/**
 * dsh-channel-telegram — thin Telegram bridge for DeepSeek Harness.
 *
 * Long-polls the Telegram Bot API, maps each allowed private chat to one DSH
 * agent session (deterministic session id `telegram-<chatId>`), drives turns
 * through the exact pattern the ACP bridge uses (`agents.create` ->
 * `agent.followup` -> `agent.whenIdle`), and replies with the final assistant
 * text. Session events are collected through the agent-scoped context, so
 * only this agent's events are seen.
 *
 * Security model (v1): access is gated by an explicit chat-id allowlist
 * (default: empty -> deny all). The agent inherits the host's global
 * permission settings, exactly like ACP/web sessions; run the bridge under a
 * restrictive permission preset or a dedicated DSH profile when the bot is
 * exposed to untrusted chats.
 *
 * Named exports only: the Loader's default unwrapping would discard the
 * `Config` schema (see docs/postmortem/0001).
 *
 * @module dsh-channel-telegram
 */

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createTelegramClient,
  parseCommand,
  textOf,
  truncateText,
} from './telegram-client.mjs'

export const name = 'dsh-channel-telegram'

export const inject = ['agents']

/** Plugin configuration. */
export const Config = Schema.object({
  /** Env var name holding the bot token (BotFather). */
  tokenEnv: Schema.string().default('TELEGRAM_BOT_TOKEN'),
  /** Private chat ids allowed to drive the agent. Empty = deny all. */
  allowlist: Schema.array(Schema.number()).default([]),
  /** Workspace (cwd) for agent sessions. Default ~/.dsh-telegram/workspace. */
  workspace: Schema.string(),
  /** Optional agent provider route (e.g. los-gateway); defaults to host default. */
  provider: Schema.string(),
  /** Optional model id on that route. */
  model: Schema.string(),
  /** Optional per-request max output tokens. */
  maxTokens: Schema.natural(),
  /** Telegram API base (test override). */
  apiBase: Schema.string().default('https://api.telegram.org'),
  /** Per-request timeout for Bot API calls. */
  requestTimeoutMs: Schema.natural().default(45_000),
  /** Pause between getUpdates long-polls after a batch. */
  pollIntervalMs: Schema.natural().default(500),
  /** Extra wait after a failed poll before retrying (cap). */
  backoffCapMs: Schema.natural().default(60_000),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const token = process.env[config.tokenEnv]
  if (!token || token.length === 0) {
    ctx.logger.error(`[dsh-channel-telegram] ${config.tokenEnv} is not set; plugin is inert`)
    return
  }
  if (config.allowlist.length === 0) {
    ctx.logger.warn('[dsh-channel-telegram] allowlist is empty — every chat is denied')
  }

  const workspace = config.workspace ?? join(homedir(), '.dsh-telegram', 'workspace')
  mkdirSync(workspace, { recursive: true })

  const telegram = createTelegramClient({
    token,
    apiBase: config.apiBase,
    timeoutMs: config.requestTimeoutMs,
  })
  const agents = ctx.agents

  /** @type {Map<number, {handle: any, agent: any, collector: any, queue: Promise<any>}>} */
  const byChat = new Map()
  /** Chats that already received the unauthorized notice. */
  const notified = new Set()
  let stopped = false

  // ── Agent creation (per chat, deterministic session id) ────────────────

  async function ensureAgent(chatId) {
    const existing = byChat.get(chatId)
    if (existing !== undefined) return existing

    const collector = { texts: [] }
    const handle = await agents.create({
      sessionId: SessionId(`telegram-${chatId}`),
      meta: { cwd: workspace },
      agentOptions: {
        ...config.provider !== undefined ? { provider: config.provider } : {},
        ...config.model !== undefined ? { model: config.model } : {},
        ...config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {},
      },
      setup: (agentCtx) => {
        // Agent-scoped: receives only this agent's session events.
        agentCtx.on('session/event', (_session, event) => {
          if (event.type === 'assistant/message') {
            const text = textOf(event.message)
            if (text.length > 0) collector.texts.push(text)
          }
        })
      },
    })

    const record = { handle, agent: handle.agent, collector, queue: Promise.resolve() }
    byChat.set(chatId, record)
    return record
  }

  // ── Turn execution (serialized per chat) ───────────────────────────────

  function enqueue(chatId, task) {
    const record = byChat.get(chatId)
    if (record === undefined) return Promise.resolve()
    record.queue = record.queue.then(async () => {
      if (stopped) return
      try {
        await task()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[dsh-channel-telegram] chat ${chatId}: ${message}`)
        await telegram.sendMessage(chatId, `⚠️ 错误：${truncateText(message, 3000)}`).catch(() => {})
      }
    })
    return record.queue
  }

  async function runTurn(chatId, text) {
    const record = await ensureAgent(chatId)
    record.collector.texts = []
    await telegram.sendChatAction(chatId, 'typing').catch(() => {})
    record.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await record.agent.whenIdle()
    // Multi-step tool turns emit several assistant/message events; the final
    // one is the answer (earlier ones are loop intermediates).
    const reply = truncateText(record.collector.texts.at(-1) ?? '(无输出)')
    await telegram.sendMessage(chatId, reply)
  }

  // ── Commands ───────────────────────────────────────────────────────────

  async function runCommand(chatId, text) {
    const parsed = parseCommand(text)
    const command = parsed?.command ?? ''
    switch (command) {
      case 'start': {
        await telegram.sendMessage(chatId,
          `👋 dsh-channel-telegram 已连接。\n\n本会话绑定 DSH agent（session: telegram-${chatId}）。\n\n发送任意文字开始对话；命令见 /help。`)
        break
      }
      case 'help': {
        await telegram.sendMessage(chatId,
          '命令：\n/start — 欢迎信息\n/new — 重置本聊天的 agent 会话\n/status — 会话状态\n/help — 本帮助')
        break
      }
      case 'new': {
        const record = byChat.get(chatId)
        if (record !== undefined) {
          await record.handle.dispose().catch(() => {})
          byChat.delete(chatId)
        }
        await telegram.sendMessage(chatId, '已重置会话（下次消息将创建全新 agent）')
        break
      }
      case 'status': {
        const record = byChat.get(chatId)
        if (record === undefined) {
          await telegram.sendMessage(chatId, '本聊天还没有 agent 会话；发送一条消息即可创建。')
        } else {
          const status = {
            sessionId: record.agent.id,
            status: record.agent.status,
            provider: record.agent.options.provider ?? '(host default)',
            model: record.agent.options.model ?? '(host default)',
            workspace,
          }
          await telegram.sendMessage(chatId, `状态：\n${JSON.stringify(status, null, 2)}`)
        }
        break
      }
      default: {
        await telegram.sendMessage(chatId, `未知命令 /${command}，/help 查看可用命令。`)
      }
    }
  }

  // ── Update handling ────────────────────────────────────────────────────

  async function handleUpdate(update) {
    const msg = update.message
    if (msg?.text === undefined || typeof msg.text !== 'string') return
    if (msg.chat?.type !== 'private') return
    const chatId = msg.chat.id

    if (!config.allowlist.includes(chatId)) {
      if (!notified.has(chatId)) {
        notified.add(chatId)
        ctx.logger.warn(`[dsh-channel-telegram] denied chat ${chatId} (not in allowlist)`)
        await telegram.sendMessage(chatId, '未授权：此 bot 只对配置的聊天开放。').catch(() => {})
      }
      return
    }

    await ensureAgent(chatId)
    const text = msg.text.trim()
    // Fire-and-forget: never block the poll loop on a long turn.
    void enqueue(chatId, async () => {
      if (text.startsWith('/')) await runCommand(chatId, text)
      else await runTurn(chatId, text)
    })
  }

  async function pollLoop() {
    let offset = 0
    let failures = 0
    while (!stopped) {
      try {
        const updates = await telegram.getUpdates({ offset, timeout: 30 })
        failures = 0
        for (const update of updates) {
          if (update.update_id >= offset) offset = update.update_id + 1
          void handleUpdate(update).catch((error) => {
            ctx.logger.warn(`[dsh-channel-telegram] update handling failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
      } catch (error) {
        failures += 1
        if (error instanceof Error && error.code === 409) {
          ctx.logger.error('[dsh-channel-telegram] 409 conflict — another poller is running; stopping polling')
          stopped = true
          break
        }
        if (error instanceof Error && error.code === 401) {
          ctx.logger.error('[dsh-channel-telegram] 401 — bot token invalid; stopping polling')
          stopped = true
          break
        }
        const backoff = Math.min(config.backoffCapMs, 1000 * 2 ** Math.min(failures, 6))
        ctx.logger.warn(`[dsh-channel-telegram] getUpdates failed (${error.message}); retry in ${backoff}ms`)
        await sleep(backoff)
        continue
      }
      await sleep(config.pollIntervalMs)
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  void (async () => {
    try {
      const me = await telegram.getMe()
      ctx.logger.info(`[dsh-channel-telegram] connected as @${me.username ?? me.id}`)
      void pollLoop()
    } catch (error) {
      ctx.logger.error(`[dsh-channel-telegram] startup failed (${error.message}); plugin is inert`)
    }
  })()

  ctx.on('dispose', () => {
    stopped = true
    void (async () => {
      for (const record of byChat.values()) {
        await record.handle.dispose().catch(() => {})
      }
    })()
  })
}
