import * as vscode from "vscode";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Bridge } from "./core";
import { Tunnel } from "./tunnel";
import { checkForUpdate } from "./updater";
import { Ngrok, systemProxy } from "./ngrok";
import { LingoPanel } from "./panel";
import { RULES_TEMPLATE } from "./guide";

let bridge: Bridge | undefined;
let tunnel: Tunnel | undefined;
let ngrok: Ngrok | undefined;
let status: vscode.StatusBarItem;
let out: vscode.OutputChannel;
let publicMcpUrl: string | undefined;
let sessionAllow = { write: false, command: false };
let curState: "off" | "starting" | "on" = "off";
let curDetail: string | undefined;
let panel: LingoPanel | undefined;

function cfg() {
  const c = vscode.workspace.getConfiguration("lingoBridge");
  return {
    port: c.get<number>("port", 3917),
    tunnel: c.get<string>("tunnel", "cloudflare"),
    publicUrl: c.get<string>("publicUrl", "").trim(),
    cloudflaredPath: c.get<string>("cloudflaredPath", "").trim(),
    downloadMirror: c.get<string>("downloadMirror", "").trim(),
    ngrokPath: c.get<string>("ngrokPath", "").trim(),
    ngrokDomain: c.get<string>("ngrokDomain", "").trim(),
    proxy: c.get<string>("proxy", "auto").trim(),
    allowWrite: c.get<boolean>("allowWrite", true),
    allowCommand: c.get<boolean>("allowCommand", true),
    approveWrite: c.get<boolean>("approveWrite", false),
    approveCommand: c.get<boolean>("approveCommand", true),
    commandTimeoutSec: c.get<number>("commandTimeoutSec", 120),
  };
}

function log(s: string) {
  out.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`);
}

async function getToken(ctx: vscode.ExtensionContext, regenerate = false): Promise<string> {
  let t = regenerate ? undefined : await ctx.secrets.get("lingoBridge.token");
  if (!t) {
    t = randomBytes(24).toString("base64url");
    await ctx.secrets.store("lingoBridge.token", t);
  }
  return t;
}

function setStatus(state: "off" | "starting" | "on", detail?: string) {
  curState = state; curDetail = detail; panel?.refresh();
  if (state === "off") { status.text = "$(plug) 灵桥 未启动"; status.tooltip = "点击打开灵桥面板"; status.command = "lingoBridge.openPanel"; }
  if (state === "starting") { status.text = "$(sync~spin) 灵桥 启动中…"; status.tooltip = detail; status.command = "lingoBridge.showLog"; }
  if (state === "on") { status.text = "$(broadcast) 灵桥 运行中"; status.tooltip = `${detail}\n点击复制 MCP 地址`; status.command = "lingoBridge.copyUrl"; }
  status.show();
}

async function approve(kind: "write" | "command", summary: string): Promise<boolean> {
  if (sessionAllow[kind]) return true;
  const title = kind === "command" ? "网页 AI 想运行命令" : "网页 AI 想修改文件";
  const pick = await Promise.race([
    vscode.window.showWarningMessage(`${title}:\n${summary}`, { modal: false }, "允许", "本次启动内都允许", "拒绝"),
    new Promise<undefined>((ok) => setTimeout(() => ok(undefined), 180_000)),
  ]);
  if (pick === "本次启动内都允许") { sessionAllow[kind] = true; return true; }
  const ok = pick === "允许";
  log(`${ok ? "已允许" : "已拒绝"}: ${summary.split("\n")[0]}`);
  return ok;
}

async function diagnostics(root: string, rel?: string): Promise<string> {
  const sev = ["错误", "警告", "信息", "提示"];
  const lines: string[] = [];
  const all = rel ? [[vscode.Uri.file(path.resolve(root, rel)), vscode.languages.getDiagnostics(vscode.Uri.file(path.resolve(root, rel)))] as const]
                  : vscode.languages.getDiagnostics();
  for (const [uri, ds] of all) {
    const r = path.relative(root, uri.fsPath).split(path.sep).join("/");
    if (r.startsWith("..")) continue;
    for (const d of ds) {
      if (d.severity > 1) continue; // only errors & warnings
      lines.push(`${r}:${d.range.start.line + 1}:${d.range.start.character + 1} [${sev[d.severity]}] ${d.message}`);
      if (lines.length >= 300) break;
    }
  }
  return lines.join("\n") || "没有错误或警告";
}

async function start(ctx: vscode.ExtensionContext) {
  if (bridge) { await copyUrl(); return; }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showErrorMessage("请先用 VS Code 打开一个项目文件夹，再启动灵桥。"); return; }
  const c = cfg();
  const root = folder.uri.fsPath;
  const token = await getToken(ctx);
  sessionAllow = { write: false, command: false };
  setStatus("starting", "正在启动本地服务");
  out.show(true);
  try {
    const b = new Bridge({
      root, port: c.port, token,
      allowWrite: c.allowWrite, allowCommand: c.allowCommand,
      approveWrite: c.approveWrite, approveCommand: c.approveCommand,
      commandTimeoutSec: c.commandTimeoutSec,
      host: {
        approve, log,
        diagnostics: (rel) => diagnostics(root, rel),
        openFile: async (abs, line) => {
          const doc = await vscode.workspace.openTextDocument(abs);
          const ed = await vscode.window.showTextDocument(doc, { preview: false });
          if (line) { const p = new vscode.Position(line - 1, 0); ed.selection = new vscode.Selection(p, p); ed.revealRange(new vscode.Range(p, p)); }
        },
        progress: (m) => { log("AI 进度: " + m); vscode.window.setStatusBarMessage("$(info) AI: " + m, 8000); },
      },
    });
    await b.start();
    bridge = b;

    let base: string;
    if (c.tunnel === "cloudflare") {
      tunnel = new Tunnel(ctx.globalStorageUri.fsPath, log);
      const bin = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "准备 cloudflared", cancellable: false },
        async (p) => {
          let last = 0;
          return tunnel!.ensureBinary(c.cloudflaredPath, c.downloadMirror, (pct) => { p.report({ message: `下载中 ${pct}%`, increment: pct - last }); last = pct; });
        });
      setStatus("starting", "正在建立 Cloudflare 隧道");
      base = await tunnel.start(bin, c.port);
    } else if (c.tunnel === "ngrok") {
      let at = await ctx.secrets.get("lingoBridge.ngrokAuthtoken");
      if (!at) { await setupNgrok(ctx); at = await ctx.secrets.get("lingoBridge.ngrokAuthtoken"); }
      if (!at) throw new Error("没有 ngrok Authtoken，已取消");
      ngrok = new Ngrok(path.join(ctx.globalStorageUri.fsPath, "ngrok"), log);
      const bin = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "准备 ngrok", cancellable: false },
        async (p) => { let last = 0; return ngrok!.ensureBinary(c.ngrokPath, (pct) => { p.report({ message: `下载中 ${pct}%`, increment: pct - last }); last = pct; }); });
      const proxy = c.proxy === "auto" ? await systemProxy() : c.proxy;
      setStatus("starting", "正在建立 ngrok 隧道");
      const domain = c.ngrokDomain || (await ctx.secrets.get("lingoBridge.ngrokDomain")) || "";
      try {
        base = await ngrok.start(bin, c.port, at, domain, proxy);
      } catch (e: any) {
        // ngrok 免费版不允许走代理（ERR_NGROK_9009），自动改为直连重试
        if (proxy && /9009|proxy is a Pay-as-you-go/i.test(String(e?.message))) {
          log("ngrok 免费版不支持代理，改为直连重试…");
          base = await ngrok.start(bin, c.port, at, domain, "");
        } else throw e;
      }
    } else if (c.publicUrl) {
      base = c.publicUrl.replace(/\/+$/, "");
    } else {
      base = `http://127.0.0.1:${c.port}`;
    }
    publicMcpUrl = `${base}${b.mcpPath}`;
    setStatus("on", `工作区: ${root}\n${publicMcpUrl}`);
    log(`MCP 地址: ${publicMcpUrl}`);
    await vscode.env.clipboard.writeText(publicMcpUrl);
    const act = await vscode.window.showInformationMessage(
      `灵桥已启动，MCP 地址已复制到剪贴板。把它添加到网页 AI 的自定义 MCP Connector 即可。`, "再次复制", "查看日志");
    if (act === "再次复制") await copyUrl();
    if (act === "查看日志") out.show();
  } catch (e: any) {
    log("启动失败: " + (e?.stack ?? e));
    vscode.window.showErrorMessage(`灵桥启动失败: ${e?.message ?? e}`);
    await stop();
  }
}

async function setupNgrok(ctx: vscode.ExtensionContext) {
  const at = await vscode.window.showInputBox({
    title: "灵桥：设置 ngrok（1/2）",
    prompt: "粘贴 ngrok Authtoken（登录 dashboard.ngrok.com → Your Authtoken 复制）",
    password: true, ignoreFocusOut: true,
  });
  if (!at) return;
  await ctx.secrets.store("lingoBridge.ngrokAuthtoken", at.trim());
  const dom = await vscode.window.showInputBox({
    title: "灵桥：设置 ngrok（2/2）",
    prompt: "可选：你的免费固定域名（dashboard.ngrok.com → Domains，形如 xxx.ngrok-free.app）。留空则每次随机",
    ignoreFocusOut: true,
  });
  await vscode.workspace.getConfiguration("lingoBridge").update("ngrokDomain", (dom ?? "").trim(), vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration("lingoBridge").update("tunnel", "ngrok", vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("ngrok 已设置好，隧道方式已切换为 ngrok。" + (bridge ? "重启灵桥后生效。" : "点状态栏“灵桥”启动。"));
}

async function stop() {
  ngrok?.stop(); ngrok = undefined;
  tunnel?.stop(); tunnel = undefined;
  await bridge?.stop(); bridge = undefined;
  publicMcpUrl = undefined;
  setStatus("off");
  log("灵桥已停止");
}

async function copyUrl() {
  if (!publicMcpUrl) { vscode.window.showWarningMessage("灵桥还没启动。"); return; }
  await vscode.env.clipboard.writeText(publicMcpUrl);
  vscode.window.showInformationMessage("MCP 地址已复制。注意：地址里含访问令牌，别发给别人。");
}

async function openRules() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showErrorMessage("请先打开一个项目文件夹。"); return; }
  const uri = vscode.Uri.joinPath(folder.uri, ".lingo", "rules.md");
  try { await vscode.workspace.fs.stat(uri); }
  catch { await vscode.workspace.fs.writeFile(uri, Buffer.from(RULES_TEMPLATE, "utf8")); }
  await vscode.window.showTextDocument(uri, { preview: false });
}

async function panelAction(ctx: vscode.ExtensionContext, m: any) {
  const conf = vscode.workspace.getConfiguration("lingoBridge");
  switch (m?.a) {
    case "start": await start(ctx); break;
    case "stop": await stop(); break;
    case "copy": await copyUrl(); break;
    case "log": out.show(); break;
    case "setupNgrok": await setupNgrok(ctx); break;
    case "rules": await openRules(); break;
    case "update": await checkForUpdate(ctx, log, true); break;
    case "regen": await vscode.commands.executeCommand("lingoBridge.regenerateToken"); break;
    case "settings": await vscode.commands.executeCommand("workbench.action.openSettings", "lingoBridge"); break;
    case "set": {
      const allowed = ["tunnel", "allowWrite", "approveWrite", "allowCommand", "approveCommand", "autoUpdate", "autoStart"];
      if (!allowed.includes(m.k)) return;
      await conf.update(m.k, m.v, vscode.ConfigurationTarget.Global);
      if (m.k === "tunnel" && m.v === "ngrok" && !(await ctx.secrets.get("lingoBridge.ngrokAuthtoken"))) await setupNgrok(ctx);
      if (bridge && ["tunnel", "allowWrite", "allowCommand", "approveWrite", "approveCommand"].includes(m.k)) {
        log(`设置 ${m.k} 已改为 ${m.v}，正在重启灵桥…`);
        await stop(); await start(ctx);
      }
      break;
    }
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  out = vscode.window.createOutputChannel("灵桥 Lingo Bridge");
  panel = new LingoPanel(async () => ({
    state: curState, detail: curDetail, url: publicMcpUrl,
    version: ctx.extension.packageJSON.version,
    root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    hasNgrokToken: !!(await ctx.secrets.get("lingoBridge.ngrokAuthtoken")),
  }), (m) => panelAction(ctx, m));
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lingoBridge.panel", panel),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("lingoBridge")) panel?.refresh(); }),
    vscode.commands.registerCommand("lingoBridge.openPanel", () => vscode.commands.executeCommand("workbench.view.extension.lingoBridge")),
    vscode.commands.registerCommand("lingoBridge.createRules", () => openRules()),
  );
  if (vscode.workspace.getConfiguration("lingoBridge").get<boolean>("autoStart", false) && vscode.workspace.workspaceFolders?.length) {
    setTimeout(() => { if (!bridge) start(ctx); }, 3000);
  }
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  setStatus("off");
  ctx.subscriptions.push(out, status,
    vscode.commands.registerCommand("lingoBridge.start", () => start(ctx)),
    vscode.commands.registerCommand("lingoBridge.stop", () => stop()),
    vscode.commands.registerCommand("lingoBridge.copyUrl", () => copyUrl()),
    vscode.commands.registerCommand("lingoBridge.showLog", () => out.show()),
    vscode.commands.registerCommand("lingoBridge.regenerateToken", async () => {
      await getToken(ctx, true);
      vscode.window.showInformationMessage("已生成新令牌，旧地址立即失效。" + (bridge ? "正在重启灵桥…" : ""));
      if (bridge) { await stop(); await start(ctx); }
    }),
    vscode.commands.registerCommand("lingoBridge.setupNgrok", async () => { await setupNgrok(ctx); }),
    vscode.commands.registerCommand("lingoBridge.checkUpdate", () => checkForUpdate(ctx, log, true)),
  );
  // 自动更新：启动 15 秒后检查一次，之后每 6 小时检查一次
  const auto = () => checkForUpdate(ctx, log, false).catch((e) => log(`更新检查异常: ${e?.message ?? e}`));
  const t1 = setTimeout(auto, 15000);
  const t2 = setInterval(auto, 6 * 3600 * 1000);
  ctx.subscriptions.push({ dispose: () => { clearTimeout(t1); clearInterval(t2); } });
}

export async function deactivate() {
  ngrok?.stop();
  tunnel?.stop();
  await bridge?.stop();
}
