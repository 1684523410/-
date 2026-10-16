using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Collections.Generic;

namespace LingoBall
{
    /// <summary>Checks lingo-ball/version.json in the public GitHub repo (with China mirrors) and self-updates.</summary>
    static class Updater
    {
        static readonly string[] Repos = { "1684523410/-", "1684523410/lingo-bridge", "1684523410/my-" };
        static readonly string[] Prefixes = { "", "https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/" };
        public class Info { public string Version, Zip, Notes, Repo, Prefix; }

        static string Raw(string prefix, string repo, string path) => prefix + "https://raw.githubusercontent.com/" + repo + "/main/" + path;

        static async Task<byte[]> Get(string url, int timeoutMs, Action<int> progress = null)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = "LingoBall";
            req.Timeout = timeoutMs; req.ReadWriteTimeout = timeoutMs;
            req.Headers["Cache-Control"] = "no-cache";
            using (var resp = (HttpWebResponse)await req.GetResponseAsync())
            using (var s = resp.GetResponseStream())
            using (var ms = new MemoryStream())
            {
                var buf = new byte[65536]; int n; long total = resp.ContentLength; int last = -1;
                while ((n = await s.ReadAsync(buf, 0, buf.Length)) > 0)
                {
                    ms.Write(buf, 0, n);
                    if (progress != null && total > 0) { var p = (int)(ms.Length * 100 / total); if (p != last) { last = p; progress(p); } }
                }
                return ms.ToArray();
            }
        }

        public static int Compare(string a, string b)
        {
            var x = a.Split('.'); var y = b.Split('.');
            for (int i = 0; i < Math.Max(x.Length, y.Length); i++)
            {
                int.TryParse(i < x.Length ? x[i] : "0", out var p); int.TryParse(i < y.Length ? y[i] : "0", out var q);
                if (p != q) return p.CompareTo(q);
            }
            return 0;
        }

        /// <summary>Returns info when a newer version exists, null when up to date. Throws when nothing was reachable.</summary>
        public static async Task<Info> Check()
        {
            Exception last = null;
            foreach (var pre in Prefixes)
                foreach (var repo in Repos)
                {
                    try
                    {
                        var bytes = await Get(Raw(pre, repo, "lingo-ball/version.json") + "?t=" + DateTime.UtcNow.Ticks, 10000);
                        var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF'));
                        var info = new Info
                        {
                            Version = d["version"] as string, Zip = d["zip"] as string,
                            Notes = d.TryGetValue("notes", out var n) ? n as string : "", Repo = repo, Prefix = pre,
                        };
                        Log.Write("更新检查: 当前 " + Controller.Version + "，最新 " + info.Version + (pre != "" ? "（经镜像）" : ""));
                        return Compare(info.Version, Controller.Version) > 0 ? info : null;
                    }
                    catch (Exception e) { last = e; }
                }
            throw new Exception("连不上更新服务器（仓库可能还没公开）：" + last?.Message);
        }

        /// <summary>Download the zip, then hand over to a PowerShell script that swaps files after we exit and relaunches.</summary>
        public static async Task DownloadAndApply(Info info, Action<int> progress)
        {
            byte[] zip = null; Exception last = null;
            var prefixes = new List<string> { info.Prefix }; prefixes.AddRange(Prefixes);
            foreach (var pre in prefixes)
            {
                try { zip = await Get(Raw(pre, info.Repo, info.Zip), 60000, progress); if (zip.Length > 100_000) break; zip = null; }
                catch (Exception e) { last = e; Log.Write("  下载失败: " + e.Message + "，换镜像…"); }
            }
            if (zip == null) throw new Exception("新版本下载失败：" + last?.Message);

            var dir = Path.Combine(Paths.Local, "update");
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.CreateDirectory(dir);
            var zipPath = Path.Combine(dir, "update.zip");
            File.WriteAllBytes(zipPath, zip);

            var app = Paths.AppDir.TrimEnd('\\');
            var exe = Path.Combine(app, "LingoBall.exe");
            var ps1 = Path.Combine(dir, "apply.ps1");
            string Q(string s) => "'" + s.Replace("'", "''") + "'";
            var script = new StringBuilder();
            script.AppendLine("$ErrorActionPreference = 'Stop'");
            script.AppendLine("try { Wait-Process -Id " + Process.GetCurrentProcess().Id + " -Timeout 30 -ErrorAction SilentlyContinue } catch {}");
            script.AppendLine("Start-Sleep -Milliseconds 500");
            script.AppendLine("$x = Join-Path " + Q(dir) + " 'x'");
            script.AppendLine("Expand-Archive -LiteralPath " + Q(zipPath) + " -DestinationPath $x -Force");
            script.AppendLine("$src = Join-Path $x 'LingoBall'; if (-not (Test-Path $src)) { $src = $x }");
            script.AppendLine("Copy-Item -Path (Join-Path $src '*') -Destination " + Q(app) + " -Recurse -Force");
            script.AppendLine("Start-Process -FilePath " + Q(exe));
            File.WriteAllText(ps1, "try {\r\n" + script + "} catch { Add-Content -Path " + Q(Path.Combine(dir, "error.txt")) + " -Value $_; Start-Process -FilePath " + Q(exe) + " }\r\n", new UTF8Encoding(true));

            Log.Write("新版本 " + info.Version + " 已下载，重启更新…");
            Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + ps1 + "\"")
            { CreateNoWindow = true, UseShellExecute = false, WorkingDirectory = dir });
        }
    }
}
