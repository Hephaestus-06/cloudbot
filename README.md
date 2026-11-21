# cloudbot

把 QQ 机器人从本地笔记本搬到常开服务器，并给它一套能远程配置的后台。

> 机器人本体目前跑在本地（NapCat + DeepSeek Harness 的桥接插件）；这个仓库先放**能独立运行的部分**，服务器到位后把协议端和桥接一起并进来。

## 进度

| 模块 | 状态 | 位置 |
|---|---|---|
| 远程配置台（改人设 / 白名单 / 功能开关 / 看状态） | ✅ v0.1 可用 | [`src/`](src/server.mjs) · [说明](docs/CONSOLE.md) |
| QQ 桥接插件（OneBot ↔ DSH 会话） | ✅ v0.1.0 可审阅 | [`bridge/`](bridge/README.md) |
| 服务器部署 | ⏳ 等机器 | [方案草稿](docs/SERVER-DEPLOY.md) |

## 组成

```
bridge/        QQ 桥接插件（DSH Host 插件，零依赖，MIT）
src/ + web/    远程配置台（改人设、白名单、开关）
docs/          配置台说明、服务器迁移方案
```

配置台和桥接是两件独立的东西：前者是「改配置的界面」，后者是「真正在跑消息的东西」。

## 打包与安装

**打包**（开发机上）：

```bash
node scripts/package.mjs
```

产出 `dist/cloudbot-<version>/` 和同名 zip（含 `manifest.json`，记录每个文件的 sha256）。

**安装**（目标机器上）：

```bash
unzip cloudbot-0.2.0.zip -d cloudbot && cd cloudbot
node install.mjs --profile cloudbot     # 加 --dry-run 只看计划
dsh cloudbot                            # 启动
```

安装器会：检查 Node ≥ 20 → 建 profile 骨架 → 写入 bundles → `dsh plugin add link:bridge` → 从示例生成 `persona.md`。
重复执行是幂等的，不会覆盖已有配置和人设。

## 怎么启动

三种方式，按场景选。

### 1. 双击启动（Windows，推荐）

双击 **`start-gui.vbs`**：

- 不弹任何命令行黑框（服务在后台隐藏运行）；
- 自动打开一个**独立窗口**（Edge/Chrome 的 app 模式，看起来就是个软件）；
- 关掉窗口不会停止服务，机器人配置随时能改。

要彻底停止：点页面底部的 **「关闭服务」**，或双击 `stop-gui.vbs`。

> 如果双击 `.vbs` 没反应，说明系统禁用了 Windows Script Host；改用下面的 `start.bat`（会有一个控制台窗口，适合排查问题）。

### 2. 带控制台启动（排查问题用）

双击 **`start.bat`**：检查 Node、首次从模板生成 `config.json`、启动并打印带 token 的地址。**关掉这个窗口 = 停止服务。**

### 3. 命令行（任意系统）

```bash
npm start              # = node src/server.mjs
npm start -- --open    # 顺便自动打开浏览器
```

macOS / Linux 也可以用 `./start.sh`（首次先 `chmod +x start.sh`）。

启动后控制台会打印带 token 的地址，第一次运行还会生成 `.token` 文件：

```
bot-console 已启动
  地址: http://127.0.0.1:8787/?token=xxxxxxxx
```

> 需要 **Node 20+**（用到了全局 `fetch` / `WebSocket`）。没有 npm 依赖，**不需要 `npm install`**。

### 3. Docker（服务器上用）

```bash
BOT_CONSOLE_TOKEN=换成你的口令 docker compose up -d --build
```

关键约束：配置台是「改文件」的工具，`docker-compose.yml` 里必须把宿主机上真实的 **profile 目录**（含 `cordis.patch.yml`）和**插件目录**（含 `persona.md`）挂进容器，否则改的是容器里的副本。见文件内注释与 [docs/SERVER-DEPLOY.md](docs/SERVER-DEPLOY.md)。

## 远程配置台

一个零依赖的本地网页服务：浏览器里改人设和配置，保存即生效（写回 Harness 的配置层并触发重载）。

能力、安全边界、目录说明见 [docs/CONSOLE.md](docs/CONSOLE.md)。

## 目录

```
start.bat / start.sh          一键启动脚本
src/server.mjs                配置台服务端（Node 内置模块，零依赖）
web/index.html                配置台界面（单页，无构建）
tests/persona-guard.test.mjs  人设写入边界测试
docs/CONSOLE.md               配置台说明
docs/SERVER-DEPLOY.md         服务器迁移方案（草稿）
Dockerfile / docker-compose.yml  服务器上的容器化启动
config.example.json           配置模板（config.json / .token 不入库）
```

## 设计原则

- **只改配置，不改代码**：配置台写的是 Harness 的配置层和人设文件，不做插件安装之类的高风险操作。
- **默认只绑 `127.0.0.1`**：远程访问走 SSH 隧道，不把管理端口暴露到公网。
- **写文件原子替换**：先写临时文件再 rename，避免写一半损坏配置。
- **能改的字段白名单**：只接受明确列出的配置项，并做类型校验。
