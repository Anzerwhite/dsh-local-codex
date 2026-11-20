#!/usr/bin/env node
// test/run-headless.mjs — headless E2E harness for dsh-codex-mode.
//
// Runs ONE `dsh --profile headless` turn inside an isolated DSH_HOME with this
// repo's plugin mounted through a `--patch` overlay, then reads back the durable
// session JSONL (Zstd or plain), prints an event sequence, and asserts a
// declarative `--expect` rule set.
//
// CLI:
//   node test/run-headless.mjs --prompt "Reply with exactly: pong"
//   node test/run-headless.mjs --prompt "..." --expect '{"events":[{"type":"turn/end"}]}'
//   node test/run-headless.mjs --prompt "..." --expect @expect.json --home /tmp/my-home
//   node test/run-headless.mjs --prompt "continue" --session-id session-… --keep-home
//   echo 'prompt from stdin' | node test/run-headless.mjs --stdin
//
// Options:
//   --prompt <text>          task text (required unless --stdin)
//   --stdin                  read the task from stdin instead
//   --home <dir>             isolated DSH_HOME (default /tmp/dsh-codex-home-test;
//                            must live under /tmp; wiped first unless --keep-home)
//   --patch <path>           overlay patch (repeatable; default dev/overlay.yml;
//                            pass `--patch none` to run without any overlay)
//   --expect <json|@file>    assertion rules, see EXPECT RULES below
//   --session-id <id>        adopt an existing Session (multi-turn continuation)
//   --timeout <seconds>      child process deadline (default 180)
//   --keep-home              do not wipe --home first (resume / multi-turn)
//   --no-credential-autofill do not read /root/.dsh/.credentials.yaml
//   --credentials-file <p>   managed store to read DEEPSEEK_API_KEY from
//   --api-key <key>          explicit key (visible in argv; discouraged)
//   --quiet                  only failures + PASS/FAIL line
//   --json-result            print a compact machine result on stdout
//   -h, --help               this help
//
// Programmatic API (what scenarios / the Lead should import):
//   import { runPrompt, loadSessionEvents, evaluateExpect } from './test/run-headless.mjs'
//   const result = await runPrompt({ prompt, patches, expect, sessionId, home })
//
// EXPECT RULES (every key optional; unknown keys are rejected):
//   exitCode, stdoutContains, stderrContains, finalTextContains, finalTextEquals,
//   lastAssistantContains, assistantContains,
//   events: [{ type, count?, minCount?, maxCount?, where?: {dotPath: value|{$contains}} }],
//   notEvents: [{ type, where? }],
//   orderedSubsequence: ['turn/start', 'assistant/message', 'turn/end'],
//   toolCalls: [{ name, count?, minCount?, maxCount? }],
//   assistantProviders: ['codex'], requestProviders: ['codex'],
//   noAssistantProvider: 'codex',
//   files: [{ path, contains?, equals?, minBytes? }]
//
// Assertions run against `result.assertEvents` = the events this invocation
// added (for a resumed session: seq greater than the pre-run baseline).
// Exit codes: 0 pass, 1 run or assertion failure, 2 usage error.
//
// All output homes go under /tmp by default; the real /root/.dsh is never
// modified. The model API key is passed to the child through its environment
// and is never echoed by this script.
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = dirname(HERE)
export const DEV_OVERLAY = join(REPO_ROOT, 'dev', 'overlay.yml')
const NPM_GLOBAL_BIN = '/root/.npm-global/bin'
const DEFAULT_HOME = '/tmp/dsh-codex-home-test'
const DEFAULT_CREDENTIALS_FILE = '/root/.dsh/.credentials.yaml'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_TIMEOUT_SECONDS = 180
const SESSION_LOG_RE = /^session\.v\d+\.jsonl(?:\.zstd)?$/
const CREDENTIALS_ENV = [DEFAULT_API_KEY_ENV]

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(quiet, ...args) {
  if (!quiet) console.log(...args)
}

function failUsage(message) {
  console.error(`[run-headless] usage error: ${message}`)
  console.error('run `node test/run-headless.mjs --help` for usage')
  process.exit(2)
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function truncate(text, max = 4000) {
  if (typeof text !== 'string') return text
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars truncated]`
}

function tail(text, max = 2500) {
  if (typeof text !== 'string' || text.length <= max) return text
  return `… [${text.length - max} chars truncated] ${text.slice(-max)}`
}

// ---------------------------------------------------------------------------
// Home preparation + environment
// ---------------------------------------------------------------------------

/** Refuse homes that could destroy real state; tests only write under /tmp. */
export function assertSafeHome(home) {
  if (typeof home !== 'string' || !home.trim()) throw new Error('home must be a non-empty path')
  const abs = resolve(home)
  if (!isAbsolute(abs)) throw new Error(`home must be absolute: ${home}`)
  const forbidden = ['/', '/root', '/root/.dsh', '/workspace', '/workspace/dsh_ifself', REPO_ROOT]
  for (const bad of forbidden) {
    if (abs === resolve(bad)) throw new Error(`refusing to use ${abs} as an isolated DSH_HOME`)
  }
  const tmpPrefix = resolve('/tmp') + sep
  if (!abs.startsWith(tmpPrefix)) {
    throw new Error(`test homes must live under /tmp (got ${abs}); use --home /tmp/<name>`)
  }
  return abs
}

export function prepareHome(home, { keepHome = false } = {}) {
  const abs = assertSafeHome(home)
  if (!keepHome && existsSync(abs)) rmSync(abs, { recursive: true, force: true })
  mkdirSync(abs, { recursive: true })
  return abs
}

/**
 * Read one credential ref from a managed `$DSH_HOME/.credentials.yaml`
 * (structure: `refs:\n  DEEPSEEK_API_KEY: <literal>\nrecords:`). Dependency-free
 * on purpose (no YAML package in this repo).
 */
export function readCredentialRef(credentialsFile, name = DEFAULT_API_KEY_ENV) {
  let text
  try {
    text = readFileSync(credentialsFile, 'utf8')
  } catch {
    return undefined
  }
  let inRefs = false
  for (const line of text.split('\n')) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(line)) break // next top-level key ends the refs block
    const match = line.match(/^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/)
    if (match && match[1] === name) return match[2]
  }
  return undefined
}

/**
 * Child environment: isolated DSH_HOME, PATH with the dsh/codex npm-global bin,
 * no leaked session-scoped DSH_* vars, telemetry opted out, and the model key
 * inherited (or auto-filled from the managed store — never logged).
 */
export function buildChildEnv({ home, credentialsFile, apiKey, autofillCredentials = true, extraEnv = {} }) {
  const env = { ...process.env }
  // The parent harness session's identity must not leak into the child run.
  for (const key of ['DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']) {
    delete env[key]
  }
  env.DSH_HOME = home
  env.DSH_TELEMETRY_DISABLED = '1' // keep scripted runs network-quiet
  const pathParts = (env.PATH ?? '').split(':').filter(Boolean)
  if (!pathParts.includes(NPM_GLOBAL_BIN)) env.PATH = [NPM_GLOBAL_BIN, ...pathParts].join(':')

  let keySource
  if (apiKey) {
    env[DEFAULT_API_KEY_ENV] = apiKey
    keySource = 'cli'
  } else if (env[DEFAULT_API_KEY_ENV]) {
    keySource = 'inherited'
  } else if (autofillCredentials) {
    const fromStore = readCredentialRef(credentialsFile ?? DEFAULT_CREDENTIALS_FILE, DEFAULT_API_KEY_ENV)
    if (fromStore) {
      env[DEFAULT_API_KEY_ENV] = fromStore
      keySource = 'managed-store'
    }
  }
  return { env: { ...env, ...extraEnv }, keySource, hasApiKey: Boolean(env[DEFAULT_API_KEY_ENV]) }
}

// ---------------------------------------------------------------------------
// Session log discovery + parsing
// ---------------------------------------------------------------------------

function walkSessionLogs(root) {
  const found = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile() && SESSION_LOG_RE.test(entry.name)) {
        try {
          const stat = statSync(abs)
          found.push({ path: abs, mtimeMs: stat.mtimeMs, size: stat.size })
        } catch {}
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Pre-run snapshot of every session log → baseline seq (for resume assertions). */
export function snapshotSessionLogs(home) {
  const snapshot = new Map()
  for (const record of walkSessionLogs(join(home, 'sessions'))) {
    try {
      const { events } = loadSessionEvents(record.path)
      const maxSeq = events.length ? events[events.length - 1].seq : -1
      snapshot.set(record.path, { maxSeq, mtimeMs: record.mtimeMs, size: record.size })
    } catch {
      // A log locked by a live process may be unreadable; treat as unseen.
    }
  }
  return snapshot
}

/**
 * Resolve which session log this run wrote.
 *  1. exact session directory named by the `--json` `session` event;
 *  2. newest log modified at/after `startedAtMs`;
 *  3. newest log overall under the home.
 */
export function locateSessionLogs({ home, sessionId, startedAtMs = 0 }) {
  const all = walkSessionLogs(join(home, 'sessions'))
  if (sessionId) {
    // Only the exact Session directory is this run's log. Falling back to the
    // newest log here would mis-attribute a stale run when an adopted
    // --session-id does not exist.
    return all.filter((record) => record.path.split(sep).includes(sessionId))
  }
  if (!startedAtMs) return all
  const fresh = all.filter((record) => record.mtimeMs >= startedAtMs - 2000)
  return fresh.length ? fresh : all
}

/** Read one session log (`.jsonl` or `.jsonl.zstd`) → header + events. */
export function loadSessionEvents(logPath) {
  const raw = readFileSync(logPath)
  const text = logPath.endsWith('.zstd')
    ? zstdDecompressSync(raw).toString('utf8')
    : raw.toString('utf8')
  let header
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (record.type === 'session') header = record
    else if (typeof record.seq === 'number') events.push(record)
  }
  events.sort((a, b) => a.seq - b.seq)
  return { header, events, lineCount: events.length }
}

// ---------------------------------------------------------------------------
// stdout / --json stream handling
// ---------------------------------------------------------------------------

function parseJsonStdout(stdout) {
  const events = []
  const nonJson = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') events.push(parsed)
    } catch {
      nonJson.push(line)
    }
  }
  return { events, nonJson }
}

function messageText(message) {
  const content = message?.content ?? []
  const texts = []
  for (const block of Array.isArray(content) ? content : []) {
    if (typeof block === 'string') texts.push(block)
    else if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n').trim()
}

function getPath(object, path) {
  let current = object
  for (const part of String(path).split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function matchesWhere(event, where) {
  if (!where || typeof where !== 'object') return true
  for (const [path, expected] of Object.entries(where)) {
    const actual = getPath(event, path)
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$contains' in expected) {
      const needle = expected.$contains
      if (typeof actual === 'string') {
        if (!actual.includes(needle)) return false
      } else if (Array.isArray(actual)) {
        if (!actual.some((item) => JSON.stringify(item) === JSON.stringify(needle) || String(item).includes(String(needle)))) return false
      } else if (JSON.stringify(actual) !== JSON.stringify(needle)) {
        return false
      }
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const KNOWN_EXPECT_KEYS = new Set([
  'exitCode', 'stdoutContains', 'stderrContains', 'finalTextContains', 'finalTextEquals',
  'lastAssistantContains', 'assistantContains', 'events', 'notEvents',
  'orderedSubsequence', 'toolCalls', 'assistantProviders', 'requestProviders',
  'noAssistantProvider', 'files', 'sessionId',
])

/**
 * Evaluate an `--expect` rule object against a runPrompt result.
 * Returns `{ ok, failures }`; never throws for an assertion mismatch.
 */
export function evaluateExpect(result, expect = {}) {
  const failures = []
  const push = (message) => failures.push(message)
  const events = result.assertEvents ?? result.newEvents ?? result.events ?? []
  const allEvents = result.events ?? events
  const subjectOf = (rule) => (rule?.scope === 'all' ? allEvents : events)

  if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
    return { ok: false, failures: ['--expect must be a JSON object'] }
  }
  for (const key of Object.keys(expect)) {
    if (!KNOWN_EXPECT_KEYS.has(key)) push(`unknown --expect key "${key}"`)
  }

  if (result.timedOut) push(`run timed out after ${result.timeoutSeconds}s`)
  if (!('exitCode' in expect)) {
    if (!result.timedOut && result.exitCode !== 0) {
      push(
        `exit code ${result.exitCode} (expected 0)` +
          (result.stderr ? `; stderr tail: ${tail(result.stderr, 1200)}` : '') +
          (result.hasApiKey ? '' : ' — hint: no DEEPSEEK_API_KEY reached the child; export it or let the harness autofill from /root/.dsh/.credentials.yaml'),
      )
    }
  } else if (result.exitCode !== expect.exitCode) {
    push(`exit code ${result.exitCode} (expected ${expect.exitCode})`)
  }
  if (expect.sessionId !== undefined && result.sessionId !== expect.sessionId) {
    push(`sessionId ${result.sessionId} (expected ${expect.sessionId})`)
  }

  const checkContains = (label, actual, needle) => {
    if (needle === undefined) return
    if (typeof actual !== 'string' || !actual.includes(needle)) {
      push(`${label} does not contain ${JSON.stringify(needle)} (actual: ${JSON.stringify(truncate(actual ?? '', 400))})`)
    }
  }
  checkContains('stdout', result.stdout, expect.stdoutContains)
  checkContains('stderr', result.stderr, expect.stderrContains)
  checkContains('final text', result.finalText, expect.finalTextContains)
  if (expect.finalTextEquals !== undefined && result.finalText !== expect.finalTextEquals) {
    push(`final text ${JSON.stringify(result.finalText)} (expected ${JSON.stringify(expect.finalTextEquals)})`)
  }
  const assistantTexts = result.assistantTexts ?? []
  if (expect.lastAssistantContains !== undefined) {
    checkContains('last assistant text', assistantTexts.at(-1) ?? '', expect.lastAssistantContains)
  }
  if (expect.assistantContains !== undefined) {
    if (!assistantTexts.some((text) => text.includes(expect.assistantContains))) {
      push(`no assistant text contains ${JSON.stringify(expect.assistantContains)} (assistant texts: ${JSON.stringify(assistantTexts.map((text) => truncate(text, 120)))})`)
    }
  }

  if (expect.events !== undefined) {
    if (!Array.isArray(expect.events)) push('"events" must be an array')
    else {
      for (const rule of expect.events) {
        if (!rule || typeof rule.type !== 'string') {
          push(`invalid events rule ${JSON.stringify(rule)}`)
          continue
        }
        const matched = subjectOf(rule).filter((event) => event.type === rule.type && matchesWhere(event, rule.where))
        const count = matched.length
        if (rule.count !== undefined && count !== rule.count) push(`event ${rule.type}: count ${count} (expected ${rule.count})`)
        if (rule.minCount !== undefined && count < rule.minCount) push(`event ${rule.type}: count ${count} (expected >= ${rule.minCount})`)
        if (rule.maxCount !== undefined && count > rule.maxCount) push(`event ${rule.type}: count ${count} (expected <= ${rule.maxCount})`)
        if (rule.count === undefined && rule.minCount === undefined && rule.maxCount === undefined && count === 0) {
          push(`event ${rule.type}: not found${rule.where ? ` matching ${JSON.stringify(rule.where)}` : ''}`)
        }
      }
    }
  }

  if (expect.notEvents !== undefined) {
    if (!Array.isArray(expect.notEvents)) push('"notEvents" must be an array')
    else {
      for (const rule of expect.notEvents) {
        if (!rule || (typeof rule !== 'string' && typeof rule.type !== 'string')) {
          push(`invalid notEvents rule ${JSON.stringify(rule)}`)
          continue
        }
        const type = typeof rule === 'string' ? rule : rule.type
        const matched = subjectOf(rule).filter((event) => event.type === type && (typeof rule === 'string' || matchesWhere(event, rule.where)))
        if (matched.length) push(`event ${type} should be absent but appeared ${matched.length}x${typeof rule === 'object' && rule.where ? ` matching ${JSON.stringify(rule.where)}` : ''}`)
      }
    }
  }

  if (expect.orderedSubsequence !== undefined) {
    const sequence = expect.orderedSubsequence.map((item) => (typeof item === 'string' ? item : item?.type))
    if (sequence.some((type) => typeof type !== 'string')) push('invalid orderedSubsequence')
    else {
      let cursor = 0
      for (const event of events) {
        if (cursor < sequence.length && event.type === sequence[cursor]) cursor += 1
      }
      if (cursor !== sequence.length) push(`orderedSubsequence ${JSON.stringify(sequence)}: reached ${cursor}/${sequence.length}`)
    }
  }

  if (expect.toolCalls !== undefined) {
    const calls = result.toolCalls ?? []
    if (!Array.isArray(expect.toolCalls)) push('"toolCalls" must be an array')
    else {
      for (const rule of expect.toolCalls) {
        if (!rule || typeof rule.name !== 'string') {
          push(`invalid toolCalls rule ${JSON.stringify(rule)}`)
          continue
        }
        const count = calls.filter((call) => call.name === rule.name).length
        if (rule.count !== undefined && count !== rule.count) push(`tool call ${rule.name}: count ${count} (expected ${rule.count})`)
        if (rule.minCount !== undefined && count < rule.minCount) push(`tool call ${rule.name}: count ${count} (expected >= ${rule.minCount})`)
        if (rule.maxCount !== undefined && count > rule.maxCount) push(`tool call ${rule.name}: count ${count} (expected <= ${rule.maxCount})`)
        if (rule.count === undefined && rule.minCount === undefined && rule.maxCount === undefined && count === 0) {
          push(`tool call ${rule.name}: not found (calls: ${JSON.stringify(calls.map((call) => call.name))})`)
        }
      }
    }
  }

  for (const key of ['assistantProviders', 'requestProviders']) {
    if (expect[key] === undefined) continue
    if (!Array.isArray(expect[key])) {
      push(`"${key}" must be an array of provider ids`)
      continue
    }
    const actual = key === 'assistantProviders' ? (result.assistantProviders ?? []) : (result.requestProviders ?? [])
    for (const provider of actual) {
      if (!expect[key].includes(provider)) push(`${key}: unexpected provider "${provider}" (expected one of ${JSON.stringify(expect[key])})`)
    }
    if (expect[key].length && actual.length === 0) push(`${key}: no provider observed (expected one of ${JSON.stringify(expect[key])})`)
  }
  if (expect.noAssistantProvider !== undefined && (result.assistantProviders ?? []).includes(expect.noAssistantProvider)) {
    push(`assistant/message unexpectedly used provider "${expect.noAssistantProvider}"`)
  }

  if (expect.files !== undefined) {
    if (!Array.isArray(expect.files)) push('"files" must be an array')
    else {
      for (const rule of expect.files) {
        if (!rule || typeof rule.path !== 'string') {
          push(`invalid files rule ${JSON.stringify(rule)}`)
          continue
        }
        let content
        try {
          content = readFileSync(rule.path, 'utf8')
        } catch (error) {
          push(`file ${rule.path}: unreadable (${error?.code ?? error?.message})`)
          continue
        }
        if (rule.contains !== undefined && !content.includes(rule.contains)) {
          push(`file ${rule.path} does not contain ${JSON.stringify(rule.contains)} (actual: ${JSON.stringify(truncate(content, 300))})`)
        }
        if (rule.equals !== undefined && content !== rule.equals) push(`file ${rule.path} content mismatch (expected exactly ${JSON.stringify(rule.equals)})`)
        if (rule.minBytes !== undefined && Buffer.byteLength(content) < rule.minBytes) push(`file ${rule.path}: ${Buffer.byteLength(content)} bytes (expected >= ${rule.minBytes})`)
      }
    }
  }

  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------------------
// Run one prompt
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RunPromptOptions
 * @property {string} [prompt]            task text (or set `stdin`)
 * @property {string} [stdin]             task text passed through stdin instead
 * @property {string} [home]              isolated DSH_HOME (under /tmp)
 * @property {string[]} [patches]         overlay patch files; default [dev/overlay.yml]
 * @property {boolean} [keepHome]         do not wipe the home first
 * @property {object} [expect]            evaluateExpect rules
 * @property {number} [timeoutMs]         child deadline (default 180_000)
 * @property {string} [sessionId]         adopt an existing Session (continuation)
 * @property {string} [cwd]               child working directory (default repo root)
 * @property {boolean} [autofillCredentials] default true
 * @property {string} [credentialsFile]   default /root/.dsh/.credentials.yaml
 * @property {string} [apiKey]            explicit key (discouraged)
 * @property {Record<string,string>} [env] extra child env vars
 * @property {boolean} [quiet]            suppress progress output
 */

/**
 * Run one headless prompt and return a structured result.
 * Never throws for assertion failures; throws only for caller errors (bad home…).
 * @param {RunPromptOptions} options
 */
export async function runPrompt(options = {}) {
  const {
    prompt,
    stdin,
    home = DEFAULT_HOME,
    patches = [DEV_OVERLAY],
    keepHome = false,
    expect,
    timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
    sessionId,
    cwd = REPO_ROOT,
    autofillCredentials = true,
    credentialsFile = DEFAULT_CREDENTIALS_FILE,
    apiKey,
    env: extraEnv,
    quiet = false,
  } = options

  if (prompt === undefined && stdin === undefined) throw new Error('runPrompt needs `prompt` or `stdin`')
  if (Boolean(prompt) && stdin !== undefined) throw new Error('pass either `prompt` or `stdin`, not both')
  if (!Array.isArray(patches)) throw new Error('`patches` must be an array of paths (or [])')
  if (sessionId && !keepHome) {
    throw new Error('`sessionId` requires `keepHome: true`: adopting a Session cannot work after wiping its DSH_HOME')
  }

  const resolvedHome = prepareHome(home, { keepHome })
  const baseline = keepHome ? snapshotSessionLogs(resolvedHome) : new Map()
  const { env, keySource, hasApiKey } = buildChildEnv({
    home: resolvedHome,
    credentialsFile,
    apiKey,
    autofillCredentials,
    extraEnv,
  })

  const launcherArgs = ['--profile', 'headless']
  for (const patch of patches) {
    if (patch === 'none') continue
    launcherArgs.push('--patch', resolve(String(patch)))
  }
  const appArgs = ['--json']
  if (sessionId) appArgs.push('--session-id', sessionId)
  if (stdin !== undefined) {
    appArgs.push('-')
  } else {
    if (String(prompt).startsWith('-')) appArgs.push('--')
    appArgs.push(String(prompt))
  }
  const argv = ['dsh', ...launcherArgs, ...appArgs]
  const commandForLog = `dsh ${launcherArgs.join(' ')} ${appArgs.map((arg) => (arg === prompt ? JSON.stringify(arg) : arg)).join(' ')}`

  log(quiet, `[run-headless] $ ${commandForLog}`)
  log(quiet, `[run-headless] DSH_HOME=${resolvedHome} key=${keySource ?? 'none'}${patches.length ? ` patches=${patches.join(',')}` : ' patches=none'}`)

  const startedAtMs = Date.now()
  const child = spawn('dsh', [...launcherArgs, ...appArgs], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (stdin !== undefined) child.stdin.write(String(stdin))
  child.stdin.end()

  let stdout = ''
  let stderr = ''
  const MAX_CAPTURE = 16 * 1024 * 1024
  child.stdout.on('data', (chunk) => {
    if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk) => {
    if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8')
  })

  const outcome = await new Promise((resolvePromise) => {
    let timedOut = false
    let timer
    let killTimer
    const finish = (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolvePromise({ code, signal, timedOut })
    }
    const armKill = () => {
      child.kill('SIGKILL')
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGTERM')
        } catch {}
        killTimer = setTimeout(armKill, 5000)
      }, timeoutMs)
      timer.unref?.()
    }
    child.on('error', (error) => {
      stderr += `\n[run-headless] spawn error: ${error?.message ?? error}`
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
  const durationMs = Date.now() - startedAtMs

  // A timed-out process can leave the log mid-write; give the fs one beat.
  if (outcome.timedOut) await sleep(250)

  const { events: jsonStream, nonJson } = parseJsonStdout(stdout)
  const sessionEvent = jsonStream.find((event) => event.type === 'session') ?? {}
  const finalEvent = [...jsonStream].reverse().find((event) => event.type === 'final') ?? {}
  const resolvedSessionId = sessionEvent.sessionId ?? sessionId

  // Locate + parse the durable session log for this run.
  let sessionLogPath
  let header
  let events = []
  let sessionLogCandidates = []
  let eventTypes = []
  let newEvents = []
  let newEventTypes = []
  let baselineSeq = -1
  let assistantTexts = []
  let toolCalls = []
  let assistantProviders = []
  let requestProviders = []
  let parseError

  try {
    sessionLogCandidates = locateSessionLogs({ home: resolvedHome, sessionId: resolvedSessionId, startedAtMs })
    sessionLogPath = sessionLogCandidates[0]?.path
    if (sessionLogPath) {
      const loaded = loadSessionEvents(sessionLogPath)
      header = loaded.header
      events = loaded.events
      baselineSeq = baseline.get(sessionLogPath)?.maxSeq ?? -1
      newEvents = events.filter((event) => event.seq > baselineSeq)
      eventTypes = events.map((event) => event.type)
      newEventTypes = newEvents.map((event) => event.type)
      assistantTexts = newEvents
        .filter((event) => event.type === 'assistant/message')
        .map((event) => messageText(event.data?.message ?? event.data))
        .filter((text) => text.length > 0)
      assistantProviders = [...new Set(
        newEvents
          .filter((event) => event.type === 'assistant/message')
          .map((event) => event.data?.message?.source?.provider ?? event.data?.message?.provider)
          .filter(Boolean),
      )]
      requestProviders = [...new Set(
        newEvents
          .filter((event) => event.type === 'request/header')
          .map((event) => event.data?.header?.config?.provider)
          .filter(Boolean),
      )]
      toolCalls = newEvents
        .filter((event) => event.type === 'tool/call')
        .map((event) => ({
          name: event.data?.name,
          callId: event.data?.callId,
          arguments: event.data?.arguments,
        }))
    }
  } catch (error) {
    parseError = error?.message ?? String(error)
  }

  const result = {
    ok: false,
    failures: [],
    command: commandForLog,
    argv,
    cwd,
    home: resolvedHome,
    patches: patches.filter((patch) => patch !== 'none').map((patch) => resolve(String(patch))),
    keySource,
    hasApiKey,
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    timeoutSeconds: Math.round(timeoutMs / 1000),
    durationMs,
    stdout,
    stderr,
    nonJsonStdout: nonJson,
    jsonStream,
    finalText: typeof finalEvent.text === 'string' ? finalEvent.text : (assistantTexts.at(-1) ?? ''),
    sessionId: resolvedSessionId,
    sessionHeader: header,
    sessionLogPath,
    sessionLogCandidates: sessionLogCandidates.map((record) => record.path),
    events,
    newEvents,
    assertEvents: newEvents.length ? newEvents : events,
    baselineSeq,
    eventTypes,
    newEventTypes,
    assistantTexts,
    toolCalls,
    assistantProviders,
    requestProviders,
    parseError,
  }

  const evaluation = evaluateExpect(result, expect ?? {})
  result.failures = evaluation.failures
  result.ok = evaluation.ok && !result.timedOut
  return result
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Human-readable block describing one run (event sequence, texts, tools). */
export function formatResult(result, { quiet = false } = {}) {
  const lines = []
  const assertionLabel = result.newEvents.length && result.baselineSeq >= 0 ? 'new events' : 'events'
  lines.push(
    `[run-headless] exit=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ''}` +
      `${result.timedOut ? ' TIMED-OUT' : ''} duration=${result.durationMs}ms session=${result.sessionId ?? '(none)'}` +
      ` key=${result.keySource ?? 'none'}`,
  )
  lines.push(`[run-headless] session log: ${result.sessionLogPath ?? '(not found)'}`)
  if (result.parseError) lines.push(`[run-headless] session log parse error: ${result.parseError}`)
  if (result.eventTypes.length) {
    lines.push(`[run-headless] ${assertionLabel} (${result.assertEvents.length}/${result.events.length}): ${result.eventTypes.join(' > ')}`)
  } else {
    lines.push('[run-headless] no session events parsed')
  }
  if (result.toolCalls.length) {
    lines.push(`[run-headless] tool calls: ${result.toolCalls.map((call) => call.name).join(', ')}`)
  }
  if (result.assistantProviders.length) lines.push(`[run-headless] assistant providers: ${result.assistantProviders.join(', ')}`)
  if (result.requestProviders.length) lines.push(`[run-headless] request providers: ${result.requestProviders.join(', ')}`)
  if (result.assistantTexts.length) {
    lines.push(`[run-headless] assistant text: ${JSON.stringify(truncate(result.assistantTexts.at(-1) ?? '', 400))}`)
  }
  lines.push(`[run-headless] final text: ${JSON.stringify(truncate(result.finalText, 400))}`)
  if (result.nonJsonStdout.length) {
    lines.push(`[run-headless] note: ${result.nonJsonStdout.length} non-JSON stdout line(s) (tolerated), e.g. ${JSON.stringify(truncate(result.nonJsonStdout[0], 160))}`)
  }
  if (!result.ok) {
    for (const failure of result.failures) lines.push(`[run-headless] FAIL: ${failure}`)
    if (result.stderr && !result.failures.some((failure) => failure.includes('stderr tail'))) {
      lines.push(`[run-headless] stderr tail: ${tail(result.stderr, 2000)}`)
    }
  } else {
    lines.push('[run-headless] PASS')
  }
  return lines.join('\n')
}

/** Compact JSON-serializable summary (no raw event payloads). */
export function summarizeResult(result) {
  return {
    ok: result.ok,
    failures: result.failures,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    command: result.command,
    home: result.home,
    patches: result.patches,
    sessionId: result.sessionId,
    sessionLogPath: result.sessionLogPath,
    eventTypes: result.eventTypes,
    newEventTypes: result.newEventTypes,
    assertEvents: result.assertEvents.length,
    events: result.events.length,
    baselineSeq: result.baselineSeq,
    finalText: result.finalText,
    assistantTexts: result.assistantTexts,
    toolCalls: result.toolCalls,
    assistantProviders: result.assistantProviders,
    requestProviders: result.requestProviders,
    keySource: result.keySource,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    prompt: undefined,
    stdin: false,
    home: DEFAULT_HOME,
    patches: undefined,
    keepHome: false,
    expect: undefined,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    sessionId: undefined,
    autofillCredentials: true,
    credentialsFile: DEFAULT_CREDENTIALS_FILE,
    apiKey: undefined,
    quiet: false,
    jsonResult: false,
  }
  const patchArgs = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const take = (name) => {
      const value = argv[index + 1]
      if (value === undefined) failUsage(`${name} requires a value`)
      index += 1
      return value
    }
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--prompt':
        options.prompt = take('--prompt')
        break
      case '--stdin':
        options.stdin = true
        break
      case '--home':
        options.home = take('--home')
        break
      case '--patch':
        patchArgs.push(take('--patch'))
        break
      case '--expect': {
        const raw = take('--expect')
        options.expectPath = raw.startsWith('@') ? raw.slice(1) : undefined
        if (options.expectPath) {
          try {
            options.expect = JSON.parse(readFileSync(options.expectPath, 'utf8'))
          } catch (error) {
            failUsage(`cannot read --expect file ${options.expectPath}: ${error?.message}`)
          }
        } else {
          try {
            options.expect = JSON.parse(raw)
          } catch (error) {
            failUsage(`--expect is not valid JSON: ${error?.message}`)
          }
        }
        break
      }
      case '--session-id':
        options.sessionId = take('--session-id')
        break
      case '--timeout': {
        const seconds = Number(take('--timeout'))
        if (!Number.isFinite(seconds) || seconds <= 0) failUsage('--timeout must be a positive number of seconds')
        options.timeoutMs = Math.round(seconds * 1000)
        break
      }
      case '--keep-home':
        options.keepHome = true
        break
      case '--no-credential-autofill':
        options.autofillCredentials = false
        break
      case '--credentials-file':
        options.credentialsFile = take('--credentials-file')
        break
      case '--api-key':
        options.apiKey = take('--api-key')
        break
      case '--quiet':
        options.quiet = true
        break
      case '--json-result':
        options.jsonResult = true
        break
      default:
        failUsage(`unknown option "${arg}"`)
    }
  }
  if (options.help) return options
  if (options.stdin && options.prompt !== undefined) failUsage('pass either --prompt or --stdin, not both')
  if (!options.stdin && options.prompt === undefined) failUsage('missing --prompt (or --stdin)')
  if (options.sessionId && options.keepHome !== true) {
    failUsage('--session-id requires --keep-home (the Session lives in the existing --home)')
  }
  options.patches = patchArgs.length ? patchArgs : [DEV_OVERLAY]
  return options
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return 0
  }
  let stdin
  if (options.stdin) {
    stdin = await readStdin()
    if (!stdin.trim()) failUsage('--stdin received no task text')
  }
  let result
  try {
    result = await runPrompt({
      prompt: options.prompt,
      stdin,
      home: options.home,
      patches: options.patches,
      keepHome: options.keepHome,
      expect: options.expect,
      timeoutMs: options.timeoutMs,
      sessionId: options.sessionId,
      autofillCredentials: options.autofillCredentials,
      credentialsFile: options.credentialsFile,
      apiKey: options.apiKey,
      quiet: options.quiet,
    })
  } catch (error) {
    // Caller/setup errors (unsafe home, bad patch path, …) are usage problems,
    // not crashes: report the message without a Node stack trace.
    console.error(`[run-headless] failed to start run: ${error?.message ?? error}`)
    return 2
  }
  console.log(formatResult(result, { quiet: options.quiet }))
  if (options.jsonResult) console.log(JSON.stringify(summarizeResult(result), null, 2))
  return result.ok ? 0 : 1
}

const HELP = `test/run-headless.mjs — headless E2E harness for dsh-codex-mode.

Runs ONE \`dsh --profile headless\` turn inside an isolated DSH_HOME (under /tmp)
with this repo's plugin mounted through a \`--patch\` overlay, reads back the
durable session JSONL (Zstd or plain), prints the event sequence, and asserts a
declarative \`--expect\` rule set.

Usage:
  node test/run-headless.mjs --prompt "Reply with exactly: pong"
  node test/run-headless.mjs --prompt "..." --expect '{"lastAssistantContains":"pong"}'
  node test/run-headless.mjs --prompt "..." --expect @expect.json
  node test/run-headless.mjs --prompt "continue" --session-id session-… --keep-home
  node test/run-headless.mjs --stdin < prompt.txt

Options:
  --prompt <text>            task text (required unless --stdin)
  --stdin                    read the task from stdin instead
  --home <dir>               isolated DSH_HOME (default ${DEFAULT_HOME}; under /tmp;
                             wiped first unless --keep-home)
  --patch <path>             overlay patch file (repeatable; default dev/overlay.yml;
                             \`--patch none\` runs without any overlay)
  --expect <json|@file>      assertion rules (see EXPECT RULES in the file header)
  --session-id <id>          adopt an existing Session (multi-turn continuation)
  --timeout <seconds>        child process deadline (default ${DEFAULT_TIMEOUT_SECONDS})
  --keep-home                keep --home (resume / multi-turn runs)
  --no-credential-autofill   never read ${DEFAULT_CREDENTIALS_FILE}
  --credentials-file <path>  managed store to autofill the API key from
  --api-key <key>            explicit key (visible in argv; discouraged)
  --quiet                    only the summary/PASS/FAIL block
  --json-result              additionally print a compact machine-readable result
  -h, --help                 show this help

Exit codes: 0 pass, 1 run or assertion failure, 2 usage error.
`

function printHelp() {
  console.log(HELP)
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[run-headless] unexpected error: ${error?.stack ?? error}`)
    process.exit(1)
  })
}
