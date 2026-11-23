# 本地版自带窗口（2026-11-23 设计，本人已确认）

本人原话：「crossline本地版应该有内置的窗口和界面，而不是要求一定要打开网页，否则访谈过程中授权文件夹等操作都不可行」。

目标：本地版（`docs/plans/desktop-local-1122.md`，托盘 + 启动器 + web 14892 + worker 14893）打开就是 Crossline 自己的窗口，不再依赖浏览器；本机才有的操作在窗口里直接完成，首先是访谈里授权文件夹：系统自带的选文件夹对话框，拿到真实完整路径，交给本地 worker。

## 0. 结论

- **外壳：在现有托盘 `Crossline.exe`（C#，系统自带 `csc` 编译）里加一个 WebView2 窗口。** 不引入 Electron、不引入 Tauri。安装包只多约 1 MB，不加新的工具链。
- **窗口只显示本机页面**（`http://127.0.0.1:<web 端口>`），任何别的地址都交给系统默认浏览器打开，不在窗口里加载。
- **桥只有四个操作**：选文件夹、在资源管理器里打开文件夹、托盘通知、读外壳版本。页面拿不到读写文件、执行程序、打开任意地址的能力。
- **托管版和浏览器里打开本地版，一切照旧**：页面看不到桥，就走现在的做法（托管版浏览器上传，本机浏览器手填路径）。

## 1. 现状与问题

- 托盘收到启动器的 `open` 事件后 `Process.Start(url)`，用默认浏览器打开页面；小帮手（Ctrl+Alt+H）用 `msedge --app=…/helper`。
- 访谈左栏有两个文件夹入口：
  - 「选择文件夹」（`apps/web/app/onboarding/folder-picker.tsx`）：浏览器的选文件夹，**拿不到路径**，只能把文件挑出来上传成副本（托管版的做法）。
  - 「授权文件夹」卡（`apps/web/app/connectors/source-folders.tsx`）：只在 `127.0.0.1`/`localhost` 显示，要本人**手动粘贴完整路径**，再「查看」→ 预览 → 授权。worker（`apps/worker/src/source-folders.ts`）按路径读、访谈按需读（D3）。
- 浏览器没有任何办法拿到真实路径，所以本地版在访谈里授权文件夹要么上传副本（失去 D3 按需读和增量重读），要么让人去资源管理器「复制为路径」再粘贴。这就是本人说的「不可行」。

## 2. 外壳选型

| | WebView2 嵌进现有 C# 托盘（推荐） | Electron | Tauri |
|---|---|---|---|
| 安装包增量 | ≈1 MB（`Microsoft.Web.WebView2.Core.dll`、`.WinForms.dll`、`WebView2Loader.dll`） | ≈80–100 MB（自带 Chromium + 第二份 Node） | ≈5–10 MB |
| Windows 依赖 | WebView2 运行时（Win11 自带；Win10 经 Edge 更新推送；本机已有 157.0） | 无 | 同样要 WebView2 运行时 |
| 构建工具 | 现有：系统 `csc`（.NET Framework 4.x）；打包时从 nuget.org 取固定版本的 SDK 包并核对 SHA-256 | npm 包 + electron-builder，或手工拼 | Rust + tauri-cli（本机有 cargo，但 Codex 的 release 构建已要三小时以上，再加一个 Rust 工程） |
| 进程结构 | 不变：托盘仍是唯一的父进程和作业对象持有者 | 要把托盘、启动器的职责搬进 Electron 主进程，或者三层嵌套 | 同 Electron，或者托盘之外再多一个进程 |
| 维护 | 一个 C# 文件里多约 300 行；WebView2 运行时随 Edge 自动更新，安全补丁不用我们发版 | Electron 每 8 周一个大版本，跟不上就带着旧 Chromium 的漏洞 | Tauri 大版本迁移、Rust 依赖 |
| 原生能力 | WinForms + COM 直接调（选文件夹对话框、资源管理器、托盘气泡都已在这个进程里） | 有现成 API | 有现成 API |

推荐 WebView2 嵌进托盘：增量最小，没有新工具链，进程结构不变，浏览器内核的安全更新由系统负责。代价是依赖 WebView2 运行时；缺运行时时退回现在的浏览器（第 5 节），并提示去安装。

## 3. 窗口和启动器、web、worker 的关系

不改启动器的职责（端口、密钥、守护 web 与 worker、更新），只改托盘：

- **启动**：托盘照旧启动启动器。启动器发 `ready`/`open` 时，托盘不再开浏览器，而是显示主窗口（首次创建，之后前置）。web 还没就绪时窗口先显示「Crossline 正在启动」，就绪后再导航。
- **第二次启动**（开始菜单、桌面快捷方式、托盘已在运行）：现在是用浏览器打开页面；改为通过命名事件 `Local\CrosslineShowWindow` 叫醒已在运行的托盘，把它的窗口前置。
- **关闭窗口 = 隐藏到托盘**，web 和 worker 继续跑（排程、提醒、后台读文件夹都在 worker 里，关窗口不该停）。第一次关闭时托盘气泡说一次「Crossline 仍在后台运行，从托盘菜单退出」。真正退出走托盘菜单「退出 Crossline」，和现在一样整组进程随作业对象结束。
- **开机自启**（`--background`）：只起托盘和服务，不弹窗口；双击托盘图标或开始菜单打开窗口。
- **小帮手**（Ctrl+Alt+H、托盘菜单）：改为第二个小 WebView2 窗口（380×560，置顶可选），不再依赖 Edge 的 `--app`；和主窗口共用同一份登录状态和同一个桥。没有 WebView2 时退回 Edge 的 `--app`。
- **小帮手的图标是本人的形象**（本人 2026-11-23 补充）：托盘读不了账本，所以 web 在小帮手读取形象时（`helperState`）把当前形象的文件名写到 `data\portrait\<ws>\desktop-face.txt`（只在本地版写，`noteDesktopFace`）；托盘监视这个文件，取形象图上方的正方形、裁成圆形作小帮手窗口的图标。没有形象时用应用自己的图标。
- **托盘菜单**：「打开 Crossline」（窗口）、「在浏览器中打开」（新增，保留老路）、「打开小帮手」、检查更新、开机时启动、打开数据文件夹、退出。
- **窗口状态**：大小、位置、是否最大化存在 `%LOCALAPPDATA%\Crossline\state\window.json`。
- **WebView2 的用户数据**（cookie、缓存、离线队列、权限）放在 `%LOCALAPPDATA%\Crossline\state\webview2\`：不在 `app\`（更新会整个替换），不在 `data\`（不进备份）；卸载时选「删除数据」会随 `state\` 一起删。窗口和浏览器的 cookie 不共享，所以窗口里要登录一次；本地版的登录是本机 Codex 账号一键签发（`codex-local.ts`），Codex 已登录时就是点一下。

## 4. 桥接口

页面与外壳之间只用 WebView2 的 `postMessage`（`window.chrome.webview.postMessage` ↔ `WebMessageReceived`），不用 `AddHostObjectToScript`（那会把一个 COM 对象整个暴露给页面）。外壳在文档创建时注入一小段脚本，定义 `window.crosslineDesktop`；页面侧封装在 `apps/web/lib/desktop-bridge.ts`。

请求 `{ id, op, args }`，回复 `{ id, ok, result | code }`。**白名单（外壳的 `switch` 只认这四个，其余一律 `DESKTOP_OP_UNKNOWN`）：**

| op | 参数 | 做什么 | 限制 |
|---|---|---|---|
| `info` | 无 | 返回 `{ shell: "webview2", version }` | 无 |
| `pickFolder` | `{ title? }` | 打开系统的选文件夹对话框（Vista 式 `IFileOpenDialog` + `FOS_PICKFOLDERS`，就是资源管理器那种），返回本人选的完整路径或 `cancelled` | 只返回本人在对话框里亲手选的路径；同一时间只允许一个对话框；外壳不读这个文件夹里的任何东西，路径照旧交给 `/api/sources/folders` → worker，由 worker 的规则（拒绝盘符根、用户目录、系统目录、自己的数据目录，滤密钥和私密文件）决定能不能授权 |
| `openFolder` | `{ path }` | 用资源管理器打开一个文件夹 | 只接受**本机盘符下已存在的文件夹**（`X:\…` 且 `Directory.Exists`；`\\server\share` 这类网络路径拒绝，免得资源管理器去连外部主机时交出本人的 Windows 凭据哈希），以 `explorer.exe "<path>"` 打开；文件、程序、URL、`shell:` 之类一律拒绝（`DESKTOP_NOT_A_FOLDER`），所以不能借它运行任何东西 |
| `notify` | `{ title, text, path? }` | 托盘气泡，点击回到窗口里的 `path` | 文字截断到 64/200 字；`path` 必须以 `/` 开头，是本应用自己的页面 |

此外外壳对页面做的固定处理（不是页面可以调用的接口）：

- **导航锁在本机源**：`NavigationStarting` 里，目标不是 `http://127.0.0.1:<web 端口>` 的一律取消；其中 `http`/`https`/`mailto` 交给系统默认浏览器打开，其余协议（`file:`、`ms-settings:`、自定义协议）直接丢弃。`NewWindowRequested`（`window.open`、`target=_blank`）同样处理。Codex 登录的 `window.open(authUrl)` 就这样去了默认浏览器，OpenAI 的同意页回调到 Codex 自己的 `localhost:1455`，窗口里的登录页照旧轮询就完成。
- **只信本机源的消息**：`WebMessageReceived` 先核对 `e.Source` 的源等于本机源，否则不处理。因为导航已经锁死，正常情况下不会有别的源，这是第二道。
- **权限**：`PermissionRequested` 里，本机源的麦克风（录音、语音输入）、摄像头（精力采样，仍受它自己的同意开关）、通知、剪贴板读取允许；其余（定位、MIDI、窗口管理等）拒绝；非本机源一律拒绝。
- **下载**：WebView2 默认的下载条，存到本人的「下载」文件夹（材料、草稿、导出文件的下载链接照旧能用）。
- **开发者工具、右键「检查」**：关闭；外壳带 `--devtools` 启动时打开（排查用）。

## 5. 退回现在的行为

- `desktop-bridge.ts` 的 `desktopShell()`：`window.crosslineDesktop` 不存在就返回 `undefined`。页面上的所有新入口都以它为条件，没有桥就是现在的界面。
- **托管版**：窗口只加载本机源，托管站永远不会在窗口里打开，也就永远拿不到桥。
- **浏览器打开本地版**（托盘「在浏览器中打开」，或本人自己开）：没有桥，照旧是「选择文件夹」上传 + 授权文件夹卡手填路径。
- **缺 WebView2 运行时**：托盘创建窗口失败时回到现在的做法（默认浏览器打开），并气泡一次「没有找到 WebView2 运行时，已用浏览器打开；安装后即有独立窗口」，点击打开微软的 WebView2 下载页（https）。

## 6. 页面上的改动

窗口里（有桥时）：

- **访谈左栏「选择文件夹」**：弹系统对话框，拿到路径，**直接授权**（`/api/sources/folders` 的 `add`，用默认规则），不再上传副本，也不再预览确认（与 2026-11-22 定的「按下即决定」一致）。之后的顺序是本人 2026-11-23 定的：**先由规则滤掉敏感文件**（密钥永不读，像私密证件单据的默认不读，worker 的 `scanFolder` 现有规则）→ **再由模型按文件名、格式、大小、日期筛出有用的**（`createFolderScreener`，同一个 `crossline-folder-classifier` Skill，只看名称不看内容）→ **把留下的导入**（`importScreenedFiles`，读入时仍逐个文件复查密钥和证件号）。没有模型答复时（额度用尽、Codex 未登录）文件先留在清单里，下一轮再筛；Skill 失败时退回最近改动的若干个。授权后文件夹出现在下面的「授权文件夹」卡里，排除列表、主线、撤销都在那里改；没被留下的文件访谈仍能按需打开（D3）。
  - 这一条改了 D3 在本机上的做法：D3 原来是「本机授权文件夹只列清单、不导入」，现在本机也和设备模式一样「列清单 → 模型筛 → 导入留下的」。为了不让同一台电脑上两种授权方式行为不同，手填路径授权的文件夹也走同样的筛选导入。
- **授权文件夹卡**：路径输入框旁加「浏览…」按钮，选完把路径填进输入框并直接「查看」（这里保留预览，供想先看再授权的时候用）。每个已授权文件夹加「打开文件夹」（`openFolder`）。
- **设置 → 日历与连接、`/device` 页**：用的是同一张授权文件夹卡，自动得到上面两项。
- **录音**：页面的 `getUserMedia` 在窗口里由第 4 节的权限处理放行；文件夹里已有录音的本机转写不受影响（worker 做）。
- **报名表的可见窗口、读本人登录的网站**：这些是 worker 另开的 Edge/Chrome（Crossline 自己的浏览器配置），和本窗口无关，照旧可用；它们打开的是独立的可见浏览器窗口，本人在那里自己登录、自己点提交。
- **Codex 登录**：第 4 节的 `window.open` 转默认浏览器。

## 7. 对 `CLAUDE.md` 安全边界的影响

- **没有新的对外写入**：桥不发任何网络请求，不写日历、不发布、不交易、不外联。
- **没有新的本机读写**：外壳不读、不写、不列任何文件。选文件夹只返回本人在系统对话框里亲手选的路径，授权仍由 worker 的现有规则判断，页面不能悄悄给自己一个路径（页面本来就能手填路径，桥没有扩大这个能力，只是省去复制粘贴）。
- **不能执行任何东西**：`openFolder` 只开已存在的文件夹；导航和新窗口只放 `http`/`https`/`mailto` 去默认浏览器。
- **摄像头**：边界不变——仍只在桌面、仍是它自己的同意（`energy.camera`），帧仍在页面里处理，不存不传；窗口只是把麦克风、摄像头的权限限定在本机源。
- **页面不能拿到任意本机权限**：桥是一个固定的 `switch`，新增操作要改 C# 并重新打包；`apps/web/lib/desktop-bridge.test.ts` 用发现式测试核对 C# 里处理的操作和 TS 里的 `DESKTOP_OPS` 完全一致，多一个少一个都失败。

`CLAUDE.md` 的「Safety boundaries」加一条：本地版窗口的桥只有上表四个操作，导航锁在本机源；放宽任何一条需要本人另外决定。

## 8. 打包

- `scripts/package-installer.ts`：从 nuget.org 下载固定版本的 `Microsoft.Web.WebView2` 包（版本 1.0.4370.26 和 SHA-256 写在脚本里，缓存在 `dist/installer/cache/`，哈希不符即 `WEBVIEW2_SDK_HASH_MISMATCH` 中止；用 Windows 自带的 `tar.exe` 解包），取 `lib/net462/Microsoft.Web.WebView2.Core.dll`、`.WinForms.dll` 和 `runtimes/win-x64/native/WebView2Loader.dll`，编译托盘时 `-r:` 引用，三个 DLL 放在 `Crossline.exe` 旁边；SDK 的许可证放进 `licenses\`。不随包带 WebView2 运行时（固定版运行时 150 MB 以上）。
- `installer/crossline.iss` 不用改：`app\` 整个随包。
- 托盘仍用 `csc` 编译（`-platform:x64`，`Crossline.cs` + `AppWindow.cs`），C# 5 语法（系统 `csc` 的上限），不用 `async`/`await` 之外的新语法。

## 9. 测试与验收

- 单元测试（`pnpm test`）：
  - `apps/web/lib/desktop-bridge.test.ts`：没有桥时返回 `undefined`；请求按 id 对上回复；超时；回复的错误码原样交给调用方；**发现式**：从 `installer/tray/*.cs` 的 `bridge-ops:begin`…`end` 之间读出 `case "…"` 的操作，等于 `DESKTOP_OPS`。
  - `apps/worker/src/folder-classifier.test.ts`：筛选器的答复映射（留下的、没跑成的留到下一轮、其余失败退回最近改动的）。
  - `apps/web/lib/helper.test.ts`：只在本地版写 `desktop-face.txt`，换形象时跟着换。
  - 打包脚本里 WebView2 包的哈希核对在打包时执行（不符即中止），没有单独的单元测试。
- `pnpm typecheck`、`pnpm test` 通过。
- 实机（本机）：`--personal` 打包、`install-personal.ps1` 安装 → 打开即窗口 → 访谈左栏「选择文件夹」弹系统对话框 → 授权文件夹卡出现该路径并开始读 → 关窗口后托盘还在、worker 继续 → 第二次双击图标窗口前置 → 托盘「在浏览器中打开」仍可用 → 窗口里点外链去默认浏览器。

## 10. 本人的决定（2026-11-23）

1. 外壳：WebView2 嵌进现有托盘。
2. 关窗口：隐藏到托盘，后台继续跑。
3. 窗口里「选择文件夹」：选完直接授权；先规则筛敏感信息，再由模型按标题名称等筛有用的，然后导入（见第 6 节）。
4. 打包时从 nuget.org 下载固定版本、核对哈希的 WebView2 SDK 包：可以。
