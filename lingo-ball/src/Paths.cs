using System;
using System.IO;

namespace LingoBall
{
    static class Paths
    {
        public static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory;
        public static readonly string Roaming = Ensure(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LingoBall"));
        public static readonly string Local = Ensure(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LingoBall"));
        public static string ConfigFile => Path.Combine(Roaming, "config.json");
        public static string AgentConfigFile => Path.Combine(Local, "agent-config.json");
        public static string BinDir => Ensure(Path.Combine(Local, "bin"));
        public static string NodeDir => Ensure(Path.Combine(Local, "node"));
        public static string WebViewData => Ensure(Path.Combine(Local, "webview"));
        public static string LogFile => Path.Combine(Local, "lingo-ball.log");
        static string Ensure(string p) { Directory.CreateDirectory(p); return p; }
    }

    static class Log
    {
        static readonly object L = new object();
        public static event Action<string> Line;
        public static void Write(string s)
        {
            var line = "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + s;
            lock (L)
            {
                try
                {
                    var fi = new FileInfo(Paths.LogFile);
                    if (fi.Exists && fi.Length > 2_000_000) fi.Delete();
                    File.AppendAllText(Paths.LogFile, line + Environment.NewLine);
                }
                catch { }
            }
            try { Line?.Invoke(line); } catch { }
        }
    }
}
