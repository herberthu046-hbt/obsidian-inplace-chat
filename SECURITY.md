# 安全与数据

本插件是本地 Codex 客户端，当前运行权限为 `danger-full-access` / `approvalPolicy: never`。模型可通过本机 shell 和已配置工具访问文件及网络，不是只读或限于库目录的沙箱。请在安装和启用前评估是否适合你的材料。

认证链接指向当前用户 Codex home，不在仓库中存储令牌。会话、数据库、日志与桌面 Codex 独立。没有额外遥测端点；内容会发送给当前 Codex 配置的模型及工具服务。

库内批注、聊天 Markdown、`.inplace-chat/receipts/`、插件 `data.json` 与本机 Codex rollout 可能包含私密内容；即使一般诊断日志做过脱敏，也不要直接公开完整目录。

报告敏感漏洞请使用 GitHub 的私密漏洞报告（仓库启用时可在 Security 页面找到）。如果入口不可用，先发一个不含利用细节或私密数据的 Issue 请求联系渠道，切勿把凭据贴到公开 Issue。
