# pi-dsh-minimal

在 pi 内复刻 DeepSeek Harness `minimal` preset 的 **anchored-standard** 流程：
先以「单句 persona + 双工具」锚定首轮轨迹，首条真实消息完成后晋升回完整 pi 配置。

## 触发规则（模型门控）

未命中的会话**完全不生效**（不注册工具、不改写任何内容）：

| provider | 规则 |
|---|---|
| `deepseek` | 所有模型触发 |
| `opencode` | id 含 `deepseek-v4-flash` / `deepseek-v4-pro` 即触发（无论日期后缀） |
| 其他 | 仅 id 含 `deepseek-v4-flash-0731` / `deepseek-v4-pro-0813`（id+日期）才触发 |

禁用：`PI_DSH_MINIMAL=off`。

## 配置（环境变量）

| 变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `PI_DSH_MINIMAL_PROMPT` | `strict` / `append` | `strict` | strict：system prompt 字节级等于 persona（payload 级强制）；append：persona 只替换 pi 默认基础提示词，插件注入/skills/AGENTS.md 等追加保留 |
| `PI_DSH_MINIMAL_TOOLS` | `strict` / `append` | `strict` | strict：只有 bash + str_replace_editor；append：minimal 对在前 + 除 read/edit/write 外的默认工具 |
| `PI_DSH_MINIMAL_UA` | `off` / 自定义字符串 | 发送 DSH UA | 门控命中后全程发送 DSH 归因请求头 `user-agent: deepseek-harness/0.1.0-rc.7 (+https://github.com/deepseek-ai/deepseek-harness)`（上游 attribution.ts 强制此行为）；`off` 关闭，其他值整体替换 |
| `PI_DSH_MINIMAL_PERSONA_EXTRA` | 字符串 | 无 | 追加到 persona 后（引导语实验用，偏离字节级复刻） |
| `PI_DSH_MINIMAL_FORCE` | `1` | 无 | 绕过模型门控（机制验证用） |

## 消融记录（deepseek-v4-pro，同题 n=4~6，首轮 minimal-like 占比）

按 index.md 朋友的宽松配方在本机做了全因子消融：

| prompt \ tools | strict（2 个） | append（21 个） |
|---|---|---|
| **strict**（仅 persona） | **3/4** | 2/4 |
| **append**（persona+AGENTS 等） | 1/4 | 0/6 |

结论：本机环境下锚定强度主要由 prompt 真空度决定，宽松工具目录也会稀释；
两者都宽松（朋友的配方）时未复现。朋友环境下能稳定复现，差异可能来自
其注入的记忆内容 / 扩展集合 / 模型端点。默认值取唯一稳定复现的
strict/strict，宽松组合可用环境变量自行实验。

## 流程

```
session_start（命中门控）
  │
  ├─ 注册 DSH 同款 bash（覆盖内置）+ str_replace_editor
  ├─ setActiveTools([bash, str_replace_editor])
  ├─ 交互模式：自动发送可见热身消息
  │   「你好，请问你可以做什么？这个仓库是干什么用的？」
  │   （print 模式 CLI prompt 已在处理，跳过热身直接锚定首轮真实消息）
  │
  ▼ bootstrap 阶段（热身轮 + 首条真实消息）
    system prompt = "You are a helpful software engineer assistant."
    （before_agent_start 整句替换 + before_provider_request payload 级强制，
      即使其他扩展追加内容，线上 payload 仍与 DSH 字节一致）
  │
  ▼ 首条真实消息的 agent_end → 晋升 resident
    setActiveTools(恢复 pi 默认全集)
    system prompt 恢复 pi 正常组装（默认提示词 + 插件 + skill + AGENTS 上下文）
```

## 命令

- `/dsh-minimal-status` — 门控结果 / 当前阶段 / 活动工具

## 与上游的差异

- bash 用管道而非 PTY（stderr 以 `2>&1` 合并模拟交错输出）
- bash 覆盖在命中会话内全程有效（晋升后仍是持久版）
- 无沙箱策略层；compaction 未禁用
- 会话中途切换模型不会重新判定门控

## 免责

与 DeepSeek 无关，非官方工具。DSH 文本摘录自本地
`../deepseek-harness` 仓库，上游变更需同步。
