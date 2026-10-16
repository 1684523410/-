using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace LingoBall
{
    /// <summary>Finds/downloads node.exe and runs lingo-agent.js, talking JSON lines over stdio.</summary>
    class AgentHost
    {
        public const string NodeVersion = "v20.18.0";
        static readonly string[] NodeUrls =
        {
            "https://npmmirror.com/mirrors/node/" + NodeVersion + "/win-x64/node.exe",
            "https://cdn.npmmirror.com/binaries/node/" + NodeVersion + "/win-x64/node.exe",
            "https://mirrors.huaweicloud.com/nodejs/" + NodeVersion + "/win-x64/node.exe",
            "https://nodejs.org/dist/" + NodeVersion + "/win-x64/node.exe",
        };
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        Process proc;
        readonly SynchronizationContext ui;
        public event Action<Dictionary<string, object>> Event;   // raised on UI thread
        public event Action<int> Exited;                          // raised on UI thread
        public bool Running => proc != null && !proc.HasExited;

        public AgentHost(SynchronizationContext ui) { this.ui = ui; }

        void Post(Action a) => ui.Post(_ => { try { a(); } catch (Exception e) { Log.Write("事件处理出错: " + e); } }, null);

        public static string AgentScript => Path.Combine(Paths.AppDir, "lingo-agent.js");

        public static string FindNode()
        {
            var candidates = new List<string>
            {
                Path.Combine(Paths.AppDir, "node", "node.exe"),
                Path.Combine(Paths.AppDir, "node.exe"),
                Path.Combine(Paths.NodeDir, "node.exe"),
            };
            foreach (var c in candidates) if (File.Exists(c)) return c;
            // A system Node >= 18 also works
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                try
                {
                    var p = Path.Combine(dir.Trim().Trim('"'), "node.exe");
                    if (File.Exists(p) && NodeMajor(p) >= 18) return p;
                }
                catch { }
            }
            return null;
        }

        static int NodeMajor(string exe)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, "--version") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
                using (var p = Process.Start(psi))
                {
                    var v = p.StandardOutput.ReadToEnd().Trim().TrimStart('v');
                    p.WaitForExit(3000);
                    return int.Parse(v.Split('.')[0]);
                }
            }
            catch { return 0; }
        }

        /// <summary>Download node.exe to %LOCALAPPDATA%\LingoBall\node. progress: 0..100</summary>
        public static async Task<string> DownloadNode(Action<int> progress)
        {
            var dest = Path.Combine(Paths.NodeDir, "node.exe");
            var tmp = dest + ".download";
            Exception last = null;
            foreach (var url in NodeUrls)
            {
                try
                {
                    Log.Write("下载 Node 运行环境: " + url);
                    var req = (HttpWebRequest)WebRequest.Create(url);
                    req.UserAgent = "LingoBall";
                    req.Timeout = 20000;
                    req.ReadWriteTimeout = 30000;
                    using (var resp = (HttpWebResponse)await req.GetResponseAsync())
                    using (var s = resp.GetResponseStream())
                    using (var f = File.Create(tmp))
                    {
                        long total = resp.ContentLength, got = 0;
                        var buf = new byte[81920];
                        int n, lastPct = -1;
                        while ((n = await s.ReadAsync(buf, 0, buf.Length)) > 0)
                        {
                            await f.WriteAsync(buf, 0, n);
                            got += n;
                            if (total > 0) { var pct = (int)(got * 100 / total); if (pct != lastPct) { lastPct = pct; progress(pct); } }
                        }
                        if (got < 20_000_000) throw new Exception("下载的文件不完整（" + got + " 字节）");
                    }
                    if (File.Exists(dest)) File.Delete(dest);
                    File.Move(tmp, dest);
                    Log.Write("Node 下载完成");
                    return dest;
                }
                catch (Exception e)
                {
                    last = e;
                    Log.Write("  失败: " + e.Message + "，换下一个地址…");
                    try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                }
            }
            throw new Exception("Node 运行环境下载失败：" + last?.Message + "\n可以手动下载 node.exe 放到 " + Paths.NodeDir);
        }

        public void Start(string nodeExe, Config cfg)
        {
            Stop();
            if (!File.Exists(AgentScript)) throw new Exception("找不到 lingo-agent.js，请确认它和 LingoBall.exe 在同一个文件夹。");
            File.WriteAllText(Paths.AgentConfigFile, cfg.AgentJson(), new UTF8Encoding(false));
            var psi = new ProcessStartInfo(nodeExe, "\"" + AgentScript + "\" \"" + Paths.AgentConfigFile + "\"")
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = Directory.Exists(cfg.Root) ? cfg.Root : Paths.Local,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            p.OutputDataReceived += (s, e) =>
            {
                if (e.Data == null) return;
                Dictionary<string, object> ev;
                try { ev = Json.Deserialize<Dictionary<string, object>>(e.Data); }
                catch { var raw = e.Data; Post(() => Log.Write(raw)); return; }
                Post(() => Event?.Invoke(ev));
            };
            p.ErrorDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) { var d = e.Data; Post(() => Log.Write("[agent] " + d)); } };
            p.Exited += (s, e) => { int code = 0; try { code = p.ExitCode; } catch { } Post(() => { if (proc == p) proc = null; Exited?.Invoke(code); }); };
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            proc = p;
            // The agent reads its config at startup; don't leave the secrets on disk.
            Task.Delay(8000).ContinueWith(_ => { try { File.Delete(Paths.AgentConfigFile); } catch { } });
        }

        public void Send(object msg)
        {
            var p = proc;
            if (p == null || p.HasExited) return;
            try
            {
                var bytes = Encoding.UTF8.GetBytes(Json.Serialize(msg) + "\n");
                p.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
                p.StandardInput.BaseStream.Flush();
            }
            catch (Exception e) { Log.Write("发送给 agent 失败: " + e.Message); }
        }

        public void Stop()
        {
            var p = proc;
            proc = null;
            if (p == null) return;
            try
            {
                if (!p.HasExited)
                {
                    Send2(p, "{\"t\":\"stop\"}\n");
                    if (!p.WaitForExit(3000)) KillTree(p.Id);
                }
            }
            catch { try { KillTree(p.Id); } catch { } }
        }

        static void Send2(Process p, string s)
        {
            try { var b = Encoding.UTF8.GetBytes(s); p.StandardInput.BaseStream.Write(b, 0, b.Length); p.StandardInput.BaseStream.Flush(); } catch { }
        }

        static void KillTree(int pid)
        {
            try
            {
                var k = Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + pid) { CreateNoWindow = true, UseShellExecute = false });
                k?.WaitForExit(5000);
            }
            catch { }
        }
    }
}
