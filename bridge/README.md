# qq-bridge

把 QQ 聊天（OneBot 11 / NapCat）接进 DeepSeek Harness 的 Host 插件。

- 版本：`0.1.0`
- 运行时：Node ≥ 20，**零 npm 依赖**（只用 `node:fs` / `node:os` / `node:path`）
- 许可：MIT（见仓库根目录 `LICENSE`）

## 它做什么

QQ 来消息 → 白名单/权限校验 → 交给 DSH 会话（带上人设与系统提示）→ 把回复按气泡拆条发回 QQ。
同时负责：打字状态、主动说话、群聊插话、好友申请审批、管理指令、掉线重连、会话与工作区映射。

## 安装（DSH CLI）

```bash
# 1. 把本目录作为依赖装进目标 profile（用 link 指向本地检出）
dsh plugin --profile <profile> add "link:/path/to/bridge"

# 2. 确认 package.json 的 dsh.profile.bundles 里出现 "@local/dsh-qq-bridge"
#    3. 启动
dsh <profile>
```

桌面版（Windows）走 DSH 的插件管理器安装，效果相同。

## 配置

所有键都在 `cordis.patch.yml` 里，按 profile 覆盖。关键项：

| 键 | 说明 |
|---|---|
| `wsUrl` | OneBot WebSocket 地址，默认 `ws://127.0.0.1:3001` |
| `allowedUsers` | 允许私聊的 QQ 号；**为空则一律不回复** |
| `allowedGroups` | 允许的群号 |
| `admins` | 管理员 QQ（私聊里拥有全部指令权限；群里不具备） |
| `personaFile` | 人设 Markdown 路径；留空则用内置 `DEFAULT_PERSONA` |
| `botProvider` / `botModel` | 机器人独立的模型通道；留空跟随 Harness 默认 |
| `proactiveEnabled` 等 | 主动说话与群聊插话的开关、频率上限 |

完整键与默认值见 `cordis.patch.yml` 的注释。

## 升级与回滚

- **升级**：检出新的 tag（如 `v0.1.1`），重新执行一次 `dsh plugin add "link:..."`，重启 profile。
- **回滚**：`git checkout v0.1.0` 后重装同一命令；配置格式向后兼容，不需要迁移。
- **可复现**：部署时请固定到 tag 或 commit，而不是分支 HEAD。

## 数据与凭据

- 不保存任何账号密码或 API Key；模型凭据由 DSH 的凭据库管理。
- 人设文件是普通 Markdown，独立于代码，可随时替换。
- 会话记录由 DSH 自己落盘，插件不额外写库。

## 状态

`0.1.0` 为对外评估版：已完成后端链路（收消息 → 会话 → 模型 → 拆条回复 → 打字状态 → 掉线重连）。
运行脚本（健康检查、容器化、systemd）在后续版本加入。
