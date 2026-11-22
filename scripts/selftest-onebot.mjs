#!/usr/bin/env node
/**
 * 一键自检：检查新架构（dsh-onebot-qq + cloudbot-skin）的线上状态。
 *
 *   node scripts/selftest-onebot.mjs
 *   node scripts/selftest-onebot.mjs --json
 *
 * 只读：不修改任何文件、不发任何 QQ 消息。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const asJson = process.argv.includes('--json')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const MEDIA = join(DSH_HOME, 'media', 'onebot')
const PLUGIN_DIR = process.env.CLOUDBOT_PLUGIN_DIR || 'D:/deepseek harness desktop/qq-bridge'
const PERSONA = join(PLUGIN_DIR, 'persona.md')
const STICKERS = join(PLUGIN_DIR, 'stickers')
const MEMORY = join(PLUGIN_DIR, 'state', 'memory')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

function probePort(port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

// 1) Node 版本
const major = Number(process.versions.node.split('.')[0])
check('Node 版本', major >= 20, `v${process.versions.node}`)

// 2) 协议端端口
const port = Number(process.env.ONEBOT_PORT || 3001)
const portUp = await probePort(port)
check(`协议端端口 ${port}`, portUp, portUp ? '在监听' : '没有监听（协议端没启动或没登录）')

// 3) profile 的 bundles
const pkg = readJson(join(PROFILE, 'package.json'))
const bundles = pkg?.dsh?.profile?.bundles ?? []
check('bundles 含 dsh-onebot-qq', bundles.includes('dsh-onebot-qq'), bundles.join(', '))
check('bundles 含 cloudbot-skin', bundles.includes('@local/dsh-cloudbot-skin'), '')

// 4) 插件是否活跃（trace 或会话映射是否近期更新）
const sessions = readJson(join(MEDIA, 'chat-sessions.json'))
const sessionCount = sessions ? Object.keys(sessions).length : 0
check('会话映射文件', sessions !== null, sessions === null ? '读不到 chat-sessions.json' : `${sessionCount} 个会话`)
const traceFile = join(MEDIA, 'qq-trace.jsonl')
const traceExists = existsSync(traceFile)
let traceAge = ''
if (traceExists) {
  const minutes = Math.round((Date.now() - statSync(traceFile).mtimeMs) / 60000)
  traceAge = `${minutes} 分钟前有事件`
  check('trace 文件', true, traceAge)
} else {
  check('trace 文件', false, '没有（traceEnabled 可能是 false，或还没收到过消息）')
}

// 5) 人设
const personaOk = existsSync(PERSONA) && statSync(PERSONA).size > 500
check('人设文件', personaOk, personaOk ? `${(statSync(PERSONA).size / 1024).toFixed(1)} KB` : '缺失或过小')

// 6) 表情图库
let tags = []
try {
  for (const entry of (await import('node:fs')).readdirSync(STICKERS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const files = (await import('node:fs')).readdirSync(join(STICKERS, entry.name)).filter((n) => /\.(gif|png|jpe?g|webp)$/i.test(n))
    if (files.length) tags.push(`${entry.name}(${files.length})`)
  }
} catch {
  /* 目录不存在 */
}
check('表情图库', tags.length > 0, tags.length ? tags.join(' ') : '没有可用标签')

// 7) 记忆目录
const memoryFile = join(MEMORY, 'messages.jsonl')
let messageCount = 0
try {
  messageCount = readFileSync(memoryFile, 'utf8').split(/\r?\n/).filter(Boolean).length
} catch {
  /* 缺失 */
}
check('记忆文件', existsSync(memoryFile), `${messageCount} 条记录`)

// 输出
const failed = results.filter((r) => !r.ok).length
if (asJson) {
  console.log(JSON.stringify({ ok: failed === 0, results }, null, 2))
  process.exit(failed ? 1 : 0)
}

console.log('=== cloudbot 自检（onebot 架构）===')
for (const r of results) {
  const tag = r.ok ? '[ OK ]' : '[FAIL]'
  console.log(`${tag} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
}
console.log(failed === 0 ? '\n全部正常。' : `\n${failed} 项异常。`)
process.exit(failed ? 1 : 0)
