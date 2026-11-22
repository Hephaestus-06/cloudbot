#!/usr/bin/env node
/**
 * cloudbot 安装器：把一个 profile 配成 QQ 机器人。
 *
 * 两种模式：
 *   node install.mjs --mode onebot --bot-qq 123456 --allow 111,222 --admin 111
 *   node install.mjs --mode bridge                        （旧方案，保留兼容）
 *
 * 其它参数：
 *   --profile <name>     profile 名，默认 cloudbot
 *   --dsh-home <path>    DSH 数据目录，默认 $DSH_HOME 或 ~/.dsh
 *   --dry-run            只打印计划
 *
 * 幂等：已有 profile 复用，已有配置不覆盖。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKIN = join(HERE, 'skin')
const BRIDGE = join(HERE, 'bridge')

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const dryRun = argv.includes('--dry-run')
const mode = arg('mode', 'onebot')
const profile = arg('profile', 'cloudbot')
const botQQ = arg('bot-qq', '')
const adminQQ = arg('admin', '')
const allowList = arg('allow', '')
const dshHome = resolve(arg('dsh-home', process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')))

const log = (msg) => console.log(msg)
function fail(msg) {
  console.error(`\n[错误] ${msg}\n`)
  process.exit(1)
}

// ---- 环境 ---------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split('.')[0])
log(`Node ${process.versions.node}`)
if (nodeMajor < 20) fail('需要 Node 20 或更高版本（https://nodejs.org/）')

function dshEntry() {
  const candidates = []
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  candidates.push(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return ''
}
const DSH_BIN = dshEntry()
function runDsh(args, options = {}) {
  if (DSH_BIN) return spawnSync(process.execPath, [DSH_BIN, ...args], { encoding: 'utf8', ...options })
  const line = ['dsh', ...args].map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ')
  return process.platform === 'win32'
    ? spawnSync('cmd', ['/d', '/s', '/c', line], { encoding: 'utf8', ...options })
    : spawnSync('sh', ['-c', line], { encoding: 'utf8', ...options })
}

const dshVersion = runDsh(['--version'])
if (dshVersion.status !== 0) {
  fail('没检测到 dsh CLI。先安装：npm i -g @deepseek-ai/dsh')
}
log(`DSH CLI：${String(dshVersion.stdout).trim()}`)

if (mode === 'bridge') {
  if (!existsSync(join(BRIDGE, 'index.js'))) fail(`找不到旧桥接插件：${BRIDGE}`)
} else {
  if (!existsSync(join(SKIN, 'index.js'))) fail(`找不到皮肤插件：${SKIN}`)
  if (!botQQ) fail('--mode onebot 需要 --bot-qq <机器人QQ号>')
}

const profileDir = join(dshHome, 'profiles', profile)
const pkgFile = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')
const personaFile = join(HERE, 'persona.md')
log(`profile：${profileDir}`)

const plan = []
if (!existsSync(profileDir)) plan.push(`创建目录 ${profileDir}`)
plan.push(`写入 package.json 依赖与 bundles`)
if (mode === 'onebot') {
  plan.push(`安装 dsh-onebot-qq@0.11.0 与 link:${SKIN}`)
  plan.push(`写入 dsh-onebot / cloudbot-skin 配置行`)
} else {
  plan.push(`安装 link:${BRIDGE}`)
}
if (!existsSync(personaFile)) plan.push(`从 bridge/persona.example.md 生成 persona.md`)

if (dryRun) {
  log('\n[dry-run] 将要做：')
  for (const step of plan) log(`  - ${step}`)
  process.exit(0)
}

// ---- profile 骨架 -------------------------------------------------------
mkdirSync(profileDir, { recursive: true })
let pkg = { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }
if (existsSync(pkgFile)) {
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    fail(`已有 package.json 解析失败：${pkgFile}`)
  }
}
pkg.dependencies = pkg.dependencies ?? {}

// ---- 人设 ---------------------------------------------------------------
if (!existsSync(personaFile)) {
  const example = join(BRIDGE, 'persona.example.md')
  if (existsSync(example)) {
    writeFileSync(personaFile, readFileSync(example, 'utf8'), 'utf8')
    log('已从示例生成 persona.md')
  }
}

// ---- 安装依赖 -----------------------------------------------------------
const packages = mode === 'onebot'
  ? [{ spec: 'dsh-onebot-qq@0.11.0' }, { spec: `link:${SKIN.replace(/\\/g, '/')}` }]
  : [{ spec: `link:${BRIDGE.replace(/\\/g, '/')}` }]

for (const entry of packages) {
  log(`安装 ${entry.spec} …`)
  const result = runDsh(['plugin', '--profile', profile, 'add', entry.spec], { cwd: profileDir, env: { ...process.env, DSH_HOME: dshHome } })
  if (result.status !== 0) {
    console.error(result.stdout || '')
    console.error(result.stderr || '')
    fail(`安装 ${entry.spec} 失败`)
  }
}

// 插件自己会把 bundle 加进 bundles；这里补齐宿主必需的两个并做兜底
const bundles = new Set((JSON.parse(readFileSync(pkgFile, 'utf8')).dsh?.profile?.bundles ?? []))
bundles.add('@deepseek-ai/dsh-base')
bundles.add('@deepseek-ai/dsh-web-app')
for (const name of mode === 'onebot' ? ['dsh-onebot-qq', '@local/dsh-cloudbot-skin'] : ['@local/dsh-qq-bridge']) {
  bundles.add(name)
}
const current = JSON.parse(readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''))
current.dsh = current.dsh ?? { profile: { bundles: [] } }
current.dsh.profile = current.dsh.profile ?? { bundles: [] }
current.dsh.profile.bundles = [...bundles]
writeFileSync(pkgFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8')

// ---- 配置行 -------------------------------------------------------------
if (mode === 'onebot') {
  let patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '[]\n'
  if (!patch.includes('id: dsh-onebot')) {
    const allow = allowList ? allowList.split(/[,\s]+/).filter(Boolean) : (adminQQ ? [adminQQ] : [])
    const admins = adminQQ ? [adminQQ] : []
    const block = `
# === cloudbot：dsh-onebot-qq 通道 + 皮肤层 ===
- id: dsh-onebot
  config:
    mode: forward
    url: 'ws://127.0.0.1:3001'
    accessToken: ''
    botQQ: '${botQQ}'
    requireMention: false
    dmPolicy: allowlist
    groupPolicy: allowlist
    allowFrom: [${allow.map((id) => `'${id}'`).join(', ')}]
    adminUsers: [${admins.map((id) => `'${id}'`).join(', ')}]
    allowAllUsers: false
    sttEnabled: false
    interimMessages: false

- id: cloudbot-skin
  config:
    personaFile: '${personaFile.replace(/\\/g, '/')}'
    memoryDir: '${join(HERE, 'memory').replace(/\\/g, '/')}'
    stickerDir: '${join(HERE, 'stickers').replace(/\\/g, '/')}'
    onebotUrl: 'ws://127.0.0.1:3001'
    affinityEnabled: true
    memoryContextMessages: 10
    memoryInject: true
    memoryMaxChars: 1200
`
    patch = `${patch.replace(/\s+$/, '')}\n${block}`
    writeFileSync(patchFile, patch, 'utf8')
    log('已写入 dsh-onebot / cloudbot-skin 配置行')
  } else {
    log('配置行已存在，保留不动')
  }
}

log('\n安装完成。下一步：')
log(`  1. 让协议端（NapCat 等）的 OneBot WebSocket 监听 127.0.0.1:3001`)
log(`  2. 启动：dsh ${profile}`)
log(`  3. 人设：${personaFile}`)
log(`  4. 表情图库：${join(HERE, 'stickers')}（子目录名 = 标签）`)
log(`  5. 长期记忆：${join(HERE, 'memory')}`)
