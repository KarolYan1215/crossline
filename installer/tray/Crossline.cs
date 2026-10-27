// The tray for an installed copy of Crossline (docs/local-installer.md). It owns nothing but the icon and the menu: everything else
// (ports, secrets, starting and restarting the web app and the worker, updates) is the launcher, `apps\launcher\src\main.ts`, which
// this starts on the bundled node.exe and talks to in lines — commands on its stdin, one JSON event per line on its stdout.
//
// The launcher is put in a Windows job object that kills everything in it when the last handle closes, so the tray dying for any
// reason (killed from Task Manager included) takes the launcher, the web app, the worker and Codex with it.
//
// Built by scripts/package-installer.ts with the C# compiler every Windows has (.NET Framework 4.x); no runtime to install.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("Crossline")]
[assembly: System.Reflection.AssemblyProduct("Crossline")]

namespace Crossline
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            using (var single = new Mutex(true, @"Local\CrosslineTray", out created))
            {
                // A second start (the Start-menu shortcut, the autostart entry after a manual start) only opens the page.
                if (!created) { Tray.OpenFromConfig(); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var tray = new Tray(Array.IndexOf(args, "--background") < 0)) Application.Run();
            }
        }
    }

    sealed class Tray : IDisposable
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunValue = "Crossline";
        static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Crossline");

        readonly NotifyIcon icon = new NotifyIcon();
        readonly ToolStripMenuItem updateItem = new ToolStripMenuItem("检查更新");
        readonly ToolStripMenuItem autostartItem = new ToolStripMenuItem("开机时启动");
        readonly SynchronizationContext ui;
        readonly bool openWhenReady;
        IntPtr job = IntPtr.Zero;
        Process launcher;
        string url;
        string pendingUpdate;
        // What a click on the last balloon opens: the update, or the page a notice named.
        string balloonOpens;
        bool quitting;
        int restarts;

        public Tray(bool openWhenReady)
        {
            this.openWhenReady = openWhenReady;
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开 Crossline", null, (s, e) => Send("open"));
            menu.Items.Add("打开小帮手（Ctrl+Alt+H）", null, (s, e) => OpenHelper());
            menu.Items.Add(updateItem);
            updateItem.Click += (s, e) => { if (pendingUpdate != null) ConfirmUpdate(); else Send("check-update"); };
            autostartItem.Checked = AutostartEnabled();
            autostartItem.Click += (s, e) => { SetAutostart(!autostartItem.Checked); autostartItem.Checked = AutostartEnabled(); };
            menu.Items.Add(autostartItem);
            menu.Items.Add("打开数据文件夹", null, (s, e) => Process.Start("explorer.exe", "\"" + Path.Combine(Root, "data") + "\""));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出 Crossline", null, (s, e) => Quit());
            icon.ContextMenuStrip = menu;
            icon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            icon.Text = "Crossline 正在启动";
            icon.Visible = true;
            icon.DoubleClick += (s, e) => Send("open");
            icon.BalloonTipClicked += (s, e) =>
            {
                if (balloonOpens == "update") { if (pendingUpdate != null) ConfirmUpdate(); }
                else if (balloonOpens != null && url != null) Process.Start(url.TrimEnd('/') + balloonOpens);
            };
            job = CreateKillOnCloseJob();
            hotkey = new HotkeyWindow(OpenHelper);
            StartLauncher();
        }

        readonly HotkeyWindow hotkey;

        // The 小帮手 alone (`/helper`) in a small window of its own: Edge's app window when Edge is there (no tabs or address bar, sized
        // for it), else the default browser. Opened from the menu or Ctrl+Alt+H anywhere in Windows.
        void OpenHelper()
        {
            var baseUrl = url ?? ConfiguredUrl();
            if (baseUrl == null) { icon.ShowBalloonTip(5000, "Crossline", "Crossline 还在启动，稍后再打开小帮手。", ToolTipIcon.Info); return; }
            var target = baseUrl.TrimEnd('/') + "/helper";
            try
            {
                // "msedge" is found through App Paths by the shell, wherever Edge is installed.
                Process.Start(new ProcessStartInfo("msedge", "--app=\"" + target + "\" --window-size=380,560") { UseShellExecute = true });
            }
            catch (System.ComponentModel.Win32Exception)
            {
                try { Process.Start(target); } catch (System.ComponentModel.Win32Exception) { }
            }
        }

        // The page's address from launcher.json when the launcher has not said it yet (the tray just started).
        static string ConfiguredUrl()
        {
            try
            {
                var text = File.ReadAllText(Path.Combine(Root, "launcher.json"));
                var port = Regex.Match(text, "\"webPort\":\\s*(\\d+)");
                return port.Success ? "http://127.0.0.1:" + port.Groups[1].Value : null;
            }
            catch (IOException) { return null; }
        }

        void StartLauncher()
        {
            var node = Path.Combine(AppDir, "node.exe");
            var main = Path.Combine(AppDir, "apps", "launcher", "src", "main.ts");
            var info = new ProcessStartInfo(node, "--import tsx \"" + main + "\" \"--app=" + AppDir + "\"")
            {
                WorkingDirectory = Path.Combine(AppDir, "apps", "launcher"),
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8
            };
            launcher = new Process { StartInfo = info, EnableRaisingEvents = true };
            launcher.OutputDataReceived += (s, e) => { if (e.Data != null) ui.Post(_ => OnEvent(e.Data), null); };
            launcher.ErrorDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
            launcher.Exited += (s, e) => ui.Post(_ => OnLauncherExit(), null);
            launcher.Start();
            if (job != IntPtr.Zero) AssignProcessToJobObject(job, launcher.Handle);
            launcher.BeginOutputReadLine();
            launcher.BeginErrorReadLine();
        }

        void OnLauncherExit()
        {
            if (quitting) { Application.Exit(); return; }
            icon.Text = "Crossline 已停止";
            if (++restarts > 5) { icon.ShowBalloonTip(10000, "Crossline", "Crossline 多次启动失败，日志在数据文件夹的 logs 里。", ToolTipIcon.Error); return; }
            var timer = new System.Windows.Forms.Timer { Interval = 3000 };
            timer.Tick += (s, e) => { timer.Stop(); timer.Dispose(); StartLauncher(); };
            timer.Start();
        }

        static string Field(string line, string name)
        {
            var match = Regex.Match(line, "\"" + name + "\":\"((?:[^\"\\\\]|\\\\.)*)\"");
            return match.Success ? Regex.Unescape(match.Groups[1].Value) : null;
        }

        void OnEvent(string line)
        {
            var type = Field(line, "type");
            if (type == "starting") { url = Field(line, "url"); return; }
            if (type == "ready")
            {
                restarts = 0;
                url = Field(line, "url") ?? url;
                icon.Text = "Crossline 正在运行";
                if (openWhenReady && !openedOnce) Send("open");
                return;
            }
            if (type == "open") { openedOnce = true; var target = Field(line, "url") ?? url; if (target != null) Process.Start(target); return; }
            if (type == "error") { icon.ShowBalloonTip(10000, "Crossline", "Crossline 没能启动，日志在数据文件夹的 logs 里。", ToolTipIcon.Error); return; }
            if (type == "update-none") { icon.ShowBalloonTip(5000, "Crossline", "已是最新版本。", ToolTipIcon.Info); return; }
            if (type == "update-failed") { icon.ShowBalloonTip(8000, "Crossline", "更新没有完成：" + (Field(line, "code") ?? "未知原因"), ToolTipIcon.Warning); return; }
            if (type == "notify")
            {
                // A child asked to call the person back (the interview's next round landed while no page was open). The path was
                // checked by the launcher; it is always one of this app's own pages.
                var path = Field(line, "path");
                if (path == null || !path.StartsWith("/")) return;
                balloonOpens = path;
                icon.ShowBalloonTip(10000, Field(line, "title") ?? "Crossline", Field(line, "text") ?? "", ToolTipIcon.Info);
                return;
            }
            if (type == "update-available")
            {
                balloonOpens = "update";
                pendingUpdate = Field(line, "version");
                updateItem.Text = "更新到 " + pendingUpdate;
                icon.ShowBalloonTip(15000, "Crossline 有新版本", "新版本 " + pendingUpdate + " 可以安装，点这里更新。", ToolTipIcon.Info);
                return;
            }
            if (type == "update-ready")
            {
                // The installer is verified and the data folder backed up; it replaces app\ and starts the new tray itself.
                var installer = Field(line, "path");
                if (installer == null) return;
                quitting = true;
                Send("quit");
                if (launcher != null) launcher.WaitForExit(15000);
                Process.Start(new ProcessStartInfo(installer, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS") { UseShellExecute = true });
                icon.Visible = false;
                Application.Exit();
            }
        }
        bool openedOnce;

        void ConfirmUpdate()
        {
            var answer = MessageBox.Show("更新到 " + pendingUpdate + "？更新前会先备份数据文件夹，更新期间 Crossline 会关闭一两分钟。",
                "Crossline 更新", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (answer == DialogResult.OK) { icon.ShowBalloonTip(5000, "Crossline", "正在下载新版本……", ToolTipIcon.Info); Send("install-update"); }
        }

        void Send(string command)
        {
            try { if (launcher != null && !launcher.HasExited) { launcher.StandardInput.WriteLine(command); launcher.StandardInput.Flush(); } }
            catch (IOException) { }
        }

        void Quit()
        {
            quitting = true;
            Send("quit");
            icon.Visible = false;
            if (launcher == null || launcher.HasExited || !launcher.WaitForExit(10000)) Application.Exit();
        }

        static void Log(string line)
        {
            try { var dir = Path.Combine(Root, "data", "logs"); Directory.CreateDirectory(dir); File.AppendAllText(Path.Combine(dir, "launcher.err.log"), line + Environment.NewLine); }
            catch (IOException) { }
        }

        static bool AutostartEnabled()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey)) return key != null && key.GetValue(RunValue) != null;
        }

        static void SetAutostart(bool on)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) key.SetValue(RunValue, "\"" + Application.ExecutablePath + "\" --background");
                else key.DeleteValue(RunValue, false);
            }
        }

        public static void OpenFromConfig()
        {
            try
            {
                var text = File.ReadAllText(Path.Combine(Root, "launcher.json"));
                var port = Regex.Match(text, "\"webPort\":\\s*(\\d+)");
                if (port.Success) Process.Start("http://127.0.0.1:" + port.Groups[1].Value);
            }
            catch (IOException) { }
        }

        public void Dispose()
        {
            icon.Visible = false;
            icon.Dispose();
            hotkey.Dispose();
            if (job != IntPtr.Zero) CloseHandle(job);
        }

        // ---- Ctrl+Alt+H anywhere in Windows: a hidden message-only window receives WM_HOTKEY (the tray icon has no window) -------
        sealed class HotkeyWindow : NativeWindow, IDisposable
        {
            const int WM_HOTKEY = 0x0312;
            const int Id = 0x4348; // "CH"
            const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_NOREPEAT = 0x4000;
            static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);
            readonly Action onPress;
            readonly bool registered;

            public HotkeyWindow(Action onPress)
            {
                this.onPress = onPress;
                CreateHandle(new CreateParams { Parent = HWND_MESSAGE });
                // Another program already holding Ctrl+Alt+H leaves only the menu item; nothing is taken from it.
                registered = RegisterHotKey(Handle, Id, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, (uint)Keys.H);
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == Id) { onPress(); return; }
                base.WndProc(ref m);
            }

            public void Dispose()
            {
                if (registered) UnregisterHotKey(Handle, Id);
                DestroyHandle();
            }

            [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
            [DllImport("user32.dll", SetLastError = true)] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        }

        // ---- job object: everything the launcher starts dies with the tray -------------------------------------------------------
        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
        }
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

        static IntPtr CreateKillOnCloseJob()
        {
            var handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) return IntPtr.Zero;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(handle, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            return handle;
        }
    }
}
