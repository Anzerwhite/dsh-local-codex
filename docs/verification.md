# 验收记录（2026-11-20）

环境：DSH `0.2.1-rc.5`（web profile 运行于 `http://127.0.0.1:3080`，headless profile 用于自动化），Node `v24.22.2`，codex-cli `0.170.0`（`/root/.npm-global/bin/codex`，自定义 provider，无需 login）。插件（开发期）以 `link:/workspace/dsh_ifself/dsh-local-codex` 安装进 web profile；此后 web profile 改为依赖 v0.1.0 GitHub Release tarball。

## 自动化

| 套件 | 命令 | 结果 |
|---|---|---|
| codex 传输/runtime 冒烟 | `node scratch/codex/smoke.mjs` | PASS：真实 codex，`initialize → thread/start → turn/start → agent_message_delta("pong") → turn_completed`，4.7s |
| 中断 | `node scratch/codex/interrupt.mjs` | PASS：命令执行中 `turn/interrupt` → `turn_completed(status=interrupted)` |
| 跨进程 resume | `node scratch/codex/resume.mjs` | PASS：新进程 `thread/resume` 同一线程，上下文保留（resume 调用约 13.5s） |
| runtime 单测 | `node scratch/codex/runtime-unit.mjs` | 38/38 PASS（参数映射、审批 3 类、未知 server request、异常隔离） |
| 传输 fake-child | `node scratch/codex/transport-fake.mjs` | 16/16 PASS（握手、并发 id、超时、崩溃/杀进程升级） |
| adapter 单测 | `node scratch/adapter/test.mjs` | 12/12 PASS（含 BlockAssembler 块序列、tool-call、abort、error、fallbackStream 透传、桥接工具 schema） |
| adapter+runtime 集成 | `node scratch/adapter/integration-runtime.mjs` | PASS（fake app-server 原生通知 → runtime 归一化 → adapter chunks/takeResult） |
| 桥接竞态回归 | `node scratch/lead/bridge-race-test.mjs` | PASS（item 在流消费前完成时仍拿到真实输出，不再 `did not complete`） |
| mode controller 单测 | `node scratch/lead/controller-test.mjs` | PASS（触发词、命令、模型切换/恢复、桥接工具生命周期、持久化） |
| headless E2E 场景 | `node test/scenarios.mjs --timeout 300` | **S1/S2/S3 PASS，S4 SKIP，0 fail** |

headless E2E 覆盖：

- **S1（13s）**：`使用codex模式：Reply with exactly: pong` → 触发词激活（`command/run`+`command/done` 回执，触发词不进模型历史）→ `request/header.config.provider=codex` → `assistant/message.source.provider=codex`，文本 `pong`。
- **S2（29s）**：`使用codex模式：Execute the shell command printf codex-tool-ok > /tmp/dsh-codex-tool-ok.txt and then reply done` → 正文流式 → `tool/call name=codex_activity` → `tool/result`（含 `[exit code: 0]`）→ 同 turn 第二 step 回复 `done`；副作用文件由 Codex 真实执行；无 DSH `bash` 工具调用。
- **S3（41s，3 次 headless 调用）**：第二轮用 `--session-id` 续接且**不带触发词**仍走 codex（`request/header` provider=codex，无新 `/codex` command）；新会话回到 `deepseek-official`、无 `codex_activity`。
- **S4 SKIP**：headless 单发无交互式停止通道，停止/故障注入留给单测与真实 GUI。

## Web GUI 手动验收（用户确认）

1. 模型选择器默认 DeepSeek；发触发词后出现“Codex 模式已开启”回执卡片，模型变为 `codex/gpt-6.2-sol`。✅
2. 普通聊天由 Codex 回复，正文流式；回复来自 codex provider（会话日志 `request/header` / `assistant/message` 交叉验证）。✅
3. 让 Codex 执行命令 → 出现可折叠工具卡片，展开显示真实命令输出与退出码；命令副作用文件生成（根因修复后确认）。✅
4. `/codex status` 显示模式、模型、思考强度、线程 ID；`/codex off` 恢复进入前的 DSH 模型（`deepseek-account/deepseek-flash/max`）。✅
5. 新开会话默认不进入 Codex 模式。✅
6. 思考强度：Codex 模型暴露 `minimal/low/medium/high/xhigh`，可在模型菜单切换；切换后会话 `model/selection` 记录档位，`/codex status` 反映实际选中档位。✅
7. 插件安装与热加载：`plugin_manager install_bundle` → `application: applied`，web 日志 `ready: provider=codex model=gpt-6.2-sol state=storageDomain`；代码更新后关闭/开启 bundle 可加载新模块。✅

## 线程占用（writer lock）释放

- 现象：使用 Codex 模式对话后，若只在 DSH 里 `/codex off`，原生 Codex 打开同一会话仍提示锁定（app-server 保持线程 loaded 并持有 `~/.codex/thread-writer-locks/<threadId>.lock`）。
- 修复：app-server 以 `-c thread_unload_delay_secs=0` 启动；`/codex off`（以及 agent 销毁、插件卸载）调用 `thread/unsubscribe`。threadId 保留，重新开启可 resume。
- 探针实测（`scratch/lead/thread-release-probe2.mjs`）：thread 加载后 `flock -n` 失败（LOCKED）；`thread/unsubscribe` 返回 `{"status":"unsubscribed"}`；+300ms 后 `thread/loaded/list` 为空、lock 文件删除、`flock -n` 成功（free）。
- 线上实测（web 日志）：`/codex off` 后出现 `released codex thread 01a1f849-… (session …)`；用户确认修复后原生 Codex 可正常打开该会话。
- 模式开启期间线程由 DSH 持有，原生 Codex 打不开属预期；先 `/codex off` 即可释放。注意原生 Codex 自己的后台 daemon 也会持有它打开的线程锁，与本插件无关。

## 上下文窗口修复（2026-11-27）

- 现象：Codex 模型真实窗口 475k，但适配器固定声明 200k，DSH 会话上下文用量（如 426k）超过 UI 声明窗口。
- 修复：适配器从 `thread/tokenUsage/updated.tokenUsage.modelContextWindow` 学习真实窗口并更新 `request/context`；新增 `contextWindow` 配置覆盖与 Codex `model_context_window` 回退。
- 验证：adapter 单测新增场景（配置覆盖 + 动态学习 + 非法值防御）；真实 Codex 集成脚本 `scratch/lead/ctx-window-real-test.mjs`：首轮前 200000 → 首轮后 **475000 PASS**。

## 未覆盖 / 需注意

- 真实审批往返（`approval_policy=on-request`）未端到端验证；默认配置不会触发。
- 附件（图片 `localImage`、文件落盘）未做真实 GUI 验证。
- Codex 的 reasoning 摘要文本在本机 provider 下不可见（只返回 token 计数），因此“思考正文”不显示；思考强度档位正常。
- `thread/resume` 首次耗时 5–30s（hooks/skills），无进度提示。
- 与 `ds-harness-remote` Codex 域共存需注意双 app-server 竞争。
- headless S3 期间与其它 agent 并发跑 codex 曾出现一次 >240s 卡顿，串行重跑通过；E2E 建议串行执行。
