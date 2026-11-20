# 用 codex app-server 作为本地 Codex 传输

通过 stdio 换行分隔 JSON-RPC 驱动 `codex app-server`：`initialize` → `thread/start` 或 `thread/resume` → `turn/start` → 消费 `item/*` 通知流；中断用 `turn/interrupt`，审批用 server-request 回执。

`codex exec --json` 没有 token 与命令输出增量、每轮一个进程、无中断与审批协议，只能当审计日志；Codex 0.170 没有内建 ACP 或 MCP server 模式。app-server 是当前唯一能支撑实时对话 UI、线程续接与审批的模式。代价是它被标记为 experimental：以 codex-cli 0.170.0 为兼容基线并固定版本，未知方法与未知 item 必须容忍。

## Consequences

- 升级 codex 需要跑协议回归；初始化失败、协议不匹配或进程崩溃都要显示错误卡片并自动重建连接。
- 同一插件进程只维护一个 app-server 子进程，多会话以 threadId 复用；与其它同样会拉起 app-server 的插件（如 ds-harness-remote 的 Codex 域）并存时需注意进程与线程写锁。
