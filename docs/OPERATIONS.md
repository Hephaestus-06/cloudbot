# 运维手册

> 适用于当前的混合架构：`dsh-onebot-qq`（通道）+ `cloudbot-skin`（人设/记忆/好感度/表情）+ NapCat 或 Lagrange（协议端）。

## 各部件在哪

| 东西 | 位置 |
|---|---|
| 通道插件 | profile 依赖 `dsh-onebot-qq`，配置行 `- id: dsh-onebot` |
| 皮肤插件 | `packages/cloudbot-skin/`（link 装进 profile），配置行 `- id: cloudbot-skin` |
| 人设 | `D:\deepseek harness desktop\qq-bridge\persona.md` |
| 表情图库 | `...\qq-bridge\stickers\<标签>\*.png` |
| 长期记忆 | `...\qq-bridge\state\memory\messages.jsonl`、`facts.jsonl`、`affinity.json` |
| 诊断 trace | `C:\Users\RUAN\.dsh\media\onebot\qq-trace.jsonl`（`traceEnabled: true` 时） |
| 会话映射 | `C:\Users\RUAN\.dsh\media\onebot\chat-sessions.json` |
| QQ 会话 | `~/.dsh/sessions/<workspace>/onebot-<chatId>/` |
| 旧方案（回滚用） | `bridge/`（`@local/dsh-qq-bridge`），配置行 `- id: qq-bridge` |

## 日常检查

```powershell
# 协议端是否在听
Get-NetTCPConnection -LocalPort 3001 -State Listen

# 插件是否连上（应为 1 条）
Get-NetTCPConnection -RemotePort 3001 | Measure-Object

# 最近收到的消息 / 回复（trace）
Get-Content "C:\Users\RUAN\.dsh\media\onebot\qq-trace.jsonl" -Tail 5

# 会话映射（有没有新会话）
Get-Content "C:\Users\RUAN\.dsh\media\onebot\chat-sessions.json"

# 记忆是否在写
Get-Content "D:\deepseek harness desktop\qq-bridge\state\memory\messages.jsonl" -Tail 4
```

## 排查「收到但不回」

看 trace 的 `stage` 序列，缺哪一段就是卡在哪：

| trace 最后停在 | 含义 | 下一步 |
|---|---|---|
| 只有 `inbound` | 被门控拦了（白名单/@/限流） | 看 `reason` 字段，检查 `allowFrom` / `dmPolicy` |
| `dispatch` 后没有 `agent` | 模型回合没结束 | 查模型通道、API key、余额 |
| `agent` 有但没 `outbound` | 出站失败 | 查协议端是否限制发送（`Ban state forbit write req`） |
| 完全没有新行 | 协议端没投递 | 查协议端登录状态、WS 连接 |

## 回滚到旧方案

```powershell
# 1. 恢复 profile 备份（package.json + cordis.patch.yml）
copy "D:\AAA_about work\project\bot\.private\backup\profile-<时间戳>\package.json" "C:\Users\RUAN\.dsh\profiles\desktop\package.json"
copy "D:\AAA_about work\project\bot\.private\backup\profile-<时间戳>\cordis.patch.yml" "C:\Users\RUAN\.dsh\profiles\desktop\cordis.patch.yml"
# 2. 重启 DSH 桌面端
```

旧插件的代码和数据都还在，不需要迁移。

## 切换协议端（NapCat ⇄ Lagrange）

脚本在 `bot\.private\lagrange\`，**管理员运行**：

```bat
switch-to-lagrange.bat     :: 停 NapCat → 启动 Lagrange（控制台打印二维码，用手机扫）
switch-back-to-napcat.bat  :: 停 Lagrange → 重新拉起 NapCat 计划任务
```

注意：

- 两个协议端都监听 `127.0.0.1:3001`，DSH 侧配置不用改；
- 同一账号不能同时登录两个客户端，切换必须先停一个；
- Lagrange 必须跑在**有控制台**的窗口里（无控制台会因 `Console.get_BufferWidth` 崩溃）。

## 调试用事件注入（⚠️ 生产保持关闭）

插件支持把一行 JSON 喂进真实入站管线，用来在没有真人发消息时验证链路：

```yaml
- id: dsh-onebot
  config:
    injectEnabled: true
    injectDryRun: true    # true = 出站被拦截，不真发
```

然后往 `C:\Users\RUAN\.dsh\media\onebot\qq-inject.jsonl` 追加一行完整消息事件，例如：

```json
{"post_type":"message","message_type":"private","sub_type":"friend","time":1795333000,"self_id":300000001,"message_id":99001,"user_id":100000001,"message":[{"type":"text","data":{"text":"在吗"}}],"raw_message":"在吗","sender":{"user_id":100000001,"nickname":"tester"}}
```

验证完**务必**把 `injectEnabled` 改回 `false` 并删除该文件。

## 已知坑

1. **作用域**：皮肤层的 `systemPrompt`/`tools` 必须用 `agent.ctx`，用全局 ctx 会污染所有会话。
2. **BOM**：PowerShell 写 JSON 带 BOM 会让插件解析失败；用 `[System.Text.UTF8Encoding]::new($false)` 或写入工具。
3. **点歌**：NapCat 不支持 OneBot 的 `music` 段，已关闭。
4. **发送受限**：账号被风控时会返回 `retcode 1200 / Ban state forbit write req`，此时能收不能发。
