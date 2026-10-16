using System;
using System.Drawing;
using System.Windows.Forms;

namespace LingoBall
{
    enum Approval { Deny, Allow, AllowSession }

    class ApproveForm : Form
    {
        public Approval Result = Approval.Deny;

        public ApproveForm(string kind, string summary)
        {
            bool cmd = kind == "command";
            Text = "灵桥 · AI 请求" + (cmd ? "运行命令" : "修改文件");
            Font = new Font("Microsoft YaHei UI", 9.5f);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false;
            TopMost = true;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(520, 300);
            Icon = Controller.AppIcon;

            var title = new Label
            {
                Text = cmd ? "AI 想在你的电脑上运行下面的命令，允许吗？" : "AI 想修改下面的文件，允许吗？",
                Dock = DockStyle.Top, Height = 36, Padding = new Padding(12, 12, 12, 0),
                Font = new Font(Font, FontStyle.Bold),
            };
            var box = new TextBox
            {
                Text = summary.Replace("\r\n", "\n").Replace("\n", "\r\n"), Multiline = true, ReadOnly = true,
                ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BackColor = Color.FromArgb(248, 248, 250),
                Font = new Font("Consolas", 10f), BorderStyle = BorderStyle.FixedSingle,
            };
            var mid = new Panel { Dock = DockStyle.Fill, Padding = new Padding(12, 6, 12, 6) };
            mid.Controls.Add(box);

            var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 52, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(8, 8, 8, 8) };
            Button B(string t, Approval r) { var b = new Button { Text = t, AutoSize = true, Padding = new Padding(10, 3, 10, 3), Margin = new Padding(6, 0, 0, 0) }; b.Click += (s, e) => { Result = r; Close(); }; return b; }
            var deny = B("拒绝", Approval.Deny);
            var allow = B("允许", Approval.Allow);
            var all = B(cmd ? "本次运行期间都允许命令" : "本次运行期间都允许修改", Approval.AllowSession);
            bar.Controls.Add(deny); bar.Controls.Add(allow); bar.Controls.Add(all);
            AcceptButton = allow; CancelButton = deny;

            Controls.Add(mid); Controls.Add(bar); Controls.Add(title);
            Shown += (s, e) => { Activate(); allow.Focus(); };
        }
    }
}
