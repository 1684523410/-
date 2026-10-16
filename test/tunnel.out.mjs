// src/tunnel.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { spawn } from "node:child_process";
function binName() {
  const p = process.platform, a = process.arch;
  if (p === "win32") return { file: "cloudflared.exe", asset: a === "arm64" ? "cloudflared-windows-arm64.exe" : "cloudflared-windows-amd64.exe" };
  if (p === "darwin") return { file: "cloudflared", asset: a === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz" };
  return { file: "cloudflared", asset: a === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64" };
}
function download(url, dest, onProgress, depth = 0) {
  return new Promise((ok, bad) => {
    if (depth > 8) return bad(new Error("\u91CD\u5B9A\u5411\u8FC7\u591A"));
    https.get(url, { headers: { "User-Agent": "shun-bridge" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), dest, onProgress, depth + 1).then(ok, bad);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return bad(new Error(`\u4E0B\u8F7D\u5931\u8D25 HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers["content-length"] ?? 0);
      let got = 0, last = -1;
      const tmp = dest + ".part";
      const f = fs.createWriteStream(tmp);
      res.on("data", (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor(got / total * 100);
          if (pct !== last) {
            last = pct;
            onProgress(pct);
          }
        }
      });
      res.pipe(f);
      f.on("finish", () => f.close(() => {
        fs.renameSync(tmp, dest);
        ok();
      }));
      f.on("error", bad);
    }).on("error", bad);
  });
}
var Tunnel = class {
  constructor(storageDir, log) {
    this.storageDir = storageDir;
    this.log = log;
  }
  storageDir;
  log;
  proc;
  url;
  /** Find or download cloudflared. customPath wins if set. */
  async ensureBinary(customPath, mirrorPrefix, onProgress) {
    if (customPath) {
      if (!fs.existsSync(customPath)) throw new Error(`\u627E\u4E0D\u5230 cloudflared: ${customPath}`);
      return customPath;
    }
    const { file, asset } = binName();
    const dest = path.join(this.storageDir, file);
    if (fs.existsSync(dest)) return dest;
    if (asset.endsWith(".tgz")) throw new Error("macOS \u8BF7\u5148\u7528 brew install cloudflared\uFF0C\u518D\u5728\u8BBE\u7F6E\u91CC\u586B\u5199\u8DEF\u5F84");
    fs.mkdirSync(this.storageDir, { recursive: true });
    const base = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
    const url = mirrorPrefix ? mirrorPrefix.replace(/\/?$/, "/") + base : base;
    this.log(`\u4E0B\u8F7D cloudflared: ${url}`);
    await download(url, dest, onProgress);
    if (process.platform !== "win32") fs.chmodSync(dest, 493);
    return dest;
  }
  start(bin, port) {
    this.stop();
    return new Promise((ok, bad) => {
      const args = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
      const p = spawn(bin, args, { windowsHide: true });
      this.proc = p;
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          bad(new Error("60 \u79D2\u5185\u6CA1\u62FF\u5230\u96A7\u9053\u5730\u5740\uFF0C\u53EF\u80FD\u7F51\u7EDC\u8FDE\u4E0D\u4E0A Cloudflare"));
        }
      }, 6e4);
      const onData = (d) => {
        const s = d.toString();
        s.split(/\r?\n/).filter(Boolean).forEach((l) => this.log("[cloudflared] " + l));
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && !done) {
          done = true;
          clearTimeout(timer);
          this.url = m[0];
          ok(m[0]);
        }
      };
      p.stdout?.on("data", onData);
      p.stderr?.on("data", onData);
      p.on("error", (e) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          bad(e);
        }
      });
      p.on("exit", (code) => {
        this.log(`cloudflared \u5DF2\u9000\u51FA (code ${code})`);
        this.url = void 0;
        if (!done) {
          done = true;
          clearTimeout(timer);
          bad(new Error(`cloudflared \u9000\u51FA\uFF0Ccode ${code}`));
        }
      });
    });
  }
  stop() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
      }
    }
    this.proc = void 0;
    this.url = void 0;
  }
};
export {
  Tunnel
};
