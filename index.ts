/**
 * /fun-agent-cfg — 级联式配置全局 sub agent（~/.pi/agent/agents/*.md）的模型与思考强度。
 *
 * 流程（仿 rpiv-models 的二段选择）：
 *
 *   顶层菜单（选择 agent，Esc 退出）
 *     └─ <agent> → 选模型 → 选思考强度 → 保存 → 回顶层菜单
 *
 * - 模型选择：若 ~/.pi/agent/model-favorites.json（与 /m 命令共享）里有收藏，
 *   则仅显示收藏的模型；否则显示全部。用 /m 命令管理收藏列表（本命令不提供编辑界面）。
 * - 列表支持键入过滤（backspace 清除）；✓ 标记当前已保存值。
 * - 保存语义：inherit → 删除 frontmatter 对应行（回退继承）；具体值 → 写入。
 * - 改完下一次 Agent spawn 自动生效（pi-subagents 每次调用重读磁盘），无需 /reload。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");
const FAVORITES_PATH = join(homedir(), ".pi", "agent", "model-favorites.json");
const INHERIT = "__inherit__";

interface AgentEntry {
	name: string;
	displayName?: string;
	description?: string;
	model?: string;
	thinking?: string;
}

interface PickerItem {
	value: string;
	label: string;
	/** 二级说明行：存在时条目渲染为「名字 || 介绍」单行（分隔符填充空隙） */
	sub?: string;
	check?: boolean;
}

// ---------------------------------------------------------------------------
// frontmatter 工具（复用 rpiv-core/frontmatter.ts parseFrontmatterBounds 模式）
// ---------------------------------------------------------------------------

function parseFrontmatterBounds(
	lines: string[],
): { start: number; end: number } | null {
	if (lines[0] !== "---") return null;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") return { start: 0, end: i };
	}
	return null; // 未闭合 frontmatter
}

/** 对 frontmatter 应用 key→value 更新：已有行原地替换，缺失行在闭合 --- 前插入。幂等。 */
function applyKeyUpdates(
	lines: string[],
	bounds: { start: number; end: number },
	keysToSet: { key: string; value: string }[],
): string[] {
	const result = [...lines];
	const insertLines: string[] = [];
	for (const { key, value } of keysToSet) {
		const existingIdx = result.findIndex(
			(line, i) => i > 0 && i < bounds.end && line.startsWith(key + ":"),
		);
		if (existingIdx !== -1) {
			result[existingIdx] = `${key}: ${value}`;
		} else {
			insertLines.push(`${key}: ${value}`);
		}
	}
	if (insertLines.length > 0) result.splice(bounds.end, 0, ...insertLines);
	return result;
}

/** 删除指定 key 的 frontmatter 行；保留首行 `---` 与闭合 fence 之后的内容。 */
function removeKeys(
	lines: string[],
	bounds: { start: number; end: number },
	keys: string[],
): string[] {
	const prefixes = new Set(keys.map((k) => `${k}:`));
	return lines.filter((line, i) => {
		if (i === 0 || i >= bounds.end) return true;
		return !prefixes.has(line.slice(0, line.indexOf(":") + 1));
	});
}

function readLines(content: string): { lines: string[]; eol: string } {
	return {
		lines: content.replace(/\r\n/g, "\n").split("\n"), // 归一化 CRLF，与 pi 内置 frontmatter 解析行为对齐
		eol: content.includes("\r\n") ? "\r\n" : "\n",
	};
}

function readFrontmatter(path: string): {
	model?: string;
	thinking?: string;
	displayName?: string;
	description?: string;
} {
	const content = readFileSync(path, "utf-8");
	const { lines } = readLines(content);
	const bounds = parseFrontmatterBounds(lines);
	if (!bounds) return {};
	const fm: {
		model?: string;
		thinking?: string;
		displayName?: string;
		description?: string;
	} = {};
	for (const line of lines.slice(bounds.start + 1, bounds.end)) {
		const m = line.match(/^(model|thinking|display_name|description):\s*(.+)$/);
		if (m) {
			const v = m[2].trim();
			if (m[1] === "description") fm.description = v.replace(/^"(.*)"$/, "$1");
			else if (m[1] === "display_name") fm.displayName = v;
			else if (v !== "inherit") fm[m[1] as "model" | "thinking"] = v; // 字面值 inherit = 继承标记
		}
	}
	return fm;
}

function listAgentEntries(): AgentEntry[] {
	try {
		return readdirSync(AGENTS_DIR)
			.filter((f) => f.endsWith(".md"))
			.map((f) => {
				const name = f.replace(/\.md$/, "");
				const fm = readFrontmatter(join(AGENTS_DIR, f));
				return {
					name,
					displayName: fm.displayName,
					description: fm.description,
					model: fm.model,
					thinking: fm.thinking,
				};
			})
			.sort((a, b) =>
				(a.displayName ?? a.name).localeCompare(b.displayName ?? b.name, "zh"),
			);
	} catch {
		return [];
	}
}

function agentPath(name: string): string {
	return join(AGENTS_DIR, `${name}.md`);
}

// ---------------------------------------------------------------------------
// 收藏列表（只读消费 ~/.pi/agent/model-favorites.json，与 /m 命令共享）
// ---------------------------------------------------------------------------

function loadFavorites(): string[] {
	if (!existsSync(FAVORITES_PATH)) return [];
	try {
		const parsed = JSON.parse(readFileSync(FAVORITES_PATH, "utf-8")) as {
			favorites?: unknown;
		};
		return Array.isArray(parsed.favorites)
			? parsed.favorites.filter((x): x is string => typeof x === "string")
			: [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// 选项/渲染工具
// ---------------------------------------------------------------------------

function modelKey(m: Model<Api>): string {
	return m.id && m.provider ? `${m.provider}/${m.id}` : (m.id ?? "");
}

function displayLabel(a: AgentEntry): string {
	return a.displayName && a.displayName !== a.name
		? `${a.displayName} (${a.name})`
		: a.name;
}

function isPrintable(s: string): boolean {
	return s.length === 1 && s.charCodeAt(0) >= 0x20 && s.charCodeAt(0) < 0x7f;
}

function clampScroll(
	cur: number,
	cursor: number,
	len: number,
	visible: number,
): number {
	if (len <= visible) return 0;
	let s = cur;
	if (cursor < s) s = cursor;
	else if (cursor >= s + visible) s = cursor - visible + 1;
	return Math.min(Math.max(s, 0), len - visible);
}

function padToWidth(s: string, w: number): string {
	const vw = visibleWidth(s);
	return vw >= w ? s : s + " ".repeat(w - vw);
}

/** 单选过滤面板（仿 rpiv-models showFilterablePicker）。返回所选 value，Esc 返回 null。 */
function pickFromList(
	ctx: ExtensionContext,
	opts: {
		title: string;
		proseLines: string[];
		items: PickerItem[];
		preferredValue?: string;
		escHint?: string;
	},
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let query = "";
		let cursor = 0;
		let scroll = 0;
		const MAX_ROWS = 12;
		const esc = opts.escHint ?? "cancel";

		const filtered = (): PickerItem[] => {
			if (!query) return opts.items;
			const q = query.toLowerCase();
			return opts.items.filter(
				(i) =>
					i.label.toLowerCase().includes(q) ||
					i.value.toLowerCase().includes(q) ||
					(i.sub ?? "").toLowerCase().includes(q),
			);
		};

		// 初始光标定位到 preferred（在全量列表里找，避免被过滤掉）
		if (opts.preferredValue) {
			const idx = opts.items.findIndex((i) => i.value === opts.preferredValue);
			if (idx >= 0) cursor = idx;
		}

		return {
			render(width: number): string[] {
				const f = filtered();
				cursor = f.length ? Math.min(cursor, f.length - 1) : 0;
				const rows = Math.min(MAX_ROWS, Math.max(f.length, 1));
				scroll = clampScroll(scroll, cursor, f.length, rows);
				const panelW = Math.min(Math.max(width, 30), 100);
				const innerW = Math.max(1, panelW - 2);

				const out: string[] = [];
				out.push(theme.bold(theme.fg("accent", opts.title)));
				for (const p of opts.proseLines)
					out.push(theme.fg("muted", truncateToWidth(p, Math.max(1, width))));
				out.push("");
				out.push(theme.fg("accent", "┌" + "─".repeat(panelW - 2) + "┐"));

				const renderRow = (it: PickerItem, isCur: boolean): string => {
					const mark = it.check ? theme.fg("success", "✓") : " ";
					const pointer = isCur ? theme.fg("accent", "▸") : " ";
					// 先截断纯文本，再套样式（与原文件一致，避免 ANSI 进 truncate）
					const trunc = truncateToWidth(it.label, Math.max(1, innerW - 4));
					const body = isCur ? theme.bold(trunc) : trunc;
					// 单行布局：名字 分隔符 介绍（分隔符 ||；空间不足只显示名字）
					if (it.sub) {
						const nameW = visibleWidth(trunc);
						const descMax = innerW - 4 - nameW - 4; // 4 = 分隔符「 || 」占宽
						if (descMax >= 8) {
							const subFull = truncateToWidth(it.sub, descMax);
							return (
								`${pointer} ${mark} ${body}` +
								theme.fg("muted", " || ") +
								theme.fg("muted", subFull)
							);
						}
					}
					return `${pointer} ${mark} ${body}`;
				};
				for (let r = 0; r < rows; r++) {
					const i = scroll + r;
					const row = i < f.length ? renderRow(f[i], i === cursor) : "";
					out.push(
						theme.fg("accent", "│") +
						padToWidth(row, innerW) +
						theme.fg("accent", "│"),
					);
				}
				out.push(theme.fg("accent", "└" + "─".repeat(panelW - 2) + "┘"));
				out.push("");
				out.push(
					theme.fg(
						"muted",
						`↑↓ 导航  键入过滤${query ? ` "${query}"` : ""}  ⌫ 清除  Enter 选择  Esc ${esc}`,
					),
				);
				return out;
			},
			invalidate(): void {
				/* 每次 render 全量重算，无需失效处理 */
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) {
					cursor = Math.max(0, cursor - 1);
				} else if (matchesKey(data, Key.down)) {
					const f = filtered();
					cursor = f.length ? Math.min(cursor + 1, f.length - 1) : 0;
				} else if (matchesKey(data, Key.enter)) {
					const f = filtered();
					if (f.length === 0) {
						// 过滤无结果时 Enter 属误触——清过滤恢复列表，而非当作 Esc 退出
						query = "";
						tui.requestRender();
						return;
					}
					done(f[cursor]?.value ?? null);
					return;
				} else if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				} else if (typeof data === "string") {
					if (data === "\u0008" || data === "\u007f")
						query = query.slice(0, -1);
					else if (isPrintable(data)) query += data;
				}
				tui.requestRender();
			},
		};
	});
}

/** 思考档位：inherit + off（若支持）+ 模型支持的档位（去重，含 max）。 */
function buildThinkItems(
	model: Model<Api>,
	currentThink?: string,
): PickerItem[] {
	const items: PickerItem[] = [
		{
			value: INHERIT,
			label: "inherit (no override)",
			check: currentThink === undefined,
		},
	];
	const levels = getSupportedThinkingLevels(model);
	if (levels.includes("off"))
		items.push({
			value: "off",
			label: "off (disable reasoning)",
			check: currentThink === "off",
		});
	const seen = new Set<string>();
	for (const l of levels) {
		if (l === "off" || seen.has(l)) continue;
		seen.add(l);
		items.push({ value: l, label: l, check: currentThink === l });
	}
	return items;
}

/** 写入 agent 的 model/thinking frontmatter。undefined = 删除对应行（inherit）。 */
function saveAgent(
	ctx: ExtensionContext,
	agent: AgentEntry,
	modelK: string | undefined,
	thinkK: string | undefined,
): void {
	const path = agentPath(agent.name);
	const { lines, eol } = readLines(readFileSync(path, "utf-8"));
	const bounds = parseFrontmatterBounds(lines);
	if (!bounds) {
		ctx.ui.notify(`${agent.name}: 无有效 frontmatter，无法写入`, "warning");
		return;
	}
	const keysToSet: { key: string; value: string }[] = [];
	const keysToRemove: string[] = [];
	if (modelK === undefined) keysToRemove.push("model");
	else keysToSet.push({ key: "model", value: modelK });
	if (thinkK === undefined) keysToRemove.push("thinking");
	else keysToSet.push({ key: "thinking", value: thinkK });
	let next = lines;
	if (keysToRemove.length) next = removeKeys(next, bounds, keysToRemove);
	const b2 = parseFrontmatterBounds(next); // removeKeys 后 fence 索引变化，重算
	if (b2 && keysToSet.length) next = applyKeyUpdates(next, b2, keysToSet);
	if (next.join(eol) === lines.join(eol)) {
		ctx.ui.notify(`${displayLabel(agent)}: 无变化，未写入`, "info");
		return;
	}
	writeFileSync(path, next.join(eol));
	// 同步内存快照：agent 是 agents 数组里的同一引用，刷新后顶层菜单的 ✓ / 预选反映刚保存的值
	agent.model = modelK;
	agent.thinking = thinkK;
	const mL = modelK ?? "inherit";
	const tL = thinkK ?? "inherit";
	ctx.ui.notify(
		`已保存 ${displayLabel(agent)} → model=${mL}, thinking=${tL}（下一次 spawn 生效）`,
		"info",
	);
}

/** 二段级联：选模型（按收藏筛选）→ 选思考强度 → 保存。返回 "back"（Esc 回顶层）或 "done"。 */
async function configureAgent(
	ctx: ExtensionContext,
	agent: AgentEntry,
	models: Model<Api>[],
): Promise<"back" | "done"> {
	const favorites = loadFavorites();
	let visibleModels = models;
	let favorNote: string;
	if (favorites.length > 0) {
		const favSet = new Set(favorites);
		visibleModels = models.filter((m) => favSet.has(modelKey(m)));
		if (visibleModels.length > 0) {
			favorNote = `仅显示 ${visibleModels.length}/${models.length} 个收藏模型（用 /m 管理收藏）`;
		} else {
			favorNote = "收藏的模型当前均不可用，显示全部模型";
			visibleModels = models;
		}
	} else {
		favorNote =
			"收藏列表为空，显示全部模型（装 pi-model-favorites 后用 /m 收藏可筛选）";
	}

	// 记住本次会话刚选的模型：Esc 从 think 退回 model 时，光标停在上次选的模型而非已保存值
	let pickedKey: string = agent.model ?? INHERIT;
	while (true) {
		// Stage 1: model
		const modelItems: PickerItem[] = [
			...visibleModels.map((m) => ({
				value: modelKey(m),
				label: `${m.name}${m.provider ? `  (${m.provider})` : ""}`,
				check: modelKey(m) === agent.model,
			})),
			{
				value: INHERIT,
				label: "inherit (no override)",
				check: agent.model === undefined,
			},
		];
		const mChoice = await pickFromList(ctx, {
			title: "Model",
			proseLines: [`${displayLabel(agent)} → 选择模型（${favorNote}）`],
			items: modelItems,
			preferredValue: pickedKey,
			escHint: "back",
		});
		if (mChoice == null) return "back"; // Esc → 回顶层菜单
		pickedKey = mChoice;

		const picked =
			mChoice === INHERIT
				? undefined
				: models.find((m) => modelKey(m) === mChoice);

		// 非 reasoning 模型无思考档位 → 直接保存（thinking = inherit）
		if (!picked || !picked.reasoning) {
			saveAgent(
				ctx,
				agent,
				mChoice === INHERIT ? undefined : mChoice,
				undefined,
			);
			return "done";
		}

		// Stage 2: think level
		const thinkItems = buildThinkItems(picked, agent.thinking);
		const tChoice = await pickFromList(ctx, {
			title: "Think Level",
			proseLines: [`${displayLabel(agent)} → ${picked.name} → 选择思考强度`],
			items: thinkItems,
			preferredValue: agent.thinking ?? INHERIT,
			escHint: "back",
		});
		if (tChoice == null) continue; // Esc → 回到模型选择
		saveAgent(
			ctx,
			agent,
			mChoice === INHERIT ? undefined : mChoice,
			tChoice === INHERIT ? undefined : tChoice,
		);
		return "done";
	}
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

type Completion = { value: string; label: string };

export default function funAgentCfg(pi: ExtensionAPI) {
	pi.registerCommand("fun-agent-cfg", {
		description:
			"交互式配置 sub agent 的模型与思考强度（级联选择，按收藏筛选模型）",
		getArgumentCompletions: (args: string): Completion[] | null => {
			const t = args.trim();
			const items: Completion[] = listAgentEntries()
				.filter((a) => a.name.startsWith(t) || displayLabel(a).startsWith(t))
				.map((a) => ({ value: a.name, label: displayLabel(a) }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/fun-agent-cfg 需要交互式界面", "warning");
				return;
			}
			const agents = listAgentEntries();
			if (agents.length === 0) {
				ctx.ui.notify(`${AGENTS_DIR} 下没有找到 agent`, "warning");
				return;
			}
			let models: Model<Api>[] = [];
			try {
				models = ctx.modelRegistry.getAvailable();
			} catch {
				/* 拿不到模型就只剩 inherit 可选 */
			}

			const requested = (args ?? "").trim();
			const reqAgent = requested
				? agents.find(
						(a) => a.name === requested || displayLabel(a) === requested,
					)
				: undefined;
			if (requested && !reqAgent)
				ctx.ui.notify(`未找到 agent: ${requested}（进入选择菜单）`, "warning");

			// 命令行直接指定 agent → 跳过顶层菜单，直接进级联
			if (reqAgent) {
				await configureAgent(ctx, reqAgent, models);
				return;
			}

			// 顶层菜单循环（选择 agent，Esc 退出）
			let scopePreselect: string | undefined;
			while (true) {
				const scopeItems: PickerItem[] = agents.map((a) => ({
					value: a.name,
					label: displayLabel(a),
					sub: a.description ?? undefined,
					check: false,
				}));
				const scope = await pickFromList(ctx, {
					title: "fun-agent-cfg",
					proseLines: ["选择要配置的 sub agent。Esc 退出。"],
					items: scopeItems,
					preferredValue: scopePreselect,
					escHint: "exit",
				});
				if (scope == null) return; // Esc → 退出命令
				const agent = agents.find((a) => a.name === scope);
				if (!agent) continue;
				await configureAgent(ctx, agent, models);
				scopePreselect = scope;
			}
		},
	});
}
