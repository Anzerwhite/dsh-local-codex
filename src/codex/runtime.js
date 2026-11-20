// Codex runtime: thread/turn lifecycle on top of a CodexAppServer plus
// normalization of app-server notifications into the stable event list from
// docs/impl-contract.md §2.3.
//
// Approvals arrive as server->client requests; they are bridged to the injected
// `approvalHandler` and answered with the decision payload the app-server
// expects.

import { CodexAppServerError } from './app-server.js'

/** server request method -> approval kind exposed to approvalHandler */
const APPROVAL_METHODS = Object.freeze({
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions',
})

const APPROVAL_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel'])

/** Valid app-server UserInput variant tags (v2/UserInput.ts). */
const USER_INPUT_TYPES = new Set(['text', 'image', 'localImage', 'audio', 'localAudio', 'skill', 'mention'])

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
})

export class CodexRuntime {
  #appServer
  #log
  #approvalHandler
  /** @type {Map<string, {turnId?: string, lastUsage?: object, cwd?: string}>} */
  #threads = new Map()
  /** @type {Set<(event: object) => unknown>} */
  #eventHandlers = new Set()
  /** @type {Array<() => void>} */
  #disposers = []
  #disposed = false

  /**
   * @param {{ appServer: import('./app-server.js').CodexAppServer, log?: object, approvalHandler?: (req: object) => Promise<string>|string }} options
   */
  constructor({ appServer, log, approvalHandler }) {
    if (appServer === undefined || appServer === null) {
      throw new TypeError('CodexRuntime: `appServer` is required')
    }
    this.#appServer = appServer
    this.#log = log ?? NOOP_LOG
    this.#approvalHandler = approvalHandler
    this.#disposers.push(
      appServer.onNotification(notification => this.#handleNotification(notification)),
      appServer.onServerRequest(request => this.#handleServerRequest(request)),
      appServer.onExit(info => this.#handleExit(info)),
    )
  }

  /** Start the app-server if needed. Idempotent; retryable after failure. */
  async ensureStarted() {
    await this.#appServer.start()
  }

  isAlive() {
    return this.#appServer.isAlive()
  }

  /**
   * @param {{cwd?: string, developerInstructions?: string, sandbox?: string, approvalPolicy?: string, model?: string, effort?: string, ephemeral?: boolean}} [options]
   * @returns {Promise<{threadId: string}>}
   */
  async threadStart(options = {}) {
    const { cwd, developerInstructions, sandbox, approvalPolicy, model, effort, ephemeral } = options
    await this.ensureStarted()
    if (effort !== undefined && effort !== null) {
      // ThreadStartParams has no reasoning-effort field (only `model`); effort is
      // applied per turn via turn/start. Keep the option for API symmetry.
      this.#log.debug('[codex] threadStart: `effort` is not part of thread/start; pass it to turnStart')
    }
    const params = omitUndefined({
      cwd: normalizePath(cwd),
      model: normalizeOptionalString(model),
      developerInstructions: normalizeOptionalString(developerInstructions),
      sandbox: mapSandboxMode(sandbox),
      approvalPolicy: mapApprovalPolicy(approvalPolicy),
      ephemeral: typeof ephemeral === 'boolean' ? ephemeral : undefined,
    })
    const result = await this.#appServer.request('thread/start', params)
    const threadId = result?.thread?.id ?? result?.threadId
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new CodexAppServerError('CODEX_BAD_RESPONSE', 'thread/start response is missing thread.id')
    }
    this.#threads.set(threadId, { cwd: normalizePath(cwd) ?? normalizePath(result?.cwd) })
    return { threadId }
  }

  /**
   * @param {{threadId: string, cwd?: string, sandbox?: string, approvalPolicy?: string, model?: string, effort?: string, excludeTurns?: boolean}} options
   * @returns {Promise<{threadId: string}>}
   */
  async threadResume(options = {}) {
    const { threadId, cwd, sandbox, approvalPolicy, model, effort, excludeTurns = true } = options
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new TypeError('threadResume: `threadId` must be a non-empty string')
    }
    await this.ensureStarted()
    if (effort !== undefined && effort !== null) {
      this.#log.debug('[codex] threadResume: `effort` is not part of thread/resume; pass it to turnStart')
    }
    const params = omitUndefined({
      threadId,
      cwd: normalizePath(cwd),
      model: normalizeOptionalString(model),
      sandbox: mapSandboxMode(sandbox),
      approvalPolicy: mapApprovalPolicy(approvalPolicy),
      // Full-history hydration is deprecated for paginated threads and can take
      // >10s; metadata + live resume is enough because the adapter streams live.
      excludeTurns: excludeTurns === undefined ? true : Boolean(excludeTurns),
    })
    const result = await this.#appServer.request('thread/resume', params)
    const resolvedThreadId = result?.thread?.id ?? threadId
    this.#threads.set(resolvedThreadId, { cwd: normalizePath(cwd) ?? normalizePath(result?.cwd) })
    return { threadId: resolvedThreadId }
  }

  /**
   * @param {{threadId: string, input: Array<object|string>, cwd?: string, sandbox?: string, approvalPolicy?: string, model?: string, effort?: string}} options
   * @returns {Promise<{turnId: string}>}
   */
  async turnStart(options = {}) {
    const { threadId, input, cwd, sandbox, approvalPolicy, model, effort } = options
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new TypeError('turnStart: `threadId` must be a non-empty string')
    }
    await this.ensureStarted()
    const params = omitUndefined({
      threadId,
      input: normalizeInput(input),
      cwd: normalizePath(cwd),
      // turn/start takes a SandboxPolicy object (thread/start takes SandboxMode).
      sandboxPolicy: mapSandboxPolicy(sandbox, normalizePath(cwd)),
      approvalPolicy: mapApprovalPolicy(approvalPolicy),
      model: normalizeOptionalString(model),
      effort: normalizeOptionalString(effort),
    })
    const result = await this.#appServer.request('turn/start', params)
    const turnId = result?.turn?.id
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new CodexAppServerError('CODEX_BAD_RESPONSE', 'turn/start response is missing turn.id')
    }
    const state = this.#threadState(threadId)
    state.turnId = turnId
    state.lastUsage = undefined
    return { turnId }
  }

  /**
   * Interrupt the active turn. Resolves once the app-server acknowledged; the
   * actual `turn/completed{status:'interrupted'}` arrives as an event.
   * Errors are logged but not rethrown so abort paths stay robust.
   * @param {{threadId: string, turnId?: string}} options
   */
  async turnInterrupt(options = {}) {
    const { threadId } = options
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new TypeError('turnInterrupt: `threadId` must be a non-empty string')
    }
    const turnId = normalizeOptionalString(options.turnId) ?? this.#threads.get(threadId)?.turnId
    if (turnId === undefined) {
      this.#log.debug('[codex] turnInterrupt: no turnId known, nothing to interrupt')
      return
    }
    await this.ensureStarted()
    try {
      await this.#appServer.request('turn/interrupt', { threadId, turnId })
    } catch (error) {
      this.#log.warn('[codex] turn/interrupt failed', error?.message ?? String(error))
    }
  }

  /**
   * Release a loaded thread WITHOUT deleting it. `thread/unsubscribe` lets the
   * app-server unload the thread (and release its writer lock) after the
   * configured unload delay; `thread/resume` can open it again later.
   * @param {{threadId: string}} options
   * @returns {Promise<object>} the app-server response
   */
  async threadUnsubscribe(options = {}) {
    const { threadId } = options
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new TypeError('threadUnsubscribe: `threadId` must be a non-empty string')
    }
    await this.ensureStarted()
    const result = await this.#appServer.request('thread/unsubscribe', { threadId })
    this.#threads.delete(threadId)
    return result
  }

  /**
   * List threads currently loaded (subscribed) in the app-server process.
   * @returns {Promise<string[]>}
   */
  async threadLoadedList() {
    await this.ensureStarted()
    const result = await this.#appServer.request('thread/loaded/list', {})
    return Array.isArray(result?.data) ? result.data : []
  }

  /**
   * Subscribe to normalized events. Handler exceptions are logged, never
   * propagated (one bad listener must not break the notification reader).
   * @param {(event: object) => unknown} handler
   * @returns {() => void} dispose
   */
  onEvent(handler) {
    if (typeof handler !== 'function') throw new TypeError('onEvent: handler must be a function')
    this.#eventHandlers.add(handler)
    return () => {
      this.#eventHandlers.delete(handler)
    }
  }

  /** Unregister listeners and stop the app-server. */
  async stop() {
    if (this.#disposed) return
    this.#disposed = true
    for (const dispose of this.#disposers) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
    this.#disposers = []
    this.#threads.clear()
    await this.#appServer.stop()
  }

  // ---------------------------------------------------------------------------
  // notifications -> normalized events
  // ---------------------------------------------------------------------------

  #handleNotification(notification) {
    const { method } = notification
    const params = isRecord(notification.params) ? notification.params : {}
    try {
      switch (method) {
        case 'turn/started': {
          const threadId = asString(params.threadId) ?? asString(params.turn?.threadId)
          const turnId = asString(params.turn?.id)
          if (threadId !== undefined && turnId !== undefined) this.#threadState(threadId).turnId = turnId
          this.#emit({ type: 'turn_started', threadId, turnId })
          return
        }
        case 'item/agentMessage/delta':
          this.#emit({
            type: 'agent_message_delta',
            threadId: asString(params.threadId),
            turnId: asString(params.turnId),
            itemId: asString(params.itemId),
            delta: asString(params.delta) ?? '',
          })
          return
        case 'item/reasoning/summaryTextDelta':
          this.#emit({
            type: 'reasoning_delta',
            threadId: asString(params.threadId),
            turnId: asString(params.turnId),
            itemId: asString(params.itemId),
            delta: asString(params.delta) ?? '',
            channel: 'summary',
          })
          return
        case 'item/reasoning/textDelta':
          this.#emit({
            type: 'reasoning_delta',
            threadId: asString(params.threadId),
            turnId: asString(params.turnId),
            itemId: asString(params.itemId),
            delta: asString(params.delta) ?? '',
            channel: 'text',
          })
          return
        case 'item/started':
          this.#emit({
            type: 'item_started',
            threadId: asString(params.threadId),
            turnId: asString(params.turnId),
            item: params.item,
          })
          return
        case 'item/completed':
          this.#emit({
            type: 'item_completed',
            threadId: asString(params.threadId),
            turnId: asString(params.turnId),
            item: params.item,
          })
          return
        case 'item/commandExecution/outputDelta':
          this.#emit({
            type: 'command_output_delta',
            threadId: asString(params.threadId),
            turnId: asString(params.turnId),
            itemId: asString(params.itemId),
            delta: asString(params.delta) ?? '',
          })
          return
        case 'item/fileChange/outputDelta':
          this.#emit({
            type: 'file_change_output_delta',
            threadId: asString(params.threadId),
            turnId: asString(params.turnId),
            itemId: asString(params.itemId),
            delta: asString(params.delta) ?? '',
          })
          return
        case 'turn/plan/updated':
          this.#emit({
            type: 'plan_updated',
            threadId: asString(params.threadId),
            turnId: asString(params.turnId),
            plan: Array.isArray(params.plan) ? params.plan : [],
            explanation: params.explanation ?? null,
          })
          return
        case 'thread/tokenUsage/updated': {
          const threadId = asString(params.threadId)
          const usage = params.tokenUsage
          if (threadId !== undefined) this.#threadState(threadId).lastUsage = usage
          this.#emit({ type: 'token_usage_updated', threadId, usage })
          return
        }
        case 'turn/completed': {
          const turn = isRecord(params.turn) ? params.turn : {}
          const threadId = asString(params.threadId) ?? asString(turn.threadId)
          const turnId = asString(turn.id)
          const state = threadId === undefined ? undefined : this.#threads.get(threadId)
          const usage = state?.lastUsage
          if (state !== undefined) {
            state.turnId = undefined
            state.lastUsage = undefined
          }
          this.#emit({
            type: 'turn_completed',
            threadId,
            turnId,
            status: asString(turn.status) ?? 'failed',
            usage: usage ?? undefined,
            raw: params,
          })
          return
        }
        case 'error': {
          const error = isRecord(params.error) ? params.error : {}
          const message = asString(error.message) ?? 'codex error'
          const threadId = asString(params.threadId)
          const turnId = asString(params.turnId)
          if (params.willRetry === true) {
            // Not terminal: the turn continues after a retry. Surface as a
            // warning so adapters do not end the turn prematurely.
            this.#emit({ type: 'warning', message: `codex error (will retry): ${message}` })
            return
          }
          this.#emit({ type: 'error', threadId, turnId, message, code: codexErrorCode(error) })
          return
        }
        case 'warning':
          this.#emit({ type: 'warning', message: asString(params.message) ?? 'codex warning' })
          return
        case 'configWarning':
        case 'deprecationNotice':
        case 'guardianWarning': {
          const summary = asString(params.summary) ?? asString(params.message) ?? method
          const details = asString(params.details)
          this.#emit({ type: 'warning', message: details ? `${summary} — ${details}` : summary })
          return
        }
        default:
          this.#log.debug(`[codex] unhandled notification: ${method}`)
          this.#emit({ type: 'raw', method, params })
          return
      }
    } catch (error) {
      this.#log.error(`[codex] failed to normalize notification ${method}`, error)
    }
  }

  // ---------------------------------------------------------------------------
  // server requests -> approval bridge
  // ---------------------------------------------------------------------------

  /**
   * Returns `{ result }` / `{ error }` for the transport to write back.
   * Unknown methods return undefined so the transport answers `-32601`.
   */
  async #handleServerRequest(request) {
    const kind = APPROVAL_METHODS[request.method]
    if (kind === undefined) return undefined
    const params = isRecord(request.params) ? request.params : {}
    const approvalRequest = {
      kind,
      requestId: request.id,
      threadId: asString(params.threadId),
      turnId: asString(params.turnId),
      itemId: asString(params.itemId),
      payload: params,
    }
    let decision = 'decline'
    const handler = this.#approvalHandler
    if (typeof handler !== 'function') {
      this.#log.debug(`[codex] no approvalHandler; declining ${request.method}`)
    } else {
      try {
        const raw = await handler(approvalRequest)
        if (APPROVAL_DECISIONS.has(raw)) {
          decision = raw
        } else if (raw !== undefined && raw !== null) {
          this.#log.warn(`[codex] approvalHandler returned unexpected decision ${String(raw)}; declining`)
        }
      } catch (error) {
        // Contract: handler failure maps to decline.
        this.#log.error('[codex] approvalHandler failed; declining', error)
        decision = 'decline'
      }
    }
    return approvalResponse(kind, decision, params)
  }

  #handleExit(info) {
    if (this.#disposed) return
    this.#log.warn(
      `[codex] app-server exited unexpectedly (code=${String(info?.code)}, signal=${String(info?.signal)})`,
    )
    this.#threads.clear()
    this.#emit({
      type: 'error',
      message: `codex app-server exited (code=${String(info?.code)}, signal=${String(info?.signal)})`,
    })
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  #threadState(threadId) {
    let state = this.#threads.get(threadId)
    if (state === undefined) {
      state = {}
      this.#threads.set(threadId, state)
    }
    return state
  }

  #emit(event) {
    for (const handler of this.#eventHandlers) {
      try {
        const result = handler(event)
        if (isThenable(result)) {
          result.catch(error => this.#log.error(`[codex] onEvent handler rejected for ${event.type}`, error))
        }
      } catch (error) {
        this.#log.error(`[codex] onEvent handler threw for ${event.type}`, error)
      }
    }
  }
}

// -----------------------------------------------------------------------------
// parameter mapping (see /tmp/dsh-codex-research/appserver-ts/v2 for the shapes)
// -----------------------------------------------------------------------------

/**
 * Map a DSH permission-preset sandbox string to app-server `SandboxMode`
 * (used by thread/start and thread/resume).
 * @param {unknown} sandbox
 * @returns {string|undefined}
 */
export function mapSandboxMode(sandbox) {
  if (sandbox === undefined || sandbox === null) return undefined
  if (typeof sandbox !== 'string') return undefined
  switch (sandbox) {
    case 'read-only':
    case 'readonly':
    case 'readOnly':
      return 'read-only'
    case 'workspace-write':
    case 'workspaceWrite':
      return 'workspace-write'
    case 'danger-full-access':
    case 'dangerFullAccess':
    case 'full-access':
      return 'danger-full-access'
    default:
      return undefined
  }
}

/**
 * Map a sandbox string to app-server `SandboxPolicy` (used by turn/start).
 * @param {unknown} sandbox
 * @param {string|undefined} cwd
 * @returns {object|undefined}
 */
export function mapSandboxPolicy(sandbox, cwd) {
  const mode = mapSandboxMode(sandbox)
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false }
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: cwd === undefined ? [] : [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    default:
      return undefined
  }
}

/**
 * Map a DSH approval policy to app-server `AskForApproval`.
 * DSH 'ask' -> 'on-request', 'never' -> 'never'; other known values pass through.
 * @param {unknown} approvalPolicy
 * @returns {string|undefined}
 */
export function mapApprovalPolicy(approvalPolicy) {
  if (approvalPolicy === undefined || approvalPolicy === null) return undefined
  if (typeof approvalPolicy !== 'string') return undefined
  switch (approvalPolicy) {
    case 'ask':
    case 'onRequest':
    case 'on_request':
      return 'on-request'
    case 'on-request':
    case 'never':
    case 'untrusted':
      return approvalPolicy
    default:
      return undefined
  }
}

/**
 * Normalize contract input entries to app-server `UserInput` variants.
 * Accepts a bare string as convenience -> `{type:'text', text}`.
 * @param {unknown} input
 */
export function normalizeInput(input) {
  if (typeof input === 'string') return [{ type: 'text', text: input }]
  if (!Array.isArray(input)) return []
  const result = []
  for (const entry of input) {
    if (typeof entry === 'string') {
      result.push({ type: 'text', text: entry })
      continue
    }
    if (!isRecord(entry) || typeof entry.type !== 'string') continue
    switch (entry.type) {
      case 'text':
        result.push({ type: 'text', text: asString(entry.text) ?? '' })
        break
      case 'localImage':
        if (typeof entry.path === 'string' && entry.path.length > 0) {
          result.push({ type: 'localImage', path: entry.path })
        }
        break
      default:
        // Forward only the other valid app-server UserInput variants; unknown
        // shapes are dropped so one bad entry cannot fail the whole turn/start.
        if (USER_INPUT_TYPES.has(entry.type)) result.push(entry)
        break
    }
  }
  return result
}

/**
 * Build the response for an approval server request.
 * @param {'command'|'fileChange'|'permissions'} kind
 * @param {'accept'|'acceptForSession'|'decline'|'cancel'} decision
 * @param {object} params
 */
export function approvalResponse(kind, decision, params) {
  if (kind === 'command' || kind === 'fileChange') {
    return { result: { decision } }
  }
  // item/permissions/requestApproval answers with a permission grant, not a
  // decision string (PermissionsRequestApprovalResponse). Accept = echo the
  // requested permission profile; decline/cancel = grant nothing.
  if (decision === 'accept' || decision === 'acceptForSession') {
    const requested = isRecord(params.permissions) ? params.permissions : {}
    return {
      result: {
        permissions: {
          network: requested.network ?? null,
          fileSystem: requested.fileSystem ?? null,
        },
        scope: decision === 'acceptForSession' ? 'session' : 'turn',
      },
    }
  }
  return { result: { permissions: {}, scope: 'turn' } }
}

// -----------------------------------------------------------------------------
// small utilities
// -----------------------------------------------------------------------------

function omitUndefined(object) {
  const result = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

function normalizePath(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asString(value) {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function'
}

function codexErrorCode(error) {
  const info = error?.codexErrorInfo
  if (typeof info === 'string') return info
  if (isRecord(info)) {
    const key = Object.keys(info)[0]
    if (typeof key === 'string' && key.length > 0) return key
  }
  return undefined
}
