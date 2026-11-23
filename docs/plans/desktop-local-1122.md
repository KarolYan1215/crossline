# 桌面本地版（只给本人用，2026-11-22）

本人要一个双击就能启动的 Crossline 本地版：数据在这台电脑上，模型用本人自己的 Codex 登录。本文是清单和结果：第一节是 `origin/main` 上更新完的内容，第二节是网页端（托管内测）做不到、本地版能做的功能，第三节是怎么构建、安装和更新。

基线：`origin/main` d3f04d416f；装在本机的 0.3.1 已含画像深度（`docs/plans/portrait-depth-1122.md`，main 7bd159ec4f）。

## 〇、本地版是什么

- **就是原来的「安装版」**（docs/local-installer.md）：`%LOCALAPPDATA%\Crossline\app`，托盘 `Crossline.exe` 启动启动器，启动器守护 web（127.0.0.1:14892）和 worker（Codex supervisor 14893），子进程带 `CROSSLINE_INSTALL_MODE=local`，只能用本机 Codex 的 ChatGPT 登录。
- 安装版在 2026-10-28 停发（只对外停发）。本次给打包脚本加了 `--personal`：不发布、不签名、没有更新源、没有使用记录回传，只装在这台电脑上（`scripts/install-personal.ps1`）。停发的决定对其他人不变。
- **完整模式，不是设备模式。** 常驻版（127.0.0.1:3210）仍是托管站的「设备」（docs/device-mode.md），本次不动它。本地版没有 `data/device/link.json`，所以 worker 跑全部模型工作（`apps/worker/src/device/mode.ts` 的 `full`），所有页面都在本机。
- 本地版和托管站是两本账：两边各自跑模型，同一个 ChatGPT 额度会花两遍，两边的内容会分叉。这是本地版本身的代价，不是缺陷。

## 一、更新完的内容（origin/main）

状态：✅ 在本地版里检查过可用；⚠️ 能用但有限制；⏸ 未检查（写明原因）。

### 访谈与导入重做（`docs/plans/2026-11-22-interview-and-import-redesign.md`，D1–D19）

| # | 内容 | 本地版 |
|---|---|---|
| D1 | 量表换成 IPIP-NEO-120 + TwIVI，访谈开场前的整页步骤（`apps/web/app/onboarding/scale-step.tsx`） | 见第四节 |
| D2 | 访谈回到 Codex 原生：一条长线程、自由文本回复、卡片和账本写入走工具 | 见第四节 |
| D3 | 本机授权文件夹不导入，访谈用 `list_folder` / `read_folder_file` 按需读 | 见第四节 |
| D4/D5 | 访谈底本与顺序（量表 → 人生经历 → 现状 → 未来）写在 Skill 里 | 随 Skill 打包，见第四节 |
| D6 | 语气固定客观冷静，不再选语气 | 见第四节 |
| D7 | 开场先列主线；末段每条主线写五年奥德赛 | 见第四节 |
| D8/D16 | 岔题交调研层，当场核实与后台深查分开 | 见第四节 |
| D9 | 整理层：24 维自由笔记 + 少量结构字段 | 见第四节 |
| D10 | 右栏活画像；开始门槛只剩「一条主线 + 一个里程碑」 | 见第四节 |
| D11 | 旧版本文件原件留库，访谈只看摘要和差异 | 见第四节 |
| D12 | 系统不生成 16 型 | 见第四节 |
| D13 | 画像和右栏不显示依据条数和置信度 | 见第四节 |
| D14 | AI 历史对话可导入（ChatGPT 导出、Codex rollout、Claude Code jsonl） | 见第二节 B6 |
| D15 | 授权文件夹跳过敏感个人文件；直接上传的证件号、卡号、账号先打码；密钥一律拒收 | 见第四节 |
| D17 | 中途插话：默认排队，可插进当前轮 | 见第四节 |
| D18 | 全系统「应交模型却写死」清单 | 随代码打包，单元测试覆盖 |
| D19 | 本人可选模型和思考强度 | 见第四节 |

### 其他近期改动（2026-11-17 到 11-22）

注意力账第 1–6 批（只推要本人动手的、先做后告、成果文件夹与系统验收、机会/动态/文献进周复盘）、Crossline 作为 MCP server（个人令牌、OAuth）、小红书收藏话题工作流内置、自动化失败暂停与自检、清空数据后撤回日历未来事件、走查 W-273～W-313 的修复。这些都在同一份代码里，随本地版一起打包，单元测试覆盖；页面上的检查见第四节。

### 画像深度（`docs/plans/portrait-depth-1122.md`）

✅ 在 0.3.1 里：`/api/portrait/narrative` 和画像页的「人生叙事与洞察」都在安装包里。这一节只在有叙事时出现；本机账本里现有的第 7 版画像写于改动之前，仍带原来的类型卡，下一次重写画像后才按新规则（无 16 型）。

## 二、网页端做不到、本地版能做的

判断依据：托管内测设 `CROSSLINE_PUBLIC_BETA=1`。web 用 `isHostedBeta()`（`apps/web/lib/hosting.ts`），worker 用 `hostedBeta` / `machineOwner`（`apps/worker/src/index.ts:321-322`），共享的是 `assistantAvailable`（`packages/db/src/skills.ts:274`）。凡是读「这台电脑」的东西，在托管站一律关掉；本地版不设这个变量，又是这台机器唯一的工作区（`runtimeOwner`），所以都打开。几乎所有本地路径的代码都已经存在，本次补的代码见各项「改动」。

「边界」一栏指 `CLAUDE.md` 的安全边界。本地版没有放宽任何一条：这些功能在托管站是因为「服务器不是本人的电脑」才关的，边界本身（同意开关、可见窗口、只写 Crossline 日历等）在本地版照样执行。

### A. 读这台电脑

| # | 功能 | 网页为什么做不到 | 本地版怎么做 | 边界 | 本地版 |
|---|---|---|---|---|---|
| A1 | 屏幕活动（前台应用、窗口标题） | 服务器看不到本人的屏幕；托管站 `MACHINE_OWNER_ONLY` | PowerShell 读前台窗口（`activity-source.ts`），设置 → 隐私里自己的同意，默认关 | 无（隐私：标题不离开本机） | ✅ 开关在，默认关（未替本人打开） |
| A2 | 作息记录（长时间空闲） | 同上 | 同一读取器记 4 小时以上的空闲段，单独同意 | 无 | ✅ 开关在，默认关 |
| A3 | 键鼠节律 | 同上 | `GetLastInputInfo` 每秒一次，只留刻钟合计 | 无 | ✅ 开关在，默认关 |
| A4 | 拟计时（按屏幕记录起草时长） | 依赖 A1 | `time-drafts.ts` | 无 | ⏸ 依赖 A1，A1 未开 |
| A5 | Codex / Claude Code 使用时间 | 服务器读不到本人的 `~/.codex`、`~/.claude` | `agent-history.ts`，只读时间戳和目录名，单独同意 | 无 | ✅ 开关在，默认关 |
| A6 | 授权文件夹 | 服务器读不到本机路径（`FOLDER_OWNER_ONLY`） | `source-folders.ts`：本人给路径，代码先滤密钥和私密文件；2026-11-23 起本地版是自带窗口，「选择文件夹」弹系统对话框直接授权，规则滤敏感 → 模型按名称筛 → 导入留下的（`docs/plans/desktop-window-1123.md`） | 无 | ✅ 设置 → 日历与连接、访谈左栏都有入口 |
| A7 | 访谈按需读文件夹（D3） | 网页只能先筛后上传 | 访谈线程的 `list_folder` / `read_folder_file`，越界路径拒绝 | 无 | ⏸ 本人访谈已到第 5/5 阶段，未替本人跑新一轮 |
| A8 | 文件夹自动归线 | 依赖 A6 | `createFolderClassifier` | 无 | ⏸ 依赖 A6，本次没有新授权文件夹 |
| A9 | 文件夹里的录音自动转写 | 服务器读不到；托管站只有夜间转写容器 | 本机 Whisper / SenseVoice，单独同意，音频不离开本机 | 麦克风（只转写已有文件，不开麦） | ✅ 卡片在，默认关 |

### B. 在这台电脑上执行

| # | 功能 | 网页为什么做不到 | 本地版怎么做 | 边界 | 本地版 |
|---|---|---|---|---|---|
| B1 | 能执行命令的助手（`crossline-agent`，danger-full-access） | 服务器上执行命令等于在别人的账本旁边开 shell | 本机 Codex，任务目录或 worktree，守卫（`agent-guard.ts`）照旧；按类别开关 | shell | ✅ 助手能力开关与近期任务在；类别由本人开 |
| B2 | 长出工作流（`skill-creator`）和「建成自动化」 | 依赖 B1 | 同 B1 | shell | ✅ 工作流区在（0 个） |
| B3 | 读本人登录的网站（小红书收藏等） | 服务器没有本人的浏览器 | Crossline 自己的浏览器配置（`browser-profiles`），本人自己登录，可见窗口 | 无（只读，限速，熔断） | ⏸ 要本人自己在 Crossline 的浏览器里登录 |
| B4 | 报名表单填写 | 服务器没有屏幕（`FORM_NEEDS_SCREEN`） | 可见窗口、每站自己的配置；规则照 `CLAUDE.md` | 表单 | ⏸ 开发和测试不得对真站提交（`CLAUDE.md`） |
| B5 | Windows 桌面通知 | 服务器只能推手机 | WinRT toast（`notify.ts`） | 无 | ⏸ 未触发通知 |
| B6 | AI 历史对话从本机位置导入（D14） | 服务器读不到本机，只能上传导出文件 | 把 `C:\Users\<你>\.codex\sessions`、`~\.claude\projects` 或放 `conversations.json` 的文件夹授权给 Crossline。**改动**：按需模式下，文件夹里的对话记录照样读入并逐段摘要，不再只列清单（`apps/worker/src/source-folders.ts`，测试在 `source-folders.test.ts`） | 无 | ✅ 单元测试；真实目录由本人授权 |
| B7 | 开机自启 | 服务器没有本人的登录会话 | HKCU Run（`autostart.ts`，设置 → 通用） | 无 | ✅ 设置 → 通用有开关（关） |
| B8 | 访谈下一轮就绪时托盘气泡 | 网页没有托盘 | `@crossline:notify` → 启动器 → 托盘 | 无 | ⏸ 未跑新一轮访谈 |
| B9 | 本机模型提供方（Ollama、LM Studio） | 服务器的 loopback 是服务器自己 | `allowLoopback`（`model-provider.ts`） | 无 | ⏸ 本机未装 Ollama / LM Studio |
| B10 | 后台最优排程（HiGHS） | 托管站为省内存关了 | 本地默认开 | 无 | ✅ worker 日志有求解结果（`solver.*`） |
| B11 | 模型并发、访客运行时上限 | 托管站限 2 并发 | 本地不限 | 无 | ✅ 未设 `CROSSLINE_PUBLIC_BETA` |

### C. 登录、日历与连接

| # | 功能 | 网页为什么做不到 | 本地版怎么做 | 边界 | 本地版 |
|---|---|---|---|---|---|
| C1 | 本机 Codex 的 ChatGPT 浏览器登录 | 回调到 Codex 自己的 localhost:1455，服务器上打不开 | 本地版登录页就是这一条（`codex-local.ts`） | 无 | ✅ 已登录（ChatGPT Plus），supervisor ready |
| C2 | Outlook 日历读取（Graph） | 托管站没有配 Entra 应用 | 打包时带上本人的 `CROSSLINE_MS_CLIENT_ID`，本人用设备码登录一次 | 日历（读：无） | ⚠️ 应用 ID 已打进 `release.json`；worker 报 `graph.not_signed_in`，要本人在设置里登录一次 |
| C3 | 写 Crossline 日历（Graph） | 同上 | `calendar-publish.ts`，写入账号单独登录（`scripts/graph-write-login.ts`），只写名为 Crossline 的日历 | 日历写入（不放宽） | ⚠️ 写入账号登录已过期（设置里「去修复」），要本人重新登录 |
| C4 | 摄像头精力采样 | 网页同样能做（不受托管限制） | 不变：桌面、单独同意、帧不离开页面 | 摄像头（不放宽） | 不属于网页限制 |

### D. 不做的，及原因

| # | 项 | 为什么不做 |
|---|---|---|
| D-1 | 手机访问与推送 | 手机要连到这台电脑，需要 Tailscale 和 https 来源（docs/local-installer.md「已知限制」）。手机上用托管站即可；本地版只在这台电脑上用 |
| D-2 | MCP 的 stdio 传输 | docs/mcp-server.md §3.1 已定：stdio 只会是一个带令牌的 HTTP 代理，没有新能力。本地版的 `http://127.0.0.1:14892/api/mcp` 直接给 Claude Code、Codex 用（URL + Bearer）。claude.ai 和 ChatGPT 的连接器要公网 https，本来就连不到本机 |
| D-3 | 第三方模型的记忆、生图、原生联网 | 这是模型提供方的限制，与网页无关；本人的 Codex 登录本来就有 |
| D-4 | Sign in with ChatGPT | 本地版只用本机 Codex 的登录（`isLocalInstall` 关掉邮箱、Google、SIWC），不需要第二种 |
| D-5 | 使用记录回传 | 只给本人用，`--personal` 不带回传地址 |
| D-6 | 删除账号 | 本机就是本人的，`ACCOUNT_DELETE_LOCAL` 照旧拒绝；要清空就卸载并选删除数据 |
| D-7 | 自动更新 | `--personal` 没有更新源；更新就按第三节重建、重装 |

## 三、构建、安装、更新

要求：Node 22+、pnpm、Visual Studio（或 Build Tools，提供 VC++ 运行库和 dumpbin）、Inno Setup 6，以及主检出里已经编好的 Codex release（`vendor\codex\codex-rs\target\release\codex.exe`，哈希要等于 `CODEX_RELEASE_BINARY_SHA256`）。

```powershell
pnpm build:prod
```

```powershell
pnpm exec tsx scripts/package-installer.ts --personal --skip-web-build --version 0.3.1 --codex-dir C:\Users\karol\Documents\ChatGPT\Multi-ID\vendor\codex\codex-rs\target\release
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-personal.ps1 -Setup dist\installer\Crossline-Personal-0.3.1.exe
```

`install-personal.ps1` 先停掉正在运行的本地版，把 `data\` 复制到 `backups\before-personal-<时间>`（保留最近三份），再静默安装并在桌面放快捷方式，安装结束自动启动托盘。打包时如果环境里有 `CROSSLINE_MS_CLIENT_ID` / `CROSSLINE_MS_TENANT_ID`，会写进 `release.json`，Outlook 日历才能用。

从 Claude 桌面会话里运行时，会话是 MSIX 容器，写 `%LOCALAPPDATA%` 会落进虚拟目录：要用 WMI（`Win32_Process Create`）在容器外启动安装脚本，启动应用用 `Start-Process explorer.exe '"%LOCALAPPDATA%\Crossline\app\Crossline.exe"'`。

## 四、验证结果

2026-11-22 在这台电脑上装好 `Crossline-Personal-0.3.0`（基线 d3f04d416f），同晚合入画像深度后重装为 0.3.1（备份 `backups\before-personal-20261122-215735`），桌面有快捷方式，托盘、启动器、web（14892）、worker（14893）都在跑。

**本次改动**

- `scripts/package-installer.ts`：`--personal`；`--codex-dir`（工作树没有自己的 Rust 构建，指向主检出的 `target/release`，照样核哈希）；补拷 `apps/web/lib/csp-policy.mjs` 和 `apps/web/solver-thread.mjs`。这两个文件 `next start` 在构建产物之外直接加载，原来没打进包：第一次安装时 web 起不来（`Cannot find module …\csp-policy.mjs imported from next.config.mjs`）。
- `scripts/bundle-installed.ts`：worker 白名单的包名正则加数字，并放行 `packages/i18n/locales/**.json`。i18n 加进来以后打包就过不了（`INSTALLED_BUNDLE_TOO_WIDE`），这是停发后没人打包才没发现的。
- `installer/crossline.iss`：`/DPersonal=1` 时输出名为 `Crossline-Personal-<版本>`。
- `apps/worker/src/source-folders.ts`：B6。
- `scripts/install-personal.ps1` / `.cmd`：先备份 `data\` 再静默安装。

**检查**

- `pnpm typecheck`、`pnpm test` 通过（682 个文件，4563 通过，5 跳过）。
- `/api/health` 200；`/api/codex/account`：ChatGPT 登录、supervisor `ready`。worker 日志 `codex.supervisor.ready` 的 `runtimeOwner` 是本机工作区，即完整模式，本机功能都打开。
- 页面：今日、设置（通用、日历与连接、隐私与屏幕活动、精力、录音转写、后台任务、自动化与助手）、访谈（三栏、文件与文件夹、长期目标、右栏已记下）、自动化、小帮手、Agent 产出、计划、待确认、画像都能打开，内容是本机账本。
- 第一节 D1–D19：都在同一份代码里，单元测试覆盖。本人的访谈已到第 5/5 阶段，所以量表页（D1）、开场列主线（D7）、新的一轮（D2、D8、D17）这次没有在页面上重走；要重走就在本地版里新开一次访谈。模型与强度（D19）在设置 → 模型连接里可选。

**要本人做的**

1. Outlook 日历（C2、C3）：设置 → 日历与连接，读取用设备码登录一次；写入 Crossline 日历的账号「去修复」重新登录。
2. 想用的本机功能（A1–A9、B1）自己在设置里打开：都默认关，本次没有替本人打开任何同意。
3. 数据：本地版现在用的是它自己原来的账本（10 月中以后没用过，启动时已迁移到当前结构）。要把托管站的账本搬过来，先退出托盘，在容器外跑（目标里原来的工作区会被替换，`install-personal` 已在 `backups\before-personal-20261122-191922` 留了一份）：

```powershell
pnpm exec tsx scripts/migrate-workspace.ts --from-db C:\Users\karol\Documents\ChatGPT\Multi-ID\data\crossline.db --from-data C:\Users\karol\Documents\ChatGPT\Multi-ID\data --workspace bf8be609-f217-4c34-88fc-6bd354c7c4d7 --to-db $env:LOCALAPPDATA\Crossline\data\crossline.db --to-data $env:LOCALAPPDATA\Crossline\data --replace
```

不加 `--apply` 是试运行；看过输出再加 `--apply`。常驻版的 `data\` 是托管站的设备镜像，搬之前先让常驻版同步一次。

**发现但没改的**

- 设置 → 隐私里仍显示「使用记录回传」和「诊断快照」。`--personal` 不带回传地址，worker 不会发（`apps/worker/src/index.ts:2267` 只在有 `CROSSLINE_TELEMETRY_URL` 时启动），快照也没有可传的地址；只是这两项在本地版里多余。
