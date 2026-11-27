// Integration entry for dsh-codex-mode (copied over index.js once the sibling
// modules land). Kept separate so the placeholder index.js stays loadable while
// src/codex and src/adapter are being implemented in parallel.

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CodexAppServer } from './src/codex/app-server.js'
import { CodexRuntime } from './src/codex/runtime.js'
import { createCodexAdapter } from './src/adapter/adapter.js'
import { createBridgeTool } from './src/bridge/tool.js'
import { ModeController } from './src/mode/controller.js'

export const name = 'dsh-codex-mode'
export const inject = ['llm', 'agents', 'tools', 'sessions']


function makeLog(ctx) {
  const wrap = (method, fallback) => (...args) => {
    try {
      const logger = ctx.get?.('logger')
      if (logger && typeof logger[method] === 'function') return logger[method]('[codex-mode]', ...args)
    } catch {}
    return fallback('[codex-mode]', ...args)
  }
  return {
    // Diagnostics always go to stderr: headless reserves stdout for the answer /
    // JSON event stream, and a profile may not provide a logger service.
    debug: wrap('debug', (...a) => console.error(...a)),
    info: wrap('info', (...a) => console.error(...a)),
    warn: wrap('warn', (...a) => console.error(...a)),
    error: wrap('error', (...a) => console.error(...a)),
  }
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

/** Resolve the codex model id: explicit config wins, then ~/.codex/config.toml. */
function readCodexConfigInteger(key) {
  try {
    const text = readFileSync(path.join(codexHome(), 'config.toml'), 'utf8')
    const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'))
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}

function readCodexConfigString(key) {
  try {
    const text = readFileSync(path.join(codexHome(), 'config.toml'), 'utf8')
    const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))
    return match ? match[1] : undefined
  } catch {
    return undefined
  }
}

function resolveModel(config) {
  if (config?.model) return config.model
  return readCodexConfigString('model') || 'gpt-6.2-sol'
}

function resolveDefaults(config) {
  const source = config || {}
  return {
    codexBin: source.codexBin || process.env.CODEX_BIN || '/root/.npm-global/bin/codex',
    providerName: source.providerName || 'codex',
    model: resolveModel(source),
    cwd: source.cwd,
    requestTimeoutMs: Number.isFinite(source.requestTimeoutMs) ? source.requestTimeoutMs : 60000,
    bootstrapLimitChars: Number.isFinite(source.bootstrapLimitChars) ? source.bootstrapLimitChars : 24000,
    attachmentsDir: source.attachmentsDir,
    defaultSandbox: source.defaultSandbox || 'danger-full-access',
    defaultApproval: source.defaultApproval || 'never',
    approvalToolName: source.approvalToolName || 'codex',
    // DSH/Codex thinking effort: explicit config wins, then the Codex config.
    reasoningEffort:
      source.reasoningEffort || readCodexConfigString('model_reasoning_effort') || 'xhigh',
    reasoningSummary: source.reasoningSummary || readCodexConfigString('model_reasoning_summary'),
    codexEfforts: Array.isArray(source.codexEfforts) ? source.codexEfforts : undefined,
    // Context capacity: explicit config wins, then Codex's own model_context_window
    // override; when absent the adapter learns the real window from Codex after
    // the first turn (thread/tokenUsage/updated.modelContextWindow).
    contextWindow: source.contextWindow ?? readCodexConfigInteger('model_context_window'),
  }
}

export async function apply(ctx, rawConfig) {
  const log = makeLog(ctx)
  const config = resolveDefaults(rawConfig)
  log.info(`loading (codex=${config.codexBin}, model=${config.model})`)

  const controller = new ModeController({ ctx, log, config })
  const appServer = new CodexAppServer({
    bin: config.codexBin,
    log,
    requestTimeoutMs: config.requestTimeoutMs,
  })
  const runtime = new CodexRuntime({
    appServer,
    log,
    approvalHandler: (request) => controller.approvalHandler(request),
  })
  const adapter = createCodexAdapter({
    runtime,
    mode: controller,
    log,
    config,
    fallbackStream: (options) => controller.fallbackStream(options),
  })
  const bridgeTool = createBridgeTool({ takeResult: adapter.takeResult, log })
  controller.attach({ runtime, adapter, bridgeTool })

  let adapterRegistration
  try {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.registerAdapter !== 'function') {
      throw new Error('the llm service is unavailable')
    }
    adapterRegistration = llm.registerAdapter([config.providerName], adapter)
  } catch (error) {
    log.error(`cannot register the codex provider: ${error?.message || error}`)
    throw error
  }

  try {
    await controller.init()
  } catch (error) {
    log.error(`initialization failed: ${error?.message || error}`)
    try {
      adapterRegistration()
    } catch {}
    throw error
  }

  let disposed = false
  return async function dispose() {
    if (disposed) return
    disposed = true
    try {
      adapterRegistration?.()
    } catch (error) {
      log.debug(`adapter unregister failed: ${error?.message || error}`)
    }
    try {
      await adapter.dispose?.()
    } catch (error) {
      log.debug(`adapter dispose failed: ${error?.message || error}`)
    }
    try {
      await controller.dispose()
    } catch (error) {
      log.debug(`controller dispose failed: ${error?.message || error}`)
    }
    try {
      await runtime.stop?.()
    } catch (error) {
      log.debug(`runtime stop failed: ${error?.message || error}`)
    }
    try {
      await appServer.stop?.()
    } catch (error) {
      log.debug(`app-server stop failed: ${error?.message || error}`)
    }
    log.info('unloaded')
  }
}
