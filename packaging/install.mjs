#!/usr/bin/env node
/**
 * cloudbot 部署器：把 QQ 机器人整套装进一个 DSH profile。
 *
 * 双击 setup.bat 即可（会交互询问机器人 QQ 号）；也可以命令行：
 *   node install.mjs --mode onebot --bot-qq 123456 --admin 123456
 *   node install.mjs --mode onebot --dry-run         # 只看计划
 *   node install.mjs --mode bridge                   # 旧方案（自研桥接）
 *
 * 做四件事：
 *   1. 解压并配置协议端（包内自带 SnowLuma 时）
 *   2. 建 profile、装 dsh-onebot-qq + 皮肤层
 *   3. 写配置行（机器人 QQ / 管理员 / 白名单）与人设
 *   4. 打印启动方式
 *
 * 幂等：重复执行不会覆盖已有配置与人设。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKIN = join(HERE, 'skin')
const BRIDGE = join(HERE, 'bridge')
const PROTOCOL_DIR = join(HERE, 'protocol')
const SNOWLUMA_APP = join(PROTOCOL_DIR, 'snowluma', 'app')

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const dryRun = argv.includes('--dry-run')
const skipProtocol = argv.includes('--no-protocol')
const mode = arg('mode', 'onebot')
const profile = arg('profile', 'cloudbot')
let botQQ = arg('bot-qq', '')
let adminQQ = arg('admin', '')
let allowList = arg('allow', '')
const dshHome = resolve(arg('dsh-home', process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')))

const log = (msg) => console.log(msg)
function fail(msg) {
  console.error(`\n[错误] ${msg}\n`)
  process.exit(1)
}

async function ask(question, fallback = '') {
  if (!process.stdin.isTTY) return fallback
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(question)).trim()
    return answer || fallback
  } finally {
    rl.close()
  }
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

// ---- 交互输入 -----------------------------------------------------------
if (mode === 'onebot' && !botQQ && !dryRun) {
  log('\n请输入机器人账号信息（直接回车用方括号里的默认值）：')
  botQQ = await ask('  机器人 QQ 号：')
  if (!botQQ) fail('机器人 QQ 号必须有')
  adminQQ = adminQQ || (await ask(`  管理员 QQ 号（你自己）[${botQQ}]：`, botQQ))
  allowList = allowList || (await ask(`  允许私聊的 QQ，逗号分隔 [${adminQQ}]：`, adminQQ))
}

if (mode === 'bridge') {
  if (!existsSync(join(BRIDGE, 'index.js'))) fail(`找不到旧桥接插件：${BRIDGE}`)
} else {
  if (!existsSync(join(SKIN, 'index.js'))) fail(`找不到皮肤插件：${SKIN}`)
  if (!botQQ && !dryRun) fail('缺少机器人 QQ 号（--bot-qq）')
}

// ---- 协议端 -------------------------------------------------------------
// 许可说明：SnowLuma / NapCat / Lagrange 的发行包都不允许被并进第三方安装包，
// 也不允许用自动化脚本部署（SnowLuma EULA 5.4）。所以这里**只做配置**：
// 用户自己下载并解压到 protocol/ 之后，安装器才去写它的 OneBot 配置。
const PROTOCOL_URL = 'https://github.com/TomyJan/SnowLuma/releases'
const protocolReady = existsSync(join(SNOWLUMA_APP, 'index.mjs'))

function prepareProtocol() {
  if (!protocolReady) {
    log('未检测到协议端（protocol/snowluma/app/index.mjs）——跳过它的配置。')
    log(`  请自行下载（${PROTOCOL_URL}）并解压到：`)
    log(`    ${SNOWLUMA_APP}`)
    log('  然后重新运行本安装器，或手动把 OneBot 服务端指向 127.0.0.1:3001。')
    return
  }
  log('检测到已自行安装的协议端，写入 OneBot 配置（不改动它的程序文件）')
  const cfgDir = join(SNOWLUMA_APP, 'config')
  mkdirSync(cfgDir, { recursive: true })
  const onebotCfg = join(cfgDir, 'onebot.json')
  if (!existsSync(onebotCfg)) {
    writeFileSync(onebotCfg, `${JSON.stringify({
      networks: {
        httpServers: [],
        httpClients: [],
        wsServers: [{
          name: 'ws-default',
          host: '127.0.0.1',
          port: 3001,
          path: '/',
          role: 'Universal',
          accessToken: '',
          messageFormat: 'array',
          reportSelfMessage: false,
        }],
        wsClients: [],
      },
    }, null, 2)}\n`, 'utf8')
    log('已写协议端 OneBot 配置（127.0.0.1:3001）')
  }
  const runtimeCfg = join(cfgDir, 'runtime.json')
  if (!existsSync(runtimeCfg)) {
    writeFileSync(runtimeCfg, `${JSON.stringify({ webuiPort: 5099, webuiHost: '127.0.0.1', hookAutoLoad: true }, null, 2)}\n`, 'utf8')
    log('已开启协议端自动接入 QQ')
  }
}

// ---- profile ------------------------------------------------------------
const profileDir = join(dshHome, 'profiles', profile)
const pkgFile = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')
const personaFile = join(HERE, 'persona.md')
log(`profile：${profileDir}`)

if (dryRun) {
  log('\n[dry-run] 将要做：')
  log(`  - 协议端配置：${protocolReady ? '已安装，写配置' : '未安装，打印下载指引'}`)
  log(`  - 建 profile 并安装 ${mode === 'onebot' ? 'dsh-onebot-qq + 皮肤层' : '旧桥接'}`)
  log(`  - 写入配置（机器人 QQ ${botQQ || '<未填>'}）`)
  if (!existsSync(personaFile)) log('  - 从示例生成 persona.md')
  process.exit(0)
}

if (!skipProtocol) prepareProtocol()

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

if (!existsSync(personaFile)) {
  const example = join(BRIDGE, 'persona.example.md') 
  if (existsSync(example)) {
    writeFileSync(personaFile, readFileSync(example, 'utf8'), 'utf8')
    log('已从示例生成 persona.md')
  }
}

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
    const allow = allowList ? allowList.split(/[,\s，]+/).filter(Boolean) : (adminQQ ? [adminQQ] : [])
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

// ---- 完成 ---------------------------------------------------------------
log('\n部署完成。下一步：')
log(`  1. 确保电脑上装了 QQ 并已登录 ${botQQ}`)
log(`  2. 双击 start.bat 启动（会拉起协议端和 DSH）`)
log(`  3. 协议端 WebUI：http://127.0.0.1:5099（初始密码在它的启动窗口里）`)
log(`  4. 人设：${personaFile}`)
log(`  5. 表情图库：${join(HERE, 'stickers')}（子目录名 = 标签）`)
log(`  6. 长期记忆：${join(HERE, 'memory')}`)
if (!protocolReady && mode === 'onebot') {
  log('\n注意：包内没有协议端，你需要自备一个 OneBot 11 实现监听 127.0.0.1:3001。')
}
