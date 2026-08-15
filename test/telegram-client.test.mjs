#!/usr/bin/env node
/**
 * Unit tests for telegram-client.mjs against a mock Bot API server.
 * Run: node test/telegram-client.test.mjs
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import {
  createTelegramClient,
  chunkText,
  parseCommand,
  textOf,
  TelegramError,
} from '../telegram-client.mjs'

// ── Mock Bot API server ────────────────────────────────────────────────────

function startMockBot() {
  const state = {
    updates: [],          // queued updates to deliver
    offset: 0,            // last offset the client asked for
    calls: [],            // {method, params} log
    failNext: null,       // {code, description} to fail the next call with
    conflict: false,      // respond 409 to every getUpdates
    unauthorized: false,
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const parts = url.pathname.split('/') // ['', 'bot<token>', method]
    const method = parts[2]
    let params = {}
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      try { params = JSON.parse(body) } catch { /* keep {} */ }
    } else {
      params = Object.fromEntries(url.searchParams)
    }
    state.calls.push({ method, params })

    if (state.failNext) {
      const fail = state.failNext
      state.failNext = null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error_code: fail.code, description: fail.description }))
      return
    }
    if (method === 'getUpdates' && state.conflict) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }))
      return
    }
    if (method === 'getUpdates' && state.unauthorized) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
      return
    }

    let result
    switch (method) {
      case 'getMe':
        result = { id: 123456, username: 'test_bot', first_name: 'Test' }
        break
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0)
        state.offset = offset
        result = state.updates.filter((u) => u.update_id >= offset)
        break
      }
      case 'sendMessage':
        result = { message_id: state.calls.length, text: params.text }
        break
      case 'sendChatAction':
        result = true
        break
      default:
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error_code: 404, description: `unknown ${method}` }))
        return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result }))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────

const mock = await startMockBot()
const client = createTelegramClient({ token: 'test-token', apiBase: mock.base, timeoutMs: 5000 })

try {
  // getMe
  const me = await client.getMe()
  assert.equal(me.username, 'test_bot')
  console.log('PASS getMe')

  // getUpdates offset passthrough + filtering
  mock.state.updates = [
    { update_id: 1, message: { message_id: 1, chat: { id: 111, type: 'private' }, text: 'hi' } },
    { update_id: 2, message: { message_id: 2, chat: { id: 111, type: 'private' }, text: 'yo' } },
  ]
  let updates = await client.getUpdates({ offset: 1, timeout: 30 })
  assert.equal(updates.length, 2)
  assert.equal(mock.state.offset, 1)
  assert.equal(mock.state.calls.at(-1).params.timeout, 30)
  updates = await client.getUpdates({ offset: 3 })
  assert.equal(updates.length, 0)
  console.log('PASS getUpdates')

  // sendMessage chunking: message ids returned, chunks split at 4096
  const longText = '段落\n'.repeat(3000) // 9000 chars
  const ids = await client.sendMessage(111, longText)
  const sendCalls = mock.state.calls.filter((c) => c.method === 'sendMessage')
  assert.ok(sendCalls.length >= 3, `expected >=3 sendMessage calls, got ${sendCalls.length}`)
  assert.equal(ids.length, sendCalls.length)
  for (const c of sendCalls) {
    assert.ok(c.params.text.length <= 4096, `chunk too long: ${c.params.text.length}`)
  }
  console.log(`PASS sendMessage chunking (${sendCalls.length} chunks)`)

  // sendChatAction
  await client.sendChatAction(111, 'typing')
  assert.equal(mock.state.calls.at(-1).params.action, 'typing')
  console.log('PASS sendChatAction')

  // error mapping: 401 and 409
  mock.state.unauthorized = true
  await assert.rejects(() => client.getUpdates({}), (e) => e instanceof TelegramError && e.code === 401)
  mock.state.unauthorized = false
  mock.state.conflict = true
  await assert.rejects(() => client.getUpdates({}), (e) => e instanceof TelegramError && e.code === 409)
  mock.state.conflict = false
  console.log('PASS error mapping (401/409)')

  // generic error passthrough
  mock.state.failNext = { code: 400, description: 'Bad Request: message text is empty' }
  await assert.rejects(() => client.sendMessage(111, ''), (e) => e instanceof TelegramError && /message text is empty/.test(e.message))
  console.log('PASS generic error passthrough')
} finally {
  await mock.close()
}

// ── Pure helpers ───────────────────────────────────────────────────────────

assert.deepEqual(chunkText('short'), ['short'])
assert.deepEqual(chunkText('a'.repeat(5000)).join('').length, 5000)
const emoji = '😀'.repeat(3000) // 6000 code units; boundary must not split surrogate
const emojiChunks = chunkText(emoji, 4096)
assert.equal(emojiChunks.join(''), emoji)
for (const c of emojiChunks) {
  assert.ok(c.length <= 4096)
  assert.equal((c.match(/\uD83D/g) ?? []).length % 2, 0, 'no dangling high surrogate')
}
console.log('PASS chunkText (length/emoji boundaries)')

assert.deepEqual(parseCommand('/start'), { command: 'start', args: '' })
assert.deepEqual(parseCommand('/new  extra words '), { command: 'new', args: 'extra words' })
assert.equal(parseCommand('plain text'), undefined)
assert.equal(parseCommand('/带中文'), undefined)
console.log('PASS parseCommand')

assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'tool', callId: 'x' }, { type: 'text', text: 'b' }] }), 'a\nb')
assert.equal(textOf({ content: [] }), '')
assert.equal(textOf(undefined), '')
console.log('PASS textOf')

console.log('\nALL TELEGRAM-CLIENT TESTS PASSED')
