# dev/NOTES.md — headless E2E harness notes (owner: e2e-harness)

Living notes for `test/run-headless.mjs` / `test/scenarios.mjs` and the loader
overlay. Update the "M4 status" section when the plugin wiring lands.

Environment facts pinned for this work:

- dsh version: `0.2.1-rc.5` (`PATH=/root/.npm-global/bin:$PATH`)
- Node: `v24.22.2` (has built-in `node:zlib` Zstandard: `zstdDecompressSync`)
- Harness stack: `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`
- Profile: `/root/.dsh/profiles/headless` (bundles only; `cordis.patch.yml` = `[]`)
- This repo: `@local/dsh-codex-mode`, plugin entry `./index.js`

---

## M1 — loader chain: `--patch` overlay works (PASS, measured 2026-11-20)

### Delivered overlay

`dev/overlay.yml` (relative path, portability preferred):

```yaml
- insert:
    - id: codex-mode-test
      name: '../index.js'
```

`name: '../index.js'` is a **file specifier anchored beside the patch file**
(`/workspace/dsh_ifself/dev/overlay.yml` → `/workspace/dsh_ifself/index.js`), so
the overlay travels with the repo. `name: '/workspace/dsh_ifself/index.js'`
(absolute file path) also loads; both variants were actually run.

Command (isolated home, no profile files touched):

```bash
DSH_HOME=/tmp/dsh-codex-home \
PATH=/root/.npm-global/bin:$PATH \
timeout 120 dsh --profile headless --patch /workspace/dsh_ifself/dev/overlay.yml "say hi"
```

Observed: `stdout` contains `[codex-mode] plugin loaded` (the placeholder
plugin's probe line), exit code 1 only because no model credential was provided
(`MISSING_CREDENTIAL`, see M2). So **the load chain is proven from the log line,
independently of the model call**.

### What does NOT work (measured, for reference)

| `name` form | result |
|---|---|
| `'../index.js'` (relative file path) | ✅ loads, anchored beside the patch file |
| `'/workspace/dsh_ifself/index.js'` (absolute file path) | ✅ loads |
| `'@local/dsh-codex-mode'` (package specifier) | ❌ `failed to import: ERR_MODULE_NOT_FOUND ... Cannot find package '@local/dsh-codex-mode' imported from <DSH_HOME>/profiles/headless/` → `dsh: warning: 1 entry did not activate`, exit 1 |

Package specifiers resolve from the profile directory's `node_modules`, which is
empty here; the installed-bundle route is the Lead's `plugin_manager` job, not
the test overlay's.

### Inactive-entry behavior (probed)

A row whose plugin declares an unsatisfiable `inject` does **not** abort startup:

```
dsh: warning: 1 entry did not activate
inject-probe (file:///tmp/inject-probe.js): pending (waiting for service: nonexistentService)
```

and the run continues. The current placeholder `index.js` injects nothing, so it
loads. Keep the test overlay row id `codex-mode-test` distinct from the bundle row
id `codex-mode` (`cordis.patch.yml`) so a `--patch` run never double-mounts when
the bundle is also installed.

### stdout pollution — found, then fixed in `index.js`

The **first** placeholder `index.js` logged through a `ctx.get('logger')`
fallback to `console.info`, and the headless profile provides **no `logger`
service**, so `[codex-mode] plugin loaded` landed on **stdout** — the stream dsh
headless reserves for the final answer / `--json` NDJSON events. Reported to the
Lead; the current integration `index.js` (measured 16:18) wraps diagnostics in
`console.error` (stderr) and Web app-server protocol streams stay clean. The
harness still ignores non-JSON stdout lines defensively (and would surface them
as a `note:`), so a regression of this kind shows up in the run summary.

---

## M2 — normal model turn in the isolated home (PASS, measured 2026-11-20)

### Credential source (verified by reading the composed profile)

`dsh --profile headless --dump-config` shows the headless bundle patches the
credential/account rows **off**:

```yaml
- id: authorization     # @deepseek-ai/dsh-authorization
  disabled: true
- id: deepseek-account
  disabled: true
- id: credentials       # @deepseek-ai/dsh-credentials-local
  disabled: true
```

The model route row is `llm-deepseek` = `@deepseek-ai/dsh-llm-deepseek-api-key`
with default `apiKeyEnv: DEEPSEEK_API_KEY`. Its README states headless resolves
API keys from **the launch environment, then `<invocation cwd>/.env`, then
`$DSH_HOME/.env`** (the managed GUI store is ignored). Default model comes from
row `agent-default-model`: `deepseek-official / deepseek-flash`.

So an isolated home needs one of:

1. **export `DEEPSEEK_API_KEY` in the child environment** (what the harness does;
   never echoed), or
2. write `$DSH_HOME/.env` containing `DEEPSEEK_API_KEY=...` (also tested, works),
   or
3. symlink/copy the workspace's `.env`.

The workspace's managed store `/root/.dsh/.credentials.yaml` holds the working
key under top-level `refs:` (`refs.DEEPSEEK_API_KEY`, 35 chars, `sk-` prefix).
`test/run-headless.mjs` reads it (regex, no YAML dep) only when the parent
environment does not already provide `DEEPSEEK_API_KEY`, and passes it to the
child via env; `--no-credential-autofill` disables this. The key is never
printed. `JUCODEX_API_KEY` also exists there (51 chars) — likely for the Codex
CLI/provider, not needed for M2; do not assume it is the DSH model key.

### Result

```bash
DEEPSEEK_API_KEY=… DSH_HOME=/tmp/dsh-codex-home-m2 \
PATH=/root/.npm-global/bin:$PATH \
timeout 180 dsh --profile headless \
  --patch /workspace/dsh_ifself/dev/overlay.yml "Reply with exactly: pong"
```

→ exit code `0`, stdout (after the plugin probe line): `pong`.
stderr: `[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s)` plus the reasoning stream. Model used: `deepseek-official/deepseek-flash`.

### Session log layout + encoding (harness-critical)

```
$DSH_HOME/sessions/<workspace-slug>/session-<uuid>/
    session.lock
    session.v4.jsonl.zstd          # default: zstd-compressed JSONL, one JSON per line
```

- Current Session format version is **4**; filename is
  `session.v<format>.jsonl.zstd` (or `.jsonl` when persistence is configured with
  `compression: 'none'`). The task statement's `*.jsonl` glob matches only the
  second form, so the harness globs **`*.jsonl` and `*.jsonl.zstd`** and
  decompresses the latter with `zlib.zstdDecompressSync` (concatenated Zstd
  frames are handled by Node's API — verified).
- First line is a `session` header (`{type:'session',version,id,createdAt,cwd,...}`,
  **no `seq`**); every following line is an event with `seq`, `time`, `type`,
  `data` (some also `surfaceOp`).
- `$DSH_HOME/sessions/--workspace-dsh_ifself--/...` slug is derived from the cwd
  the run was started in; `--json` mode also prints the exact
  `{"type":"session","sessionId":...}` first (JSON) event — cheapest way to find
  the log. Do not hardcode the slug.
- A plain one-turn run wrote 21 records: `permission/preset`, `sandbox/mode`,
  `approval/policy`, `agent/inbox/spliced` ×2, `turn/start`, `step/start`,
  `system/message`, `user/message` ×2 (task + runtime-context snapshot),
  `request/header`, `request/context`, `session/title` ×2,
  `session/title-llm-request`, `session-log-deepseek/delivery-accepted` ×2,
  `assistant/message`, `step/end`, `turn/end`.

### Where the model route shows up (for scenario assertions)

There is **no `model/selection` event in a normal headless run** — that event is
appended by the *Session Controller* (`selectModel`), and `sessionController` is
not mounted in the headless profile (see inventory). Provider/model evidence in
session JSONL comes from:

- `request/header` → `data.header.config.provider` / `.model` (e.g.
  `deepseek-official` / `deepseek-flash`), and
- `assistant/message` → `data.message.source.provider` / `.model` (plus
  content blocks; reasoning + text in the sample), and
- `session/title` (`source.kind: 'provider'`, `source.model`) for the auxiliary
  title call.

Therefore S1 asserts **`request/header.data.header.config.provider === 'codex'`**
and **`assistant/message.data.message.source.provider === 'codex'`**; if the
plugin also writes a literal `model/selection` event itself, the harness matcher
supports that too (it is a known Session event type:
`dsh-session/lib/types/known-event-types.js`).

### `--json` event stream (used for correlation, not for rich assertions)

`dsh --profile headless --json <task>` prints NDJSON on stdout:
`session` → `status` (turn/step phases) → `thinking` → `text` → `tool_call` /
`tool_result` → `final`. It gives the run's `sessionId` and final text cheaply,
but it does **not** expose `request/header`, `model/selection`, or full
tool-result payloads — so scenario assertions read the session JSONL, while
`--json` is the correlation channel. Note the placeholder plugin's stdout probe
line is a non-JSON line *before* the stream; parse line-by-line and ignore
non-JSON lines.

### Multi-round / resume (needed by S2 + future codex scenarios)

Headless runs **one task per invocation** and has no `--resume`; the only
continuation flag is `--session-id <id>` (app flag, after launcher flags):

```bash
dsh --profile headless --patch <overlay> --json --session-id <id> "continue"
# long form: --session-id is the exact Session identity, unknown id = error
```

Verified: invocation 1 created `session-5ff…` with `turn/start turn=1`, printed
`pong`; invocation 2 with `--session-id session-5ff…` produced `turn/start
turn=2` in the **same** log and correctly answered `pong` from history. So a
multi-turn scenario is: run once, keep the home (`--keep-home`), then run again
with `--session-id`. The harness exposes this as `runPrompt({ sessionId })` and
scenarios as `steps: [{prompt}, {prompt, sessionIdFromPrevious: true}]`.

---

## M1-bis — headless service inventory (probed, not guessed)

Reproduce:

```bash
DEEPSEEK_API_KEY=… DSH_HOME=/tmp/dsh-codex-home-probe \
DSH_PROBE_OUT=/workspace/dsh_ifself/dev/headless-services.json \
PATH=/root/.npm-global/bin:$PATH \
dsh --profile headless --patch /workspace/dsh_ifself/dev/probe.overlay.yml "Reply with exactly: pong"
```

Artifacts: `dev/probe-plugin.js`, `dev/probe.overlay.yml`, machine-readable
snapshot `dev/headless-services.json` (two snapshots: `mount` and `steady`).

Steady-state headless composition provides **60 active services** (0 inactive):

```
agentDefaultModel, agentLoop, agents, appExit, appReady, approval, attachments,
cmdlineArgs, commands, compaction, configEditor, deepseekLlmApiExtensions,
dshHomePath, fs, goals, headlessStartup, jobs, launchEnvironment, llm, loader,
mcpResources, otel, permissionPresets, planMode, pluginManager, pluginPackages,
profileContext, ptcRuntime, remoteAccess, sandbox, sandboxPolicy,
sessionFeedback, sessionPersistence, sessionProjectionCache, sessionProjections,
sessionQuery, sessionTelemetry, sessionTitle, sessions, settings, shell,
shellEnv, skills, spillStore, storage, storage.backend.json, storageDomain,
subagents, subprocess, systemPrompt, timer, tokenMeter, toolResultPruner, tools,
typert, typertGateway, userQuestions, web, workflowEngine, workingDirectory
```

Present (service name → owner class, useful methods):

| service | class | notes for codex-mode |
|---|---|---|
| `llm` | `LlmRuntime` | `registerAdapter`, `listModels`, `commitRoutes`, `prepareCall`, `stream`, `adapterStream`, `resolveCallConfig` — provider registration path |
| `agents` | `AgentRegistry` | `create`, `resume`, `get`, `roots`, `list`, `register`, `withInitiator` — agent-scoped ctx access |
| `agentLoop` | `AgentLoop` | `create`, `createAgent`, `createStoredSession`, `resume`, `resumeWith`, `setupAndPublish` |
| `sessions` | `SessionStore` | `create`, `get`, `flush`, `fork`, `enter`, `registerMessageProjection` (service is plural; no `session`) |
| `tools` | `ToolRuntime` | `register`, `execute`, `dispatchToolBody`, `schemas`, `get`, `view` |
| `commands` | `CommandRuntime` | `register`, `execute`, `find`, `list` — `/codex` command channel |
| `systemPrompt` | `SystemPrompt` | `section`, `tools`, `variable`, `assemble` — trigger/pre-step prompt hooks |
| `storageDomain` | `DomainFacility` | `open`, `get`, `closeAll` — mode-state persistence |
| `storage` | `Storage` | `mount`, `form` (json backend active as `storage.backend.json`) |
| `sessionPersistence` | `JsonlSessionPersistence` | `create`, `open`, `appendLines`, `flush`, `list` — what writes the JSONL |
| `sessionQuery` | `SqliteSessionQueryEngine` | `readSession`, `listEvents`, `readTitle` (search disabled: `openAt: never`) |
| `attachments` | `LocalAttachmentStore` | `saveImage`, `saveFile`, `imageHostPath`, `fileHostPath` — S-attachment work |
| `approval` | `ApprovalService` | `request`, `decide`, `setPolicy` — approval bridge target (service name is `approval`) |
| `permissionPresets` | `PermissionPresetService` | `apply`, `current`, `permissionState`, `resolve` |
| `sandboxPolicy` / `sandbox` | `SandboxPolicyService` / `LocalSandboxProvider` | sandbox mode + enforcement |
| `fs` | `SandboxedFileSystem` | `resolve`, `readText`, `writeText`, `editText`, `listDir` |
| `shell` / `shellEnv` | `SandboxBashExecutor` / `ShellEnvRegistry` | bash tool backend |
| `jobs`, `subagents`, `workflowEngine`, `goals`, `skills`, `web`, `tokenMeter`, `compaction`, `planMode`, `userQuestions`, `settings`, `profileContext`, `loader` | — | all active |

**Absent** (important design consequences — don't code against these in headless):

| name | why |
|---|---|
| `sessionController` | web-control-plane row (`@deepseek-ai/dsh-api-session-controller`) is NOT in the headless bundle stack. No `selectModel`/modelCatalog service in headless. |
| `modelCatalog` | part of the session-controller HTTP/Host surface, absent |
| `logger` / `log` | no logger service in headless composition → `ctx.get('logger')` is `undefined` (see stdout-pollution warning in M1) |
| `credentials`, `authorization`, `deepseek-account` | deliberately disabled by `@deepseek-ai/dsh-headless` |
| `session` (singular), `agent` (singular), `permission`, `userApproval` | wrong names; real ones are `sessions`, `agents`, `permissionPresets`, `approval` |

Consequence for the Lead's controller: the web-path `ctx.sessionController.selectModel`
is unavailable in headless tests. Model routing must go through
`llm.registerAdapter` + agent-scoped model selection
(`dsh-agent`'s `installModelSelection` / agent-scoped `ctx` obtained from
`agents`/`agentLoop`), and mode state through `storageDomain` or the documented
file fallback. `commands.register`, `tools.register`, `systemPrompt.section`
and `agent/*` events tied to agent-scoped contexts are available.

`dev/headless-services.json` also carries prototype **method lists** for every
active service, so no d.ts reading is needed for the next service-level check.

---

## M3 — `test/run-headless.mjs` (delivered)

One-shot runner + reusable API; see the file header for the full option list.
Highlights:

```bash
node test/run-headless.mjs --prompt "Reply with exactly: pong" \
  --expect '{"exitCode":0,"lastAssistantContains":"pong"}'
```

- `--prompt <text>` (required unless `--stdin`), `--home <dir>` (default
  `/tmp/dsh-codex-home-test`; auto-created empty unless `--keep-home`),
  `--patch <path>` (repeatable; default `dev/overlay.yml`),
  `--expect <json>`, `--timeout <seconds>`, `--session-id <id>`,
  `--keep-home`, `--no-credential-autofill`, `--api-key <value>` (explicit,
  discouraged: visible in argv), `--quiet`, `--json-result`.
- The script prepares the home, spawns
  `dsh --profile headless --patch … --json <prompt>` with a sanitized env
  (`DSH_HOME` isolated, stale `DSH_PROFILE*`/`DSH_SESSION_ID` stripped,
  `PATH` augmented with `/root/.npm-global/bin`, `DEEPSEEK_API_KEY` inherited
  or auto-filled from `/root/.dsh/.credentials.yaml`), captures
  stdout/stderr/exit code, resolves the exact session JSONL (from the `--json`
  `session` event, falling back to newest-mtime scan), decompresses Zstd,
  parses every line, prints the event-type sequence + tool calls + assistant
  texts + final text, evaluates `--expect`, and exits non-zero on any failure.
- `--json` app mode is for correlation/`final`; assertions read **session
  JSONL** (`newEvents` = events with `seq > baseline`, so resume runs assert
  only the new turns).
- Programmatic use (what the Lead should call):
  `import { runPrompt } from './test/run-headless.mjs'` →
  `await runPrompt({ prompt, patches, expect, sessionId, home })` returns
  `{ ok, failures, exitCode, stdout, stderr, sessionId, sessionLogPath,
  events, newEvents, eventTypes, assistantTexts, toolCalls, finalText, ... }`.

### `--expect` rule vocabulary

```jsonc
{
  "exitCode": 0,
  "stdoutContains": "pong",
  "finalTextContains": "pong",
  "finalTextEquals": "pong",
  "lastAssistantContains": "pong",
  "assistantContains": "pong",
  "events": [
    { "type": "request/header", "minCount": 1,
      "where": { "data.header.config.provider": "codex" } },
    { "type": "assistant/message", "count": 1,
      "where": { "data.message.source.provider": "codex" } },
    { "type": "tool/call", "minCount": 1,
      "where": { "data.name": "codex_activity" } }
  ],
  "notEvents": [ { "type": "tool/call" } ],
  "orderedSubsequence": ["turn/start", "assistant/message", "turn/end"],
  "toolCalls": [ { "name": "codex_activity", "minCount": 1 } ],
  "assistantProviders": [ "codex" ],       // every assistant/message provider
  "noAssistantProvider": "codex",          // negative route assertion
  "requestProviders": [ "codex" ]
}
```

`where` dot-paths resolve through the raw session event (`data.*` included) and
support `{"$contains": "substring"}` for strings/arrays; every rule is optional
and unknown keys are rejected so typos fail loudly.

---

## M4 — codex acceptance scenarios (`test/scenarios.mjs`, WIRED & PASSING)

Final result (2026-11-20 ~16:40 local, plugin integration from Lead landed):

```
[scenarios] S1: PASS (13.3s)
[scenarios] S2: PASS (29.7s)
[scenarios] S3: PASS (26.0s)   # 3 headless invocations: 8.3s + 11.3s + 6.4s
[scenarios] S4: SKIP (0ms) — headless one-shot run has no stable stop channel
[scenarios] summary: 3 passed, 1 skipped, 0 failed (of 4)
```

Command / usage:

```bash
node test/scenarios.mjs                  # all scenarios (S1–S4)
node test/scenarios.mjs --only S1,S3     # subset
node test/scenarios.mjs --dry            # print plan, run nothing
node test/scenarios.mjs --json-result    # + machine-readable results
node test/scenarios.mjs --only S3 --timeout 300 --home-prefix /tmp/my-e2e
```

Each scenario runs against a **fresh isolated home per scenario**
`/tmp/dsh-codex-mode-scenarios/<id>/` (overridable with `--home-prefix`), mounts
the plugin through `dev/overlay.yml`, and after every step writes
`<home>/artifacts/step-N.stdout.txt`, `step-N.stderr.txt`,
`step-N.result.json`, plus `summary.json` — a failing CI run is diagnosable from
those files alone. `S4` is `skipped: true` in the scenario table and reported as
SKIP.

| id | what it proves | assertions / observed evidence | result |
|---|---|---|---|
| S1 | 触发词+内容: `使用codex模式：Reply with exactly: pong` | `command/run`+`command/done` receipt (trigger activates mode, trigger word not sent to codex), `request/header.config.provider=codex`, `assistant/message.source.provider=codex`, last assistant text `pong`, exit 0 | **PASS 13.3s** |
| S2 | 工具卡片: `使用codex模式：Execute the shell command printf codex-tool-ok > /tmp/dsh-codex-tool-ok.txt and then reply done` | `tool/call` name=`codex_activity` (args carry kind=`command`, title=`/bin/bash -lc 'printf …'`), `tool/result` `[exit code: 0]`, file `/tmp/dsh-codex-tool-ok.txt` == `codex-tool-ok`, assistant text contains `done`, **no** `bash` tool/call (codex executed it itself) | **PASS 29.7s** |
| S3 | 续接/隔离: step 1 trigger; step 2 same Session via `--session-id`, plain prompt, no trigger → still codex; step 3 new Session (no `--session-id`) → default DSH model | step 2 `request/header` reason=`resume`, provider=codex, assistant `pong2`, and no `/codex` `command/run` receipt; step 3 provider=`deepseek-official`, no `codex_activity`; step-2 sessionId == step-1 sessionId, step-3 sessionId different | **PASS 26.0s** |
| S4 | 失败/停止（design §7 #10） | requires mid-turn interruption / adapter fault injection; headless one-shot has no interactive stop channel. Kept as SKIP placeholder for the acceptance matrix | **SKIP** |

Multi-turn mechanics in the runner:

- a step with `sessionIdFromPrevious: true` (default for steps after the first)
  reuses the previous `result.sessionId` and `keepHome: true`;
- `sessionIdFromPrevious: false` starts a **fresh** Session in the same isolated
  home (`--session-id` omitted) — this is how S3 step 3 proves isolation;
- assertions run on `newEvents` (seq greater than the pre-run baseline), so a
  resumed run only asserts the turns it added.

Timeout guidance: `--timeout ≥ 240` (the CLI default used by scenarios is 240s).
Measured normal costs: codex app-server cold start + thread start ≈ 2–5s, one
codex turn ≈ 5–13s, thread resume ≈ 5–24s, S2 tool-card turn ≈ 30s.

### Integration observations made while wiring M4 (for the record)

- `request/header` is logged with `provider=codex`; the model route switch happens
  even though `sessionController` is absent in headless (the plugin routes via
  the `agent/request` waterfall / agent-scoped selection instead of
  `sessionController.selectModel` — the web-only service, correctly skipped with
  a debug log).
- A mid-integration build once failed with
  `dsh: UNKNOWN: session event "request/header" carries non-JSON-serializable data`;
  the current controller deletes explicit `undefined` `reasoningEffort` before
  returning the rewritten config (session events are losslessly JSON-snapshotted,
  so an explicit `undefined` fails the append). Current builds log the header
  fine — keep that `delete` when editing routing.
- The sandbox/approval interface briefly mismatched (`{sandbox, approval}` from
  the controller vs `approvalPolicy` in the adapter contract) and codex fell back
  to `read-only/never`; the adapter now accepts both keys
  (`fromMode?.approvalPolicy ?? fromMode?.approval`) and the fallback warning is
  gone from current runs.
- Cosmetic only: controller log lines already carry a `[codex-mode]` prefix and
  `index.js`'s log wrapper adds another → `[codex-mode] [codex-mode] …` on stderr.

## Known limitations / gotchas

1. **One task per process.** Continue with `--session-id`; there is no
   `--resume` flag and no interactive follow-up.
2. **Zstd by default.** Session JSONL is `session.v4.jsonl.zstd`; plain `.jsonl`
   only if persistence is configured with `compression: 'none'`. Add a row
   override in an overlay if a plain file is ever needed.
3. **The session-slug directory is cwd-derived**, so always locate logs by
   session id / mtime, never by a fixed path.
4. **stdout hygiene (regression watch)**: headless has no `logger` service, so a
   plugin logging fallback that uses `console.info`/`console.log` pollutes the
   stdout answer / `--json` stream. Current `index.js` logs to stderr; the
   harness tolerates non-JSON stdout lines and reports them as a note.
5. **Credentials never touch the profile**: isolated `DSH_HOME` + env var (or
   `$DSH_HOME/.env`). The real `/root/.dsh` is never written by these tests;
   runs use only `/tmp/dsh-codex-*` homes.
6. **Telemetry**: headless still mounts `session-telemetry-otel` in
   `FEEDBACK_ONLY` mode; no user feedback is emitted by scripted runs (no network
   side effects observed; stderr stays clean apart from model listing/reasoning).
7. Probe snapshots at `mount` time are incomplete by design (only the first 8
   boot services are up); use the `steady` snapshot (2 s after mount).
8. **Transient codex resume hang observed once**: during one S3 run, step 2
   (thread resume) stalled >240 s with only `item_started type userMessage` on
   the codex side, while several other agents were running codex tests
   concurrently; the same scenario passed on retry (11–24 s resume). Treat the
   codex E2E suite as serialized workload: run one scenario process at a time,
   and retry a hung scenario once before filing it as a failure. The harness
   keeps full stderr per step precisely for this diagnosis.
9. **Codex auth/model config lives outside DSH**: codex reads
   `/root/.codex/config.toml`; logs show an ignored `disable_response_storage`
   setting and a skills-scan traversal-limit ERROR on every codex start. Neither
   affects the tested behavior, but they add stderr noise.
