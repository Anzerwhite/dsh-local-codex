/**
 * Codex LLM adapter — routes one DSH session to the local Codex runtime and
 * maps normalized Codex runtime events onto the DSH `StreamChunk` protocol.
 *
 * The adapter is a plain object implementing the `LlmAdapter` contract
 * structurally (docs/impl-contract.md §3.1); it is constructed by the mode
 * controller and registered on the `codex` route by the plugin entry.
 *
 * Two protocols meet here:
 *
 * 1. DSH steps: `stream(options)` is called once per agent-loop step with the
 *    full derived history. The last durable user message identifies a Codex
 *    turn; every later step that still ends on that same message id is a
 *    continuation of the same Codex turn (normally triggered by a dispatched
 *    bridge-tool result).
 * 2. Codex runtime events: an independent, long-lived `runtime.onEvent`
 *    subscription fills per-session event queues. `stream()` only consumes
 *    those queues, so the bridge tool can await a Codex item's completion
 *    without deadlocking the transport reader.
 *
 * Synthetic tool calls: whenever a bridgeable Codex item starts
 * (`commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`) the adapter
 * closes the text block, records a pending result for the item, emits a
 * `codex_activity` tool-call block, finishes with `{kind:'tool-calls'}` and
 * returns. The DSH loop dispatches `src/bridge/tool.js`, whose `execute()`
 * awaits `takeResult(callId, signal)` until the item completes, so the native
 * `tool/result` already carries the final output.
 *
 * @module dsh-codex-mode/adapter
 */

import { randomUUID } from 'node:crypto'
import { buildBootstrap, extractUserMessageText } from './bootstrap.js'
import { BRIDGE_TOOL_NAME } from '../bridge/tool.js'

/** Provider display name reported to the LLM catalog. */
export const PROVIDER_DISPLAY_NAME = 'Codex (local)'

/**
 * Fallback context capacity advertised for the codex route until Codex tells us
 * the real window. Codex reports the authoritative value per thread in
 * `thread/tokenUsage/updated` as `tokenUsage.modelContextWindow` (for example
 * 475000 for a large-context provider model); advertising a hard-coded 200k
 * makes DSH's context meter and compaction thresholds wrong for those models.
 */
export const CODEX_CONTEXT_WINDOW = 200000

/** Error text for unsupported auxiliary calls when no fallback was injected. */
export const AUXILIARY_CALLS_ERROR = 'codex adapter: auxiliary calls are not served'

const DEFAULT_MODEL = 'gpt-6.2-sol'
const DEFAULT_BOOTSTRAP_LIMIT_CHARS = 24000
const BRIDGE_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'])

/** Buffered streamed output cap per pending activity (~10k tokens). */
const MAX_PENDING_OUTPUT_CHARS = 40000
/** Hard cap on a per-session event queue so a runaway turn cannot grow memory. */
const MAX_QUEUE_EVENTS = 100000
/** Retained settled pending activities per session (for late takeResult calls). */
const MAX_RETAINED_PENDINGS = 200
/** Conservative fallback when the mode controller cannot report the preset. */
const FALLBACK_PERMISSIONS = Object.freeze({ sandbox: 'read-only', approvalPolicy: 'never' })

/**
 * Create the Codex adapter.
 *
 * @param {object} options
 * @param {object} options.runtime - `CodexRuntime` (docs/impl-contract.md §2.2):
 *   `ensureStarted`, `threadStart`, `threadResume`, `turnStart`, `turnInterrupt`, `onEvent`.
 * @param {object} options.mode - session-scoped mode accessors:
 *   `getThread`, `setThread`, `getCwd`, `getSandboxApproval`, `materializeInput`.
 * @param {{debug?: Function, info?: Function, warn?: Function, error?: Function}} [options.log]
 * @param {{model?: string, cwd?: string, bootstrapLimitChars?: number}} [options.config]
 * @param {(callId: string, signal?: AbortSignal) => Promise<{kind: string, text: string, isError: boolean}>} [options.takeResult]
 *   Present in the factory signature for wiring convenience; the adapter always
 *   exposes its own queue-backed implementation (an injected one is unused).
 * @param {(options: object) => AsyncIterable<object>} [options.fallbackStream]
 *   Stream used for auxiliary calls (`compaction` / `session-title`), which are
 *   routed to the DSH default model instead of Codex.
 * @returns {object} `LlmAdapter`-shaped plain object plus `takeResult`/`dispose`.
 */
export function createCodexAdapter({ runtime, mode, log, config, takeResult: injectedTakeResult, fallbackStream } = {}) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('createCodexAdapter: runtime is required')
  if (typeof runtime.onEvent !== 'function') throw new TypeError('createCodexAdapter: runtime.onEvent() is required')
  const sessionMode = mode && typeof mode === 'object' ? mode : {}
  const settings = config && typeof config === 'object' ? config : {}
  const logger = normalizeLogger(log)
  const model = typeof settings.model === 'string' && settings.model.trim() ? settings.model.trim() : DEFAULT_MODEL
  const bootstrapLimitChars = positiveInt(settings.bootstrapLimitChars) ?? DEFAULT_BOOTSTRAP_LIMIT_CHARS
  const defaultCwd = typeof settings.cwd === 'string' && settings.cwd.trim() ? settings.cwd.trim() : undefined
  /** Codex reasoning efforts advertised to the DSH model picker. */
  const reasoningEfforts = normalizeReasoningEfforts(settings.codexEfforts)
  /** Effort used when a request carries none (Codex config model_reasoning_effort). */
  const defaultReasoningEffort = normalizeReasoningEffort(settings.reasoningEffort)
  /** Optional per-turn reasoning summary override; omitted leaves Codex config. */
  const reasoningSummary = normalizeReasoningSummary(settings.reasoningSummary)
  /** Safety net: the DSH loop has no step cap, so bound bridged actions per user turn. */
  const maxBridgeCallsPerTurn = positiveInt(settings.maxBridgeCallsPerTurn) ?? 200
  /** Context capacity advertised to DSH; updated once Codex reports the real one. */
  let contextWindow = positiveInt(settings.contextWindow) ?? CODEX_CONTEXT_WINDOW

  /**
   * Keep the advertised window in sync with Codex. `thread/tokenUsage/updated`
   * carries `modelContextWindow`; DSH only records a new `request/context` when
   * the advertised value changes, so applying it here is visible on the next
   * request (context meter and compaction thresholds then match the model).
   */
  function applyContextWindow(usage) {
    const window = positiveInt(usage?.modelContextWindow)
    if (window === undefined || window === contextWindow) return
    logger.info(`codex adapter: codex model context window ${contextWindow} -> ${window}`)
    contextWindow = window
  }
  const resolveEffortForLog = (requested) => normalizeReasoningEffort(requested) ?? defaultReasoningEffort

  /** @type {Map<string, SessionState>} */
  const sessions = new Map()
  /** Codex threadId -> DSH sessionId (event routing). */
  const threadToSession = new Map()
  /** callId -> pending activity record (global, UUID-keyed). */
  const allPendings = new Map()
  /** Sessions with a `stream()` consumer running right now. */
  const activeStreams = new Set()
  /** Runtime events already applied to pending activities by the subscription. */
  const appliedToPending = new WeakSet()

  let disposed = false
  let permissionsWarned = false
  let disposeEvents
  try {
    const maybeDispose = runtime.onEvent((event) => {
      try {
        handleEvent(event)
      } catch (error) {
        logger.error('codex adapter: event handling failed', error)
      }
    })
    disposeEvents = typeof maybeDispose === 'function' ? maybeDispose : undefined
  } catch (error) {
    throw new Error(`codex adapter: runtime.onEvent() failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // ---------------------------------------------------------------------------
  // Session state & event routing
  // ---------------------------------------------------------------------------

  function getSessionState(sessionId) {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {
        sessionId,
        channel: new EventChannel(),
        consumedUserMessageId: undefined,
        activeTurn: undefined,
        bridgeCallsThisTurn: 0,
        pendings: new Map(),
        pendingByItemId: new Map(),
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  function associateThread(threadId, sessionId) {
    if (typeof threadId !== 'string' || !threadId) return
    const previous = threadToSession.get(threadId)
    if (previous !== undefined && previous !== sessionId) {
      logger.warn(`codex adapter: codex thread ${threadId} was associated with ${previous}, now ${sessionId}`)
    }
    threadToSession.set(threadId, sessionId)
  }

  /** Resolve the session an event belongs to, or undefined when unattributable. */
  function stateForEvent(event) {
    if (!event || typeof event !== 'object') return undefined
    if (typeof event.threadId === 'string' && threadToSession.has(event.threadId)) {
      return sessions.get(threadToSession.get(event.threadId))
    }
    if (activeStreams.size === 1) {
      const [onlySessionId] = activeStreams
      return sessions.get(onlySessionId)
    }
    return undefined
  }

  /**
   * Subscription-side bookkeeping. Must run for every runtime event, even while
   * no `stream()` is consuming, so the bridge tool can settle an item that
   * completes during the model call boundary.
   */
  function handleEvent(event) {
    if (!event || typeof event !== 'object') return
    // Learn the Codex model's real context window as soon as Codex reports it,
    // even before/without an active stream consumer (the next request then
    // advertises the updated capacity through request/context).
    if (event.type === 'token_usage_updated' || event.type === 'turn_completed') applyContextWindow(event?.usage)
    applyPendingEvent(event)
    const state = stateForEvent(event)
    if (!state) {
      logger.debug(`codex adapter: dropping unattributable event ${String(event.type)} (thread ${String(event.threadId)})`)
      return
    }
    // Events fully consumed by the pending-activity bookkeeping need no queued
    // copy: a long command can stream thousands of output deltas while the
    // bridge tool awaits it, and the stream() consumer would only skip them.
    // (When no pending was attributable yet they are NOT marked, so the queued
    // copy is still applied later in order by the consumer.)
    if (
      (event.type === 'command_output_delta' || event.type === 'file_change_output_delta' || event.type === 'item_completed') &&
      appliedToPending.has(event)
    ) {
      return
    }
    state.channel.push(event)
  }

  function applyPendingEvent(event) {
    const state = stateForEvent(event)
    if (!state) return
    switch (event.type) {
      case 'item_started': {
        // Eagerly record the activity so output deltas that arrive before the
        // next stream() call can be accumulated in order.
        if (isBridgeableItem(event.item)) ensurePendingForItem(state, event)
        return
      }
      case 'item_completed': {
        const pending = pendingForItemId(state, event.item?.id)
        if (!pending || pending.settled || appliedToPending.has(event)) return
        appliedToPending.add(event)
        logger.debug(`codex adapter: item/completed settled ${pending.kind} activity ${pending.itemId}`)
        finalizePending(pending, event.item)
        return
      }
      case 'command_output_delta':
      case 'file_change_output_delta': {
        const pending = pendingForItemId(state, event.itemId)
        if (!pending || pending.settled || appliedToPending.has(event)) return
        appliedToPending.add(event)
        appendPendingOutput(pending, event.delta)
        return
      }
      case 'turn_completed':
      case 'error': {
        logger.debug(
          `codex adapter: terminal ${String(event.type)} thread=${String(event.threadId)} turn=${String(event.turnId)} status=${String(event.status)} pendings=${state.pendings.size}`,
        )
        settlePendingsForTerminalEvent(state, event)
        return
      }
      default:
        return
    }
  }

  // ---------------------------------------------------------------------------
  // Pending bridge activities
  // ---------------------------------------------------------------------------

  function pendingForItemId(state, itemId) {
    if (typeof itemId !== 'string' || itemId.length === 0) return undefined
    return state.pendingByItemId.get(itemId)
  }

  function ensurePendingForItem(state, event) {
    const item = event?.item
    if (!item || typeof item !== 'object') return undefined
    const itemId = typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined
    if (!itemId) return undefined
    const existing = state.pendingByItemId.get(itemId)
    if (existing) {
      if (isBridgeableItem(item) && existing.item === undefined) existing.item = item
      return existing
    }
    const kind = bridgeKind(item.type)
    if (!kind) return undefined
    const callId = randomUUID()
    const title = bridgeTitle(item, kind)
    const pending = {
      callId,
      itemId,
      kind,
      title,
      args: { callId, kind, title },
      sessionId: state.sessionId,
      threadId: event.threadId,
      turnId: event.turnId,
      item,
      output: '',
      outputTruncated: false,
      emitted: false,
      settled: false,
      result: undefined,
      failureText: undefined,
      waiters: [],
    }
    state.pendings.set(callId, pending)
    state.pendingByItemId.set(itemId, pending)
    allPendings.set(callId, pending)
    prunePendings(state)
    return pending
  }

  function appendPendingOutput(pending, delta) {
    if (typeof delta !== 'string' || delta.length === 0) return
    if (pending.output.length >= MAX_PENDING_OUTPUT_CHARS) {
      pending.outputTruncated = true
      return
    }
    const room = MAX_PENDING_OUTPUT_CHARS - pending.output.length
    if (delta.length <= room) {
      pending.output += delta
    } else {
      pending.output += delta.slice(0, room)
      pending.outputTruncated = true
    }
  }

  function finalizePending(pending, item, options) {
    if (pending.settled) return
    pending.settled = true
    if (item && typeof item === 'object') pending.item = item
    pending.result = options?.forcedResult ?? buildPendingResult(pending)
    pending.output = ''
    // NOTE: keep state.pendingByItemId[itemId] pointing at this settled pending:
    // an item can complete before the step's stream consumer reaches its queued
    // item_started, and re-creating a pending there would lose the real result.
    const waiters = pending.waiters.splice(0)
    for (const waiter of waiters) {
      try {
        waiter.resolve(pending.result)
      } catch (error) {
        logger.error('codex adapter: pending waiter failed', error)
      }
    }
  }

  function rejectPending(pending, error) {
    if (pending.settled) return
    pending.settled = true
    pending.failureText = error instanceof Error ? error.message : String(error)
    pending.output = ''
    const waiters = pending.waiters.splice(0)
    for (const waiter of waiters) {
      try {
        waiter.reject(error)
      } catch (callbackError) {
        logger.error('codex adapter: pending waiter failed', callbackError)
      }
    }
  }

  function settlePendingsForTerminalEvent(state, event) {
    const activeTurnId = state.activeTurn?.codexTurnId
    // A terminal event for a different Codex turn must never settle this turn's
    // activities (a resumed thread can surface late notifications).
    if (typeof event.turnId === 'string' && typeof activeTurnId === 'string' && event.turnId !== activeTurnId) {
      logger.debug(`codex adapter: ignoring ${String(event.type)} for another turn ${event.turnId}`)
      return
    }
    const reasonText =
      event.type === 'error'
        ? `codex error: ${typeof event.message === 'string' && event.message ? event.message : 'unknown error'}`
        : `codex turn ${typeof event.status === 'string' ? event.status : 'completed'} before this activity finished`
    const turnItems = Array.isArray(event?.raw?.turn?.items) ? event.raw.turn.items : []
    for (const pending of state.pendings.values()) {
      if (pending.settled) continue
      if (typeof event.threadId === 'string' && pending.threadId && event.threadId !== pending.threadId) continue
      if (typeof event.turnId === 'string' && pending.turnId && event.turnId !== pending.turnId) continue
      // turn/completed carries the final Turn items: prefer the real item over a
      // forced error so a missed item/completed notification still yields the
      // actual command output / diff.
      const matched = typeof pending.itemId === 'string'
        ? turnItems.find((item) => item && typeof item === 'object' && item.id === pending.itemId)
        : undefined
      if (matched) {
        logger.debug(`codex adapter: settling ${pending.kind} activity ${pending.itemId} from turn items`)
        finalizePending(pending, matched)
        continue
      }
      logger.warn(
        `codex adapter: ${pending.kind} activity ${String(pending.itemId)} did not finish before ${String(event.type)} (thread=${String(event.threadId)} turn=${String(event.turnId)})`,
      )
      finalizePending(pending, pending.item, {
        forcedResult: { kind: pending.kind, text: `codex activity did not complete: ${reasonText}`, isError: true },
      })
    }
  }

  function prunePendings(state) {
    if (state.pendings.size <= MAX_RETAINED_PENDINGS) return
    for (const [callId, pending] of state.pendings) {
      if (state.pendings.size <= MAX_RETAINED_PENDINGS) break
      if (!pending.settled) continue
      state.pendings.delete(callId)
      allPendings.delete(callId)
      if (state.pendingByItemId.get(pending.itemId) === pending) state.pendingByItemId.delete(pending.itemId)
    }
  }

  /**
   * Adapter-exported result accessor used by `src/bridge/tool.js`.
   *
   * Waits for the Codex item that backs a synthetic `codex_activity` call and
   * returns its recorded outcome. Rejects on abort; resolves with error text
   * when the call id is unknown (never re-runs the command).
   *
   * @param {string} callId - id carried by the synthetic tool-call arguments.
   * @param {AbortSignal} [signal] - tool execution cancellation.
   * @returns {Promise<{kind: string, text: string, isError: boolean}>}
   */
  async function takeResult(callId, signal) {
    if (typeof callId !== 'string' || callId.length === 0) {
      return { kind: 'unknown', text: 'codex_activity: missing callId', isError: true }
    }
    const pending = allPendings.get(callId)
    if (!pending) {
      return { kind: 'missing', text: `codex_activity: no recorded activity for call ${callId}`, isError: true }
    }
    if (pending.settled) return settledPendingResult(pending)
    if (signal?.aborted) throw makeAbortError('codex_activity: aborted before the activity result was available')

    return await new Promise((resolve, reject) => {
      let done = false
      const finish = (fn, value) => {
        if (done) return
        done = true
        if (signal) signal.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => {
        const index = pending.waiters.indexOf(waiter)
        if (index >= 0) pending.waiters.splice(index, 1)
        finish(reject, makeAbortError('codex_activity: aborted while waiting for the codex activity result'))
        // The bridge tool is dispatched after the adapter's stream returned, so
        // the stream cannot observe this abort. If the tool call is cancelled
        // while the Codex turn is still open (the user pressed Stop), interrupt
        // the Codex turn here; otherwise Codex keeps running unattended and the
        // next user turn would race an in-flight turn.
        const state = sessions.get(pending.sessionId)
        const turn = state?.activeTurn
        if (turn && (!pending.turnId || turn.turnId === pending.turnId)) void emitTurnInterrupt(turn)
      }
      const waiter = {
        resolve: (result) => finish(resolve, result),
        reject: (error) => finish(reject, error),
      }
      pending.waiters.push(waiter)
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  function settledPendingResult(pending) {
    if (pending.result) return pending.result
    return {
      kind: pending.kind ?? 'unknown',
      text: pending.failureText ?? 'codex_activity: activity did not complete',
      isError: true,
    }
  }

  // ---------------------------------------------------------------------------
  // Turn lifecycle
  // ---------------------------------------------------------------------------

  function cleanupTurn(state, { rejectPendings = false, failureText = 'turn ended' } = {}) {
    state.activeTurn = undefined
    state.channel.clear()
    for (const pending of state.pendings.values()) {
      if (pending.settled) continue
      if (rejectPendings) {
        rejectPending(pending, makeAbortError('codex_activity: codex turn was aborted'))
      } else {
        finalizePending(pending, pending.item, {
          forcedResult: { kind: pending.kind, text: `codex activity did not complete: ${failureText}`, isError: true },
        })
      }
    }
    state.pendingByItemId.clear()
  }

  function buildAbortedChunks(state, emitter, message, code) {
    const turn = state.activeTurn
    const finish = emitter.finish({ kind: 'aborted', failure: { message, code } })
    const close = emitter.close()
    cleanupTurn(state, { rejectPendings: true, failureText: message })
    return { interrupt: turn && !turn.interrupted ? turn : undefined, chunks: [...close, ...finish] }
  }

  function buildCompletedChunks(state, emitter, event) {
    const chunks = []
    chunks.push(...emitter.close())
    applyContextWindow(event?.usage)
    const usage = normalizeUsage(event?.usage)
    if (usage) chunks.push(...emitter.usage(usage))
    const interrupted = event?.status === 'interrupted'
    const failed = !interrupted && event?.status !== 'completed' && event?.status !== undefined
    cleanupTurn(state, { failureText: interrupted ? 'codex turn interrupted' : `codex turn ${String(event?.status ?? 'completed')}` })
    if (failed) {
      // A failed turn must stay visible: Codex may only report it through
      // turn/completed, not through an `error` notification.
      const turnError = event?.raw?.turn?.error
      const failure = {
        message:
          turnError && typeof turnError === 'object' && typeof turnError.message === 'string' && turnError.message
            ? turnError.message
            : `codex turn ${String(event.status)} ended`,
        code:
          turnError && typeof turnError === 'object' && typeof turnError.code === 'string' && turnError.code
            ? turnError.code
            : 'CODEX_TURN_FAILED',
      }
      logger.error(`codex adapter: codex turn ${String(event?.status)} ended without an error event: ${failure.message}`)
      chunks.push({ type: 'finish', reason: { kind: 'error', failure } })
      return chunks
    }
    chunks.push(
      interrupted
        ? { type: 'finish', reason: { kind: 'aborted', failure: { message: 'codex turn interrupted', code: 'TURN_INTERRUPTED' } } }
        : { type: 'finish', reason: { kind: 'stop' } },
    )
    return chunks
  }

  function buildErrorChunks(state, emitter, event) {
    const failure = {
      message: typeof event?.message === 'string' && event.message ? event.message : 'codex error',
      code: typeof event?.code === 'string' && event.code ? event.code : 'CODEX_ERROR',
    }
    const chunks = [...emitter.close(), { type: 'finish', reason: { kind: 'error', failure } }]
    cleanupTurn(state, { failureText: failure.message })
    return chunks
  }

  async function emitTurnInterrupt(turn) {
    if (!turn || turn.interrupted) return
    turn.interrupted = true
    try {
      await runtime.turnInterrupt({ threadId: turn.threadId, turnId: turn.codexTurnId })
    } catch (error) {
      logger.warn(`codex adapter: turnInterrupt failed for ${turn.codexTurnId}`, error)
    }
  }

  async function startCodexTurn(sessionId, state, lastUser, options, signal) {
    // A new Codex turn starts from a clean slate: anything still buffered was
    // produced by the previous turn that ended (or was abandoned) already.
    state.channel.clear()
    if (disposed) throw new Error('codex adapter: disposed')

    if (typeof runtime.ensureStarted === 'function') {
      const ensured = await raceAbort(Promise.resolve().then(() => runtime.ensureStarted()), signal)
      if (ensured.aborted) return { aborted: true }
      if (ensured.error) throw ensured.error
    }

    const cwd = resolveCwd(sessionId)
    const { sandbox, approvalPolicy } = resolvePermissions(sessionId)
    const existingThreadId = safeModeCall(() => sessionMode.getThread?.(sessionId), 'getThread')
    let threadId

    if (typeof existingThreadId === 'string' && existingThreadId.length > 0) {
      associateThread(existingThreadId, sessionId)
      const resumed = await raceAbort(
        Promise.resolve().then(() => runtime.threadResume({ threadId: existingThreadId, cwd, sandbox, approvalPolicy, model })),
        signal,
      )
      if (resumed.aborted) return { aborted: true }
      if (resumed.error) {
        logger.warn(`codex adapter: thread resume failed for ${existingThreadId}; creating a new thread`, resumed.error)
        threadToSession.delete(existingThreadId)
        const created = await createCodexThread(sessionId, options?.messages, cwd, sandbox, approvalPolicy, signal)
        if (created.aborted) return { aborted: true }
        threadId = created.threadId
      } else {
        threadId =
          typeof resumed.value?.threadId === 'string' && resumed.value.threadId.length > 0 ? resumed.value.threadId : existingThreadId
        safeModeCall(() => sessionMode.setThread?.(sessionId, threadId), 'setThread')
      }
    } else {
      const created = await createCodexThread(sessionId, options?.messages, cwd, sandbox, approvalPolicy, signal)
      if (created.aborted) return { aborted: true }
      threadId = created.threadId
    }
    associateThread(threadId, sessionId)

    const materialized = await raceAbort(Promise.resolve().then(() => resolveInput(sessionId, lastUser)), signal)
    if (materialized.aborted) return { aborted: true }
    if (materialized.error) throw materialized.error

    logger.debug(
      `codex adapter: turn/start for ${sessionId} (effort=${String(resolveEffortForLog(options?.reasoningEffort)) || '(default)'}, model=${model})`,
    )
    const started = await raceAbort(
      Promise.resolve().then(() =>
        runtime.turnStart({
          threadId,
          input: materialized.value,
          cwd,
          sandbox,
          approvalPolicy,
          model,
          effort: resolveEffortForLog(options?.reasoningEffort),
          ...(reasoningSummary ? { summary: reasoningSummary } : {}),
        }),
      ),
      signal,
    )
    if (started.aborted) return { aborted: true }
    if (started.error) throw started.error
    const turnId = started.value?.turnId
    if (typeof turnId !== 'string' || turnId.length === 0) throw new Error('codex adapter: runtime.turnStart() returned no turnId')

    state.consumedUserMessageId = lastUser.id
    state.bridgeCallsThisTurn = 0
    state.activeTurn = { threadId, turnId, codexTurnId: turnId, turnDone: false, interrupted: false }
    state.pendingByItemId.clear()
    return { aborted: false }
  }

  async function createCodexThread(sessionId, messages, cwd, sandbox, approvalPolicy, signal) {
    const developerInstructions = buildBootstrap({
      messages,
      cwd,
      sandbox,
      approvalPolicy,
      limitChars: bootstrapLimitChars,
      model,
    })
    const created = await raceAbort(
      Promise.resolve().then(() => runtime.threadStart({ cwd, developerInstructions, sandbox, approvalPolicy, model })),
      signal,
    )
    if (created.aborted) return { aborted: true }
    if (created.error) throw created.error
    const threadId = created.value?.threadId
    if (typeof threadId !== 'string' || threadId.length === 0) throw new Error('codex adapter: runtime.threadStart() returned no threadId')
    associateThread(threadId, sessionId)
    safeModeCall(() => sessionMode.setThread?.(sessionId, threadId), 'setThread')
    return { threadId }
  }

  function resolveCwd(sessionId) {
    const fromMode = safeModeCall(() => sessionMode.getCwd?.(sessionId), 'getCwd')
    if (typeof fromMode === 'string' && fromMode.trim()) return fromMode.trim()
    if (defaultCwd) return defaultCwd
    return process.cwd()
  }

  /**
   * Call one optional `mode.*` accessor. The mode controller surface is
   * optional from the adapter's point of view (tests and early integration
   * passes provide partial fakes); a throwing accessor must degrade to the
   * conservative fallback instead of aborting the whole step.
   */
  function safeModeCall(fn, label) {
    try {
      return fn()
    } catch (error) {
      logger.warn(`codex adapter: mode.${label} failed`, error)
      return undefined
    }
  }

  function resolvePermissions(sessionId) {
    const fromMode = safeModeCall(() => sessionMode.getSandboxApproval?.(sessionId), 'getSandboxApproval')
    const sandbox = typeof fromMode?.sandbox === 'string' && fromMode.sandbox ? fromMode.sandbox : undefined
    // The contract names the field `approvalPolicy`; the mode controller in this
    // repository exposes it as `approval`. Accept both so the DSH permission
    // preset (ADR-0004) is never silently downgraded to the fallback.
    const rawApproval = fromMode?.approvalPolicy ?? fromMode?.approval
    const approvalPolicy = typeof rawApproval === 'string' && rawApproval ? rawApproval : undefined
    if ((!sandbox || !approvalPolicy) && !permissionsWarned) {
      permissionsWarned = true
      logger.warn('codex adapter: mode.getSandboxApproval() returned no sandbox/approval; falling back to read-only/never')
    }
    return {
      sandbox: sandbox ?? FALLBACK_PERMISSIONS.sandbox,
      approvalPolicy: approvalPolicy ?? FALLBACK_PERMISSIONS.approvalPolicy,
    }
  }

  async function resolveInput(sessionId, lastUser) {
    let materialized
    if (typeof sessionMode.materializeInput === 'function') {
      materialized = await sessionMode.materializeInput(sessionId, lastUser)
    } else {
      materialized = { text: extractUserMessageText(lastUser), images: [] }
    }
    const fallbackText = extractUserMessageText(lastUser)
    const text = typeof materialized?.text === 'string' && materialized.text.length > 0 ? materialized.text : fallbackText
    const input = []
    const images = Array.isArray(materialized?.images) ? materialized.images : []
    for (const image of images) {
      if (typeof image === 'string' && image.length > 0) input.push({ type: 'localImage', path: image })
    }
    if (text.trim().length > 0) input.unshift({ type: 'text', text })
    if (input.length === 0) input.push({ type: 'text', text: '(empty message)' })
    return input
  }

  // ---------------------------------------------------------------------------
  // stream()
  // ---------------------------------------------------------------------------

  async function* stream(options) {
    if (options?.purpose !== undefined) {
      // Auxiliary calls (compaction / session-title) never become Codex turns:
      // they are delegated to the DSH route without touching any codex state.
      // `fallbackStream` may return an async iterable directly or a promise for
      // one (the controller forwards `llm.stream(...)`, which is iterable).
      if (typeof fallbackStream !== 'function') throw new Error(AUXILIARY_CALLS_ERROR)
      const fallback = await fallbackStream(options)
      if (fallback) yield* fallback
      return
    }

    const sessionId = options?.sessionId
    if (!sessionId) throw new Error('codex adapter: options.sessionId is required')
    if (disposed) throw new Error('codex adapter: disposed')

    const signal = options?.signal
    const messages = Array.isArray(options?.messages) ? options.messages : []
    const lastUser = findLastUserMessage(messages)
    const state = getSessionState(sessionId)
    const isNewTurn = lastUser !== undefined && lastUser.id !== state.consumedUserMessageId

    if (!isNewTurn && !state.activeTurn) {
      // Nothing to forward and no Codex turn to continue (e.g. a context-only
      // step after a turn already ended): finish the step without content.
      logger.debug(`codex adapter: no active codex turn for session ${sessionId}; finishing empty step`)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    activeStreams.add(sessionId)
    const emitter = createEmitter()
    try {
      if (isNewTurn) {
        if (signal?.aborted) {
          yield* buildAbortedChunks(state, emitter, 'cancelled', 'ABORTED').chunks
          return
        }
        const started = await startCodexTurn(sessionId, state, lastUser, options, signal)
        if (started.aborted) {
          yield* buildAbortedChunks(state, emitter, 'cancelled', 'ABORTED').chunks
          return
        }
        if (signal?.aborted) {
          const aborted = buildAbortedChunks(state, emitter, 'cancelled', 'ABORTED')
          await emitTurnInterrupt(aborted.interrupt)
          yield* aborted.chunks
          return
        }
      } else if (state.activeTurn) {
        associateThread(state.activeTurn.threadId, sessionId)
      }

      const turn = state.activeTurn
      if (!turn) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      while (true) {
        if (signal?.aborted) {
          const aborted = buildAbortedChunks(state, emitter, 'cancelled', 'ABORTED')
          await emitTurnInterrupt(aborted.interrupt)
          yield* aborted.chunks
          return
        }

        const next = await state.channel.next(signal)
        if (next.kind === 'aborted') {
          const aborted = buildAbortedChunks(state, emitter, 'cancelled', 'ABORTED')
          await emitTurnInterrupt(aborted.interrupt)
          yield* aborted.chunks
          return
        }
        if (next.kind === 'closed') {
          const chunks = [...emitter.close(), { type: 'finish', reason: { kind: 'error', failure: { message: 'codex adapter disposed', code: 'ADAPTER_DISPOSED' } } }]
          yield* chunks
          return
        }

        const event = next.event
        if (!eventBelongsToTurn(turn, event)) {
          logger.debug(
            `codex adapter: dropping stale event ${String(event?.type)} (thread ${String(event?.threadId)}, turn ${String(event?.turnId)}; active ${turn.threadId}/${turn.turnId})`,
          )
          continue
        }

        switch (event.type) {
          case 'turn_started': {
            logger.debug(`codex adapter: codex turn started ${String(event.turnId)}`)
            continue
          }
          case 'agent_message_delta': {
            const delta = typeof event.delta === 'string' ? event.delta : ''
            if (delta.length === 0) continue
            yield* emitter.text(delta)
            continue
          }
          case 'reasoning_delta': {
            const delta = typeof event.delta === 'string' ? event.delta : ''
            if (delta.length === 0) continue
            yield* emitter.reasoning(delta)
            continue
          }
          case 'item_started': {
            if (!isBridgeableItem(event.item)) {
              logger.debug(`codex adapter: ignoring item_started type ${String(event.item?.type)}`)
              continue
            }
            const pending = ensurePendingForItem(state, event)
            if (!pending || pending.emitted) continue
            if (state.bridgeCallsThisTurn >= maxBridgeCallsPerTurn) {
              const failure = {
                message: `codex produced more than ${maxBridgeCallsPerTurn} actions in one turn (action budget exceeded)`,
                code: 'CODEX_ACTION_BUDGET',
              }
              logger.warn(`codex adapter: ${failure.message}`)
              cleanupTurn(state, { failureText: failure.message })
              yield* emitter.close()
              yield { type: 'finish', reason: { kind: 'error', failure } }
              return
            }
            state.bridgeCallsThisTurn += 1
            pending.emitted = true
            if (pending.settled) {
              logger.debug(`codex adapter: emitting tool call for already-settled activity ${pending.itemId}`)
            }
            yield* emitter.toolCall(pending.callId, pending.args)
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          case 'item_completed': {
            const pending = pendingForItemId(state, event.item?.id)
            if (pending && !pending.settled && !appliedToPending.has(event)) finalizePending(pending, event.item)
            continue
          }
          case 'command_output_delta':
          case 'file_change_output_delta': {
            const pending = pendingForItemId(state, event.itemId)
            if (pending && !pending.settled && !appliedToPending.has(event)) appendPendingOutput(pending, event.delta)
            continue
          }
          case 'turn_completed': {
            yield* buildCompletedChunks(state, emitter, event)
            return
          }
          case 'error': {
            yield* buildErrorChunks(state, emitter, event)
            return
          }
          case 'token_usage_updated': {
            applyContextWindow(event?.usage)
            logger.debug('codex adapter: applied token usage / context window update')
            continue
          }
          case 'plan_updated':
          case 'warning':
          case 'raw': {
            logger.debug(`codex adapter: ignoring ${String(event.type)} event`)
            continue
          }
          default: {
            logger.debug(`codex adapter: ignoring unknown event type ${String(event?.type)}`)
            continue
          }
        }
      }
    } finally {
      activeStreams.delete(sessionId)
    }
  }

  // ---------------------------------------------------------------------------
  // Adapter surface
  // ---------------------------------------------------------------------------

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: PROVIDER_DISPLAY_NAME }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    imageRequestTarget(_provider, _model, image) {
      return {
        width: typeof image?.width === 'number' ? image.width : 0,
        height: typeof image?.height === 'number' ? image.height : 0,
        maxBytes: typeof image?.bytes === 'number' ? image.bytes : 0,
      }
    },
    async listModels(provider) {
      return [{ provider, id: model, name: `Codex · ${model}` }]
    },
    async resolveModel(provider, requestedModel) {
      const id = typeof requestedModel === 'string' && requestedModel.length > 0 ? requestedModel : model
      return {
        provider,
        id,
        name: id,
        context: { contextWindow },
        inputModalities: ['text', 'image'],
        toolUpdate: 'in-history',
        reasoning: {
          efforts: reasoningEfforts,
          ...(defaultReasoningEffort ? { defaultEffort: defaultReasoningEffort } : {}),
        },
      }
    },
    async prepareCall(provider, requestedModel) {
      const resolved = await adapter.resolveModel(provider, requestedModel)
      return { model: resolved, stream: (streamOptions) => adapter.stream(streamOptions) }
    },
    stream,
    takeResult,
    dispose,
  }
  return adapter

  // ---------------------------------------------------------------------------
  // dispose()
  // ---------------------------------------------------------------------------

  function dispose() {
    if (disposed) return
    disposed = true
    if (disposeEvents) {
      try {
        disposeEvents()
      } catch (error) {
        logger.warn('codex adapter: event subscription dispose failed', error)
      }
      disposeEvents = undefined
    }
    for (const state of sessions.values()) {
      const error = makeAbortError('codex adapter disposed')
      for (const pending of state.pendings.values()) rejectPending(pending, error)
      state.pendings.clear()
      state.pendingByItemId.clear()
      state.channel.close()
    }
    sessions.clear()
    allPendings.clear()
    threadToSession.clear()
    activeStreams.clear()
    if (injectedTakeResult !== undefined && typeof injectedTakeResult !== 'function') {
      logger.debug('codex adapter: ignoring non-function injected takeResult')
    }
  }
}

// -----------------------------------------------------------------------------
// Event channel: one per session, filled by the runtime subscription.
// -----------------------------------------------------------------------------

class EventChannel {
  #items = []
  #waiters = new Set()
  #closed = false

  push(event) {
    if (this.#closed) return
    const waiter = firstValue(this.#waiters)
    if (waiter) {
      this.#waiters.delete(waiter)
      waiter({ kind: 'event', event })
      return
    }
    if (this.#items.length >= MAX_QUEUE_EVENTS) this.#items.shift()
    this.#items.push(event)
  }

  next(signal) {
    if (this.#items.length > 0) return Promise.resolve({ kind: 'event', event: this.#items.shift() })
    if (this.#closed) return Promise.resolve({ kind: 'closed' })
    if (signal?.aborted) return Promise.resolve({ kind: 'aborted' })

    return new Promise((resolve) => {
      const onAbort = () => {
        cleanup()
        resolve({ kind: 'aborted' })
      }
      const cleanup = () => {
        this.#waiters.delete(onEvent)
        signal?.removeEventListener('abort', onAbort)
      }
      const onEvent = (event) => {
        cleanup()
        resolve(event)
      }
      this.#waiters.add(onEvent)
      signal?.addEventListener('abort', onAbort, { once: true })
    }).then((result) => result)
  }

  clear() {
    this.#items.length = 0
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter)
      waiter({ kind: 'closed' })
    }
  }
}

function firstValue(set) {
  for (const value of set) return value
  return undefined
}

// -----------------------------------------------------------------------------
// Chunk emitter: one per stream() call, owns the block index / open block.
// -----------------------------------------------------------------------------

function createEmitter() {
  let current = null
  let nextIndex = 0
  let usageEmitted = false

  const emitter = {
    ensure(type) {
      if (current && current.type === type) return []
      const chunks = emitter.close()
      current = { index: nextIndex, type, text: '' }
      nextIndex += 1
      chunks.push({ type: 'block-start', index: current.index, blockType: type })
      return chunks
    },
    text(delta) {
      const chunks = emitter.ensure('text')
      current.text += delta
      chunks.push({ type: 'text-delta', index: current.index, text: delta })
      return chunks
    },
    reasoning(delta) {
      const chunks = emitter.ensure('reasoning')
      current.text += delta
      chunks.push({ type: 'reasoning-delta', index: current.index, text: delta })
      return chunks
    },
    close() {
      if (!current) return []
      const block =
        current.type === 'text' ? { type: 'text', text: current.text } : { type: 'reasoning', text: current.text }
      const chunk = { type: 'block-end', index: current.index, block }
      current = null
      return [chunk]
    },
    toolCall(callId, args) {
      const chunks = emitter.close()
      const index = nextIndex
      nextIndex += 1
      const argumentsJson = JSON.stringify(args)
      chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
      chunks.push({ type: 'tool-call-delta', index, id: callId, name: BRIDGE_TOOL_NAME, argumentsDelta: argumentsJson })
      chunks.push({
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: callId, name: BRIDGE_TOOL_NAME, arguments: argumentsJson },
      })
      return chunks
    },
    usage(usage) {
      if (!usage || usageEmitted) return []
      usageEmitted = true
      return [{ type: 'usage', usage }]
    },
    finish(reason) {
      return [{ type: 'finish', reason }]
    },
  }
  return emitter
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function normalizeLogger(log) {
  const noop = () => {}
  const source = log && typeof log === 'object' ? log : {}
  const pick = (name) =>
    typeof source[name] === 'function'
      ? (...args) => {
          try {
            source[name](...args)
          } catch {
            /* logging must never break the adapter */
          }
        }
      : noop
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') }
}

function positiveInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const int = Math.floor(value)
  return int > 0 ? int : undefined
}

function makeAbortError(message) {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/** Find the last durable user message (contract §3.2 turn identification). */
function findLastUserMessage(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
    if (message.id === undefined || message.id === null) continue
    return message
  }
  return undefined
}

function eventBelongsToTurn(turn, event) {
  if (!event || typeof event !== 'object') return false
  if (typeof event.threadId === 'string' && event.threadId !== turn.threadId) return false
  if (typeof event.turnId === 'string' && event.turnId !== turn.turnId) return false
  return true
}

function isBridgeableItem(item) {
  return Boolean(item && typeof item === 'object' && BRIDGE_ITEM_TYPES.has(item.type))
}

function bridgeKind(itemType) {
  switch (itemType) {
    case 'commandExecution':
      return 'command'
    case 'fileChange':
      return 'file-change'
    case 'mcpToolCall':
      return 'mcp-tool'
    case 'webSearch':
      return 'web-search'
    default:
      return undefined
  }
}

function bridgeTitle(item, kind) {
  switch (kind) {
    case 'command': {
      const command = typeof item.command === 'string' ? item.command : ''
      return shorten(command.replace(/\s+/g, ' ').trim() || 'command execution', 300)
    }
    case 'file-change': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes
        .map((change) => (typeof change?.path === 'string' && change.path ? change.path : '?'))
        .filter(Boolean)
      if (paths.length === 0) return 'file change'
      const shown = paths.slice(0, 5).join(', ')
      const more = paths.length > 5 ? ` (+${paths.length - 5} more)` : ''
      return shorten(`${paths.length} file${paths.length === 1 ? '' : 's'}: ${shown}${more}`, 300)
    }
    case 'mcp-tool': {
      const server = typeof item.server === 'string' && item.server ? item.server : 'mcp'
      const tool = typeof item.tool === 'string' && item.tool ? item.tool : 'tool'
      return shorten(`${server}/${tool}`, 300)
    }
    case 'web-search': {
      const query = typeof item.query === 'string' && item.query.trim() ? item.query.trim() : 'web search'
      return shorten(query, 300)
    }
    default:
      return kind
  }
}

function buildPendingResult(pending) {
  const item = pending.item && typeof pending.item === 'object' ? pending.item : {}
  switch (pending.kind) {
    case 'command': {
      const aggregated = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
      const output = aggregated.trim().length > 0 ? aggregated : pending.output
      const exitCode = typeof item.exitCode === 'number' && Number.isFinite(item.exitCode) ? item.exitCode : undefined
      const isError = item.status === 'failed' || item.status === 'declined' || (exitCode !== undefined && exitCode !== 0)
      let text = output.length > 0 ? output : '(no output)'
      if (exitCode !== undefined) text = `${text.replace(/\s+$/, '')}\n[exit code: ${exitCode}]`
      if (pending.outputTruncated && aggregated.trim().length === 0) text = `${text}\n[output truncated by dsh-codex-mode]`
      return { kind: 'command', text: capText(text), isError }
    }
    case 'file-change': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const parts = changes.map((change) => {
        const path = typeof change?.path === 'string' ? change.path : '?'
        const changeKind = typeof change?.kind === 'string' ? change.kind : 'update'
        const diff = typeof change?.diff === 'string' ? change.diff : ''
        return diff.length > 0 ? `${changeKind}: ${path}\n${diff}` : `${changeKind}: ${path}`
      })
      const text = parts.length > 0 ? parts.join('\n\n') : '(no file changes)'
      const isError = item.status === 'failed' || item.status === 'declined'
      return { kind: 'file-change', text: capText(text), isError }
    }
    case 'mcp-tool': {
      const errorMessage =
        item.error && typeof item.error === 'object' && typeof item.error.message === 'string' ? item.error.message : undefined
      if (errorMessage) return { kind: 'mcp-tool', text: capText(errorMessage), isError: true }
      const text = flattenMcpResult(item.result)
      const isError = item.status === 'failed'
      return { kind: 'mcp-tool', text: capText(text.length > 0 ? text : '(no output)'), isError }
    }
    case 'web-search': {
      const query = typeof item.query === 'string' && item.query.trim() ? item.query.trim() : 'web search'
      const results = Array.isArray(item.results) ? item.results : []
      const lines = [query]
      if (results.length > 0) lines.push(`[${results.length} result${results.length === 1 ? '' : 's'} recorded by Codex]`)
      return { kind: 'web-search', text: capText(lines.join('\n')), isError: false }
    }
    default:
      return { kind: pending.kind, text: capText(safeStringify(item)), isError: false }
  }
}

function flattenMcpResult(result) {
  if (!result || typeof result !== 'object') return safeStringify(result)
  const content = Array.isArray(result.content) ? result.content : []
  const parts = []
  for (const entry of content) {
    if (entry && typeof entry === 'object' && typeof entry.text === 'string') parts.push(entry.text)
    else parts.push(safeStringify(entry))
  }
  if (parts.length === 0 && result.structuredContent !== undefined && result.structuredContent !== null) {
    parts.push(safeStringify(result.structuredContent))
  }
  return parts.join('\n')
}

function safeStringify(value) {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : String(value)
  } catch {
    return String(value)
  }
}

function shorten(text, maxLength) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function capText(text) {
  if (typeof text !== 'string') return ''
  if (text.length <= MAX_PENDING_OUTPUT_CHARS) return text
  const headLength = Math.floor(MAX_PENDING_OUTPUT_CHARS * 0.75)
  const tailLength = MAX_PENDING_OUTPUT_CHARS - headLength
  const omitted = text.length - MAX_PENDING_OUTPUT_CHARS
  return `${text.slice(0, headLength)}\n… [${omitted} chars omitted] …\n${text.slice(-tailLength)}`
}

// -----------------------------------------------------------------------------
// Signal racing & usage normalization
// -----------------------------------------------------------------------------

/** Race an async operation against an AbortSignal without leaking rejections. */
function raceAbort(promise, signal) {
  if (!signal) {
    return Promise.resolve(promise).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
  }
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {})
    return Promise.resolve({ aborted: true })
  }
  return new Promise((resolve) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      resolve({ aborted: true })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        cleanup()
        resolve({ value })
      },
      (error) => {
        cleanup()
        resolve({ error })
      },
    )
  })
}

/**
 * Translate a runtime usage payload into DSH `TokenUsage`.
 *
 * Tolerates the shapes the Codex runtime may forward: DSH-shaped token usage,
 * app-server `TokenUsageBreakdown` (camelCase), a `{total,last}` wrapper, and
 * snake_case variants. Counts are made disjoint: cached input is reported via
 * `cacheReadTokens`/`cacheWriteTokens` and subtracted from `inputTokens`.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (raw.last && typeof raw.last === 'object') return normalizeUsage(raw.last)
  if (raw.total && typeof raw.total === 'object') return normalizeUsage(raw.total)
  if (hasCodexBreakdownKeys(raw)) return normalizeUsageBreakdown(raw)
  const input = numberOrUndefined(raw.inputTokens)
  const output = numberOrUndefined(raw.outputTokens)
  if (input === undefined && output === undefined) return undefined
  const usage = { inputTokens: Math.max(0, input ?? 0), outputTokens: Math.max(0, output ?? 0) }
  const total = numberOrUndefined(raw.totalTokens)
  if (total !== undefined) usage.totalTokens = total
  const cacheRead = numberOrUndefined(raw.cacheReadTokens)
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  const cacheWrite = numberOrUndefined(raw.cacheWriteTokens)
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
  const reasoning = numberOrUndefined(raw.reasoningTokens)
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  return usage
}

function hasCodexBreakdownKeys(usage) {
  return (
    numberOrUndefined(usage.cachedInputTokens) !== undefined ||
    numberOrUndefined(usage.cacheWriteInputTokens) !== undefined ||
    numberOrUndefined(usage.reasoningOutputTokens) !== undefined ||
    numberOrUndefined(usage.cached_input_tokens) !== undefined ||
    numberOrUndefined(usage.reasoning_output_tokens) !== undefined
  )
}

function normalizeUsageBreakdown(usage) {
  const input = numberOrUndefined(usage.inputTokens) ?? numberOrUndefined(usage.input_tokens)
  const output = numberOrUndefined(usage.outputTokens) ?? numberOrUndefined(usage.output_tokens)
  if (input === undefined && output === undefined) return undefined
  const cached = numberOrUndefined(usage.cachedInputTokens) ?? numberOrUndefined(usage.cached_input_tokens) ?? 0
  const cacheWrite = numberOrUndefined(usage.cacheWriteInputTokens) ?? numberOrUndefined(usage.cache_write_input_tokens) ?? 0
  const reasoning = numberOrUndefined(usage.reasoningOutputTokens) ?? numberOrUndefined(usage.reasoning_output_tokens)
  const total = numberOrUndefined(usage.totalTokens) ?? numberOrUndefined(usage.total_tokens)
  const result = {
    inputTokens: Math.max(0, (input ?? 0) - cached - cacheWrite),
    outputTokens: Math.max(0, output ?? 0),
  }
  if (total !== undefined) result.totalTokens = total
  if (cached > 0) result.cacheReadTokens = cached
  if (cacheWrite > 0) result.cacheWriteTokens = cacheWrite
  if (reasoning !== undefined) result.reasoningTokens = reasoning
  return result
}

function numberOrUndefined(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}


// ---------------------------------------------------------------------------
// Reasoning effort helpers
// ---------------------------------------------------------------------------

const REASONING_EFFORT_ALIASES = Object.freeze({
  max: 'xhigh',
  maximum: 'xhigh',
  'extra-high': 'xhigh',
  extrahigh: 'xhigh',
  min: 'minimal',
  minimum: 'minimal',
  xhigh: 'xhigh',
})

const DEFAULT_REASONING_EFFORTS = Object.freeze([
  { id: 'minimal', name: 'Minimal' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Extra High' },
])

function normalizeReasoningEffort(value) {
  if (typeof value !== 'string') return undefined
  const key = value.trim().toLowerCase()
  if (!key) return undefined
  const canonical = REASONING_EFFORT_ALIASES[key] ?? key
  const known = DEFAULT_REASONING_EFFORTS.some((effort) => effort.id === canonical)
  return known ? canonical : undefined
}

function normalizeReasoningEfforts(value) {
  if (!Array.isArray(value)) return DEFAULT_REASONING_EFFORTS
  const ids = []
  for (const entry of value) {
    const id = normalizeReasoningEffort(typeof entry === 'string' ? entry : entry?.id)
    if (id && !ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) return DEFAULT_REASONING_EFFORTS
  return ids.map((id) => DEFAULT_REASONING_EFFORTS.find((effort) => effort.id === id))
}

function normalizeReasoningSummary(value) {
  if (typeof value !== 'string') return undefined
  const key = value.trim().toLowerCase()
  return key === 'auto' || key === 'concise' || key === 'detailed' || key === 'none' ? key : undefined
}
