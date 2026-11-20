# DSH Codex 模式

一个 DeepSeek Harness 插件上下文：让单个 DSH 会话改用本机 Codex 作为对话代理，并把 codex 的对话过程同步显示在 DSH Web UI 中。

## Language

**Codex 模式 (Codex Mode)**：
一个会话级的运行状态——该会话的对话代理是本机 Codex，DSH 只负责同步展示与输入转发。
_Avoid_: codex 插件模式、codex 会话

**指定会话 (Target Session)**：
用户显式打开 Codex 模式的那个 DSH 会话；Codex 模式只对它生效。
_Avoid_: 当前会话、活动会话

**本机 Codex (Local Codex)**：
运行在这台机器上、沿用本机 `~/.codex/config.toml` 与认证的 Codex 代理进程（含其自带的模型、工具与审批策略）。
_Avoid_: codex 客户端、codex 服务

**Codex 线程 (Codex Thread)**：
本机 Codex 内部维护的一段连续对话，有自己的 thread id 与上下文；Codex 模式下与指定会话一一绑定。
_Avoid_: codex 会话、codex 历史

**同步 (Sync)**：
把 Codex 线程中发生的对话与工具活动按发生顺序呈现为指定会话里可见的对话内容。
_Avoid_: 镜像、复制对话

**初始化上下文 (Bootstrap Context)**：
开启 Codex 模式时一次性写入 Codex 线程的“前情提要”，取自指定会话开启前的历史。
_Avoid_: 迁移历史、导入对话

**思考强度 (Thinking Effort)**：
DSH 会话级的推理强度选择；Codex 模式下映射为 Codex 的 reasoning effort（DSH 的 `max` 映射为 `xhigh`），并逐轮传给 Codex。
_Avoid_: 思考等级、reasoning 档位

**触发词 (Trigger Phrase)**：
出现在消息句首、用于开启或关闭 Codex 模式的固定短语；它本身不进入模型历史。
_Avoid_: 暗号、魔法命令
