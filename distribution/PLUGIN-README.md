# In-place Chat 插件安装包

已有 Obsidian 库的 Windows 用户：

1. 将本包的 `inplace-chat` 文件夹复制到 `<你的库>/.obsidian/plugins/`，启用插件。
2. 另装 Document Comments 0.1.15 和 PDF Annotator 0.3.4；第一次使用更建议直接下载 empty-vault 包，已带齐依赖。
3. 确认本机 Codex 已登录并能聊天。PowerShell 进入本安装包所在目录后运行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-codex-home.ps1 -Vault "你的库的完整路径"
   ```

   需要时确认一次 UAC，仅用于连接自己的登录。移动库后重新运行。
4. Obsidian 设置里模型留空使用本机 Codex 默认模型，或填写自己账户可用的名字。
5. 在批注里写 `@chat 问题`，保存后 `Alt+S` 发送。PDF 先开启 Annotate。

升级只替换三个插件文件，保留 data.json、笔记和历史。PDF 全文阅读建议另装 Python / PyMuPDF。

本版以完整本机权限运行 Codex，没有逐次审批；可读写文件和调用本机工具。材料发送给你的模型服务，用量由你的账户承担。不要公开使用后的聊天与请求记录。

完整说明和依赖地址：https://github.com/herberthu046-hbt/obsidian-inplace-chat

In-place Chat 采用 MIT，见 LICENSE。Obsidian 和 Codex 不包含在本包中。
