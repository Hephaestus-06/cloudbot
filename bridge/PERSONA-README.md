# 人设文件怎么用

## 一句话

直接改 / 覆盖 `persona.md`，保存就完事。不用改配置、不用重启。

```
D:\deepseek harness desktop\qq-bridge\persona.md
```

> 注意：Windows 文件名不区分大小写，别另建 `PERSONA.md`，会覆盖同一个文件。

## 生效时机

- 下一条 QQ 消息进来时自动生效；
- 已经在聊的会话也会重建提示词（不用 `/reset`）；
- 想立刻确认当前生效的是哪份、内容是什么：在 QQ 里发 `/persona`。

## 换成别的位置

两种都行，任选其一：

1. QQ 里发：`/persona file D:/你的路径/某个.md`
2. 改 `cordis.patch.yml` 里的 `personaFile: '...'`

优先级：`persona`（内联文本）> `personaFile`（文件）> 插件内置默认。

## 写人设时注意

这段文字会**整段替换** QQ 会话的系统提示词，所以除了性格，最好保留这几段约束，否则它会在 QQ 里贴 Markdown、写小作文、自称 AI、提文件和工具：

- 说话方式：口语短句、禁 Markdown、不自称 AI、不提后台信息
- 工具说明：`qq_say` / `qq_after` / `qq_poke`
- 「不想说话就只回复 SKIP」

`persona.example.md` 是一份带完整约束的模板，可以拿来对照。

## 相关指令（管理员私聊）

| 指令 | 作用 |
|---|---|
| `/persona` | 看当前来源和前 180 字预览 |
| `/persona file <路径>` | 切到某个 md |
| `/persona <文本>` | 用一段内联文本 |
| `/persona reset` | 回到内置人格 |
