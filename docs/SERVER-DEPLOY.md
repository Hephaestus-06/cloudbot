# 服务器部署（占位，等服务器到位再写）

> 状态：**未开始**。服务器还没给到，这里先记下要解决的问题和约束，避免到时候重新踩坑。

## 目标

机器人（NapCat + DSH + qq-bridge）从这台 Windows 笔记本搬到一台常开服务器，本机可以关机。

## 已确认的事实

- 机器人的**协议端**是 NapCat（基于 NTQQ 的第三方实现），QQ 侧对机房 IP 风控更严，登录可能反复要求扫码。
- **桥接插件**（qq-bridge）是 DSH 的 Host 插件，运行在 DSH 进程内，依赖 `sessionController` 等 Host 服务。
- DSH 除了桌面版，还有跨平台 CLI：`@deepseek-ai/dsh`（`bin: lib/bin.js`，无 os/cpu 限制），理论上可跑在 Linux。
- 配置、人设、凭据分别落在：
  - `~/.dsh/profiles/<profile>/cordis.patch.yml`（机器人配置覆盖行）
  - `~/.dsh/.credentials.yaml`（API key 凭据库）
  - `<pluginDir>/persona.md`（人设）

## 待定选项

| 方案 | 说明 | 主要风险 |
|---|---|---|
| Windows 云服务器 | 与现在完全一致，配置可直接搬 | 贵；RDP 断开后 GUI 进程稳定性待验证 |
| Linux + Docker NapCat + dsh CLI | 便宜 | QQ 机房 IP 风控；NapCat 需 Xvfb；打包迁移量大 |
| 家里小主机 | 家庭 IP 友好、零月费 | 仍需一台设备常开 |

## 迁移清单（草稿）

1. 目标机装 Node 20+、QQ/NapCat 或 Docker
2. 搬 `~/.dsh`（含 profile、凭据库、会话）
3. 搬 `qq-bridge` 插件目录（源码 + `persona.md`）
4. 重新 `install_bundle` 并把 `@local/dsh-qq-bridge` 加回 profile 的 bundles 列表
5. 在目标机重新登录 QQ（大概率要扫码一次）
6. 验证：`health-check` 等价检查 + 一条真实消息往返
7. 本机下线：停掉计划任务、停掉 DSH

## 这个工具在服务器上的形态

- 仍然只绑 `127.0.0.1`，通过 SSH 隧道访问；
- 若要用反向代理暴露，必须加认证（不要把 token 放在 URL 里发到公网）。
