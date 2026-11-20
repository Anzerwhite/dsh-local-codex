# dsh-codex-mode — 实现契约 v1

所有并行实现必须遵守本文件。接口变更必须先改本文件并通知 Lead。设计背景见 [docs/design.md](./design.md)。

## 0. 全局规则

- **语言**：纯 ESM JavaScript（`.js`），不引入 TypeScript/构建步骤。Node 24。
- **禁止**：写 `$DSH_PROFILE_DIR` 下的任何文件、运行 `dsh plugin`/pnpm、调用 `plugin_manager`、修改 /root/.dsh 配置。安装由 Lead 通过 `plugin_manager` 完成。
- 只在各自的写作用域内创建文件；测试脚本放 `scratch/<owner>/`，不要改动别人作用域。
- codex 可执行文件：`/root/.npm-global/bin/codex`（不在默认 PATH 上），CLI 0.170.0。
- codex app-server 协议资料：`/tmp/dsh-codex-research/appserver-ts/`（生成的 TS 类型）、`/tmp/dsh-codex-research/appserver-schema/`、`/tmp/dsh-codex-research/codex-protocol.md`；实测脚本 `/tmp/dsh-codex-research/appserver*.py`。
- DSH 包源码/类型：`/root/.local/share/deepseek-harness/app/node_modules/@deepseek-ai/`。本仓库 `node_modules/` 里已有指向这些包的软链（`@deepseek-ai/dsh-llm`、`dsh-tools`、`dsh-storage-domain`、`dsh-session`、`zod` 等），测试脚本可直接 import 以复用官方类型/Assembler。
- 日志：使用注入的 `log` 对象 `{debug, info, warn, error}`，绝不 `console.log` 到 stdout（会污染 host/app-server 协议）。

## 1. 文件布局与归属

| 路径 | 负责人 | 内容 |
|---|---|---|
| `index.js` | Lead | 插件入口 `apply(ctx, config)`、服务接线、生命周期 |
| `src/mode/controller.js` | Lead | 模式状态、触发/命令、模型路由、pre-step、agent/created 桥接工具注册 |
| `src/mode/state.js`, `src/mode/trigger.js` | Lead | 持久化状态、触发词语法 |
| `src/shared/messages.js` | Lead | DSH 消息内容提取/文本化工具 |
| `src/codex/app-server.js` | T-codex | stdio JSON-RPC 传输 |
| `src/codex/runtime.js` | T-codex | 线程/turn 生命周期、通知归一化、审批、重启 |
| `src/adapter/adapter.js` | T-adapter | LlmAdapter 实现、流映射、桥接调用发射 |
| `src/bridge/tool.js` | T-adapter | 桥接工具定义（codex_activity） |
| `test/**`, `dev/**` | T-test | 无 Web 端到端 harness、overlay patch、验收脚本 |
| `scratch/<owner>/**` | 各自 | 临时冒烟脚本 |
| `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg`, `docs/` | Lead | 包与文档 |

## 2. T-codex：`src/codex/app-server.js` + `src/codex/runtime.js`

### 2.1 `CodexAppServer`

```js
export class CodexAppServer {
  constructor({ bin, args = [], log, requestTimeoutMs = 60000 })
  async start()        // spawn + initialize 握手；幂等；失败抛错且可再次 start 重试
  get started()
  isAlive()
  async request(method, params, timeoutMs?)  // JSON-RPC request，返回 result；失败抛错
  onNotification(handler)  // handler({ method, params })；返回 dispose
  onServerRequest(handler) // handler({ id, method, params }) => Promise<{result}|{error}>；返回值原样回写
  onExit(handler)          // handler({ code, signal })；返回 dispose
  async stop()             // SIGTERM → 2s → SIGKILL；清空 pending 请求（reject）
}
```

- stdio 传输是**换行分隔 JSON-RPC**（不是 Content-Length）；每行一个 JSON。
- 启动后第一条必须是 `initialize`（`clientInfo: { name: 'dsh-codex-mode', title: 'DSH Codex Mode', version: '0.1.0' }`）；收到响应后才算 ready；失败或 10s 未响应则抛错并杀进程。
- 请求 id 自增；响应与 notification 区分（有 `id` + `result|error` 为响应；有 `method` 无 `id` 为 notification；有 `method` + `id` 为 server→client request）。
- stderr 逐行以 `log.debug('[codex] ...')` 输出；进程退出时 reject 所有 pending、触发 onExit。
- 收到不认识的 server request：回 `{ error: { code: -32601, message: 'unsupported method' } }`，不要悬挂。

### 2.2 `CodexRuntime`

```js
export class CodexRuntime {
  constructor({ appServer, log, approvalHandler })
  // approvalHandler(req) => Promise<'accept'|'acceptForSession'|'decline'|'cancel'>
  //   req = { kind: 'command'|'fileChange'|'permissions', requestId, threadId, turnId, itemId, payload }
  async ensureStarted()                     // appServer.start() 幂等
  async threadStart({ cwd, developerInstructions, sandbox, approvalPolicy, model, effort }) -> { threadId }
  async threadResume({ threadId, cwd, sandbox, approvalPolicy, model, effort }) -> { threadId }
  async turnStart({ threadId, input, cwd, sandbox, approvalPolicy, model, effort }) -> { turnId }
  async turnInterrupt({ threadId, turnId }) -> void
  onEvent(handler) -> dispose
  isAlive()
  async stop()
}
```

- `input`：`[{ type:'text', text } | { type:'localImage', path }]`，与 app-server `UserInput` 对齐（对照 `appserver-ts/v2/UserInput.ts`）。
- `sandbox`：`'read-only'|'workspace-write'|'danger-full-access'`（与 `SandboxMode`/`SandboxPolicy` 对齐；注意 `turn/start` 用 `sandboxPolicy`，`thread/start` 用 `sandbox`，对照 schema）。
- `approvalPolicy`：映射 DSH `'ask'`→`'on-request'`、`'never'`→`'never'`（对照 `AskForApproval`）。
- `thread/resume` 参数以 app-server schema 为准；resume 失败向上抛错，由上层决定重建线程。
- runtime 维护 `threadId → { turnId, lastUsage }` 的内存表，供归一化。
- 审批 server request：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`；调用 approvalHandler 并把结果映射为对应 response 决策字段（accept/acceptForSession/decline/cancel）；handler 抛错则回 decline。

### 2.3 归一化事件（runtime.onEvent 的 payload）

```js
{ type:'turn_started', threadId, turnId }
{ type:'agent_message_delta', threadId, turnId, itemId, delta }
{ type:'reasoning_delta', threadId, turnId, itemId, delta, channel:'summary'|'text' }
{ type:'item_started', threadId, turnId, item }      // item = app-server ThreadItem（已 JSON 化的原始对象）
{ type:'item_completed', threadId, turnId, item }
{ type:'command_output_delta', threadId, turnId, itemId, delta }
{ type:'file_change_output_delta', threadId, turnId, itemId, delta }
{ type:'plan_updated', threadId, turnId, plan }
{ type:'token_usage_updated', threadId, usage }
{ type:'turn_completed', threadId, turnId, status, usage, raw } // status: 'completed'|'interrupted'|'failed'|其它
{ type:'error', threadId?, turnId?, message, code? }
{ type:'warning', message }
{ type:'raw', method, params }                       // 未识别通知
```

- 通知/请求的 method 名与 payload 以 `/tmp/dsh-codex-research/appserver-ts/v2/*Notification.ts` 为准（如 `item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/commandExecution/outputDelta`、`turn/completed`、`thread/tokenUsage/updated`、`error`）。
- 回调异常必须被 runtime 捕获并 `log.error`，不能打断 reader。

## 3. T-adapter：`src/adapter/adapter.js` + `src/bridge/tool.js`

### 3.1 适配器工厂

```js
export function createCodexAdapter({ runtime, mode, log, config, takeResult, fallbackStream })
// mode: {
//   isEnabled(sessionId): boolean
//   getThread(sessionId): string|undefined
//   setThread(sessionId, threadId): void        // 持久化由 mode controller 负责
//   getCwd(sessionId): string|undefined
//   getSandboxApproval(sessionId): { sandbox, approvalPolicy }
//   materializeInput(sessionId, userMessage): Promise<{ text, images: string[] }>
// }
// takeResult(callId, signal): Promise<{ kind, text, isError }>   // 由桥接工具调用
// fallbackStream(options): AsyncIterable<StreamChunk>            // 辅助调用改走 DSH 路由（见 §3.2）
```

返回对象需实现 LlmAdapter 契约（普通对象即可，不要 import LlmAdapter）：

```js
{
  providerInfo(provider) -> { id: provider, name: 'Codex (local)' },
  providerRetryPolicy() -> undefined,
  imageRequestPricing() -> undefined,
  imageRequestTarget(provider, model, image) -> { width, height, maxBytes },
  async listModels(provider) -> [{ provider, id: config.model, name: `Codex · ${config.model}` }],
  async resolveModel(provider, model) -> { provider, id: model, name: model, context: { contextWindow: 200000 },
                                           inputModalities: ['text','image'], toolUpdate: 'in-history' },
  async prepareCall(provider, model, signal) -> { model: resolvedInfo, stream: (options) => this.stream(options) },
  async *stream(options)                     // 核心
  dispose()
}
```

### 3.2 `stream(options)` 行为

- `options.purpose !== undefined`（`compaction` / `session-title`）→ **改走 DSH 路由**：若注入了 `fallbackStream`，`yield* fallbackStream(options)` 并 return（不要再抛错，否则 Codex 模式会话的标题/压缩会失败）；只有未注入 `fallbackStream` 时才抛错。
- 只处理 `options.sessionId` 命中的会话；`options.sessionId` 为空 → throw。
- **turn 识别**：从 `options.messages` 反向找最后一条 `role==='user' && source?.kind==='user'` 且带 `id` 的消息。
  - 若与 `state.consumedUserMessageId` 不同 → 开启新的 codex turn（见下）。
  - 否则视为同一 codex turn 的后续 step（通常由桥接工具结果触发），继续消费队列。
- **新 codex turn**：
  1. 确保线程：`mode.getThread(sessionId)` 有值 → `runtime.threadResume`；无值 → `runtime.threadStart({ cwd, developerInstructions: buildBootstrap(...), sandbox, approvalPolicy, model })`，成功（或 resume 失败重建）后 `mode.setThread(sessionId, threadId)`。**bootstrap 只在线程创建时注入一次**；resume 成功不注入。
  2. `materializeInput` 得到文本与图片路径；`runtime.turnStart({ threadId, input, cwd, sandbox, approvalPolicy, model })`。
  3. 记录 `consumedUserMessageId`、`activeTurn = { codexTurnId, turnDone: false }`。
- **消费循环**（从每会话事件队列取事件；队列由构造时注册的 `runtime.onEvent` 填充）：

| 事件 | 输出 |
|---|---|
| `agent_message_delta` | 确保 text block 打开（`block-start{index, blockType:'text'}`），`text-delta{index,text}` |
| `reasoning_delta` | 确保 reasoning block 打开，`reasoning-delta{index,text}` |
| `item_started`，`item.type ∈ {commandExecution, fileChange, mcpToolCall, webSearch}` | 关闭当前块；`callId = crypto.randomUUID()`；把 `{callId, itemId, kind, title, args}` 存入 `pending`（供 takeResult 等待）；发 tool-call block：`block-start{index,blockType:'tool-call'}` + 一个 `tool-call-delta{index,id:callId,name:'codex_activity',argumentsDelta:JSON.stringify(args)}` + 可选 `block-end`；然后 `yield {type:'finish', reason:{kind:'tool-calls'}}` 并 `return`（队列保留，事件继续在后台缓冲） |
| `item_completed`（item 已发过 tool-call） | 把 pending 标记完成（不产生 chunk） |
| `command_output_delta` / `file_change_output_delta` | 累积到对应 pending 数据（不产生 chunk） |
| `item_completed`（未发过 tool-call 的其它 item，如 plan/reasoning） | v1 忽略 |
| `plan_updated` / `token_usage_updated` / `warning` / `raw` | 忽略（记 log.debug） |
| `turn_completed` | 关闭当前块；若有 usage 则 `yield {type:'usage', usage}`；`yield {type:'finish', reason:{kind: status==='interrupted'?'aborted':'stop', ...}}`；清理 activeTurn；return |
| `error` | 关闭当前块；`yield finish {kind:'error', failure:{message, code}}`；清理；return |

- **abort**：监听 `options.signal`；触发时调用 `runtime.turnInterrupt`，关闭当前块，`yield {type:'finish', reason:{kind:'aborted', failure:{message:'cancelled', code:'ABORTED'}}}` 并 return；之后该 turn 的残留事件丢弃。
- **失败**：`ensureStarted`/`threadStart`/`turnStart` 抛错 → 让异常抛出（loop 会转成 terminal error chunk）。
- 每个 step 最多一个 finish，且 `usage` 必须在 `finish` 前。不要用 `max-tokens` finish 携带 tool-call。
- 块索引：每次 stream 调用内从 0 递增，独立计数；text 块最多一个同时打开，reasoning 与 text 可交替（关闭后再开新 index）。

### 3.3 `buildBootstrap({ messages, cwd, sandbox, limitChars })`

- 取 `messages` 中 `role` 为 `user`/`assistant` 且带 `id` 的消息，排除最后一条用户消息；按时间顺序把文本内容拼成 `<user>: ...` / `<assistant>: ...` 行；仅保留最近约 `limitChars`（默认 24000 字符）内的内容。
- 输出一段 `developerInstructions` 文本：说明“你由 DSH 的 Codex 模式接管该会话”、cwd、权限模式、历史摘录。无历史时仍返回一段简短环境说明。
- 工具函数放 `src/adapter/adapter.js` 内或 `src/adapter/bootstrap.js`（T-adapter 自选，保持自包含）。

### 3.4 桥接工具 `src/bridge/tool.js`

```js
export const BRIDGE_TOOL_NAME = 'codex_activity'
export function createBridgeTool({ takeResult, log })  // 返回 ToolDefinition 普通对象
```

- 手工定义（不要用 `defineTool` 也行；但参数/输出必须是合法 JSON Schema）：
  - `name: 'codex_activity'`
  - `description: 'Display a local Codex action (command execution / file change / tool call) in the conversation.'`
  - `parameters`: `{ type:'object', properties:{ callId:{type:'string'}, kind:{type:'string'}, title:{type:'string'} }, required:['callId','kind'], additionalProperties:false }`
  - `output`: `{ schema: { type:'object', properties:{ kind:{type:'string'}, text:{type:'string'}, isError:{type:'boolean'} }, required:['kind','text'], additionalProperties:false }, render: (args, value) => [{ type:'text', text: value.text }] }`
  - `async execute(args, exec)`：`const r = await takeResult(args.callId, exec.signal)`；返回 `{ kind: r.kind, text: r.text, isError: r.isError }`。
  - 不设置 `timeoutMs`（无截止）；不实现 `isConcurrencySafe`（串行）。
- `takeResult(callId, signal)` 由 adapter 导出（`adapter.takeResult(callId, signal)`），等待该 callId 的 pending 完成，返回 `{ kind, text, isError }`；abort 时 reject；pending 不存在时返回错误文本。

## 4. 状态与配置（Lead 实现，供参考）

- 模式状态：`Map<sessionId, { enabled, threadId?, previousRoute?, updatedAt }>`；持久化优先 `ctx.storageDomain`（domain `codex-mode`），不可用时写 `$DSH_HOME/codex-mode/state.json`（原子写）。
- 配置字段（row config，全部可选）：`codexBin`（默认 `/root/.npm-global/bin/codex`）、`providerName`（`codex`）、`model`（默认读 `~/.codex/config.toml` 的 `model`，读不到则 `gpt-6.2-sol`）、`cwd`、`bootstrapLimitChars`（24000）、`triggerPhrases`、`requestTimeoutMs`（60000）。

## 5. 测试

- **T-codex 冒烟**：`node scratch/codex/smoke.mjs` —— 真实 `codex app-server`：initialize → thread/start（cwd `/tmp/dsh-codex-smoke`）→ turn/start（`Reply with exactly: pong`）→ 打印归一化事件直到 turn_completed，断言出现 agent_message_delta。约 10–60s。
- **T-adapter 单测**：`node scratch/adapter/test.mjs` —— 用假 runtime 事件序列驱动 stream()，断言 chunk 序列（text → tool-call/finish → usage/finish stop、abort、error、辅助调用拒绝）。用本仓库 node_modules 里的 `@deepseek-ai/dsh-llm` BlockAssembler 校验块可组装。
- **T-test harness**：`node test/run-headless.mjs --prompt "..."` —— 设置隔离 `DSH_HOME`，用 `dev/overlay.yml`（`--patch`）把本仓库插件插入 `dsh --profile headless`，跑完从会话 JSONL 断言事件（`assistant/message`、`tool/call`、`tool/result`、`model/selection` 等）。插件未就绪时先用一个最小占位插件验证 `--patch` 加载链路。
- 所有测试输出目录放 `/tmp/dsh-codex-mode-*`，不要污染仓库。
