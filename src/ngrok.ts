// ngrok tunnel: supports going through a local HTTP/SOCKS proxy (e.g. v2rayN 10808)
// and a fixed free domain (xxx.ngrok-free.app).
import { spawn, execFile, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";

function asset(): { url: string; zip: boolean; file: string } {
  const a = process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "386" : "amd64";
  const base = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable";
  if (process.platform === "win32") return { url: `${base}-windows-${a}.zip`, zip: true, file: "ngrok.exe" };
  if (process.platform === "darwin") return { url: `${base}-darwin-${a}.zip`, zip: true, file: "ngrok" };
  return { url: `${base}-linux-${a}.tgz`, zip: false, file: "ngrok" };
}

function download(url: string, dest: string, onProgress: (p: number) => void, depth = 0): Promise<void> {
  return new Promise((ok, bad) => {
    if (depth > 8) return bad(new Error("重定向过多"));
    const req = https.get(url, { headers: { "User-Agent": "lingo-bridge" }, timeout: 20000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), dest, onProgress, depth + 1).then(ok, bad);
      }
      if (res.statusCode !== 200) { res.resume(); return bad(new Error(`下载 ngrok 失败 HTTP ${res.statusCode}`)); }
      const total = Number(res.headers["content-length"] ?? 0);
      let got = 0, last = -1;
      const f = fs.createWriteStream(dest);
      res.on("data", (c: Buffer) => { got += c.length; if (total) { const p = Math.floor(got / total * 100); if (p !== last) { last = p; onProgress(p); } } });
      res.pipe(f);
      res.on("error", bad);
      f.on("finish", () => f.close(() => (got < 1_000_000 ? bad(new Error("ngrok 下载不完整")) : ok())));
      f.on("error", bad);
    });
    req.on("timeout", () => req.destroy(new Error("连接超时")));
    req.on("error", bad);
  });
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, bad) => execFile(cmd, args, { windowsHide: true, timeout: 120000 }, (e, so, se) => (e ? bad(new Error(se || e.message)) : ok(String(so)))));
}

/** Read the Windows system proxy (what v2rayN "自动配置系统代理" sets). Returns http://host:port or "". */
export async function systemProxy(): Promise<string> {
  if (process.platform !== "win32") return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const en = await run("reg", ["query", key, "/v", "ProxyEnable"]);
    if (!/0x1\b/.test(en)) return "";
    const sv = await run("reg", ["query", key, "/v", "ProxyServer"]);
    const m = sv.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (!m) return "";
    let v = m[1];
    if (v.includes("=")) { // per-protocol form: http=127.0.0.1:10808;https=...
      const parts = Object.fromEntries(v.split(";").map((x) => x.split("=") as [string, string]));
      v = parts.https || parts.http || parts.socks || "";
      if (!v) return "";
      if (parts.socks && !parts.https && !parts.http) return "socks5://" + v;
    }
    return /^\w+:\/\//.test(v) ? v : "http://" + v;
  } catch { return ""; }
}

export class Ngrok {
  private proc?: ChildProcess;
  public url?: string;
  constructor(private storageDir: string, private log: (s: string) => void) {}

  async ensureBinary(customPath: string, onProgress: (p: number) => void): Promise<string> {
    if (customPath) { if (!fs.existsSync(customPath)) throw new Error(`找不到 ngrok: ${customPath}`); return customPath; }
    const a = asset();
    const dest = path.join(this.storageDir, a.file);
    if (fs.existsSync(dest)) return dest;
    fs.mkdirSync(this.storageDir, { recursive: true });
    const arc = path.join(this.storageDir, a.zip ? "ngrok.zip" : "ngrok.tgz");
    this.log(`下载 ngrok: ${a.url}`);
    await download(a.url, arc, onProgress);
    if (process.platform === "win32") {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${arc.replace(/'/g, "''")}' -DestinationPath '${this.storageDir.replace(/'/g, "''")}' -Force`]);
    } else if (a.zip) {
      await run("unzip", ["-o", arc, "-d", this.storageDir]);
    } else {
      await run("tar", ["-xzf", arc, "-C", this.storageDir]);
    }
    try { fs.unlinkSync(arc); } catch {}
    if (!fs.existsSync(dest)) throw new Error("ngrok 解压失败");
    if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
    return dest;
  }

  start(bin: string, port: number, authtoken: string, domain: string, proxy: string): Promise<string> {
    this.stop();
    const cfgFile = path.join(this.storageDir, "ngrok.yml");
    const lines = ['version: "2"', `authtoken: ${authtoken}`];
    if (proxy) lines.push(`proxy_url: ${proxy}`);
    fs.mkdirSync(this.storageDir, { recursive: true });
    fs.writeFileSync(cfgFile, lines.join("\n") + "\n", { mode: 0o600 });
    const args = ["http", `127.0.0.1:${port}`, "--config", cfgFile, "--log", "stdout", "--log-format", "json"];
    if (domain) args.push("--url", domain.replace(/^https?:\/\//, "").replace(/\/+$/, ""));
    this.log(`启动 ngrok${proxy ? `（经代理 ${proxy}）` : "（直连）"}${domain ? `，固定域名 ${domain}` : ""}`);
    return new Promise((ok, bad) => {
      const env = { ...process.env }; for (const k of ["http_proxy","https_proxy","HTTP_PROXY","HTTPS_PROXY","all_proxy","ALL_PROXY"]) delete env[k];
      const p = spawn(bin, args, { windowsHide: true, env: proxy ? process.env : env });
      this.proc = p;
      let done = false, lastErr = "";
      const timer = setTimeout(() => { if (!done) { done = true; bad(new Error("60 秒内没拿到 ngrok 地址。" + (lastErr || "请检查网络/代理"))); } }, 60_000);
      let buf = "";
      const onData = (d: Buffer) => {
        buf += d.toString();
        const ls = buf.split(/\r?\n/); buf = ls.pop() ?? "";
        for (const l of ls) {
          if (!l.trim()) continue;
          let j: any; try { j = JSON.parse(l); } catch { this.log("[ngrok] " + l); continue; }
          if (j.lvl === "eror" || j.lvl === "crit" || j.err) { lastErr = String(j.err || j.msg); this.log(`[ngrok] 错误: ${lastErr}`); }
          if (j.url && /^https:\/\//.test(j.url) && !done) {
            done = true; clearTimeout(timer); this.url = j.url; this.log(`[ngrok] 隧道地址: ${j.url}`); ok(j.url);
          }
        }
      };
      p.stdout?.on("data", onData);
      p.stderr?.on("data", (d: Buffer) => { const s = d.toString().trim(); if (s) { lastErr = s; this.log("[ngrok] " + s); } });
      p.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); bad(e); } });
      p.on("exit", (code) => {
        this.log(`ngrok 已退出 (code ${code})`);
        this.url = undefined;
        if (!done) { done = true; clearTimeout(timer); bad(new Error(`ngrok 退出 (code ${code})：${lastErr || "未知错误"}`)); }
      });
    });
  }

  stop() {
    if (this.proc && !this.proc.killed) { try { this.proc.kill(); } catch {} }
    this.proc = undefined; this.url = undefined;
  }
}
