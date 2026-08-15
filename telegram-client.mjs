/**
 * Pure Telegram Bot API client for dsh-channel-telegram.
 * No DSH dependencies — unit-testable standalone against a mock server.
 */

/** Telegram API error, carrying the Bot API error_code when present. */
export class TelegramError extends Error {
  constructor(message, { code, httpStatus } = {}) {
    super(message)
    this.name = 'TelegramError'
    this.code = code       // Bot API error_code (401/409/400/...)
    this.httpStatus = httpStatus
  }
}

/**
 * @param {object} options
 * @param {string} options.token - bot token
 * @param {string} [options.apiBase] - API base (test override), default https://api.telegram.org
 * @param {number} [options.timeoutMs] - per-request timeout
 */
export function createTelegramClient({ token, apiBase = 'https://api.telegram.org', timeoutMs = 45_000 }) {
  async function apiCall(method, params = {}) {
    const url = `${apiBase}/bot${token}/${method}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      })
    } catch (error) {
      throw new TelegramError(`telegram ${method}: network error (${error.cause?.code ?? error.message})`, { httpStatus: 0 })
    } finally {
      clearTimeout(timer)
    }
    const raw = await res.text()
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      throw new TelegramError(`telegram ${method}: non-JSON response HTTP ${res.status}: ${raw.slice(0, 200)}`, { httpStatus: res.status })
    }
    if (body.ok !== true) {
      const code = body.error_code
      const description = body.description ?? `HTTP ${res.status}`
      if (code === 409) {
        throw new TelegramError(`telegram ${method}: 409 conflict — another getUpdates poller is running`, { code: 409, httpStatus: res.status })
      }
      if (code === 401) {
        throw new TelegramError(`telegram ${method}: 401 unauthorized — bot token invalid`, { code: 401, httpStatus: res.status })
      }
      throw new TelegramError(`telegram ${method}: ${description}`, { code, httpStatus: res.status })
    }
    return body.result
  }

  return {
    apiBase,
    /** Validate the token. Returns {id, username, first_name} or throws TelegramError. */
    async getMe() {
      return await apiCall('getMe')
    },
    /** Long-poll for updates. offset: lowest update id to return (older already seen). */
    async getUpdates({ offset = 0, timeout = 30 } = {}) {
      const result = await apiCall('getUpdates', { offset, timeout })
      return Array.isArray(result) ? result : []
    },
    /** Send a typing/uploading action so the user sees the bot is working. */
    async sendChatAction(chatId, action = 'typing') {
      return await apiCall('sendChatAction', { chat_id: chatId, action })
    },
    /**
     * Send a message, chunked to Telegram's 4096-char limit.
     * Returns the array of sent message ids.
     */
    async sendMessage(chatId, text, { parseMode } = {}) {
      const chunks = chunkText(text)
      const ids = []
      for (const chunk of chunks) {
        const params = { chat_id: chatId, text: chunk }
        if (parseMode !== undefined) params.parse_mode = parseMode
        const result = await apiCall('sendMessage', params)
        if (result?.message_id !== undefined) ids.push(result.message_id)
      }
      return ids
    },
    /** Plain API passthrough for future needs. */
    apiCall,
  }
}

/**
 * Split text into Telegram-safe chunks (<= max, default 4096), preferring
 * paragraph/line breaks; never splits a surrogate pair (emoji).
 */
export function chunkText(text, max = 4096) {
  if (text.length <= max) return [text]
  const chunks = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.5) cut = max
    // back off over surrogate pairs so emoji stay intact
    while (cut > 0 && cut < rest.length) {
      const code = rest.charCodeAt(cut)
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1
      else break
    }
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Parse a leading /command into {command, args}. */
export function parseCommand(text) {
  const match = /^\/([a-zA-Z0-9_]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return undefined
  return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() }
}

/** Extract plain text from a DSH message's content blocks (text blocks only). */
export function textOf(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Serialize long text into a single string with a truncation notice. */
export function truncateText(text, max = 200_000) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(截断，共 ${text.length} 字符)`
}
