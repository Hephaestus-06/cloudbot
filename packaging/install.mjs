#!/usr/bin/env node
/**
 * cloudbot 安装器：把桥接插件装进一个 DSH profile。
 *
 *   node install.mjs --profile cloudbot
 *   node install.mjs --profile cloudbot --dsh-home "C:/Users/me/.dsh"
 *   node install.mjs --dry-run          # 只检查环境并打印将执行的命令
 *
 * 幂等：重复执行不会破坏已有配置；profile 已存在就复用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, 'bridge')

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const dryRun = argv.includes('--dry-run')
const profile = arg('profile', 'cloudbot')
const dshHome = resolve(arg('dsh-home', process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')))

function log(msg) { console.log(msg) }
function fail(msg) {
  console.error(`\n[错误] ${msg}\n`)
  process.exit(1)
}

// 1) 环境检查
const nodeMajor = Number(process.versions.node.split('.')[0])
log(`Node ${process.versions.node}`)
if (nodeMajor < 20) fail('需要 Node 20 或更高版本（https://nodejs.org/）')

/** 直接定位 dsh 的 JS 入口，用当前 node 执行——绕开 Windows 上 .cmd + 空格的引号地狱。 */
function dshEntry() {
  const candidates = []
  const appData = process.env.APPDATA
  if (appData) candidates.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  candidates.push(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  candidates.push(join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

const DSH_BIN = dshEntry()
function runDsh(args, options = {}) {
  if (DSH_BIN) return spawnSync(process.execPath, [DSH_BIN, ...args], { encoding: 'utf8', ...options })
  // 兜底：交给 shell（路径里有空格时可能失败）
  const line = ['dsh', ...args].map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ')
  return process.platform === 'win32'
    ? spawnSync('cmd', ['/d', '/s', '/c', line], { encoding: 'utf8', ...options })
    : spawnSync('sh', ['-c', line], { encoding: 'utf8', ...options })
}

if (!existsSync(join(BRIDGE, 'index.js'))) fail(`找不到插件目录：${BRIDGE}`)
log(`插件目录：${BRIDGE}`)

const dsh = runDsh(['--version'])
const hasDsh = dsh.status === 0
if (hasDsh) {
  log(`DSH CLI：${String(dsh.stdout).trim()}`)
} else {
  log('DSH CLI：未检测到')
}

// 2) profile 骨架
const profileDir = join(dshHome, 'profiles', profile)
const pkgFile = join(profileDir, 'package.json')
log(`profile：${profileDir}`)

const basePackage = {
  name: `dsh-profile-${profile}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}

if (dryRun) {
  log('\n[dry-run] 将要做的：')
  log(`  1. 创建目录 ${profileDir}`)
  log(`  2. 写入 package.json（bundles 加 @local/dsh-qq-bridge）`)
  log(`  3. 执行 dsh plugin --profile ${profile} add "link:${BRIDGE}"`)
  log('  4. 生成 persona.md（从示例复制）')
  process.exit(0)
}

if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true })

let pkg = basePackage
if (existsSync(pkgFile)) {
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    fail(`已有 profile 的 package.json 解析失败：${pkgFile}`)
  }
} else {
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  log('已创建 profile 骨架')
}

pkg.dependencies = pkg.dependencies ?? {}
pkg.dependencies['@local/dsh-qq-bridge'] = `link:${BRIDGE.replace(/\\/g, '/')}`
pkg.dsh = pkg.dsh ?? { profile: { bundles: [] } }
pkg.dsh.profile = pkg.dsh.profile ?? { bundles: [] }
const bundles = new Set(pkg.dsh.profile.bundles ?? [])
bundles.add('@deepseek-ai/dsh-base')
bundles.add('@deepseek-ai/dsh-web-app')
bundles.add('@local/dsh-qq-bridge')
pkg.dsh.profile.bundles = [...bundles]
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
log('已写入 package.json（含 bundles）')

// 3) 人设（不覆盖已有）
const personaTarget = join(BRIDGE, 'persona.md')
if (!existsSync(personaTarget)) {
  const example = join(BRIDGE, 'persona.example.md')
  if (existsSync(example)) {
    writeFileSync(personaTarget, readFileSync(example, 'utf8'), 'utf8')
    log('已从示例生成 persona.md（可以直接改这个文件）')
  }
} else {
  log('persona.md 已存在，保留不动')
}

// 4) 安装依赖（需要 dsh CLI）
if (!hasDsh) {
  log('\n未检测到 dsh CLI，跳过依赖安装。请先安装：')
  log('  npm i -g @deepseek-ai/dsh')
  log(`然后执行：dsh plugin --profile ${profile} add "link:${BRIDGE}"`)
  process.exit(2)
}

log('\n安装依赖…')
const linkTarget = BRIDGE.replace(/\\/g, '/')
const add = runDsh(['plugin', '--profile', profile, 'add', `link:${linkTarget}`], {
  cwd: profileDir,
  env: { ...process.env, DSH_HOME: dshHome },
})
if (add.status !== 0) {
  console.error(add.stdout || '')
  console.error(add.stderr || '')
  fail('依赖安装失败（看上面的 pnpm 输出）')
}
log(String(add.stdout || '').trim().split('\n').slice(-3).join('\n'))

// 5) 完成
log('\n安装完成。下一步：')
log(`  启动机器人：dsh ${profile}`)
log(`  配置台：    node console/src/server.mjs`)
log(`  人设文件：  ${join(BRIDGE, 'persona.md')}`)
log(`  表情包图库： ${join(BRIDGE, 'stickers')}（子目录名 = 标签）`)
log('\n别忘了先让 NapCat 登录 QQ，并确认 OneBot 的 WebSocket 在 127.0.0.1:3001。')
