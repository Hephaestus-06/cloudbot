# cloudbot

把 QQ 机器人从本地笔记本搬到常开服务器，并给它一套能远程配置的后台。

> 机器人本体目前跑在本地（NapCat + DeepSeek Harness 的桥接插件）；这个仓库先放**能独立运行的部分**，服务器到位后把协议端和桥接一起并进来。

## 进度

| 模块 | 状态 | 位置 |
|---|---|---|
| 远程配置台（改人设 / 白名单 / 功能开关 / 看状态） | ✅ v0.1 可用 | [`src/`](src/server.mjs) · [说明](docs/CONSOLE.md) |
| 服务器部署 | ⏳ 等机器 | [方案草稿](docs/SERVER-DEPLOY.md) |
| 机器人本体（协议端 + 桥接） | 本地运行中 | 迁移时并入 |

## 远程配置台

一个零依赖的本地网页服务：浏览器里改人设和配置，保存即生效（写回 Harness 的配置层并触发重载）。

```bash
cp config.example.json config.json   # 按自己的路径改
node src/server.mjs                  # 首次启动会生成 .token 并打印带 token 的地址
```

能力、安全边界、目录说明见 [docs/CONSOLE.md](docs/CONSOLE.md)。

## 目录

```
src/server.mjs                配置台服务端（Node 内置模块，零依赖）
web/index.html                配置台界面（单页，无构建）
tests/persona-guard.test.mjs  人设写入边界测试
docs/CONSOLE.md               配置台说明
docs/SERVER-DEPLOY.md         服务器迁移方案（草稿）
config.example.json           配置模板（config.json / .token 不入库）
```

## 设计原则

- **只改配置，不改代码**：配置台写的是 Harness 的配置层和人设文件，不做插件安装之类的高风险操作。
- **默认只绑 `127.0.0.1`**：远程访问走 SSH 隧道，不把管理端口暴露到公网。
- **写文件原子替换**：先写临时文件再 rename，避免写一半损坏配置。
- **能改的字段白名单**：只接受明确列出的配置项，并做类型校验。
