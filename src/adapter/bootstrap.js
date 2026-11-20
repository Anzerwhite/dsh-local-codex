/**
 * Bootstrap ("initialization context") for a newly created Codex thread.
 *
 * The DSH side of a Codex-mode session keeps every message of the conversation
 * that happened before the mode was turned on. A brand-new Codex thread starts
 * empty, so the adapter flattens the most recent user/assistant prose into one
 * `developerInstructions` string that is injected exactly once, at
 * `thread/start`. Resumed threads never receive it again.
 *
 * Kept self-contained (no imports from other plugin modules) so the adapter
 * can be unit-tested and reasoned about in isolation.
 *
 * @module dsh-codex-mode/adapter/bootstrap
 */

/** Default character budget for the transcript excerpt (contract §3.3). */
export const DEFAULT_BOOTSTRAP_LIMIT_CHARS = 24000

const IMAGE_PLACEHOLDER = '[image attachment]'
const FILE_PLACEHOLDER = '[file attachment]'

/**
 * Flatten one message content into plain text.
 *
 * Handles the canonical content-block array plus a few defensive shapes:
 * a bare string, a block list containing text/image/file/tool-call blocks.
 * Tool-call blocks are reduced to a placeholder because the DSH tool history
 * is intentionally not forwarded to Codex.
 *
 * @param {unknown} content - message content (block array, block, or string).
 * @returns {string} flattened text.
 */
export function extractTextFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
    return ''
  }
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'reasoning':
        // Reasoning is model-internal; never part of the handover transcript.
        break
      case 'image':
        parts.push(IMAGE_PLACEHOLDER)
        break
      case 'file':
        parts.push(FILE_PLACEHOLDER)
        break
      case 'tool-call':
        parts.push(`[tool call: ${typeof block.name === 'string' ? block.name : 'unknown'}]`)
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/**
 * Flatten one user message into plain text.
 *
 * @param {unknown} message - a DSH message (user role expected).
 * @returns {string} flattened text, never undefined.
 */
export function extractUserMessageText(message) {
  return extractTextFromContent(message?.content)
}

/**
 * Collect the durable user/assistant prose of a request history.
 *
 * Only conversation messages participate:
 * - a user message must come from the user (`source.kind === 'user'`), so
 *   runtime-context snapshots (`source.kind === 'runtime-context'`) and other
 *   injected user-role context never leak into the handover transcript;
 * - an assistant message must be model-produced.
 * Messages must also carry a stable `id`; the last durable user message is
 * skipped because it is the utterance that opened this Codex turn and is
 * forwarded through `turn/start` instead.
 *
 * @param {readonly unknown[]} messages - `GenerateOptions.messages`.
 * @returns {{role: 'user'|'assistant', text: string}[]} oldest-to-newest entries.
 */
export function collectHistoryEntries(messages) {
  const list = Array.isArray(messages) ? messages : []
  let lastUserIndex = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i]
    if (message?.role === 'user' && message.source?.kind === 'user') {
      lastUserIndex = i
      break
    }
  }
  if (lastUserIndex === -1) {
    // Defensive fallback for hand-built / legacy histories without a source tag.
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.role === 'user') {
        lastUserIndex = i
        break
      }
    }
  }
  const entries = []
  for (let i = 0; i < list.length; i += 1) {
    if (i === lastUserIndex) continue
    const message = list[i]
    if (!message || typeof message !== 'object') continue
    if (message.id === undefined || message.id === null) continue
    if (message.role === 'user') {
      if (message.source?.kind !== 'user') continue
    } else if (message.role === 'assistant') {
      if (message.source?.kind !== 'model') continue
    } else {
      continue
    }
    const text = extractTextFromContent(message.content).trim()
    if (!text) continue
    entries.push({ role: message.role, text })
  }
  return entries
}

/**
 * Keep the newest entries that fit into `limitChars`, preserving order.
 *
 * A single entry that exceeds the remaining budget is included as its tail
 * (the most recent part is what matters for continuing a conversation) with an
 * explicit truncation marker.
 *
 * @param {{role: string, text: string}[]} entries - oldest-to-newest entries.
 * @param {number} limitChars - character budget for the formatted lines.
 * @returns {string[]} formatted `<role>: text` lines, oldest first.
 */
function takeRecentLines(entries, limitChars) {
  const budget = Number.isFinite(limitChars) && limitChars > 0 ? Math.floor(limitChars) : DEFAULT_BOOTSTRAP_LIMIT_CHARS
  const lines = []
  let remaining = budget
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (remaining <= 0) break
    const entry = entries[i]
    const line = `<${entry.role}>: ${entry.text}`
    if (line.length + 1 <= remaining) {
      lines.unshift(line)
      remaining -= line.length + 1
      continue
    }
    const prefix = `<${entry.role}>: …`
    const keep = remaining - prefix.length - 1
    if (keep > 40) lines.unshift(`${prefix}${entry.text.slice(-keep)}`)
    break
  }
  return lines
}

/**
 * Build the `developerInstructions` injected when a Codex thread is created.
 *
 * Always returns a usable environment note; history is included only when the
 * request carried durable user/assistant messages.
 *
 * @param {object} [options]
 * @param {readonly unknown[]} [options.messages] - full request history.
 * @param {string} [options.cwd] - session working directory.
 * @param {string} [options.sandbox] - codex sandbox mode.
 * @param {string} [options.approvalPolicy] - codex approval policy.
 * @param {number} [options.limitChars] - history character budget.
 * @param {string} [options.model] - codex model id (diagnostic only).
 * @returns {string} developer instructions text, non-empty.
 */
export function buildBootstrap({ messages, cwd, sandbox, approvalPolicy, limitChars, model } = {}) {
  const entries = collectHistoryEntries(messages)
  const lines = takeRecentLines(entries, limitChars ?? DEFAULT_BOOTSTRAP_LIMIT_CHARS)

  const sections = []
  sections.push(
    [
      'You are Codex, taking over an existing DeepSeek Harness (DSH) conversation in "Codex mode".',
      'From now on the DSH user talks to you through the DSH chat UI; your replies and local actions are synced back into that session.',
      'Continue the conversation naturally using the earlier transcript below as context. Do not repeat or summarize the transcript unless the user asks.',
    ].join('\n'),
  )

  const environment = ['Environment:', `- Working directory: ${cwd || '(unknown)'}`, `- Sandbox: ${sandbox || '(unknown)'}`, `- Approval policy: ${approvalPolicy || '(unknown)'}`]
  if (model) environment.push(`- Model route: ${model}`)
  sections.push(environment.join('\n'))

  if (lines.length > 0) {
    sections.push(['Previous conversation (oldest to newest, possibly truncated):', ...lines].join('\n'))
  } else {
    sections.push('There is no earlier conversation transcript: this is the first message of the conversation.')
  }

  return sections.join('\n\n')
}
