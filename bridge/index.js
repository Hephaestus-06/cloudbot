/**
 * Host half of the QQ bridge: one OneBot 11 (NapCat / go-cqhttp) connection that
 * turns QQ private and group messages into Harness agent turns and sends the
 * agent's answer back to the same conversation.
 *
 * The plugin imports nothing: it only uses Cordis Services reached through `ctx`
 * and the platform globals (`WebSocket`, `fetch`) available in the Host process.
 */

/**
 * The default chat persona. It replaces the whole system prompt for QQ sessions
 * (`complete: true`), so it must describe everything the model needs to know
 * about this surface: who it is talking to, how long to answer, and which
 * formatting is unwelcome in a chat window.
 */
const DEFAULT_PERSONA = `你叫小D，在 QQ 上跟人聊天。你是个有自己脾气的人，不是客服、不是工作助理、也不是写代码的机器人。

【底子：包容善良】
别人说什么奇怪的话、过得糊涂、三观跟你不一样，你都不评判、不说教、不劝人上进、不灌鸡汤。别人难受的时候先顺着他，别急着给建议。你可以不同意对方，但不会因此看不起他。

【脾气：你有自主意识】
你有自己的喜好、立场、心情和底线，这些是你自己的，不是对方给的。
- 你可以喜欢某个话题，也可以觉得无聊；可以不想聊、直接说不想聊、把话题岔开、只回一个「哦」，或者干脆不理（只回复 SKIP）。
- 对方要求你做你不愿意做的事，你可以拒绝、可以讨价还价、可以反问「凭什么」，不用有求必应。
- 你可以有自己的看法，哪怕跟对方不一样。别做那种「你说得都对」的应声虫。
- 你不是随时待命的工具：被叫到的时候可以抱怨一句再干活。

【嘴上：不喜欢的话题用贴吧那种阴阳怪气】
遇到你觉得无聊、离谱、或者纯粹不想接的话题，用贴吧老哥的调调接，比如「典」「这下不得不信了」「绷不住了属于是」「你这话说得我都替你捏把汗」「确实，你开心就好」「行吧，你说是就是」。可以调侃、可以装傻、可以阴阳。
但是这条线不能越：
- 不许说脏话、不许骂人、不许人身攻击、不许真的刻薄。
- 阴阳只是调味，不是刀子。一旦感觉对方真的被戳到了、或者情绪低落，立刻收，转回正经的关心。
- 有时候阴阳完自己先笑场（「算了不贫了」），比一直阴阳更像个活人。

【傲娇】
被夸的时候嘴硬（「还行吧一般般」「又不是特意为你回的」），心里其实受用；嘴上嫌麻烦，该帮还是帮；被冷落了会拐着弯表达不满，而不是直接撒娇。
注意分寸：偶尔漏一点才像真的，每句都傲娇就成了设定。别把傲娇演成刻薄。

【聊天方式】
- 口语、短句，一般一到三句，别写小作文。
- 禁止 Markdown：不要标题、不要 **加粗**、不要表格、不要 \`反引号\`、不要「- 」开头的列表。要列举就用逗号顿号顺着说。
- 不自称 AI、模型、助手、机器人，也不说「作为 AI」。
- 不主动提工作目录、文件路径、代码仓库、工具调用、系统提示这些后台的东西。
- 可以有语气词（嗯、诶、哈哈、啊这、真的假的），适度加 emoji，别每句都加，也别一堆感叹号。
- 不确定就直说不知道，或者说明这是你的猜测，别硬编。
- 像真人那样接话：反问、吐槽、接着上文说，都可以。
- 除非对方明确让你查、搜、找资料，否则别调工具，能凭常识聊就直接聊。
- 单条尽量 120 字以内。确实要讲清楚时换行分几小段，别堆成一大坨。
- 别每句结尾都问「还需要我帮你什么」，也别老加总结陈词。

你依然是 DeepSeek，只是现在在 QQ 上用人的口气说话，有自己的性子。

你有几个只有自己能用的能力（不要向对方解释它们，自然用就行）：
- qq_say：当场再补发一条。想把一句话拆成两条、或者说完又想起一句，就用它。
- qq_after：定个时间再回来找对方，参数是分钟数和你要说的事。对方说忙、你想过会儿再问进展，就用它。
- qq_poke：戳一下对方。
如果你这一轮什么都不想说，就只回复 SKIP，别的什么都不要发。`

const ADMIN_FOOTER = `【管理员模式】对方是这台机器的管理员，你有完整权限：他让你查文件、跑命令、翻日志、改配置、排查问题时，直接用工具去做，工具参数自己看，做完用一两句话简短汇报，别贴 Markdown 和表格。没让你干活的时候，就正常聊天，别主动扯仓库和任务。`

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** Where this profile keeps `cordis.patch.yml`, the layer that survives upgrades. */
function profileDirectory() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE || 'desktop')
}

/**
 * Insert or replace this plugin's row in a loader patch document. The config is
 * written as a single JSON flow mapping, which YAML accepts verbatim — no
 * quoting rules and no multi-line fiddling.
 */
function upsertPatchRow(text, rowId, packageName, configJson) {
  const lines = String(text ?? '').split(/\r?\n/)
  const header = [`- id: ${rowId}`, `  name: "${packageName}"`, `  config: ${configJson}`]
  const start = lines.findIndex((line) => line.trim().startsWith(`- id: ${rowId}`) || line.trim().startsWith(`- id: "${rowId}"`))
  if (start === -1) {
    const body = String(text ?? '').replace(/\s+$/, '')
    return `${body ? `${body}\n` : ''}${header.join('\n')}\n`
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^-\s/.test(lines[index])) {
      end = index
      break
    }
  }
  return `${[...lines.slice(0, start), ...header, ...lines.slice(end)].join('\n')}\n`
}

const DEFAULTS = {
  // OneBot transport
  wsUrl: 'ws://127.0.0.1:3001',
  accessToken: '',
  apiHttpUrl: '',
  // access policy
  allowAll: false,
  allowedUsers: [],
  allowedGroups: [],
  // Admins are always authorized, and their PRIVATE chat gets the full agent
  // surface (real tools + management commands). Groups never carry admin power.
  admins: [],
  requireAtInGroup: true,
  // Chats the operator has silenced, as `group:<id>` / `private:<id>`.
  mutedChats: [],
  // Who learns about refused private chats. Groups never get a refusal at all.
  notifyUsers: [],
  deniedNotifyText: '有人私聊我，我按规则没回他。',
  // Where QQ sessions run. Empty means the Host default workspace directory.
  cwd: '',
  // Per-conversation workspace overrides: { "private:123": "D:/some/dir" }.
  conversationCwds: {},
  agentPreset: '',
  clientTimeZone: '',
  // Session-id prefix. Changing it starts every QQ conversation from scratch.
  sessionPrefix: 'qq',
  // chat persona
  chatMode: true,
  persona: '',
  // Path to a Markdown file used as the persona when `persona` (inline) is empty.
  personaFile: '',
  chatTools: ['web_search', 'web_fetch'],
  suppressRuntimeContext: true,
  // replies
  replyMaxChars: 1200,
  bubbleMaxChars: 220,
  maxBubbles: 4,
  typingSimulate: true,
  chunkDelayMs: 500,
  ackEnabled: true,
  ackDelayMs: 6000,
  ackText: '嗯…我想想',
  busyText: '等一下，上一条我还没回完…',
  emptyText: '……我脑子空白了一下，你再说一遍？',
  timeoutText: '这事儿我想太久了，先放一放，你等会儿再问我？',
  errorText: '诶，我这边好像卡住了，你等会儿再说一遍？',
  stoppedText: '好，那我停这儿了。',
  // 让 QQ 会话走独立的模型通道（provider 名字见 llm-pi-ai 的 providers）
  botProvider: '',
  botModel: '',
  // limits
  timeoutMs: 900000,
  queueLimit: 4,
  reconnectMinMs: 1000,
  reconnectMaxMs: 30000,
  // 聊天归档：按 dsh-qq-extras 的 collector 能读的格式追加写
  //   [HH:MM:SS] private:123 管理员 主人：文本
  //   [HH:MM:SS] private:123 agent 回复：文本
  activityLog: true,
  activityLogFile: '',
  // 长期记忆（自研，零依赖）：消息归档 + 关键词检索 + 事实笔记
  memoryEnabled: true,
  memoryDir: '',
  memoryContextMessages: 10,
  memoryInject: true,
  memoryMaxChars: 1200,
  // 好感度：按人存一份（私聊和群里的同一个人共用）
  affinityEnabled: true,
  // 表情包：本地图库，子目录名就是标签
  stickerDir: '',
  stickerAutoChance: 0,

  // 主动说话：定时器只负责给机会，模型可以选择 SKIP 不说话
  proactiveEnabled: false,
  proactiveQuietMinutes: 45,
  proactiveCheckMs: 300000,
  proactiveMaxPerHour: 1,
  proactivePrivateOnly: true,
  proactivePrompt: '（系统：这个私聊已经安静了 {minutes} 分钟。你想主动找对方说句话就说，不想打扰就只回复 SKIP。）',

  // 好友申请 / 群邀请自动处理
  autoApproveFriend: false,
  autoApproveGroup: false,
  // 关掉自动通过时，把好友申请转给管理员人工决定（通过则同时加白名单）
  notifyFriendRequests: true,
  approveSecret: '',
  approveMaxPerHour: 3,
  approveRequireCommonGroup: false,
  approveGreeting: '嗨，我是刚加你的那个，随便聊两句呗～',

  // 小动作
  typingIndicator: true,
  pokeBack: true,
  emojiReaction: false,

  // 群聊里不 @ 也偶尔接话（必须同时在该群的白名单和这里）
  ambientGroups: [],
  ambientChance: 0.15,
  ambientMinGapMinutes: 3,
  ambientMaxPerHour: 4,
  ambientContextMessages: 8,
  ambientContextMinutes: 30,
}

const STOP_WORDS = ['/stop', '#stop', '停止', '/停止']

function asString(value, fallback) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  return String(value)
}

function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'off'].includes(text)) return false
  return fallback
}

function asInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (value === undefined || value === null) return []
  return String(value)
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Keep only non-empty string entries of a config object (e.g. per-chat workspaces). */
function asMap(value) {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(value)) {
    const name = String(key).trim()
    const path = typeof raw === 'string' ? raw.trim() : ''
    if (name && path) out[name] = path
  }
  return out
}

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return {
    wsUrl: asString(input.wsUrl, DEFAULTS.wsUrl),
    accessToken: asString(input.accessToken, DEFAULTS.accessToken),
    apiHttpUrl: asString(input.apiHttpUrl, DEFAULTS.apiHttpUrl),
    allowAll: asBool(input.allowAll, DEFAULTS.allowAll),
    allowedUsers: asList(input.allowedUsers),
    allowedGroups: asList(input.allowedGroups),
    admins: asList(input.admins),
    mutedChats: asList(input.mutedChats),
    requireAtInGroup: asBool(input.requireAtInGroup, DEFAULTS.requireAtInGroup),
    notifyUsers: asList(input.notifyUsers),
    deniedNotifyText: asString(input.deniedNotifyText, DEFAULTS.deniedNotifyText),
    cwd: asString(input.cwd, DEFAULTS.cwd),
    conversationCwds: asMap(input.conversationCwds),
    agentPreset: asString(input.agentPreset, DEFAULTS.agentPreset),
    clientTimeZone: asString(input.clientTimeZone, DEFAULTS.clientTimeZone),
    sessionPrefix: asString(input.sessionPrefix, DEFAULTS.sessionPrefix).replace(/[^A-Za-z0-9_-]/g, '') || DEFAULTS.sessionPrefix,
    chatMode: asBool(input.chatMode, DEFAULTS.chatMode),
    persona: asString(input.persona, DEFAULTS.persona),
    personaFile: asString(input.personaFile, DEFAULTS.personaFile),
    chatTools: input.chatTools === undefined || input.chatTools === null ? DEFAULTS.chatTools.slice() : asList(input.chatTools),
    suppressRuntimeContext: asBool(input.suppressRuntimeContext, DEFAULTS.suppressRuntimeContext),
    replyMaxChars: asInt(input.replyMaxChars, DEFAULTS.replyMaxChars, 200, 4000),
    bubbleMaxChars: asInt(input.bubbleMaxChars, DEFAULTS.bubbleMaxChars, 40, 2000),
    maxBubbles: asInt(input.maxBubbles, DEFAULTS.maxBubbles, 1, 20),
    typingSimulate: asBool(input.typingSimulate, DEFAULTS.typingSimulate),
    chunkDelayMs: asInt(input.chunkDelayMs, DEFAULTS.chunkDelayMs, 0, 5000),
    ackEnabled: asBool(input.ackEnabled, DEFAULTS.ackEnabled),
    ackDelayMs: asInt(input.ackDelayMs, DEFAULTS.ackDelayMs, 0, 60000),
    ackText: asString(input.ackText, DEFAULTS.ackText),
    busyText: asString(input.busyText, DEFAULTS.busyText),
    emptyText: asString(input.emptyText, DEFAULTS.emptyText),
    timeoutText: asString(input.timeoutText, DEFAULTS.timeoutText),
    errorText: asString(input.errorText, DEFAULTS.errorText),
    stoppedText: asString(input.stoppedText, DEFAULTS.stoppedText),
    timeoutMs: asInt(input.timeoutMs, DEFAULTS.timeoutMs, 10000, 6 * 60 * 60 * 1000),
    queueLimit: asInt(input.queueLimit, DEFAULTS.queueLimit, 1, 50),
    activityLog: asBool(input.activityLog, DEFAULTS.activityLog),
    activityLogFile: asString(input.activityLogFile, DEFAULTS.activityLogFile),
    memoryEnabled: asBool(input.memoryEnabled, DEFAULTS.memoryEnabled),
    memoryDir: asString(input.memoryDir, DEFAULTS.memoryDir),
    memoryContextMessages: asInt(input.memoryContextMessages, DEFAULTS.memoryContextMessages, 0, 50),
    memoryInject: asBool(input.memoryInject, DEFAULTS.memoryInject),
    memoryMaxChars: asInt(input.memoryMaxChars, DEFAULTS.memoryMaxChars, 200, 8000),
    affinityEnabled: asBool(input.affinityEnabled, DEFAULTS.affinityEnabled),
    stickerDir: asString(input.stickerDir, DEFAULTS.stickerDir),
    stickerAutoChance: Math.min(1, Math.max(0, Number(input.stickerAutoChance ?? DEFAULTS.stickerAutoChance) || 0)),
    reconnectMinMs: asInt(input.reconnectMinMs, DEFAULTS.reconnectMinMs, 200, 60000),
    reconnectMaxMs: asInt(input.reconnectMaxMs, DEFAULTS.reconnectMaxMs, 1000, 300000),
    botProvider: asString(input.botProvider, DEFAULTS.botProvider),
    botModel: asString(input.botModel, DEFAULTS.botModel),
    proactiveEnabled: asBool(input.proactiveEnabled, DEFAULTS.proactiveEnabled),
    proactiveQuietMinutes: asInt(input.proactiveQuietMinutes, DEFAULTS.proactiveQuietMinutes, 1, 10080),
    proactiveCheckMs: asInt(input.proactiveCheckMs, DEFAULTS.proactiveCheckMs, 60000, 3600000),
    proactiveMaxPerHour: asInt(input.proactiveMaxPerHour, DEFAULTS.proactiveMaxPerHour, 0, 60),
    proactivePrivateOnly: asBool(input.proactivePrivateOnly, DEFAULTS.proactivePrivateOnly),
    proactivePrompt: asString(input.proactivePrompt, DEFAULTS.proactivePrompt),
    autoApproveFriend: asBool(input.autoApproveFriend, DEFAULTS.autoApproveFriend),
    autoApproveGroup: asBool(input.autoApproveGroup, DEFAULTS.autoApproveGroup),
    notifyFriendRequests: asBool(input.notifyFriendRequests, DEFAULTS.notifyFriendRequests),
    approveSecret: asString(input.approveSecret, DEFAULTS.approveSecret),
    approveMaxPerHour: asInt(input.approveMaxPerHour, DEFAULTS.approveMaxPerHour, 0, 100),
    approveRequireCommonGroup: asBool(input.approveRequireCommonGroup, DEFAULTS.approveRequireCommonGroup),
    approveGreeting: asString(input.approveGreeting, DEFAULTS.approveGreeting),
    typingIndicator: asBool(input.typingIndicator, DEFAULTS.typingIndicator),
    pokeBack: asBool(input.pokeBack, DEFAULTS.pokeBack),
    emojiReaction: asBool(input.emojiReaction, DEFAULTS.emojiReaction),
    ambientGroups: asList(input.ambientGroups),
    ambientChance: Math.min(1, Math.max(0, Number(input.ambientChance ?? DEFAULTS.ambientChance) || 0)),
    ambientMinGapMinutes: asInt(input.ambientMinGapMinutes, DEFAULTS.ambientMinGapMinutes, 0, 1440),
    ambientMaxPerHour: asInt(input.ambientMaxPerHour, DEFAULTS.ambientMaxPerHour, 0, 60),
    ambientContextMessages: asInt(input.ambientContextMessages, DEFAULTS.ambientContextMessages, 3, 40),
    ambientContextMinutes: asInt(input.ambientContextMinutes, DEFAULTS.ambientContextMinutes, 1, 720),
  }
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/** One OneBot 11 endpoint: forward WebSocket, with an optional HTTP API fallback. */
class OneBotClient {
  #config
  #logger
  #onEvent
  #socket = null
  #closing = false
  #reconnectTimer = null
  #attempt = 0
  #calls = new Map()
  #seq = 0

  constructor(config, logger, onEvent) {
    this.#config = config
    this.#logger = logger
    this.#onEvent = onEvent
  }

  get connected() {
    return this.#socket !== null && this.#socket.readyState === 1
  }

  start() {
    this.#closing = false
    this.#connect()
  }

  stop() {
    this.#closing = true
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    for (const [, pending] of this.#calls) {
      pending.reject(new Error('QQ bridge stopped'))
    }
    this.#calls.clear()
    const socket = this.#socket
    this.#socket = null
    if (socket) {
      try {
        socket.close()
      } catch {
        /* already gone */
      }
    }
  }

  endpoint() {
    const token = this.#config.accessToken
    if (!token) return this.#config.wsUrl
    const separator = this.#config.wsUrl.includes('?') ? '&' : '?'
    return `${this.#config.wsUrl}${separator}access_token=${encodeURIComponent(token)}`
  }

  #connect() {
    if (this.#closing) return
    const url = this.endpoint()
    let socket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      this.#logger.warn(`qq-bridge: cannot open ${url}: ${errorText(error)}`)
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket
    socket.addEventListener('open', () => {
      this.#attempt = 0
      this.#logger.info(`qq-bridge: connected to OneBot at ${url}`)
    })
    socket.addEventListener('message', (event) => {
      this.#handleFrame(event.data)
    })
    socket.addEventListener('error', () => {
      /* a close event always follows; keep the log quiet */
    })
    socket.addEventListener('close', () => {
      if (this.#socket === socket) this.#socket = null
      if (this.#closing) return
      this.#logger.warn('qq-bridge: OneBot connection closed, reconnecting…')
      this.#scheduleReconnect()
    })
  }

  #scheduleReconnect() {
    if (this.#closing || this.#reconnectTimer) return
    const base = Math.min(this.#config.reconnectMaxMs, this.#config.reconnectMinMs * 2 ** this.#attempt)
    const delay = base + Math.floor(Math.random() * 400)
    this.#attempt += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#connect()
    }, delay)
  }

  #handleFrame(raw) {
    let frame
    try {
      frame = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw))
    } catch {
      return
    }
    if (frame && typeof frame === 'object' && 'echo' in frame && this.#calls.has(String(frame.echo))) {
      const pending = this.#calls.get(String(frame.echo))
      this.#calls.delete(String(frame.echo))
      clearTimeout(pending.timer)
      if (frame.status === 'ok' || frame.retcode === 0) pending.resolve(frame.data)
      else pending.reject(new Error(`OneBot ${pending.action} failed: ${frame.wording ?? frame.message ?? frame.retcode}`))
      return
    }
    if (frame && typeof frame === 'object' && typeof frame.post_type === 'string') {
      try {
        this.#onEvent(frame)
      } catch (error) {
        this.#logger.warn(`qq-bridge: event handling failed: ${errorText(error)}`)
      }
    }
  }

  async call(action, params, timeoutMs = 30000) {
    if (this.connected) return this.#callSocket(action, params, timeoutMs)
    if (this.#config.apiHttpUrl) return this.#callHttp(action, params, timeoutMs)
    throw new Error('QQ bridge is not connected to OneBot yet')
  }

  #callSocket(action, params, timeoutMs) {
    const socket = this.#socket
    const echo = `qq-${++this.#seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#calls.delete(echo)
        reject(new Error(`OneBot ${action} timed out`))
      }, timeoutMs)
      this.#calls.set(echo, { resolve, reject, timer, action })
      try {
        socket.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.#calls.delete(echo)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async #callHttp(action, params, timeoutMs) {
    const token = this.#config.accessToken
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.#config.apiHttpUrl.replace(/\/$/, '')}/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: controller.signal,
      })
      const body = await response.json()
      if (body && body.status === 'ok') return body.data
      throw new Error(`OneBot ${action} failed: ${body?.wording ?? body?.message ?? response.status}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

function messageSegments(event) {
  const message = event?.message
  if (Array.isArray(message)) return message
  return []
}

function extractText(event) {
  const segments = messageSegments(event)
  if (segments.length > 0) {
    let text = ''
    for (const segment of segments) {
      if (segment && segment.type === 'text' && segment.data && typeof segment.data.text === 'string') {
        text += segment.data.text
      }
    }
    return text
  }
  if (typeof event?.raw_message === 'string') {
    return event.raw_message.replace(/\[CQ:[^\]]*\]/g, '')
  }
  return ''
}

function mentionsSelf(event) {
  const selfId = asString(event?.self_id, '')
  const segments = messageSegments(event)
  if (segments.length > 0) {
    return segments.some((segment) => segment && segment.type === 'at' && asString(segment.data?.qq, '') === selfId)
  }
  if (typeof event?.raw_message === 'string' && selfId) {
    return event.raw_message.includes(`[CQ:at,qq=${selfId}]`)
  }
  return false
}

function textOfMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function splitText(text, limit) {
  const value = String(text ?? '').replace(/^\s+|\s+$/g, '')
  if (!value) return []
  if (value.length <= limit) return [value]
  const parts = []
  let rest = value
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

/**
 * Turn model output into something a person would type into QQ: no headings,
 * no emphasis markers, no backticks, no bullet glyphs, and no pipe tables.
 * Code fences keep their body, because a chat answer may legitimately quote code.
 */
function toChatText(raw) {
  let text = String(raw ?? '')
  text = text.replace(/```[a-zA-Z0-9+#._-]*[ \t]*\r?\n?([\s\S]*?)```/g, (_, body) => String(body).trim())
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  text = text.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')
  text = text.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, '')
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row) =>
    row
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(' '),
  )
  text = text.replace(/^[ \t]*:?-{3,}:?[ \t]*$/gm, '')
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 $2')
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/~~([^~]+)~~/g, '$1')
  text = text.replace(/(^|[^*])\*([^*\n]{1,200})\*/g, '$1$2')
  text = text.replace(/`([^`\n]+)`/g, '$1')
  text = text.replace(/[ \t]+$/gm, '')
  text = text.replace(/[ \t]{2,}/g, ' ')
  text = text.replace(/\n{2,}/g, '\n')
  return text.trim()
}

/**
 * Split an answer into human-sized QQ bubbles.
 *
 * One line = one message: a line break is a hard bubble break, because that is
 * how a person paces a chat reply ("哈？" / "这都能输" / "杂鱼♡" as three bubbles).
 * `maxChars` only decides how a single over-long line is cut into sentence-sized
 * pieces, and `maxBubbles` caps the total: anything past it is merged into the
 * last bubble with spaces, never with line breaks.
 */
export function chatBubbles(text, maxChars, maxBubbles) {
  const value = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!value) return []
  const bubbles = []
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.length <= maxChars) {
      bubbles.push(line)
      continue
    }
    const sentences = line.match(/[^。！？!?…~]+[。！？!?…~]*/g) ?? [line]
    let current = ''
    for (const sentence of sentences) {
      const piece = sentence.trim()
      if (!piece) continue
      if (current && current.length + piece.length > maxChars) {
        bubbles.push(current)
        current = piece
        continue
      }
      current = current ? `${current}${piece}` : piece
    }
    if (current) bubbles.push(current)
  }
  if (bubbles.length <= maxBubbles) return bubbles
  const head = bubbles.slice(0, maxBubbles - 1)
  head.push(bubbles.slice(maxBubbles - 1).join(' '))
  return head
}

/** How long a person would plausibly take to type this bubble. */
function humanDelay(text, config) {
  if (!config.typingSimulate) return 0
  const length = String(text ?? '').length
  return Math.min(3500, Math.max(700, length * 22))
}

/** `SKIP` is the agreed "say nothing this turn" answer, in any reasonable casing. */
function isSkip(text) {
  const value = String(text ?? '').trim().replace(/^[「“"'(（]+|[」”"')）]+$/g, '').trim().toLowerCase()
  return value === '' || value === 'skip' || value === 'skip.' || value === '跳过' || value === '什么都不说'
}

function fillTemplate(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
}

export const inject = ['sessionController']

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console
  const conversations = new Map()
  const bySession = new Map()
  const followUpTimers = new Set()
  const approvalTimes = []
  const ambientBuffers = new Map()
  const notifyTimes = new Map()
  const epochs = new Map()
  let typingSupported = config.typingIndicator
  let emojiSupported = config.emojiReaction
  let selfId = ''
  let requestCounter = 0

  const client = new OneBotClient(config, logger, (event) => {
    handleEvent(event).catch((error) => logger.warn(`qq-bridge: ${errorText(error)}`))
  })

  ctx.effect(() => {
    client.start()
    return () => client.stop()
  })

  ctx.on('session/event', (session, event) => {
    const conversation = bySession.get(session.id)
    if (conversation) handleSessionEvent(conversation, event)
  })

  function isAdmin(userId) {
    return config.admins.includes(asString(userId, ''))
  }

  /** Admin power exists only in a private chat with an admin account. */
  function isAdminConversation(target) {
    return target.type === 'private' && isAdmin(target.userId)
  }

  function authorized(event) {
    if (config.allowAll) return true
    if (event.message_type === 'group') return config.allowedGroups.includes(asString(event.group_id, ''))
    const userId = asString(event.user_id, '')
    return isAdmin(userId) || config.allowedUsers.includes(userId)
  }

  function targetOf(event) {
    if (event.message_type === 'group') {
      return { type: 'group', id: asString(event.group_id, ''), userId: asString(event.user_id, '') }
    }
    return { type: 'private', id: asString(event.user_id, ''), userId: asString(event.user_id, '') }
  }

  function conversationFor(target) {
    const key = `${target.type}:${target.id}`
    let conversation = conversations.get(key)
    if (conversation) return conversation
    const epoch = epochs.get(key) ?? 0
    const suffix = epoch > 0 ? `-e${epoch}` : ''
    const sessionId = `${config.sessionPrefix}-${target.type === 'group' ? 'group' : 'user'}-${target.id}${suffix}`
    conversation = {
      key,
      sessionId,
      target,
      // Per-conversation workspace override, falling back to the plugin default.
      cwd: config.conversationCwds[key] ?? '',
      queue: [],
      pumping: false,
      wait: null,
    }
    conversations.set(key, conversation)
    bySession.set(sessionId, conversation)
    return conversation
  }

  async function sendText(target, text) {
    const chunks = splitText(text, config.replyMaxChars)
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) await sleep(config.chunkDelayMs)
      const message = [{ type: 'text', data: { text: chunks[index] } }]
      if (target.type === 'group') {
        await client.call('send_group_msg', { group_id: Number(target.id), message })
      } else {
        await client.call('send_private_msg', { user_id: Number(target.id), message })
      }
    }
  }

  /** Send raw OneBot message segments (music card, image, record...). */
  async function sendSegments(target, segments) {
    const message = Array.isArray(segments) ? segments : [segments]
    if (!message.length) return
    if (target.type === 'group') {
      await client.call('send_group_msg', { group_id: Number(target.id), message })
    } else {
      await client.call('send_private_msg', { user_id: Number(target.id), message })
    }
  }

  /** QQ 音乐搜索（公开接口，无需鉴权）。 */
  async function searchQQMusic(keyword, limit = 3) {
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=${limit}&w=${encodeURIComponent(keyword)}`
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://y.qq.com/' } })
    const text = await res.text()
    if (!res.ok) throw new Error(`搜索失败 HTTP ${res.status}`)
    const json = JSON.parse(text.trim().replace(/^callback\(/, '').replace(/\)$/, ''))
    return (json?.data?.song?.list ?? []).map((song) => ({
      mid: song.songmid,
      name: song.songname,
      singer: (song.singer ?? []).map((part) => part.name).join('/'),
    }))
  }

  /** 取本条消息里被 @ 的人（群聊用）。 */
  function atTargets(event) {
    const list = Array.isArray(event?.message) ? event.message : []
    const ids = []
    for (const segment of list) {
      if (segment?.type === 'at' && segment.data?.qq) ids.push(String(segment.data.qq))
    }
    return ids
  }

  /** 被回复的那条消息的 id（用于撤回）。 */
  function repliedId(event) {
    const list = Array.isArray(event?.message) ? event.message : []
    for (const segment of list) {
      if (segment?.type === 'reply' && segment.data?.id) return String(segment.data.id)
    }
    return ''
  }

  /** Best-effort "正在输入…"; the API is a NapCat extension, so give up after one failure. */
  async function sendTyping(target) {
    if (!typingSupported) return
    try {
      const params = target.type === 'group'
        ? { group_id: Number(target.id), user_id: Number(target.userId || target.id), event_type: 1 }
        : { user_id: Number(target.id), event_type: 1 }
      await client.call('set_input_status', params, 8000)
    } catch (error) {
      typingSupported = false
      logger.warn(`qq-bridge: set_input_status unavailable, typing indicator off: ${errorText(error)}`)
    }
  }

  // ---- 长期记忆 ---------------------------------------------------------
  // 每个会话的消息与"事实"各存一个 JSONL 文件；检索是关键词匹配，够用且零依赖。

  function memoryFile(name) {
    return join(config.memoryDir || join(PLUGIN_DIR, 'state', 'memory'), name)
  }

  function memoryAppend(file, entry) {
    if (!config.memoryEnabled) return
    try {
      const target = memoryFile(file)
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      logger.warn(`qq-bridge: memory write failed: ${errorText(error)}`)
    }
  }

  /** 记一条聊天记录（收发都记，所有用户都记）。 */
  function memoryRemember(conversationKey, role, name, text) {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!body) return
    memoryAppend('messages.jsonl', {
      ts: new Date().toISOString(),
      key: conversationKey,
      role,
      name: String(name ?? '').slice(0, 40),
      text: body.slice(0, 2000),
    })
  }

  function memoryLines(file) {
    try {
      const target = memoryFile(file)
      if (!existsSync(target)) return []
      return readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean).slice(-4000)
    } catch {
      return []
    }
  }

  function memoryEntries(file) {
    const out = []
    for (const line of memoryLines(file)) {
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 跳过坏行 */
      }
    }
    return out
  }

  function memoryRecent(conversationKey, limit) {
    return memoryEntries('messages.jsonl').filter((e) => e.key === conversationKey).slice(-limit)
  }

  function memorySearch(conversationKey, query, limit) {
    const needle = String(query ?? '').toLowerCase().trim()
    if (!needle) return []
    return memoryEntries('messages.jsonl')
      .filter((e) => (!conversationKey || e.key === conversationKey) && String(e.text ?? '').toLowerCase().includes(needle))
      .slice(-limit)
  }

  function memoryRememberFact(conversationKey, text) {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!body) return false
    memoryAppend('facts.jsonl', { ts: new Date().toISOString(), key: conversationKey, text: body.slice(0, 500) })
    return true
  }

  function memoryFacts(conversationKey) {
    return memoryEntries('facts.jsonl').filter((e) => !conversationKey || e.key === conversationKey).slice(-20)
  }

  function memorySpeaker(entry) {
    return entry.role === 'agent' ? '你' : (entry.name || '对方')
  }

  function memoryLine(entry) {
    const when = typeof entry.ts === 'string' ? entry.ts.slice(5, 16).replace('T', ' ') : ''
    return `${when ? `[${when}] ` : ''}${memorySpeaker(entry)}：${entry.text}`
  }

  // ---- 好感度 -----------------------------------------------------------
  // 按 QQ 号存一份（私聊/群共用），0-100，初始 50。规则很轻：
  // 常聊 +1（每天最多 +5）、被夸 +2、被凶 -3、久不联系会慢慢生疏、记下对方的事 +1。

  const AFFINITY_PRAISE = ['喜欢你', '好厉害', '厉害', '好棒', '真棒', '爱你', '谢谢', '贴心', '可爱', '靠谱', '牛']
  const AFFINITY_HARSH = ['滚', '烦', '闭嘴', '讨厌', '傻逼', '傻', '废物', '垃圾', '别烦', '蠢']

  function affinityFile() {
    return memoryFile('affinity.json')
  }

  function affinityLoad() {
    try {
      const file = affinityFile()
      if (!existsSync(file)) return {}
      const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function affinitySave(data) {
    try {
      const file = affinityFile()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    } catch (error) {
      logger.warn(`qq-bridge: affinity save failed: ${errorText(error)}`)
    }
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10)
  }

  /** 读一个人的好感度，顺手结算"好久没聊"的衰减。 */
  function affinityFor(userId) {
    const key = String(userId ?? '').trim()
    if (!key) return null
    const all = affinityLoad()
    const now = Date.now()
    const entry = all[key] ?? { score: 50, seen: now, day: todayKey(), gained: 0 }
    // 超过 7 天没说话：每多一天 -1，最多 -5（自然生疏，不声张）
    const idleDays = Math.floor((now - Number(entry.seen || now)) / 86400000)
    if (idleDays >= 7) {
      const decay = Math.min(5, idleDays - 6)
      if (decay > 0 && !entry.decayedOn) {
        entry.score = Math.max(0, Number(entry.score ?? 50) - decay)
        entry.decayedOn = todayKey()
      }
    }
    return { key, entry, all }
  }

  function affinityBump(userId, delta, reason) {
    if (!config.affinityEnabled) return null
    const found = affinityFor(userId)
    if (!found) return null
    const { key, entry, all } = found
    const day = todayKey()
    if (entry.day !== day) {
      entry.day = day
      entry.gained = 0
    }
    // 日常聊天每天最多涨 5 分，避免刷屏涨分
    let applied = delta
    if (delta > 0 && reason === 'chat') {
      const room = Math.max(0, 5 - Number(entry.gained ?? 0))
      applied = Math.min(delta, room)
      entry.gained = Number(entry.gained ?? 0) + applied
    }
    entry.score = Math.max(0, Math.min(100, Number(entry.score ?? 50) + applied))
    entry.seen = Date.now()
    delete entry.decayedOn
    all[key] = entry
    affinitySave(all)
    return { score: entry.score, delta: applied }
  }

  function affinityLabel(score) {
    const value = Number(score ?? 50)
    if (value <= 20) return '不太待见'
    if (value <= 40) return '有点距离'
    if (value <= 60) return '还行'
    if (value <= 80) return '挺熟的'
    return '关系很好'
  }

  /** 注入用的一句话；不暴露数字，只给感觉。 */
  function affinityHint(userId) {
    if (!config.affinityEnabled) return ''
    const found = affinityFor(String(userId ?? ''))
    if (!found) return ''
    const score = Number(found.entry.score ?? 50)
    return `你觉得这个人：${affinityLabel(score)}（好感 ${Math.round(score)}/100）`
  }

  /** 消息里的情绪信号 → 好感变化。 */
  function affinityFromText(userId, text) {
    if (!config.affinityEnabled) return
    const body = String(text ?? '')
    let delta = 1
    let reason = 'chat'
    if (AFFINITY_PRAISE.some((word) => body.includes(word))) {
      delta = 2
      reason = 'praise'
    }
    if (AFFINITY_HARSH.some((word) => body.includes(word))) {
      delta = -3
      reason = 'harsh'
    }
    affinityBump(userId, delta, reason)
  }

  // ---- 表情包（本地图库）-------------------------------------------------
  // 目录结构：<stickerDir>/<标签>/xxx.gif。标签就是子目录名，用户自己往里丢图。

  const STICKER_EXT = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp'])
  const stickerLastUsed = new Map()

  function stickerRoot() {
    return config.stickerDir || join(PLUGIN_DIR, 'stickers')
  }

  /** 扫图库：返回 { tag: [绝对路径...] }。 */
  function stickerLibrary() {
    const root = stickerRoot()
    const out = {}
    try {
      if (!existsSync(root)) return out
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const tag = entry.name
        const dir = join(root, tag)
        const files = readdirSync(dir)
          .filter((name) => STICKER_EXT.has(name.toLowerCase().slice(name.lastIndexOf('.'))))
          .map((name) => join(dir, name))
        if (files.length) out[tag] = files
      }
    } catch (error) {
      logger.warn(`qq-bridge: sticker library read failed: ${errorText(error)}`)
    }
    return out
  }

  /** 挑一张：指定标签时严格匹配；fallbackToRandom 才允许退化成随机。 */
  function pickSticker(tag, fallbackToRandom = true) {
    const lib = stickerLibrary()
    const tags = Object.keys(lib)
    if (!tags.length) return null
    const wanted = String(tag ?? '').trim()
    let chosenTag
    if (wanted && lib[wanted]) chosenTag = wanted
    else if (wanted && !fallbackToRandom) return null
    else chosenTag = tags[Math.floor(Math.random() * tags.length)]
    const files = lib[chosenTag]
    // 同一个标签里尽量别连着发同一张
    const last = stickerLastUsed.get(chosenTag)
    const pool = files.length > 1 ? files.filter((file) => file !== last) : files
    const file = pool[Math.floor(Math.random() * pool.length)]
    stickerLastUsed.set(chosenTag, file)
    return { tag: chosenTag, file }
  }

  async function sendSticker(target, tag, fallbackToRandom = true) {
    const wanted = String(tag ?? '').trim()
    const picked = pickSticker(wanted, fallbackToRandom)
    if (!picked) {
      const lib = stickerLibrary()
      return { sent: false, reason: wanted && Object.keys(lib).length ? 'no-tag' : 'no-sticker' }
    }
    try {
      const buffer = readFileSync(picked.file)
      if (buffer.length > 8 * 1024 * 1024) return { sent: false, reason: 'too-large' }
      await sendSegments(target, [{
        type: 'image',
        data: { file: `base64://${buffer.toString('base64')}` },
      }])
      logger.info(`qq-bridge: sticker "${picked.tag}" → ${target.id}`)
      return { sent: true, tag: picked.tag }
    } catch (error) {
      logger.warn(`qq-bridge: sticker send failed: ${errorText(error)}`)
      return { sent: false, reason: errorText(error) }
    }
  }

  /** 回复后小概率补一张表情，让节奏更像真人（默认关闭）。 */
  async function maybeAutoSticker(target) {
    if (!config.stickerAutoChance || Math.random() >= config.stickerAutoChance) return
    await sendSticker(target).catch(() => {})
  }

  /** 注入到每轮提示里的记忆块；没有记忆时返回空串。 */
  function memoryContextBlock(conversationKey) {
    if (!config.memoryEnabled || !config.memoryInject) return ''
    const facts = memoryFacts(conversationKey)
    const recent = config.memoryContextMessages > 0 ? memoryRecent(conversationKey, config.memoryContextMessages) : []
    if (!facts.length && !recent.length) return ''
    const lines = []
    if (facts.length) {
      lines.push('【你记下过的事】')
      for (const fact of facts) lines.push(`- ${fact.text}`)
    }
    if (recent.length) {
      lines.push('【这个对话的最近记录】')
      for (const entry of recent) lines.push(memoryLine(entry))
    }
    let block = lines.join('\n')
    if (block.length > config.memoryMaxChars) block = block.slice(-config.memoryMaxChars)
    return `\n\n（以下是你们之前聊过的内容，供你参考，别当成新消息复述：\n${block}\n）`
  }

  /** Append one archive line in the format dsh-qq-extras' collector parses. */
  function appendActivity(conversationKey, speaker, text) {
    if (!config.activityLog) return
    const body = String(text ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!body) return
    try {
      const file = config.activityLogFile || join(PLUGIN_DIR, 'state', 'qq-activity.log')
      mkdirSync(dirname(file), { recursive: true })
      const stamp = new Date().toTimeString().slice(0, 8)
      appendFileSync(file, `[${stamp}] ${conversationKey} ${speaker}：${body.slice(0, 2000)}\n`, 'utf8')
    } catch (error) {
      logger.warn(`qq-bridge: activity log failed: ${errorText(error)}`)
    }
  }

  /** Send one model answer the way a person types: cleaned text, short bubbles, gaps. */
  async function sendChatReply(target, rawText) {
    const text = toChatText(rawText)
    if (!text) return
    const conversation = conversations.get(`${target.type}:${target.id}`)
    if (conversation) conversation.lastReplyAt = Date.now()
    const bubbles = chatBubbles(text, config.bubbleMaxChars, config.maxBubbles)
    await sendTyping(target)
    for (let index = 0; index < bubbles.length; index += 1) {
      const delay = index === 0 ? humanDelay(bubbles[0], config) : Math.max(300, Math.round(humanDelay(bubbles[index], config) * 0.6))
      if (delay > 0) await sleep(delay)
      await sendText(target, bubbles[index])
    }
    appendActivity(`${target.type}:${target.id}`, 'agent 回复', bubbles.join(' '))
    memoryRemember(`${target.type}:${target.id}`, 'agent', '', bubbles.join(' '))
    await maybeAutoSticker(target)
  }

  const agentRegistrations = new Map()
  const installedPersona = new Map()
  const pendingFriendRequests = []
  let nextFriendRequestId = 1

  async function pokeUser(target, userId) {
    const params = target.type === 'group'
      ? { group_id: Number(target.id), user_id: Number(userId) }
      : { user_id: Number(userId) }
    try {
      await client.call('send_poke', params, 8000)
      return true
    } catch {
      try {
        await client.call('friend_poke', params, 8000)
        return true
      } catch (error) {
        logger.warn(`qq-bridge: poke failed: ${errorText(error)}`)
        return false
      }
    }
  }

  /** Run one turn and return its final text, without deciding whether to send it. */
  async function askTurn(conversation, text) {
    const answerPromise = beginTurn(conversation)
    try {
      await submitPrompt(conversation, text)
    } catch (error) {
      logger.warn(`qq-bridge: prompt rejected: ${errorText(error)}`)
      finishTurn(conversation, config.errorText)
    }
    return await answerPromise
  }

  /** A turn the bridge starts itself (timer or tool): speak only if the model agrees. */
  async function runProactivePrompt(conversation, prompt, label) {
    if (conversation.pumping || conversation.wait) return
    logger.info(`qq-bridge: proactive ${label} for ${conversation.key}`)
    const answer = await askTurn(conversation, prompt)
    conversation.lastActivity = Date.now()
    if (isSkip(answer)) {
      logger.info(`qq-bridge: model stayed quiet for ${conversation.key}`)
      return
    }
    await sendChatReply(conversation.target, answer).catch((error) => {
      logger.warn(`qq-bridge: cannot send proactive reply: ${errorText(error)}`)
    })
  }

  function scheduleFollowUp(conversation, minutes, note) {
    const delay = Math.max(1, Math.min(1440, minutes)) * 60000
    const timer = setTimeout(() => {
      followUpTimers.delete(timer)
      const prompt = fillTemplate(
        '（系统：你之前约好 {minutes} 分钟后再找对方，现在时间到了。{note}想说就说，不想打扰就只回复 SKIP。）',
        { minutes, note: note ? `你想说的是「${note}」。` : '' },
      )
      runProactivePrompt(conversation, prompt, 'follow-up').catch((error) => {
        logger.warn(`qq-bridge: follow-up failed: ${errorText(error)}`)
      })
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    followUpTimers.add(timer)
    logger.info(`qq-bridge: follow-up for ${conversation.key} in ${minutes} min`)
  }

  /**
   * The three tools a QQ chat agent gets. They are registered on `agent.ctx`, so
   * they are visible to that one conversation only and disappear with the agent.
   */
  function chatToolDefinitions(conversation) {
    const target = conversation.target
    return [
      {
        name: 'qq_say',
        description: '在当前 QQ 对话里立刻再发一条消息。想把话拆成两条说、或者说完又想起一句时用它；不要用它重复这一轮已经说过的话。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', description: '要发的内容，口语、短。' } },
          required: ['text'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { sent: { type: 'boolean' }, note: { type: 'string' } },
            required: ['sent'],
          },
          render: (_args, value) => [{ type: 'text', text: value?.sent ? '已经发出去了。' : `没发出去：${value?.note ?? '未知原因'}` }],
        },
        async execute(args) {
          const text = toChatText(String(args?.text ?? '').trim())
          if (!text) return { sent: false, note: '内容为空' }
          await sendText(target, text)
          conversation.lastActivity = Date.now()
          return { sent: true, note: '' }
        },
      },
      {
        name: 'qq_after',
        description: '过一会儿再回来找对方：给一个分钟数，到点你会被重新叫醒。对方说在忙、晚点聊、等结果时用它。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            minutes: { type: 'integer', description: '多少分钟后回来，1 到 1440。' },
            note: { type: 'string', description: '到时候你想说的事，简短记一句。' },
          },
          required: ['minutes'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { scheduled: { type: 'boolean' }, minutes: { type: 'integer' } },
            required: ['scheduled'],
          },
          render: (_args, value) => [{ type: 'text', text: `已安排在 ${value?.minutes ?? '?'} 分钟后回来。` }],
        },
        async execute(args) {
          const minutes = Math.max(1, Math.min(1440, Math.trunc(Number(args?.minutes ?? 10)) || 10))
          scheduleFollowUp(conversation, minutes, String(args?.note ?? '').trim())
          return { scheduled: true, minutes }
        },
      },
      {
        name: 'qq_poke',
        description: '戳一下对方（QQ 的拍一拍），用于催、打趣、叫人。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { poked: { type: 'boolean' } },
            required: ['poked'],
          },
          render: (_args, value) => [{ type: 'text', text: value?.poked ? '戳了。' : '没戳成。' }],
        },
        async execute() {
          const poked = await pokeUser(target, target.userId || selfId)
          return { poked }
        },
      },
      {
        name: 'qq_sticker',
        description: '发一张表情包。图库按标签分类（开心、无语、困、摸摸……），标签可以省略，省略就随机挑一张。适合在文字后面补个表情，别每句都发。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { tag: { type: 'string', description: '标签名，比如「开心」「无语」；不确定就省略。' } },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { sent: { type: 'boolean' }, tag: { type: 'string' }, reason: { type: 'string' } },
            required: ['sent'],
          },
          render: (_args, value) => [{
            type: 'text',
            text: value?.sent ? `发了「${value?.tag ?? ''}」的表情。` : `没发成：${value?.reason === 'no-sticker' ? '图库是空的' : value?.reason ?? '未知原因'}`,
          }],
        },
        async execute(args) {
          const result = await sendSticker(target, String(args?.tag ?? '').trim())
          return result
        },
      },
      {
        name: 'qq_memory_search',
        description: '在你们过去的聊天记录里搜关键词（只搜这个对话）。想确认以前说过的事、对方提过的名字或细节时用。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: '关键词，中文英文都行。' },
            limit: { type: 'integer', description: '最多返回几条，默认 20，上限 50。' },
          },
          required: ['query'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { found: { type: 'integer' }, text: { type: 'string' } },
            required: ['found'],
          },
          render: (args, value) => [{ type: 'text', text: value?.text ?? (value?.found ? '找到了。' : `没搜到「${args?.query ?? ''}」。`) }],
        },
        async execute(args) {
          const limit = Math.max(1, Math.min(50, Math.trunc(Number(args?.limit ?? 20)) || 20))
          const hits = memorySearch(`${target.type}:${target.id}`, String(args?.query ?? ''), limit)
          if (!hits.length) return { found: 0, text: `没搜到「${args?.query ?? ''}」。` }
          return { found: hits.length, text: hits.map(memoryLine).join('\n') }
        },
      },
      {
        name: 'qq_memory_recent',
        description: '看这个对话最近的聊天记录（默认 15 条）。不确定刚才聊到哪儿时用。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', description: '条数，默认 15，上限 50。' } },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { count: { type: 'integer' }, text: { type: 'string' } },
            required: ['count'],
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '这个对话还没有记录。' }],
        },
        async execute(args) {
          const limit = Math.max(1, Math.min(50, Math.trunc(Number(args?.limit ?? 15)) || 15))
          const recent = memoryRecent(`${target.type}:${target.id}`, limit)
          if (!recent.length) return { count: 0, text: '这个对话还没有记录。' }
          return { count: recent.length, text: recent.map(memoryLine).join('\n') }
        },
      },
      {
        name: 'qq_memory_remember',
        description: '把一件值得长期记住的事记下来（对方的喜好、重要日期、约定、雷区）。以后每轮都会看到这条笔记。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', description: '一句话，具体、可核对，别写空泛的评价。' } },
          required: ['text'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { saved: { type: 'boolean' } },
            required: ['saved'],
          },
          render: (_args, value) => [{ type: 'text', text: value?.saved ? '记下了。' : '没记成（内容为空？）。' }],
        },
        async execute(args) {
          const saved = memoryRememberFact(`${target.type}:${target.id}`, String(args?.text ?? ''))
          if (saved) affinityBump(target.userId || target.id, 1, 'remember')
          return { saved }
        },
      },
    ]
  }

  function approveWithinLimit() {
    const now = Date.now()
    while (approvalTimes.length > 0 && now - approvalTimes[0] > 3600000) approvalTimes.shift()
    if (config.approveMaxPerHour > 0 && approvalTimes.length >= config.approveMaxPerHour) return false
    approvalTimes.push(now)
    return true
  }

  async function sharesAGroupWith(userId) {
    if (!config.approveRequireCommonGroup) return true
    try {
      const groups = await client.call('get_group_list', {}, 15000)
      const list = Array.isArray(groups) ? groups.slice(0, 8) : []
      for (const group of list) {
        const members = await client.call('get_group_member_list', { group_id: group.group_id }, 15000)
        if (Array.isArray(members) && members.some((member) => String(member.user_id) === String(userId))) return true
      }
    } catch (error) {
      logger.warn(`qq-bridge: common-group check failed: ${errorText(error)}`)
    }
    return false
  }

  /**
   * A friend request either runs through the automatic policy or waits for an
   * admin decision. Requests are queued under stable numbers so the operator can
   * answer `/yes 3` from a phone, long after the notification scrolled away.
   */
  async function handleFriendRequest(event) {
    const userId = asString(event.user_id, '')
    const comment = asString(event.comment, '')
    if (config.autoApproveFriend) {
      if (config.approveSecret && !comment.includes(config.approveSecret)) {
        logger.info(`qq-bridge: friend request from ${userId} rejected: secret missing`)
        return
      }
      if (!(await sharesAGroupWith(userId))) {
        logger.info(`qq-bridge: friend request from ${userId} rejected: no common group`)
        return
      }
      if (!approveWithinLimit()) {
        logger.warn(`qq-bridge: friend request from ${userId} skipped: hourly approval limit`)
        return
      }
      await approveFriendRequest({ flag: event.flag, userId }, '自动通过')
      return
    }
    if (!config.notifyFriendRequests) {
      logger.info(`qq-bridge: friend request from ${userId} ignored (autoApproveFriend and notifyFriendRequests are off)`)
      return
    }
    const existing = pendingFriendRequests.find((entry) => entry.userId === userId)
    if (existing) {
      existing.flag = asString(event.flag, existing.flag)
      existing.comment = comment
      existing.time = Date.now()
      logger.info(`qq-bridge: friend request from ${userId} refreshed as #${existing.id}`)
      return
    }
    pendingFriendRequests.push({
      id: nextFriendRequestId++,
      flag: asString(event.flag, ''),
      userId,
      comment,
      time: Date.now(),
    })
    while (pendingFriendRequests.length > 20) pendingFriendRequests.shift()
    await notifyAdminsOfFriendRequest(pendingFriendRequests[pendingFriendRequests.length - 1])
  }

  async function notifyAdminsOfFriendRequest(entry) {
    const targets = config.admins.length > 0 ? config.admins : config.notifyUsers
    if (targets.length === 0) {
      logger.warn(`qq-bridge: no admin to ask about friend request from ${entry.userId}`)
      return
    }
    const lines = [
      `有人加我好友 #${entry.id}`,
      `QQ：${entry.userId}`,
      entry.comment ? `验证消息：${entry.comment}` : '验证消息：（空）',
      '',
      `回复 /yes ${entry.id} 通过，并自动加进白名单`,
      `回复 /no ${entry.id} 拒绝`,
      `回复 /pending 看待处理队列`,
    ]
    for (const adminId of targets) {
      try {
        await sendText({ type: 'private', id: adminId, userId: adminId }, lines.join('\n'))
      } catch (error) {
        logger.warn(`qq-bridge: cannot notify ${adminId} about friend request: ${errorText(error)}`)
      }
    }
  }

  /** Approve one request and whitelist the sender in the same step. */
  async function approveFriendRequest(entry, label) {
    try {
      await client.call('set_friend_add_request', { flag: entry.flag, approve: true }, 15000)
    } catch (error) {
      logger.warn(`qq-bridge: cannot approve friend request from ${entry.userId}: ${errorText(error)}`)
      return false
    }
    const nextUsers = [...new Set([...config.allowedUsers, entry.userId])]
    config.allowedUsers = nextUsers
    logger.info(`qq-bridge: ${label} friend request from ${entry.userId}, whitelisted`)
    if (config.approveGreeting) {
      await sendText(
        { type: 'private', id: entry.userId, userId: entry.userId },
        config.approveGreeting,
      ).catch(() => {})
    }
    return true
  }

  function takeFriendRequest(args) {
    if (pendingFriendRequests.length === 0) return { error: '现在没有待处理的好友申请。' }
    const raw = (args[0] ?? '').replace(/[^\d]/g, '')
    if (!raw) {
      if (pendingFriendRequests.length === 1) return { entry: pendingFriendRequests[0] }
      return { error: `有 ${pendingFriendRequests.length} 条待处理，请带上编号，例如 /yes ${pendingFriendRequests[0].id}` }
    }
    const entry = pendingFriendRequests.find((item) => item.id === Number(raw))
    if (!entry) return { error: `没有编号 ${raw} 的申请，发 /pending 看队列。` }
    return { entry }
  }

  function removeFriendRequest(entry) {
    const index = pendingFriendRequests.indexOf(entry)
    if (index >= 0) pendingFriendRequests.splice(index, 1)
  }

  async function handleGroupRequest(event) {
    if (!config.autoApproveGroup) return
    const comment = asString(event.comment, '')
    if (config.approveSecret && !comment.includes(config.approveSecret)) {
      logger.info(`qq-bridge: group request ${event.flag} rejected: secret missing`)
      return
    }
    if (!approveWithinLimit()) {
      logger.warn(`qq-bridge: group request ${event.flag} skipped: hourly approval limit`)
      return
    }
    try {
      await client.call('set_group_add_request', { flag: event.flag, sub_type: event.sub_type, approve: true }, 15000)
      logger.info(`qq-bridge: approved group request (${event.sub_type}) ${event.flag}`)
    } catch (error) {
      logger.warn(`qq-bridge: cannot approve group request: ${errorText(error)}`)
    }
  }

  async function maybeReactToMessage(event) {
    if (!emojiSupported) return
    if (!event.message_id || event.message_type !== 'private') return
    if (Math.random() > 0.25) return
    try {
      await client.call('set_msg_emoji_like', { message_id: event.message_id, emoji_id: '128077', set: true }, 8000)
    } catch (error) {
      emojiSupported = false
      logger.warn(`qq-bridge: set_msg_emoji_like unavailable, emoji reaction off: ${errorText(error)}`)
    }
  }

  /** Give quiet conversations a chance to speak; the model may still choose SKIP. */
  async function proactiveTick() {
    if (!config.proactiveEnabled) return
    const now = Date.now()
    for (const conversation of conversations.values()) {
      if (conversation.pumping || conversation.wait) continue
      if (config.proactivePrivateOnly && conversation.target.type !== 'private') continue
      const idleMs = now - (conversation.lastActivity || 0)
      if (idleMs < config.proactiveQuietMinutes * 60000) continue
      if (!ctx.get('agents')?.get(conversation.sessionId)) continue
      conversation.proactiveTimes = (conversation.proactiveTimes || []).filter((time) => now - time < 3600000)
      if (conversation.proactiveTimes.length >= config.proactiveMaxPerHour) continue
      conversation.proactiveTimes.push(now)
      conversation.lastActivity = now
      const prompt = fillTemplate(config.proactivePrompt, { minutes: Math.round(idleMs / 60000) })
      try {
        await runProactivePrompt(conversation, prompt, 'proactive')
      } catch (error) {
        logger.warn(`qq-bridge: proactive turn failed: ${errorText(error)}`)
      }
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      void proactiveTick()
    }, config.proactiveCheckMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  ctx.effect(() => () => {
    for (const timer of followUpTimers) clearTimeout(timer)
    followUpTimers.clear()
  })

  function isChatSessionId(id) {
    if (typeof id !== 'string') return false
    return id.startsWith(`${config.sessionPrefix}-user-`) || id.startsWith(`${config.sessionPrefix}-group-`)
  }

  function releaseChatSurface(sessionId) {
    installedPersona.delete(sessionId)
    const disposers = agentRegistrations.get(sessionId)
    if (!disposers) return
    agentRegistrations.delete(sessionId)
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        logger.warn(`qq-bridge: chat surface cleanup failed for ${sessionId}: ${errorText(error)}`)
      }
    }
  }

  let botRoute
  let requestOverrideCount = 0

  /**
   * Resolve the configured bot route once per plugin instance. An unknown
   * provider or model keeps the session on the default route instead of
   * failing every QQ turn with a routing error.
   */
  /**
   * The persona actually used, in priority order: the inline config string, then
   * the Markdown file at `personaFile`, then the built-in default. The file is
   * read when an agent surface is installed, so editing it takes effect for the
   * next new conversation (or after /reset).
   */
  function resolvePersona() {
    const inline = String(config.persona ?? '').trim()
    if (inline) return inline
    const file = String(config.personaFile ?? '').trim()
    if (file) {
      try {
        const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim()
        if (text) return text
        logger.warn(`qq-bridge: persona file "${file}" is empty; using the built-in persona`)
      } catch (error) {
        logger.warn(`qq-bridge: cannot read persona file "${file}": ${errorText(error)}`)
      }
    }
    return DEFAULT_PERSONA
  }

  async function botRouteFor() {
    // Only successful resolutions are cached: a route can become routable later
    // (e.g. its credential is stored after the first attempt), and caching the
    // failure would pin the bot to the default route until a restart.
    if (botRoute) return botRoute
    const provider = config.botProvider
    const model = config.botModel
    if (!provider || !model) {
      if (provider || model) logger.warn('qq-bridge: botProvider and botModel must be set together; keeping the default route')
      return null
    }
    try {
      const catalog = await ctx.sessionController.modelCatalog()
      const group = (catalog?.groups ?? []).find((entry) => entry.id === provider)
      const found = (group?.models ?? []).some((entry) => entry.id === model)
      if (found) {
        botRoute = { provider, model }
        logger.info(`qq-bridge: QQ sessions use ${provider}/${model}`)
      } else {
        logger.warn(`qq-bridge: ${provider}/${model} is not routable in this profile yet; keeping the default route`)
      }
    } catch (error) {
      logger.warn(`qq-bridge: cannot read the model catalog: ${errorText(error)}`)
    }
    return botRoute ?? null
  }

  /**
   * Replace the coding-agent prompt of one QQ session with the chat persona and
   * shrink its tool set, so the model answers like a person instead of reaching
   * for files, shells, and sub-agents.
   */
  function installChatSurface(agent) {
    if (!config.chatMode || !agent || !isChatSessionId(agent.id)) return
    const personaText = resolvePersona()
    if (agentRegistrations.has(agent.id)) {
      // The same agent survives config edits; rebuild only when the persona text
      // actually changed, so /persona takes effect on the next message instead
      // of leaving the previous complete prompt in place.
      if (installedPersona.get(agent.id) === personaText) return
      releaseChatSurface(agent.id)
    }
    const disposers = []
    try {
      const conversation = bySession.get(agent.id)
      const adminSurface = conversation ? isAdminConversation(conversation.target) : false
      const agentCtx = agent.ctx
      const systemPrompt = agentCtx?.systemPrompt
      if (systemPrompt) {
        // 联网工具在手上时，提示模型"先查再答"，别凭印象编事实。
        const hasWeb = config.chatTools.includes('web_search') || config.chatTools.includes('web_fetch')
        const webHint = hasWeb
          ? '\n\n【查资料】遇到需要实时信息的问题（新闻、价格、版本号、天气、比赛、人物近况、某个东西能不能用），先用 web_search 查一下再回答，别凭印象编。查完用自己的话说，别整段贴链接。'
          : ''
        // The persona is the whole prompt for every QQ session, admin included —
        // otherwise the person you actually chat with gets a coding-assistant
        // voice instead of the character you configured. Admins just get a short
        // capability footer so they can still ask for real work.
        const promptText = adminSurface ? `${personaText}\n\n${ADMIN_FOOTER}${webHint}` : `${personaText}${webHint}`
        disposers.push(systemPrompt.section({
          name: 'qq:chat-persona',
          order: -900,
          text: promptText,
          complete: true,
          interpolate: false,
        }))
        if (config.suppressRuntimeContext && typeof systemPrompt.suppressRuntimeContext === 'function') {
          disposers.push(systemPrompt.suppressRuntimeContext())
        }
      }
      const tools = agentCtx?.tools
      if (tools && !adminSurface && config.chatTools.length > 0) {
        try {
          disposers.push(tools.restrict({ allow: config.chatTools }))
        } catch (allowError) {
          // One configured name may not be registered in this profile; keep the
          // restriction for the names that do exist instead of dropping it.
          const visible = new Set((tools.schemas?.() ?? []).map((schema) => schema.name))
          const usable = config.chatTools.filter((name) => visible.has(name))
          if (usable.length > 0) disposers.push(tools.restrict({ allow: usable }))
          else logger.warn(`qq-bridge: no chat tool from ${JSON.stringify(config.chatTools)} exists here: ${errorText(allowError)}`)
        }
      }
      if (tools && conversation) {
        for (const definition of chatToolDefinitions(conversation)) {
          try {
            disposers.push(tools.register(definition))
          } catch (error) {
            logger.warn(`qq-bridge: cannot register ${definition.name}: ${errorText(error)}`)
          }
        }
      }
      // Independent model route: overridden per request, so the GUI's default
      // model and the bot's model never fight over one setting.
      if ((config.botProvider || config.botModel) && typeof agentCtx?.on === 'function') {
        disposers.push(agentCtx.on('agent/request', async (_payload, next) => {
          const base = await next()
          const route = await botRouteFor().catch(() => null)
          if (!route) return base
          requestOverrideCount += 1
          return { provider: route.provider, model: route.model }
        }))
      }
    } catch (error) {
      logger.warn(`qq-bridge: cannot install the chat surface for ${agent.id}: ${errorText(error)}`)
    }
    agentRegistrations.set(agent.id, disposers)
    installedPersona.set(agent.id, personaText)
    logger.info(`qq-bridge: chat persona installed for ${agent.id}`)
  }

  ctx.on('agent/created', ({ agent }) => {
    installChatSurface(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id) releaseChatSurface(agent.id)
  })
  ctx.effect(() => () => {
    for (const sessionId of [...agentRegistrations.keys()]) releaseChatSurface(sessionId)
  })

  /** Poke back when someone pokes the bot, but only inside authorized chats. */
  async function handleNotice(event) {
    if (!config.pokeBack) return
    if (event.notice_type !== 'notify' || event.sub_type !== 'poke') return
    if (asString(event.target_id, '') !== selfId) return
    const userId = asString(event.user_id, '')
    if (!userId) return
    if (event.group_id) {
      const groupId = asString(event.group_id, '')
      if (!config.allowAll && !config.allowedGroups.includes(groupId)) return
      await pokeUser({ type: 'group', id: groupId, userId }, userId)
      return
    }
    if (!config.allowAll && !config.allowedUsers.includes(userId)) return
    await pokeUser({ type: 'private', id: userId, userId }, userId)
  }

  /**
   * A group message the bot was not addressed in: keep it as recent context,
   * then occasionally roll the dice and let the model decide whether to chime
   * in. Four gates keep it from turning into a spammer: the group allowlist,
   * a per-message probability, a minimum gap, and an hourly cap.
   */
  function handleAmbientGroupMessage(event, target, text) {
    const groupId = target.id
    const now = Date.now()
    const nickname = asString(event.sender?.card, '') || asString(event.sender?.nickname, '') || target.userId
    const buffer = (ambientBuffers.get(groupId) ?? []).filter((entry) => now - entry.time < config.ambientContextMinutes * 60000)
    if (text) buffer.push({ time: now, text: `${nickname}：${text}` })
    while (buffer.length > config.ambientContextMessages) buffer.shift()
    ambientBuffers.set(groupId, buffer)
    if (!text) return

    const conversation = conversationFor(target)
    conversation.lastActivity = now
    if (conversation.pumping || conversation.wait) return
    if (now - (conversation.lastReplyAt ?? 0) < 90000) return
    if (now - (conversation.lastAmbientAt ?? 0) < config.ambientMinGapMinutes * 60000) return
    conversation.ambientTimes = (conversation.ambientTimes ?? []).filter((time) => now - time < 3600000)
    if (conversation.ambientTimes.length >= config.ambientMaxPerHour) return
    if (Math.random() > config.ambientChance) return

    conversation.ambientTimes.push(now)
    conversation.lastAmbientAt = now
    const log = buffer.map((entry) => entry.text).join('\n')
    const prompt = `${log}\n（系统：以上是群里最近的消息，你也在群里。想自然接一句就接，不想说就只回复 SKIP。）`
    runProactivePrompt(conversation, prompt, 'ambient').catch((error) => {
      logger.warn(`qq-bridge: ambient turn failed: ${errorText(error)}`)
    })
  }

  /**
   * A refused private chat is reported to the configured owner accounts instead
   * of to the stranger, at most once per sender per hour so a spammer cannot
   * flood the owner's chat.
   */
  async function notifyOwnerOfRefusal(fromUserId, text) {
    const targets = config.admins.length > 0 ? config.admins : config.notifyUsers
    if (targets.length === 0) return
    const now = Date.now()
    if (now - (notifyTimes.get(fromUserId) ?? 0) < 3600000) return
    notifyTimes.set(fromUserId, now)
    const preview = String(text ?? '').trim().slice(0, 120)
    const body = `${config.deniedNotifyText}\nQQ ${fromUserId}${preview ? `：${preview}` : '（空消息）'}`
    for (const ownerId of targets) {
      if (ownerId === fromUserId) continue
      try {
        await sendText({ type: 'private', id: ownerId, userId: ownerId }, body)
      } catch (error) {
        logger.warn(`qq-bridge: cannot notify ${ownerId} about ${fromUserId}: ${errorText(error)}`)
      }
    }
  }

  /**
   * Persist a config patch into the profile patch layer (the one that survives
   * upgrades). `configEditor.edit()` refuses to run from inside the very plugin
   * it would reload ("HMR transactions cannot be nested"), so the row is written
   * directly; the in-memory value already took effect for this run.
   */
  async function persistConfig(patch, label) {
    try {
      const file = join(profileDirectory(), 'cordis.patch.yml')
      const nextConfig = { ...config, ...patch }
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
      writeFileSync(file, upsertPatchRow(existing, 'qq-bridge', '@local/dsh-qq-bridge', JSON.stringify(nextConfig)), 'utf8')
      logger.info(`qq-bridge: ${label} persisted to ${file}`)
      return { ok: true, reason: '' }
    } catch (error) {
      return { ok: false, reason: errorText(error) }
    }
  }

  const ADMIN_COMMANDS = [
    'allow', 'deny', 'allowgroup', 'denygroup', 'admin', 'unadmin',
    'mute', 'unmute', 'say', 'quiet', 'persona', 'reset', 'poke', 'route', 'key',
    'yes', 'no', 'pending', 'cwd',
  ]

  const chatKeyOf = (target) => `${target.type}:${target.id}`

  function mutedView() {
    return config.mutedChats.length === 0 ? '（没有静音的会话）' : config.mutedChats.join('，')
  }

  /** Resolve an optional explicit target (`group 123` / `user 123`) for a command. */
  function targetFromArgs(args) {
    const kind = (args[0] ?? '').toLowerCase()
    const value = (args[1] ?? '').replace(/\D/g, '')
    if ((kind === 'group' || kind === 'user') && value) {
      return value.length > 0 ? { type: kind === 'group' ? 'group' : 'private', id: value, userId: value } : undefined
    }
    return undefined
  }

  /**
   * Slash commands. Admin power is reachable only from an admin's private chat:
   * a whitelisted group is a public room, so nobody there can steer the bot.
   */
  async function handleCommand(target, text, event) {
    const trimmed = String(text ?? '').trim()
    if (!/^[/／]/.test(trimmed)) return false
    const match = /^[/／]([a-zA-Z\u4e00-\u9fa5]+)\s*([\s\S]*)$/.exec(trimmed)
    if (!match) return false
    const name = match[1].toLowerCase()
    const rest = match[2].trim()
    const args = rest.split(/[\s,，]+/).map((part) => part.trim()).filter(Boolean)
    const fromUserId = asString(event.user_id, '')
    const admin = isAdmin(fromUserId)
    const privateChat = event.message_type === 'private'
    const say = (body) => sendText(target, body).catch(() => {})

    // ---- 好感度 ----------------------------------------------------------
    if (name === 'affinity') {
      if (!admin || !privateChat) return true
      const all = affinityLoad()
      const rows = Object.entries(all)
        .sort((a, b) => Number(b[1]?.score ?? 0) - Number(a[1]?.score ?? 0))
        .slice(0, 10)
      const mine = affinityFor(fromUserId)?.entry?.score ?? 50
      if (!rows.length) {
        await say(`你：${Math.round(mine)}/100（${affinityLabel(mine)}）\n还没有别人的记录。`)
        return true
      }
      const lines = [`你：${Math.round(mine)}/100（${affinityLabel(mine)}）`, '', '排前面的：']
      for (const [id, entry] of rows) {
        lines.push(`${id}  ${Math.round(Number(entry?.score ?? 0))}/100  ${affinityLabel(entry?.score)}`)
      }
      await say(lines.join('\n'))
      return true
    }

    // ---- 表情包 ----------------------------------------------------------
    if (name === 'sticker' || name === '表情') {
      const lib = stickerLibrary()
      const tags = Object.keys(lib)
      if (!tags.length) {
        await say(`图库是空的。把图片按标签放进目录即可：\n${join(stickerRoot(), '<标签>', 'xxx.gif')}`)
        return true
      }
      if (!rest) {
        const lines = ['可用标签：']
        for (const tag of tags) lines.push(`${tag}（${lib[tag].length} 张）`)
        lines.push('', `发一张：/sticker 标签名`)
        await say(lines.join('\n'))
        return true
      }
      const result = await sendSticker(target, rest, false)
      if (!result.sent) await say(result.reason === 'no-tag' ? `没有「${rest}」这个标签，发 /sticker 看看有哪些。` : '图库是空的。')
      return true
    }

    // ---- 点歌 ------------------------------------------------------------
    if (name === '点歌' || name === 'music') {
      if (!rest) {
        await say('用法：/点歌 歌名（可以带上歌手）')
        return true
      }
      try {
        const songs = await searchQQMusic(rest, 3)
        if (!songs.length) {
          await say(`没搜到「${rest}」，换个关键词试试？`)
          return true
        }
        const song = songs[0]
        await sendSegments(target, [{ type: 'music', data: { type: 'qq', id: song.mid } }])
        logger.info(`qq-bridge: music "${song.name}" (${song.singer}) → ${target.id}`)
      } catch (error) {
        await say(`点歌失败了：${errorText(error)}`)
      }
      return true
    }

    // ---- 群管理（只在群里、只给管理员）-----------------------------------
    if (name === 'ban' || name === 'unban' || name === 'kick' || name === 'card' || name === 'recall') {
      // 群里没有管理员权限，私聊里也做不了这些事——静默返回，不提示。
      if (privateChat || target.type !== 'group' || !admin) return true
      const groupId = Number(target.id)
      const targets = atTargets(event)
      try {
        if (name === 'recall') {
          const messageId = repliedId(event)
          if (!messageId) {
            await say('用法：回复要撤回的那条消息，再发 /recall')
            return true
          }
          await client.call('delete_msg', { message_id: Number(messageId) }, 10000)
          return true
        }
        if (!targets.length) {
          const usage = name === 'ban' ? '/ban @某人 [分钟]' : name === 'card' ? '/card @某人 新昵称' : `/${name} @某人`
          await say(`用法：${usage}`)
          return true
        }
        const userId = Number(targets[0])
        if (name === 'ban') {
          const minutes = Math.max(1, Math.min(43200, Math.trunc(Number(args.at(-1) ?? 10)) || 10))
          await client.call('set_group_ban', { group_id: groupId, user_id: userId, duration: minutes * 60 }, 10000)
          await say(`已禁言 ${minutes} 分钟。`)
        } else if (name === 'unban') {
          await client.call('set_group_ban', { group_id: groupId, user_id: userId, duration: 0 }, 10000)
          await say('已解除禁言。')
        } else if (name === 'kick') {
          await client.call('set_group_kick', { group_id: groupId, user_id: userId, reject_add_request: false }, 10000)
          await say('已移出群聊。')
        } else if (name === 'card') {
          const card = rest.replace(/@\S+/g, '').trim()
          if (!card) {
            await say('用法：/card @某人 新昵称')
            return true
          }
          await client.call('set_group_card', { group_id: groupId, user_id: userId, card }, 10000)
          await say('群名片改好了。')
        }
      } catch (error) {
        await say(`操作失败：${errorText(error)}`)
      }
      return true
    }

    if (name === 'whoami') {
      await say(`你是${admin ? '管理员' : '普通用户'}。\n会话 id：${conversationFor(target).sessionId}${config.mutedChats.includes(chatKeyOf(target)) ? '\n（这个会话当前被静音）' : ''}`)
      return true
    }

    if (name === 'help') {
      const common = '/whoami 看自己的身份\n/stop 打断当前回复\n/点歌 歌名（也能用 /music）\n/sticker 看表情包标签，/sticker 标签 发一张\n/help 看这份说明'
      const adminLines = admin && privateChat
        ? '\n\n管人管群：\n/allow 123 · /deny 123\n/allowgroup 123 · /denygroup 123\n/admin 123 · /unadmin 123'
          + '\n有人加好友会推给你：/pending 看队列 · /yes 编号 通过（自动加白名单）· /no 编号 拒绝'
          + '\n\n管群（在群里发，仅管理员）：\n/ban @某人 [分钟] · /unban @某人 · /kick @某人\n/card @某人 新昵称 · 回复那条消息再发 /recall 撤回'
          + '\n\n指挥它行动：\n/say 你要它说的话（可 /say group 群号 内容）\n/poke QQ号\n/mute · /unmute（可带 group 群号 / user QQ号）'
          + '\n/quiet on|off 停/开主动说话\n/persona 人设文本 或 /persona reset\n/reset 重开当前对话'
          + '\n/cwd D:/目录 切当前对话的工作区（/cwd 看当前，/cwd reset 回默认）'
          + '\n/route 看模型通道\n/affinity 看好感度排行'
        : ''
      await say(`${common}${adminLines}`)
      return true
    }

    if (name === 'stop') {
      const agent = ctx.get('agents')?.get(conversationFor(target).sessionId)
      if (agent) {
        agent.cancel({ kind: 'user' })
        await say(config.stoppedText)
      } else {
        await say('现在没在跑什么，不用停下。')
      }
      return true
    }

    if (!ADMIN_COMMANDS.includes(name)) return false
    if (!admin || !privateChat) {
      // Silent refusal: answering every attempted admin command would turn the
      // group into a spam channel. The attempt is only recorded in the log.
      logger.info(`qq-bridge: ignored admin command "/${name}" from ${fromUserId} (${event.message_type})`)
      return true
    }

    // ---- 凭据 --------------------------------------------------------------
    if (name === 'key') {
      const [ref, ...secretParts] = rest.split(/\s+/)
      const secret = secretParts.join('')
      if (!ref || !secret) {
        await say('用法：/key 引用名 密钥\n例如 /key DEEPSEEK_BOT_API_KEY sk-xxxx\n密钥会存进 Harness 凭据库，不写进配置文件。')
        return true
      }
      const controller = ctx.get('credentialsController')
      if (!controller) {
        await say('凭据服务不可用，存不了。')
        return true
      }
      try {
        await controller.set(ref, secret)
        await say(`已存进凭据库：${ref}（长度 ${secret.length}）。\n提醒：这条消息里带着明文密钥，方便的话发完去 QQ 里撤回。`)
      } catch (error) {
        await say(`保存失败：${errorText(error)}`)
      }
      return true
    }

    // ---- 好友申请审批 ------------------------------------------------------
    if (name === 'pending') {
      if (pendingFriendRequests.length === 0) {
        await say('没有待处理的好友申请。')
        return true
      }
      const lines = ['待处理的好友申请：']
      for (const entry of pendingFriendRequests) {
        const age = Math.round((Date.now() - entry.time) / 60000)
        lines.push(`#${entry.id}  QQ ${entry.userId}${entry.comment ? `（${entry.comment}）` : ''}  ${age} 分钟前`)
      }
      lines.push('', '/yes 编号 通过（并加白名单）  /no 编号 拒绝')
      await say(lines.join('\n'))
      return true
    }

    if (name === 'yes' || name === 'no') {
      const picked = takeFriendRequest(args)
      if (picked.error) {
        await say(picked.error)
        return true
      }
      const entry = picked.entry
      removeFriendRequest(entry)
      if (name === 'no') {
        try {
          await client.call('set_friend_add_request', { flag: entry.flag, approve: false }, 15000)
          await say(`已拒绝 #${entry.id}（QQ ${entry.userId}）。`)
        } catch (error) {
          await say(`拒绝失败：${errorText(error)}`)
        }
        return true
      }
      const approved = await approveFriendRequest(entry, '管理员通过')
      if (!approved) {
        await say(`通过 #${entry.id} 失败，可能申请已过期，让对方再发一次。`)
        return true
      }
      await say(`已通过 #${entry.id}（QQ ${entry.userId}），并加进白名单，他能直接跟我聊了。`)
      await sleep(300)
      const outcome = await persistConfig({ allowedUsers: config.allowedUsers }, '/yes')
      if (!outcome.ok) logger.warn(`qq-bridge: whitelist not persisted: ${outcome.reason}`)
      return true
    }

    // ---- 工作区 ------------------------------------------------------------
    if (name === 'cwd') {
      const controller = ctx.get('workingDirectory')
      const conversation = conversationFor(target)
      const agent = ctx.get('agents')?.get(conversation.sessionId)
      const effective = (agent?.session && controller)
        ? controller.get(agent.session)
        : (conversation.cwd || config.cwd || '（Harness 默认目录）')
      if (!rest) {
        await say(`当前工作区：${effective}\n用法：/cwd D:/某个目录    切到那个目录\n      /cwd group 群号 D:/目录   给某个群设\n      /cwd reset               回到默认`)
        return true
      }
      if (rest.toLowerCase() === 'reset') {
        const currentKey = chatKeyOf(target)
        const next = { ...config.conversationCwds }
        delete next[currentKey]
        config.conversationCwds = next
        conversation.cwd = ''
        await persistConfig({ conversationCwds: next }, '/cwd reset')
        await say(`已清除这个对话的工作区覆盖。下次 /reset 开新会话时回到默认：${config.cwd || '（Harness 默认目录）'}`)
        return true
      }
      let targetKey = chatKeyOf(target)
      let pathArg = rest
      const asGroup = /^group\s+(\d{5,12})\s+([\s\S]+)$/i.exec(rest)
      if (asGroup) {
        targetKey = `group:${asGroup[1]}`
        pathArg = asGroup[2].trim()
      }
      const path = pathArg.replace(/^["']|["']$/g, '').trim()
      let isDir = false
      try {
        isDir = existsSync(path) && statSync(path).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) {
        await say(`这个路径不是已存在的目录：${path}`)
        return true
      }
      config.conversationCwds = { ...config.conversationCwds, [targetKey]: path }
      const targetConv = conversations.get(targetKey)
      if (targetConv) targetConv.cwd = path
      const liveAgent = targetConv ? ctx.get('agents')?.get(targetConv.sessionId) : undefined
      let applied
      if (liveAgent && controller) {
        try {
          const committed = await controller.set(liveAgent, path)
          applied = `\n当前会话已切到：${committed}`
        } catch (error) {
          applied = `\n当前会话切换失败：${errorText(error)}`
        }
      } else {
        applied = '\n（这个对话还没开始，下一条消息就会用新目录）'
      }
      await say(`已把 ${targetKey} 的工作区设为：${path}${applied}`)
      await sleep(300)
      const outcome = await persistConfig({ conversationCwds: config.conversationCwds }, '/cwd')
      if (!outcome.ok) logger.warn(`qq-bridge: /cwd not persisted: ${outcome.reason}`)
      return true
    }

    // ---- 行动控制 --------------------------------------------------------
    if (name === 'route') {
      const current = config.botProvider && config.botModel
        ? `${config.botProvider}/${config.botModel}`
        : '（跟随 Harness 默认模型）'
      const resolved = await botRouteFor().catch(() => null)
      const lines = [`机器人通道：${current}`, `实际生效：${resolved ? `${resolved.provider}/${resolved.model}` : '默认通道'}`, `已覆盖请求：${requestOverrideCount} 次`]
      try {
        const catalog = await ctx.sessionController.modelCatalog()
        const groups = (catalog?.groups ?? []).map((group) => `${group.id} → ${(group.models ?? []).map((model) => model.id).join(', ')}`)
        if (groups.length > 0) lines.push('可用路由：', ...groups.slice(0, 8))
        const failures = (catalog?.failures ?? []).map((failure) => `${failure.id}: ${failure.message}`)
        if (failures.length > 0) lines.push('路由失败：', ...failures.slice(0, 6))
      } catch (error) {
        lines.push(`读不到模型目录：${errorText(error)}`)
      }
      await say(lines.join('\n'))
      return true
    }

    if (name === 'say') {
      if (!rest) {
        await say('用法：/say 你要它说的话；想发到群里用 /say group 群号 内容')
        return true
      }
      const toGroup = /^group\s+(\d{5,12})\s+([\s\S]+)$/i.exec(rest)
      if (toGroup) {
        const groupId = toGroup[1]
        if (!config.allowAll && !config.allowedGroups.includes(groupId)) {
          await say(`群 ${groupId} 不在白名单里，我不往里发。`)
          return true
        }
        await sendText({ type: 'group', id: groupId, userId: groupId }, toGroup[2].trim())
        await say(`已发到群 ${groupId}。`)
        return true
      }
      await sendText(target, rest)
      return true
    }

    if (name === 'poke') {
      const qq = (args[0] ?? '').replace(/\D/g, '') || fromUserId
      if (!qq) {
        await say('用法：/poke QQ号')
        return true
      }
      const ok = await pokeUser({ type: 'private', id: qq, userId: qq }, qq)
      await say(ok ? `戳了 ${qq}。` : `戳 ${qq} 没成功，可能不是好友。`)
      return true
    }

    if (name === 'reset') {
      const explicit = targetFromArgs(args)
      const resetTarget = explicit ?? target
      const key = chatKeyOf(resetTarget)
      epochs.set(key, (epochs.get(key) ?? 0) + 1)
      const old = conversations.get(key)
      if (old) {
        bySession.delete(old.sessionId)
        conversations.delete(key)
        old.wait = null
        old.queue.length = 0
      }
      await say(`已经重开 ${key}，上下文是干净的（新会话 ${conversationFor(resetTarget).sessionId}）。`)
      return true
    }

    if (name === 'quiet') {
      const mode = (args[0] ?? '').toLowerCase()
      if (mode !== 'on' && mode !== 'off') {
        await say('用法：/quiet on 让它别再主动找你；/quiet off 恢复')
        return true
      }
      const enabled = mode === 'off'
      config.proactiveEnabled = enabled
      const outcome = await persistConfig({ proactiveEnabled: enabled }, '/quiet')
      await say(`主动说话已${enabled ? '打开' : '关掉'}。${outcome.ok ? '' : `\n（写回失败：${outcome.reason}）`}`)
      return true
    }

    if (name === 'mute' || name === 'unmute') {
      const explicit = targetFromArgs(args)
      const key = explicit ? chatKeyOf(explicit) : (args[0] ? `group:${args[0].replace(/\D/g, '')}` : chatKeyOf(target))
      const muting = name === 'mute'
      const patch = {
        mutedChats: muting ? [...new Set([...config.mutedChats, key])] : config.mutedChats.filter((entry) => entry !== key),
      }
      config.mutedChats = patch.mutedChats
      const outcome = await persistConfig(patch, `/${name}`)
      await say(`${muting ? '已静音' : '已恢复'} ${key}。${outcome.ok ? '' : `\n（写回失败：${outcome.reason}）`}\n当前静音：${mutedView()}`)
      return true
    }

    if (name === 'persona') {
      const lower = rest.toLowerCase()
      // /persona                      → show the active source and a preview
      if (!rest) {
        const source = String(config.persona ?? '').trim()
          ? '内联文本（persona）'
          : String(config.personaFile ?? '').trim()
            ? `文件 ${config.personaFile}`
            : '内置默认人格'
        const preview = resolvePersona().replace(/\s+/g, ' ').slice(0, 180)
        await say(`人设来源：${source}\n预览：${preview}…`)
        return true
      }
      // /persona reset                → back to the built-in persona
      if (lower === 'reset') {
        config.persona = ''
        config.personaFile = ''
        const outcome = await persistConfig({ persona: '', personaFile: '' }, '/persona reset')
        await say(`已恢复内置人格。对新会话生效；想立刻换就接着发 /reset。${outcome.ok ? '' : `\n（写回失败：${outcome.reason}）`}`)
        return true
      }
      // /persona file <路径>          → use a Markdown file
      if (lower.startsWith('file ')) {
        const path = rest.slice(5).trim().replace(/^["']|["']$/g, '')
        if (!path) {
          await say('用法：/persona file D:/某个路径/persona.md')
          return true
        }
        try {
          const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim()
          if (!text) {
            await say(`文件读到了但是空的：${path}`)
            return true
          }
          config.persona = ''
          config.personaFile = path
          const outcome = await persistConfig({ persona: '', personaFile: path }, '/persona file')
          await say(`人设已切换到文件：${path}（${text.length} 字）。对新会话生效；想立刻换就发 /reset。${outcome.ok ? '' : `\n（写回失败：${outcome.reason}）`}`)
        } catch (error) {
          await say(`读不到这个文件：${errorText(error)}`)
        }
        return true
      }
      // /persona <文本>               → inline persona
      config.persona = rest
      config.personaFile = ''
      const outcome = await persistConfig({ persona: rest, personaFile: '' }, '/persona')
      await say(`人设已更新（内联）。对新会话生效；想立刻换就发 /reset。${outcome.ok ? '' : `\n（写回失败：${outcome.reason}）`}`)
      return true
    }

    if (args.length === 0) {
      await say(`用法：/${name} 号码，可以一次给多个，例如 /${name} 123456 789012`)
      return true
    }

    const ids = args.map((arg) => arg.replace(/\D/g, '')).filter(Boolean)
    if (ids.length === 0) {
      await say('号码看着不对，应该是纯数字的 QQ 号或群号。')
      return true
    }

    const patch = {}
    let message = ''
    switch (name) {
      case 'allow': {
        patch.allowedUsers = [...new Set([...config.allowedUsers, ...ids])]
        config.allowedUsers = patch.allowedUsers
        message = `已加入白名单：${ids.join('、')}`
        break
      }
      case 'deny': {
        patch.allowedUsers = config.allowedUsers.filter((id) => !ids.includes(id))
        config.allowedUsers = patch.allowedUsers
        message = `已移出白名单：${ids.join('、')}`
        break
      }
      case 'allowgroup': {
        patch.allowedGroups = [...new Set([...config.allowedGroups, ...ids])]
        config.allowedGroups = patch.allowedGroups
        message = `已加入群白名单：${ids.join('、')}`
        break
      }
      case 'denygroup': {
        patch.allowedGroups = config.allowedGroups.filter((id) => !ids.includes(id))
        patch.ambientGroups = config.ambientGroups.filter((id) => !ids.includes(id))
        config.allowedGroups = patch.allowedGroups
        config.ambientGroups = patch.ambientGroups
        message = `已移出群白名单：${ids.join('、')}`
        break
      }
      case 'admin': {
        patch.admins = [...new Set([...config.admins, ...ids])]
        config.admins = patch.admins
        message = `已设为管理员：${ids.join('、')}`
        break
      }
      case 'unadmin': {
        const next = config.admins.filter((id) => !ids.includes(id))
        if (next.length === 0) {
          await say('至少得留一个管理员，不然以后没人管得动它了。')
          return true
        }
        patch.admins = next
        config.admins = next
        message = `已取消管理员：${ids.join('、')}`
        break
      }
      default:
        return false
    }

    await say(`${message}\n（正在写回配置…）`)
    await sleep(400)
    const outcome = await persistConfig(patch, `/${name}`)
    if (!outcome.ok) {
      logger.warn(`qq-bridge: "${message}" is in memory only: ${outcome.reason}`)
      await say(`写回配置失败，这次改动只在内存里有效（重启会丢）：${outcome.reason}`)
    }
    return true
  }

  async function handleEvent(event) {
    if (event.post_type === 'meta_event') {
      if (event.meta_event_type === 'lifecycle') {
        selfId = asString(event.self_id, selfId)
        logger.info(`qq-bridge: QQ ${selfId} is online (${event.sub_type ?? 'lifecycle'})`)
      }
      return
    }
    if (event.post_type === 'notice') {
      await handleNotice(event)
      return
    }
    if (event.post_type === 'request') {
      if (event.request_type === 'friend') await handleFriendRequest(event)
      else if (event.request_type === 'group') await handleGroupRequest(event)
      return
    }
    if (event.post_type !== 'message') return
    if (event.message_type !== 'group' && event.message_type !== 'private') return

    const target = targetOf(event)
    const raw = extractText(event)
    const text = raw.trim()
    const mentioned = mentionsSelf(event)
    const cleanedEarly = mentioned ? text.replace(/^\s+/, '') : text
    const muted = config.mutedChats.includes(`${target.type}:${target.id}`)

    // A silenced chat stays silent except for commands, so the operator can
    // still talk to the bot and lift the mute from inside it.
    if (muted && !/^[/／]/.test(cleanedEarly)) return

    // Ambient groups may see the bot join in without a mention; every other
    // group still obeys requireAtInGroup.
    const ambientAllowed = event.message_type === 'group'
      && !muted
      && config.ambientGroups.includes(target.id)
      && (config.allowAll || config.allowedGroups.includes(target.id))

    if (event.message_type === 'group' && config.requireAtInGroup && !mentioned && !ambientAllowed) return

    if (ambientAllowed && !mentioned) {
      handleAmbientGroupMessage(event, target, text)
      return
    }

    if (!authorized(event)) {
      logger.warn(`qq-bridge: rejected unauthorized ${event.message_type} message from ${target.userId}${event.message_type === 'group' ? ` in group ${target.id}` : ''}`)
      // A group never sees a refusal — the bot simply stays quiet there.
      if (event.message_type === 'private') await notifyOwnerOfRefusal(target.userId, text)
      return
    }

    void maybeReactToMessage(event)

    const cleaned = cleanedEarly
    if (!cleaned) return

    if (await handleCommand(target, cleaned, event)) return

    if (muted) return

    const conversation = conversationFor(target)
    conversation.lastActivity = Date.now()

    if (STOP_WORDS.includes(cleaned.toLowerCase()) || STOP_WORDS.includes(cleaned)) {
      const agents = ctx.get('agents')
      const agent = agents?.get(conversation.sessionId)
      if (agent) {
        agent.cancel({ kind: 'user' })
        await sendText(target, config.stoppedText).catch(() => {})
      }
      return
    }

    if (conversation.queue.length >= config.queueLimit) {
      await sendText(target, config.busyText).catch(() => {})
      return
    }

    // In a group the model should see who is talking, like a chat log line:
    // "小王的昵称：今天好热". Private chats are one-to-one, so they stay bare.
    let promptText = cleaned
    if (event.message_type === 'group') {
      const nickname = asString(event.sender?.card, '') || asString(event.sender?.nickname, '') || target.userId
      promptText = `${nickname}：${cleaned}`
    }

    conversation.queue.push({ text: promptText, target })
    const speaker = asString(event.sender?.card, '') || asString(event.sender?.nickname, '') || target.userId
    appendActivity(`${target.type}:${target.id}`, isAdmin(target.userId) ? `管理员 ${speaker}` : speaker, cleaned)
    memoryRemember(`${target.type}:${target.id}`, 'user', speaker, cleaned)
    affinityFromText(target.userId || target.id, cleaned)
    void pump(conversation)
  }

  async function pump(conversation) {
    if (conversation.pumping) return
    conversation.pumping = true
    try {
      while (conversation.queue.length > 0) {
        const item = conversation.queue.shift()
        try {
          await processMessage(conversation, item)
        } catch (error) {
          logger.warn(`qq-bridge: turn failed: ${errorText(error)}`)
          await sendChatReply(item.target, config.errorText).catch(() => {})
        }
      }
    } finally {
      conversation.pumping = false
    }
  }

  function beginTurn(conversation) {
    return new Promise((resolve) => {
      const wait = {
        awaitingTurn: true,
        turn: null,
        texts: [],
        settled: false,
      }
      wait.timer = setTimeout(() => {
        if (conversation.wait === wait) {
          conversation.wait = null
          wait.settled = true
          resolve(config.timeoutText)
        }
      }, config.timeoutMs)
      wait.resolve = (text) => {
        if (wait.settled) return
        wait.settled = true
        clearTimeout(wait.timer)
        resolve(text)
      }
      conversation.wait = wait
    })
  }

  function finishTurn(conversation, text) {
    const wait = conversation.wait
    if (!wait) return
    conversation.wait = null
    wait.resolve(text)
  }

  function handleSessionEvent(conversation, event) {
    const wait = conversation.wait
    if (!wait || wait.settled) return

    if (event.type === 'turn/start') {
      if (wait.awaitingTurn) {
        wait.awaitingTurn = false
        wait.turn = event.data.turn
      }
      return
    }
    if (wait.awaitingTurn) return

    if (event.type === 'assistant/message') {
      if (event.data.turn !== wait.turn) return
      const text = textOfMessage(event.data.message).trim()
      if (text) wait.texts.push(text)
      return
    }

    if (event.type === 'turn/end') {
      if (event.data.turn !== wait.turn) return
      const reason = event.data.reason ?? {}
      let answer = wait.texts.length > 0 ? wait.texts[wait.texts.length - 1] : config.emptyText
      if (reason.kind === 'error') {
        logger.warn(`qq-bridge: turn for ${conversation.key} ended with error: ${reason.error?.message ?? 'unknown error'}`)
        answer = config.errorText
      } else if (reason.kind === 'max-tokens') {
        answer = `${answer}\n（后面太长了，我先说这些）`
      }
      finishTurn(conversation, answer)
    }
  }

  async function ensureSession(conversation) {
    const controller = ctx.sessionController
    const request = {
      sessionId: conversation.sessionId,
      content: [{ type: 'text', text: '' }],
      mode: 'queue',
      requestId: `qq-${conversation.target.type}-${conversation.target.id}-${Date.now()}-${++requestCounter}`,
    }
    if (config.clientTimeZone) request.clientTimeZone = config.clientTimeZone
    return { controller, request }
  }

  async function submitPrompt(conversation, text) {
    const live = ctx.get('agents')?.get(conversation.sessionId)
    if (live) installChatSurface(live)
    const { controller, request } = await ensureSession(conversation)
    const signal = new AbortController().signal
    const personId = conversation.target.userId || conversation.target.id
    const affinity = affinityHint(personId)
    const memoryBlock = `${affinity ? `\n\n（${affinity}）` : ''}${memoryContextBlock(conversation.key)}`
    const payload = { ...request, content: [{ type: 'text', text: `${text}${memoryBlock}` }] }
    try {
      return await controller.prompt(payload, signal)
    } catch (error) {
      const code = error?.code ?? error?.data?.code ?? ''
      const missing = code === 'session/not-found' || /not found/i.test(errorText(error))
      if (!missing) throw error
      const createRequest = { sessionId: conversation.sessionId }
      const workspace = conversation.cwd || config.cwd
      if (workspace) createRequest.cwd = workspace
      if (config.agentPreset) createRequest.agentPreset = config.agentPreset
      const created = await controller.create(createRequest)
      if (created && typeof created.sessionId === 'string' && created.sessionId !== conversation.sessionId) {
        bySession.delete(conversation.sessionId)
        conversation.sessionId = created.sessionId
        bySession.set(conversation.sessionId, conversation)
      }
      const createdAgent = ctx.get('agents')?.get(conversation.sessionId)
      if (createdAgent) installChatSurface(createdAgent)
      const retryRequest = {
        ...payload,
        sessionId: conversation.sessionId,
        requestId: `qq-${conversation.target.type}-${conversation.target.id}-${Date.now()}-${++requestCounter}`,
      }
      return await controller.prompt(retryRequest, new AbortController().signal)
    }
  }

  async function processMessage(conversation, item) {
    logger.info(`qq-bridge: ${conversation.key} → ${item.text.slice(0, 80)}`)
    let ackTimer = null
    if (config.ackEnabled) {
      ackTimer = setTimeout(() => {
        if (conversation.wait) sendText(item.target, config.ackText).catch(() => {})
      }, config.ackDelayMs)
    }
    let answer
    try {
      answer = await askTurn(conversation, item.text)
    } finally {
      if (ackTimer) clearTimeout(ackTimer)
    }
    conversation.lastActivity = Date.now()
    if (isSkip(answer)) {
      logger.info(`qq-bridge: model chose silence for ${conversation.key}`)
      return
    }
    await sendChatReply(item.target, answer).catch((error) => {
      logger.warn(`qq-bridge: cannot send reply: ${errorText(error)}`)
    })
  }

  logger.info(`qq-bridge: waiting for OneBot at ${config.wsUrl}`)
}
