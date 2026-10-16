# 灵桥 Lingo Bridge · 网页 AI 本地桥接（免费开源）

把当前 VS Code 打开的项目文件夹变成一个**带令牌保护的 MCP 服务**，并自动通过 **Cloudflare 免费隧道**生成公网地址，让 ChatGPT、Claude、Hark 等支持「自定义 MCP Connector」的网页 AI 直接读写你的本地项目、运行命令。

- 不用改 VS Code，原版装插件即可
- 不用注册 Cloudflare 账号（使用临时隧道 trycloudflare.com）
- 不限设备、不收费，MIT 协议

## 安装

1. 到本仓库 [Releases](../../releases) 下载最新的 `lingo-bridge-x.y.z.vsix`
2. 打开 VS Code → 左侧「扩展」→ 右上角 `…` → **从 VSIX 安装…** → 选择下载的文件
   （或命令行：`code --install-extension lingo-bridge-x.y.z.vsix`）

## 使用

1. 用 VS Code 打开你的项目文件夹（AI 只能访问这个文件夹）
2. 点右下角状态栏 **「灵桥 未启动」**，或按 `Ctrl+Shift+P` 输入 **灵桥: 启动**
3. 首次启动会自动下载 cloudflared（约 30–60MB）。国内下载慢可在设置里填 `lingoBridge.downloadMirror` 加速前缀，或自己下载后填 `lingoBridge.cloudflaredPath`
4. 启动成功后 **MCP 地址会自动复制到剪贴板**，形如
   `https://xxxx.trycloudflare.com/mcp/<令牌>`
5. 把地址添加到网页 AI：
   - **ChatGPT**：设置 → Apps & Connectors → 高级设置 → 开启开发者模式 → 创建 Connector，填入地址，认证选「无」
   - **Claude**：设置 → Connectors → Add custom connector，填入地址
   - **Hark**：直接把地址发给 Hark，让它连接这个 MCP 服务

> 临时隧道每次启动地址都会变，需要在网页 AI 里更新一次。想要固定地址，可以自己用 frp / Cloudflare Named Tunnel，把 `lingoBridge.tunnel` 设为 `none` 并填写 `lingoBridge.publicUrl`。

## 提供给 AI 的工具

| 工具 | 作用 |
|---|---|
| `list_directory` | 列出目录 |
| `find_files` | 按 glob 找文件 |
| `search_text` | 全文/正则搜索 |
| `read_file` | 读文件（带行号，可读片段） |
| `write_file` | 新建/覆盖文件 |
| `edit_file` | 精确替换一段文本（保留 CRLF） |
| `delete_path` / `move_path` | 删除、移动 |
| `run_command` | 运行命令（Windows 用 PowerShell，支持超时和后台运行） |
| `get_diagnostics` | 读取 VS Code 里的错误和警告 |
| `open_in_editor` | 在你的编辑器里打开文件 |
| `report_progress` | AI 汇报进度，显示在状态栏 |

## 安全

- **地址里的令牌就是钥匙**，别发给别人。泄露了就运行「灵桥: 重新生成访问令牌」，旧地址立即失效
- 所有路径都限制在打开的文件夹内，`../` 越界会被拒绝
- 默认**运行命令前弹窗确认**（可选「本次启动内都允许」）；修改文件默认不确认，可在设置里打开 `lingoBridge.approveWrite`
- 可在设置里完全关闭写入（`allowWrite`）或命令（`allowCommand`）
- 所有调用都记录在「输出 → 灵桥 Lingo Bridge」日志里
- 不用时点状态栏停止，隧道随之关闭

## 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| `lingoBridge.port` | 3917 | 本地端口 |
| `lingoBridge.tunnel` | cloudflare | `cloudflare` 自动隧道 / `none` 不开隧道 |
| `lingoBridge.publicUrl` | 空 | 自建穿透的公网地址 |
| `lingoBridge.cloudflaredPath` | 空 | 自备 cloudflared 路径 |
| `lingoBridge.downloadMirror` | 空 | GitHub 下载加速前缀 |
| `lingoBridge.allowWrite` | true | 允许写文件 |
| `lingoBridge.allowCommand` | true | 允许运行命令 |
| `lingoBridge.approveWrite` | false | 写文件前确认 |
| `lingoBridge.approveCommand` | true | 运行命令前确认 |
| `lingoBridge.commandTimeoutSec` | 120 | 命令超时秒数 |

## 自己构建

```bash
npm install
npm run package   # 生成 .vsix
```

## 协议

MIT

## 自动更新

1. 在 VS Code 左下角「账户」图标登录 GitHub。
2. 灵桥启动 15 秒后、以及之后每 6 小时，会去你的 GitHub 仓库（设置 `lingoBridge.updateRepo`）看 `package.json` 的版本号；有新版就自动下载 `release/lingo-bridge-<版本>.vsix` 安装，并提示「立即重新加载」。
3. 第一次会弹窗请求 GitHub 仓库访问权限，可在命令面板运行「灵桥: 检查更新」授权。
4. 不想自动更新：设置里关掉 `lingoBridge.autoUpdate`。

## ngrok 隧道（可走代理 + 固定链接）

ngrok 提供免费固定链接。注意：ngrok 免费版**不允许走代理**，默认直连；付费版才可在 `lingoBridge.proxy` 填代理。

1. 打开 ngrok.com 免费注册（可用 GitHub 账号登录）。
2. 在 dashboard 的 **Your Authtoken** 复制令牌；在 **Domains** 领取一个免费固定域名（形如 `xxx.ngrok-free.app`）。
3. VS Code 里 `Ctrl+Shift+P` → 「灵桥: 设置 ngrok」，依次粘贴令牌和域名。
4. 点状态栏「灵桥」启动。之后链接固定不变：`https://xxx.ngrok-free.app/mcp/<令牌>`。



## 控制面板（0.4.0 起）

左侧活动栏的「灵桥」图标打开控制面板：启动/停止、复制 MCP 地址、切换隧道（Cloudflare / ngrok / 不用隧道）、AI 权限开关、自动启动、自动更新、检查更新、重置令牌，全部一处搞定。改权限或隧道时灵桥会自动重启生效。

## 给 AI 的使用说明与项目规则

- AI 接入时自动收到简要说明（系统、PowerShell 语法注意事项、权限），并被要求先调用 `get_usage_guide` 读完整说明（推荐流程、安全规则、工具一览）。
- 新工具：`get_usage_guide`、`get_workspace_info`（项目类型、git 分支、规则文件）、`read_files`（一次读多个文件）。
- 项目规则：在面板点「创建 / 打开项目规则」生成 `.lingo/rules.md`，写上项目简介、常用命令、代码约定，所有接入的 AI 都会自动收到并遵守。也兼容 `AGENTS.md`、`CLAUDE.md`、`.github/copilot-instructions.md`、`.cursorrules`。
