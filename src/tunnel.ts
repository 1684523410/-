// Cloudflare quick tunnel manager: downloads cloudflared if needed and exposes a local port.
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { spawn, ChildProcess } from "node:child_process";

function binName() {
  const p = process.platform, a = process.arch;
  if (p === "win32") return { file: "cloudflared.exe", asset: a === "arm64" ? "cloudflared-windows-arm64.exe" : "cloudflared-windows-amd64.exe" };
  if (p === "darwin") return { file: "cloudflared", asset: a === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz" };
  return { file: "cloudflared", asset: a === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64" };
}

function download(url: string, dest: string, onProgress: (pct: number) => void, depth = 0): Promise<void> {
  return new Promise((ok, bad) => {
    if (depth > 8) return bad(new Error("重定向过多"));
    const req = https.get(url, { headers: { "User-Agent": "lingo-bridge" }, timeout: 15000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), dest, onProgress, depth + 1).then(ok, bad);
      }
      if (res.statusCode !== 200) { res.resume(); return bad(new Error(`下载失败 HTTP ${res.statusCode}`)); }
      const total = Number(res.headers["content-length"] ?? 0);
      let got = 0, last = -1;
      const tmp = dest + ".part";
      const f = fs.createWriteStream(tmp);
      res.on("data", (c: Buffer) => {
        got += c.length;
        if (total) { const pct = Math.floor((got / total) * 100); if (pct !== last) { last = pct; onProgress(pct); } }
      });
      res.pipe(f);
      res.on("error", bad);
      f.on("finish", () => f.close(() => {
        if (got < 5_000_000) { try { fs.unlinkSync(tmp); } catch {} return bad(new Error(`文件不完整 (${got} 字节)`)); }
        fs.renameSync(tmp, dest); ok();
      }));
      f.on("error", bad);
    });
    req.on("timeout", () => req.destroy(new Error("连接超时")));
    req.on("error", bad);
  });
}

export class Tunnel {
  private proc?: ChildProcess;
  public url?: string;
  constructor(private storageDir: string, private log: (s: string) => void) {}

  /** Find or download cloudflared. customPath wins if set. */
  async ensureBinary(customPath: string, mirrorPrefix: string, onProgress: (pct: number) => void): Promise<string> {
    if (customPath) {
      if (!fs.existsSync(customPath)) throw new Error(`找不到 cloudflared: ${customPath}`);
      return customPath;
    }
    const { file, asset } = binName();
    const dest = path.join(this.storageDir, file);
    if (fs.existsSync(dest)) return dest;
    if (asset.endsWith(".tgz")) throw new Error("macOS 请先用 brew install cloudflared，再在设置里填写路径");
    fs.mkdirSync(this.storageDir, { recursive: true });
    const base = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
    // 国内直连 GitHub 常超时：依次尝试 用户镜像 → 直连 → 公共加速镜像
    const prefixes = [mirrorPrefix, "", "https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/", "https://gh.llkk.cc/"]
      .filter((x, i, a) => x !== undefined && a.indexOf(x) === i && (i > 0 || x));
    let lastErr: any;
    for (const pre of prefixes) {
      const url = pre ? pre.replace(/\/?$/, "/") + base : base;
      this.log(`下载 cloudflared: ${url}`);
      try { await download(url, dest, onProgress); lastErr = undefined; break; }
      catch (e: any) { lastErr = e; this.log(`  失败: ${e?.message ?? e}，换下一个地址…`); }
    }
    if (lastErr) throw new Error(`cloudflared 所有下载地址都失败了。可手动下载 cloudflared-windows-amd64.exe，然后在设置 lingoBridge.cloudflaredPath 填它的路径。最后错误: ${lastErr?.message ?? lastErr}`);
    if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
    return dest;
  }

  start(bin: string, port: number): Promise<string> {
    this.stop();
    return new Promise((ok, bad) => {
      const args = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
      const p = spawn(bin, args, { windowsHide: true });
      this.proc = p;
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; bad(new Error("60 秒内没拿到隧道地址，可能网络连不上 Cloudflare")); } }, 60_000);
      const onData = (d: Buffer) => {
        const s = d.toString();
        s.split(/\r?\n/).filter(Boolean).forEach((l) => this.log("[cloudflared] " + l));
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && !done) { done = true; clearTimeout(timer); this.url = m[0]; ok(m[0]); }
      };
      p.stdout?.on("data", onData);
      p.stderr?.on("data", onData);
      p.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); bad(e); } });
      p.on("exit", (code) => {
        this.log(`cloudflared 已退出 (code ${code})`);
        this.url = undefined;
        if (!done) { done = true; clearTimeout(timer); bad(new Error(`cloudflared 退出，code ${code}`)); }
      });
    });
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
    this.proc = undefined;
    this.url = undefined;
  }
}
