// Sidebar control panel for 灵桥.
import * as vscode from "vscode";

export interface PanelState {
  state: "off" | "starting" | "on";
  detail?: string;
  url?: string;
  version: string;
  root?: string;
  hasNgrokToken: boolean;
}

export class LingoPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  constructor(private getState: () => Promise<PanelState>, private onAction: (msg: any) => Promise<void>) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(async (m) => { try { await this.onAction(m); } finally { this.refresh(); } });
    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); });
    this.refresh();
  }

  async refresh() {
    if (!this.view) return;
    const s = await this.getState();
    const c = vscode.workspace.getConfiguration("lingoBridge");
    this.view.webview.html = html(s, {
      tunnel: c.get<string>("tunnel", "cloudflare"),
      ngrokDomain: c.get<string>("ngrokDomain", ""),
      allowWrite: c.get<boolean>("allowWrite", true),
      allowCommand: c.get<boolean>("allowCommand", true),
      approveWrite: c.get<boolean>("approveWrite", false),
      approveCommand: c.get<boolean>("approveCommand", true),
      autoUpdate: c.get<boolean>("autoUpdate", true),
      autoStart: c.get<boolean>("autoStart", false),
    }, nonce());
  }
}

function nonce() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
function esc(s: string) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }

function html(s: PanelState, c: Record<string, any>, n: string) {
  const dot = s.state === "on" ? "#3fb950" : s.state === "starting" ? "#d29922" : "#8b949e";
  const label = s.state === "on" ? "运行中" : s.state === "starting" ? "启动中…" : "未启动";
  const chk = (k: string, text: string, hint = "") =>
    `<label class="row"><input type="checkbox" data-k="${k}" ${c[k] ? "checked" : ""}/> <span>${text}${hint ? `<small>${hint}</small>` : ""}</span></label>`;
  const radio = (v: string, text: string, hint: string) =>
    `<label class="row"><input type="radio" name="tunnel" value="${v}" ${c.tunnel === v ? "checked" : ""}/> <span>${text}<small>${hint}</small></span></label>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);padding:4px 10px 16px}
h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin:18px 0 6px}
.status{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;margin-top:6px}
.dot{width:10px;height:10px;border-radius:50%;background:${dot};box-shadow:0 0 6px ${dot}}
.muted{color:var(--vscode-descriptionForeground);font-size:12px;word-break:break-all;margin:4px 0}
button{width:100%;padding:6px 8px;margin:4px 0;border:none;border-radius:3px;cursor:pointer;font-size:13px;
 background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:hover{background:var(--vscode-button-hoverBackground)}
button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.sec:hover{background:var(--vscode-button-secondaryHoverBackground)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 6px}
.url{display:flex;gap:4px;align-items:center;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);
 border-radius:3px;padding:4px 6px;font-family:var(--vscode-editor-font-family);font-size:11px;word-break:break-all}
.row{display:flex;gap:6px;align-items:flex-start;margin:5px 0;cursor:pointer}
.row small{display:block;color:var(--vscode-descriptionForeground);font-size:11px}
</style></head><body>
<div class="status"><span class="dot"></span>灵桥 ${label}</div>
<div class="muted">v${esc(s.version)}${s.root ? " · " + esc(s.root) : " · 未打开文件夹"}</div>
${s.state === "on" && s.url ? `<div class="url">${esc(s.url.replace(/(\/mcp\/)(.{4}).*$/, "$1$2••••••"))}</div>
<div class="grid"><button data-a="copy">复制 MCP 地址</button><button class="sec" data-a="stop">停止</button></div>`
  : s.state === "starting" ? `<div class="muted">${esc(s.detail ?? "")}</div><button class="sec" data-a="log">查看日志</button>`
  : `<button data-a="start">启动灵桥</button>`}

<h3>隧道方式</h3>
${radio("cloudflare", "Cloudflare 临时隧道", "免费免注册，每次启动地址会变")}
${radio("ngrok", "ngrok 固定链接", c.ngrokDomain ? esc(c.ngrokDomain) : (s.hasNgrokToken ? "随机域名" : "需先设置 Authtoken"))}
${radio("none", "不用隧道", "仅本机 / 自己的 frp 等")}
<button class="sec" data-a="setupNgrok">${s.hasNgrokToken ? "修改 ngrok 设置" : "设置 ngrok"}</button>

<h3>AI 权限</h3>
${chk("allowWrite", "允许修改文件")}
${chk("approveWrite", "修改前弹窗问我")}
${chk("allowCommand", "允许运行命令")}
${chk("approveCommand", "运行命令前弹窗问我")}

<h3>给 AI 的说明</h3>
<div class="muted">AI 接入时会自动收到使用说明；项目规则写在 .lingo/rules.md，所有 AI 都会遵守。</div>
<button class="sec" data-a="rules">创建 / 打开项目规则</button>

<h3>其他</h3>
${chk("autoStart", "打开 VS Code 时自动启动")}
${chk("autoUpdate", "自动更新")}
<div class="grid"><button class="sec" data-a="update">检查更新</button><button class="sec" data-a="log">查看日志</button></div>
<div class="grid"><button class="sec" data-a="regen">重置令牌</button><button class="sec" data-a="settings">全部设置</button></div>
<script nonce="${n}">
const vs=acquireVsCodeApi();
document.querySelectorAll('button[data-a]').forEach(b=>b.onclick=()=>vs.postMessage({a:b.dataset.a}));
document.querySelectorAll('input[type=checkbox][data-k]').forEach(i=>i.onchange=()=>vs.postMessage({a:'set',k:i.dataset.k,v:i.checked}));
document.querySelectorAll('input[name=tunnel]').forEach(i=>i.onchange=()=>vs.postMessage({a:'set',k:'tunnel',v:i.value}));
</script></body></html>`;
}
