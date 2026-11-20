// Mode controller: owns per-session Codex Mode state, activation/deactivation,
// model routing, trigger/command handling, bridge-tool registration, permission
// mapping and input materialization.
//
// Wiring: index.js constructs the controller, then calls attach({ runtime,
// adapter, bridgeTool }) before init(). The controller is also the `mode` object
// handed to the adapter (isEnabled/getThread/setThread/getCwd/... ).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ModeStore } from './state.js'
import { parseTrigger, DEFAULT_ON_PHRASES, DEFAULT_OFF_PHRASES } from './trigger.js'
import { latestDurableUserMessage, joinText, textOf } from '../shared/messages.js'

const PROVIDER_INFO = { name: 'Codex (local)' }

function nowIso() {
  return new Date().toISOString()
}

export class ModeController {
  constructor({ ctx, log, config }) {
    this.ctx = ctx
    this.log = log
    this.config = config
    this.provider = config.providerName || 'codex'
    this.model = config.model
    this.store = new ModeStore({ ctx, log })
    this.runtime = undefined
    this.adapter = undefined
    this.bridgeTool = undefined

    /** @type {Map<string, () => void>} sessionId -> bridge tool disposer */
    this.bridgeTools = new Map()
    /** @type {Set<string>} sessions with an open turn */
    this.openTurns = new Set()
    /** @type {Set<string>} sessions whose bridge tool disposal waits for turn end */
    this.pendingDispose = new Set()
    /** @type {Set<string>} sessions whose codex thread release waits for turn end */
    this.pendingThreadRelease = new Set()
    /** @type {Map<string, Promise<void>>} in-flight codex thread releases */
    this.releasePromises = new Map()
    /** @type {Map<string, {provider:string, model:string, reasoningEffort?:string}>} */
    this.lastRoute = new Map()
    /** @type {Map<string, {provider:string, model:string, reasoningEffort?:string}>} */
    this.lastSelection = new Map()
    /** @type {Map<string, string>} threadId -> sessionId */
    this.threadOwner = new Map()
    /** @type {{provider:string, model:string, reasoningEffort?:string}|undefined} */
    this.fallbackCache = undefined
    this.disposers = []
    this.commandDispose = undefined
    this._receipt = undefined
    this.disposed = false
  }

  attach({ runtime, adapter, bridgeTool }) {
    this.runtime = runtime
    this.adapter = adapter
    this.bridgeTool = bridgeTool
  }

  async init() {
    await this.store.init()
    this.#listen()
    await this.refreshFallbackRoute()
    this.#registerCommand()
    // Pre-existing live agents (plugin (re)load, HMR): restore tooling for
    // sessions whose persisted mode is on.
    const agents = this.ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) {
      try {
        this.#wireAgent(agent)
      } catch (error) {
        this.log.warn(`[codex-mode] could not wire live agent ${agent?.id}: ${error?.message || error}`)
      }
    }
    this.log.info(
      `[codex-mode] ready: provider=${this.provider} model=${this.model} state=${this.store.backend}`,
    )
  }

  // ---------------------------------------------------------------- routing

  isEnabled(sessionId) {
    const state = this.store.get(sessionId)
    return Boolean(state && state.enabled)
  }

  getThread(sessionId) {
    const state = this.store.get(sessionId)
    if (state?.threadId) {
      this.threadOwner.set(state.threadId, sessionId)
      return state.threadId
    }
    return undefined
  }

  setThread(sessionId, threadId) {
    const state = this.store.get(sessionId) || { enabled: this.isEnabled(sessionId), updatedAt: Date.now() }
    this.threadOwner.set(threadId, sessionId)
    void this.store.set(sessionId, { ...state, threadId, updatedAt: Date.now() })
  }

  getCwd(sessionId) {
    try {
      const session = this.ctx.get('sessions')?.get?.(sessionId)
      if (session) {
        const workingDirectory = this.ctx.get('workingDirectory')
        const fromService = workingDirectory?.get?.(session)
        if (typeof fromService === 'string' && fromService.length > 0) return fromService
        const fromHeader = session.header?.cwd
        if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
      }
    } catch (error) {
      this.log.debug(`[codex-mode] getCwd failed: ${error?.message || error}`)
    }
    const state = this.store.get(sessionId)
    return state?.cwd || this.config.cwd || process.cwd()
  }

  /** DSH permission preset -> codex sandbox/approval knobs. */
  getSandboxApproval(sessionId) {
    const fallback = {
      sandbox: this.config.defaultSandbox || 'danger-full-access',
      approval: this.config.defaultApproval || 'never',
    }
    try {
      const session = this.ctx.get('sessions')?.get?.(sessionId)
      const presets = this.ctx.get('permissionPresets')
      if (!session || !presets) return fallback
      const current = presets.current(session)
      const spec = presets.resolve(current)
      if (!spec) return fallback
      return {
        sandbox: spec.sandbox || fallback.sandbox,
        approval: spec.approval || fallback.approval,
      }
    } catch (error) {
      this.log.debug(`[codex-mode] permission preset mapping failed: ${error?.message || error}`)
      return fallback
    }
  }

  /**
   * Convert the newest durable user message (text + image/file attachments)
   * into codex turn input parts.
   */
  async materializeInput(sessionId, userMessage) {
    const content = Array.isArray(userMessage?.content) ? userMessage.content : []
    const texts = []
    const images = []
    const notes = []
    let attachmentIndex = 0
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      } else if (block.type === 'image' && block.attachment) {
        attachmentIndex += 1
        const materialized = await this.#materializeImage(sessionId, block.attachment, attachmentIndex)
        if (materialized) images.push(materialized)
        else notes.push('[image attachment could not be materialized for Codex]')
      } else if (block.type === 'file' && block.attachment) {
        attachmentIndex += 1
        const materialized = await this.#materializeFile(sessionId, block.attachment, attachmentIndex)
        if (materialized) notes.push(`[file attachment saved at ${materialized}]`)
        else notes.push('[file attachment could not be materialized for Codex]')
      }
    }
    let text = texts.join('\n').trim()
    if (notes.length > 0) {
      text = text.length > 0 ? `${text}\n\n${notes.join('\n')}` : notes.join('\n')
    }
    return { text, images }
  }

  /** Delegate auxiliary model calls (compaction / session title) to a DSH route. */
  fallbackStream(options) {
    const llm = this.ctx.get('llm')
    const route = this.fallbackRoute()
    if (!llm || !route) throw new Error('codex mode: no fallback model route for an auxiliary call')
    return llm.stream({
      ...options,
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
    })
  }

  fallbackRoute() {
    if (this.fallbackCache) return this.fallbackCache
    const fromState = this.ctx.get('agentDefaultModel')?.currentSelection?.()
    if (fromState?.provider && fromState?.model) {
      return {
        provider: fromState.provider,
        model: fromState.model,
        ...(fromState.reasoningEffort ? { reasoningEffort: fromState.reasoningEffort } : {}),
      }
    }
    return { provider: 'deepseek-account', model: 'deepseek-flash' }
  }

  /** Resolve a real DSH route for auxiliary calls from the live registry. */
  async refreshFallbackRoute() {
    try {
      const llm = this.ctx.get('llm')
      if (!llm || typeof llm.listProviders !== 'function') return
      const providers = (llm.listProviders() || []).map((entry) => entry.id).filter((id) => id && id !== this.provider)
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model && providers.includes(selection.provider)) {
        this.fallbackCache = {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        }
        return
      }
      for (const provider of providers) {
        try {
          const models = await llm.listModels(provider)
          if (Array.isArray(models) && models.length > 0 && models[0]?.id) {
            this.fallbackCache = { provider, model: models[0].id }
            return
          }
        } catch {}
      }
    } catch (error) {
      this.log.debug(`[codex-mode] fallback route resolution failed: ${error?.message || error}`)
    }
  }

  /** Approval bridge for codex server requests. */
  async approvalHandler(request) {
    try {
      const sessionId = request?.threadId ? this.threadOwner.get(request.threadId) : undefined
      const agent = sessionId ? this.ctx.get('agents')?.get?.(sessionId) : undefined
      const approval = this.ctx.get('approval')
      if (!agent || !approval) return 'cancel'
      const reason =
        request?.payload?.reason ||
        request?.payload?.command ||
        `Codex requests ${request?.kind || 'tool'} approval`
      const outcome = await approval.request({
        agent,
        toolName: this.config.approvalToolName || 'codex',
        reason: String(reason).slice(0, 500),
      })
      if (outcome === 'allowed-once') return 'accept'
      if (outcome === 'rejected') return 'decline'
      return 'cancel'
    } catch (error) {
      this.log.warn(`[codex-mode] approval bridge failed: ${error?.message || error}`)
      return 'cancel'
    }
  }

  // -------------------------------------------------------------- lifecycle

  async enable(sessionId, signal) {
    // If a previous `/codex off` is still releasing the thread, wait for it so
    // the first resumed turn cannot race the unsubscribe.
    const inFlightRelease = this.releasePromises.get(sessionId)
    if (inFlightRelease) {
      try {
        await inFlightRelease
      } catch {}
    }
    const existing = this.store.get(sessionId)
    const previousRoute =
      existing?.previousRoute || this.lastRoute.get(sessionId) || this.defaultRouteFor(sessionId)
    await this.store.set(sessionId, {
      enabled: true,
      ...(existing?.threadId ? { threadId: existing.threadId } : {}),
      previousRoute,
      updatedAt: Date.now(),
    })
    const agent = this.ctx.get('agents')?.get?.(sessionId)
    if (agent) this.#wireAgent(agent)
    this.log.info(`[codex-mode] session ${sessionId} enabled (model ${this.provider}/${this.model})`)
    const effort = normalizeCodexEffort(this.config.reasoningEffort)
    await this.#selectModel(sessionId, {
      provider: this.provider,
      model: this.model,
      ...(effort ? { reasoningEffort: effort } : {}),
    })
  }

  async disable(sessionId) {
    const state = this.store.get(sessionId)
    if (!state) return
    await this.store.set(sessionId, { ...state, enabled: false, updatedAt: Date.now() })
    this.#scheduleBridgeDispose(sessionId)
    const restore = state.previousRoute || this.fallbackRoute()
    this.log.info(`[codex-mode] session ${sessionId} disabled`)
    await this.#selectModel(sessionId, restore)
    // Release the Codex thread reader/writer lease so a native Codex TUI can
    // re-open the session immediately; the thread itself (and its id) is kept
    // so re-enabling resumes the same context.
    this.#scheduleThreadRelease(sessionId)
  }

  defaultRouteFor(sessionId) {
    const selection = this.lastSelection.get(sessionId)
    if (selection) return selection
    return this.fallbackRoute()
  }

  async #selectModel(sessionId, route) {
    if (!route || !route.provider || !route.model) return
    const controller = this.ctx.get('sessionController')
    if (!controller || typeof controller.selectModel !== 'function') {
      this.log.debug('[codex-mode] no sessionController; skipping model selection switch')
      return
    }
    try {
      await controller.selectModel({
        sessionId,
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      })
    } catch (error) {
      this.log.warn(
        `[codex-mode] could not switch session ${sessionId} model to ${route.provider}/${route.model}: ${error?.message || error}`,
      )
    }
  }

  statusText(sessionId) {
    const state = this.store.get(sessionId)
    if (!state?.enabled) return 'Codex 模式：关闭。用“使用codex模式”或 /codex on 开启。'
    const selectedEffort = this.lastSelection.get(sessionId)?.reasoningEffort
    const effort = normalizeCodexEffort(selectedEffort) ?? normalizeCodexEffort(this.config.reasoningEffort)
    return [
      'Codex 模式：开启',
      `模型：${this.provider}/${this.model}`,
      ...(effort ? [`思考强度：${effort}`] : []),
      `线程：${state.threadId || '(尚未创建)'}`,
      '用 /codex off 关闭。',
    ].join(' · ')
  }

  // ----------------------------------------------------------------- events

  #listen() {
    const ctx = this.ctx
    const on = (name, handler) => {
      const dispose = ctx.on(name, handler)
      if (typeof dispose === 'function') this.disposers.push(dispose)
      else if (dispose && typeof dispose[Symbol.dispose] === 'function') this.disposers.push(() => dispose[Symbol.dispose]())
    }

    on('agent/created', (payload) => {
      try {
        this.#wireAgent(payload.agent)
      } catch (error) {
        this.log.warn(`[codex-mode] agent/created wiring failed: ${error?.message || error}`)
      }
    })

    on('agent/disposed', (payload) => {
      const sessionId = payload?.agent?.id
      if (!sessionId) return
      this.#disposeBridgeTool(sessionId)
      this.openTurns.delete(sessionId)
      this.pendingDispose.delete(sessionId)
      this.pendingThreadRelease.delete(sessionId)
      void this.#releaseThread(sessionId)
      this.threadOwner.delete(this.store.get(sessionId)?.threadId)
    })

    on('session/event', (session, event) => {
      const sessionId = session?.id
      if (!sessionId || !event) return
      if (event.type === 'turn/start') this.openTurns.add(sessionId)
      if (event.type === 'turn/end') {
        this.openTurns.delete(sessionId)
        if (this.pendingDispose.delete(sessionId)) this.#disposeBridgeTool(sessionId)
        if (this.pendingThreadRelease.delete(sessionId)) void this.#releaseThread(sessionId)
      }
      if (event.type === 'model/selection') {
        const selection = event.data?.selection || event.data
        if (selection?.provider && selection?.model) {
          this.lastSelection.set(sessionId, {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          })
        }
      }
    })

    on('llm/adapters-updated', () => {
      void this.refreshFallbackRoute()
    })

    on('agent/pre-step', (payload, next) => this.#onPreStep(payload, next))

    on('agent/request', async (payload, next) => {
      const config = await next()
      const sessionId = payload?.agent?.id
      if (!sessionId) return config
      try {
        if (this.isEnabled(sessionId)) {
          // Never carry an explicit `undefined` into the logged request header:
          // session.append() snapshots lossless JSON and rejects `undefined`.
          const routed = { ...config, provider: this.provider, model: this.model }
          const effort = normalizeCodexEffort(config.reasoningEffort) ?? normalizeCodexEffort(this.config.reasoningEffort)
          if (effort) routed.reasoningEffort = effort
          else delete routed.reasoningEffort
          return routed
        }
        this.lastRoute.set(sessionId, {
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        })
        if (config.provider === this.provider) {
          const fallback = this.store.get(sessionId)?.previousRoute || this.defaultRouteFor(sessionId)
          const restored = { ...config, provider: fallback.provider, model: fallback.model }
          if (fallback.reasoningEffort) restored.reasoningEffort = fallback.reasoningEffort
          else delete restored.reasoningEffort
          return restored
        }
        return config
      } catch (error) {
        this.log.warn(`[codex-mode] agent/request rewrite failed: ${error?.message || error}`)
        return config
      }
    })
  }

  async #onPreStep(payload, next) {
    const agent = payload?.agent
    const sessionId = agent?.id
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    if (!sessionId || messages.length === 0) return next()

    const text = joinText(messages).trim()
    const parsed = parseTrigger(text, this.config.triggerPhrases)
    if (!parsed) return next()

    const enabled = this.isEnabled(sessionId)
    if (parsed.action === 'off') {
      if (!enabled) return next()
      await this.disable(sessionId)
      await this.#receipt(agent, '/codex off', payload.signal)
      return { kind: 'reject' }
    }

    if (!enabled) await this.enable(sessionId, payload.signal)
    await this.#receipt(agent, '/codex on', payload.signal)

    if (!parsed.rest) return { kind: 'reject' }

    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    const rewritten = messages.map((message, index) => {
      if (index !== messages.length - 1) return message
      return { ...message, content: [{ type: 'text', text: parsed.rest }] }
    })
    return { ...decision, messages: rewritten }
  }

  #registerCommand() {
    const commands = this.ctx.get('commands')
    if (!commands || typeof commands.register !== 'function') {
      this.log.debug('[codex-mode] no commands service; /codex is unavailable in this profile')
      return
    }
    this.commandDispose = commands.register({
      name: 'codex',
      description: '开启/关闭本会话的 Codex 模式，或查看状态',
      input: { hint: 'on | off | status' },
      handler: (invocation) => this.#onCommand(invocation),
    })
  }

  async #onCommand(invocation) {
    const agent = invocation.agent
    const sessionId = agent?.id
    if (!sessionId) return { kind: 'error', text: 'codex: 无会话上下文' }
    const arg = String(invocation.rawInput || '').trim().toLowerCase()
    const sub = arg.split(/\s+/)[0] || 'status'

    // Internal receipt path: the state change already happened in pre-step.
    if (this._receipt) {
      return { kind: 'success', text: this._receipt.text || this.statusText(sessionId) }
    }

    try {
      if (sub === 'on') {
        if (this.isEnabled(sessionId)) return { kind: 'success', text: 'Codex 模式已是开启状态。' }
        await this.enable(sessionId, invocation.signal)
        return { kind: 'success', text: 'Codex 模式已开启；本会话后续对话由本机 Codex 处理。' }
      }
      if (sub === 'off') {
        if (!this.isEnabled(sessionId)) return { kind: 'success', text: 'Codex 模式当前是关闭状态。' }
        await this.disable(sessionId)
        return { kind: 'success', text: 'Codex 模式已关闭；本会话恢复使用 DSH 模型。' }
      }
      if (sub === 'status' || sub === '') return { kind: 'success', text: this.statusText(sessionId) }
      return { kind: 'error', text: '用法：/codex on | off | status' }
    } catch (error) {
      return { kind: 'error', text: `codex: ${error?.message || error}` }
    }
  }

  /** Write one log-only command card describing an activation change. */
  async #receipt(agent, line, signal) {
    const commands = this.ctx.get('commands')
    if (!commands || typeof commands.execute !== 'function') return
    this._receipt = { line, text: this.statusText(agent.id) }
    try {
      await commands.execute(agent, line, [], signal || new AbortController().signal)
    } catch (error) {
      this.log.debug(`[codex-mode] receipt command failed: ${error?.message || error}`)
    } finally {
      this._receipt = undefined
    }
  }

  // -------------------------------------------------------- bridge tooling

  #wireAgent(agent) {
    if (!agent?.id || !this.isEnabled(agent.id)) return
    if (this.bridgeTools.has(agent.id)) return
    if (!this.bridgeTool) {
      this.log.debug('[codex-mode] bridge tool not attached yet')
      return
    }
    if (!agent.ctx || !agent.ctx.tools || typeof agent.ctx.tools.register !== 'function') {
      this.log.warn('[codex-mode] agent has no scoped tools registry')
      return
    }
    const dispose = agent.ctx.tools.register(this.bridgeTool)
    if (typeof dispose === 'function') this.bridgeTools.set(agent.id, dispose)
  }

  #disposeBridgeTool(sessionId) {
    const dispose = this.bridgeTools.get(sessionId)
    if (dispose) {
      try {
        dispose()
      } catch (error) {
        this.log.debug(`[codex-mode] bridge tool dispose failed: ${error?.message || error}`)
      }
      this.bridgeTools.delete(sessionId)
    }
  }

  #scheduleBridgeDispose(sessionId) {
    if (this.openTurns.has(sessionId)) {
      this.pendingDispose.add(sessionId)
    } else {
      this.#disposeBridgeTool(sessionId)
    }
  }

  // ------------------------------------------------------ codex thread lease

  /** Release the codex thread after the current turn ends (never mid-turn). */
  #scheduleThreadRelease(sessionId) {
    if (this.openTurns.has(sessionId)) {
      this.pendingThreadRelease.add(sessionId)
    } else {
      void this.#releaseThread(sessionId)
    }
  }

  /**
   * `thread/unsubscribe` the loaded codex thread so its writer lock is released
   * (the app-server spawns with thread_unload_delay_secs=0). The thread id stays
   * in mode state; re-enabling resumes the same context.
   */
  #releaseThread(sessionId) {
    if (this.disposed) return Promise.resolve()
    const threadId = this.store.get(sessionId)?.threadId
    if (!threadId) return Promise.resolve()
    if (!this.runtime || typeof this.runtime.threadUnsubscribe !== 'function') return Promise.resolve()
    // A dead app-server holds no leases; don't spawn it just to unsubscribe.
    if (typeof this.runtime.isAlive === 'function' && !this.runtime.isAlive()) {
      this.log.debug(`[codex-mode] app-server not running; no lease to release for ${threadId}`)
      return Promise.resolve()
    }
    const promise = Promise.resolve()
      .then(() => this.runtime.threadUnsubscribe({ threadId }))
      .then(() => this.log.info(`[codex-mode] released codex thread ${threadId} (session ${sessionId})`))
      .catch((error) =>
        this.log.debug(`[codex-mode] codex thread release failed for ${threadId}: ${error?.message || error}`),
      )
      .finally(() => {
        if (this.releasePromises.get(sessionId) === promise) this.releasePromises.delete(sessionId)
      })
    this.releasePromises.set(sessionId, promise)
    return promise
  }

  // ------------------------------------------------------------ attachments

  async #materializeImage(sessionId, attachment, index) {
    const attachments = this.ctx.get('attachments')
    if (!attachments) return undefined
    try {
      const hostPath = attachments.imageHostPath?.(attachment)
      if (hostPath) return hostPath
      if (typeof attachments.readImage !== 'function') return undefined
      const stored = await attachments.readImage(attachment)
      const data = stored?.data || stored
      if (!data) return undefined
      const dir = this.#attachmentDir(sessionId)
      await fs.mkdir(dir, { recursive: true })
      const name = `${index}-${safeName(attachment.name || attachment.attachmentId || 'image')}`
      const file = path.join(dir, name)
      await fs.writeFile(file, data)
      return file
    } catch (error) {
      this.log.warn(`[codex-mode] image materialization failed: ${error?.message || error}`)
      return undefined
    }
  }

  async #materializeFile(sessionId, attachment, index) {
    const attachments = this.ctx.get('attachments')
    if (!attachments) return undefined
    try {
      const hostPath = attachments.fileHostPath?.(attachment)
      if (hostPath) return hostPath
      if (typeof attachments.readFileStream !== 'function') return undefined
      const dir = this.#attachmentDir(sessionId)
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${index}-${safeName(attachment.name || 'file')}`)
      const chunks = []
      for await (const chunk of attachments.readFileStream(attachment)) chunks.push(chunk)
      await fs.writeFile(file, Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))))
      return file
    } catch (error) {
      this.log.warn(`[codex-mode] file materialization failed: ${error?.message || error}`)
      return undefined
    }
  }

  #attachmentDir(sessionId) {
    const base = this.config.attachmentsDir || path.join(os.tmpdir(), 'dsh-codex-mode')
    return path.join(base, safeName(sessionId))
  }

  // --------------------------------------------------------------- dispose

  async dispose() {
    if (this.disposed) return
    const threadSessions = []
    for (const [sessionId, state] of this.store.entries()) {
      if (state?.threadId) threadSessions.push(sessionId)
    }
    // Release leases before tearing down the runtime/app-server so native Codex
    // can reopen these threads without waiting for the process to exit.
    const releases = threadSessions.map((sessionId) => this.#releaseThread(sessionId))
    if (releases.length > 0) {
      await Promise.race([
        Promise.allSettled(releases),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
    }
    this.disposed = true
    try {
      this.commandDispose?.()
    } catch {}
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {}
    }
    for (const disposer of this.bridgeTools.values()) {
      try {
        disposer()
      } catch {}
    }
    this.bridgeTools.clear()
    await this.store.close()
    this.log.info('[codex-mode] controller disposed')
  }
}

const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])
const EFFORT_ALIASES = Object.freeze({
  max: 'xhigh',
  maximum: 'xhigh',
  'extra-high': 'xhigh',
  extrahigh: 'xhigh',
  min: 'minimal',
  minimum: 'minimal',
})

/** Map a DSH/Codex reasoning-effort id onto a Codex-supported effort. */
export function normalizeCodexEffort(value) {
  if (typeof value !== 'string') return undefined
  const key = value.trim().toLowerCase()
  if (!key) return undefined
  const canonical = EFFORT_ALIASES[key] ?? key
  return CODEX_EFFORTS.has(canonical) ? canonical : undefined
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'attachment'
}

export { PROVIDER_INFO }
