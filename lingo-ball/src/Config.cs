using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace LingoBall
{
    class Config
    {
        public string Root = "";
        public int Port = 3927;
        public string Token = "";
        public string Tunnel = "ngrok";
        public string NgrokAuthtoken = "";
        public string NgrokDomain = "";
        public bool AllowWrite = true, ApproveWrite = false, AllowCommand = true, ApproveCommand = true;
        public int CommandTimeoutSec = 120;
        public bool AutoConnect = true, ShowBall = true, AutoUpdate = true;
        public int BallX = -1, BallY = -1;
        public string DownloadMirror = "";

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public static Config Load()
        {
            Config c;
            try { c = File.Exists(Paths.ConfigFile) ? Json.Deserialize<Config>(File.ReadAllText(Paths.ConfigFile, Encoding.UTF8)) : new Config(); }
            catch (Exception e) { Log.Write("读取配置失败，使用默认: " + e.Message); c = new Config(); }
            if (c == null) c = new Config();
            if (string.IsNullOrEmpty(c.Token)) { c.Token = NewToken(); c.Save(); }
            return c;
        }

        public void Save()
        {
            try { File.WriteAllText(Paths.ConfigFile, Json.Serialize(this), new UTF8Encoding(false)); }
            catch (Exception e) { Log.Write("保存配置失败: " + e.Message); }
        }

        public static string NewToken()
        {
            const string abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            var b = new byte[32];
            using (var r = RandomNumberGenerator.Create()) r.GetBytes(b);
            var sb = new StringBuilder();
            foreach (var x in b) sb.Append(abc[x % abc.Length]);
            return sb.ToString();
        }

        /// <summary>The JSON the Node agent reads.</summary>
        public string AgentJson()
        {
            var d = new Dictionary<string, object>
            {
                ["root"] = Root, ["port"] = Port, ["token"] = Token, ["tunnel"] = Tunnel,
                ["ngrokAuthtoken"] = NgrokAuthtoken, ["ngrokDomain"] = NgrokDomain,
                ["allowWrite"] = AllowWrite, ["approveWrite"] = ApproveWrite,
                ["allowCommand"] = AllowCommand, ["approveCommand"] = ApproveCommand,
                ["commandTimeoutSec"] = CommandTimeoutSec, ["dataDir"] = Paths.BinDir,
                ["downloadMirror"] = DownloadMirror,
            };
            return Json.Serialize(d);
        }
    }
}
