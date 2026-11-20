# 用 LLM provider adapter 承载 Codex

DSH 会话由 agent-loop 驱动，第三方插件无法替换每个会话的 agent driver（`setFactory` 是单一全局槽，已被 dsh-agent-loop 占用），也无法持久化自定义会话事件。因此插件注册一个 LLM provider adapter（provider 路由如 `codex`），Codex 模式下通过 `agent/request` 把该会话的 provider/model 路由到它；adapter 内部驱动本机 codex app-server。

这是唯一无需修改 DSH 内核、又能让 DSH 记录真实 `assistant/message`、复用现有聊天 UI、fork、resume 与 Stop 的路径。

## Considered Options

- 自定义 Agent / driver：不支持，单工厂槽位无法按会话替换。
- `agent/pre-step` 接管并手工伪造事件：可检测与控制，但丢失流式、绕过 turn 结算、用户消息可能不落日志。
- 独立 Codex 视图 + 自有传输：无法满足“并入同一对话流”，且需要全套自定义客户端。

## Consequences

- adapter 每次请求收到完整的 DSH 派生历史与 `purpose` 标记；必须拒绝 `compaction` / `session-title` 辅助调用，否则辅助任务会打到 codex。
- 该会话的 DSH 原生工具不再被模型调用（codex 自带工具），但仍会随请求头出现；adapter 忽略即可。
