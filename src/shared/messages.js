// Shared helpers for DSH message content. Works with durable DSH messages
// (`Message` from @deepseek-ai/dsh-llm) without importing the package.

/** True for a durable user-role message authored by a human (has id + source). */
export function isDurableUserMessage(message) {
  return Boolean(
    message &&
      message.role === 'user' &&
      typeof message.id === 'string' &&
      message.source &&
      message.source.kind === 'user',
  )
}

/** True for any durable message carrying an id (user/assistant/tool). */
export function isDurableMessage(message) {
  return Boolean(message && typeof message.id === 'string')
}

/** Text blocks of a message's content array. */
export function textBlocks(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  return content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
}

/** Join one message's text blocks. */
export function textOf(message) {
  return textBlocks(message)
    .map((block) => block.text)
    .join('\n')
}

/** Join the text of several messages. */
export function joinText(messages) {
  return (messages || [])
    .map((message) => textOf(message))
    .filter((text) => text.length > 0)
    .join('\n')
}

/** Last durable human user message, or undefined. */
export function latestDurableUserMessage(messages) {
  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isDurableUserMessage(message)) return message
  }
  return undefined
}

/** Durable user/assistant text turns suitable for a bootstrap digest. */
export function bootstrapTurns(messages) {
  const turns = []
  for (const message of messages || []) {
    if (!isDurableMessage(message)) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOf(message)
    if (!text) continue
    turns.push({ role: message.role, id: message.id, text })
  }
  return turns
}

/** Truncate from the end while keeping whole characters. */
export function tailChars(text, limit) {
  if (limit <= 0) return ''
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** Truncate a string to at most `limit` characters, appending a marker. */
export function clipChars(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…[truncated]`
}
