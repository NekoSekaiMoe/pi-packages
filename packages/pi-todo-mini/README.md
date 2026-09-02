# todo

轻量三态任务清单 — `pending` / `in_progress` / `completed`。支持 session 持久化、状态栏、双列 widget、`/todos` TUI 视图，以及延迟 steer 驱动任务推进。

## 设计定位

| 维度 | todo | goal |
|------|------|------|
| 状态机 | **刻意无约束**，任意状态自由流转（含反向） | 7 态状态机 + 强制任务分解 |
| 持久化 | 复用 Pi 的 toolResult entry（不调用 appendEntry） | appendEntry 主动写入 |
| 定位 | 多步骤工作的临时进度追踪 | 持久化目标驱动循环 |

`in_progress` 非强制，`pending → completed` 直接跳转合法。

## 安装

```bash
pi install npm:@zhushanwen/pi-todo
```

## todo tool

### Action 与参数

| action | 参数 | 必填 | 行为 |
|--------|------|------|------|
| `list` | — | — | 返回全部 todo |
| `add` | `texts: string[]` | 是 | 批量追加，自动分配连续 ID，初始 `status=pending` |
| `update` | `id` + `status` 或 `text`；**或** `updates: Array<{id, status?, text?}>` | `id` 必填 | `updates[]` **优先于** single 的 `id/status/text` |
| `delete` | `ids: number[]` | 是 | 批量删除；**部分 id 缺失则整体拒绝**（原子性） |
| `clear` | — | — | 清空全部，重置 `nextId=1` 和完成态标记 |

- `status` 枚举：`pending` / `in_progress` / `completed`
- `add` 不接受 `status`（恒为 pending），不存在 `verifyTexts`（那是 goal 的概念）

### 错误处理约定

handler 失败**直接 `throw new Error()`**，不返回错误成功模式（见 CLAUDE.md「Tool 设计」）。常见错误：

| 触发 | 错误信息 |
|------|---------|
| `add` 缺 `texts` | `add requires texts parameter (non-empty array)` |
| `update` 缺 `id` | `update requires id parameter` |
| `update` 缺 `status` 和 `text` | `update requires at least status or text parameter` |
| `update` `text` 空串 | `text cannot be empty string` |
| `update` `status` 非法 | `status only accepts pending / in_progress / completed` |
| `update`/`delete` id 不存在 | `Todo #N not found` |
| `delete` 缺 `ids` | `delete requires ids parameter (non-empty array)` |

## Steer 机制（延迟注入）

todo 的核心驱动力是「延迟一拍」的 steer：

```
agent_end 设置 pendingSteerMessage
        → 下一 turn 的 before_agent_start 消费（用户不可见，display:false）
```

四个子机制（handlers.ts，阈值常量硬编码）：

| 机制 | 触发 | 行为 |
|------|------|------|
| **auto-clear** | 全部 completed 后再过 2 轮 | 自动清空 todos + 重置标记 |
| **completion-steer** | 首次全部 completed | 注入「检查交付质量」steer（一次性，`completionSteered` 防重） |
| **stall 检测** | 无 todo 活动达 5 轮 | 注入极简 reminder（仅下一个任务），整个 session 只触发一次 |
| **reminder** | 无 todo 活动达 2 轮 | 温和 reminder |

`agent_end` 内短路顺序：completion-steer **不短路**（继续往下），auto-clear / stall / reminder 各自短路 return。详见 `ARCHITECTURE.md`。

## 持久化机制

todo 扩展**自己不调用 `appendEntry`**。状态快照随 Pi 框架自动记录的 toolResult entry 落盘：

1. 每次 todo tool 调用，`execute` 返回的 `details.todos` / `details.nextId` 被 Pi 自动序列化为一条 `toolResult` entry
2. `session_start` / `session_tree` 时，`reconstructState` 回放**最后一条** todo toolResult 重建状态
3. 回放后 splice 掉更早的 todo toolResult（entry GC，从后往前删避免索引漂移）
4. 向后兼容：`migrateTodo` 把旧五态（`verifying→in_progress`、`failed→pending`）和极旧的 `done:boolean` 降级映射到三态

## 三层渲染

| 层 | 触发 | 规则 |
|----|------|------|
| **status line** | 每次 tool execute / session 恢复 | 空列表不显示；全完成 `✓ c/t`（绿）；否则 `☑ c/t` |
| **widget**（侧边） | 有 todo 时 | ≤8 项单列；≥9 项双列（规避 Pi 的 10 行 widget 截断） |
| **tool result** | tool 返回时 | collapsed 显示前 5 项 + `... N more`；expanded 全显示 |

## 命令

`/todos` — 进入只读 TUI 视图（`TodoListComponent`，固定双列布局）。Escape / Ctrl+C 关闭。需 interactive mode。

## 文件结构

```
todo/
├── index.ts              # 工厂入口（re-export src/index.ts）
├── PLAN.md               # [SUPERSEDED] v2 历史计划，保留作决策记录
├── ARCHITECTURE.md       # 架构详图（文件依赖 + steer 时序 + 事件流）
└── src/
    ├── index.ts          # 工厂入口（创建 state + 注册 tool/command/event）
    ├── state.ts          # TodoSessionState 会话状态接口 + 工厂
    ├── model.ts          # 纯函数数据层（类型/迁移/addTodos/updateTodos/format/buildGui）
    ├── tool.ts           # todo tool 注册 — 5 action + execute dispatcher
    ├── handlers.ts       # 5 事件处理器 + reconstructState + steer 四机制
    ├── render.ts         # status line / widget / tool result 三层渲染
    ├── component.ts      # /todos 的 TodoListComponent TUI 组件
    ├── commands.ts       # /todos 命令注册
    └── __tests__/        # 单测（model 纯函数 + widget 布局 + agent_end 数据条件）
```
