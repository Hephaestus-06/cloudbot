/**
 * bot-console — QQ 机器人的远程配置台（第一版）
 *
 * 只做三件事：
 *   1. 读/写人设文件（Markdown）
 *   2. 读/写机器人配置里的少量关键项（白名单、开关、模型）
 *   3. 看状态（OneBot 端口是否在听、账号是否在线）
 *
 * 零依赖：只用 Node 内置模块 + 全局 fetch/WebSocket。
 * 写配置时会触发 DSH 的配置重载，所以保存即生效（约 1-2 秒）。
 */

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ---------------------------------------------------------------------------
// 配置：config.json 存在就用它，否则用这里的默认值
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  port: 8787,
  host: '127.0.0.1',
  // DSH 的 profile 目录，配置覆盖行（cordis.patch.yml）在这里
  profileDir: 'C:/Users/RUAN/.dsh/profiles/desktop',
  // qq-bridge 插件目录（人设文件在里面）
  pluginDir: 'D:/deepseek harness desktop/qq-bridge',
  // OneBot 的 WebSocket 地址，用于探测在线状态
  oneBotWs: 'ws://127.0.0.1:3001',
  // 配置行的 id 与包名
  rowId: 'qq-bridge',
  packageName: '@local/dsh-qq-bridge',
}

function loadConfig() {
  const file = process.env.BOT_CONSOLE_CONFIG || join(ROOT, 'config.json')
  // Windows 编辑器/PowerShell 常带 UTF-8 BOM，JSON.parse 会直接报错，先剥掉
  const saved = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    : {}
  // 环境变量优先于配置文件，方便 Docker / systemd 部署
  const fromEnv = {}
  if (process.env.PORT) fromEnv.port = Number(process.env.PORT)
  if (process.env.HOST) fromEnv.host = process.env.HOST
  if (process.env.PROFILE_DIR) fromEnv.profileDir = process.env.PROFILE_DIR
  if (process.env.PLUGIN_DIR) fromEnv.pluginDir = process.env.PLUGIN_DIR
  if (process.env.ONEBOT_WS) fromEnv.oneBotWs = process.env.ONEBOT_WS
  return { ...DEFAULT_CONFIG, ...saved, ...fromEnv, _file: file }
}

const config = loadConfig()

/** 允许通过网页修改的配置项，及其类型校验。 */
const EDITABLE = {
  allowedUsers: 'stringList',
  allowedGroups: 'stringList',
  admins: 'stringList',
  notifyUsers: 'stringList',
  ambientGroups: 'stringList',
  botProvider: 'string',
  botModel: 'string',
  chatMode: 'boolean',
  proactiveEnabled: 'boolean',
  proactiveQuietMinutes: 'int',
  proactiveMaxPerHour: 'int',
  autoApproveFriend: 'boolean',
  autoApproveGroup: 'boolean',
  notifyFriendRequests: 'boolean',
  typingIndicator: 'boolean',
  pokeBack: 'boolean',
  ambientChance: 'number',
  ambientMinGapMinutes: 'int',
  ambientMaxPerHour: 'int',
  bubbleMaxChars: 'int',
  maxBubbles: 'int',
}

// ---------------------------------------------------------------------------
// token：文件不存在就生成一个，打印在启动日志里
// ---------------------------------------------------------------------------
function loadToken() {
  if (process.env.BOT_CONSOLE_TOKEN) return process.env.BOT_CONSOLE_TOKEN
  const file = join(ROOT, '.token')
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim()
    if (saved) return saved
  }
  const token = randomBytes(18).toString('base64url')
  writeFileSync(file, `${token}\n`, 'utf8')
  return token
}

const token = loadToken()

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------
const paths = {
  persona: () => join(config.pluginDir, 'persona.md'),
  patch: () => join(config.profileDir, 'cordis.patch.yml'),
}

/**
 * 人设文件允许写入的位置：插件目录之内。
 * 配置里的 personaFile 可能指向别处（比如线上机器人的目录），
 * 那种情况只读展示、拒绝写入——避免误改别的部署。
 */
function personaTarget() {
  const row = readRowConfig()
  const file = resolve(row.config.personaFile || paths.persona())
  const root = resolve(config.pluginDir)
  const inside = file === root || file.startsWith(root.endsWith(sep) ? root : root + sep)
  return { file, inside }
}

function readText(file, fallback = '') {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : fallback
  } catch {
    return fallback
  }
}

/** 先写临时文件再原子替换，避免写一半把配置弄坏。 */
function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 把 JSON 值输出成 YAML 能直接读的流式映射（JSON 是 YAML 子集）。 */
function toFlowMapping(value) {
  return JSON.stringify(value)
}

/**
 * 在 patch 文档里找到（或插入）机器人那一行，并整体替换它的 config。
 * 其它行原样保留。
 */
function upsertRow(text, rowId, packageName, nextConfig) {
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim().startsWith(`- id: ${rowId}`))
  const header = [
    `- id: ${rowId}`,
    `  name: "${packageName}"`,
    `  config: ${toFlowMapping(nextConfig)}`,
  ]
  if (start === -1) {
    const body = String(text ?? '').replace(/\s+$/, '')
    return { text: `${body ? `${body}\n` : ''}${header.join('\n')}\n`, inserted: true }
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^-\s/.test(lines[index])) {
      end = index
      break
    }
  }
  // 保留原来的 disabled 状态（没有就默认启用）
  const block = lines.slice(start, end).join('\n')
  const disabled = /^\s+disabled:\s*true\s*$/m.test(block)
  if (disabled) header.push('  disabled: true')
  const next = [...lines.slice(0, start), ...header, ...lines.slice(end)]
  return { text: `${next.join('\n').replace(/\s+$/, '')}\n`, inserted: false }
}

function readRowConfig() {
  const text = readText(paths.patch())
  const match = /^- id: qq-bridge[\s\S]*?^\s+config:\s*(\{[\s\S]*?\})\s*$/m.exec(text)
  if (!match) return { text, config: {}, found: false }
  try {
    return { text, config: JSON.parse(match[1]), found: true }
  } catch {
    return { text, config: {}, found: true, broken: true }
  }
}

// ---------------------------------------------------------------------------
// 类型校验
// ---------------------------------------------------------------------------
function asStringList(value) {
  if (!Array.isArray(value)) throw new Error('需要字符串数组')
  return value.map((item) => String(item).trim()).filter(Boolean)
}

function coerce(key, kind, value) {
  switch (kind) {
    case 'stringList':
      return asStringList(value)
    case 'string':
      return String(value ?? '').trim()
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${key} 需要布尔值`)
      return value
    case 'int': {
      const parsed = Number.parseInt(String(value), 10)
      if (!Number.isFinite(parsed)) throw new Error(`${key} 需要整数`)
      return parsed
    }
    case 'number': {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`${key} 需要数字`)
      return parsed
    }
    default:
      return value
  }
}

function validatePatch(patch) {
  const clean = {}
  for (const [key, value] of Object.entries(patch ?? {})) {
    const kind = EDITABLE[key]
    if (!kind) throw new Error(`不允许修改的配置项：${key}`)
    clean[key] = coerce(key, kind, value)
  }
  return clean
}

// ---------------------------------------------------------------------------
// 状态探测
// ---------------------------------------------------------------------------
function tcpCheck(host, port, timeoutMs = 800) {
  return new Promise((resolveResult) => {
    const socket = connect({ host, port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      socket.destroy()
      resolveResult(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function oneBotStatus() {
  const url = config.oneBotWs
  if (typeof WebSocket !== 'function') return { reachable: false, reason: '当前 Node 没有全局 WebSocket（需要 Node 22+）' }
  return new Promise((resolveResult) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolveResult(result)
    }
    let socket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      resolveResult({ reachable: false, reason: String(error) })
      return
    }
    const timer = setTimeout(() => finish({ reachable: false, reason: '超时' }), 3000)
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'c1' }))
    })
    socket.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse(String(event.data))
        if (frame.echo === 'c1') {
          clearTimeout(timer)
          finish({ reachable: true, online: frame.data?.online === true, good: frame.data?.good === true })
        }
      } catch {
        /* ignore */
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      finish({ reachable: false, reason: '连接失败' })
    })
  })
}

async function collectState() {
  const row = readRowConfig()
  const target = personaTarget()
  const persona = readText(target.file)
  const port = Number(config.oneBotWs.replace(/^.*:(\d+).*$/, '$1'))
  const portUp = await tcpCheck('127.0.0.1', port)
  const oneBot = portUp ? await oneBotStatus() : { reachable: false, reason: '端口未监听' }
  return {
    paths: {
      persona: target.file,
      patch: paths.patch(),
      profileDir: config.profileDir,
      pluginDir: config.pluginDir,
    },
    persona: {
      text: persona,
      bytes: Buffer.byteLength(persona, 'utf8'),
      editable: target.inside,
      reason: target.inside ? '' : '人设文件在插件目录之外，只读展示；要改请手工编辑或调整 personaFile。',
    },
    config: row.config,
    rowFound: row.found,
    rowBroken: Boolean(row.broken),
    status: {
      oneBotPort: port,
      portUp,
      online: oneBot.online === true,
      oneBotReason: oneBot.reason ?? '',
      checkedAt: new Date().toISOString(),
    },
    editable: Object.keys(EDITABLE),
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const WEB_DIR = join(ROOT, 'web')

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolveBody({})
      try {
        resolveBody(JSON.parse(raw))
      } catch {
        reject(new Error('JSON 解析失败'))
      }
    })
    req.on('error', reject)
  })
}

function authorized(req) {
  const header = req.headers['x-token']
  if (typeof header === 'string' && safeEqual(header, token)) return true
  const url = new URL(req.url, 'http://localhost')
  const query = url.searchParams.get('token')
  return typeof query === 'string' && safeEqual(query, token)
}

function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a)).digest()
  const right = createHash('sha256').update(String(b)).digest()
  return left.length === right.length && createHash('sha256').update(a).digest().equals(right) && a === b
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  // 无鉴权的健康检查：只回答“活着”，用于启动器探测，不暴露任何配置
  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) })
    return
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('未授权：请带上正确的 token（.?token=...）')
    return
  }
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = readText(join(WEB_DIR, 'index.html'), '缺少 web/index.html')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, await collectState())
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/persona') {
      const body = await readBody(req)
      const text = String(body.text ?? '')
      if (text.trim().length === 0) {
        sendJson(res, 400, { ok: false, error: '人设不能为空' })
        return
      }
      const target = personaTarget()
      if (!target.inside) {
        sendJson(res, 409, {
          ok: false,
          error: `人设文件不在插件目录内，拒绝写入：${target.file}（要改请手工编辑，或把 personaFile 指到插件目录里）`,
        })
        return
      }
      writeTextAtomic(target.file, text)
      sendJson(res, 200, { ok: true, bytes: Buffer.byteLength(text, 'utf8'), file: target.file })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req)
      const patch = validatePatch(body.patch)
      const row = readRowConfig()
      if (row.broken) {
        sendJson(res, 409, { ok: false, error: '现有配置行解析失败，先手工修好再保存' })
        return
      }
      const nextConfig = { ...row.config, ...patch }
      const next = upsertRow(row.text, config.rowId, config.packageName, nextConfig)
      writeTextAtomic(paths.patch(), next.text)
      sendJson(res, 200, { ok: true, changed: Object.keys(patch), inserted: next.inserted })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/reload') {
      // 重写同一份内容即可触发 DSH 的配置重载
      const row = readRowConfig()
      const next = upsertRow(row.text, config.rowId, config.packageName, row.config)
      writeTextAtomic(paths.patch(), next.text)
      sendJson(res, 200, { ok: true })
      return
    }

    // 让用户在没有终端的情况下也能关掉服务（界面上的“关闭服务”按钮）
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      sendJson(res, 200, { ok: true })
      setTimeout(() => process.exit(0), 300)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
})

/** 用系统默认浏览器打开控制台地址（--open 时使用）。 */
function openBrowser(url) {
  const platform = process.platform
  const command = platform === 'win32'
    ? `start "" "${url}"`
    : platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`
  try {
    spawn(platform === 'win32' ? 'cmd' : 'sh', platform === 'win32' ? ['/c', command] : ['-c', command], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  } catch {
    /* 打开失败不影响服务，地址已经打印出来了 */
  }
}

// 端口被占用时给出人话，而不是一串堆栈
server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    const url = `http://${config.host}:${config.port}/?token=${token}`
    console.error('')
    console.error(`端口 ${config.port} 已被占用，无法启动。`)
    console.error('  最常见的情况：已经有一个 bot-console 在跑了。直接打开这个地址即可：')
    console.error(`  ${url}`)
    console.error('  如果打不开，说明占用端口的是别的程序——改 config.json 里的 port，或先关掉那个程序。')
    console.error('')
    process.exit(1)
  }
  console.error('服务启动失败：', error)
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}/?token=${token}`
  console.log('bot-console 已启动')
  console.log(`  地址: ${url}`)
  console.log('  提示: 如果浏览器没有自动打开，把上面这个地址复制到浏览器即可（地址里带访问令牌，别外传）')
  console.log(`  profile: ${resolve(config.profileDir)}`)
  console.log(`  plugin : ${resolve(config.pluginDir)}`)
  console.log(`  配置  : ${config._file}`)
  if (process.argv.includes('--open')) openBrowser(url)
})
