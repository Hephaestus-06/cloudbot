#!/usr/bin/env node
/**
 * 打出可分发的发布包：dist/cloudbot-<version>/ 以及同名 zip。
 *
 *   node scripts/package.mjs                 # 公开版：不含任何第三方协议端
 *   node scripts/package.mjs --with-protocol # 个人自用版：携带 SnowLuma 并自动解压
 *
 * --with-protocol 产物**不可对外分发**：SnowLuma EULA 5.4 禁止并入第三方安装包。
 * 个人版输出在 dist/personal/，与公开版完全隔离。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = join(ROOT, 'dist')

const version = JSON.parse(readFileSync(join(ROOT, 'bridge', 'package.json'), 'utf8')).version
const withProtocol = process.argv.includes('--with-protocol')
const personal = withProtocol
const baseName = personal ? `cloudbot-${version}-personal` : `cloudbot-${version}`
const outDir = personal ? join(DIST, 'personal', baseName) : join(DIST, baseName)
const zipPath = personal ? join(DIST, 'personal', `${baseName}.zip`) : join(DIST, `${baseName}.zip`)

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

// 1f) 协议端：**不打包二进制**
// SnowLuma EULA 5.4 明确禁止「并入第三方安装包」和「通过自动化脚本部署」；
// NapCat / Lagrange 仓库没有 LICENSE 文件（默认保留所有权利）。所以包里只放说明。
const protocolReadme = `# 协议端（需你自行下载）

本安装包**不附带** OneBot 协议端二进制——SnowLuma / NapCat / Lagrange 的许可都不允许
被并进第三方安装包（SnowLuma EULA 第 5.4 条还明确禁止"通过自动化脚本部署"）。

## 推荐：SnowLuma

1. 打开 https://github.com/TomyJan/SnowLuma/releases
2. 下载 \`SnowLuma-v*-win-x64.zip\`（约 41 MB）
3. 解压到本目录，使路径变成：

   \`\`\`
   protocol/snowluma/app/index.mjs
   protocol/snowluma/app/node.exe
   \`\`\`

4. 重新运行 \`setup.bat\`（或 \`node install.mjs --mode onebot\`）——它会写入
   OneBot 配置（127.0.0.1:3001）并开启自动接入 QQ，**不会改动协议端程序文件**。

## 换别的协议端

NapCat / Lagrange 也可以：让它的 OneBot 11 WebSocket 服务端监听
\`127.0.0.1:3001\` 即可，本安装包的 DSH 侧配置不需要改。

## 许可提醒

- SnowLuma：个人非商业自用可以，**分发/打包/脚本化部署需书面授权**（motricseven@foxmail.com）。
- NapCat / Lagrange：仓库无 LICENSE，默认保留所有权利，同样不宜分发。
- 你自己用没问题；要给别人装，让对方自己从官方仓库下载。
`
mkdirSync(join(outDir, 'protocol'), { recursive: true })
writeFileSync(join(outDir, 'protocol', 'README.md'), protocolReadme, 'utf8')

// 个人自用版：携带本地已下载的协议端并允许自动解压
if (personal) {
  const source = join(ROOT, '.private', 'snowluma')
  const zipName = existsSync(source) ? readdirSync(source).find((entry) => /SnowLuma.*win-x64.*\.zip$/i.test(entry)) : ''
  if (zipName) {
    copyFileSync(join(source, zipName), join(outDir, 'protocol', zipName))
    console.log(`  + bundled protocol (personal build): ${zipName}`)
  } else {
    console.log('  ! 没有找到 SnowLuma zip（.private/snowluma），个人版不含协议端')
  }
  const setupBat = join(outDir, 'setup.bat')
  if (existsSync(setupBat)) {
    const text = readFileSync(setupBat, 'utf8').replace('node install.mjs --mode onebot', 'node install.mjs --mode onebot --auto-extract-protocol')
    writeFileSync(setupBat, text, 'utf8')
  }
  writeFileSync(join(outDir, 'PERSONAL-BUILD.txt'), [
    'PRIVATE CONVENIENCE BUILD — DO NOT REDISTRIBUTE',
    '',
    'This build bundles SnowLuma. Its EULA (v1.1, clause 5.4) forbids incorporating',
    'the proprietary components into a third-party installer and deploying them via',
    'automated scripts without prior written authorization from SnowLumaDevs',
    '(motricseven@foxmail.com).',
    '',
    'Keep it for your own non-commercial use. When sharing with someone else, use the',
    'public build (no protocol client bundled) and let them download the protocol',
    'client from its official release page.',
  ].join('\n') + '\n', 'utf8')
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
