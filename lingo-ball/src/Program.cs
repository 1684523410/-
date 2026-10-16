using System;
using System.Threading;
using System.Windows.Forms;

namespace LingoBall
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            bool created;
            using (var mutex = new Mutex(true, "LingoBall.SingleInstance.v1", out created))
            {
                if (!created)
                {
                    MessageBox.Show("灵桥小球已经在运行了（看看桌面上的小球或右下角托盘）。", "灵桥小球", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                System.Net.ServicePointManager.SecurityProtocol |= System.Net.SecurityProtocolType.Tls12;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += (s, e) => Log.Write("UI 异常: " + e.Exception);
                AppDomain.CurrentDomain.UnhandledException += (s, e) => Log.Write("未处理异常: " + e.ExceptionObject);
                Application.Run(new Controller());
            }
        }
    }
}
