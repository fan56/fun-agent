/**
 * /fun-agent-cfg — 交互式配置全局 sub agent（~/.pi/agent/agents/*.md）的模型与思考强度。
 *
 * 三面板网格（←/→ 或 Tab/Shift+Tab 切栏，↑↓ 栏内移动，Enter 保存，Esc 取消）：
 *
 *   ┌─ Agent ─────────────┐ ┌─ Model ──────────────────────────┐
 *   │ ▸ 牛马狗 (workhorse) │ │ ▸ deepseek-v4-flash  (opencode-go) │
 *   │   老法师 (oldfox)    │ │   glm-5.2  (zai-coding-cn)         │
 *   └─────────────────────┘ └──────────────────────────────────┘
 *   ┌─ Think Level ────────────────┐
 *   │ ▸ high                        │
 *   └───────────────────────────────┘
 *
 * - Model 面板支持键入过滤（backspace 清除）；✓ 标记当前已保存值。
 * - 保存语义：inherit → 删除 frontmatter 对应行（回退继承）；具体值 → 写入。
 * - 改完下一次 Agent spawn 自动生效（pi-subagents 每次调用重读磁盘），无需 /reload。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");
const INHERIT = "__inherit__";

interface AgentEntry {
 name: string;
 displayName?: string;
 model?: string;
 thinking?: string;
}

interface PickItem {
 value: string;
 label: string;
}

const FOOTERS = [
 "←→ 切栏  ↑↓ 选择 agent  Enter 保存  Esc 取消",
 "←→ 切栏  ↑↓ 选择模型  键入过滤  ⌫ 清除  Enter 保存  Esc 取消",
 "←→ 切栏  ↑↓ 选择思考强度  Enter 保存  Esc 取消",
];

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

/** 对 frontmatter 应用 key→value 更新：已有行原地替换，缺失行在闭合 --- 前插入。幂等。 */
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

/** 删除指定 key 的 frontmatter 行；保留首行 `---` 与闭合 fence 之后的内容。 */
function removeKeys(lines: string[], bounds: { start: number; end: number }, keys: string[]): string[] {
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

function readFrontmatter(path: string): { model?: string; thinking?: string; displayName?: string } {
 const content = readFileSync(path, "utf-8");
 const { lines } = readLines(content);
 const bounds = parseFrontmatterBounds(lines);
 if (!bounds) return {};
 const fm: { model?: string; thinking?: string; displayName?: string } = {};
 for (const line of lines.slice(bounds.start + 1, bounds.end)) {
  const m = line.match(/^(model|thinking|display_name):\s*(.+)$/);
  if (m) {
   const v = m[2].trim();
   if (m[1] === "display_name") fm.displayName = v;
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
    return { name, displayName: fm.displayName, model: fm.model, thinking: fm.thinking };
   })
   .sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name, "zh"));
 } catch {
  return [];
 }
}

function agentPath(name: string): string {
 return join(AGENTS_DIR, `${name}.md`);
}

// ---------------------------------------------------------------------------
// 选项构建
// ---------------------------------------------------------------------------

function modelKey(m: Model<Api>): string {
 return m.id && m.provider ? `${m.provider}/${m.id}` : (m.id ?? "");
}

function displayLabel(a: AgentEntry): string {
 return a.displayName && a.displayName !== a.name ? `${a.displayName} (${a.name})` : a.name;
}

/** 模型列表（当前已选浮顶），末尾恒有 inherit。 */
function buildModelItems(models: Model<Api>[], currentKey?: string): PickItem[] {
 const items: PickItem[] = models.map((m) => ({
  value: modelKey(m),
  label: `${m.name}${m.provider ? `  (${m.provider})` : ""}`,
 }));
 const ci = currentKey ? items.findIndex((i) => i.value === currentKey) : -1;
 if (ci > 0) items.unshift(items.splice(ci, 1)[0]);
 items.push({ value: INHERIT, label: "inherit (no override)" });
 return items;
}

/** 思考档位：inherit + off（若支持）+ 模型支持的档位（去重，含 max）。 */
function buildThinkItems(model: Model<Api> | undefined): PickItem[] {
 const items: PickItem[] = [{ value: INHERIT, label: "inherit (no override)" }];
 const levels = model ? getSupportedThinkingLevels(model) : [];
 if (levels.includes("off")) items.push({ value: "off", label: "off (disable reasoning)" });
 const seen = new Set<string>();
 for (const l of levels) {
  if (l === "off" || seen.has(l)) continue;
  seen.add(l);
  items.push({ value: l, label: l });
 }
 return items;
}

function isPrintable(s: string): boolean {
 return s.length === 1 && s.charCodeAt(0) >= 0x20 && s.charCodeAt(0) < 0x7f;
}

function padToWidth(s: string, w: number): string {
 const vw = visibleWidth(s);
 return vw >= w ? s : s + " ".repeat(w - vw);
}

function clampScroll(cur: number, cursor: number, len: number, visible: number): number {
 if (len <= visible) return 0;
 let s = cur;
 if (cursor < s) s = cursor;
 else if (cursor >= s + visible) s = cursor - visible + 1;
 return Math.min(Math.max(s, 0), len - visible);
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

type Completion = { value: string; label: string };

export default function funAgentCfg(pi: ExtensionAPI) {
 pi.registerCommand("fun-agent-cfg", {
  description: "交互式配置 sub agent 的模型与思考强度（三面板网格）",
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
    /* 拿不到就只剩 inherit 可选 */
   }
   const requested = (args ?? "").trim();
   const reqIdx = requested
    ? agents.findIndex((a) => a.name === requested || displayLabel(a) === requested)
    : -1;

   try {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
     // ------- state -------
     const scroll = { agent: 0, model: 0, think: 0 };
     let active = 0; // 0=Agent 1=Model 2=Think
     let agentIdx = 0;
     let filter = "";
     let modelItems: PickItem[] = [];
     let filtered: PickItem[] = [];
     let modelIdx = 0;
     let thinkItems: PickItem[] = [];
     let thinkIdx = 0;

     function currentModel(): Model<Api> | undefined {
      const v = filtered[modelIdx]?.value;
      return models.find((m) => modelKey(m) === v);
     }

     function refreshThink(keepPrev: boolean) {
      const prev = keepPrev ? thinkItems[thinkIdx]?.value : undefined;
      thinkItems = buildThinkItems(currentModel());
      let idx = prev !== undefined ? thinkItems.findIndex((i) => i.value === prev) : -1;
      if (idx < 0) idx = thinkItems.findIndex((i) => i.value === agents[agentIdx].thinking);
      thinkIdx = idx >= 0 ? idx : 0;
      scroll.think = 0;
     }

     function setupForAgent(i: number) {
      agentIdx = i;
      const a = agents[i];
      modelItems = buildModelItems(models, a.model);
      filtered = modelItems;
      filter = "";
      modelIdx = a.model && modelItems.some((x) => x.value === a.model) ? 0 : modelItems.length - 1;
      scroll.agent = 0;
      scroll.model = 0;
      refreshThink(false);
     }

     function moveCursor(delta: number) {
      if (active === 0) {
       const next = Math.min(Math.max(agentIdx + delta, 0), agents.length - 1);
       if (next !== agentIdx) setupForAgent(next);
      } else if (active === 1) {
       if (!filtered.length) return;
       modelIdx = Math.min(Math.max(modelIdx + delta, 0), filtered.length - 1);
       refreshThink(true);
      } else {
       if (!thinkItems.length) return;
       thinkIdx = Math.min(Math.max(thinkIdx + delta, 0), thinkItems.length - 1);
      }
     }

     function applyFilter(data: string) {
      if (data === "\u0008" || data === "\u007f") filter = filter.slice(0, -1);
      else if (isPrintable(data)) filter += data;
      else return;
      const q = filter.toLowerCase();
      filtered = q ? modelItems.filter((i) => i.label.toLowerCase().includes(q)) : modelItems;
      modelIdx = filtered.length ? Math.min(modelIdx, filtered.length - 1) : 0;
      scroll.model = 0;
      refreshThink(true);
     }

     function commit() {
      const modelItem = filtered[modelIdx];
      const thinkItem = thinkItems[thinkIdx];
      if (!modelItem) {
       // 过滤结果为空时按 Enter 属误触——清除过滤恢复列表，而不是 done() 关掉整个 UI
       filter = "";
       filtered = modelItems;
       modelIdx = Math.max(0, Math.min(modelIdx, filtered.length - 1));
       scroll.model = 0;
       refreshThink(true);
       tui.requestRender();
       return;
      }
      if (!thinkItem) return; // 不可达：thinkItems 恒含 inherit
      const a = agents[agentIdx];
      const path = agentPath(a.name);
      const { lines, eol } = readLines(readFileSync(path, "utf-8"));
      const bounds = parseFrontmatterBounds(lines);
      if (!bounds) {
       done();
       ctx.ui.notify(`${a.name}: 无有效 frontmatter，无法写入`, "warning");
       return;
      }
      const keysToSet: { key: string; value: string }[] = [];
      const keysToRemove: string[] = [];
      if (modelItem.value === INHERIT) keysToRemove.push("model");
      else keysToSet.push({ key: "model", value: modelItem.value });
      if (thinkItem.value === INHERIT) keysToRemove.push("thinking");
      else keysToSet.push({ key: "thinking", value: thinkItem.value });
      let next = lines;
      if (keysToRemove.length) next = removeKeys(next, bounds, keysToRemove);
      const b2 = parseFrontmatterBounds(next); // removeKeys 后 fence 索引变化，重算
      if (b2 && keysToSet.length) next = applyKeyUpdates(next, b2, keysToSet);
      if (next.join(eol) === lines.join(eol)) {
       done();
       ctx.ui.notify(`${displayLabel(a)}: 无变化，未写入`, "info");
       return;
      }
      writeFileSync(path, next.join(eol));
      done();
      const mL = modelItem.value === INHERIT ? "inherit" : modelItem.value;
      const tL = thinkItem.value === INHERIT ? "inherit" : thinkItem.value;
      ctx.ui.notify(`已保存 ${displayLabel(a)} → model=${mL}, thinking=${tL}（下一次 spawn 生效）`, "info");
     }

     setupForAgent(reqIdx >= 0 ? reqIdx : 0);

     // ------- render helpers（闭包内可用 theme）-------
     const frame = (panelActive: boolean) => (s: string) =>
      panelActive ? theme.fg("accent", s) : theme.fg("dim", s);

     function boxTop(title: string, w: number, f: (s: string) => string): string {
      const t = truncateToWidth(title, Math.max(1, w - 4));
      return f("┌─") + theme.bold(f(t)) + f("─".repeat(Math.max(0, w - 3 - visibleWidth(t))) + "┐");
     }

     function boxBottom(w: number): string {
      return "└" + "─".repeat(Math.max(0, w - 2)) + "┘";
     }

     function buildRow(
      value: string,
      label: string,
      isCursor: boolean,
      panelActive: boolean,
      contentW: number,
      checkVal?: string,
     ): string {
      const isCheck = checkVal !== undefined && value === checkVal;
      const mark = isCheck ? theme.fg("success", " ✓") : "";
      const labelW = Math.max(1, contentW - 2 - (isCheck ? 2 : 0));
      const text = truncateToWidth(label, labelW);
      const prefix = isCursor ? theme.fg(panelActive ? "accent" : "dim", "▸") : " ";
      const body = isCursor && panelActive ? theme.bold(text) : text;
      return padToWidth(prefix + " " + body + mark, contentW);
     }

     return {
      render(width: number): string[] {
       const lines: string[] = [];
       // 列宽
       let agentW = 12;
       for (const a of agents) agentW = Math.max(agentW, visibleWidth(displayLabel(a)) + 2);
       agentW = Math.min(agentW, 26);
       let modelW = 16;
       for (const i of modelItems) modelW = Math.max(modelW, visibleWidth(i.label) + 2);
       modelW = Math.min(modelW, 46);
       const gap = 1;
       if (agentW + gap + modelW > width) {
        modelW = Math.max(12, modelW - (agentW + gap + modelW - width));
        if (agentW + gap + modelW > width) agentW = Math.max(10, width - gap - modelW);
       }
       const thinkW = Math.min(width, Math.max(20, Math.min(60, agentW + gap + modelW)));
       const h = Math.max(2, Math.min(10, Math.max(agents.length, modelItems.length)));
       const thinkH = Math.min(6, Math.max(thinkItems.length, 1));
       scroll.agent = clampScroll(scroll.agent, agentIdx, agents.length, h);
       scroll.model = clampScroll(scroll.model, modelIdx, filtered.length, h);
       scroll.think = clampScroll(scroll.think, thinkIdx, thinkItems.length, thinkH);

       const a = agents[agentIdx];
       const modelItem = filtered[modelIdx];
       const thinkItem = thinkItems[thinkIdx];
       const cur = `${displayLabel(a)} → ${modelItem ? (modelItem.value === INHERIT ? "inherit" : modelItem.value) : "-"} / ${thinkItem ? (thinkItem.value === INHERIT ? "inherit" : thinkItem.value) : "-"}`;

       lines.push(theme.bold(theme.fg("accent", "fun-agent-cfg")) + theme.fg("muted", "  sub agent 模型/思考配置"));
       lines.push(theme.fg("muted", truncateToWidth(cur, Math.max(1, width))));
       lines.push("");

       const aFrame = frame(active === 0);
       const mFrame = frame(active === 1);
       const tFrame = frame(active === 2);

       lines.push(boxTop("Agent", agentW, aFrame) + " ".repeat(gap) + boxTop("Model", modelW, mFrame));
       for (let r = 0; r < h; r++) {
        const ai = scroll.agent + r;
        const mi = scroll.model + r;
        const aLine =
         ai < agents.length
          ? buildRow(agents[ai].name, displayLabel(agents[ai]), ai === agentIdx, active === 0, agentW - 2)
          : "";
        const mLine =
         mi < filtered.length
          ? buildRow(filtered[mi].value, filtered[mi].label, mi === modelIdx, active === 1, modelW - 2, a.model)
          : "";
        lines.push(
         aFrame("│" + padToWidth(aLine, agentW - 2) + "│") +
          " ".repeat(gap) +
          mFrame("│" + padToWidth(mLine, modelW - 2) + "│"),
        );
       }
       lines.push(aFrame(boxBottom(agentW)) + " ".repeat(gap) + mFrame(boxBottom(modelW)));
       lines.push("");
       lines.push(tFrame(boxTop("Think Level", thinkW, tFrame)));
       for (let r = 0; r < thinkH; r++) {
        const ti = scroll.think + r;
        const tLine =
         ti < thinkItems.length
          ? buildRow(thinkItems[ti].value, thinkItems[ti].label, ti === thinkIdx, active === 2, thinkW - 2, a.thinking)
          : "";
        lines.push(tFrame("│" + padToWidth(tLine, thinkW - 2) + "│"));
       }
       lines.push(tFrame(boxBottom(thinkW)));
       lines.push("");
       lines.push(theme.fg("muted", FOOTERS[active] + (active === 1 && filter ? `  过滤: "${filter}"` : "")));
       return lines;
      },
      invalidate(): void {
       /* 每次 render 全量重算，无需失效处理 */
      },
      handleInput(data: string) {
       if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
        active = (active + 2) % 3;
       } else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
        active = (active + 1) % 3;
       } else if (matchesKey(data, Key.up)) {
        moveCursor(-1);
       } else if (matchesKey(data, Key.down)) {
        moveCursor(1);
       } else if (matchesKey(data, Key.enter)) {
        commit();
        return;
       } else if (matchesKey(data, Key.escape)) {
        done();
        return;
       } else if (active === 1 && typeof data === "string") {
        applyFilter(data);
       }
       tui.requestRender();
      },
     };
    });
   } catch (e) {
    ctx.ui.notify(`/fun-agent-cfg 出错: ${e instanceof Error ? e.message : String(e)}`, "warning");
   }
  },
 });
}
