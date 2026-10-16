using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LingoBall
{
    /// <summary>Floating mini window that hosts the Hark web app, opened by clicking the ball.</summary>
    class HarkWindow : Form
    {
        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        readonly ToolStrip bar = new ToolStrip { GripStyle = ToolStripGripStyle.Hidden, RenderMode = ToolStripRenderMode.System, Padding = new Padding(4, 2, 4, 2) };
        readonly ToolStripButton pin, shot;
        readonly ToolStripLabel hint = new ToolStripLabel { ForeColor = Color.FromArgb(0x6B, 0x5B, 0xD6) };
        readonly Timer hintTimer = new Timer { Interval = 4000 };
        CoreWebView2Environment env;
        readonly Config cfg;
        public event Action ScreenshotRequested;

        public HarkWindow(Config cfg)
        {
            this.cfg = cfg;
            Text = "Hark";
            Icon = Controller.AppIcon;
            AutoScaleMode = AutoScaleMode.Dpi;
            FormBorderStyle = FormBorderStyle.SizableToolWindow;
            ShowInTaskbar = false;
            TopMost = cfg.HarkTopMost;
            StartPosition = FormStartPosition.Manual;
            ClientSize = new Size(Math.Max(320, cfg.HarkW), Math.Max(420, cfg.HarkH));
            MinimumSize = new Size(300, 400);
            Font = new Font("Microsoft YaHei UI", 9f);

            pin = new ToolStripButton("📌 置顶") { Checked = cfg.HarkTopMost, CheckOnClick = true, ToolTipText = "保持在最上层" };
            pin.CheckedChanged += (s, e) => { TopMost = cfg.HarkTopMost = pin.Checked; cfg.Save(); };
            shot = new ToolStripButton("📷 截屏") { ToolTipText = "截取当前屏幕并复制，在对话框里按 Ctrl+V 粘贴发给 Hark" };
            shot.Click += (s, e) => ScreenshotRequested?.Invoke();
            var reload = new ToolStripButton("⟳") { ToolTipText = "刷新" };
            reload.Click += (s, e) => { try { web.CoreWebView2?.Reload(); } catch { } };
            var ext = new ToolStripButton("↗") { ToolTipText = "在浏览器中打开" };
            ext.Click += (s, e) => { try { System.Diagnostics.Process.Start(web.Source?.ToString() ?? cfg.HarkUrl); } catch { } };
            bar.Items.AddRange(new ToolStripItem[] { pin, shot, hint });
            ext.Alignment = ToolStripItemAlignment.Right; reload.Alignment = ToolStripItemAlignment.Right;
            bar.Items.Add(ext); bar.Items.Add(reload);
            hintTimer.Tick += (s, e) => { hintTimer.Stop(); hint.Text = ""; };

            Controls.Add(web);
            Controls.Add(bar);
            FormClosing += (s, e) => { if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
            ResizeEnd += (s, e) => { cfg.HarkW = ClientSize.Width; cfg.HarkH = ClientSize.Height; cfg.Save(); };
            Load += async (s, e) => await Init();
        }

        public void Hint(string text)
        {
            hint.Text = text;
            hintTimer.Stop(); hintTimer.Start();
        }

        async Task Init()
        {
            try
            {
                env = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewData);
                await web.EnsureCoreWebView2Async(env);
                web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                // sign-in popups (Google/Apple) must stay inside WebView2 so window.opener keeps working
                web.CoreWebView2.NewWindowRequested += async (o, e) =>
                {
                    var deferral = e.GetDeferral();
                    try
                    {
                        var f = new Form { Text = "登录", Icon = Controller.AppIcon, StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(520, 640), TopMost = TopMost };
                        var w = new WebView2 { Dock = DockStyle.Fill };
                        f.Controls.Add(w);
                        f.Show(this);
                        await w.EnsureCoreWebView2Async(env);
                        w.CoreWebView2.WindowCloseRequested += (a, b) => f.Close();
                        e.NewWindow = w.CoreWebView2;
                        e.Handled = true;
                    }
                    catch (Exception ex) { Log.Write("打开登录窗口失败: " + ex.Message); }
                    finally { deferral.Complete(); }
                };
                web.Source = new Uri(string.IsNullOrWhiteSpace(cfg.HarkUrl) ? "https://hark.com/login" : cfg.HarkUrl);
            }
            catch (Exception e)
            {
                Log.Write("Hark 窗口初始化失败: " + e.Message);
                Controls.Remove(web);
                var lbl = new LinkLabel
                {
                    Dock = DockStyle.Fill, Padding = new Padding(16), Font = new Font("Microsoft YaHei UI", 10f),
                    Text = "需要 Microsoft Edge WebView2 运行时才能在小窗里打开 Hark。\r\n\r\n点这里下载安装（微软官方，免费）。",
                };
                lbl.LinkArea = new LinkArea(lbl.Text.IndexOf("点这里"), 3);
                lbl.LinkClicked += (o, a) => { try { System.Diagnostics.Process.Start("https://developer.microsoft.com/zh-cn/microsoft-edge/webview2/"); } catch { } };
                Controls.Add(lbl);
                lbl.BringToFront();
            }
        }

        public void ShowNear(Rectangle anchor)
        {
            var wa = Screen.FromRectangle(anchor).WorkingArea;
            int x = anchor.Left - Width - 8;
            if (x < wa.Left) x = anchor.Right + 8;
            if (x + Width > wa.Right) x = wa.Right - Width;
            int y = Math.Max(wa.Top, Math.Min(anchor.Top - Height / 3, wa.Bottom - Height));
            if (!Visible) Location = new Point(x, y);
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            try { web.Focus(); } catch { }
        }
    }
}
