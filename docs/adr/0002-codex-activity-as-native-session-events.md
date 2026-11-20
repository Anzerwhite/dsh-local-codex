# Codex 活动以原生 DSH 会话事件呈现

Codex 的正文与推理通过标准 stream chunk（`text-delta` / `reasoning-delta`）流回 agent-loop，最终成为真实的 `assistant/message`；命令执行、文件改动等工具活动则通过“桥接工具调用”：adapter 在流里发出指向插件注册的展示工具的 `tool-call`，loop 照常派发并落盘 `tool/call` + `tool/result`，现有 Chat UI 将其渲染为可折叠工具卡片。

第三方插件不能追加可持久化的自定义会话事件：`session.append()` 无法设置 `ignorable: true`，未知事件类型在会话恢复时会被整体拒绝；独立的 Codex 视图又无法满足“并入同一对话流”的要求。桥接工具让展示走通原生事件与原生渲染通路，且不污染恢复语义。

## Consequences

- 会话日志中会出现一个仅供展示的工具名（及其 `tool/call` / `tool/result`），请求头也会记录其 schema；Codex 模式关闭时必须注销该工具。
- 工具卡片沿用 DSH 通用样式；终端/diff 定制卡片留待后续（保留 codex 原始 item 数据以便升级）。
- 一个用户轮内可产生多个 step（正文段 → 工具卡片 → 正文段），顺序即 codex 事件发生顺序。

## 已验证

源码审查与探针验证确认：adapter 可发 `tool-call` chunk；loop 会派发并落盘 `tool/call` + `tool/result`；agent 作用域注册可被请求头自动拾取；一用户轮内 step 数无上限，需自行加动作预算。可选增强：桥接工具借用 `bash`/`write` 线名可零客户端代码复用 DSH 原生终端/diff 卡片，但需处理工具遮蔽与 spill 降级，不在 v1 范围。
