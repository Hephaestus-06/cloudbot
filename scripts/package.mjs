#!/usr/bin/env node
/**
 * 打出可分发的发布包：dist/cloudbot-<version>/ 以及同名 zip。
 *
 *   node scripts/package.mjs
 *
 * 内容：bridge（插件+图库）、console（配置台）、install.mjs、README、LICENSE。
 * 同时生成 manifest.json（版本、构建时间、每个文件的 sha256）。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = join(ROOT, 'dist')

const version = JSON.parse(readFileSync(join(ROOT, 'bridge', 'package.json'), 'utf8')).version
const outDir = join(DIST, `cloudbot-${version}`)
const zipPath = join(DIST, `cloudbot-${version}.zip`)

rmSync(outDir, { recursive: true, force: true })
rmSync(zipPath, { force: true })
mkdirSync(outDir, { recursive: true })

function copyTree(from, to, filter = () => true) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (!filter(src, entry)) continue
    if (entry.isDirectory()) {
      mkdirSync(dst, { recursive: true })
      copyTree(src, dst, filter)
    } else {
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(src, dst)
    }
  }
}

const skip = (p) => !/node_modules|[\\/]dist([\\/]|$)|\.git([\\/]|$)/.test(p)

// 1) 旧方案插件（含图库，保留作回滚；不含开发用 persona.md）
copyTree(join(ROOT, 'bridge'), join(outDir, 'bridge'), (src) => skip(src) && !src.endsWith('persona.md'))

// 1b) 新方案皮肤层（人设/记忆/好感度/表情包）
if (existsSync(join(ROOT, 'packages', 'cloudbot-skin'))) {
  copyTree(join(ROOT, 'packages', 'cloudbot-skin'), join(outDir, 'skin'))
}
// 1c) 顶层表情图库（安装器默认指向 <安装目录>/stickers）
if (existsSync(join(ROOT, 'bridge', 'stickers'))) {
  copyTree(join(ROOT, 'bridge', 'stickers'), join(outDir, 'stickers'))
}
// 1d) 人设模板
if (existsSync(join(ROOT, 'bridge', 'persona.example.md'))) {
  copyFileSync(join(ROOT, 'bridge', 'persona.example.md'), join(outDir, 'persona.example.md'))
}

// 1e) 部署脚本（setup / start / stop / selftest）
mkdirSync(join(outDir, 'scripts'), { recursive: true })
for (const bat of ['setup.bat', 'start.bat', 'stop.bat', 'selftest.bat']) {
  const from = join(ROOT, 'packaging', bat)
  if (existsSync(from)) copyFileSync(from, join(outDir, bat))
}
if (existsSync(join(ROOT, 'scripts', 'selftest-onebot.mjs'))) {
  copyFileSync(join(ROOT, 'scripts', 'selftest-onebot.mjs'), join(outDir, 'scripts', 'selftest-onebot.mjs'))
}

// 1f) 协议端（可选：把本地下载好的 SnowLuma 打进包，实现"一个包完成部署"）
function findProtocolZip() {
  const fromEnv = process.env.CLOUDBOT_PROTOCOL_ZIP
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const dir = join(ROOT, '.private', 'snowluma')
  if (!existsSync(dir)) return ''
  const name = readdirSync(dir).find((entry) => /SnowLuma.*win-x64.*\.zip$/i.test(entry))
  return name ? join(dir, name) : ''
}
const protocolZip = findProtocolZip()
if (protocolZip) {
  mkdirSync(join(outDir, 'protocol'), { recursive: true })
  copyFileSync(protocolZip, join(outDir, 'protocol', basename(protocolZip)))
  console.log(`  + protocol client: ${basename(protocolZip)}`)
}

// 2) 配置台
mkdirSync(join(outDir, 'console', 'src'), { recursive: true })
mkdirSync(join(outDir, 'console', 'web'), { recursive: true })
for (const file of ['src/server.mjs', 'web/index.html', 'package.json', 'config.example.json']) {
  const from = join(ROOT, file)
  if (existsSync(from)) copyFileSync(from, join(outDir, 'console', file.replace(/^src\//, 'src/').replace(/^web\//, 'web/')))
}
// 配置台模板里指向开发机的路径改成占位
const consoleCfg = join(outDir, 'console', 'config.example.json')
if (existsSync(consoleCfg)) {
  const cfg = JSON.parse(readFileSync(consoleCfg, 'utf8'))
  cfg.profileDir = '~/.dsh/profiles/cloudbot'
  cfg.pluginDir = '<安装目录>/bridge'
  writeFileSync(consoleCfg, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
}

// 3) 安装器与文档
copyFileSync(join(ROOT, 'packaging', 'install.mjs'), join(outDir, 'install.mjs'))
for (const file of ['README.md', 'LICENSE']) {
  if (existsSync(join(ROOT, file))) copyFileSync(join(ROOT, file), join(outDir, file))
}
if (existsSync(join(ROOT, 'docs'))) {
  mkdirSync(join(outDir, 'docs'), { recursive: true })
  copyTree(join(ROOT, 'docs'), join(outDir, 'docs'))
}

// 4) manifest
function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, acc)
    else acc.push(full)
  }
  return acc
}
const files = walk(outDir).map((full) => {
  const data = readFileSync(full)
  return {
    path: relative(outDir, full).replace(/\\/g, '/'),
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  }
})
const manifest = {
  name: 'cloudbot',
  version,
  builtAt: new Date().toISOString(),
  node: '>=20',
  entry: { install: 'install.mjs', console: 'console/src/server.mjs', bridge: 'bridge/index.js' },
  files,
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

// 5) zip
const zip = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zipPath}' -Force`], { encoding: 'utf8' })
if (zip.status !== 0) {
  console.error(zip.stderr || zip.stdout || '')
  process.exit(1)
}
const zipSize = statSync(zipPath).size
const zipHash = createHash('sha256').update(readFileSync(zipPath)).digest('hex')

console.log(`packed cloudbot ${version}`)
console.log(`  dir : ${outDir}  (${files.length} files)`)
console.log(`  zip : ${zipPath}  (${(zipSize / 1024).toFixed(1)} KB)`)
console.log(`  sha256: ${zipHash}`)
