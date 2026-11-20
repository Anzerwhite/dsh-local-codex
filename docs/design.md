# DSH Codex 模式 —— 设计文档

- 状态：设计定稿（尚未实现）
- 日期：2026-11-20
- 领域词表：[CONTEXT.md](../CONTEXT.md)
- 决策记录：[docs/adr/](./adr/)

## 1. 背景与目标

### 1.1 需求

用户希望在 DeepSeek Harness（DSH）的 Web 会话里，**指定某个会话“使用 codex 模式”**：该会话此后的对话由本机 Codex（Codex CLI，沿用 `~/.codex/config.toml` 的模型与 provider）代理；DSH 负责把 codex 的对话过程**同步显示**在同一个对话流里，并把用户输入转发给 codex。模式**只在指定会话生效**，新建会话自动失效。

grilling 后确认的语义：

| 维度 | 结论 |
|---|---|
| Codex 角色 | **全权接管**：指定会话的对话代理就是本机 Codex；从开启起，DSH 不再为该会话调用自己的模型（会话标题/压缩等辅助调用除外），也不使用 DSH 原生工具 |
| 显示保真度 | 正文**流式**显示；命令执行、文件改动、工具调用以**可折叠的通用工具卡片**呈现；不逐 token 展示推理 |
| 显示位置 | **并入该会话现有对话流**，与开启前的 DSH 对话连续；不新建会话、不加独立页签 |
| 激活/退出 | **触发词 + 斜杠命令双通道**：句首触发词（可带附带内容）；`/codex on\|off\|status` |
| 历史衔接 | 开启时把此前对话的**最近历史摘要/截断原文**作为初始化上下文注入新 codex 线程（一次性） |
| 生命周期 | 模式与 codex threadId **持久化**；DSH 重启后重开同一会话仍为 Codex 模式并续接线程；新会话与 fork 默认关闭 |
| 权限来源 | **以 DSH 会话权限预设为准**，逐轮映射为 codex 的 sandbox/approval；codex 审批请求转 DSH 审批卡片 |
| 模型显示 | 开启时把会话模型切换到插件注册的 codex 模型（UI 模型选择器如实显示），关闭时恢复原 DSH 模型 |
| 停止 | 中断当前 codex 轮（`turn/interrupt`），保留已生成内容为“已中断”助手消息，模式保持 |
| 失败 | 显示错误卡片、模式保持、后台自动重建 app-server 并尝试 resume 线程；可手动重试或 `/codex off` |
| 附件 | 图片转 codex `localImage`；普通文件落盘到会话工作区并把路径告知 codex |
| 模式标识 | 不需要额外常驻标识；模型选择器 + 开关回执足够 |
| 实现路线 | **自研薄插件**，复用 codex app-server 协议与 ds-harness-remote 的 MIT app-server 客户端实现经验 |

### 1.2 非目标（v1）

- 不做独立的 Codex 页签/侧栏/徽标组件。
- 不做终端/diff 定制卡片（用 DSH 通用工具卡片；但保留 codex 原始 item 数据以便后续升级）。
- 不做逐 token 推理展示；不做 codex 计划/待办专用卡片（计划更新可作为普通文本提示或忽略）。
- 不做远程/多用户场景；不修改 DSH 内核、不引入自定义会话事件类型。
- 不支持 codex 内建的交互式 approval TUI；审批统一走 DSH。
- 不做模式在会话间的迁移/共享（fork 不继承）。
- 不转发 DSH 的系统提示/persona/技能给 codex；codex 使用自己的 AGENTS.md、配置与工具。

## 2. 领域语言

术语与禁用词见 [CONTEXT.md](../CONTEXT.md)：Codex 模式、指定会话、本机 Codex、Codex 线程、同步、初始化上下文、触发词。

## 3. 关键决策

| ADR | 决策 | 一句话理由 |
|---|---|---|
| [0001](./adr/0001-codex-as-llm-provider-adapter.md) | 用 LLM provider adapter 承载 Codex，会话级路由切换 | 唯一无需改内核、又能复用聊天 UI/fork/resume/Stop 的接入点 |
| [0002](./adr/0002-codex-activity-as-native-session-events.md) | Codex 活动以原生会话事件呈现（正文 chunk + 桥接工具调用） | 第三方插件不能持久化自定义事件，独立视图又无法并入同一对话流 |
| [0003](./adr/0003-codex-app-server-transport.md) | 用 `codex app-server` stdio JSON-RPC，基线 codex-cli 0.170.0 | exec --json 无增量/中断/审批，app-server 是唯一可做实时 UI 的模式 |
| [0004](./adr/0004-dsh-permission-preset-authority.md) | 权限以 DSH 会话权限预设为准 | DSH 界面里切的权限必须真实生效，不能出现两套安全语义 |
| [0005](./adr/0005-session-scoped-mode-persistence.md) | 模式按 sessionId 持久化并续接 codex 线程 | “仅指定会话生效、新会话失效”要求状态属于会话且可跨重启恢复 |

## 4. 架构总览

### 4.1 组件

```text
┌──────────────────────────────────────────────────────────────────┐
│ DSH Web UI（现有 Chat，零改动）                                    │
│  模型选择器、工具卡片、审批卡片、停止按钮、附件                       │
└───────────────▲──────────────────────────────────────────────────┘
                │ 标准会话事件 / 标准 API
┌───────────────┴──────────────────────────────────────────────────┐
│ DSH agent-loop（现有）                                             │
│  pre-step → agent/request 路由 → llm.stream → 派发工具 → 落盘事件   │
└───────────────▲──────────────────────────────────────────────────┘
                │ GenerateOptions / StreamChunk
┌───────────────┴──────────────────────────────────────────────────┐
│ dsh-codex-mode（本插件，host 插件）                                 │
│  mode controller  │  codex adapter  │  bridge tool  │  bootstrap  │
└───────────────▲──────────────────────────────────────────────────┘
                │ stdio JSON-RPC（换行分隔）
┌───────────────┴──────────────────────────────────────────────────┐
│ codex app-server（单子进程，多线程复用）                             │
│  thread/start|resume · turn/start|interrupt · 通知流 · 审批请求      │
└───────────────▲──────────────────────────────────────────────────┘
                │
      本机 Codex 线程、工具执行、provider（~/.codex/config.toml）
```

本插件**没有 client 半端**：会话流、模型标签、工具卡片、审批卡片全部由 DSH 现有 UI 从标准事件渲染（这是架构选择带来的最大收益）。

### 4.2 一次用户轮的时序

1. 用户消息进入会话：`user/message` 落盘，loop 打开 turn。
2. `agent/pre-step`（插件，prepend 监听）：触发词检测。若命中控制指令，则执行开/关并 `reject` 该 step（不送模型）。
3. loop 组装请求：`agent/request`（插件）把 provider/model 改写为插件注册的 codex 路由。
4. codex adapter 被调用（`bench` = 一个 step 的一次 `llm.stream`）：
   - 首次调用：必要时 `thread/start`（cwd = 会话工作目录；`developerInstructions` 携带初始化上下文与环境说明）或 `thread/resume`；
   - 对最新未消费的用户消息 `turn/start`（附件转换后作为 input；per-turn cwd/sandbox/approval）；
   - 消费 app-server 通知：`item/agentMessage/delta` → `text-delta`；`item/reasoning/*` → `reasoning-delta`；
   - 遇到命令/文件等工具活动：结束当前正文块，发出指向桥接工具的 `tool-call`，`finish('tool-calls')`。
     注意：loop 的派发只由 assistant 消息里的 `tool-call` 块决定，finish reason 并不 gate；但**绝不能**在含 tool-call 的响应上用 `finish('max-tokens')`（assembler 会丢弃全部 tool call 并结束轮次）。
5. loop 派发桥接工具 → 落盘真实 `tool/call` + `tool/result` → 工具卡片渲染 → 同 turn 内请求下一 step。
6. adapter 继续消费 codex 通知（**不**启动新 codex 轮），直到 `turn/completed`：发 `finish('stop')` 与 `usage` 映射，loop 关闭 turn。
7. 用户点停止：adapter 的 abort signal 触发 → `turn/interrupt` → codex 回 `turn/completed`（interrupted）→ 已输出正文保留为 interrupted 助手消息。

### 4.3 模式状态机

```text
off ──触发词/命令──▶ enabling ──成功──▶ on
 ▲                    │失败                │
 │                    ▼                   │
 └────── off ◀──(恢复模型路由)─────────────┘
on  ──停用后重开──▶ on（resume 原 codex 线程，不重复初始化上下文）
```

- `enabling`：写模式状态 → 切换会话模型（catalog 校验）→ 记录进入前模型路由 → 必要时建线程（注入初始化上下文）→ 注册桥接工具。
- `off`：注销桥接工具 → 恢复进入前模型路由 → 保留 threadId 供下次续接。
- 启动恢复：插件加载后读 storageDomain；遇到模式为 on 的会话被打开/恢复时，按需要重建 app-server、resume 线程、注册桥接工具。

## 5. 模块设计

包结构（建议）：

```text
dsh-codex-mode/
  package.json          # main=host 半端；dsh.bundle.patch 指向 cordis.patch.yml
  cordis.patch.yml      # 插入插件配置 + pin 标题/压缩路由
  src/
    index.ts            # 插件入口、Config schema、服务组装
    mode/state.ts       # storageDomain 声明与读写
    mode/controller.ts  # 开/关/恢复、模型切换与回退
    mode/trigger.ts     # 触发词语法、/codex 命令
    adapter/index.ts    # LlmAdapter 实现、provider 元数据、listModels
    adapter/turn-state.ts # 每会话状态：codex turn、消息游标、事件队列
    adapter/mapping.ts  # app-server 通知 → StreamChunk / 桥接调用
    bridge/tool.ts      # defineTool 展示工具与生命周期
    codex/app-server.ts # stdio JSON-RPC 客户端（可参考 ds-harness-remote MIT 实现）
    codex/runtime.ts    # 子进程生命周期、线程缓存、turn 控制、审批回写
    codex/protocol.ts   # 所需请求/通知的最小类型与未知项容忍
    bootstrap.ts        # 初始化上下文构建（token 预算）
    attachments.ts      # DSH 附件 → localImage / 落盘文件
    errors.ts
  test/
```

### 5.1 模式状态存储

`storageDomain`（host 侧、schema 校验、跨重启持久）：

```text
domain: codex-mode  version: 1
table: sessions
  key: SessionId
  value: {
    enabled: boolean
    codexThreadId?: string
    previousRoute: { provider: string, model: string, reasoningEffort?: string } | null
    updatedAt: number
  }
```

跨会话隔离由 key 保证；fork 产生新 SessionId，因此默认无记录（模式关闭）。

### 5.2 激活、退出与触发词

**触发词语法**（句首、可带附带内容）：

```text
^[\s，,。.!！:："'“”]* (使用|开启|进入|切换到)\s*codex\s*模式
^\s*(use\s+codex\s+mode|enable\s+codex\s+mode|codex\s+mode\s+on)
退出：^...?(退出|关闭|结束)\s*codex\s*模式 / (exit|disable)\s+codex\s+mode
```

- 触发词后可跟 `[：:，,。.!！\s]`，其后剩余文本为附带内容。
- **无附带内容**：只切换模式；触发词消息作为控制指令被拒绝进入模型，显示一张控制回执卡片。
- **有附带内容**：切换模式，并把附带内容作为该轮输入（开启后即发送给 codex）。
- 触发词本身不进入模型历史（控制指令被 reject）。
- 触发词表、开关词表均为可配置项（中文/英文默认表）。

**斜杠命令**（`ctx.commands.register`，不产生模型消息、落盘为 `command/run|done`）：

```text
/codex on      开启（若未开启）
/codex off     关闭（若已开启）
/codex status  报告模式、模型、codex 线程、app-server 状态
```

**控制回执的实现路径**：模式控制与回执尽量复用 DSH 命令通路（命令日志 + 通用命令卡片）。若宿主插件不能直接调用命令执行入口，退化为：在对话流中由插件发布一次性的客户端提示（需要极薄的 client 半端）——实现阶段实测后二选一，不影响其余架构。

### 5.3 模型路由

- 开启时：`ctx.sessionController.selectModel({ sessionId, provider: 'codex', model: <codex 模型 id> })`，要求该模型已在 adapter 的 `listModels()` 目录中；同时把当前会话路由记录到 `previousRoute`。
- `agent/request` 监听器（prepend）：模式 on 时改写请求 config 为 `{ provider: 'codex', model: <codex 模型>, reasoningEffort: undefined }`；模式 off 但残留 codex 路由时恢复 `previousRoute`（或部署默认路由）。
- `codex` 路由的 `listModels()` 由 adapter 依据 `~/.codex/config.toml` 的 `model`（及可选的配置项 `modelAllowlist`）提供；UI 模型选择器因此显示 codex 模型。
- **辅助调用**：adapter 对 `options.purpose !== undefined`（`compaction` / `session-title`）直接抛错；同时 `cordis.patch.yml` 把会话标题与压缩的 provider/model 固定到部署默认的 DSH 路由，确保辅助任务不走 codex、不消耗 codex 额度。

### 5.4 codex adapter

- `class CodexAdapter extends LlmAdapter`，注册 provider 路由 `codex`；`stream(options)` 是唯一必需实现。
- 会话级状态：`codexThreadId`、`activeTurn`、`eventQueue`、`consumedMessageIds`、`bridgeCalls`（callId → 展示数据）、`bootstrapDone`。
- **轮次识别**：用 `options.messages` 中持久消息的 MessageId 与 `consumedMessageIds` 对比——出现新的用户消息即启动一个新的 codex `turn/start`；否则（同一用户轮的后续 step，通常带桥接工具结果）继续消费当前 codex 轮队列。
- **首次请求**：若无线程 → `thread/start`（`cwd` = 会话工作目录，`developerInstructions` = 环境说明 + 初始化上下文）；若线程存在但 codex 侧已不存在 → 重建并重新注入初始化上下文。
- **流映射**：`item/agentMessage/delta` → `text-delta`；`item/reasoning/summaryTextDelta|textDelta` → `reasoning-delta`；`item/commandExecution/outputDelta` 在工具卡片结果中汇总，不重复成正文；`turn/completed` → `usage` + `finish('stop')`；codex `turn.completed.status` 失败 → 抛出可读错误。
- **工具活动切分**：当 command/file/mcp/web-search/plan 等 item 出现时，结束当前 assistant 文本块并发送 `tool-call` 块（桥接工具名 + 结构化 JSON 参数），`finish('tool-calls')`；loop 执行桥接工具后再被调用，继续消费。
- **取消**：`options.signal` abort → 发送 `turn/interrupt`，把已收到的正文作为部分内容保留，`finish('aborted')`。
- **错误**：app-server 崩溃/超时/鉴权 → 抛错（loop 展示错误状态）；runtime 在下一轮自动重启并尝试 resume。

### 5.5 桥接工具（已通过源码审查 + 探针验证：可行，无需改内核）

- `defineTool({ name: 'codex_activity', ... })`，仅当模式 on 时通过该 agent 的作用域（`agent.ctx.tools.register`）注册；**在 turn/end 之后注销**（绝不 step 中途注销）。
- **流块形态**（dsh-llm）：`block-start{index, blockType:'tool-call'}`（可选）→ 若干 `tool-call-delta{index, id, name?, argumentsDelta}`（每个 delta 必须带 id）→ 可选权威 `block-end{index, block:{type:'tool-call', id, name, arguments}}`；`usage` 必须在 `finish` 前发出，`finish` 之后不再有任何 chunk。
- 参数（模型不可见，由 adapter 发出）：`{ kind, title, command?, cwd?, exitCode?, output?, diff?, status?, durationMs?, raw? }`；输出为声明的 JSON 值，`render` 生成可读文本块（命令 + 输出 / 统一 diff）。
- `execute` 无副作用：从 adapter 队列按 callId 取回展示数据；**在工具体内 await 对应 `item/completed`**，让 `tool/result` 落盘时即带最终输出（卡片 running → settled）；找不到时返回“展示数据缺失”错误结果（不重跑命令）。
- 派发不校验 request header 中的工具清单；未知工具只是 isError 结果、轮次继续。因此桥接工具必须在模式 on 期间真实注册。
- 默认审批为放行（只有未挂载的 auto-review 会发 `ask`），无需为展示工具请求审批；`isConcurrencySafe` 不设置，保持串行语义。
- 一**个用户轮内的 step 数无上限**：增加 `maxBridgeCallsPerTurn` 配置作为动作预算，超限/桥接工具返回错误时以可读错误结束该轮。
- 输出体积受 DSH spill 策略影响（约 12.5k tokens 后终端类卡片降级）；对单条输出做上限截断并在结果里注明。
- 会话日志中出现 `tool/call`/`tool/result` 是预期的；UI 渲染为通用折叠卡片（Q13 决策）。
- **可选增强（不在 v1 范围）**：桥接工具改用 `bash`/`pwsh` 或 `write`/`edit` 的线名并伪造对应 args/meta，可零客户端代码复用 DSH 原生终端/diff 卡片；代价是工具遮蔽语义、延迟注销与体积降级处理，留待后续评估。

### 5.6 Codex 运行时（app-server 客户端）

- 一个插件进程维护**一个** `codex app-server` 子进程，惰性启动；会话以 `threadId` 路由。
- 握手：`initialize`（clientInfo：`dsh-codex-mode`）→ 接收响应后再发业务请求；请求/响应按 id 关联，通知按 `threadId` 分发。
- **通知读取与 `stream()` 解耦**：独立 reader 协程持续消费 stdout 并按 threadId 入队；`stream()` 只消费队列。若把读取绑在 `stream()` 上，工具卡片等待 `item/completed` 时会死锁。
- 线程：`thread/start`（cwd、approvalPolicy、sandbox、baseInstructions/developerInstructions、model 可选）与 `thread/resume`；threadId 持久化在模式状态。
- turn：`turn/start`（threadId、input、cwd、approvalPolicy、sandboxPolicy、model/effort 可选）；`turn/interrupt`。
- 审批：app-server 的 `item/commandExecution|fileChange|permissions/requestApproval` 等 server-request → `ctx.approval.request({ agent, tool, reason, signal })`（turn 打开期间合法，agent 由 sessionId 取得）→ 回写 accept/decline/cancel。
- 进程治理：启动失败/崩溃 → 指数退避重启（有限次数）；`dispose` 时 SIGTERM → 超时 SIGKILL；写锁/重复进程风险见风险节。
- 未知通知与未知 item：忽略并记录（debug 日志），不影响已支持的能力。
- 版本兼容：以 codex-cli 0.170.0 协议为基线；启动时读取 `codex --version`/握手做能力探测；不匹配时给出可读错误。

### 5.7 初始化上下文

- 来源：DSH `session.deriveMessages()` 中开启前的历史；只取用户/助手正文，工具结果压缩成一行摘要；按 token 预算（默认 ~8k，可配）从近到远截取。
- 不转发 DSH 的系统提示/persona/技能；codex 使用自己的 AGENTS.md、配置与工具。
- 结构：一段 `developerInstructions`，包含（a）一句“你由 DSH 的 Codex 模式驱动，接管以下会话”；（b）环境说明（会话工作目录、权限策略）；（c）历史摘录。
- 只在线程**创建**时注入一次；再次开启（resume 既有线程）不重复注入。
- 线程丢失重建时重新注入，并在对话里提示“历史已重新同步给 codex”。

### 5.8 附件

- 只处理最新用户消息携带的附件；DSH 的显示不受影响。
- 图片：经 `ctx.attachments` 取出字节 → 临时文件 → `turn/start` 的 `localImage` 输入。
- 普通文件：写入会话工作区 `.dsh-codex-mode/attachments/<turn>-<name>`，并以文本输入告知 codex 绝对路径（codex 用自身工具读取）。
- 清理策略可配：turn 结束即删 / 保留 N 天；工作区临时目录在会话结束时可清理。
- 未能转换的附件 → 在错误卡片/文本中显式说明，不静默丢弃。

### 5.9 停止、失败与恢复

| 场景 | 行为 |
|---|---|
| 用户停止 | abort → `turn/interrupt`；保留部分正文（interrupted 助手消息），模式保持 |
| codex 轮失败/鉴权错误 | 该轮错误状态可见（可读原因）；模式保持；下一轮自动重建 app-server 并 resume |
| app-server 崩溃 | 同上；线程 resume 失败 → 重新建线程 + 初始化上下文 + 提示 |
| 超时/协议不匹配 | 可读错误；建议 `/codex status` 或 `/codex off` |
| 会话关闭/插件卸载 | 终止子进程；threadId 保留（下次续接） |
| 新会话 / fork | 无状态 → 普通模式 |
| 同一会话多个标签页 | 模式状态在 host 侧一致；模型选择器与事件流天然共享 |

## 6. 配置与安装

`package.json`（建议）：

```jsonc
{
  "name": "dsh-codex-mode",
  "type": "module",
  "main": "./dist/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-agent": "...",
    "@deepseek-ai/dsh-llm": "...",
    "@deepseek-ai/dsh-tools": "...",
    "@deepseek-ai/dsh-session": "...",
    "@deepseek-ai/dsh-storage-domain": "...",
    "@deepseek-ai/dsh-commands": "...",
    "@deepseek-ai/dsh-user-approval": "...",
    "@deepseek-ai/dsh-permission-presets": "...",
    "@deepseek-ai/dsh-attachment": "..."
  }
}
```

`cordis.patch.yml` 内容要点：

1. 插入插件行与配置（codex 可执行文件路径、触发词表、初始化上下文预算等）。
2. 把会话标题与压缩的 provider/model 固定到 DSH 默认路由。
3. 如使用 `ds-harness-remote`，建议关闭其 Codex 域（避免重复 app-server / 线程写锁竞争）。

安装（开发期）：构建到 `dist/` 后用 `dsh plugin --profile web add -w /workspace/dsh_ifself`（或把包路径写进 profile `package.json` 的 `dsh.profile.bundles`）；profile 为 `patchReload: live`，重载后生效。发布形态：npm 包 + plugin manager 安装。

可配置项（`Config` schema 草案）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `codexBin` | `codex`（PATH/`~/.npm-global/bin`） | codex 可执行文件 |
| `providerName` | `codex` | 注册的 LLM provider 路由名 |
| `model` | 读 `~/.codex/config.toml` | 模型目录与默认选择 |
| `triggerPhrases.on/off` | 中英文内置表 | 触发词表 |
| `bootstrapTokenBudget` | 8000 | 初始化上下文预算 |
| `verifyApprovals` | `true` | 审批桥接开关 |
| `appServer.requestTimeoutMs` | 60000 | 单请求超时 |
| `restart.maxAttempts` | 3 | 崩溃重启上限 |
| `attachments.retention` | `turn` | 附件清理策略 |

## 7. 验收场景

1. **新会话默认普通**：新建会话直接提问，由 DSH 模型回答；codex 进程不被拉起。
2. **触发词开启（无附带内容）**：发“使用codex模式” → 模式开启、模型选择器变为 codex 模型、出现控制回执；codex 未被该消息调用。
3. **触发词开启（带内容）**：“使用codex模式：帮我修一下测试” → 开启并把“帮我修一下测试”作为首轮发给 codex。
4. **同步显示**：codex 回复流式出现；其执行的命令/文件改动以可折叠工具卡片按发生顺序出现在正文之间。
5. **新会话失效**：再开一个新会话，默认仍为 DSH 模型，无 Codex 模式。
6. **退出恢复**：`/codex off`（或其触发词）→ 模型选择器恢复原 DSH 模型；后续由 DSH 模型回答。
7. **重启续接**：开启模式并对话若干轮后重启 DSH，重开同一会话 → 模式仍在，提问一句能延续 codex 上下文（可复述之前内容）。
8. **前情提要**：在已有 10 轮 DSH 对话中开启模式，codex 能正确接上之前的背景要点。
9. **会话隔离**：两个会话并行，一个 Codex 模式、一个普通；交错提问互不串台，模型标签各自正确。
10. **停止**：codex 执行长任务时点停止 → codex 当前轮中断，已输出正文保留，随后可继续下一轮。
11. **权限**：把会话权限切到 `workspace-write` 或 `read-only` 后，codex 的命令受相应限制；`ask` 时出现 DSH 审批卡片并可批准/拒绝。
12. **附件**：发图片 → codex 能看到并描述；发文件 → codex 能读取落盘路径内容。
13. **故障恢复**：杀掉 app-server 进程或断开网络 → 该轮显示错误，模式保持；下一轮自动重建并续接线程。
14. **fork 不继承**：fork 会话默认普通模式。
15. **命令通道**：`/codex status` 正确报告状态；`/codex` 命令本身不进入模型历史、不消耗 codex。
16. **辅助调用隔离**：Codex 模式下会话标题/压缩仍由 DSH 默认模型完成（不出现 codex provider 请求）。

## 8. 实现计划

| 阶段 | 内容 | 验收门 | 估时 |
|---|---|---|---|
| P0 Spike | 空插件装入 web profile；注册 `codex` provider；`listModels` 出现在模型选择器；假 adapter 回显文本并落真实 assistant/message | 插件可加载、模型可选、对话可回显 | 0.5–1 d |
| P1 模式控制 | storageDomain、触发词/pre-step、`/codex` 命令、模型切换/恢复、控制回执 | 验收 2、3、6、14、15 | 1–2 d |
| P2 Codex 运行时 | app-server 客户端（握手、线程、turn、通知路由、interrupt、审批、重启） | 单会话一轮文本走通；停止可中断 | 2–3 d |
| P3 adapter 流映射 | 轮次识别、text/reasoning delta、usage、错误、abort、初始化上下文注入 | 验收 4（正文）、7、8、9、10、13 | 2–3 d |
| P4 桥接工具 | 注册/注销生命周期、synthetic tool-call、结果取回、卡片渲染、动作预算、顺序 | 验收 4（工具卡片） | 2–3 d |
| P5 附件与权限 | 图片/文件转换、权限映射、审批桥接 | 验收 11、12 | 1–2 d |
| P6 硬化与交付 | 重启/重连/并发/超时、测试、文档、打包安装 | 全部验收 + 回归清单 | 2–3 d |

合计约 **1.5–2.5 周**（含调试）。P0–P3 是主链路，P4 决定“同步器”体验是否达标。

## 9. 风险与待验证项

1. **桥接工具**：已通过源码审查与探针验证可行（chunk 形态、loop 派发、agent 作用域遮蔽、卡片渲染顺序、无 step 上限均已确认）。仍需端到端验证：agent-scoped 工具注册/注销时机与请求头变化、超长输出 spill 降级、`maxBridgeCallsPerTurn` 预算下的错误收口。备选方案：自己的工具名 + 通用卡片（v1 基线）；或遮蔽 `bash`/`write` 线名换取原生终端/diff 卡片（可选增强）。
2. **控制回执路径**：`ctx.commands.execute` 能否由 host 插件直接调用待验证；否则引入极薄 client 半端做一次性提示。
3. **模型目录与切换**：`selectModel` 要求模型在 catalog；插件加载顺序、模型目录刷新、UI 标签更新时机需验证。
4. **codex app-server 的 experimental 属性**：版本漂移、未知通知/字段、`turn/started` 延迟、首个命令输出 delta 缺失（需用 `aggregatedOutput` 兜底）等。
5. **与 ds-harness-remote 共存**：其 Codex 域会另起 app-server，可能与线程写锁/资源竞争；建议关闭或明确只保留一个。
6. **codex 认证形态**：当前 `codex login status` 显示未登录，但 `~/.codex/config.toml` 的自定义 provider（`requires_openai_auth=false` + bearer token）实测可用；provider 变更时需重新确认。
7. **审批桥接细节**：DSH 审批卡片在 codex 模型路由下的渲染与超时；turn 打开期间的 `userApproval.request` 合法性。
8. **附件 API**：从 `ctx.attachments` 合法取出字节/路径的方式；图片格式白名单与体积上限。
9. **辅助路由 pin**：会话标题/压缩插件的具体 id 与配置字段需按 web profile 实际 bundle 确认。
10. **token/成本口径**：codex 的 usage 与 DSH token meter 口径差异（缓存字段），需在 UI 上避免误导。

## 10. 参考资料

- codex app-server 协议：`codex app-server generate-ts --out <dir>` 与 `generate-json-schema` 可离线生成；本次研究产物在 `/tmp/dsh-codex-research/`（临时）。
- ds-harness-remote（MIT）：`dist/codex/app-server.js` 等 host 半端实现可参考/复用（注意用 0.6.6，而非本机安装的 0.6.3）。
- DSH 包文档：`@deepseek-ai/dsh-llm`（adapter/GenerateOptions/StreamChunk）、`dsh-agent`（`agent/pre-step`、`agent/request`、agent scoped ctx）、`dsh-tools`（defineTool）、`dsh-commands`、`dsh-storage-domain`、`dsh-user-approval`、`dsh-permission-presets`、`dsh-api-session-controller`（selectModel/modelCatalog）。
- 先例：`dsh-codex-native@0.2.5`（provider 形态的既有插件，未做工具卡片与触发词）。


## 11. 实现状态与偏差（2026-11-20）

P0–P4 主链路已实现并在本机 Web profile 安装运行；P5 的权限映射与附件物化已实现，真实附件/审批场景未做端到端验证；P6 的失败重建已有基础实现与诊断日志。验收证据见 [verification.md](./verification.md)。

实现中相对本设计的偏差/补充：

- `turn_completed(status='failed')` 输出 `finish(kind:'error')`（原契约表写 stop），保证失败可见。
- 合成 tool-call 的参数严格为 `{ callId, kind, title }`；命令/查询折叠进 `title`，完整 item 数据留在 adapter pending 内供 `takeResult` 生成结果文本。
- bootstrap 只收真正的用户/助手正文，排除 runtime-context 注入与触发词消息。
- 新增动作预算 `maxBridgeCallsPerTurn`（默认 200）：DSH loop 无 step 上限，超出预算以错误结束该轮。
- 修复“活动先结算、流后消费”的桥接竞态：保留 itemId→pending 映射到 turn 清理，晚到的 `item_started` 复用已结算 pending，工具卡片拿到真实输出。
- 思考强度：adapter 在模型目录声明 Codex 档位（minimal/low/medium/high/xhigh，默认取 Codex 配置），`agent/request` 保留并映射 effort（DSH `max` → `xhigh`），adapter 逐轮传给 `turn/start.effort`；`/codex status` 显示会话实际档位。
- 模型上下文窗口在适配器元数据中沿用 200k 声明（provider 实际报告约 475k），只影响 UI 容量估算。
- `thread/resume` 在真实 profile 下较慢（5–30s，Codex hooks/skills 加载）；v1 无“准备中”提示。
- 运维事实：web profile 以 `link:/workspace/dsh_ifself` 安装；本机 profile 环境原本缺少 `pnpm`，为让 Plugin Manager 能安装，创建了 `/usr/bin/pnpm` shim 指向 corepack 缓存（pnpm 11.24.0）。插件代码更新后，关闭再开启 bundle 以加载新模块。
- Codex reasoning 摘要文本在本机 provider 下不可用（仅 token 计数），因此“思考过程”不可见；档位可见可调。
- **线程占用释放**：app-server 以 `-c thread_unload_delay_secs=0` 启动；`/codex off`（或会话/插件销毁）时调用 `thread/unsubscribe`，Codex 线程会在数百毫秒内 unload 并释放 `~/.codex/thread-writer-locks` 上的 flock，原生 Codex TUI 可立即重开该线程；threadId 保留，重新开启时 `thread/resume`。模式开启期间线程由 DSH 持有属预期行为。
