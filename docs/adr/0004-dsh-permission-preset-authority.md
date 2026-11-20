# 权限以 DSH 会话权限预设为准

每次 `turn/start` 都把 DSH 会话当前权限预设映射为本轮 codex 的 `sandboxPolicy` / `approvalPolicy`（两套词汇一致：read-only / workspace-write / danger-full-access；审批 ask 映射为需要审批的策略）。codex 发来的审批 server-request 转成 DSH 原生审批卡片并回写决定；`~/.codex/config.toml` 里的 `approval_policy` / `sandbox_mode` 不作为权威。

用户在 DSH 界面里切换权限必须真实生效，否则同一个会话会出现两套安全语义。codex 的 `turn/start` 支持逐轮覆盖，因此这一映射可以无损实现。

## Consequences

- codex 自身配置中的审批/沙箱只在插件未覆盖的场合（如插件外使用 codex）生效。
- 权限映射表是维护点；DSH 新增预设时需要同步。
- 若 DSH 侧审批超时或被取消，codex 侧应收到 `decline` / `cancel` 决定，避免悬挂的 codex 轮。
