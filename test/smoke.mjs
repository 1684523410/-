import core from "./core.cjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const { Bridge } = core;
const token = "testtoken123";
const b = new Bridge({ root: process.argv[2] || "/tmp/ws", port: 3917, token, allowWrite: true, allowCommand: true, approveWrite: false, approveCommand: true, commandTimeoutSec: 10,
  host: { approve: async (k, s) => { console.log("APPROVE?", k, s); return true; }, log: (s) => console.log("LOG", s), progress: (m) => console.log("PROGRESS", m) } });
await b.start();
const base = process.argv[3] || "http://127.0.0.1:3917";
// unauthorized check
const r = await fetch(base + "/mcp/wrong", { method: "POST", headers: {"content-type":"application/json"}, body: "{}" });
console.log("unauth status", r.status);
const c = new Client({ name: "t", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp/" + token)));
const tools = await c.listTools();
console.log("TOOLS", tools.tools.map(t => t.name).join(","));
const call = async (name, args) => { const res = await c.callTool({ name, arguments: args }); console.log(`== ${name}`, res.isError ? "ERR" : "", res.content[0].text.slice(0, 400)); };
await call("list_directory", {});
await call("find_files", { pattern: "**/*.txt" });
await call("search_text", { query: "FOO" });
await call("read_file", { path: "src/a.txt" });
await call("edit_file", { path: "src/a.txt", old_text: "foo bar", new_text: "foo baz" });
await call("write_file", { path: "new/b.md", content: "# hi" });
await call("move_path", { from: "new/b.md", to: "new/c.md" });
await call("run_command", { command: "ls -R && cat src/a.txt" });
await call("run_command", { command: "sleep 30", timeout_sec: 2 });
await call("read_file", { path: "../etc/passwd" });
await call("delete_path", { path: "new" });
await call("report_progress", { message: "half done" });
await c.close();
// bearer header route
const c2 = new Client({ name: "t2", version: "1" });
await c2.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
console.log("bearer tools", (await c2.listTools()).tools.length);
await c2.close();
if (!process.argv[4]) { await b.stop(); process.exit(0); }
