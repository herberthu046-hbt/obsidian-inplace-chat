# In-place Chat

在 Obsidian 的讲义原文旁提问，把回答留在对应段落，而不是散落在另一个聊天窗口里。

支持 Markdown 批注与 PDF 高亮；同一文档沿用上下文，独立聊天页可继续追问并显示 Markdown、代码和公式。通过本机 Codex 登录调用模型。**当前首发主要面向 Windows 桌面用户**，不支持 Obsidian 移动端。

## 下载哪个？

前往 [Releases](https://github.com/herberthu046-hbt/obsidian-inplace-chat/releases/latest)。

| 下载文件 | 适合谁 |
| --- | --- |
| `inplace-chat-empty-vault-0.9.7.zip` | 第一次用：包含空白库、三个所需插件和上手说明 |
| `inplace-chat-0.9.7.zip` | 已有 Obsidian 库：只安装本插件，批注依赖另装 |
| `main.js`、`manifest.json`、`styles.css` | 手动安装或更新本插件的三个文件 |
| `SHA256SUMS.txt` | 校验下载文件 |

GitHub 自动提供的 **Source code** 是开发源码，不是开箱即用的空白库。无需 fork 仓库，也不需要把自己的笔记推到 GitHub。本插件尚未进入 Obsidian 社区插件目录。

熟悉 GitHub 的同学也可使用 [空白模板仓库](https://github.com/herberthu046-hbt/obsidian-inplace-chat-starter) 的 **Use this template**。初学者直接下载 ZIP 更简单。

## 同学快速开始

1. 安装 [Obsidian](https://obsidian.md/) 与 [Codex](https://developers.openai.com/codex/cli/)，确认自己的账户能在本机 Codex 中正常提问。CLI 安装方式：安装 Node.js 22.13+，然后运行 `npm install -g @openai/codex`、`codex login`。模型用量由你的账户承担。
2. 下载并解压 **empty-vault** 压缩包到准备长期使用的目录；不要直接在压缩包内打开。
3. 在 Obsidian 选择“打开本地仓库”，选择解压后的 `In-place-Chat` 文件夹；阅读信任提示后允许社区插件。
4. 在 PowerShell 中进入该文件夹，运行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-codex-home.ps1 -Vault .
   ```

   脚本在需要时弹出一次 UAC，只建立指向自己 Codex 登录文件的两个链接。它不把登录文件复制到库里，不修改系统执行策略。移动库后需要在新位置再运行一次。
5. 打开设置 → In-place Chat。模型留空时使用本机 Codex 默认模型；也可填写**你自己账户可用**的模型名。找不到 Codex 时填写 `codex.exe` 完整路径，然后重启 Obsidian。
6. 放入自己的 `.md` 或 `.pdf`，按下面的方法添加问题并发送。

PDF 全文阅读建议预先安装 Python 和 PyMuPDF：`python -m pip install PyMuPDF`。这不是空白库内置依赖；纯 Markdown 使用不需要 Python。扫描版 PDF 的 OCR 不在首发支持范围。

## 怎么用

| 操作 | 方法 |
| --- | --- |
| Markdown 提问 | 选中文字，用 Document Comments 添加评论（空库设置 `Alt+C`），问题中保留 `@chat` |
| PDF 提问 | 打开 PDF，点 **Annotate** 开启批注模式，选中文字并保存包含 `@chat` 的评论 |
| 发送 | `Alt+S` 发送当前文档全部待答；也可点击底部 chat 状态，选择要发送的问题 |
| 读新回答 | PDF 单击关联高亮可标为已读，双击打开聊天详情；重叠批注弹出选择列表 |
| 继续追问 | 聊天详情底部输入问题，Enter 发送，Shift+Enter 换行；无需再写 `@chat` |
| 看状态 | 状态栏区分当前文档和其他文档；点击查看待答、未读、失败记录 |

只添加批注不会自动调用模型；发送快捷键可在 Obsidian“快捷键”设置中修改。发送 PDF 时必须保持该 PDF 的 Annotate 模式可用，直到回答写回。

## 安装到已有库

1. 先备份库。
2. 安装 [Document Comments](https://github.com/kylemcd/obsidian-document-comments) 和 [PDF Annotator](https://github.com/AlexanderT142/Alex-annotator)。首发验证组合为 Document Comments **0.1.15**、PDF Annotator **0.3.4**。
3. 解压插件安装包，将 `inplace-chat` 文件夹放入 `<你的库>/.obsidian/plugins/`。在 Obsidian 启用三个插件。
4. 从安装包的 `scripts` 目录运行 `setup-codex-home.ps1 -Vault "你的库的完整路径"`，然后完成模型设置。

升级时替换本插件的 `main.js`、`manifest.json`、`styles.css` 即可，保留 `data.json` 与库内数据。首次升级至独立会话版本也需要运行设置脚本。

## 会话、登录与隐私

每个库有独立的 Codex 会话目录：`%USERPROFILE%/.obsidian-inplace-chat/codex/<库路径哈希>/`。与 Codex 桌面端分开保存历史、数据库和会话写锁，避免 `already has an active writer`；插件新回复不会更新桌面聊天列表。旧桌面聊天作为原记录保留，插件首次续接时复制相应历史。

登录仍使用本机 Codex：`auth.json` 和 `auth.lock` 是指向源 Codex home 的符号链接，刷新与账号切换共用原认证。配置、技能和工具沿用本机配置。换账户不要求清空问答；正在生成时尽量不要切换登录。

**权限边界需要在使用前了解：当前版本以 `danger-full-access`、`approvalPolicy: never` 运行 Codex。** 模型可读取本机文档、调用 shell 和已配置工具，具备修改文件及联网能力；不局限于这一个库，也不逐次弹审批。只对你愿意交给模型处理的材料使用。本文档说明实际行为，不把它描述成只读沙箱。

内容和工具结果会发送给你当前配置的模型服务；本插件没有额外遥测服务。回答和批注留在库内，`.inplace-chat/` 保存状态、请求与恢复记录，插件 `data.json` 保存设置和会话映射，`diagnostics/` 保存诊断。请求记录可能包含原文、问题和绝对路径，**不要直接公开整个库或提交原始请求记录**。

## 常见问题

- **找不到 Codex / 无法启动**：先在终端确认 `codex --version` 和登录可用；安装后重启 Obsidian，必要时填原生 `codex.exe` 路径。插件依赖 Codex app-server；协议仍在变化。
- **提示独立会话目录未连接登录**：先 `codex login`，再对当前库运行设置脚本并同意 UAC。Windows 无法创建链接时不要手工复制令牌代替。
- **`active writer`**：确认升级并完成独立目录设置；不要另开 Codex 进程使用插件私有 `CODEX_HOME`。不要删除锁文件或杀掉其他聊天来重试。
- **PDF 不可发送**：在该 PDF 中开启 Annotate，并等待加载。初次提问需先保存批注。
- **超过 15 分钟没有回复**：固定上限会中断请求。先用“恢复原回答”，查看请求记录确认结果；不会自动重复生成。确认中断后可手动重新发送仍待答的问题。
- **模型不存在、503、额度或登录错误**：在本机 Codex 检查同一模型和服务配置；换成账户可用模型。模型服务失败与插件写回失败会分别记录。
- **首次启动慢**：插件会核对库内已有 Markdown 和批注；大库需要等待。

## 兼容性与首发范围

Manifest 最低 Obsidian 版本为 1.7.2，实际首发验证在 Windows 桌面环境完成。未宣称所有 Obsidian / Codex / 批注插件版本均兼容。开发测试使用过 Codex `0.167.0-alpha.3.2`；独立 CLI 没有桌面 project 接口时可跳过该功能。旧 CLI 如果不支持认证符号链接、app-server 或所需协议，需要更新。

macOS/Linux 没有完整验收与安装向导，暂不承诺开箱即用。代码中保留的 Zotero 桥接是实验性旧功能、默认关闭；**本次不发布独立 Zotero 插件**。不是 Obsidian、OpenAI 或第三方批注插件的官方项目。

## 开发与构建

```sh
npm ci
npm test
npm run build
node scripts/fetch-dependencies.cjs
npm run package:starter
```

构建输出在 `dist/`，空库在 `release/empty-vault/`；再次打包请先选择新的输出目录，工具不会覆盖现有库。运行 `python scripts/package-release.py` 可生成发布 ZIP 与校验文件。依赖下载依据 `distribution/dependencies.json` 中固定版本与 SHA-256 校验。测试默认使用假模型，不消耗账户用量。可选浏览器交互测试需要自行安装 Playwright。

见 [贡献说明](../CONTRIBUTING.md)、[版本记录](../CHANGELOG.md)、[安全与数据说明](../SECURITY.md)。代码采用 [MIT](../LICENSE)，模板中的第三方插件保留各自许可证，见 [第三方声明](../distribution/THIRD-PARTY-NOTICES.md)。
