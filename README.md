# fun-agent

pi 自定义 sub agent 套件：**workhorse**（牛马狗，干活主力）+ **oldfox**（老法师，顾问审核）。

## 内容

| 路径 | 说明 |
| ------ | ------ |
| `agents/workhorse.md` | workhorse 权威定义（部署到 `~/.pi/agent/agents/`） |
| `agents/oldfox.md` | oldfox 权威定义（部署到 `~/.pi/agent/agents/`） |
| `workhorse-gate.ts` | workhorse 安全门扩展 |
| `index.ts` | `/fun-agent-cfg` 命令扩展 |

## 部署

将 `agents/*.md` 复制到 `~/.pi/agent/agents/`（包注册见 `package.json` 与 `~/.pi/agent/settings.json` 的 packages）：

    cp agents/workhorse.md ~/.pi/agent/agents/workhorse.md
    cp agents/oldfox.md ~/.pi/agent/agents/oldfox.md

## 命令

`/fun-agent-cfg` — 配置 agent 的模型与思考强度：

- `/fun-agent-cfg get <agent>` — 查看当前 model/thinking
- `/fun-agent-cfg set <agent> model <provider/modelId>` — 设置模型
- `/fun-agent-cfg set <agent> thinking <level>` — 设置思考强度（off/minimal/low/medium/high/xhigh/max）
- `/fun-agent-cfg reset <agent>` — 删除 model/thinking，回退继承

改完 frontmatter 后**下一次 spawn 生效**，无需 /reload。

⚠️ 注意：对 rpiv 管理的 agent（codebase-analyzer 等）使用 set/reset 后，下次 `/rpiv-update-agents` 会覆盖你的设置。

## workhorse-gate 规则（workhorse 会话内生效）

1. write/edit 目标在 `$HOME` 之外 → 阻断
2. bash 含 sudo/su、`rm -rf`、`chmod/chown 777` → 阻断
3. write/edit 落在 `~/.pi/agent/` 内 → 阻断（含 gate 自身保护）
4. bash 重定向目标（`>`/`>>`/`tee`/`dd of=`）在 `$HOME` 外或 `~/.pi/agent/` 内 → 阻断

> 限制：workhorse-gate 是**事故拦截器**（tool_call 代码级检查），非 OS 级权限隔离——read/grep 等只读工具面不拦截；MCP 及其他未列入 write/edit/ctx_edit/ctx_patch/bash 的工具面不受检查。

## 配置

默认模型与思考强度直接在 agent frontmatter 中定义（workhorse: deepseek-v4-flash/high；oldfox: GLM-5.2/max），可用 `/fun-agent-cfg` 随时调整。
