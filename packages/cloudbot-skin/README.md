# cloudbot-skin

给 [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq) 的 QQ 会话补上「活人感」的伴生插件。
零 npm 依赖，只用 `node:fs` / `node:os` / `node:path` 和宿主提供的 Cordis 服务。

## 它做什么

只对 `onebot-*` 会话（即 QQ 会话）生效，其他会话完全不受影响：

| 能力 | 实现 |
|---|---|
| **人设** | `systemPrompt.section`，`text` 用函数形式，每次组装提示词时读文件 → 改完即生效 |
| **长期记忆** | 监听 `session/event` 的 `user/message` / `assistant/message`，写 `messages.jsonl`、`facts.jsonl` |
| **记忆注入** | `systemPrompt.context`（函数形式），每轮注入「记下的事 + 最近 N 条」 |
| **好感度** | 按 QQ 号存 0–100，隐式注入一句影响语气，**不提供查询入口** |
| **表情包** | `qq_sticker` 工具，从本地图库按标签挑图，自己开临时 WS 直连协议端发送 |
| **分段提示** | 提示模型「想连发几条用 `qq_send_segments`」 |
| **自动补表情** | `stickerAutoChance` > 0 时，回合结束按概率发一张 |

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `personaFile` | `<插件目录>/persona.md` | 人设 Markdown 路径 |
| `memoryDir` | `$DSH_HOME/cloudbot-skin` | 记忆与好感度存放目录 |
| `affinityEnabled` | `true` | 是否启用好感度 |
| `memoryContextMessages` | `10` | 每轮注入最近几条消息（0 关闭） |
| `memoryInject` | `true` | 是否注入记忆 |
| `memoryMaxChars` | `1200` | 注入块字数上限 |
| `stickerDir` | `<插件目录>/stickers` | 表情图库根目录（子目录名 = 标签） |
| `onebotUrl` | `ws://127.0.0.1:3001` | 发图用的协议端地址 |
| `onebotToken` | `''` | 协议端 access token（如果有） |
| `stickerAutoChance` | `0` | 回复后补表情的概率（0–1） |

## 数据格式

`memoryDir/messages.jsonl`，每行一条：

```json
{"ts":"2026-11-22T07:31:32.229Z","key":"private:100000001","role":"user","name":"tester","text":"在吗"}
```

`memoryDir/facts.jsonl`（模型主动记下的事）、`memoryDir/affinity.json`（好感度）。

## 一个关键实现细节

注册提示词和工具**必须用 `agent.ctx`**（会话自己的作用域）：

```js
ctx.on('agent/created', ({ agent }) => {
  const chatKey = chatKeyOfSession(agent?.session?.id)
  if (!chatKey) return
  const systemPrompt = agent?.ctx?.systemPrompt   // ← 不能是 ctx.get('systemPrompt')
  ...
})
```

用插件的全局 `ctx` 会把人设和工具泄漏到**所有会话**（包括 GUI 里的普通代码对话），
这是一个已经踩过的真实 bug，改回来后验证过。

## 依赖的服务

`systemPrompt`、`tools`、`sessions`（通过 `inject` 声明）。缺少任意一个会拒绝启动，避免半残状态。

## License

MIT（见仓库根目录 `LICENSE`）。
