#!/usr/bin/env node
// test/scenarios.mjs — codex-mode acceptance scenarios (skeleton, ready for wiring).
//
// Each scenario is declarative: one or more `steps` (a step = one headless
// invocation), per-step `expect` rules (see test/run-headless.mjs), an optional
// `setup`/`checks`/`teardown`, and tags. Multi-turn scenarios reuse the Session
// id from the previous step (`sessionIdFromPrevious`), which is how a headless
// one-task-per-process CLI continues a conversation: `--session-id <id>`.
//
// Run:
//   node test/scenarios.mjs                    # every scenario
//   node test/scenarios.mjs --only S1,S3
//   node test/scenarios.mjs --dry              # print the plan, run nothing
//   node test/scenarios.mjs --json-result      # + compact machine summary
//
// Programmatic:
//   import { scenarios, runScenario } from './test/scenarios.mjs'
//   const outcome = await runScenario(scenarios[0], { prefix: '/tmp/my-run' })
//
// Current status: the plugin in index.js is still a load-only placeholder, so
// S1/S2 are EXPECTED to fail until the Lead wires the codex provider; S3 is the
// control and should pass even with the placeholder mounted. The scenario
// definitions below are final in shape — assertions may be tightened once the
// first real run shows the adapter's actual event payloads.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runPrompt, summarizeResult } from './run-headless.mjs'

const DEFAULT_PREFIX = '/tmp/dsh-codex-mode-scenarios'
const TIMEOUT_SECONDS = 240

/** Remove a file if present (used by scenarios that assert command effects). */
function removeFile(path) {
  try {
    rmSync(path, { force: true })
  } catch {}
}

/**
 * S1 — trigger phrase + inline content.
 * `使用codex模式：Reply with exactly: pong` must enable codex mode for this
 * session and route the first turn through the codex provider, whose answer is
 * `pong` (not a DSH-model answer).
 */
const S1 = {
  id: 'S1',
  title: '触发词+内容 → session routes to codex and answers pong',
  tags: ['codex', 'route', 'trigger'],
  requiresPlugin: true,
  steps: [
    {
      prompt: '使用codex模式：Reply with exactly: pong',
      expect: {
        exitCode: 0,
        requestProviders: ['codex'],
        assistantProviders: ['codex'],
        events: [
          { type: 'turn/start', minCount: 1 },
          { type: 'request/header', minCount: 1, where: { 'data.header.config.provider': 'codex' } },
          { type: 'assistant/message', minCount: 1, where: { 'data.message.source.provider': 'codex' } },
          { type: 'turn/end', minCount: 1 },
        ],
        lastAssistantContains: 'pong',
        finalTextContains: 'pong',
      },
    },
  ],
  checks: ({ results }) => {
    const failures = []
    // If the plugin writes an explicit model/selection event (known Session
    // event type, appended by the session controller in web builds), it must
    // name the codex provider. Its absence is fine in headless.
    const selections = (results[0]?.newEvents ?? []).filter((event) => event.type === 'model/selection')
    for (const event of selections) {
      const provider = event.data?.provider
      if (provider !== 'codex') failures.push({ ok: false, message: `model/selection provider ${provider} (expected codex)` })
    }
    return failures
  },
}

/**
 * S2 — tool-card bridge.
 * Codex executes a shell command itself (NOT the DSH `bash` tool); the plugin
 * surfaces each Codex action as a synthetic `codex_activity` tool call
 * (tool/call + tool/result in the session log) and the command's side effect
 * must exist on disk. The file is checked after the DSH run exits because the
 * command runs inside Codex's own process/sandbox.
 */
const TOOL_FILE = '/tmp/dsh-codex-tool-ok.txt'
const S2 = {
  id: 'S2',
  title: '触发词+工具 → codex_activity tool card + real command side effect',
  tags: ['codex', 'tools', 'bridge'],
  requiresPlugin: true,
  setup: () => removeFile(TOOL_FILE),
  steps: [
    {
      prompt:
        '使用codex模式：Execute the shell command printf codex-tool-ok > /tmp/dsh-codex-tool-ok.txt and then reply done',
      expect: {
        exitCode: 0,
        requestProviders: ['codex'],
        assistantProviders: ['codex'],
        events: [
          { type: 'request/header', minCount: 1, where: { 'data.header.config.provider': 'codex' } },
          { type: 'tool/call', minCount: 1, where: { 'data.name': 'codex_activity' } },
          { type: 'tool/result', minCount: 1 },
          { type: 'assistant/message', minCount: 1, where: { 'data.message.source.provider': 'codex' } },
        ],
        // The command must run inside Codex, not be re-dispatched to DSH's bash tool.
        notEvents: [{ type: 'tool/call', where: { 'data.name': 'bash' } }],
        toolCalls: [{ name: 'codex_activity', minCount: 1 }],
        files: [{ path: TOOL_FILE, contains: 'codex-tool-ok' }],
        lastAssistantContains: 'done',
      },
    },
  ],
  checks: ({ results }) => {
    const failures = []
    const events = results[0]?.newEvents ?? []
    const call = events.find((event) => event.type === 'tool/call' && event.data?.name === 'codex_activity')
    if (!call) failures.push({ ok: false, message: 'no tool/call with name codex_activity' })
    const result = events.find((event) => event.type === 'tool/result')
    if (!result) failures.push({ ok: false, message: 'no tool/result paired with the codex_activity call' })
    return failures
  },
}

/**
 * S3 — persistence + isolation across turns and sessions.
 *  step 1: trigger phrase enables codex mode for this Session;
 *  step 2: a SECOND turn in the SAME Session, with NO trigger phrase, still
 *          routes to codex (`--session-id` resume) — the route persists;
 *  step 3: a NEW Session in the same isolated home (no `--session-id`) is back
 *          on the default DSH model — codex mode does not leak.
 */
const S3 = {
  id: 'S3',
  title: '续接/隔离 → 无触发词的第二轮仍走 codex；新会话回到默认模型',
  tags: ['codex', 'persistence', 'isolation'],
  requiresPlugin: true,
  steps: [
    {
      prompt: '使用codex模式：Reply with exactly: pong',
      expect: {
        exitCode: 0,
        requestProviders: ['codex'],
        assistantProviders: ['codex'],
        events: [
          { type: 'request/header', minCount: 1, where: { 'data.header.config.provider': 'codex' } },
          { type: 'assistant/message', minCount: 1, where: { 'data.message.source.provider': 'codex' } },
        ],
        lastAssistantContains: 'pong',
      },
    },
    {
      prompt: 'Reply with exactly: pong2',
      sessionIdFromPrevious: true,
      expect: {
        exitCode: 0,
        requestProviders: ['codex'],
        assistantProviders: ['codex'],
        events: [
          { type: 'request/header', minCount: 1, where: { 'data.header.config.provider': 'codex' } },
          { type: 'assistant/message', minCount: 1, where: { 'data.message.source.provider': 'codex' } },
        ],
        // Turn 2 has no trigger phrase, so no /codex receipt command runs.
        notEvents: [{ type: 'command/run', where: { 'data.name': 'codex' } }],
        lastAssistantContains: 'pong2',
      },
    },
    {
      prompt: 'Reply with exactly: dsh-default',
      sessionIdFromPrevious: false,
      expect: {
        exitCode: 0,
        requestProviders: ['deepseek-official'],
        noAssistantProvider: 'codex',
        events: [
          { type: 'request/header', minCount: 1, where: { 'data.header.config.provider': 'deepseek-official' } },
          { type: 'assistant/message', minCount: 1, where: { 'data.message.source.provider': 'deepseek-official' } },
        ],
        notEvents: [{ type: 'tool/call', where: { 'data.name': 'codex_activity' } }],
        lastAssistantContains: 'dsh-default',
      },
    },
  ],
  checks: ({ results }) => {
    const failures = []
    const [first, second, third] = results
    if (first && second && first.sessionId !== second.sessionId) {
      failures.push({ ok: false, message: `turn 2 did not resume turn 1's session (${first.sessionId} != ${second.sessionId})` })
    }
    if (first && third && first.sessionId === third.sessionId) {
      failures.push({ ok: false, message: 'step 3 unexpectedly reused the codex-mode session instead of starting a new one' })
    }
    return failures
  },
}

/**
 * S4 — failure/stop path (aborted turn). Hard to trigger deterministically in
 * headless: the runner has no interactive stop channel and a synthetic
 * mid-turn failure would need adapter-level fault injection. Kept as a
 * placeholder so the acceptance matrix mirrors design.md §7; skipped until the
 * plugin exposes a test seam (or a fault-injection overlay exists).
 */
const S4 = {
  id: 'S4',
  title: '失败/停止（暂不自动化：headless 无稳定停止通道）',
  tags: ['codex', 'failure', 'skipped'],
  skipped: true,
  skipReason: 'headless one-shot run has no interactive stop channel; needs an adapter fault-injection seam',
  requiresPlugin: true,
  steps: [],
}

export const scenarios = [S1, S2, S3, S4]

// A multi-turn scenario template lives here for the Lead: after wiring, steps
// after the first pass `sessionIdFromPrevious: true` and the runner keeps the
// isolated home to resume the same Session with `--session-id`.
// export const S4 = {
//   id: 'S4',
//   title: '两轮续接：触发后追问，codex 记住上一轮',
//   steps: [
//     { prompt: '使用codex模式：Remember the word APPLE and reply ok', expect: { exitCode: 0 } },
//     { prompt: 'Which word did I ask you to remember? Reply with just that word.',
//       sessionIdFromPrevious: true,
//       expect: { exitCode: 0, lastAssistantContains: 'APPLE' } },
//   ],
// }

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Persist one step's captured output under `<home>/artifacts/` so a failed run
 * can be diagnosed after the process exits (stdout/stderr/event summary).
 * Best effort: artifact writes never fail a scenario.
 */
function writeStepArtifacts(home, stepIndex, result) {
  try {
    const dir = join(home, 'artifacts')
    mkdirSync(dir, { recursive: true })
    const base = join(dir, `step-${stepIndex + 1}`)
    writeFileSync(`${base}.stdout.txt`, result.stdout ?? '')
    writeFileSync(`${base}.stderr.txt`, result.stderr ?? '')
    writeFileSync(`${base}.result.json`, JSON.stringify(summarizeResult(result), null, 2))
    return base
  } catch {
    return undefined
  }
}

/**
 * Execute one scenario.
 * @param {object} scenario
 * @param {{prefix?: string, timeoutMs?: number, overlay?: string, quiet?: boolean, dryRun?: boolean}} options
 * @returns {Promise<{id: string, ok: boolean, failures: string[], steps: object[], checks: object[], results: object[], durationMs: number, dryRun?: boolean}>} 
 */
export async function runScenario(scenario, options = {}) {
  const {
    prefix = DEFAULT_PREFIX,
    timeoutMs = TIMEOUT_SECONDS * 1000,
    overlay,
    quiet = false,
    dryRun = false,
  } = options
  if (!scenario || typeof scenario.id !== 'string' || !Array.isArray(scenario.steps)) {
    throw new Error(`invalid scenario: ${JSON.stringify(scenario)?.slice(0, 200)}`)
  }
  const startedAtMs = Date.now()
  const home = `${prefix}/${scenario.id.toLowerCase()}`
  const outcome = { id: scenario.id, title: scenario.title, ok: false, skipped: false, failures: [], steps: [], checks: [], results: [], home, durationMs: 0 }

  if (scenario.skipped) {
    outcome.skipped = true
    outcome.skipReason = scenario.skipReason
    outcome.ok = true
    outcome.durationMs = Date.now() - startedAtMs
    return outcome
  }

  if (dryRun) {
    outcome.dryRun = true
    outcome.ok = true
    return outcome
  }

  await scenario.setup?.()

  let result
  try {
    for (const [index, step] of scenario.steps.entries()) {
      const continuation = index > 0 && step.sessionIdFromPrevious !== false
      const sessionId = continuation ? result.sessionId : step.sessionId
      const patches = step.patches ?? (overlay ? [overlay] : undefined)
      if (!quiet) console.log(`[scenario ${scenario.id}] step ${index + 1}/${scenario.steps.length}: ${JSON.stringify(step.prompt ?? '(stdin)').slice(0, 160)}`)
      const stepResult = await runPrompt({
        prompt: step.prompt,
        stdin: step.stdin,
        home,
        patches,
        keepHome: continuation || index > 0,
        sessionId,
        expect: step.expect,
        timeoutMs: step.timeoutMs ?? timeoutMs,
        quiet: quiet || !step.verbose,
      })
      const artifactBase = writeStepArtifacts(home, index, stepResult)
      outcome.steps.push({
        index,
        prompt: step.prompt,
        sessionId: stepResult.sessionId,
        ok: stepResult.ok,
        failures: stepResult.failures,
        sessionLogPath: stepResult.sessionLogPath,
        artifactBase,
      })
      outcome.results.push(stepResult)
      result = stepResult
      const stepFailures = stepResult.failures.map((failure) => `step ${index + 1}: ${failure}`)
      outcome.failures.push(...stepFailures)
      if (stepResult.sessionLogPath && !quiet) {
        console.log(`[scenario ${scenario.id}] step ${index + 1} session log: ${stepResult.sessionLogPath}`)
      }
      if (!stepResult.ok && !quiet) {
        console.log(`[scenario ${scenario.id}] step ${index + 1} FAILED: ${stepResult.failures.join(' | ')}`)
        console.log(`[scenario ${scenario.id}] step ${index + 1} stderr tail: ${(stepResult.stderr ?? '').slice(-1200)}`)
      }
    }

    const checks = await scenario.checks?.({ results: outcome.results, home, scenario })
    for (const check of checks ?? []) {
      outcome.checks.push(check)
      if (!check.ok) outcome.failures.push(`check: ${check.message}`)
    }
  } catch (error) {
    outcome.failures.push(`runner error: ${error?.message ?? error}`)
  } finally {
    try {
      await scenario.teardown?.({ results: outcome.results, home })
    } catch (error) {
      outcome.failures.push(`teardown error: ${error?.message ?? error}`)
    }
  }

  outcome.ok = outcome.failures.length === 0
  outcome.durationMs = Date.now() - startedAtMs
  try {
    const dir = join(home, 'artifacts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({
      id: outcome.id,
      title: outcome.title,
      ok: outcome.ok,
      skipped: outcome.skipped,
      failures: outcome.failures,
      durationMs: outcome.durationMs,
      steps: outcome.steps,
      checks: outcome.checks,
      results: outcome.results.map(summarizeResult),
    }, null, 2))
  } catch {}
  return outcome
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const options = { only: undefined, prefix: DEFAULT_PREFIX, timeoutMs: TIMEOUT_SECONDS * 1000, overlay: undefined, quiet: false, jsonResult: false, dry: false, verbose: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const take = () => {
      const value = argv[index + 1]
      if (value === undefined) {
        console.error(`[scenarios] ${arg} requires a value`)
        process.exit(2)
      }
      index += 1
      return value
    }
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--only':
        options.only = take().split(',').map((id) => id.trim().toUpperCase()).filter(Boolean)
        break
      case '--home-prefix':
        options.prefix = take()
        break
      case '--timeout':
        options.timeoutMs = Number(take()) * 1000
        break
      case '--overlay':
        options.overlay = take()
        break
      case '--quiet':
        options.quiet = true
        break
      case '--verbose':
        options.verbose = true
        break
      case '--json-result':
        options.jsonResult = true
        break
      case '--dry':
        options.dry = true
        break
      default:
        console.error(`[scenarios] unknown option "${arg}"`)
        process.exit(2)
    }
  }
  return options
}

function printPlan(selected) {
  console.log(`[scenarios] ${selected.length} scenario(s) defined:`)
  for (const scenario of selected) {
    console.log(`- ${scenario.id}: ${scenario.title} [${(scenario.tags ?? []).join(', ')}]${scenario.skipped ? ` [SKIPPED: ${scenario.skipReason ?? 'no reason'}]` : ''}`)
    for (const [index, step] of scenario.steps.entries()) {
      const continuation = index > 0 && step.sessionIdFromPrevious !== false ? ' (continues previous session)' : ''
      console.log(`    step ${index + 1}${continuation}: ${JSON.stringify(step.prompt ?? '(stdin)')}`)
      if (step.expect) console.log(`      expect: ${JSON.stringify(step.expect)}`)
    }
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    console.log('test/scenarios.mjs — codex-mode headless acceptance scenarios')
    console.log('usage: node test/scenarios.mjs [--only S1,S2] [--home-prefix /tmp/dir] [--timeout 240] [--overlay path] [--dry] [--quiet] [--json-result]')
    return 0
  }
  const selected = options.only
    ? scenarios.filter((scenario) => options.only.includes(scenario.id.toUpperCase()))
    : scenarios
  if (!selected.length) {
    console.error(`[scenarios] no scenario matched --only ${options.only?.join(',')}`)
    return 2
  }
  printPlan(selected)
  if (options.dry) return 0

  const outcomes = []
  for (const scenario of selected) {
    console.log(`\n[scenarios] === ${scenario.id}: ${scenario.title} ===`)
    const outcome = await runScenario(scenario, {
      prefix: options.prefix,
      timeoutMs: options.timeoutMs,
      overlay: options.overlay,
      quiet: options.quiet,
      dryRun: false,
    })
    outcomes.push(outcome)
    if (options.verbose) {
      for (const result of outcome.results) {
        console.log(`[scenarios] ${scenario.id} events: ${result.eventTypes.join(' > ')}`)
      }
    }
    const label = outcome.skipped ? 'SKIP' : outcome.ok ? 'PASS' : 'FAIL'
    console.log(`[scenarios] ${scenario.id}: ${label} (${outcome.durationMs}ms)${outcome.skipped ? ` — ${outcome.skipReason}` : ''}`)
    for (const failure of outcome.failures) console.log(`[scenarios] ${scenario.id} FAIL: ${failure}`)
    if (!outcome.ok && !outcome.skipped) console.log(`[scenarios] ${scenario.id} artifacts: ${join(outcome.home, 'artifacts')}`)
  }

  const skipped = outcomes.filter((outcome) => outcome.skipped).length
  const passed = outcomes.filter((outcome) => outcome.ok && !outcome.skipped).length
  const failed = outcomes.filter((outcome) => !outcome.ok).length
  console.log(`\n[scenarios] summary: ${passed} passed, ${skipped} skipped, ${failed} failed (of ${outcomes.length})`)
  if (options.jsonResult) {
    console.log(JSON.stringify(outcomes.map((outcome) => ({
      id: outcome.id,
      ok: outcome.ok,
      skipped: outcome.skipped,
      skipReason: outcome.skipReason,
      failures: outcome.failures,
      durationMs: outcome.durationMs,
      steps: outcome.steps,
      results: outcome.results.map(summarizeResult),
    })), null, 2))
  }
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[scenarios] unexpected error: ${error?.stack ?? error}`)
    process.exit(1)
  })
}
