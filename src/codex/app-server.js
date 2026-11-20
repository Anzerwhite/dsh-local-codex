// Codex app-server stdio JSON-RPC client.
//
// Transport is newline-delimited JSON (NOT LSP Content-Length framing): one
// JSON object per line on stdout, responses correlate by `id`, objects with
// `method` and no `id` are notifications, objects with both `method` and `id`
// are server->client requests that must be answered.
//
// See docs/impl-contract.md §2.1 for the required surface.

import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'

const CLIENT_INFO = Object.freeze({
  name: 'dsh-codex-mode',
  title: 'DSH Codex Mode',
  version: '0.1.0',
})

/**
 * app-server subcommand; callers may override via `args`.
 * `thread_unload_delay_secs=0` makes `thread/unsubscribe` unload the thread (and
 * release its writer lock) promptly instead of keeping it resident, so a native
 * Codex TUI can re-open the thread right after `/codex off`.
 */
const DEFAULT_ARGS = Object.freeze([
  'app-server',
  '--listen',
  'stdio://',
  '-c',
  'thread_unload_delay_secs=0',
])

/** Handshake (initialize) must complete within 10s. */
const START_TIMEOUT_MS = 10_000
/** SIGTERM grace before SIGKILL in stop(). */
const STOP_GRACE_MS = 2_000
/** Guard against an unterminated stdout line exhausting memory. */
const MAX_STDOUT_BUFFER_BYTES = 288 * 1024 * 1024
/** stderr is diagnostics only; bound each logged line. */
const MAX_STDERR_LINE_CHARS = 4_000

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
})

export class CodexAppServerError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human readable message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CodexAppServerError'
    this.code = code
  }
}

export class CodexAppServer {
  #bin
  #args
  #log
  #requestTimeoutMs
  #child
  #nextId = 1
  /** @type {Map<number|string, {resolve: Function, reject: Function, timer: NodeJS.Timeout, method: string}>} */
  #pending = new Map()
  /** @type {Set<(notification: {method: string, params: object}) => unknown>} */
  #notificationHandlers = new Set()
  /** @type {Set<(request: {id: number|string, method: string, params: object}) => unknown>} */
  #serverRequestHandlers = new Set()
  /** @type {Set<(info: {code: number|null, signal: string|null, error?: Error}) => unknown>} */
  #exitHandlers = new Set()
  #stdoutBuffer = Buffer.alloc(0)
  #stderrDecoder = new StringDecoder('utf8')
  #stderrBuffer = ''
  #ready = false
  #stopping = false
  #startPromise
  #exitNotified = false

  /**
   * @param {{ bin: string, args?: string[], log?: object, requestTimeoutMs?: number }} options
   */
  constructor({ bin, args = [], log, requestTimeoutMs = 60_000 }) {
    if (typeof bin !== 'string' || bin.length === 0) {
      throw new TypeError('CodexAppServer: `bin` must be a non-empty string')
    }
    this.#bin = bin
    this.#args = Array.isArray(args) && args.length > 0 ? [...args] : [...DEFAULT_ARGS]
    this.#log = log ?? NOOP_LOG
    this.#requestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 60_000
  }

  /** True once the initialize handshake has completed. */
  get started() {
    return this.#ready
  }

  /** True while a child process exists and has not exited. */
  isAlive() {
    const child = this.#child
    return child !== undefined && child.exitCode === null && !child.killed
  }

  /**
   * Spawn the app-server and perform the initialize handshake. Idempotent while
   * healthy; after a failure (or unexpected exit) a later call retries.
   */
  start() {
    if (this.#ready) return Promise.resolve()
    if (this.#startPromise !== undefined) return this.#startPromise
    this.#startPromise = this.#startOnce().finally(() => {
      this.#startPromise = undefined
    })
    return this.#startPromise
  }

  /**
   * Send a JSON-RPC request and resolve with its `result`.
   * @param {string} method
   * @param {object|undefined} params
   * @param {number} [timeoutMs]
   */
  async request(method, params, timeoutMs = this.#requestTimeoutMs) {
    if (!this.#ready) {
      throw new CodexAppServerError('CODEX_UNAVAILABLE', 'codex app-server is not ready')
    }
    return this.#sendRequest(method, params, timeoutMs)
  }

  /**
   * Subscribe to server->client notifications.
   * @param {(notification: {method: string, params: object}) => unknown} handler
   * @returns {() => void} dispose
   */
  onNotification(handler) {
    if (typeof handler !== 'function') throw new TypeError('onNotification: handler must be a function')
    this.#notificationHandlers.add(handler)
    return () => {
      this.#notificationHandlers.delete(handler)
    }
  }

  /**
   * Subscribe to server->client requests (approval prompts, elicitation, ...).
   * The handler returns `{ result }` or `{ error }`; the first non-null answer
   * is written back verbatim. If no handler answers, `-32601` is returned.
   * @param {(request: {id: number|string, method: string, params: object}) => Promise<{result?: unknown, error?: {code: number, message: string}}|undefined>|{result?: unknown, error?: {code: number, message: string}}|undefined} handler
   * @returns {() => void} dispose
   */
  onServerRequest(handler) {
    if (typeof handler !== 'function') throw new TypeError('onServerRequest: handler must be a function')
    this.#serverRequestHandlers.add(handler)
    return () => {
      this.#serverRequestHandlers.delete(handler)
    }
  }

  /**
   * Subscribe to unexpected child-process termination. Not called for a
   * deliberate `stop()`.
   * @param {(info: {code: number|null, signal: string|null, error?: Error}) => unknown} handler
   * @returns {() => void} dispose
   */
  onExit(handler) {
    if (typeof handler !== 'function') throw new TypeError('onExit: handler must be a function')
    this.#exitHandlers.add(handler)
    return () => {
      this.#exitHandlers.delete(handler)
    }
  }

  /** SIGTERM, wait up to 2s, then SIGKILL. Rejects all pending requests. */
  async stop() {
    this.#stopping = true
    this.#ready = false
    const child = this.#child
    this.#child = undefined
    this.#failPending(new CodexAppServerError('CODEX_STOPPED', 'codex app-server was stopped'))
    if (child === undefined || child.exitCode !== null || child.killed) return
    try {
      child.kill('SIGTERM')
    } catch {
      return
    }
    if (await this.#waitForExit(child, STOP_GRACE_MS)) return
    this.#log.warn('[codex] app-server did not exit on SIGTERM, sending SIGKILL')
    try {
      child.kill('SIGKILL')
    } catch {
      return
    }
    await this.#waitForExit(child, STOP_GRACE_MS)
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  async #startOnce() {
    if (this.#child !== undefined) {
      throw new CodexAppServerError('CODEX_STARTING', 'codex app-server is already starting')
    }
    this.#stopping = false
    this.#exitNotified = false
    this.#ready = false
    this.#stdoutBuffer = Buffer.alloc(0)
    this.#stderrDecoder = new StringDecoder('utf8')
    this.#stderrBuffer = ''

    const child = spawn(this.#bin, this.#args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child
    child.stdout.on('data', chunk => this.#consumeStdout(Buffer.from(chunk)))
    child.stderr.on('data', chunk => this.#consumeStderr(Buffer.from(chunk)))
    child.stdin.on('error', error => {
      // EPIPE while the child is dying; the pending requests are rejected by
      // the exit handler, no need to escalate.
      this.#log.debug(`[codex] stdin error: ${error?.message ?? String(error)}`)
    })
    child.on('error', error => this.#handleProcessError(child, error))
    child.on('exit', (code, signal) => this.#handleProcessExit(child, code, signal))

    try {
      const result = await this.#sendRequest(
        'initialize',
        {
          clientInfo: { ...CLIENT_INFO },
          capabilities: { experimentalApi: true },
        },
        START_TIMEOUT_MS,
      )
      if (this.#child !== child) {
        throw new CodexAppServerError('CODEX_EXITED', 'codex app-server exited during initialize')
      }
      this.#write({ method: 'initialized' })
      this.#ready = true
      this.#log.info('[codex] app-server ready', { userAgent: result?.userAgent })
      return result
    } catch (error) {
      this.#ready = false
      this.#child = undefined
      this.#failPending(error)
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGTERM')
        } catch {
          // ignore
        }
      }
      if (error instanceof CodexAppServerError) throw error
      throw new CodexAppServerError(
        'CODEX_INITIALIZE_FAILED',
        `codex app-server initialize failed: ${error?.message ?? String(error)}`,
        { cause: error },
      )
    }
  }

  #sendRequest(method, params, timeoutMs) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(new CodexAppServerError('CODEX_REQUEST_TIMEOUT', `codex app-server request timed out: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#write(params === undefined ? { id, method } : { id, method, params })
      } catch (error) {
        const entry = this.#pending.get(id)
        if (entry === undefined) return
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  #write(message) {
    const child = this.#child
    const stdin = child?.stdin
    if (child === undefined || stdin === undefined || stdin.destroyed || !stdin.writable) {
      throw new CodexAppServerError('CODEX_UNAVAILABLE', 'codex app-server is not available')
    }
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  #consumeStdout(chunk) {
    this.#stdoutBuffer = this.#stdoutBuffer.length === 0 ? chunk : Buffer.concat([this.#stdoutBuffer, chunk])
    if (this.#stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
      this.#log.error('[codex] stdout buffer exceeded limit, dropping buffered output')
      this.#stdoutBuffer = Buffer.alloc(0)
      return
    }
    let newline = this.#stdoutBuffer.indexOf(0x0a)
    while (newline >= 0) {
      const line = this.#stdoutBuffer.subarray(0, newline)
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1)
      if (line.length > 0) this.#handleLine(line.toString('utf8').trim())
      newline = this.#stdoutBuffer.indexOf(0x0a)
    }
  }

  #consumeStderr(chunk) {
    this.#stderrBuffer += this.#stderrDecoder.write(chunk)
    let newline = this.#stderrBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.#stderrBuffer.slice(0, newline)
      this.#stderrBuffer = this.#stderrBuffer.slice(newline + 1)
      if (line.trim().length > 0) this.#logStderrLine(line)
      newline = this.#stderrBuffer.indexOf('\n')
    }
  }

  #logStderrLine(line) {
    const trimmed = line.trim()
    const text = trimmed.length > MAX_STDERR_LINE_CHARS ? `${trimmed.slice(0, MAX_STDERR_LINE_CHARS)}…` : trimmed
    try {
      this.#log.debug(`[codex] ${text}`)
    } catch {
      // a broken logger must never break the reader loop
    }
  }

  #handleLine(text) {
    if (text.length === 0) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      this.#log.warn('[codex] dropping invalid JSON line from app-server', text.slice(0, 200))
      return
    }
    if (!isRecord(message)) {
      this.#log.warn('[codex] dropping non-object app-server message')
      return
    }
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    if (hasId && ('result' in message || 'error' in message)) {
      this.#handleResponse(message)
      return
    }
    if (typeof message.method !== 'string' || message.method.length === 0) {
      this.#log.warn('[codex] dropping app-server message without method or result')
      return
    }
    const params = isRecord(message.params) ? message.params : {}
    if (hasId) {
      this.#dispatchServerRequest({ id: message.id, method: message.method, params })
    } else {
      this.#dispatchNotification({ method: message.method, params })
    }
  }

  #handleResponse(message) {
    const id = message.id
    const pending = this.#pending.get(id)
    if (pending === undefined) {
      this.#log.debug(`[codex] response for unknown request id: ${String(id)}`)
      return
    }
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if ('error' in message && message.error !== undefined && message.error !== null) {
      pending.reject(upstreamError(pending.method, message.error))
      return
    }
    pending.resolve(message.result)
  }

  #dispatchNotification(notification) {
    for (const handler of this.#notificationHandlers) {
      try {
        const result = handler(notification)
        if (isThenable(result)) {
          result.catch(error => {
            this.#log.error(`[codex] notification handler rejected for ${notification.method}`, error)
          })
        }
      } catch (error) {
        this.#log.error(`[codex] notification handler threw for ${notification.method}`, error)
      }
    }
  }

  #dispatchServerRequest(request) {
    void this.#answerServerRequest(request)
  }

  async #answerServerRequest(request) {
    let response
    for (const handler of this.#serverRequestHandlers) {
      try {
        const result = await handler(request)
        if (result !== undefined && result !== null) {
          response = result
          break
        }
      } catch (error) {
        this.#log.error(`[codex] server request handler failed for ${request.method}`, error)
        response = { error: { code: -32603, message: 'internal error' } }
        break
      }
    }
    if (response === undefined) {
      response = { error: { code: -32601, message: 'unsupported method' } }
    }
    try {
      this.#write({ id: request.id, ...response })
    } catch (error) {
      this.#log.error(`[codex] failed to answer server request ${request.method}`, error)
    }
  }

  #handleProcessError(child, error) {
    if (this.#child !== child) return
    this.#child = undefined
    this.#ready = false
    const wrapped =
      error instanceof CodexAppServerError
        ? error
        : new CodexAppServerError('CODEX_PROCESS_ERROR', `codex app-server process error: ${error?.message ?? String(error)}`, {
            cause: error,
          })
    this.#failPending(wrapped)
    this.#log.error('[codex] app-server process error', error)
    if (!this.#stopping) this.#notifyExit({ code: null, signal: null, error: wrapped })
  }

  #handleProcessExit(child, code, signal) {
    if (this.#child !== child) return
    this.#child = undefined
    this.#ready = false
    this.#failPending(
      new CodexAppServerError('CODEX_EXITED', `codex app-server exited (code=${String(code)}, signal=${String(signal)})`),
    )
    this.#log.debug(`[codex] app-server exited code=${String(code)} signal=${String(signal)}`)
    if (!this.#stopping) this.#notifyExit({ code: code ?? null, signal: signal ?? null })
  }

  #notifyExit(info) {
    if (this.#exitNotified) return
    this.#exitNotified = true
    for (const handler of this.#exitHandlers) {
      try {
        const result = handler(info)
        if (isThenable(result)) {
          result.catch(error => {
            this.#log.error('[codex] onExit handler rejected', error)
          })
        }
      } catch (error) {
        this.#log.error('[codex] onExit handler threw', error)
      }
    }
  }

  #failPending(error) {
    for (const [id, entry] of [...this.#pending.entries()]) {
      this.#pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  #waitForExit(child, timeoutMs) {
    if (child.exitCode !== null) return Promise.resolve(true)
    return new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
      child.once('exit', () => finish(true))
    })
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function'
}

function upstreamError(method, error) {
  const rpcCode = isRecord(error) && typeof error.code === 'number' ? error.code : undefined
  const upstreamMessage = isRecord(error) && typeof error.message === 'string' ? error.message : 'unknown error'
  const wrapped = new CodexAppServerError(
    rpcCode === undefined ? 'CODEX_RPC_ERROR' : `CODEX_RPC_${rpcCode}`,
    `codex app-server rejected ${method}: ${upstreamMessage}`,
  )
  wrapped.rpcCode = rpcCode
  wrapped.upstreamMessage = upstreamMessage
  if (isRecord(error) && 'data' in error) wrapped.data = error.data
  return wrapped
}
