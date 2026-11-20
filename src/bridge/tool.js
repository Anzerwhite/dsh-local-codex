/**
 * `codex_activity` — display-bridge tool for Codex activities.
 *
 * The Codex adapter cannot persist custom session events. Instead, when a
 * Codex item that represents a local action starts (a command execution, a
 * file change, an MCP tool call, a web search), the adapter emits a synthetic
 * `tool-call` block for this plugin-scoped tool. The DSH loop dispatches that
 * call, which produces the native `tool/call` + `tool/result` session events
 * and therefore a generic collapsible tool card in the existing Web UI.
 *
 * The tool body is side-effect free: it only waits for the adapter to report
 * the Codex-recorded outcome for that call id. It never re-runs anything.
 *
 * Plain ESM object; the `ToolDefinition` shape is structural (no import from
 * `@deepseek-ai/dsh-tools` needed).
 *
 * @module dsh-codex-mode/bridge/tool
 */

/** Wire name of the synthetic display-bridge tool. */
export const BRIDGE_TOOL_NAME = 'codex_activity'

const DESCRIPTION = 'Display a local Codex action (command execution / file change / tool call) in the conversation.'

/**
 * @typedef {object} BridgeToolOptions
 * @property {(callId: string, signal?: AbortSignal) => Promise<{kind: string, text: string, isError: boolean}>} takeResult
 *   Adapter-owned result queue accessor; resolves when the corresponding Codex
 *   item completed (or with an error result when no data exists).
 * @property {{debug?: Function, info?: Function, warn?: Function, error?: Function}} [log]
 */

/**
 * Create the bridge tool definition.
 *
 * Contract notes (docs/impl-contract.md §3.4):
 * - parameters/output must be valid raw JSON Schema (supported keyword subset);
 * - no `timeoutMs` (waiting for Codex has no deadline);
 * - no `isConcurrencySafe` (activities are displayed in order, exclusively).
 *
 * @param {BridgeToolOptions} options
 * @returns {object} a `ToolDefinition`-shaped plain object.
 */
export function createBridgeTool({ takeResult, log } = {}) {
  if (typeof takeResult !== 'function') throw new TypeError('createBridgeTool: takeResult(callId, signal) is required')
  const logger = normalizeLogger(log)

  return {
    name: BRIDGE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        callId: { type: 'string' },
        kind: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['callId', 'kind'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          text: { type: 'string' },
          isError: { type: 'boolean' },
        },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
      render(_args, value) {
        const text = value && typeof value.text === 'string' ? value.text : ''
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const callId = args && typeof args === 'object' && typeof args.callId === 'string' ? args.callId : ''
      if (!callId) {
        return { kind: 'unknown', text: `${BRIDGE_TOOL_NAME}: missing callId in arguments`, isError: true }
      }
      const result = await takeResult(callId, exec?.signal)
      const value = {
        kind: typeof result?.kind === 'string' ? result.kind : 'unknown',
        text: typeof result?.text === 'string' ? result.text : '',
        isError: result?.isError === true,
      }
      logger.debug(`${BRIDGE_TOOL_NAME}: resolved call ${callId} (${value.kind}, ${value.text.length} chars, isError=${value.isError})`)
      return value
    },
  }
}

function normalizeLogger(log) {
  const noop = () => {}
  const source = log && typeof log === 'object' ? log : {}
  const pick = (name) => (typeof source[name] === 'function' ? (...args) => {
    try {
      source[name](...args)
    } catch {
      /* logging must never break a tool call */
    }
  } : noop)
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') }
}
