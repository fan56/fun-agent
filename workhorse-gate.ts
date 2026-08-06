/**
 * workhorse-gate — workhorse（牛马狗）会话的安全门扩展。
 *
 * 仅对 workhorse 会话生效（会话名 `${type}#${id}` 前缀判定）。
 * subagent 会话无 UI（hasUI=false），全部为纯策略自动阻断。
 *
 * 标准规则：
 *   ① write/edit 目标 realpath 后在 $HOME 之外 → 阻断
 *   ② bash 含 sudo/su、rm 递归（-r/-rf/--recursive）、chmod/chown 777 → 阻断
 *   ③ write/edit 落在 ~/.pi/agent/ 内 → 阻断（含 gate 自身文件保护）
 *   ④ bash 重定向目标（>、>>、tee、dd of=）在 $HOME 外或 ~/.pi/agent 内 → 阻断
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";
import { realpathSync } from "fs";
import { join, resolve, isAbsolute, normalize, relative } from "path";

const AGENT_SESSION_PREFIX = "workhorse";
const HOME = homedir();
const HOME_REAL = realpathSafe(HOME) ?? HOME;
const PI_AGENT_DIR = join(HOME_REAL, ".pi", "agent");

// ② 危险 bash 模式（先剥引号再匹配，避免误伤 git commit -m "fix sudo" 等合法命令）
const DANGEROUS_PATTERNS: RegExp[] = [
	/\bsudo\b/i,
	/(?:^|[;&|]\s*)su(?:[\s-]|$)/i, // su 仅作为命令 token 匹配（grep su 等良性用法放行）
	/\brm\s+-[a-z]*r[a-z]*\b/i, // rm -r/-rf/-fR 等递归删除
	/\brm\s+--recursive\b/i,
	/\b(chmod|chown)\b.*\b(?:[0-7]{1,3})?777\b/i, // 覆盖 0777/4777(setuid)/7777 变体
];

function realpathSafe(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

/** 去掉单/双引号包裹的片段（git commit -m "..." 等内容不参与危险判定）。 */
function stripQuoted(command: string): string {
	// sh -c / eval 包裹的引号内容是真正要执行的命令——不剥引号，交给危险模式检查
	if (
		/\b(bash|sh|zsh|ksh|dash)\s+-[a-z]*c\b/i.test(command) ||
		/\beval\b/i.test(command)
	) {
		return command;
	}
	return command.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
}

/** 提取 bash 重定向目标路径（>、>>、tee、dd of=），跳过引号内片段（引号内是字面文本，不是重定向）。 */
function scanRedirectTargets(command: string): string[] {
	const quoteSpans: Array<[number, number]> = [];
	for (const m of command.matchAll(/"[^"]*"/g))
		quoteSpans.push([m.index!, m.index! + m[0].length]);
	for (const m of command.matchAll(/'[^']*'/g))
		quoteSpans.push([m.index!, m.index! + m[0].length]);
	const wrapped =
		/\b(bash|sh|zsh|ksh|dash)\s+-[a-z]*c\b/i.test(command) ||
		/\beval\b/i.test(command);
	const inQuote = (i: number) =>
		!wrapped && quoteSpans.some(([s, e]) => i >= s && i < e);
	const targets: string[] = [];
	const re = /(?:>>|>)\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
	for (const m of command.matchAll(re)) {
		if (inQuote(m.index!)) continue;
		const t = m[1] ?? m[2] ?? m[3];
		if (t && !t.startsWith("&")) targets.push(t); // 2>&1 / >& 的 &1 不是路径
	}
	// tee 的目标：跳过 -a/-i/--append 等 flag，支持多目标（tee -a file1 file2）
	const reTee = /\btee\b/g;
	for (const m of command.matchAll(reTee)) {
		const rest = command.slice(m.index! + 3);
		for (const tok of rest.matchAll(/"[^"]*"|'[^']*'|\S+/g)) {
			const t = tok[0];
			if (t.startsWith("-")) continue;
			if (/^[|;&>]/.test(t)) break;
			const isQuote =
				(t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') ||
				(t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'");
			targets.push(isQuote ? t.slice(1, -1) : t);
			if (targets.length >= 8) break;
		}
	}
	const reDd = /\bdd\b[^|;]*?\bof=("([^"]*)"|'([^']*)'|(\S+))/g;
	for (const m of command.matchAll(reDd)) {
		if (inQuote(m.index!)) continue;
		const t = m[2] ?? m[3] ?? m[4];
		if (t && !t.startsWith("&")) targets.push(t);
	}
	return targets.filter(Boolean);
}

/** 规范化目标路径：展开 ~、$HOME、$PWD，转绝对路径、realpath（未落盘时退化为 normalize）。 */
function normalizeTarget(raw: string): string | null {
	if (!raw) return null;
	let p = raw.trim();
	if (p === "~") p = HOME;
	else if (p.startsWith("~/")) p = join(HOME, p.slice(2));
	p = p
		.replace(/\$HOME|\$\{HOME\}/g, HOME)
		.replace(/\$PWD|\$\{PWD\}/g, process.cwd());
	const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
	return realpathSafe(abs) ?? normalize(abs);
}

// 注意：若主会话被用户命名为 workhorse 也会命中（默认主会话名 undefined，当前惰性）
function isWorkhorseSession(ctx: {
	sessionManager?: { getSessionName?: () => string | undefined };
}): boolean {
	const name = ctx.sessionManager?.getSessionName?.();
	return (
		typeof name === "string" &&
		(name === AGENT_SESSION_PREFIX ||
			name.startsWith(AGENT_SESSION_PREFIX + "#"))
	);
}

/** 包含性检查（path.relative 判定，避免 startsWith 前缀逻辑的符号链接旁路）。 */
function isUnderHome(p: string): boolean {
	const rel = relative(HOME_REAL, p);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export default function workhorseGate(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isWorkhorseSession(ctx)) return undefined;

		// ② 危险 bash 命令
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (typeof command !== "string" || !command.trim()) return undefined;
			if (DANGEROUS_PATTERNS.some((re) => re.test(stripQuoted(command)))) {
				return {
					block: true,
					reason:
						"workhorse-gate: 危险命令被阻断（sudo/su、rm -r、chmod/chown 777 及变体）",
				};
			}
			// ④ bash 重定向目标检查（echo x > /etc/passwd、cat > ~/.pi/agent/agents/evil.md、tee、dd of=）
			for (const raw of scanRedirectTargets(command)) {
				const target = normalizeTarget(raw);
				if (!target || target.startsWith("/dev/")) continue; // 设备写入无持久化影响（>/dev/null 等）
				if (!isUnderHome(target)) {
					return {
						block: true,
						reason: `workhorse-gate: bash 重定向目标在 $HOME 之外，已阻断: ${raw}`,
					};
				}
				if (target === PI_AGENT_DIR || target.startsWith(PI_AGENT_DIR + "/")) {
					return {
						block: true,
						reason:
							"workhorse-gate: bash 重定向目标落在 ~/.pi/agent 配置目录，已阻断（规则③）",
					};
				}
			}
			return undefined;
		}

		// ① + ③ write/edit 路径检查（含 lean-ctx 的 ctx_edit/ctx_patch，path 字段同构）
		if (
			event.toolName === "write" ||
			event.toolName === "edit" ||
			event.toolName === "ctx_edit" ||
			event.toolName === "ctx_patch"
		) {
			const raw = event.input.path as string;
			const target = normalizeTarget(raw);
			if (!target) return undefined;

			if (!isUnderHome(target)) {
				return {
					block: true,
					reason: `workhorse-gate: 目标路径在 $HOME 之外，已阻断: ${raw}`,
				};
			}
			if (target === PI_AGENT_DIR || target.startsWith(PI_AGENT_DIR + "/")) {
				return {
					block: true,
					reason: "workhorse-gate: 禁止修改 ~/.pi/agent 配置目录（规则③）",
				};
			}
			return undefined;
		}

		return undefined;
	});
}
