// The tray for an installed copy of Crossline (docs/local-installer.md). It owns nothing but the icon and the menu: everything else
// (ports, secrets, starting and restarting the web app and the worker, updates) is the launcher, `apps\launcher\dist\main.mjs`, which
// this starts on the bundled node.exe and talks to in lines — commands on its stdin, one JSON event per line on its stdout.
//
// The launcher is put in a Windows job object that kills everything in it when the last handle closes, so the tray dying for any
// reason (killed from Task Manager included) takes the launcher, the web app, the worker and Codex with it.
//
// The pages show in Crossline's own window (AppWindow.cs, WebView2; docs/plans/desktop-window-1123.md), not in a browser; without the
// WebView2 runtime they open in the default browser as before.
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
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
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
                // A second start (the Start-menu shortcut, the autostart entry after a manual start) only brings the window back; a tray
                // from before the window existed has no event to signal, and the page opens in the browser as it did.
                if (!created) { if (!Tray.SignalShow()) Tray.OpenFromConfig(); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var tray = new Tray(Array.IndexOf(args, "--background") < 0, Array.IndexOf(args, "--devtools") >= 0)) Application.Run();
            }
        }
    }

    sealed class Tray : IDisposable, IWindowHost
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunValue = "Crossline";
        const string ShowEventName = @"Local\CrosslineShowWindow";
        static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        public static readonly string Root = Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData), "Crossline");

        readonly NotifyIcon icon = new NotifyIcon();
        readonly ToolStripMenuItem updateItem = new ToolStripMenuItem("检查更新");
        readonly ToolStripMenuItem autostartItem = new ToolStripMenuItem("开机时启动");
        readonly ToolStripMenuItem helperItem = new ToolStripMenuItem("打开小帮手（Ctrl+Alt+H）");
        readonly bool devTools;
        readonly string version;
        readonly EventWaitHandle showEvent;
        FileSystemWatcher faceWatcher;
        AppWindow main, helper;
        bool mainLoaded, helperLoaded, webReady;
        bool? windowsAvailable;
        Task<CoreWebView2Environment> environment;
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

        public Tray(bool openWhenReady, bool devTools)
        {
            this.openWhenReady = openWhenReady;
            this.devTools = devTools;
            version = ReleaseVersion();
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开 Crossline", null, (s, e) => Send("open"));
            menu.Items.Add("在浏览器中打开", null, (s, e) => { var target = url ?? ConfiguredUrl(); if (target != null) Process.Start(target); });
            helperItem.Click += (s, e) => OpenHelper();
            menu.Items.Add(helperItem);
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
                else if (balloonOpens != null && balloonOpens.StartsWith("link:https://")) Process.Start(balloonOpens.Substring(5));
                else if (balloonOpens != null && url != null) ShowMain(url.TrimEnd('/') + balloonOpens);
            };
            job = CreateKillOnCloseJob();
            hotkey = new HotkeyWindow(OpenHelper);
            // A second start signals this event: the window comes back.
            showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
            ThreadPool.RegisterWaitForSingleObject(showEvent, (state, timedOut) => ui.Post(_ => ShowMain(null), null), null, -1, false);
            WatchFace();
            StartLauncher();
            // The window opens at once and says it is starting; the page follows when the web app answers.
            if (openWhenReady) ShowMain(null);
        }

        public static bool SignalShow()
        {
            EventWaitHandle existing;
            if (!EventWaitHandle.TryOpenExisting(ShowEventName, out existing)) return false;
            using (existing) existing.Set();
            return true;
        }

        static string ReleaseVersion()
        {
            try
            {
                var match = Regex.Match(File.ReadAllText(Path.Combine(AppDir, "release.json")), "\"version\":\\s*\"([^\"]+)\"");
                return match.Success ? match.Groups[1].Value : "";
            }
            catch (IOException) { return ""; }
        }

        // ---- the window (AppWindow.cs) --------------------------------------------------------------------------------------------

        public string Version { get { return version; } }
        public bool DevTools { get { return devTools; } }

        public Task<CoreWebView2Environment> Environment()
        {
            // Cookies, cache and permissions live in state\: not app\ (an update replaces it), not data\ (not backed up).
            if (environment == null) environment = CoreWebView2Environment.CreateAsync(null, Path.Combine(Root, "state", "webview2"), null);
            return environment;
        }

        /// <summary>Whether the WebView2 runtime is here; without it the page opens in the browser, and the person is told once how to get it.</summary>
        bool WindowsAvailable()
        {
            if (windowsAvailable.HasValue) return windowsAvailable.Value;
            try { windowsAvailable = !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString()); }
            catch (Exception error)
            {
                windowsAvailable = false;
                Log("webview2 unavailable: " + error.GetType().Name + ": " + error.Message);
                balloonOpens = "link:https://developer.microsoft.com/microsoft-edge/webview2/";
                icon.ShowBalloonTip(15000, "Crossline", "没有找到 WebView2 运行时，已用浏览器打开。点这里安装后，Crossline 会在自己的窗口里打开。", ToolTipIcon.Info);
            }
            return windowsAvailable.Value;
        }

        /// <summary>Brings the main window back; `address` is a page to show, or null to keep what it shows (the start page the first time).</summary>
        void ShowMain(string address)
        {
            if (!WindowsAvailable())
            {
                var target = address ?? url ?? ConfiguredUrl();
                if (target != null && webReady) Process.Start(target);
                return;
            }
            if (main == null || main.IsDisposed) { main = new AppWindow(this, WindowKind.Main, icon.Icon); mainLoaded = false; }
            var go = address;
            if (go == null && !mainLoaded && webReady && url != null) go = url;
            if (go != null) mainLoaded = true;
            main.BringToFront(go);
        }

        public void OpenOwnPage(string address)
        {
            var page = new AppWindow(this, WindowKind.Page, icon.Icon);
            page.Navigate(address);
            page.Show();
        }

        public void Balloon(string title, string text, string path)
        {
            balloonOpens = path ?? "/";
            icon.ShowBalloonTip(10000, title, text, ToolTipIcon.Info);
        }

        public void Hidden()
        {
            if (WindowPlacement.Flag("toldHidden")) return;
            WindowPlacement.SetFlag("toldHidden");
            balloonOpens = null;
            icon.ShowBalloonTip(8000, "Crossline 仍在后台运行", "提醒、排程和文件夹读取照常进行。要完全退出，在托盘图标的菜单里点「退出 Crossline」。", ToolTipIcon.Info);
        }

        /// <summary>The 小帮手 takes the person's figure as its icon (Face in AppWindow.cs); the web app names it in desktop-face.txt.</summary>
        void WatchFace()
        {
            RefreshFace();
            try
            {
                var data = Path.Combine(Root, "data");
                Directory.CreateDirectory(data);
                faceWatcher = new FileSystemWatcher(data, "desktop-face.txt") { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName };
                FileSystemEventHandler changed = (s, e) => ui.Post(_ => RefreshFace(), null);
                faceWatcher.Changed += changed;
                faceWatcher.Created += changed;
                faceWatcher.EnableRaisingEvents = true;
            }
            catch (Exception error) { Log("face watcher: " + error.Message); }
        }

        void RefreshFace()
        {
            var face = Face.Load();
            helperItem.Image = face == null ? null : face.ToBitmap();
            if (helper != null && !helper.IsDisposed) helper.Icon = face ?? icon.Icon;
        }

        readonly HotkeyWindow hotkey;

        // The 小帮手 alone (`/helper`) in a small window of its own, with the person's figure as its icon. Without WebView2: Edge's app
        // window when Edge is there (no tabs or address bar, sized for it), else the default browser. Opened from the menu or Ctrl+Alt+H.
        void OpenHelper()
        {
            var baseUrl = url ?? ConfiguredUrl();
            if (baseUrl == null || !webReady) { icon.ShowBalloonTip(5000, "Crossline", "Crossline 还在启动，稍后再打开小帮手。", ToolTipIcon.Info); return; }
            var target = baseUrl.TrimEnd('/') + "/helper";
            if (WindowsAvailable())
            {
                if (helper == null || helper.IsDisposed) { helper = new AppWindow(this, WindowKind.Helper, Face.Load() ?? icon.Icon); helperLoaded = false; }
                helper.BringToFront(helperLoaded ? null : target);
                helperLoaded = true;
                return;
            }
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
            // Compiled at packaging (scripts/bundle-installed.ts): no TypeScript ships, so no tsx.
            var main = Path.Combine(AppDir, "apps", "launcher", "dist", "main.mjs");
            var info = new ProcessStartInfo(node, "\"" + main + "\" \"--app=" + AppDir + "\"")
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
                webReady = true;
                icon.Text = "Crossline 正在运行";
                if (openWhenReady && !openedOnce) Send("open");
                // A window opened while the app was starting shows its page now.
                else if (main != null && !main.IsDisposed && main.Visible && !mainLoaded) ShowMain(null);
                return;
            }
            if (type == "open") { openedOnce = true; url = Field(line, "url") ?? url; webReady = true; ShowMain(null); return; }
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
            if (type == "update-discontinued")
            {
                // The full installed copy is no longer published (2026-10-28): its last word, said once. Nothing here is removed; a click
                // opens the page the signed manifest named (https only, checked by the launcher).
                var link = Field(line, "link");
                balloonOpens = link != null && link.StartsWith("https://") ? "link:" + link : null;
                updateItem.Text = "已停止更新";
                icon.ShowBalloonTip(20000, "Crossline 本机版已停止更新", Field(line, "notice") ?? "", ToolTipIcon.Info);
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
                if (main != null && !main.IsDisposed) main.Quitting = true;
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
            if (main != null && !main.IsDisposed) main.Quitting = true;
            Send("quit");
            icon.Visible = false;
            if (launcher == null || launcher.HasExited || !launcher.WaitForExit(10000)) Application.Exit();
        }

        static void Log(string line)
        {
            try { var dir = Path.Combine(Root, "data", "logs"); Directory.CreateDirectory(dir); File.AppendAllText(Path.Combine(dir, "launcher.err.log"), line + System.Environment.NewLine); }
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
            if (faceWatcher != null) faceWatcher.Dispose();
            showEvent.Dispose();
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
