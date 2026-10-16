// 灵桥小球 agent: headless bridge driven by LingoBall.exe over stdio (JSON lines).
// stdout events: {t:"status",s,detail} {t:"url",url} {t:"log",m} {t:"approve",id,kind,summary} {t:"progress",m} {t:"error",m}
// stdin commands: {t:"approve",id,ok} {t:"stop"}
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { Bridge } from "./core";
import { Tunnel } from "./tunnel";
import { Ngrok } from "./ngrok";

const send = (o: any) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (m: string) => send({ t: "log", m });

const cfgPath = process.argv[2];
const c = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
const dataDir: string = c.dataDir || path.dirname(cfgPath);

let seq = 0;
const pending = new Map<number, (ok: boolean) => void>();
let tunnel: Tunnel | undefined, ngrok: Ngrok | undefined, bridge: Bridge | undefined;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m: any; try { m = JSON.parse(line); } catch { return; }
  if (m.t === "approve") { pending.get(m.id)?.(!!m.ok); pending.delete(m.id); }
  if (m.t === "stop") shutdown();
});
process.stdin.on("end", shutdown);

async function shutdown() {
  try { tunnel?.stop(); } catch {}
  try { ngrok?.stop(); } catch {}
  try { await bridge?.stop(); } catch {}
  process.exit(0);
}

async function main() {
  if (!c.root || !fs.existsSync(c.root)) throw new Error("工作文件夹不存在，请右键小球 → 选择工作文件夹");
  send({ t: "status", s: "starting", detail: "正在启动本地服务" });
  bridge = new Bridge({
    root: c.root, port: c.port || 3917, token: c.token,
    allowWrite: c.allowWrite !== false, allowCommand: c.allowCommand !== false,
    approveWrite: !!c.approveWrite, approveCommand: c.approveCommand !== false,
    commandTimeoutSec: c.commandTimeoutSec || 120,
    host: {
      log,
      approve: (kind, summary) => new Promise((ok) => { const id = ++seq; pending.set(id, ok); send({ t: "approve", id, kind, summary }); }),
      openFile: async (abs) => { spawn("explorer.exe", [abs], { detached: true, windowsHide: false }).unref(); },
      progress: (m) => send({ t: "progress", m }),
    },
  });
  await bridge.start();
  const port = c.port || 3917;
  let base: string;
  if (c.tunnel === "cloudflare") {
    tunnel = new Tunnel(dataDir, log);
    send({ t: "status", s: "starting", detail: "准备 cloudflared（首次需下载）" });
    const bin = await tunnel.ensureBinary(c.cloudflaredPath || "", c.downloadMirror || "", (p) => send({ t: "status", s: "starting", detail: `下载 cloudflared ${p}%` }));
    send({ t: "status", s: "starting", detail: "正在建立 Cloudflare 隧道" });
    base = await tunnel.start(bin, port);
  } else if (c.tunnel === "ngrok") {
    if (!c.ngrokAuthtoken) throw new Error("还没设置 ngrok Authtoken：右键小球 → 设置 ngrok");
    ngrok = new Ngrok(path.join(dataDir, "ngrok"), log);
    send({ t: "status", s: "starting", detail: "准备 ngrok（首次需下载）" });
    const bin = await ngrok.ensureBinary(c.ngrokPath || "", (p) => send({ t: "status", s: "starting", detail: `下载 ngrok ${p}%` }));
    send({ t: "status", s: "starting", detail: "正在建立 ngrok 隧道" });
    base = await ngrok.start(bin, port, c.ngrokAuthtoken, c.ngrokDomain || "", "");
  } else {
    base = `http://127.0.0.1:${port}`;
  }
  const url = `${base.replace(/\/+$/, "")}${bridge.mcpPath}`;
  log(`MCP 地址: ${url}`);
  send({ t: "url", url });
  send({ t: "status", s: "on", detail: c.root });
}

main().catch((e) => { send({ t: "error", m: String(e?.message ?? e) }); log(String(e?.stack ?? e)); setTimeout(() => process.exit(1), 300); });
