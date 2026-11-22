# 从自研桥接迁移到 dsh-onebot-qq（混合方案）

> 状态：**隔离 profile 已验证通过**（2026-11-22），线上尚未切换。旧方案（`bridge/` + NapCat）保持可用，可随时回滚。

## 为什么要迁

自研桥接（`bridge/`，2600 行）把重点放在「像人聊天」：人设、气泡、记忆、好感度、表情包。
但它在 QQ 通道能力上远不如现成插件：

| 能力 | 自研 `bridge/` | `dsh-onebot-qq@0.11.0` |
|---|---|---|
| 语音收发（STT/TTS） | ❌ | ✅ ffmpeg + whisper，非阻塞占位转写 |
| t2i 文字卡片 | ❌ | ✅ canvas 渲染（表格/代码块/中文禁则） |
| 图片/视频/文件/合并转发 | 仅表情 | ✅ 全套工具 |
| 会话管理（/new /model /workspace /preset /session） | 仅 /cwd /reset | ✅ 完整命令集 |
| 诊断（/doctor export/test） | ❌ | ✅ |
| 群权限分档 | 管理员/普通 | ✅ 三档 + 工具白名单 |
| 热加载 | ❌ 需重载插件 | ✅ profile patch 改动秒级生效 |

## 混合架构

```
QQ ←→ NapCat(OneBot WS 3001) ←→ dsh-onebot-qq（通道：命令/媒体/卡片/语音）
                                      ↕ 同一个 DSH 会话
                                 cloudbot-skin（皮肤：人设/记忆/好感度/表情包）
```

- `dsh-onebot-qq`：负责和 QQ 打交道。
- `cloudbot-skin`（`packages/cloudbot-skin/`，零依赖）：只对 `onebot-*` 会话生效，负责"活人感"。

### 皮肤层做了三件事

1. **人设**：`personaFile` 指向 Markdown，注册为动态 `systemPrompt.section`（每次组装提示词时读文件，改完即生效）。
2. **记忆**：监听 `session/event`
   - 只解析 `<user_message qq=... nickname=...>` 包装内的文本（避免把 DSH 注入的运行时上下文记成聊天）
   - 写入 `messages.jsonl` / `facts.jsonl`
   - 通过动态 `systemPrompt.context` 每轮注入「记下的事 + 最近 10 条」
3. **好感度**：按 QQ 号存 0–100，隐式注入一句话影响语气，**不提供查询入口**。
4. **表情包**：`qq_sticker` 工具按标签挑图，自己开一条临时 WS 直连协议端发图（不依赖宿主插件内部实现）。

## 验证记录（隔离 profile）

| 检查 | 结果 |
|---|---|
| 插件连接 OneBot（正向 WS） | ✅ |
| `/ver`、`/id` 命令 | ✅ `dsh-onebot v0.11.0 (f4fb9aa)` |
| 人设注入 | ✅ 回复呈小鲸鱼口吻 |
| 记忆写入（含昵称） | ✅ 只记真实消息，无运行时上下文污染 |
| 记忆召回 | ✅ 第三问准确答出「小明 / 喜欢猫」 |
| 好感度 | ✅ 三条消息 50 → 53 |
| 表情包发送 | ✅ `send_private_msg image(...)` 两张不同图 |

## 切换步骤（线上）

1. **备份**：`profile/package.json`、`profile/cordis.patch.yml`、bundles 列表
2. 安装依赖：
   ```bash
   dsh plugin --profile desktop add dsh-onebot-qq@0.11.0
   dsh plugin --profile desktop add "link:<仓库>/packages/cloudbot-skin"
   ```
3. 改 `cordis.patch.yml`：
   - bundles 里移除 `@local/dsh-qq-bridge`，加入 `dsh-onebot-qq`、`@local/dsh-cloudbot-skin`
   - 加 `dsh-onebot` 行：`mode: forward`、`url: ws://127.0.0.1:3001`、`botQQ: '<机器人QQ>'`、`allowFrom`、`adminUsers`、`dmPolicy: allowlist`
   - 加 `cloudbot-skin` 行：personaFile / memoryDir / stickerDir / onebotUrl
4. 重载 profile（改 patch 会自动热加载；必要时 `set_bundle false → true`）
5. 验证：`get_status` 在线、桥接连接、发一条消息看是否回复

## 回滚

```bash
# 恢复备份的两个文件，然后把 bundles 换回 @local/dsh-qq-bridge
cp backup/package.json      ~/.dsh/profiles/desktop/package.json
cp backup/cordis.patch.yml  ~/.dsh/profiles/desktop/cordis.patch.yml
```
旧插件代码和数据（`state/memory`、`stickers`）都保留，不需要迁移数据。

## 协议端（NapCat → Lagrange）

**尚未完成**。Lagrange.OneBot 提供自包含 Windows 二进制（33 MB），但本机网络下载反复中断（23.7/33.4 MB 被重置，续传不支持）。

如果后续要换：
1. 下载 `Lagrange.OneBot_win-x64_net9.0_SelfContained.zip`
2. 解压后改 `appsettings.json`：`Implementations[0].ForwardWebSocket` 指向 3001
3. 停 NapCat → 启动 Lagrange → 扫码登录
4. `dsh-onebot` 的 `url` 不变（都是 3001），无需改配置

**注意**：Lagrange 也是第三方 NTQQ 协议实现，换客户端会重新走一次登录风控；当前账号已多次被风控，建议先用小号验证。
