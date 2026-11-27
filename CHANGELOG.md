# Changelog

## 0.1.1 — 2026-11-27

- Fix context window advertisement: the adapter no longer hard-codes 200k for every Codex model. It now reads Codex's reported `modelContextWindow` from `thread/tokenUsage/updated` and updates the DSH route's advertised window (so the context meter and compaction thresholds match large-window Codex providers), with a new `contextWindow` config override and `model_context_window` fallback from `~/.codex/config.toml`.

## 0.1.0 — 2026-11-20

Initial release.

- Per-session Codex mode: trigger words or `/codex on|off|status` hand one DSH session to the local Codex CLI.
- Local Codex through `codex app-server`, using `~/.codex/config.toml` (including custom providers).
- Streamed assistant text inline; commands, file changes, MCP calls and web searches rendered as native DSH tool cards via a display-only bridge tool.
- Thinking-effort tiers exposed to DSH and forwarded per Codex turn.
- Mode and Codex thread id persisted per session (resumed after a DSH restart; new sessions and forks default off).
- DSH session permission presets mapped onto Codex sandbox/approval; Codex approval requests bridged to DSH approval cards.
- Stop interrupts the active Codex turn; failures surface an error and rebuild the app-server.
- `/codex off` releases the Codex thread lease (`thread/unsubscribe` + `thread.unload`-on-idle configuration), so native Codex can reopen the session.
- Images forwarded as `localImage`, files materialized to disk with their path passed to Codex.
- Host-only plugin: no custom client bundle, no DSH core changes.
