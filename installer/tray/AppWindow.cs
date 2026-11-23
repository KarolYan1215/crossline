// Crossline's own window (docs/plans/desktop-window-1123.md): this app's pages in WebView2, inside the tray process, so the installed copy
// opens as a window and not a browser tab, and what only this computer can do (the system's folder dialog first of all) is done here.
//
// What a page may ask for is the fixed list in `Answer` (between the bridge-ops markers; apps/web/lib/desktop-bridge.test.ts holds it
// equal to DESKTOP_OPS). Nothing here reads, writes or lists a file, runs a program or opens an address for a page. The window shows only
// this app's own origin: any other address goes to the default browser (http, https and mailto only) and never loads here, so no other
// page ever sees the bridge, the microphone or the camera.
//
// C# 5 (the compiler every Windows has): no string interpolation, no `?.`, no `nameof`.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Crossline
{
    /// <summary>What a window needs from the tray.</summary>
    interface IWindowHost
    {
        string Version { get; }
        bool DevTools { get; }
        Task<CoreWebView2Environment> Environment();
        /// <summary>A tray balloon; a click brings the main window back on `path`.</summary>
        void Balloon(string title, string text, string path);
        /// <summary>An address of this origin a page opened in a new window.</summary>
        void OpenOwnPage(string url);
        /// <summary>The main window was hidden by its close button (said once).</summary>
        void Hidden();
    }

    enum WindowKind { Main, Helper, Page }

    sealed class AppWindow : Form
    {
        readonly IWindowHost host;
        readonly WindowKind kind;
        readonly WebView2 view = new WebView2();
        readonly Label waiting = new Label();
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        string origin;
        string pending;
        bool ready;
        bool marked;
        bool pickerOpen;
        public bool Quitting;

        public AppWindow(IWindowHost host, WindowKind kind, Icon icon)
        {
            this.host = host;
            this.kind = kind;
            Text = kind == WindowKind.Helper ? "小帮手" : "Crossline";
            Icon = icon;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.White;
            if (kind == WindowKind.Helper) { ClientSize = new Size(380, 560); StartPosition = FormStartPosition.CenterScreen; }
            else { MinimumSize = new Size(480, 400); WindowPlacement.Restore(this, kind == WindowKind.Main ? "main" : "page"); }
            waiting.Text = "Crossline 正在启动……";
            waiting.Dock = DockStyle.Fill;
            waiting.TextAlign = ContentAlignment.MiddleCenter;
            waiting.Font = new Font("Microsoft YaHei UI", 11f);
            waiting.ForeColor = Color.FromArgb(80, 80, 80);
            view.Dock = DockStyle.Fill;
            view.Visible = false;
            Controls.Add(view);
            Controls.Add(waiting);
            FormClosing += OnClosing;
            Load += (s, e) => Init();
        }

        /// <summary>Shows `url` (this origin) once the view is ready; until then the window says it is starting.</summary>
        public void Navigate(string url)
        {
            if (IsHandleCreated && InvokeRequired) { BeginInvoke(new Action(() => Navigate(url))); return; }
            Uri parsed;
            if (!Uri.TryCreate(url, UriKind.Absolute, out parsed)) return;
            origin = parsed.Scheme + "://" + parsed.Authority;
            if (ready) Go(url);
            else pending = url;
        }

        void Go(string url)
        {
            // The marker the page's desktop-bridge.ts looks for, defined only on this origin's documents; added once the origin is known.
            // The navigation waits for it, and comes back to this window's thread by BeginInvoke: an `await` here resumed on a pool
            // thread in the installed tray (no captured context), and the view may only be touched from its own thread.
            if (!marked)
            {
                marked = true;
                view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                    "(function(){var o=" + json.Serialize(origin) + ";if(location.origin===o&&window.chrome&&window.chrome.webview)"
                    + "Object.defineProperty(window,'crosslineDesktop',{value:Object.freeze({shell:'webview2',version:" + json.Serialize(host.Version) + "})});})();")
                    .ContinueWith(_ => BeginInvoke(new Action(() => { view.CoreWebView2.Navigate(url); ShowView(); })));
                return;
            }
            view.CoreWebView2.Navigate(url);
            ShowView();
        }

        void ShowView() { waiting.Visible = false; view.Visible = true; }

        // No `await` in this window: on .NET Framework a callback run through BeginInvoke has no SynchronizationContext, so an await
        // inside one resumed on a pool thread and touched the view from there (the installed tray crashed with InvalidCastException).
        // Every step comes back to this window's thread by BeginInvoke instead.
        void Init()
        {
            host.Environment().ContinueWith(environment => BeginInvoke(new Action(() =>
            {
                if (environment.IsFaulted) { Failed(environment.Exception); return; }
                try
                {
                    view.EnsureCoreWebView2Async(environment.Result).ContinueWith(ensured => BeginInvoke(new Action(() =>
                    {
                        if (ensured.IsFaulted) Failed(ensured.Exception); else Setup();
                    })));
                }
                catch (Exception error) { Failed(error); }
            })));
        }

        void Failed(Exception error)
        {
            waiting.Text = "Crossline 的窗口没能打开：" + error.GetBaseException().Message;
        }

        void Setup()
        {
            var core = view.CoreWebView2;
            core.Settings.AreDevToolsEnabled = host.DevTools;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.NavigationStarting += (s, e) => { if (!IsOwnOrigin(e.Uri)) { e.Cancel = true; OpenOutside(e.Uri); } };
            core.FrameNavigationStarting += (s, e) => { if (!IsOwnOrigin(e.Uri) && e.Uri != "about:blank" && e.Uri != "about:srcdoc") e.Cancel = true; };
            core.NewWindowRequested += (s, e) =>
            {
                e.Handled = true;
                if (IsOwnOrigin(e.Uri) && !e.Uri.StartsWith("blob:")) host.OpenOwnPage(e.Uri); else OpenOutside(e.Uri);
            };
            core.PermissionRequested += OnPermission;
            core.WebMessageReceived += OnMessage;
            core.DocumentTitleChanged += (s, e) => { if (kind != WindowKind.Helper && !string.IsNullOrEmpty(core.DocumentTitle)) Text = core.DocumentTitle; };
            core.ProcessFailed += (s, e) => { if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited) BeginInvoke(new Action(() => core.Reload())); };
            ready = true;
            if (pending != null) { var url = pending; pending = null; Go(url); }
        }

        /// <summary>This app's own pages: http on the loopback address and the web app's port, and blobs they made.</summary>
        bool IsOwnOrigin(string uri)
        {
            if (origin == null || uri == null) return false;
            if (uri.StartsWith("blob:")) uri = uri.Substring(5);
            Uri parsed;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out parsed)) return false;
            return string.Equals(parsed.Scheme + "://" + parsed.Authority, origin, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Another address: the default browser for http, https and mail; anything else (file:, ms-settings:, a custom scheme) is dropped.</summary>
        static void OpenOutside(string uri)
        {
            Uri parsed;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out parsed)) return;
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeMailto) return;
            try { Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true }); }
            catch (System.ComponentModel.Win32Exception) { }
        }

        void OnPermission(object sender, CoreWebView2PermissionRequestedEventArgs e)
        {
            var allowed = IsOwnOrigin(e.Uri) && (e.PermissionKind == CoreWebView2PermissionKind.Microphone || e.PermissionKind == CoreWebView2PermissionKind.Camera
                || e.PermissionKind == CoreWebView2PermissionKind.Notifications || e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead);
            e.State = allowed ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsOwnOrigin(e.Source)) return;
            Dictionary<string, object> message;
            try { message = json.DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>; }
            catch (ArgumentException) { return; }
            if (message == null || !"desktop".Equals(Value(message, "crossline")) || !(Value(message, "id") is string)) return;
            var id = (string)message["id"];
            var args = Value(message, "args") as Dictionary<string, object> ?? new Dictionary<string, object>();
            // Off the event: a modal dialog inside a WebView2 event handler re-enters it.
            BeginInvoke(new Action(() => Answer(id, Value(message, "op") as string, args)));
        }

        static object Value(Dictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) ? value : null;
        }

        void Answer(string id, string op, Dictionary<string, object> args)
        {
            // bridge-ops:begin
            switch (op)
            {
                case "info":
                    Reply(id, new Dictionary<string, object> { { "shell", "webview2" }, { "version", host.Version } });
                    return;
                case "pickFolder":
                    if (pickerOpen) { Fail(id, "DESKTOP_BUSY"); return; }
                    pickerOpen = true;
                    try
                    {
                        var title = Value(args, "title") as string;
                        var path = FolderDialog.Pick(Handle, title != null && title.Length <= 80 ? title : "选择文件夹");
                        Reply(id, path == null ? new Dictionary<string, object> { { "cancelled", true } } : new Dictionary<string, object> { { "path", path } });
                    }
                    catch (COMException) { Fail(id, "DESKTOP_DIALOG_FAILED"); }
                    finally { pickerOpen = false; }
                    return;
                case "openFolder":
                    var folder = Value(args, "path") as string;
                    if (!LocalFolder(folder)) { Fail(id, "DESKTOP_NOT_A_FOLDER"); return; }
                    Process.Start(new ProcessStartInfo("explorer.exe", "\"" + Path.GetFullPath(folder) + "\"") { UseShellExecute = false });
                    Reply(id, null);
                    return;
                case "notify":
                    var heading = Value(args, "title") as string ?? "Crossline";
                    var text = Value(args, "text") as string ?? "";
                    var page = Value(args, "path") as string;
                    if (page != null && (!page.StartsWith("/") || page.StartsWith("//") || page.Contains("\\"))) page = null;
                    host.Balloon(Cut(heading, 64), Cut(text, 200), page);
                    Reply(id, null);
                    return;
                default:
                    Fail(id, "DESKTOP_OP_UNKNOWN");
                    return;
            }
            // bridge-ops:end
        }

        /// <summary>
        /// An existing folder on a local drive (`D:\…`). A network path is refused: only asking whether `\\host\share` exists makes Windows
        /// connect to that host and offer it the person's sign-in, which a page must never be able to cause.
        /// </summary>
        static bool LocalFolder(string path)
        {
            if (string.IsNullOrEmpty(path) || path.Length > 1000 || !Regex.IsMatch(path, @"^[A-Za-z]:\\") || path.IndexOfAny(Path.GetInvalidPathChars()) >= 0) return false;
            try { return Directory.Exists(path); } catch (Exception) { return false; }
        }

        static string Cut(string value, int length) { return value.Length <= length ? value : value.Substring(0, length); }

        void Reply(string id, object result)
        {
            var body = new Dictionary<string, object> { { "crossline", "desktop" }, { "id", id }, { "ok", true } };
            if (result != null) body["result"] = result;
            Post(body);
        }

        void Fail(string id, string code) { Post(new Dictionary<string, object> { { "crossline", "desktop" }, { "id", id }, { "ok", false }, { "code", code } }); }

        void Post(Dictionary<string, object> body)
        {
            if (view.CoreWebView2 != null && IsOwnOrigin(view.CoreWebView2.Source)) view.CoreWebView2.PostWebMessageAsJson(json.Serialize(body));
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (kind != WindowKind.Helper) WindowPlacement.Save(this, kind == WindowKind.Main ? "main" : "page");
            // The close button hides the main window: the worker keeps the plan, the reminders and the folders going. 退出 is in the tray.
            if (kind == WindowKind.Main && !Quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); host.Hidden(); }
        }

        public void BringToFront(string url)
        {
            if (url != null) Navigate(url);
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }
    }

    /// <summary>Size and place of the windows, kept in state\window.json; a place no screen shows any more is not used.</summary>
    static class WindowPlacement
    {
        static readonly string FilePath = Path.Combine(Tray.Root, "state", "window.json");
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        static Dictionary<string, object> All()
        {
            try { return Json.DeserializeObject(File.ReadAllText(FilePath)) as Dictionary<string, object> ?? new Dictionary<string, object>(); }
            catch (Exception) { return new Dictionary<string, object>(); }
        }

        public static void Restore(Form form, string name)
        {
            object saved;
            var place = All().TryGetValue(name, out saved) ? saved as Dictionary<string, object> : null;
            var bounds = new Rectangle(0, 0, 1280, 860);
            if (place != null)
            {
                try { bounds = new Rectangle(Convert.ToInt32(place["x"]), Convert.ToInt32(place["y"]), Convert.ToInt32(place["w"]), Convert.ToInt32(place["h"])); }
                catch (Exception) { place = null; }
            }
            var area = Screen.PrimaryScreen.WorkingArea;
            if (place == null || !Screen.AllScreens.Any(screen => screen.WorkingArea.IntersectsWith(bounds)))
            {
                bounds.Width = Math.Min(bounds.Width, area.Width - 40);
                bounds.Height = Math.Min(bounds.Height, area.Height - 40);
                bounds.X = area.X + (area.Width - bounds.Width) / 2;
                bounds.Y = area.Y + (area.Height - bounds.Height) / 2;
            }
            form.Bounds = bounds;
            if (place != null && place.ContainsKey("max") && true.Equals(place["max"])) form.WindowState = FormWindowState.Maximized;
        }

        public static void Save(Form form, string name)
        {
            var bounds = form.WindowState == FormWindowState.Normal ? form.Bounds : form.RestoreBounds;
            var all = All();
            all[name] = new Dictionary<string, object> { { "x", bounds.X }, { "y", bounds.Y }, { "w", bounds.Width }, { "h", bounds.Height }, { "max", form.WindowState == FormWindowState.Maximized } };
            try { Directory.CreateDirectory(Path.GetDirectoryName(FilePath)); File.WriteAllText(FilePath, Json.Serialize(all)); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        public static bool Flag(string name)
        {
            object value;
            return All().TryGetValue(name, out value) && true.Equals(value);
        }

        public static void SetFlag(string name)
        {
            var all = All();
            all[name] = true;
            try { Directory.CreateDirectory(Path.GetDirectoryName(FilePath)); File.WriteAllText(FilePath, Json.Serialize(all)); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>The 小帮手 window's icon: the person's figure, as the 小帮手 shows it on the page (the upper part, in a circle).</summary>
    static class Face
    {
        /// <summary>The figure the web app last named in `data\portrait\<workspace>\desktop-face.txt`, or null.</summary>
        public static Icon Load()
        {
            try
            {
                var portrait = Path.Combine(Tray.Root, "data", "portrait");
                if (!Directory.Exists(portrait)) return null;
                var pointer = Directory.GetDirectories(portrait).Select(dir => new FileInfo(Path.Combine(dir, "desktop-face.txt")))
                    .Where(file => file.Exists).OrderByDescending(file => file.LastWriteTimeUtc).FirstOrDefault();
                if (pointer == null) return null;
                var name = File.ReadAllText(pointer.FullName).Trim();
                // The same rule as FIGURE_FILE in @crossline/core: a figure's own name, nothing that leaves the folder.
                if (!Regex.IsMatch(name, @"^(?:v\d+(?:r\d+)?|u\d+)-character\.png$")) return null;
                var image = Path.Combine(pointer.DirectoryName, name);
                if (!File.Exists(image)) return null;
                using (var source = new Bitmap(image)) return Circle(source, 64);
            }
            catch (Exception) { return null; }
        }

        static Icon Circle(Bitmap source, int size)
        {
            // A full-length figure: the top of the picture, as wide as half its height, holds the head and shoulders.
            var side = Math.Min(source.Width, source.Height / 2);
            var crop = new Rectangle((source.Width - side) / 2, 0, side, side);
            using (var bitmap = new Bitmap(size, size))
            {
                using (var graphics = Graphics.FromImage(bitmap))
                using (var clip = new GraphicsPath())
                {
                    graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.Clear(Color.Transparent);
                    clip.AddEllipse(0, 0, size - 1, size - 1);
                    graphics.SetClip(clip);
                    graphics.DrawImage(source, new Rectangle(0, 0, size, size), crop, GraphicsUnit.Pixel);
                }
                var handle = bitmap.GetHicon();
                try { return (Icon)Icon.FromHandle(handle).Clone(); }
                finally { DestroyIcon(handle); }
            }
        }

        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
    }

    /// <summary>The system's folder dialog (the File Explorer one, IFileOpenDialog with FOS_PICKFOLDERS); null when the person cancels.</summary>
    static class FolderDialog
    {
        const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800, FOS_NOCHANGEDIR = 0x8;
        const uint SIGDN_FILESYSPATH = 0x80058000;
        const int ERROR_CANCELLED = unchecked((int)0x800704C7);

        public static string Pick(IntPtr owner, string title)
        {
            var dialog = (IFileDialog)new FileOpenDialogClass();
            try
            {
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
                dialog.SetTitle(title);
                var shown = dialog.Show(owner);
                if (shown == ERROR_CANCELLED) return null;
                if (shown != 0) throw new COMException("IFileDialog.Show", shown);
                IShellItem item;
                dialog.GetResult(out item);
                string path;
                item.GetDisplayName(SIGDN_FILESYSPATH, out path);
                Marshal.ReleaseComObject(item);
                return path;
            }
            finally { Marshal.ReleaseComObject(dialog); }
        }

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        class FileOpenDialogClass { }

        // IModalWindow::Show, then IFileDialog up to GetResult: the vtable order is the interface's, so nothing may be left out before it.
        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint count, IntPtr filters);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem item);
            void SetFolder(IShellItem item);
            void GetFolder(out IShellItem item);
            void GetCurrentSelection(out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult(out IShellItem item);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr context, [MarshalAs(UnmanagedType.LPStruct)] Guid handler, [MarshalAs(UnmanagedType.LPStruct)] Guid iid, out IntPtr result);
            void GetParent(out IShellItem parent);
            void GetDisplayName(uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        }
    }
}
