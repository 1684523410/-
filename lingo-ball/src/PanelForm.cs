using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LingoBall
{
    /// <summary>The control panel: an HTML page in WebView2.</summary>
    class PanelForm : Form
    {
        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        bool ready;
        public event Action<string> Message;  // JSON from the page
        public event Action Ready;

        public PanelForm()
        {
            Text = "灵桥小球";
            Icon = Controller.AppIcon;
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(380, 660);
            MinimumSize = new Size(320, 420);
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = true;
            Controls.Add(web);
            FormClosing += (s, e) => { if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
            Load += async (s, e) => await Init();
        }

        async Task Init()
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewData);
                await web.EnsureCoreWebView2Async(env);
                var s = web.CoreWebView2.Settings;
                s.AreDevToolsEnabled = false;
                s.IsStatusBarEnabled = false;
                s.AreDefaultContextMenusEnabled = false;
                s.IsZoomControlEnabled = false;
                web.CoreWebView2.WebMessageReceived += (o, e) => { try { Message?.Invoke(e.WebMessageAsJson); } catch (Exception ex) { Log.Write("面板消息出错: " + ex); } };
                web.CoreWebView2.NavigationCompleted += (o, e) => { ready = true; Ready?.Invoke(); };
                web.CoreWebView2.NewWindowRequested += (o, e) => { e.Handled = true; try { System.Diagnostics.Process.Start(e.Uri); } catch { } };
                web.CoreWebView2.NavigateToString(LoadHtml());
            }
            catch (Exception e)
            {
                Log.Write("WebView2 初始化失败: " + e.Message);
                Controls.Remove(web);
                var lbl = new LinkLabel
                {
                    Dock = DockStyle.Fill, Padding = new Padding(16), Font = new Font("Microsoft YaHei UI", 10f),
                    Text = "面板需要 Microsoft Edge WebView2 运行时，你的电脑上好像没有。\r\n\r\n点这里下载安装（微软官方，免费）。\r\n\r\n不装也可以：右键小球的菜单里有全部常用功能。",
                };
                lbl.LinkArea = new LinkArea(lbl.Text.IndexOf("点这里"), 3);
                lbl.LinkClicked += (o, a) => { try { System.Diagnostics.Process.Start("https://developer.microsoft.com/zh-cn/microsoft-edge/webview2/"); } catch { } };
                Controls.Add(lbl);
            }
        }

        static string LoadHtml()
        {
            var file = Path.Combine(Paths.AppDir, "ui", "panel.html");
            if (File.Exists(file)) return File.ReadAllText(file);
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("LingoBall.panel.html"))
            using (var r = new StreamReader(s)) return r.ReadToEnd();
        }

        public void Post(string json)
        {
            if (!ready || web.CoreWebView2 == null) return;
            try { web.CoreWebView2.PostWebMessageAsJson(json); } catch { }
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
        }
    }
}
