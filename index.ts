/**
 * /fun-agent-cfg — 配置全局 sub agent（~/.pi/agent/agents/*.md）的模型与思考强度。
 *
 * 用法：
 *   /fun-agent-cfg get <agent>                          — 查看当前 model/thinking
 *   /fun-agent-cfg set <agent> model <provider/modelId> — 设置模型（校验 models-store）
 *   /fun-agent-cfg set <agent> thinking <level>         — 设置思考强度
 *   /fun-agent-cfg reset <agent>                        — 删除 model/thinking，回退继承
 *
 * frontmatter 改写复用 rpiv-core applyKeyUpdates 模式（替换或闭合 --- 前插入，幂等）。
 * 改完下一次 Agent spawn 自动生效（pi-subagents 每次调用重读磁盘），无需 /reload。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");
const MODELS_STORE = join(homedir(), ".pi", "agent", "models-store.json");
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// ---------------------------------------------------------------------------
// frontmatter 工具（复用 rpiv-core/frontmatter.ts parseFrontmatterBounds 模式）
// ---------------------------------------------------------------------------

function parseFrontmatterBounds(lines: string[]): { start: number; end: number } | null {
 if (lines[0] !== "---") return null;
 for (let i = 1; i < lines.length; i++) {
  if (lines[i] === "---") return { start: 0, end: i };
 }
 return null; // 未闭合 frontmatter
}

/** 对 frontmatter 应用 key→value 更新：已有行原地替换，缺失行在闭合 --- 前插入。行数不变，幂等。 */
function applyKeyUpdates(
 lines: string[],
 bounds: { start: number; end: number },
 keysToSet: { key: string; value: string }[],
): string[] {
 const result = [...lines];
 const insertLines: string[] = [];
 for (const { key, value } of keysToSet) {
  const prefix = `${key}: `;
  const existingIdx = result.findIndex((line, i) => i > 0 && i < bounds.end && line.startsWith(key + ":"));
  if (existingIdx !== -1) {
   result[existingIdx] = `${prefix}${value}`;
  } else {
   insertLines.push(`${prefix}${value}`);
  }
 }
 if (insertLines.length > 0) result.splice(bounds.end, 0, ...insertLines);
 return result;
}

/** 删除指定 key 的 frontmatter 行（reset 用）；保留首行 `---` 与闭合 fence 之后的内容。 */
function removeKeys(lines: string[], bounds: { start: number; end: number }, keys: string[]): string[] {
 const prefixes = new Set(keys.map((k) => `${k}:`));
 return lines.filter((line, i) => {
  if (i === 0 || i >= bounds.end) return true;
  return !prefixes.has(line.slice(0, line.indexOf(":") + 1));
 });
}

function readLines(content: string): { lines: string[]; eol: string } {
 return {
  lines: content.replace(/\r\n/g, "\n").split("\n"), // 归一化 CRLF，与 pi 内置 frontmatter 解析（frontmatter.js:8）行为对齐
  eol: content.includes("\r\n") ? "\r\n" : "\n",
 };
}

function readFrontmatter(path: string): { model?: string; thinking?: string } {
 const content = readFileSync(path, "utf-8");
 const { lines } = readLines(content);
 const bounds = parseFrontmatterBounds(lines);
 if (!bounds) return {};
 const fm: { model?: string; thinking?: string } = {};
 for (const line of lines.slice(bounds.start + 1, bounds.end)) {
  const m = line.match(/^(model|thinking):\s*(.+)$/);
  if (m) {
   const v = m[2].trim();
   if (v !== "inherit") fm[m[1] as "model" | "thinking"] = v; // 字面值 inherit = 继承标记，显示同 (继承)
  }
 }
 return fm;
}

function listAgents(): string[] {
 try {
  return readdirSync(AGENTS_DIR)
   .filter((f) => f.endsWith(".md"))
   .map((f) => f.replace(/\.md$/, ""));
 } catch {
  return [];
 }
}

function agentPath(name: string): string {
 return join(AGENTS_DIR, `${name}.md`);
}

/** 校验模型存在于 models-store。store 可读且 provider 已知但 model 缺失 → 拒绝（防拼写错误静默回退）；
 *  store 不可读或 provider 未知（如 litellm 代理）→ 放行。 */
function findModelInStore(id: string): { found: boolean; storeOk: boolean } {
 try {
  const slash = id.indexOf("/"); // 首斜杠切片，多斜杠 id（如 litellm/openai/gpt-4）不截断
  if (slash === -1) return { found: false, storeOk: false };
  const provider = id.slice(0, slash);
  const modelId = id.slice(slash + 1);
  const store = JSON.parse(readFileSync(MODELS_STORE, "utf-8"));
  const entry = store?.[provider];
  if (!entry?.models) return { found: false, storeOk: false };
  return { found: entry.models.some((m: { id?: string }) => m.id === modelId), storeOk: true };
 } catch {
  return { found: false, storeOk: false };
 }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

type Completion = { value: string; label: string };

export default function funAgentCfg(pi: ExtensionAPI) {
 pi.registerCommand("fun-agent-cfg", {
  description: "配置全局 sub agent 的模型与思考强度（get/set/reset）",
  // 位置式补全：pi 传入光标前整段参数文本（pi-tui autocomplete.js:241）
  getArgumentCompletions: (args: string): Completion[] | null => {
   const parts = args.trim().split(/\s+/).filter(Boolean);
   const agents = listAgents();
   const items: Completion[] = [];
   const isSub = (s: string) => ["get", "set", "reset"].includes(s);

   if (parts.length === 0) {
    // 刚输入空格：子命令 + agent 名
    for (const w of ["get", "set", "reset"]) items.push({ value: w, label: w });
    for (const a of agents) items.push({ value: a, label: a });
   } else if (parts.length === 1) {
    // 首 token：补全子命令或 agent 名
    const t = parts[0];
    for (const w of ["get", "set", "reset"]) if (w.startsWith(t)) items.push({ value: w, label: w });
    for (const a of agents) if (a.startsWith(t)) items.push({ value: a, label: a });
   } else if (parts.length === 2 && isSub(parts[0])) {
    // <sub> <agent…>：补全 agent 名
    const t = parts[1];
    for (const a of agents) if (a.startsWith(t)) items.push({ value: `${parts[0]} ${a}`, label: a });
   } else if (parts.length === 3 && parts[0] === "set") {
    // set <agent> <field…>：补全字段
    const t = parts[2];
    for (const f of ["model", "thinking"]) if (f.startsWith(t)) items.push({ value: `${parts[0]} ${parts[1]} ${f}`, label: f });
   } else if (parts.length === 4 && parts[0] === "set" && parts[2] === "thinking") {
    // set <agent> thinking <level…>：补全档位
    const t = parts[3];
    for (const l of THINKING_LEVELS) if (l.startsWith(t)) items.push({ value: `${parts[0]} ${parts[1]} ${parts[2]} ${l}`, label: l });
   }
   return items.length ? items : null;
  },
  handler: async (args, ctx) => {
   try {
    const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const [sub, agent, field, value] = parts;

    if (!sub || !["get", "set", "reset"].includes(sub)) {
     ctx.ui.notify("用法: /fun-agent-cfg get|set|reset <agent> [model|thinking <value>]", "warning");
     return;
    }
    if (!agent) {
     ctx.ui.notify(`缺少 agent 名。可用: ${listAgents().join(", ")}`, "warning");
     return;
    }
    if (!listAgents().includes(agent)) {
     ctx.ui.notify(`agent "${agent}" 不存在（可用: ${listAgents().join(", ")}）`, "warning");
     return;
    }
    const path = agentPath(agent);

    if (sub === "get") {
     const fm = readFrontmatter(path);
     ctx.ui.notify(`${agent}: model=${fm.model ?? "(继承)"}, thinking=${fm.thinking ?? "(继承)"}`, "info");
     return;
    }

    if (sub === "reset") {
     const { lines, eol } = readLines(readFileSync(path, "utf-8"));
     const bounds = parseFrontmatterBounds(lines);
     if (!bounds) {
      ctx.ui.notify(`${agent}: 无有效 frontmatter，无需 reset`, "warning");
      return;
     }
     const next = removeKeys(lines, bounds, ["model", "thinking"]).join(eol);
     if (next === lines.join(eol)) {
      ctx.ui.notify(`${agent}: 没有 model/thinking 行，无需 reset`, "info");
      return;
     }
     writeFileSync(path, next);
     ctx.ui.notify(`${agent}: 已删除 model/thinking，回退继承（下一次 spawn 生效）`, "info");
     return;
    }

    // set
    if (!field) {
     ctx.ui.notify("用法: /fun-agent-cfg set <agent> model <provider/modelId> | set <agent> thinking <level>", "warning");
     return;
    }
    if (field !== "model" && field !== "thinking") {
     ctx.ui.notify(`未知字段 "${field}"（可选 model | thinking）`, "warning");
     return;
    }
    if (!value) {
     ctx.ui.notify(`缺少值: ${field === "model" ? "provider/modelId" : `(${THINKING_LEVELS.join("/")})`}`, "warning");
     return;
    }
    if (field === "model") {
     if (!/^[^/\s]+\/.+$/.test(value)) {
      ctx.ui.notify(`模型格式应为 provider/modelId（如 opencode-go/deepseek-v4-flash），收到 "${value}"`, "warning");
      return;
     }
     const { found, storeOk } = findModelInStore(value);
     if (storeOk && !found) {
      ctx.ui.notify(`models-store 中找不到 "${value}"（可用 /m 查看全部模型）；已拒绝写入`, "warning");
      return;
     }
    }
    if (field === "thinking" && !THINKING_LEVELS.includes(value)) {
     ctx.ui.notify(`thinking 应为 ${THINKING_LEVELS.join("/")} 之一，收到 "${value}"`, "warning");
     return;
    }

    const { lines, eol } = readLines(readFileSync(path, "utf-8"));
    const bounds = parseFrontmatterBounds(lines);
    if (!bounds) {
     ctx.ui.notify(`${agent}: 无有效 frontmatter，无法设置`, "warning");
     return;
    }
    const updated = applyKeyUpdates(lines, bounds, [{ key: field, value }]);
    writeFileSync(path, updated.join(eol));
    ctx.ui.notify(`${agent}: ${field}=${value} 已写入（下一次 spawn 生效）`, "info");
   } catch (e) {
    ctx.ui.notify(`/fun-agent-cfg 出错: ${e instanceof Error ? e.message : String(e)}`, "warning");
   }
  },
 });
}
