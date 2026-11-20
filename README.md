# dsh-local-codex

> npm 包名：`dsh-local-codex` · 插件行 id：`codex-mode` · 仓库工作名：dsh-codex-mode
>
> 把 DeepSeek Harness 的**单个会话**交给本机 Codex 代理：你在 DSH 里正常聊天，Codex 自己推理、执行命令、改动文件，而它的回复（流式）、命令执行与文件改动会同步显示在同一个对话流里（工具活动渲染为 DSH 原生的可折叠工具卡片）。

模式只对**指定会话**生效，新会话自动关闭；DSH 重启后重新打开同一会话会续接同一个 Codex 线程。

- 设计文档：[docs/design.md](./docs/design.md)
- 领域词表：[CONTEXT.md](./CONTEXT.md)
- 架构决策：[docs/adr/](./docs/adr/)
- 实现契约与并行开发说明：[docs/impl-contract.md](./docs/impl-contract.md)
- 验收记录：[docs/verification.md](./docs/verification.md)

## 当前状态

已在 **本机** DSH Web profile（`dsh` 0.2.1-rc.5，`http://127.0.0.1:3080`）安装并运行：profile 以 `link:/workspace/dsh_ifself` 依赖本仓库，bundle 行 `codex-mode` 由 [cordis.patch.yml](./cordis.patch.yml) 插入。

Headless 端到端场景 **S1/S2/S3 全部通过**（触发词接管、工具卡片真实结果、续接/新会话隔离），Web GUI 手动验收通过（含思考强度切换）。

## 使用

1. 新建或打开一个会话（默认仍是 DeepSeek 模型）。
2. 在消息里说一句触发词，或使用斜杠命令：

   使用codex模式                     只开启模式
   使用codex模式：帮我修复这个测试     开启，并把“帮我修复这个测试”作为第一轮发给 Codex
   /codex on | off | status           开启 / 关闭 / 查看状态
   退出codex模式                      关闭模式（恢复原 DSH 模型）

   同时也接受 `开启codex模式`、`进入codex模式`、`切换到codex模式`、`use codex mode`、`enable codex mode`、`enter codex mode`、`codex mode on`；关闭词：`退出/关闭/结束codex模式`、`exit/disable codex mode`、`codex mode off`。
3. 开启后该会话的模型变为 `codex/gpt-6.2-sol`（模型参数沿用 `~/.codex/config.toml`），此后每条消息都交给本机 Codex；它的命令/文件动作以工具卡片出现。
4. 思考强度（thinking effort）：Codex 模型会声明可用档位 `minimal / low / medium / high / xhigh`（默认取 `~/.codex/config.toml` 的 `model_reasoning_effort`），在模型菜单里可切换，每轮都会传给 Codex；DSH 的 `max` 档映射为 `xhigh`。`/codex status` 会显示当前实际档位。
5. 关闭模式后模型恢复成进入前的 DSH 路由。退出时会对 Codex 执行 `thread/unsubscribe`，配合 app-server 的 `thread_unload_delay_secs=0`，**释放该线程的 writer 占用**，让原生 Codex TUI 可以立即打开这个会话；Codex 线程 ID 保留，下次开启继续同一线程（不重复注入前情提要）。
   - 模式开启期间该线程由 DSH 持有，原生 Codex 打开它仍会显示占用——这是预期行为；先 `/codex off` 再开即可。
6. 新会话与 fork 出来的会话默认关闭。模式状态是 per-session 的（存 `storageDomain`），没有全局开关。

## 工作原理（一图流）

```text
DSH Web UI（现有 Chat，无改动）
   │ 标准会话事件 / 标准 API
DSH agent-loop（现有：pre-step → agent/request 路由 → llm.stream → 派发工具 → 落盘）
   │ StreamChunk / GenerateOptions
dsh-codex-mode Host 插件
   ├─ mode controller：触发词/命令、模式持久化、模型选择切换、权限映射、附件物化
   ├─ codex adapter：一个 DSH 会话 ↔ 一个 Codex thread；正文/推理流式 chunk；命令/文件 → 合成 tool-call
   └─ bridge tool（codex_activity）：把 Codex 动作落成真实 tool/call+tool/result，复用原生工具卡片
   │ stdio JSON-RPC
codex app-server（单子进程，多线程复用）
```

关键决策见 ADR：用 LLM provider adapter 承载 Codex（0001）、Codex 活动走原生会话事件（0002）、`codex app-server` 传输（0003）、权限以 DSH 会话预设为准（0004）、按会话持久化并续接线程（0005）。

## 安装 / 更新

前置：

- DeepSeek Harness 0.2.1-rc.x（Web profile）。
- 本机 Codex CLI 0.170.x（默认 `/root/.npm-global/bin/codex`，可用配置 `codexBin` 覆盖）；认证沿用 `~/.codex/config.toml`。
- profile 环境能执行 `pnpm`（Plugin Manager 安装依赖时使用）。

安装（发布到 npm 之后；本机开发期用本地目录）：

```sh
dsh plugin --profile web add dsh-local-codex
# 本地开发目录：
dsh plugin --profile web add -w /workspace/dsh_ifself
# 或通过 plugin_manager 工具 install_bundle，target=/workspace/dsh_ifself
```

**修改本插件代码后的加载**：在 DSH 的 Plugin Manager（或 plugin_manager 工具）里把本 bundle 关闭再开启，即可加载最新模块；配置文件/行外配置的变更走 profile reload。若修改后行为未变化，再关闭/开启一次。

## 配置

可在 `cordis.patch.yml` 的插入行写 `config`（DSH 会把未声明 `Config` schema 的插件行配置原样传入）：

```yaml
- insert:
    - id: codex-mode
      name: '@local/dsh-codex-mode'
      config:
        model: gpt-6.2-sol
        reasoningEffort: xhigh
```

| 键 | 默认 | 说明 |
|---|---|---|
| `codexBin` | `/root/.npm-global/bin/codex` | Codex 可执行文件 |
| `providerName` | `codex` | 注册的 LLM provider 路由名 |
| `model` | 读 `~/.codex/config.toml` 的 `model` | 暴露给模型选择器的模型 id |
| `cwd` | 会话工作目录 | 覆盖 Codex 线程工作目录（一般不需要） |
| `requestTimeoutMs` | `60000` | app-server 单请求超时 |
| `bootstrapLimitChars` | `24000` | 开启时注入的“前情提要”字符预算 |
| `reasoningEffort` | 读 Codex 配置 `model_reasoning_effort` | 默认思考强度 |
| `reasoningSummary` | 读 Codex 配置 | 逐轮 `turn/start.summary` 覆盖（`auto/concise/detailed/none`） |
| `codexEfforts` | 内置 5 档 | 暴露给 DSH 的思考档位列表 |
| `maxBridgeCallsPerTurn` | `200` | 单用户轮内桥接动作预算（防无限循环） |
| `defaultSandbox` / `defaultApproval` | `danger-full-access` / `never` | 读不到 DSH 权限预设时的回退 |
| `attachmentsDir` | 系统临时目录 | 附件物化目录 |

## 插件市场

- 市场包名：`dsh-local-codex`；发布与收录步骤见 [publish/PUBLISHING.md](./publish/PUBLISHING.md)。
- 目标目录是社区目录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（dshmarket 与宿主 Discover 读取的同一份清单），收录需要 npm/GitHub 凭据与仓库创建满 1 天。
- 未上架前可先用 `dsh plugin --profile web add -w /workspace/dsh_ifself`（本机当前即此方式）或安装 `dist/dsh-local-codex-0.1.0.tgz`。

## 已知限制

- `codex app-server` 在 Codex 中是 experimental；本项目以 **codex-cli 0.170.0** 为兼容基线，升级 Codex 后可能需要对协议做回归。
- 线程续接（`thread/resume`）在真实 profile 下可能需要 **5–30 秒**（Codex hooks/skills 加载），首轮或重启后第一句会等得久一点；v1 没有“准备中”进度提示。
- Codex 的“思考过程文本”是否显示取决于模型服务商；当前本机 provider 只返回 reasoning token 数、不返回摘要文本，因此对话里能看到**思考强度档位**但看不到 thinking 正文。
- 附件（图片转 `localImage`、文件落盘+路径告知）已实现但未做大规模真实场景验证。
- 真实审批往返（`approval_policy=on-request`）未做端到端验证；在默认 `danger-full-access/never` 下 Codex 不会发起审批。
- 与 `ds-harness-remote` 的 Codex 域同时启用时，两者会各自拉起 `codex app-server`；建议只保留一个，避免线程写锁/资源竞争。
- 工具卡片是 DSH 通用样式（无终端/diff 定制外观）；历史卡片在插件卸载后仍可显示。
- 本插件以本仓库路径 `link:` 安装；移动或删除本仓库会让 profile 中的插件失效。
