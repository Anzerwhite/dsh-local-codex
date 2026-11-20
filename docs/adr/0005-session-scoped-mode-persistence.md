# Codex 模式按会话持久化并续接 Codex 线程

模式状态（是否启用、codex threadId、进入前该会话的 DSH 模型路由）存进 host 侧 storageDomain，以 sessionId 为键；DSH 重启后重新打开同一会话时恢复模式并对原 codex 线程执行 `thread/resume`。新建会话与 fork 出来的会话默认关闭。

“仅在指定会话生效、新会话自动失效”意味着模式属于会话状态而不是全局设置；持久化 sessionId→状态才能同时满足“重启后仍是那个会话”和“新会话默认关”。fork 得到新 sessionId，因此天然不继承模式，这与“新会话失效”的要求一致。

## Consequences

- 需要处理 codex 线程已不存在（codex 侧清理/迁移）的情况：用初始化上下文重建线程并提示。
- 退出模式时保留 threadId 以便再次开启时续接，但模式本身关闭；再次开启不重复注入初始化上下文。
- storageDomain 记录是版本化 schema，字段演进需兼容旧记录。
