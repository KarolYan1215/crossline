// The tray of 「Crossline 节点」 (docs/compute-node.md 「托盘与桌宠」, 2026-10-28). It owns the icon, the menu, Ctrl+Alt+H and the 小帮手's
// desktop window; the node program itself (main.mjs: pairing, sign-in, the relay, updates) runs on the bundled node.exe as a child with
// `--tray` and talks to this in lines — commands on its stdin, one JSON event per line on its stdout — as the installed copy's launcher
// does with Crossline.exe (installer/tray/Crossline.cs).
//
// The 小帮手 window is WebView2 (the runtime every Windows 11 has): no frame, transparent outside the figure and its bubble, above other
// windows, dragged by the figure, its place remembered. It loads `<site>/helper?pet=1` with a profile of its own under
// %LOCALAPPDATA%\Crossline Node\webview2, so the person signs in to the site once there; any other page of the site (the sign-in) is shown
// in an ordinary window until it comes back to the 小帮手. Links leaving the 小帮手 open in the person's own browser.
//
// The node is put in a Windows job object that kills it when the last handle closes: the tray dying takes the node and its Codex along.
//
// Built by scripts/package-node.ts with the C# compiler every Windows has (.NET Framework 4.x) against the WebView2 SDK's managed DLLs,
// which ship beside it (Microsoft.Web.WebView2.Core/WinForms + WebView2Loader.dll; version and hashes pinned there).
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("Crossline 节点")]
[assembly: System.Reflection.AssemblyProduct("Crossline 节点")]

namespace CrosslineNode
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            using (var single = new Mutex(true, @"Local\CrosslineNodeTray", out created))
            {
                // A second start (the Start-menu shortcut while running) only opens the node's own page.
                if (!created) { Tray.OpenRunningPage(); return; }
                // Per-monitor DPI: the figure is drawn sharp, not a stretched bitmap. Sizes are scaled by the window's own DPI below.
                try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var tray = new Tray(Array.IndexOf(args, "--background") >= 0, Array.IndexOf(args, "--no-node") >= 0, Option(args, "--site")))
                    Application.Run();
            }
        }

        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        static string Option(string[] args, string name)
        {
            var at = Array.IndexOf(args, name);
            return at >= 0 && at + 1 < args.Length ? args[at + 1] : null;
        }
    }

    sealed class Tray : IDisposable
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunValue = "Crossline Node";
        internal static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        internal static readonly string Home = Environment.GetEnvironmentVariable("CROSSLINE_NODE_HOME")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Crossline Node");

        readonly NotifyIcon icon = new NotifyIcon();
        readonly ToolStripMenuItem petItem = new ToolStripMenuItem();
        readonly ToolStripMenuItem statusItem = new ToolStripMenuItem("节点：正在启动") { Enabled = false };
        readonly ToolStripMenuItem pauseItem = new ToolStripMenuItem("暂停算力") { Enabled = false };
        readonly ToolStripMenuItem updateItem = new ToolStripMenuItem("检查更新");
        readonly ToolStripMenuItem autostartItem = new ToolStripMenuItem("开机时启动");
        readonly SynchronizationContext ui;
        readonly bool background;
        readonly bool withoutNode;
        readonly HotkeyWindow hotkey;
        IntPtr job = IntPtr.Zero;
        Process node;
        PetWindow pet;
        string site;
        string helperUrl;
        string pendingUpdate;
        string balloonOpens;
        bool paused;
        bool quitting;
        int restarts;

        public Tray(bool background, bool withoutNode, string siteOverride)
        {
            this.background = background;
            this.withoutNode = withoutNode;
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            site = Origin(siteOverride) ?? ConfiguredSite();
            if (site != null) helperUrl = site + "/helper?pet=1";

            var menu = new ContextMenuStrip();
            petItem.Click += (s, e) => TogglePet();
            menu.Items.Add(petItem);
            menu.Items.Add("打开 Crossline 网页", null, (s, e) => { if (site != null) OpenInBrowser(site + "/"); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(statusItem);
            pauseItem.Click += (s, e) => Send(paused ? "resume" : "pause");
            menu.Items.Add(pauseItem);
            menu.Items.Add("节点设置与登录", null, (s, e) => Send("open"));
            updateItem.Click += (s, e) => { if (pendingUpdate != null) ConfirmUpdate(); else Send("check-update"); };
            menu.Items.Add(updateItem);
            autostartItem.Checked = AutostartEnabled();
            autostartItem.Click += (s, e) => { SetAutostart(!autostartItem.Checked); autostartItem.Checked = AutostartEnabled(); };
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出 Crossline 节点", null, (s, e) => Quit());
            icon.ContextMenuStrip = menu;
            icon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            icon.Text = "Crossline 节点";
            icon.Visible = true;
            icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) TogglePet(); };
            icon.BalloonTipClicked += (s, e) =>
            {
                if (balloonOpens == "update") { if (pendingUpdate != null) ConfirmUpdate(); }
                else if (balloonOpens != null && balloonOpens.StartsWith("https://")) OpenInBrowser(balloonOpens);
            };

            hotkey = new HotkeyWindow(TogglePet);
            petItem.Text = hotkey.Registered ? "显示小帮手（Ctrl+Alt+H）" : "显示小帮手";
            if (!hotkey.Registered)
                icon.ShowBalloonTip(8000, "Crossline 节点", "Ctrl+Alt+H 已被另一个程序占用，小帮手只能从托盘图标唤出。关掉那个程序的快捷键后重启节点即可。", ToolTipIcon.Info);

            job = CreateKillOnCloseJob();
            if (!withoutNode) StartNode();
            if (PetWindow.SavedVisible() && helperUrl != null) ShowPet();
        }

        // ---- the 小帮手 window --------------------------------------------------------------------------------------------------
        void TogglePet()
        {
            if (pet != null && !pet.IsDisposed && pet.Visible) { pet.HideAndRemember(); petItem.Checked = false; return; }
            ShowPet();
        }

        void ShowPet()
        {
            if (helperUrl == null) { icon.ShowBalloonTip(5000, "Crossline 节点", "节点还在启动，稍后再唤出小帮手。", ToolTipIcon.Info); return; }
            if (pet == null || pet.IsDisposed)
            {
                pet = new PetWindow(site, helperUrl, OpenInBrowser, message => icon.ShowBalloonTip(10000, "Crossline 小帮手", message, ToolTipIcon.Warning));
                pet.VisibleChanged += (s, e) => petItem.Checked = pet != null && !pet.IsDisposed && pet.Visible;
            }
            pet.ShowAndRemember();
            petItem.Checked = true;
        }

        // ---- the node program ---------------------------------------------------------------------------------------------------
        void StartNode()
        {
            var nodeExe = Path.Combine(AppDir, "node.exe");
            var main = Path.Combine(AppDir, "main.mjs");
            var arguments = "\"" + main + "\" --tray" + (background ? " --autostart" : "") + (site != null ? " --site " + site : "");
            var info = new ProcessStartInfo(nodeExe, arguments)
            {
                WorkingDirectory = AppDir, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8
            };
            node = new Process { StartInfo = info, EnableRaisingEvents = true };
            node.OutputDataReceived += (s, e) => { if (e.Data != null) ui.Post(_ => OnEvent(e.Data), null); };
            node.ErrorDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
            node.Exited += (s, e) => ui.Post(_ => OnNodeExit(), null);
            node.Start();
            if (job != IntPtr.Zero) AssignProcessToJobObject(job, node.Handle);
            node.BeginOutputReadLine();
            node.BeginErrorReadLine();
        }

        void OnNodeExit()
        {
            if (quitting) { Application.Exit(); return; }
            statusItem.Text = "节点：已停止";
            pauseItem.Enabled = false;
            if (++restarts > 5) { icon.ShowBalloonTip(10000, "Crossline 节点", "节点多次启动失败，日志在 " + Path.Combine(Home, "logs") + "。", ToolTipIcon.Error); return; }
            var timer = new System.Windows.Forms.Timer { Interval = 3000 };
            timer.Tick += (s, e) => { timer.Stop(); timer.Dispose(); StartNode(); };
            timer.Start();
        }

        internal static string Field(string line, string name)
        {
            var match = Regex.Match(line, "\"" + name + "\":\"((?:[^\"\\\\]|\\\\.)*)\"");
            return match.Success ? Regex.Unescape(match.Groups[1].Value) : null;
        }
        static bool Flag(string line, string name) { return Regex.IsMatch(line, "\"" + name + "\":true"); }

        static readonly System.Collections.Generic.Dictionary<string, string> StateWords = new System.Collections.Generic.Dictionary<string, string>
        {
            { "ready", "已接入，替网页版干活" }, { "connecting", "正在连接网页版" }, { "waiting", "连接断开，稍后自动重连" },
            { "refused", "网页版没有接受" }, { "off", "未运行" }
        };

        void OnEvent(string line)
        {
            var type = Field(line, "type");
            if (type == "ready")
            {
                restarts = 0;
                var reported = Origin(Field(line, "site"));
                if (reported != null && reported != site)
                {
                    site = reported;
                    helperUrl = site + "/helper?pet=1";
                    if (pet != null && !pet.IsDisposed) pet.Retarget(site, helperUrl);
                }
                if (PetWindow.SavedVisible() && (pet == null || pet.IsDisposed)) ShowPet();
                return;
            }
            if (type == "status")
            {
                paused = Flag(line, "paused");
                var state = Field(line, "state") ?? "off";
                string words;
                if (!Flag(line, "paired")) words = "等待配对";
                else if (!Flag(line, "signedIn")) words = "等待登录 ChatGPT";
                else if (paused) words = "已暂停";
                else words = StateWords.ContainsKey(state) ? StateWords[state] : state;
                statusItem.Text = "节点：" + words;
                icon.Text = Truncate("Crossline 节点：" + words, 63);
                pauseItem.Enabled = Flag(line, "paired") && Flag(line, "signedIn");
                pauseItem.Text = paused ? "继续提供算力" : "暂停算力";
                return;
            }
            if (type == "update-none") { icon.ShowBalloonTip(5000, "Crossline 节点", "已是最新版本。", ToolTipIcon.Info); return; }
            if (type == "update-failed") { icon.ShowBalloonTip(8000, "Crossline 节点", "更新没有完成：" + (Field(line, "code") ?? "未知原因"), ToolTipIcon.Warning); return; }
            if (type == "update-discontinued")
            {
                var link = Field(line, "link");
                balloonOpens = link != null && link.StartsWith("https://") ? link : null;
                icon.ShowBalloonTip(20000, "Crossline 节点", Field(line, "notice") ?? "", ToolTipIcon.Info);
                return;
            }
            if (type == "update-available")
            {
                balloonOpens = "update";
                pendingUpdate = Field(line, "version");
                updateItem.Text = "更新到 " + pendingUpdate;
                icon.ShowBalloonTip(15000, "Crossline 节点有新版本", "新版本 " + pendingUpdate + " 可以安装，点这里更新。", ToolTipIcon.Info);
                return;
            }
            if (type == "update-ready")
            {
                // The node checked the download against the signed manifest (apps/launcher/src/update.ts); only then is a path sent.
                var installer = Field(line, "path");
                if (installer == null || !File.Exists(installer)) return;
                quitting = true;
                Send("quit");
                if (node != null) node.WaitForExit(15000);
                if (pet != null && !pet.IsDisposed) pet.Close();
                Process.Start(new ProcessStartInfo(installer, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART") { UseShellExecute = true });
                icon.Visible = false;
                Application.Exit();
            }
        }

        static string Truncate(string text, int max) { return text.Length <= max ? text : text.Substring(0, max - 1) + "…"; }

        void ConfirmUpdate()
        {
            var answer = MessageBox.Show("更新到 " + pendingUpdate + "？更新时节点会停一两分钟，模型工作暂时回到服务器。",
                "Crossline 节点更新", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (answer == DialogResult.OK) { icon.ShowBalloonTip(5000, "Crossline 节点", "正在下载新版本……", ToolTipIcon.Info); Send("install-update"); }
        }

        void Send(string command)
        {
            try { if (node != null && !node.HasExited) { node.StandardInput.WriteLine(command); node.StandardInput.Flush(); } }
            catch (IOException) { }
            catch (InvalidOperationException) { }
        }

        void Quit()
        {
            quitting = true;
            Send("quit");
            icon.Visible = false;
            if (pet != null && !pet.IsDisposed) pet.Close();
            if (node == null || node.HasExited || !node.WaitForExit(10000)) Application.Exit();
        }

        // ---- helpers --------------------------------------------------------------------------------------------------------------
        /** An https origin (or http on this computer, for a local test site); anything else is not a site the window may load. */
        internal static string Origin(string value)
        {
            Uri uri;
            if (value == null || !Uri.TryCreate(value, UriKind.Absolute, out uri)) return null;
            if (uri.Scheme == "https" || (uri.Scheme == "http" && (uri.Host == "127.0.0.1" || uri.Host == "localhost")))
                return uri.GetLeftPart(UriPartial.Authority);
            return null;
        }

        /** The site from the node's own state (node.json), written when the installer first started it with `--site`. */
        static string ConfiguredSite()
        {
            try { return Origin(Field(File.ReadAllText(Path.Combine(Home, "node.json")), "site")); }
            catch (IOException) { return null; }
        }

        internal static void OpenInBrowser(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || (uri.Scheme != "https" && uri.Scheme != "http")) return;
            try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); } catch (System.ComponentModel.Win32Exception) { }
        }

        public static void OpenRunningPage()
        {
            try
            {
                var text = File.ReadAllText(Path.Combine(Home, "node.lock"));
                var port = Regex.Match(text, "\"port\":\\s*(\\d+)");
                if (port.Success) OpenInBrowser("http://127.0.0.1:" + port.Groups[1].Value + "/");
            }
            catch (IOException) { }
        }

        static void Log(string line)
        {
            try { var dir = Path.Combine(Home, "logs"); Directory.CreateDirectory(dir); File.AppendAllText(Path.Combine(dir, "node.err.log"), line + Environment.NewLine); }
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

        public void Dispose()
        {
            icon.Visible = false;
            icon.Dispose();
            hotkey.Dispose();
            if (job != IntPtr.Zero) CloseHandle(job);
        }

        // ---- Ctrl+Alt+H anywhere in Windows: a hidden message-only window receives WM_HOTKEY ---------------------------------------
        sealed class HotkeyWindow : NativeWindow, IDisposable
        {
            const int WM_HOTKEY = 0x0312;
            const int Id = 0x4E48; // "NH"
            const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_NOREPEAT = 0x4000;
            static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);
            readonly Action onPress;
            public readonly bool Registered;

            public HotkeyWindow(Action onPress)
            {
                this.onPress = onPress;
                CreateHandle(new CreateParams { Parent = HWND_MESSAGE });
                // Another program already holding Ctrl+Alt+H (the installed copy's tray included) leaves only the tray icon; nothing is taken.
                Registered = RegisterHotKey(Handle, Id, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, (uint)Keys.H);
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == Id) { onPress(); return; }
                base.WndProc(ref m);
            }

            public void Dispose()
            {
                if (Registered) UnregisterHotKey(Handle, Id);
                DestroyHandle();
            }

            [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
            [DllImport("user32.dll", SetLastError = true)] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        }

        // ---- job object: the node and its Codex die with the tray -------------------------------------------------------------------
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

    /**
     * The 小帮手 on the desktop. Pet mode: no frame, above other windows, out of the taskbar, and cut (a window region) to what the page
     * draws — the figure, the bubble, the small input, the menu — which it reports as rectangles; everything else is not part of the
     * window, so it is neither drawn nor in the way of clicks. A colour key was tried first (2026-10-28): it drew the right shape, but
     * WebView2 draws through DirectComposition, so to Windows every pixel was the key colour and every click went through to the window
     * behind. Any other page of the site (the sign-in) is shown in an ordinary window.
     *
     * The page talks to it with `chrome.webview.postMessage`: {type:"shape", rects:[[x,y,w,h,r],…]} sets the cut (CSS px), {type:"drag"}
     * moves the window with the pointer, {type:"open", path} opens a page of the site in the person's browser, {type:"hide"} hides it. It tells the page where the pointer is (anywhere on the screen, so the
     * figure can look at it) and how long the computer has had no input (so it dozes when the person is away, not only from this window).
     */
    sealed class PetWindow : Form
    {
        /** Shown in the few px around each piece (the pad that keeps the breathing and the hop from being clipped): the page's paper. */
        static readonly Color Paper = Color.White;
        /** CSS px added around each reported piece. */
        const int ShapePad = 4;
        static readonly Size PetSize = new Size(340, 540);
        static readonly Size SignInSize = new Size(480, 720);
        static string StateFile { get { return Path.Combine(Tray.Home, "pet.json"); } }

        readonly WebView2 view = new WebView2();
        readonly Action<string> openInBrowser;
        readonly Action<string> warn;
        readonly System.Windows.Forms.Timer pointer = new System.Windows.Forms.Timer { Interval = 120 };
        string site;
        string helperUrl;
        bool petMode = true;
        bool ready;
        Point lastPointer = new Point(int.MinValue, int.MinValue);
        long lastIdleBucket = -1;

        public PetWindow(string site, string helperUrl, Action<string> openInBrowser, Action<string> warn)
        {
            this.site = site;
            this.helperUrl = helperUrl;
            this.openInBrowser = openInBrowser;
            this.warn = warn;
            Text = "Crossline 小帮手";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.Dpi;
            view.Dock = DockStyle.Fill;
            Controls.Add(view);
            // The window handle first, so its DPI is the screen's (WindowDpi) and not 96.
            CreateHandle();
            ApplyPetMode(true);
            Location = SavedLocation(Size);
            LocationChanged += (s, e) => { if (petMode && Visible) Save(); };
            pointer.Tick += (s, e) => TellPage();
            FormClosing += (s, e) =>
            {
                // The close box of the sign-in window, or Alt+F4 on the pet: hidden, not destroyed, so the session stays.
                if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; HideAndRemember(); }
            };
            Start();
        }

        async void Start()
        {
            try
            {
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Tray.Home, "webview2"));
                await view.EnsureCoreWebView2Async(environment);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                warn("这台电脑没有 WebView2 运行时，小帮手窗口打不开。点托盘菜单「打开 Crossline 网页」也能用；安装运行时后重启节点即可。");
                openInBrowser("https://developer.microsoft.com/microsoft-edge/webview2/");
                return;
            }
            catch (Exception error)
            {
                warn("小帮手窗口没能打开：" + error.Message);
                return;
            }
            view.DefaultBackgroundColor = Color.Transparent;
            var core = view.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.NewWindowRequested += (s, e) => { e.Handled = true; openInBrowser(e.Uri); };
            core.NavigationStarting += OnNavigationStarting;
            core.SourceChanged += (s, e) => OnSource(core.Source);
            core.WebMessageReceived += OnMessage;
            ready = true;
            view.Source = new Uri(helperUrl);
            pointer.Start();
        }

        public void Retarget(string newSite, string newHelperUrl)
        {
            site = newSite;
            helperUrl = newHelperUrl;
            if (ready) view.Source = new Uri(helperUrl);
        }

        /**
         * The 小帮手 page is the pet; anything else is an ordinary window. The site's sign-in lands on Today, not where it came from, so
         * the first page of the site after a sign-in page goes back to the 小帮手 — once, so a 小帮手 the site sends on (the interview,
         * before the start standard) stays where the site put it.
         */
        bool signingIn;
        void OnSource(string url)
        {
            Uri uri;
            if (Uri.TryCreate(url, UriKind.Absolute, out uri) && uri.GetLeftPart(UriPartial.Authority) == site)
            {
                var path = uri.AbsolutePath;
                if (path == "/login" || path.StartsWith("/auth/") || path.StartsWith("/api/auth")) signingIn = true;
                else if (signingIn && path != "/helper") { signingIn = false; view.Source = new Uri(helperUrl); return; }
            }
            ApplyPetMode(IsHelper(url));
        }

        bool IsHelper(string url)
        {
            Uri uri;
            return Uri.TryCreate(url, UriKind.Absolute, out uri) && uri.GetLeftPart(UriPartial.Authority) == site && uri.AbsolutePath == "/helper";
        }

        void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            Uri uri;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri)) { e.Cancel = true; return; }
            var sameSite = uri.GetLeftPart(UriPartial.Authority) == site;
            // The 小帮手 stays on the 小帮手: another page of the site opened from it goes to the person's browser, unless it is the
            // sign-in the site sent this window to (then it is shown here, in an ordinary window, until the site comes back).
            if (sameSite) return;
            // Off the site: a sign-in provider during sign-in may load here over https; from the pet itself, everything goes outside.
            if (uri.Scheme == "https" && !petMode) return;
            e.Cancel = true;
            openInBrowser(e.Uri);
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json;
            try { json = e.WebMessageAsJson; } catch (ArgumentException) { return; }
            var type = Tray.Field(json, "type");
            if (type == "drag" && petMode) StartDrag();
            else if (type == "open")
            {
                var path = Tray.Field(json, "path");
                if (path != null && path.StartsWith("/") && !path.StartsWith("//")) openInBrowser(site + path);
            }
            else if (type == "hide") HideAndRemember();
            else if (type == "shape" && petMode) ApplyShape(json);
        }

        static readonly Regex ShapeRect = new Regex(@"\[(-?\d+),(-?\d+),(\d+),(\d+),(\d+)\]");

        /** Cuts the window to the reported pieces, each a rounded rectangle padded by ShapePad, in this window's own pixels. */
        void ApplyShape(string json)
        {
            var scale = WindowDpi() / 96.0;
            var path = new System.Drawing.Drawing2D.GraphicsPath(System.Drawing.Drawing2D.FillMode.Winding);
            var any = false;
            foreach (Match rect in ShapeRect.Matches(json))
            {
                var x = (float)((int.Parse(rect.Groups[1].Value) - ShapePad) * scale);
                var y = (float)((int.Parse(rect.Groups[2].Value) - ShapePad) * scale);
                var w = (float)((int.Parse(rect.Groups[3].Value) + 2 * ShapePad) * scale);
                var h = (float)((int.Parse(rect.Groups[4].Value) + 2 * ShapePad) * scale);
                var d = Math.Min(Math.Min(w, h), (float)((int.Parse(rect.Groups[5].Value) + ShapePad) * 2 * scale));
                if (w < 1 || h < 1) continue;
                any = true;
                // Each piece its own figure; with the winding rule, overlapping pieces add up instead of cancelling out.
                path.StartFigure();
                if (d < 2) path.AddRectangle(new RectangleF(x, y, w, h));
                else
                {
                    path.AddArc(x, y, d, d, 180, 90);
                    path.AddArc(x + w - d, y, d, d, 270, 90);
                    path.AddArc(x + w - d, y + h - d, d, d, 0, 90);
                    path.AddArc(x, y + h - d, d, d, 90, 90);
                    path.CloseFigure();
                }
            }
            if (!any) { path.Dispose(); return; }
            var previous = Region;
            Region = new Region(path);
            path.Dispose();
            if (previous != null) previous.Dispose();
        }

        /**
         * Moves the window with the pointer until the button is let go. The mouse is captured by WebView2's own window in another
         * process, so the usual WM_NCLBUTTONDOWN/HTCAPTION hand-off never starts a move (tried 2026-10-28); the cursor is followed instead.
         */
        readonly System.Windows.Forms.Timer dragging = new System.Windows.Forms.Timer { Interval = 15 };
        Point dragOffset;
        void StartDrag()
        {
            if (dragging.Enabled) return;
            var cursor = Cursor.Position;
            dragOffset = new Point(cursor.X - Left, cursor.Y - Top);
            dragging.Tick -= OnDragTick;
            dragging.Tick += OnDragTick;
            dragging.Start();
        }
        void OnDragTick(object sender, EventArgs e)
        {
            if ((MouseButtons & MouseButtons.Left) == 0) { dragging.Stop(); Save(); return; }
            var cursor = Cursor.Position;
            Location = new Point(cursor.X - dragOffset.X, cursor.Y - dragOffset.Y);
        }

        /** Where the pointer is (relative to this window, in its CSS pixels) and the computer's idle time, sent when they change. */
        void TellPage()
        {
            if (!ready || !Visible || !petMode || view.CoreWebView2 == null) return;
            var at = PointToClient(Cursor.Position);
            var scale = WindowDpi() / 96.0;
            if (Math.Abs(at.X - lastPointer.X) + Math.Abs(at.Y - lastPointer.Y) >= 4)
            {
                lastPointer = at;
                Post("{\"type\":\"pointer\",\"x\":" + (int)(at.X / scale) + ",\"y\":" + (int)(at.Y / scale) + "}");
            }
            var idle = IdleMilliseconds();
            var bucket = idle / 15000;
            if (bucket != lastIdleBucket) { lastIdleBucket = bucket; Post("{\"type\":\"idle\",\"ms\":" + idle + "}"); }
        }

        void Post(string json)
        {
            try { view.CoreWebView2.PostWebMessageAsJson(json); } catch (InvalidOperationException) { } catch (COMException) { }
        }

        void ApplyPetMode(bool pet)
        {
            if (pet == petMode && ready) return;
            petMode = pet;
            SuspendLayout();
            if (pet)
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                TopMost = true;
                BackColor = Paper;
                Size = Scaled(PetSize);
                Location = SavedLocation(Size);
                // Until the page says what it draws: only the corner where the figure stands.
                var corner = Scaled(new Size(140, 190));
                Region = new Region(new Rectangle(Width - corner.Width, Height - corner.Height, corner.Width, corner.Height));
            }
            else
            {
                Region = null;
                BackColor = SystemColors.Window;
                FormBorderStyle = FormBorderStyle.Sizable;
                ShowInTaskbar = true;
                TopMost = false;
                Size = Scaled(SignInSize);
                var area = Screen.FromPoint(Cursor.Position).WorkingArea;
                Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + (area.Height - Height) / 2);
                Activate();
            }
            ResumeLayout();
        }

        Size Scaled(Size size)
        {
            var scale = WindowDpi() / 96.0;
            return new Size((int)(size.Width * scale), (int)(size.Height * scale));
        }

        public void ShowAndRemember()
        {
            Show();
            if (petMode) Location = SavedLocation(Size);
            Activate();
            Save();
        }

        public void HideAndRemember() { Hide(); Save(); }

        // ---- where it stands, kept in %LOCALAPPDATA%\Crossline Node\pet.json ------------------------------------------------------
        void Save()
        {
            if (!petMode && Visible) return;
            try
            {
                Directory.CreateDirectory(Tray.Home);
                var place = petMode ? Location : SavedLocation(Scaled(PetSize));
                File.WriteAllText(StateFile, "{\"x\":" + place.X + ",\"y\":" + place.Y + ",\"visible\":" + (Visible ? "true" : "false") + "}");
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        /** Shown at the last start unless the person hid it; the first start shows it. */
        public static bool SavedVisible()
        {
            try { return !Regex.IsMatch(File.ReadAllText(StateFile), "\"visible\":false"); }
            catch (IOException) { return true; }
        }

        /** The saved place, kept on a screen that still exists (a monitor unplugged since); bottom right of the main screen otherwise. */
        static Point SavedLocation(Size size)
        {
            var area = Screen.PrimaryScreen.WorkingArea;
            var fallback = new Point(area.Right - size.Width - 16, area.Bottom - size.Height - 8);
            try
            {
                var text = File.ReadAllText(StateFile);
                var x = Regex.Match(text, "\"x\":(-?\\d+)");
                var y = Regex.Match(text, "\"y\":(-?\\d+)");
                if (!x.Success || !y.Success) return fallback;
                var place = new Point(int.Parse(x.Groups[1].Value), int.Parse(y.Groups[1].Value));
                // At least the figure's corner (bottom right) must be on some screen.
                var corner = new Point(place.X + size.Width - 60, place.Y + size.Height - 60);
                foreach (var screen in Screen.AllScreens) if (screen.WorkingArea.Contains(corner)) return place;
                return fallback;
            }
            catch (IOException) { return fallback; }
            catch (FormatException) { return fallback; }
            catch (OverflowException) { return fallback; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x80; // WS_EX_TOOLWINDOW: not in Alt+Tab while it is a pet
                return cp;
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { pointer.Dispose(); dragging.Dispose(); view.Dispose(); }
            base.Dispose(disposing);
        }

        // ---- Win32 -------------------------------------------------------------------------------------------------------------
        // .NET Framework's DeviceDpi stays 96 without an app.config opt-in; the window's own DPI is asked for directly.
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hWnd);
        double WindowDpi()
        {
            try { var dpi = GetDpiForWindow(Handle); return dpi > 0 ? dpi : 96; } catch (EntryPointNotFoundException) { return 96; }
        }
        [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

        static long IdleMilliseconds()
        {
            var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
            if (!GetLastInputInfo(ref info)) return 0;
            return Math.Max(0, (long)(uint)Environment.TickCount - info.dwTime);
        }
    }
}
