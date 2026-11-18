/**
 * 集成测试：验证 bot-console 的人设写入边界。
 *
 * 前置：先启动一个指向沙箱目录的服务
 *   node src/server.mjs            （config.json 指向沙箱）
 * 运行：
 *   node tests/persona-guard.test.mjs
 *
 * 可用环境变量覆盖：
 *   TEST_PATCH     沙箱里的 cordis.patch.yml
 *   TEST_INSIDE    插件目录内的人设文件（允许写）
 *   TEST_OUTSIDE   插件目录外的人设文件（应拒绝）
 *   TEST_BASE      服务地址，默认 http://127.0.0.1:8899
 *   TEST_TOKEN     访问令牌
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const PATCH = process.env.TEST_PATCH || 'D:/AAA_about work/project/bot/.sandbox/profile/cordis.patch.yml'
const INSIDE = process.env.TEST_INSIDE || 'D:/AAA_about work/project/bot/.sandbox/plugin/persona.md'
const OUTSIDE = process.env.TEST_OUTSIDE || 'D:/AAA_about work/project/bot/.sandbox-outside/persona.md'
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8899'
const TOKEN = process.env.TEST_TOKEN || 'testtoken123'

function setPersonaFile(path) {
  const text = readFileSync(PATCH, 'utf8')
  const match = /^- id: qq-bridge[\s\S]*?^\s+config:\s*(\{[\s\S]*?\})\s*$/m.exec(text)
  if (!match) throw new Error('沙箱配置里找不到 qq-bridge 行')
  const config = JSON.parse(match[1])
  config.personaFile = path
  const replaced = `- id: qq-bridge\n  name: "@local/dsh-qq-bridge"\n  config: ${JSON.stringify(config)}`
  writeFileSync(PATCH, text.replace(match[0], replaced), 'utf8')
}

async function api(path, options = {}) {
  const response = await fetch(BASE + path, {
    ...options,
    headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

const results = []

// 目录外：只读 + 拒绝写入，而且不能创建文件
setPersonaFile(OUTSIDE)
let state = await api('/api/state')
results.push(['A1 目录外标为只读', state.body.persona?.editable === false, `editable=${state.body.persona?.editable}`])
let write = await api('/api/persona', { method: 'POST', body: JSON.stringify({ text: '不该被写入' }) })
results.push(['A2 目录外拒绝写入(409)', write.status === 409, `status=${write.status}`])
results.push(['A3 未创建外部文件', !existsSync(OUTSIDE), `exists=${existsSync(OUTSIDE)}`])

// 目录内：可写
setPersonaFile(INSIDE)
state = await api('/api/state')
results.push(['B1 目录内标为可写', state.body.persona?.editable === true, `editable=${state.body.persona?.editable}`])
write = await api('/api/persona', { method: 'POST', body: JSON.stringify({ text: '# 沙箱人设\n\n只用于测试。' }) })
results.push(['B2 写入成功(200)', write.status === 200, `status=${write.status} bytes=${write.body.bytes}`])
const written = readFileSync(INSIDE, 'utf8')
results.push(['B3 内容正确', written.includes('沙箱人设'), JSON.stringify(written.slice(0, 24))])

let failed = 0
for (const [name, ok, detail] of results) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`)
}
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
