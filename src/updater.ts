// Self-updater: checks the user's (possibly private) GitHub repo for a newer
// package.json version and installs release/lingo-bridge-<ver>.vsix.
// Uses the GitHub account the user signed into inside VS Code.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const API = "https://api.github.com";
const DEFAULT_REPOS = "1684523410/-, 1684523410/lingo-bridge, 1684523410/my-";

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

async function gh(url: string, token: string, raw = false): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60000);
  try {
    return await fetch(url, {
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "lingo-bridge",
        Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
      },
    });
  } finally { clearTimeout(t); }
}

const MIRRORS = ["", "https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/"];

async function fetchRaw(repo: string, file: string, token?: string): Promise<Buffer | undefined> {
  // 1) public repo: raw.githubusercontent.com directly or via China mirrors (no login needed)
  for (const pre of MIRRORS) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), file.endsWith(".vsix") ? 90000 : 12000);
      const r = await fetch(`${pre}https://raw.githubusercontent.com/${repo}/main/${file}?t=${Date.now()}`, { signal: ctl.signal, headers: { "User-Agent": "lingo-bridge" } }).finally(() => clearTimeout(t));
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (r.status === 404 && !pre) break; // not public / not there
    } catch { /* try next mirror */ }
  }
  // 2) private repo: GitHub API with the VS Code GitHub sign-in
  if (token) {
    const r = await gh(`${API}/repos/${repo}/contents/${file}`, token, true);
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  }
  return undefined;
}

export async function checkForUpdate(ctx: vscode.ExtensionContext, log: (s: string) => void, manual: boolean) {
  const c = vscode.workspace.getConfiguration("lingoBridge");
  if (!manual && !c.get<boolean>("autoUpdate", true)) return;
  const repos = c.get<string>("updateRepo", DEFAULT_REPOS)
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const r of DEFAULT_REPOS.split(",").map((s) => s.trim())) if (!repos.includes(r)) repos.push(r);
  const current: string = ctx.extension.packageJSON.version;

  let token: string | undefined;
  try { token = (await vscode.authentication.getSession("github", ["repo"], { silent: true }))?.accessToken; } catch { /* optional */ }

  for (const repo of repos) {
    try {
      const pj = await fetchRaw(repo, "package.json", token);
      if (!pj) { log(`更新检查：读不到仓库 ${repo}，试下一个`); continue; }
      const latest: string = JSON.parse(pj.toString("utf8")).version;
      log(`更新检查：当前 ${current}，仓库 ${repo} 最新 ${latest}`);
      if (!newer(latest, current)) {
        if (manual) vscode.window.showInformationMessage(`灵桥已是最新版 (${current})。`);
        return;
      }
      const buf = await fetchRaw(repo, `release/lingo-bridge-${latest}.vsix`, token);
      if (!buf || buf.length < 10000) throw new Error("安装包下载失败或不完整");
      const file = path.join(os.tmpdir(), `lingo-bridge-${latest}.vsix`);
      fs.writeFileSync(file, buf);
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(file));
      log(`已安装灵桥 ${latest}`);
      const pick = await vscode.window.showInformationMessage(`灵桥已更新到 ${latest}，重新加载窗口后生效。`, "立即重新加载", "稍后");
      if (pick === "立即重新加载") await vscode.commands.executeCommand("workbench.action.reloadWindow");
      return;
    } catch (e: any) {
      log(`更新检查失败 (${repo}): ${e?.message ?? e}`);
      if (manual) vscode.window.showErrorMessage(`灵桥检查更新失败: ${e?.message ?? e}`);
      return;
    }
  }
  if (manual) vscode.window.showWarningMessage("灵桥：连不上更新仓库，请稍后再试。");
}
