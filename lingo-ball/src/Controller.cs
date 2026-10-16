using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LingoBall
{
    class Controller : ApplicationContext
    {
        public static readonly string Version = typeof(Controller).Assembly.GetName().Version.ToString(3);
        public static Icon AppIcon = SafeIcon();
        static Icon SafeIcon() { try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { return SystemIcons.Application; } }

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        readonly Config cfg = Config.Load();
        readonly Ball ball = new Ball();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        PanelForm panel;
        readonly AgentHost agent;
        readonly SynchronizationContext ui;
        readonly List<string> logBuf = new List<string>();

        string status = "off";   // off | preparing | starting | on | error
        string detail = "";
        string url = "";
        string error = "";
        bool userStopped = true;
        int crashRestarts = 0;
        bool sessionAllowWrite, sessionAllowCommand;
        readonly Queue<Dictionary<string, object>> approvals = new Queue<Dictionary<string, object>>();
        bool approving;
        Updater.Info update; string updateMsg = ""; bool updating;
        readonly System.Windows.Forms.Timer updTimer = new System.Windows.Forms.Timer { Interval = 6 * 3600 * 1000 };

        public Controller()
        {
            // Make sure a WindowsFormsSynchronizationContext exists before capturing it.
            var dummy = new Control(); dummy.CreateControl();
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            agent = new AgentHost(ui);
            agent.Event += OnAgentEvent;
            agent.Exited += OnAgentExited;
            Log.Line += line => ui.Post(_ => { logBuf.Add(line); if (logBuf.Count > 500) logBuf.RemoveAt(0); PostPanel(new Dictionary<string, object> { ["type"] = "log", ["line"] = line }); }, null);
            Log.Write("灵桥小球 v" + Version + " 启动");

            menu.Font = new Font("Microsoft YaHei UI", 9.5f);
            menu.Opening += (s, e) => BuildMenu();
            tray.Icon = AppIcon;
            ApplySkin();
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) TogglePanel(); };
            tray.BalloonTipClicked += (s, e) => ShowPanel();

            ball.Clicked += TogglePanel;
            ball.RightClicked += p => { BuildMenu(); menu.Show(p); };
            ball.Moved += () => { cfg.BallX = ball.BallBounds.X; cfg.BallY = ball.BallBounds.Y; cfg.Save(); };
            PlaceBall();
            if (cfg.ShowBall) ball.Show();

            UpdateVisuals();
            if (string.IsNullOrEmpty(cfg.Root))
                ui.Post(_ => { ShowPanel(); Balloon("欢迎使用灵桥小球", "先在面板里选择要给 AI 访问的工作文件夹，然后点“启动”。"); }, null);
            else if (cfg.AutoConnect)
                ui.Post(_ => Start(), null);

            updTimer.Tick += (s, e) => CheckUpdate(false);
            updTimer.Start();
            Task.Delay(20000).ContinueWith(_ => ui.Post(__ => CheckUpdate(false), null));
        }

        async void CheckUpdate(bool manual)
        {
            if (updating) return;
            if (!cfg.AutoUpdate && !manual) return;
            try
            {
                if (manual) { updateMsg = "正在检查…"; PushState(); }
                update = await Updater.Check();
                updateMsg = update == null ? "已是最新版本" : "发现新版本 v" + update.Version + (string.IsNullOrEmpty(update.Notes) ? "" : "：" + update.Notes);
                if (update != null && !manual) Balloon("灵桥小球有新版本", "v" + update.Version + " 可以更新了，打开面板点“立即更新”。");
            }
            catch (Exception e) { if (manual) updateMsg = e.Message; Log.Write("更新检查失败: " + e.Message); }
            PushState();
        }

        async void ApplyUpdate()
        {
            if (update == null || updating) return;
            updating = true;
            try
            {
                await Updater.DownloadAndApply(update, p => ui.Post(_ => { updateMsg = "下载新版本 " + p + "%"; PushState(); }, null));
                ExitApp();
            }
            catch (Exception e) { updating = false; updateMsg = e.Message; Log.Write(e.Message); PushState(); }
        }

        // ---------- placement ----------
        void PlaceBall()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            int m = ball.Margin2;
            if (cfg.BallX < 0 || cfg.BallY < 0) ball.Location = new Point(wa.Right - ball.Width - 24, wa.Top + wa.Height / 3);
            else ball.Location = new Point(cfg.BallX - m, cfg.BallY - m);
            bool onScreen = false;
            foreach (var s in Screen.AllScreens) if (s.WorkingArea.IntersectsWith(ball.BallBounds)) onScreen = true;
            if (!onScreen) ball.Location = new Point(wa.Right - ball.Width - 24, wa.Top + wa.Height / 3);
        }

        // ---------- panel ----------
        PanelForm Panel()
        {
            if (panel == null || panel.IsDisposed)
            {
                panel = new PanelForm();
                panel.Message += OnPanelMessage;
                panel.Ready += () => { PushState(); foreach (var l in logBuf) PostPanel(new Dictionary<string, object> { ["type"] = "log", ["line"] = l }); };
            }
            return panel;
        }
        void ShowPanel() { var p = Panel(); p.ShowNear(cfg.ShowBall && ball.Visible ? ball.BallBounds : new Rectangle(Cursor.Position, new Size(1, 1))); }
        void TogglePanel() { var p = Panel(); if (p.Visible && p.WindowState != FormWindowState.Minimized) p.Hide(); else ShowPanel(); }
        void PostPanel(object o) { if (panel != null && !panel.IsDisposed) panel.Post(Json.Serialize(o)); }

        void PushState()
        {
            PostPanel(new Dictionary<string, object>
            {
                ["type"] = "state",
                ["status"] = status, ["detail"] = detail, ["url"] = url, ["error"] = error,
                ["root"] = cfg.Root, ["tunnel"] = cfg.Tunnel, ["port"] = cfg.Port,
                ["ngrokDomain"] = cfg.NgrokDomain, ["hasNgrokToken"] = !string.IsNullOrEmpty(cfg.NgrokAuthtoken),
                ["allowWrite"] = cfg.AllowWrite, ["approveWrite"] = cfg.ApproveWrite,
                ["allowCommand"] = cfg.AllowCommand, ["approveCommand"] = cfg.ApproveCommand,
                ["autoConnect"] = cfg.AutoConnect, ["showBall"] = cfg.ShowBall, ["autoStartWin"] = AutoStartWin,
                ["version"] = Version, ["autoUpdate"] = cfg.AutoUpdate, ["ballSkin"] = cfg.BallSkin,
                ["update"] = update?.Version ?? "", ["updateMsg"] = updateMsg, ["updating"] = updating,
            });
        }

        void OnPanelMessage(string raw)
        {
            var m = Json.Deserialize<Dictionary<string, object>>(raw);
            string a = m.TryGetValue("a", out var av) ? av as string : "";
            object v = m.TryGetValue("v", out var vv) ? vv : null;
            switch (a)
            {
                case "ready": PushState(); break;
                case "start": Start(); break;
                case "stop": Stop(); break;
                case "restart": Restart(); break;
                case "copy": CopyUrl(); break;
                case "pickFolder": PickFolder(); break;
                case "openFolder": if (Directory.Exists(cfg.Root)) Process.Start("explorer.exe", "\"" + cfg.Root + "\""); break;
                case "openLog": try { Process.Start("notepad.exe", "\"" + Paths.LogFile + "\""); } catch { } break;
                case "regen":
                    if (MessageBox.Show(panel, "重置后旧的 MCP 地址会失效，需要把新地址重新发给 AI。确定吗？", "重置访问令牌", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) == DialogResult.OK)
                    { cfg.Token = Config.NewToken(); cfg.Save(); Log.Write("访问令牌已重置"); RestartIfRunning(); }
                    break;
                case "saveNgrok":
                    var tok = (m.TryGetValue("token", out var t) ? t as string : "")?.Trim() ?? "";
                    var dom = (m.TryGetValue("domain", out var d) ? d as string : "")?.Trim() ?? "";
                    if (tok.Length > 0) cfg.NgrokAuthtoken = tok;
                    cfg.NgrokDomain = dom.Replace("https://", "").Replace("http://", "").TrimEnd('/');
                    cfg.Save(); Log.Write("ngrok 设置已保存" + (cfg.NgrokDomain != "" ? "，固定域名 " + cfg.NgrokDomain : ""));
                    if (cfg.Tunnel == "ngrok") RestartIfRunning();
                    break;
                case "set": SetOption(m["k"] as string, v); break;
                case "exit": ExitApp(); break;
                case "checkUpdate": CheckUpdate(true); break;
                case "applyUpdate": ApplyUpdate(); break;
            }
            PushState();
        }

        static readonly string[][] Skins = { new[] { "glass", "彩窗蝴蝶（深色）" }, new[] { "light", "清透蝴蝶（浅色）" }, new[] { "classic", "经典小桥" } };

        void ApplySkin()
        {
            ball.SetSkin(cfg.BallSkin);
            try
            {
                using (var src = Ball.LoadSkin(cfg.BallSkin == "classic" ? "glass" : cfg.BallSkin))
                {
                    if (src == null) return;
                    using (var bmp = new Bitmap(32, 32))
                    {
                        using (var g = Graphics.FromImage(bmp))
                        {
                            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                            g.DrawImage(src, 0, 0, 32, 32);
                        }
                        var old = tray.Icon;
                        tray.Icon = Icon.FromHandle(bmp.GetHicon());
                        if (old != null && old != AppIcon) old.Dispose();
                    }
                }
            }
            catch (Exception e) { Log.Write("托盘图标切换失败: " + e.Message); }
        }

        void SetOption(string k, object v)
        {
            bool b = v is bool bb && bb;
            bool restart = true;
            switch (k)
            {
                case "tunnel": cfg.Tunnel = v as string ?? "cloudflare"; break;
                case "allowWrite": cfg.AllowWrite = b; break;
                case "approveWrite": cfg.ApproveWrite = b; break;
                case "allowCommand": cfg.AllowCommand = b; break;
                case "approveCommand": cfg.ApproveCommand = b; break;
                case "autoConnect": cfg.AutoConnect = b; restart = false; break;
                case "showBall": cfg.ShowBall = b; if (b) { PlaceBall(); ball.Show(); } else ball.Hide(); restart = false; break;
                case "autoStartWin": AutoStartWin = b; restart = false; break;
                case "autoUpdate": cfg.AutoUpdate = b; restart = false; break;
                case "ballSkin": cfg.BallSkin = v as string ?? "glass"; ApplySkin(); restart = false; break;
                default: return;
            }
            cfg.Save();
            if (restart) RestartIfRunning();
        }

        // ---------- menu ----------
        void BuildMenu()
        {
            menu.Items.Clear();
            var head = new ToolStripMenuItem("灵桥 · " + StatusText()) { Enabled = false };
            menu.Items.Add(head);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开面板", null, (s, e) => ShowPanel());
            if (status == "on" || status == "starting" || status == "preparing") menu.Items.Add("停止", null, (s, e) => Stop());
            else menu.Items.Add("启动", null, (s, e) => Start());
            var copy = new ToolStripMenuItem("复制 MCP 地址", null, (s, e) => CopyUrl()) { Enabled = url != "" };
            menu.Items.Add(copy);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("选择工作文件夹…", null, (s, e) => PickFolder());
            var tun = new ToolStripMenuItem("隧道");
            foreach (var (id, name) in new[] { ("ngrok", "ngrok 固定链接"), ("cloudflare", "Cloudflare 临时隧道"), ("none", "不用隧道（仅本机）") })
            {
                var it = new ToolStripMenuItem(name) { Checked = cfg.Tunnel == id };
                it.Click += (s, e) => { SetOption("tunnel", id); PushState(); };
                tun.DropDownItems.Add(it);
            }
            menu.Items.Add(tun);
            var sk = new ToolStripMenuItem("小球外观");
            foreach (var x in Skins)
            {
                var id = x[0];
                sk.DropDownItems.Add(new ToolStripMenuItem(x[1], null, (s, e) => { SetOption("ballSkin", id); PushState(); }) { Checked = cfg.BallSkin == id });
            }
            menu.Items.Add(sk);
            menu.Items.Add(new ToolStripMenuItem(cfg.ShowBall ? "隐藏小球（留在托盘）" : "显示小球", null, (s, e) => { SetOption("showBall", !cfg.ShowBall); PushState(); }));
            menu.Items.Add(new ToolStripMenuItem("开机自动运行", null, (s, e) => { AutoStartWin = !AutoStartWin; PushState(); }) { Checked = AutoStartWin });
            menu.Items.Add(new ToolStripSeparator());
            if (update != null) menu.Items.Add("更新到 v" + update.Version, null, (s, e) => ApplyUpdate());
            menu.Items.Add("退出", null, (s, e) => ExitApp());
        }

        // ---------- lifecycle ----------
        string StatusText()
        {
            switch (status)
            {
                case "on": return "运行中";
                case "starting": case "preparing": return "启动中…";
                case "error": return "出错了";
                default: return "未启动";
            }
        }

        void UpdateVisuals()
        {
            var st = status == "on" ? Ball.State.On : status == "error" ? Ball.State.Error : (status == "starting" || status == "preparing") ? Ball.State.Starting : Ball.State.Off;
            ball.SetState(st, approving);
            var tip = "灵桥小球 · " + StatusText();
            if (status == "starting" || status == "preparing") tip += "\n" + detail;
            tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
            PushState();
        }

        void SetStatus(string s, string d = "") { status = s; detail = d; if (s != "error") error = ""; UpdateVisuals(); }

        async void Start()
        {
            if (agent.Running || status == "preparing") { if (url != "") CopyUrl(); return; }
            if (string.IsNullOrEmpty(cfg.Root) || !Directory.Exists(cfg.Root))
            {
                if (!PickFolder(startAfter: false)) return;
            }
            if (cfg.Tunnel == "ngrok" && string.IsNullOrEmpty(cfg.NgrokAuthtoken))
            {
                ShowPanel();
                Fail("还没设置 ngrok：在面板“隧道”里填好 Authtoken 后再启动（或改用 Cloudflare）。");
                return;
            }
            userStopped = false;
            url = "";
            sessionAllowWrite = sessionAllowCommand = false;
            SetStatus("preparing", "检查运行环境");
            try
            {
                var node = AgentHost.FindNode();
                if (node == null)
                {
                    SetStatus("preparing", "首次使用，下载运行环境 0%");
                    Balloon("灵桥小球", "首次使用需要下载约 30MB 的运行环境，稍等一下。");
                    node = await AgentHost.DownloadNode(p => ui.Post(_ => SetStatus("preparing", "首次使用，下载运行环境 " + p + "%"), null));
                }
                if (userStopped) { SetStatus("off"); return; }
                SetStatus("starting", "正在启动");
                agent.Start(node, cfg);
            }
            catch (Exception e) { Fail(e.Message); }
        }

        void Stop()
        {
            userStopped = true;
            agent.Stop();
            url = "";
            SetStatus("off");
            Log.Write("已停止");
        }

        void Restart() { Stop(); ui.Post(_ => Start(), null); }
        void RestartIfRunning() { if (agent.Running || status == "on" || status == "starting") { Log.Write("设置已更改，正在重启…"); Restart(); } }

        void Fail(string msg)
        {
            status = "error"; error = msg; detail = "";
            Log.Write("出错: " + msg);
            UpdateVisuals();
            Balloon("灵桥出错了", msg, ToolTipIcon.Error);
        }

        void OnAgentEvent(Dictionary<string, object> ev)
        {
            var t = ev.TryGetValue("t", out var tv) ? tv as string : "";
            switch (t)
            {
                case "log": Log.Write(ev["m"] as string); break;
                case "status":
                    var s = ev["s"] as string;
                    var d = ev.TryGetValue("detail", out var dv) ? dv as string ?? "" : "";
                    if (s == "on") { crashRestarts = 0; SetStatus("on", d); } else SetStatus(s, d);
                    break;
                case "url":
                    url = ev["url"] as string ?? "";
                    try { Clipboard.SetText(url); } catch { }
                    Balloon("灵桥已连接", "MCP 地址已复制到剪贴板，发给网页 AI 即可。");
                    PushState();
                    break;
                case "progress": Log.Write("AI 进度: " + ev["m"]); tray.Text = Trunc("AI: " + ev["m"], 63); break;
                case "approve": approvals.Enqueue(ev); PumpApprovals(); break;
                case "error": userStopped = true; Fail(ev["m"] as string); break;
            }
        }

        void PumpApprovals()
        {
            if (approving || approvals.Count == 0) return;
            var ev = approvals.Dequeue();
            var kind = ev["kind"] as string;
            var id = ev["id"];
            if ((kind == "write" && sessionAllowWrite) || (kind == "command" && sessionAllowCommand))
            {
                agent.Send(new Dictionary<string, object> { ["t"] = "approve", ["id"] = id, ["ok"] = true });
                PumpApprovals();
                return;
            }
            approving = true; UpdateVisuals();
            using (var f = new ApproveForm(kind, ev["summary"] as string ?? ""))
            {
                f.ShowDialog();
                if (f.Result == Approval.AllowSession) { if (kind == "write") sessionAllowWrite = true; else sessionAllowCommand = true; }
                bool ok = f.Result != Approval.Deny;
                Log.Write((ok ? "已允许" : "已拒绝") + (kind == "command" ? "命令" : "修改"));
                agent.Send(new Dictionary<string, object> { ["t"] = "approve", ["id"] = id, ["ok"] = ok });
            }
            approving = false; UpdateVisuals();
            ui.Post(_ => PumpApprovals(), null);
        }

        void OnAgentExited(int code)
        {
            approvals.Clear();
            if (userStopped || status == "error") { if (status != "error") SetStatus("off"); return; }
            url = "";
            if (crashRestarts < 3)
            {
                crashRestarts++;
                Log.Write("灵桥意外退出（代码 " + code + "），3 秒后自动重启（第 " + crashRestarts + " 次）");
                SetStatus("starting", "意外退出，正在重启");
                Task.Delay(3000).ContinueWith(_ => ui.Post(__ => { if (!userStopped) { status = "off"; Start(); } }, null));
            }
            else Fail("灵桥多次意外退出，请打开日志看看原因。");
        }

        // ---------- helpers ----------
        bool PickFolder(bool startAfter = true)
        {
            using (var dlg = new FolderBrowserDialog { Description = "选择要让 AI 访问的工作文件夹", ShowNewFolderButton = true })
            {
                if (Directory.Exists(cfg.Root)) dlg.SelectedPath = cfg.Root;
                else if (Directory.Exists(@"D:\vs code文件夹")) dlg.SelectedPath = @"D:\vs code文件夹";
                var owner = panel != null && panel.Visible ? (IWin32Window)panel : null;
                if (dlg.ShowDialog(owner) != DialogResult.OK) return false;
                var changed = !string.Equals(cfg.Root, dlg.SelectedPath, StringComparison.OrdinalIgnoreCase);
                cfg.Root = dlg.SelectedPath; cfg.Save();
                Log.Write("工作文件夹: " + cfg.Root);
                PushState();
                if (changed && startAfter) { if (agent.Running) Restart(); }
                return true;
            }
        }

        void CopyUrl()
        {
            if (url == "") { Balloon("灵桥", "还没启动，暂时没有地址。"); return; }
            try { Clipboard.SetText(url); Balloon("已复制", "MCP 地址已复制到剪贴板。"); } catch (Exception e) { Log.Write("复制失败: " + e.Message); }
        }

        void Balloon(string title, string text, ToolTipIcon icon = ToolTipIcon.Info)
        {
            try { tray.ShowBalloonTip(4000, title, Trunc(text, 250), icon); } catch { }
        }

        static string Trunc(string s, int n) => s == null ? "" : (s.Length > n ? s.Substring(0, n) : s);

        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        bool AutoStartWin
        {
            get { try { using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) return k?.GetValue("LingoBall") != null; } catch { return false; } }
            set
            {
                try
                {
                    using (var k = Registry.CurrentUser.OpenSubKey(RunKey, true) ?? Registry.CurrentUser.CreateSubKey(RunKey))
                    {
                        if (value) k.SetValue("LingoBall", "\"" + Application.ExecutablePath + "\"");
                        else k.DeleteValue("LingoBall", false);
                    }
                }
                catch (Exception e) { Log.Write("设置开机自启失败: " + e.Message); }
            }
        }

        void ExitApp()
        {
            userStopped = true;
            try { agent.Stop(); } catch { }
            try { tray.Visible = false; } catch { }
            ExitThread();
        }

        protected override void ExitThreadCore()
        {
            try { agent.Stop(); } catch { }
            try { tray.Visible = false; } catch { }
            base.ExitThreadCore();
        }
    }
}
