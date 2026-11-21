# In-place Chat

在 Obsidian 的讲义旁提问，把 AI 回答留在对应段落。

支持 **Markdown 批注、PDF 高亮、连续追问**。用你本机的 Codex 登录，同一篇文档记住前文；回答支持 Markdown、代码和公式。插件会话与 Codex 桌面分开，不抢同一把写锁。

## 直接用

👉 [下载最新版](https://github.com/herberthu046-hbt/obsidian-inplace-chat/releases/latest)

- **第一次用**：下载 `inplace-chat-empty-vault-0.9.7.zip`。已带好插件，里面没有讲义、聊天或账号。
- **已有 Obsidian 库**：下载 `inplace-chat-0.9.7.zip`，把 `inplace-chat` 文件夹放到库的 `.obsidian/plugins/`。另需 Document Comments 和 PDF Annotator，见[完整安装说明](docs/guide.md)。
- 想自己改：直接 clone 本仓库。也可以从[空白模板库](https://github.com/herberthu046-hbt/obsidian-inplace-chat-starter) 点 **Use this template**。

**不要下 GitHub 自动生成的 Source code 充当插件安装包。**

## 三步开始（Windows）

1. 安装 Obsidian 和 Codex，登录自己的 Codex 账户，确认能正常聊天。CLI 用户可运行 `npm install -g @openai/codex`，然后 `codex login`。
2. 解压空白库，在 Obsidian 中“打开本地仓库”并启用其中的社区插件。在库文件夹打开 PowerShell，运行一次：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-codex-home.ps1 -Vault .
   ```

   需要时确认 UAC。这只是把插件连接到你自己的 Codex 登录，不修改系统策略。移动库后再运行一次。
3. 放入自己的讲义。Markdown 选中文字按 `Alt+C` 添加评论；PDF 先点 **Annotate** 再批注。问题写 `@chat …`，保存后按 **Alt+S** 发送。

PDF 单击高亮消除未读，双击打开详情；详情页底部 Enter 继续追问，Shift+Enter 换行。模型留空跟随本机 Codex 默认配置。PDF 全文阅读建议另装 Python 与 `python -m pip install PyMuPDF`。

## 先知道这几件事

- 目前主要验证 **Windows 桌面**，不支持手机端，也不承诺所有版本都兼容。首发批注依赖固定为 Document Comments 0.1.15、PDF Annotator 0.3.4。
- **Codex 使用完整本机权限、无逐次审批**：可以读写文件、联网并调用你配置的工具；材料会发送给你的模型服务，用量由你的账户承担。
- 空白库不含私人数据；使用后的笔记、聊天和请求记录不要直接公开。旧对话会保留。
- 15 分钟超时限制保留；失败先看状态栏的请求记录，必要时“恢复原回答”，避免重复发送。

遇到问题或想让自己的 AI 帮改，给它看 [详细说明](docs/guide.md) 和源码即可。这是独立项目，不是 Obsidian 或 OpenAI 官方插件；本次不含独立 Zotero 插件。

## 开发

Node.js 22.13+：

```sh
npm ci
npm test
npm run build
```

三个插件发布文件在 `dist/`。`npm run package:starter` 生成空白库；`python scripts/package-release.py` 生成 ZIP。测试默认不调用模型。

[MIT 许可证](LICENSE) · [第三方声明](distribution/THIRD-PARTY-NOTICES.md) · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/herberthu046-hbt/obsidian-inplace-chat/issues)
