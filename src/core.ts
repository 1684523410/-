// 灵桥 Lingo Bridge core: an MCP server (Streamable HTTP) exposing a local workspace.
// No dependency on the vscode module, so it can be tested with plain Node.
import * as http from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import fg from "fast-glob";
import { shortInstructions, fullGuide, readProjectRules } from "./guide";

export interface Host {
  /** Ask the user to approve a risky action. Resolve true to allow. */
  approve(kind: "write" | "command", summary: string): Promise<boolean>;
  log(line: string): void;
  /** Optional editor diagnostics (errors/warnings). */
  diagnostics?(relPath?: string): Promise<string>;
  /** Optional: open a file in the editor. */
  openFile?(absPath: string, line?: number): Promise<void>;
  /** Optional: progress note from the AI, shown to the user. */
  progress?(text: string): void;
}

export interface BridgeOptions {
  root: string;
  port: number;
  token: string;
  allowWrite: boolean;
  allowCommand: boolean;
  approveWrite: boolean;
  approveCommand: boolean;
  commandTimeoutSec: number;
  host: Host;
}

export const VERSION = "0.4.2";
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**", "**/build/**", "**/.venv/**", "**/__pycache__/**"];
const MAX_READ = 200_000; // chars per file read
const MAX_OUT = 60_000; // chars of command output

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function fail(s: string) {
  return { content: [{ type: "text" as const, text: "错误: " + s }], isError: true };
}
function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + `\n…[已截断，共 ${s.length} 字符]` : s;
}

export class Bridge {
  private server?: http.Server;
  constructor(private o: BridgeOptions) {}

  /** Resolve a user path inside the workspace root; throw if it escapes. */
  resolve(p: string): string {
    const root = path.resolve(this.o.root);
    const abs = path.resolve(root, p || ".");
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`路径超出工作区: ${p}`);
    return abs;
  }
  rel(abs: string) {
    return path.relative(this.o.root, abs).split(path.sep).join("/") || ".";
  }

  buildMcp(): McpServer {
    const o = this.o;
    const mcp = new McpServer({ name: "lingo-bridge", version: VERSION }, {
      instructions: shortInstructions(o.root, { allowWrite: o.allowWrite, allowCommand: o.allowCommand }),
    });

    const guard = async <T>(name: string, args: unknown, fn: () => Promise<T>) => {
      o.host.log(`→ ${name} ${JSON.stringify(args).slice(0, 300)}`);
      try {
        const r = await fn();
        return r;
      } catch (e: any) {
        o.host.log(`✗ ${name}: ${e?.message ?? e}`);
        return fail(e?.message ?? String(e)) as any;
      }
    };

    mcp.registerTool("get_usage_guide", {
      description: "【第一次使用必读】获取灵桥的完整使用说明：环境、推荐工作流程、规则、工具一览和本项目的规则文件。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => guard("get_usage_guide", {}, async () => text(fullGuide(o.root, { allowWrite: o.allowWrite, allowCommand: o.allowCommand }))));

    mcp.registerTool("get_workspace_info", {
      description: "获取工作区概况：系统、命令行、根目录文件、识别出的项目类型、git 分支、规则文件。了解新项目时先调用。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => guard("get_workspace_info", {}, async () => {
      const root = o.root;
      const top = (await fsp.readdir(root, { withFileTypes: true }).catch(() => []))
        .map((d) => (d.isDirectory() ? d.name + "/" : d.name)).sort().slice(0, 200);
      const has = (f: string) => fs.existsSync(path.join(root, f));
      const kinds: string[] = [];
      if (has("package.json")) {
        try {
          const pj = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
          kinds.push(`Node.js（${pj.name ?? ""}；scripts: ${Object.keys(pj.scripts ?? {}).join(", ") || "无"}）`);
        } catch { kinds.push("Node.js"); }
      }
      if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) kinds.push("Python");
      if (has("Cargo.toml")) kinds.push("Rust");
      if (has("go.mod")) kinds.push("Go");
      if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) kinds.push("Java/Kotlin");
      if (fg.sync("*.sln", { cwd: root }).length || fg.sync("*.csproj", { cwd: root }).length) kinds.push(".NET");
      if (has("index.html")) kinds.push("静态网页");
      let branch = "不是 git 仓库";
      try { const h = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim(); branch = h.startsWith("ref:") ? h.replace(/^ref: refs\/heads\//, "") : h.slice(0, 12); } catch {}
      const rules = readProjectRules(root);
      return text([
        `根目录: ${root}`,
        `系统: ${process.platform === "win32" ? "Windows（命令行 PowerShell）" : process.platform + "（bash）"}`,
        `项目类型: ${kinds.join("；") || "未识别（可能是空项目）"}`,
        `git 分支: ${branch}`,
        `规则文件: ${rules ? rules.file : "无"}`,
        `权限: 写入${o.allowWrite ? "开" : "关"}，命令${o.allowCommand ? "开" : "关"}，写入需审批${o.approveWrite ? "是" : "否"}，命令需审批${o.approveCommand ? "是" : "否"}`,
        `根目录内容:`,
        top.join("\n") || "(空)",
      ].join("\n"));
    }));

    mcp.registerTool("read_files", {
      description: "一次读取多个文件（最多 20 个），带行号。适合同时查看几个相关文件。",
      inputSchema: { paths: z.array(z.string()).min(1).max(20) },
      annotations: { readOnlyHint: true },
    }, async (a) => guard("read_files", a, async () => {
      const parts: string[] = [];
      let budget = MAX_READ;
      for (const p of a.paths) {
        try {
          const abs = this.resolve(p);
          const raw = await fsp.readFile(abs, "utf8");
          const lines = raw.split(/\r?\n/);
          let body = lines.map((l, i) => `${String(i + 1).padStart(5)}│${l}`).join("\n");
          if (body.length > budget) body = body.slice(0, Math.max(0, budget)) + "\n…[已截断，请用 read_file 分段读取]";
          budget -= body.length;
          parts.push(`===== ${this.rel(abs)} (共 ${lines.length} 行) =====\n${body}`);
        } catch (e: any) { parts.push(`===== ${p} =====\n错误: ${e?.message ?? e}`); }
        if (budget <= 0) { parts.push("…[总长度达到上限，剩余文件未读取]"); break; }
      }
      return text(parts.join("\n\n"));
    }));

    mcp.registerTool("list_directory", {
      description: "列出工作区内某个目录的内容（文件夹以 / 结尾）。path 默认为根目录。",
      inputSchema: { path: z.string().optional().describe("相对路径，默认 .") },
      annotations: { readOnlyHint: true },
    }, async (a) => guard("list_directory", a, async () => {
      const abs = this.resolve(a.path ?? ".");
      const items = await fsp.readdir(abs, { withFileTypes: true });
      const lines = items
        .sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name))
        .slice(0, 1000)
        .map((d) => (d.isDirectory() ? d.name + "/" : d.name));
      return text(`${this.rel(abs)}:\n` + (lines.join("\n") || "(空)"));
    }));

    mcp.registerTool("find_files", {
      description: "按 glob 模式查找文件，例如 **/*.ts 或 src/**/index.*。默认忽略 node_modules、.git 等。",
      inputSchema: { pattern: z.string(), limit: z.number().int().min(1).max(2000).optional() },
      annotations: { readOnlyHint: true },
    }, async (a) => guard("find_files", a, async () => {
      const files = await fg(a.pattern, { cwd: o.root, ignore: DEFAULT_IGNORE, dot: true, onlyFiles: true, suppressErrors: true });
      const lim = a.limit ?? 300;
      return text(files.slice(0, lim).join("\n") + (files.length > lim ? `\n…共 ${files.length} 个，仅显示 ${lim} 个` : "") || "没有匹配的文件");
    }));

    mcp.registerTool("search_text", {
      description: "在工作区文件中搜索文本或正则，返回 文件:行号: 内容。",
      inputSchema: {
        query: z.string(),
        regex: z.boolean().optional().describe("按正则搜索，默认 false"),
        case_sensitive: z.boolean().optional(),
        include: z.string().optional().describe("限定文件的 glob，默认 **/*"),
        max_results: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true },
    }, async (a) => guard("search_text", a, async () => {
      const flags = a.case_sensitive ? "" : "i";
      const re = a.regex ? new RegExp(a.query, flags) : new RegExp(a.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      const files = await fg(a.include ?? "**/*", { cwd: o.root, ignore: DEFAULT_IGNORE, dot: false, onlyFiles: true, suppressErrors: true });
      const max = a.max_results ?? 200;
      const out: string[] = [];
      for (const f of files) {
        if (out.length >= max) break;
        const abs = path.join(o.root, f);
        let st: fs.Stats;
        try { st = await fsp.stat(abs); } catch { continue; }
        if (st.size > 2_000_000) continue;
        let buf: Buffer;
        try { buf = await fsp.readFile(abs); } catch { continue; }
        if (buf.subarray(0, 8000).includes(0)) continue; // binary
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length && out.length < max; i++) {
          if (re.test(lines[i])) out.push(`${f}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
      }
      return text(out.join("\n") || "没有找到匹配");
    }));

    mcp.registerTool("read_file", {
      description: "读取文件内容，带行号。可用 start_line / end_line 只读一段（从 1 开始）。",
      inputSchema: { path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() },
      annotations: { readOnlyHint: true },
    }, async (a) => guard("read_file", a, async () => {
      const abs = this.resolve(a.path);
      const raw = await fsp.readFile(abs, "utf8");
      const lines = raw.split(/\r?\n/);
      const s = (a.start_line ?? 1) - 1;
      const e = Math.min(a.end_line ?? lines.length, lines.length);
      const body = lines.slice(s, e).map((l, i) => `${String(s + i + 1).padStart(5)}│${l}`).join("\n");
      return text(`${this.rel(abs)} (共 ${lines.length} 行，显示 ${s + 1}-${e})\n` + clip(body, MAX_READ));
    }));

    const checkWrite = async (summary: string) => {
      if (!o.allowWrite) throw new Error("用户在设置里关闭了写入权限");
      if (o.approveWrite && !(await o.host.approve("write", summary))) throw new Error("用户拒绝了这次修改");
    };

    mcp.registerTool("write_file", {
      description: "创建或整体覆盖一个文件（会自动创建上级目录）。小改动请用 edit_file。",
      inputSchema: { path: z.string(), content: z.string() },
      annotations: { destructiveHint: true },
    }, async (a) => guard("write_file", { path: a.path, bytes: a.content.length }, async () => {
      const abs = this.resolve(a.path);
      const existed = fs.existsSync(abs);
      await checkWrite(`${existed ? "覆盖" : "新建"} ${this.rel(abs)}（${a.content.length} 字符）`);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, a.content, "utf8");
      return text(`${existed ? "已覆盖" : "已新建"} ${this.rel(abs)}`);
    }));

    mcp.registerTool("edit_file", {
      description: "精确替换文件中的一段文本。old_text 必须与文件内容完全一致且唯一（除非 replace_all）。",
      inputSchema: { path: z.string(), old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional() },
      annotations: { destructiveHint: true },
    }, async (a) => guard("edit_file", { path: a.path }, async () => {
      const abs = this.resolve(a.path);
      let raw = await fsp.readFile(abs, "utf8");
      const crlf = raw.includes("\r\n");
      let oldT = a.old_text, newT = a.new_text;
      if (crlf && !oldT.includes("\r\n")) { oldT = oldT.replace(/\n/g, "\r\n"); newT = newT.replace(/\n/g, "\r\n"); }
      const count = raw.split(oldT).length - 1;
      if (count === 0) throw new Error("没找到 old_text，请先 read_file 确认原文");
      if (count > 1 && !a.replace_all) throw new Error(`old_text 出现了 ${count} 次，请加上下文让它唯一，或设 replace_all`);
      await checkWrite(`修改 ${this.rel(abs)}（替换 ${a.replace_all ? count : 1} 处）`);
      raw = a.replace_all ? raw.split(oldT).join(newT) : raw.replace(oldT, () => newT);
      await fsp.writeFile(abs, raw, "utf8");
      return text(`已修改 ${this.rel(abs)}，替换 ${a.replace_all ? count : 1} 处`);
    }));

    mcp.registerTool("delete_path", {
      description: "删除文件或文件夹（文件夹会递归删除）。",
      inputSchema: { path: z.string() },
      annotations: { destructiveHint: true },
    }, async (a) => guard("delete_path", a, async () => {
      const abs = this.resolve(a.path);
      if (abs === path.resolve(o.root)) throw new Error("不能删除工作区根目录");
      await checkWrite(`删除 ${this.rel(abs)}`);
      await fsp.rm(abs, { recursive: true, force: false });
      return text(`已删除 ${this.rel(abs)}`);
    }));

    mcp.registerTool("move_path", {
      description: "移动或重命名文件/文件夹。",
      inputSchema: { from: z.string(), to: z.string() },
      annotations: { destructiveHint: true },
    }, async (a) => guard("move_path", a, async () => {
      const from = this.resolve(a.from), to = this.resolve(a.to);
      await checkWrite(`移动 ${this.rel(from)} → ${this.rel(to)}`);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      return text(`已移动 ${this.rel(from)} → ${this.rel(to)}`);
    }));

    mcp.registerTool("run_command", {
      description: `在工作区里运行一条命令并返回输出。Windows 下用 PowerShell，其他系统用 bash/sh。超时默认 ${o.commandTimeoutSec} 秒。不要运行需要交互输入的命令；长期运行的服务请加 background:true。`,
      inputSchema: {
        command: z.string(),
        cwd: z.string().optional().describe("相对工作区的目录，默认根目录"),
        timeout_sec: z.number().int().min(1).max(3600).optional(),
        background: z.boolean().optional().describe("后台启动，不等待结束（用于开发服务器等）"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    }, async (a) => guard("run_command", a, async () => {
      if (!o.allowCommand) throw new Error("用户在设置里关闭了运行命令权限");
      const cwd = this.resolve(a.cwd ?? ".");
      if (o.approveCommand && !(await o.host.approve("command", `${a.command}\n（目录: ${this.rel(cwd)}）`))) throw new Error("用户拒绝运行这条命令");
      return text(await runShell(a.command, cwd, (a.timeout_sec ?? o.commandTimeoutSec) * 1000, !!a.background));
    }));

    if (o.host.diagnostics) {
      mcp.registerTool("get_diagnostics", {
        description: "获取编辑器里的错误和警告（来自 VS Code 语言服务）。可指定文件，默认整个工作区。",
        inputSchema: { path: z.string().optional() },
        annotations: { readOnlyHint: true },
      }, async (a) => guard("get_diagnostics", a, async () => text(await o.host.diagnostics!(a.path))));
    }
    if (o.host.openFile) {
      mcp.registerTool("open_in_editor", {
        description: "在用户的 VS Code 里打开文件，方便用户查看。",
        inputSchema: { path: z.string(), line: z.number().int().min(1).optional() },
      }, async (a) => guard("open_in_editor", a, async () => {
        await o.host.openFile!(this.resolve(a.path), a.line);
        return text("已在编辑器中打开");
      }));
    }
    if (o.host.progress) {
      mcp.registerTool("report_progress", {
        description: "把当前进度告诉用户（会显示在 VS Code 里）。长任务每完成一个阶段调用一次。",
        inputSchema: { message: z.string() },
      }, async (a) => { o.host.progress!(a.message); return text("ok"); });
    }
    return mcp;
  }

  get mcpPath() { return `/mcp/${this.o.token}`; }

  async start(): Promise<void> {
    if (this.server) return;
    const srv = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        // CORS for browser-based clients
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
        if (url.pathname === "/health") { res.writeHead(200, { "content-type": "text/plain" }).end("ok"); return; }

        const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        const okPath = url.pathname === this.mcpPath || url.pathname === this.mcpPath + "/";
        const okHeader = (url.pathname === "/mcp" || url.pathname === "/mcp/") && bearer === this.o.token;
        if (!okPath && !okHeader) { res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized"); return; }

        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json", Allow: "POST" })
            .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }));
          return;
        }
        const body = await readBody(req);
        // Stateless: a fresh server+transport per request.
        const mcp = this.buildMcp();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { transport.close(); mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e: any) {
        this.o.host.log("HTTP 错误: " + (e?.stack ?? e));
        if (!res.headersSent) res.writeHead(500).end("internal error");
      }
    });
    await new Promise<void>((ok, bad) => {
      srv.once("error", bad);
      srv.listen(this.o.port, "127.0.0.1", () => ok());
    });
    this.server = srv;
    this.o.host.log(`本地 MCP 服务已启动: http://127.0.0.1:${this.o.port}${this.mcpPath}`);
  }

  async stop() {
    const s = this.server; this.server = undefined;
    if (s) await new Promise<void>((ok) => s.close(() => ok()));
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((ok, bad) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 20_000_000) { bad(new Error("请求体过大")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      try { ok(s ? JSON.parse(s) : undefined); } catch (e) { bad(e); }
    });
    req.on("error", bad);
  });
}

export function runShell(command: string, cwd: string, timeoutMs: number, background: boolean): Promise<string> {
  const win = process.platform === "win32";
  const file = win ? "powershell.exe" : (fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  const args = win
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
       "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; " + command]
    : ["-lc", command];
  return new Promise((ok) => {
    const child = spawn(file, args, { cwd, env: process.env, windowsHide: true, detached: background && !win });
    if (background) {
      let early = "";
      child.stdout?.on("data", (d) => { early += d; });
      child.stderr?.on("data", (d) => { early += d; });
      child.unref();
      setTimeout(() => ok(`已在后台启动 (pid ${child.pid})。前 3 秒输出:\n${clip(early, 8000) || "(无)"}`), 3000);
      return;
    }
    let out = "";
    const add = (d: Buffer) => { out += d.toString("utf8"); if (out.length > MAX_OUT * 2) out = out.slice(-MAX_OUT * 2); };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(t); ok(`启动失败: ${e.message}`); });
    child.on("close", (code) => {
      clearTimeout(t);
      const head = timedOut ? `超时（${timeoutMs / 1000}s）已终止` : `退出码 ${code}`;
      ok(`${head}\n${clip(out.length > MAX_OUT ? "…" + out.slice(-MAX_OUT) : out, MAX_OUT + 100) || "(无输出)"}`);
    });
  });
}

function killTree(pid?: number) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch { /* ignore */ }
}
