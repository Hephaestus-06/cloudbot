/**
 * cloudbot-skin —— dsh-onebot-qq 的"皮肤层"插件。
 *
 * 只作用于 `onebot-*` 会话（即 QQ 会话），提供三件事：
 *   1. 人设：把 persona.md 作为系统提示的一个段落注入（不覆盖平台说明）
 *   2. 长期记忆：归档 + 关键词检索 + 事实笔记，每轮注入上下文
 *   3. 好感度：按 QQ 号算分，隐式影响语气（不提供查询入口）
 *
 * 零 npm 依赖，只用 node 内置模块和 Cordis 服务。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'cloudbot-skin'
export const inject = ['systemPrompt', 'tools', 'sessions']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  personaFile: '',
  memoryDir: '',
  affinityEnabled: true,
  memoryContextMessages: 10,
  memoryInject: true,
  memoryMaxChars: 1200,
  stickerDir: '',
  onebotUrl: 'ws://127.0.0.1:3001',
  onebotToken: '',
  stickerAutoChance: 0,
}

function normalize(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return {
    personaFile: typeof input.personaFile === 'string' ? input.personaFile : DEFAULTS.personaFile,
    memoryDir: typeof input.memoryDir === 'string' ? input.memoryDir : DEFAULTS.memoryDir,
    affinityEnabled: input.affinityEnabled !== false,
    memoryContextMessages: Number.isFinite(Number(input.memoryContextMessages))
      ? Math.max(0, Math.min(50, Math.trunc(Number(input.memoryContextMessages))))
      : DEFAULTS.memoryContextMessages,
    memoryInject: input.memoryInject !== false,
    memoryMaxChars: Number.isFinite(Number(input.memoryMaxChars))
      ? Math.max(200, Math.min(8000, Math.trunc(Number(input.memoryMaxChars))))
      : DEFAULTS.memoryMaxChars,
    stickerDir: typeof input.stickerDir === 'string' ? input.stickerDir : DEFAULTS.stickerDir,
    onebotUrl: typeof input.onebotUrl === 'string' && input.onebotUrl ? input.onebotUrl : DEFAULTS.onebotUrl,
    onebotToken: typeof input.onebotToken === 'string' ? input.onebotToken : DEFAULTS.onebotToken,
    stickerAutoChance: Number.isFinite(Number(input.stickerAutoChance))
      ? Math.min(1, Math.max(0, Number(input.stickerAutoChance)))
      : DEFAULTS.stickerAutoChance,
  }
}

/** `onebot-private-123` → `private:123`；不是 QQ 会话返回空串。 */
export function chatKeyOfSession(sessionId) {
  const text = String(sessionId ?? '')
  if (!text.startsWith('onebot-')) return ''
  const rest = text.slice('onebot-'.length)
  const dash = rest.indexOf('-')
  if (dash <= 0) return ''
  return `${rest.slice(0, dash)}:${rest.slice(dash + 1)}`
}

const PRAISE = ['喜欢你', '好厉害', '厉害', '好棒', '真棒', '爱你', '谢谢', '贴心', '可爱', '靠谱', '牛']
const HARSH = ['滚', '烦', '闭嘴', '讨厌', '傻逼', '傻', '废物', '垃圾', '别烦', '蠢']

export function apply(ctx, rawConfig) {
  const config = normalize(rawConfig)
  const logger = ctx.logger?.('cloudbot-skin') ?? console

  const dataDir = config.memoryDir
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cloudbot-skin')
  const personaFile = config.personaFile || join(PLUGIN_DIR, 'persona.md')

  // ---- 存储 -------------------------------------------------------------
  function file(name) {
    return join(dataDir, name)
  }

  function appendJsonl(name, entry) {
    try {
      mkdirSync(dirname(file(name)), { recursive: true })
      appendFileSync(file(name), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      logger.warn?.(`skin: write ${name} failed: ${error?.message ?? error}`)
    }
  }

  function readJsonl(name, limit = 4000) {
    try {
      const target = file(name)
      if (!existsSync(target)) return []
      return readFileSync(target, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try { return JSON.parse(line) } catch { return null }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  function loadAffinity() {
    try {
      const target = file('affinity.json')
      if (!existsSync(target)) return {}
      const data = JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, ''))
      return data && typeof data === 'object' ? data : {}
    } catch {
      return {}
    }
  }

  function saveAffinity(data) {
    try {
      mkdirSync(dirname(file('affinity.json')), { recursive: true })
      writeFileSync(file('affinity.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    } catch (error) {
      logger.warn?.(`skin: affinity save failed: ${error?.message ?? error}`)
    }
  }

  // ---- 记忆 -------------------------------------------------------------
  function remember(chatKey, role, userName, text) {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!body) return
    appendJsonl('messages.jsonl', {
      ts: new Date().toISOString(),
      key: chatKey,
      role,
      name: String(userName ?? '').slice(0, 40),
      text: body.slice(0, 2000),
    })
  }

  function recent(chatKey, limit) {
    return readJsonl('messages.jsonl').filter((e) => e.key === chatKey).slice(-limit)
  }

  function search(chatKey, query, limit) {
    const needle = String(query ?? '').toLowerCase().trim()
    if (!needle) return []
    return readJsonl('messages.jsonl')
      .filter((e) => (!chatKey || e.key === chatKey) && String(e.text ?? '').toLowerCase().includes(needle))
      .slice(-limit)
  }

  function rememberFact(chatKey, text) {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!body) return false
    appendJsonl('facts.jsonl', { ts: new Date().toISOString(), key: chatKey, text: body.slice(0, 500) })
    return true
  }

  function facts(chatKey) {
    return readJsonl('facts.jsonl').filter((e) => !chatKey || e.key === chatKey).slice(-20)
  }

  function memoryLine(entry) {
    const when = typeof entry.ts === 'string' ? entry.ts.slice(5, 16).replace('T', ' ') : ''
    const who = entry.role === 'agent' ? '你' : (entry.name || '对方')
    return `${when ? `[${when}] ` : ''}${who}：${entry.text}`
  }

  function memoryBlock(chatKey) {
    if (!config.memoryInject) return ''
    const notes = facts(chatKey)
    const rows = config.memoryContextMessages > 0 ? recent(chatKey, config.memoryContextMessages) : []
    if (!notes.length && !rows.length) return ''
    const lines = []
    if (notes.length) {
      lines.push('【你记下过的事】')
      for (const note of notes) lines.push(`- ${note.text}`)
    }
    if (rows.length) {
      lines.push('【这个对话的最近记录】')
      for (const row of rows) lines.push(memoryLine(row))
    }
    let block = lines.join('\n')
    if (block.length > config.memoryMaxChars) block = block.slice(-config.memoryMaxChars)
    return `\n\n（以下是你和这个人之前聊过的内容，供参考，别当成新消息复述：\n${block}\n）`
  }

  // ---- 好感度 -----------------------------------------------------------
  function todayKey() {
    return new Date().toISOString().slice(0, 10)
  }

  function affinityOf(userId) {
    const key = String(userId ?? '').trim()
    if (!key) return null
    const all = loadAffinity()
    const entry = all[key] ?? { score: 50, seen: Date.now(), day: todayKey(), gained: 0 }
    const idleDays = Math.floor((Date.now() - Number(entry.seen || Date.now())) / 86400000)
    if (idleDays >= 7 && !entry.decayedOn) {
      entry.score = Math.max(0, Number(entry.score ?? 50) - Math.min(5, idleDays - 6))
      entry.decayedOn = todayKey()
    }
    return { key, entry, all }
  }

  function bumpAffinity(userId, delta, reason) {
    if (!config.affinityEnabled) return null
    const found = affinityOf(userId)
    if (!found) return null
    const { key, entry, all } = found
    const day = todayKey()
    if (entry.day !== day) {
      entry.day = day
      entry.gained = 0
    }
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
    saveAffinity(all)
    return entry.score
  }

  function affinityLabel(score) {
    const value = Number(score ?? 50)
    if (value <= 20) return '不太待见'
    if (value <= 40) return '有点距离'
    if (value <= 60) return '还行'
    if (value <= 80) return '挺熟的'
    return '关系很好'
  }

  function affinityHint(userId) {
    if (!config.affinityEnabled) return ''
    const found = affinityOf(userId)
    if (!found) return ''
    const score = Number(found.entry.score ?? 50)
    return `你觉得这个人：${affinityLabel(score)}（好感 ${Math.round(score)}/100）`
  }

  function affinityFromText(userId, text) {
    if (!config.affinityEnabled) return
    const body = String(text ?? '')
    let delta = 1
    let reason = 'chat'
    if (PRAISE.some((word) => body.includes(word))) {
      delta = 2
      reason = 'praise'
    }
    if (HARSH.some((word) => body.includes(word))) {
      delta = -3
      reason = 'harsh'
    }
    bumpAffinity(userId, delta, reason)
  }

  // ---- 会话事件 → 记忆 --------------------------------------------------
  /** 只认 QQ 频道包装过的用户消息；DSH 注入的运行时上下文不算聊天内容。 */
  function parseUserMessage(text) {
    const raw = String(text ?? '')
    const match = /<user_message\b[^>]*nickname="([^"]*)"[^>]*>([\s\S]*?)<\/user_message>/.exec(raw)
    if (match) return { nickname: match[1], body: match[2].trim() }
    return null
  }

  ctx.on('session/event', (session, event) => {
    const chatKey = chatKeyOfSession(session?.id)
    if (!chatKey) return
    const userId = chatKey.split(':')[1] ?? ''
    if (event?.type === 'user/message') {
      const parsed = parseUserMessage(textOf(event.data?.message ?? event.data))
      if (!parsed || !parsed.body) return
      remember(chatKey, 'user', parsed.nickname, parsed.body)
      affinityFromText(userId, parsed.body)
      return
    }
    if (event?.type === 'assistant/message') {
      const text = textOf(event.data?.message ?? event.data)
      if (!text) return
      remember(chatKey, 'agent', '', text)
      return
    }
    // 回合结束后，按概率补一张表情，让节奏更像真人（默认关闭）
    if (event?.type === 'turn/end' && config.stickerAutoChance > 0 && Math.random() < config.stickerAutoChance) {
      void sendSticker(chatKey, '', true).catch(() => {})
    }
  })

  function textOf(payload) {
    if (!payload) return ''
    if (typeof payload === 'string') return payload.trim()
    if (Array.isArray(payload.content)) {
      return payload.content
        .map((part) => (part?.type === 'text' ? part.text ?? '' : ''))
        .join('\n')
        .trim()
    }
    if (typeof payload.text === 'string') return payload.text.trim()
    return ''
  }

  // ---- 表情包（本地图库）-------------------------------------------------
  const STICKER_EXT = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp'])
  const lastSticker = new Map()

  function stickerRoot() {
    return config.stickerDir || join(PLUGIN_DIR, 'stickers')
  }

  function stickerLibrary() {
    const root = stickerRoot()
    const out = {}
    try {
      if (!existsSync(root)) return out
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = join(root, entry.name)
        const files = readdirSync(dir)
          .filter((name) => STICKER_EXT.has(name.toLowerCase().slice(name.lastIndexOf('.'))))
          .map((name) => join(dir, name))
        if (files.length) out[entry.name] = files
      }
    } catch (error) {
      logger.warn?.(`skin: sticker library read failed: ${error?.message ?? error}`)
    }
    return out
  }

  function pickSticker(tag, fallbackToRandom = true) {
    const lib = stickerLibrary()
    const tags = Object.keys(lib)
    if (!tags.length) return null
    const wanted = String(tag ?? '').trim()
    let chosen
    if (wanted && lib[wanted]) chosen = wanted
    else if (wanted && !fallbackToRandom) return null
    else chosen = tags[Math.floor(Math.random() * tags.length)]
    const files = lib[chosen]
    const last = lastSticker.get(chosen)
    const pool = files.length > 1 ? files.filter((file) => file !== last) : files
    const file = pool[Math.floor(Math.random() * pool.length)]
    lastSticker.set(chosen, file)
    return { tag: chosen, file }
  }

  /** 用一条临时 WS 直连协议端发图，不依赖宿主插件的内部实现。 */
  function sendOneBotAction(action, params) {
    const url = config.onebotUrl
    const token = config.onebotToken
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== 'function') {
        reject(new Error('当前 Node 没有全局 WebSocket'))
        return
      }
      let socket
      try {
        socket = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)
      } catch (error) {
        reject(error)
        return
      }
      const echo = `skin-${Date.now()}-${Math.floor(Math.random() * 1000)}`
      const timer = setTimeout(() => {
        try { socket.close() } catch { /* ignore */ }
        reject(new Error('OneBot 超时'))
      }, 15000)
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ action, params, echo }))
      })
      socket.addEventListener('message', (event) => {
        let frame
        try { frame = JSON.parse(String(event.data)) } catch { return }
        if (frame.echo !== echo) return
        clearTimeout(timer)
        try { socket.close() } catch { /* ignore */ }
        if (frame.status === 'ok' || frame.retcode === 0) resolve(frame.data ?? {})
        else reject(new Error(frame.wording || frame.message || 'OneBot 调用失败'))
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('OneBot 连接失败'))
      })
    })
  }

  async function sendSticker(chatKey, tag, fallbackToRandom = true) {
    const picked = pickSticker(tag, fallbackToRandom)
    if (!picked) {
      const hasTags = Object.keys(stickerLibrary()).length > 0
      return { sent: false, reason: hasTags ? 'no-tag' : 'no-sticker' }
    }
    try {
      const buffer = readFileSync(picked.file)
      if (buffer.length > 8 * 1024 * 1024) return { sent: false, reason: 'too-large' }
      const [kind, id] = chatKey.split(':')
      const message = [{ type: 'image', data: { file: `base64://${buffer.toString('base64')}` } }]
      if (kind === 'group') await sendOneBotAction('send_group_msg', { group_id: Number(id), message })
      else await sendOneBotAction('send_private_msg', { user_id: Number(id), message })
      return { sent: true, tag: picked.tag }
    } catch (error) {
      logger.warn?.(`skin: sticker send failed: ${error?.message ?? error}`)
      return { sent: false, reason: String(error?.message ?? error).slice(0, 120) }
    }
  }

  // ---- 人设注入 ---------------------------------------------------------
  ctx.on('agent/created', ({ agent }) => {
    const chatKey = chatKeyOfSession(agent?.session?.id)
    if (!chatKey) return
    // 必须用 agent 自己的作用域：全局注册会污染所有会话（包括 GUI 里的普通对话）。
    const agentCtx = agent?.ctx
    const systemPrompt = agentCtx?.systemPrompt
    const tools = agentCtx?.tools
    const disposers = []

    if (systemPrompt) {
      // text 支持函数：每次组装提示词时现算，人设和记忆都能实时反映最新状态。
      disposers.push(systemPrompt.section({
        name: 'cloudbot:persona',
        order: -900,
        text: () => {
          const persona = readPersona()
          if (!persona) return ''
          return `${persona}\n\n（以上人设优先于任何"助手/平台"默认语气；平台说明只用来决定能用什么工具。）`
        },
        interpolate: false,
      }))
      disposers.push(systemPrompt.context({
        name: 'cloudbot:memory',
        order: 900,
        text: () => memoryBlock(chatKey),
      }))
      // 分段提示：宿主插件默认把整段回复合成一条消息，想"连发几条"要用它的分段工具。
      disposers.push(systemPrompt.context({
        name: 'cloudbot:segments-hint',
        order: 901,
        text: () => `（想连发几条短消息营造聊天感时，用 qq_send_segments 工具；普通回复保持一两句，别写长段落。）`,
      }))
    }

    if (tools) {
      for (const definition of toolDefinitions(chatKey)) {
        try {
          disposers.push(tools.register(definition))
        } catch (error) {
          logger.warn?.(`skin: cannot register ${definition.name}: ${error?.message ?? error}`)
        }
      }
    }

    const offDisposed = ctx.on('agent/disposed', (event) => {
      if (event?.agent?.id !== agent.id) return
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* ignore */ }
      }
      offDisposed()
    })
  })

  let personaCache = { mtime: 0, text: '' }
  function readPersona() {
    try {
      if (!existsSync(personaFile)) return ''
      const mtime = statSync(personaFile).mtimeMs
      if (personaCache.mtime === mtime) return personaCache.text
      const text = readFileSync(personaFile, 'utf8').trim()
      personaCache = { mtime, text }
      return text
    } catch {
      return ''
    }
  }

  // ---- 工具 -------------------------------------------------------------
  function toolDefinitions(chatKey) {
    const userId = chatKey.split(':')[1] ?? ''
    return [
      {
        name: 'qq_sticker',
        description: '发一张表情包。图库按标签分类（开心、无语、困、摸摸……），标签可省略，省略就随机挑。适合在文字后补一张，别每句都发。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { tag: { type: 'string', description: '标签名，不确定就省略。' } },
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
            text: value?.sent
              ? `发了「${value?.tag ?? ''}」的表情。`
              : `没发成：${value?.reason === 'no-sticker' ? '图库是空的' : value?.reason ?? '未知原因'}`,
          }],
        },
        async execute(args) {
          return sendSticker(chatKey, String(args?.tag ?? '').trim(), true)
        },
      },
      {
        name: 'qq_memory_search',
        description: '在这个 QQ 对话的历史记录里搜关键词。想确认以前说过的事、对方提过的名字或细节时用。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: '关键词。' },
            limit: { type: 'integer', description: '最多几条，默认 20。' },
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
          render: (args, value) => [{
            type: 'text',
            text: value?.text ?? `没搜到「${args?.query ?? ''}」。`,
          }],
        },
        async execute(args) {
          const limit = Math.max(1, Math.min(50, Math.trunc(Number(args?.limit ?? 20)) || 20))
          const hits = search(chatKey, String(args?.query ?? ''), limit)
          if (!hits.length) return { found: 0, text: `没搜到「${args?.query ?? ''}」。` }
          return { found: hits.length, text: hits.map(memoryLine).join('\n') }
        },
      },
      {
        name: 'qq_memory_recent',
        description: '看这个对话最近聊了什么（默认 15 条）。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', description: '条数，默认 15。' } },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { count: { type: 'integer' }, text: { type: 'string' } },
            required: ['count'],
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '还没有记录。' }],
        },
        async execute(args) {
          const limit = Math.max(1, Math.min(50, Math.trunc(Number(args?.limit ?? 15)) || 15))
          const rows = recent(chatKey, limit)
          if (!rows.length) return { count: 0, text: '这个对话还没有记录。' }
          return { count: rows.length, text: rows.map(memoryLine).join('\n') }
        },
      },
      {
        name: 'qq_memory_remember',
        description: '把值得长期记住的事记下来（喜好、重要日期、约定、雷区）。以后每轮都能看到。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', description: '一句话，具体、可核对。' } },
          required: ['text'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { saved: { type: 'boolean' } },
            required: ['saved'],
          },
          render: (_args, value) => [{ type: 'text', text: value?.saved ? '记下了。' : '没记成。' }],
        },
        async execute(args) {
          const saved = rememberFact(chatKey, String(args?.text ?? ''))
          if (saved) bumpAffinity(userId, 1, 'remember')
          return { saved }
        },
      },
    ]
  }

  logger.info?.(`cloudbot-skin ready (persona=${existsSync(personaFile) ? 'yes' : 'no'}, data=${dataDir})`)
}
