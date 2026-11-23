# 发布包

## cloudbot-0.3.1.zip（公开版，116 KB）

**不含任何第三方协议端二进制**，只含本仓库自己的代码：

```
setup.bat / start.bat / stop.bat / selftest.bat
install.mjs              部署引擎
skin/                    皮肤层插件（人设 / 记忆 / 好感度 / 表情包）
bridge/                  旧方案桥接插件（可回滚）
stickers/                表情图库
persona.example.md       人设模板
console/                 配置台
docs/                    迁移说明、运维手册
protocol/README.md       协议端下载说明（二进制需你自行下载）
```

sha256：`1aa3b83a11ced4d1385055dfdfb431c7b75937f540759fabd8a87f556af3ba4a`

### 为什么包里没有协议端

| 协议端 | 许可 | 能否随包分发 |
|---|---|---|
| SnowLuma | 自定义 EULA v1.1 | ❌ 第 5.4 条禁止「并入第三方安装包」与「通过自动化脚本部署」 |
| NapCatQQ | 仓库无 LICENSE | ❌ 默认保留所有权利 |
| Lagrange.Core | 仓库无 LICENSE | ❌ 默认保留所有权利 |

所以包里只放 `protocol/README.md`：你从官方 Release 自己下载、解压到
`protocol/snowluma/app/`，再跑 `setup.bat` 即可——安装器只写配置，不动它的程序文件。

### 安装

```text
1. 装好 QQ 并登录机器人账号
2. 下载并解压协议端到 protocol/snowluma/app/
3. 解压本 zip
4. 双击 setup.bat（输入机器人 QQ 与你的 QQ）
5. 双击 start.bat
```
