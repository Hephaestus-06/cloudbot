/**
 * 把线上插件同步进仓库：复制代码 + 自动脱敏 + 更新版本号。
 *
 * 脱敏不硬编码号码：从线上配置里读出白名单/管理员/群号，按出现顺序替换成占位符。
 * 用法: node scripts/sync-bridge.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LIVE = process.env.CLOUDBOT_LIVE_BRIDGE || 'D:/deepseek harness desktop/qq-bridge'
const DEST = join(ROOT, 'bridge')
const VERSION = '0.2.0'

if (!existsSync(join(LIVE, 'index.js'))) {
  console.error(`找不到线上插件：${LIVE}\n用 CLOUDBOT_LIVE_BRIDGE 指定路径。`)
  process.exit(1)
}

/** 从线上配置里找出所有真实号码，生成 "真号 → 占位" 映射。 */
function buildRedaction(livePatchFile) {
  const text = existsSync(livePatchFile) ? readFileSync(livePatchFile, 'utf8') : ''
  const users = new Set()
  const groups = new Set()
  for (const key of ['allowedUsers', 'admins', 'notifyUsers']) {
    const m = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(text)
    if (m) for (const id of m[1].match(/\d{5,12}/g) ?? []) users.add(id)
  }
  for (const key of ['allowedGroups', 'ambientGroups']) {
    const m = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(text)
    if (m) for (const id of m[1].match(/\d{5,12}/g) ?? []) groups.add(id)
  }
  const map = {}
  let userIndex = 0
  for (const id of users) {
    userIndex += 1
    map[id] = String(100000000 + userIndex)
  }
  let groupIndex = 0
  for (const id of groups) {
    if (map[id]) continue
    groupIndex += 1
    map[id] = String(200000000 + groupIndex)
  }
  return map
}

const REDACT = buildRedaction(join(LIVE, 'cordis.patch.yml'))

function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  if (/\.(js|mjs|json|ya?ml|md)$/i.test(from)) {
    let body = readFileSync(from, 'utf8')
    for (const [real, fake] of Object.entries(REDACT)) body = body.split(real).join(fake)
    // 开发机的人设绝对路径 → 留空，安装时按示例生成
    body = body.replace(/personaFile:\s*'[^']*'/, "personaFile: ''")
    writeFileSync(to, body, 'utf8')
    return
  }
  copyFileSync(from, to)
}

// 1) 主文件
for (const name of ['index.js', 'cordis.patch.yml', 'persona.example.md', 'PERSONA-README.md', 'icon.svg', 'README.md']) {
  const from = join(LIVE, name)
  if (existsSync(from)) copyFile(from, join(DEST, name))
}

// 2) 图库（含说明）
const stickers = join(LIVE, 'stickers')
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else copyFile(full, join(DEST, 'stickers', relative(stickers, full)))
  }
}
if (existsSync(stickers)) walk(stickers)

// 3) package.json：版本 + 许可 + 仓库元信息
const pkg = JSON.parse(readFileSync(join(LIVE, 'package.json'), 'utf8'))
pkg.version = VERSION
pkg.license = 'MIT'
pkg.repository = { type: 'git', url: 'git+https://github.com/Hephaestus-06/cloudbot.git', directory: 'bridge' }
pkg.engines = { node: '>=20' }
pkg.keywords = ['dsh', 'qq', 'onebot', 'napcat', 'bridge', 'memory', 'sticker']
pkg.files = ['index.js', 'cordis.patch.yml', 'persona.example.md', 'PERSONA-README.md', 'icon.svg', 'stickers']
writeFileSync(join(DEST, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

console.log(`synced ${VERSION} into bridge/ (redacted ${Object.keys(REDACT).length} ids)`)
