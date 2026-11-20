// Trigger phrase grammar for Codex Mode.
//
// Rule (from docs/design.md): a trigger phrase must appear at the START of the
// message (leading whitespace / decorative punctuation tolerated). Text after
// the phrase, separated by punctuation or whitespace, becomes the attached
// content for that turn. The trigger itself never enters model history.

export const DEFAULT_ON_PHRASES = Object.freeze([
  '使用codex模式',
  '使用 codex 模式',
  '开启codex模式',
  '开启 codex 模式',
  '进入codex模式',
  '进入 codex 模式',
  '切换到codex模式',
  '切换到 codex 模式',
  'use codex mode',
  'enable codex mode',
  'enter codex mode',
  'codex mode on',
])

export const DEFAULT_OFF_PHRASES = Object.freeze([
  '退出codex模式',
  '退出 codex 模式',
  '关闭codex模式',
  '关闭 codex 模式',
  '结束codex模式',
  '结束 codex 模式',
  '停用codex模式',
  '停用 codex 模式',
  'exit codex mode',
  'disable codex mode',
  'codex mode off',
])

const LEADING_NOISE = /^[\s，,。.!！?？:：;；"'“”‘’、·~—\-]+/u
const TRAILING_SEPARATOR = /^[\s，,。.!！?？:：;；"'“”‘’、·~—\-]+/u

function normalizePhrase(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function matchPhraseStart(text, phrases) {
  const normalized = text.replace(/\s+/g, ' ')
  const lower = normalized.toLowerCase()
  let best = null
  for (const phrase of phrases) {
    const candidate = normalizePhrase(phrase)
    if (!candidate) continue
    if (lower.startsWith(candidate)) {
      // Longest match wins so "use codex mode" beats a shorter accidental prefix.
      if (!best || candidate.length > best.length) {
        best = { length: candidate.length }
      }
    }
  }
  return best
}

/**
 * Parse a trigger from one message text.
 * @param {string} text raw message text (text blocks joined)
 * @param {{onPhrases?: readonly string[], offPhrases?: readonly string[]}} [options]
 * @returns {null | {action: 'on' | 'off', rest: string}}
 */
export function parseTrigger(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return null
  const onPhrases = options.onPhrases || DEFAULT_ON_PHRASES
  const offPhrases = options.offPhrases || DEFAULT_OFF_PHRASES

  // Work from the first non-noise position but keep the original text for `rest`.
  const leading = text.match(LEADING_NOISE)
  const start = leading ? leading[0].length : 0
  const body = text.slice(start)

  const offMatch = matchPhraseStart(body, offPhrases)
  const onMatch = matchPhraseStart(body, onPhrases)
  // Prefer the longer phrase when one is a prefix of the other across lists.
  const offLength = offMatch ? offMatch.length : -1
  const onLength = onMatch ? onMatch.length : -1
  const action = offLength >= onLength && offLength >= 0 ? 'off' : onLength >= 0 ? 'on' : null
  if (!action) return null

  const phraseLength = action === 'off' ? offLength : onLength
  let rest = body.slice(phraseLength)
  rest = rest.replace(TRAILING_SEPARATOR, '')
  return { action, rest: rest.trim() }
}
