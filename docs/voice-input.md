# 语音输入

每个自由文字框右下角都有一个麦克风：小帮手和今日页的输入框、任务与时段卡片里的对话、访谈（开场卡、每一轮回答、卡片上的「用一句话说」）、主线卡片里的访谈，以及各处的备注、原因、回答与说明。2026-11-02 与本人分三轮确认（见文末「决定」）。

## 怎么用

- 点一下开始，再点一下结束；按住超过 0.4 秒则松开即结束。面板上 ✓ 结束，× 或 Esc 取消。最长 3 分钟，到时自动结束。
- 浏览器自带识别时，面板实时显示听到的字；本机或服务器识别时显示音量条和计时。
- 结束后先把识别原文插到光标处（中文之间不加空格，两个拉丁词之间加一个）；纠错开着时几秒后替换为纠正后的文字，面板显示「已纠正 N 处 · 恢复原文」。这几秒里本人改动过这段文字，就不替换。
- 同一时刻只有一个文字框在录音；在另一个框点麦克风会先结束前一个。

不放麦克风的框：搜索、网址、邮箱服务器、邀请码、数字、密码与 API key、远程登录的键入框、登录与注册表单、出行地址。

## 识别引擎（`apps/web/app/ui/voice/voice-model.ts` `chooseEngine`）

1. **浏览器自带**（Web Speech API）：Chrome 交给 Google，Edge 交给 Microsoft，Safari 交给 Apple。不用下载，延迟最低，能实时出字。
2. **Crossline 自己的 SenseVoice**，浏览器没有识别或识别坏了时使用：
   - iPhone 主屏幕上的 App（WebKit bug 225298：standalone 模式下识别不工作）、Firefox（没有实现）；
   - 这个标签页里浏览器识别报过 `network` / `service-not-allowed` / `language-not-supported`（桌面壳常见），之后不再试它（`sessionStorage crossline.voice.browserBroken`）。
   - 托管版：录音（16 kHz 单声道 16 位 PCM，页面里重采样）经 `/api/voice/transcribe` 写到 `<data>/dictation/upload/<ws>/`，worker 移进 `dictation/inbox/`，`crossline-transcriber` 容器先于录音转写处理它（优先锁），结果写到 `outbox/<id>.json`，worker 每 200 ms 看一次，最多等 90 秒。容器每 30 秒写一次 `transcriber.alive`，超过 90 秒没写就算不可用。最近 10 分钟有过听写时容器不退出、模型常驻。
   - 本机安装版：worker 进程里直接跑 SenseVoice。模型（约 240 MB，Hugging Face，按 sha256 校验）只在本人点「下载模型」后下载（`POST /v1/voice/model {consent:true}`）。
3. 两者都不可用时，面板说明这个浏览器不能语音输入。

**系统麦克风静音**（`microphoneMuted`，2026-11-02）：开始录音时另开一路不做降噪的麦克风流读 1.2 秒（Safari 除外），音轨 `muted` 或采样严格为 0 就当场在录音条上说「这台电脑的麦克风处于静音…」，结束时也用这句代替「没有听清」。真麦克风在安静房间里也有底噪，严格的 0 只出现在系统静音时。本人的笔记本上「麦克风阵列 (Realtek)」在 Windows 里被静音，所有浏览器和识别都只回 `no-speech`；当天先加的「浏览器识别没出字就改用录音交给 SenseVoice」兜底建立在错误的判断上，又让流程多出下载、说明、再说一遍几步，已撤回（本人：「不如之前的按住输入，点按切换」）。

录音不保存：浏览器引擎的音频由浏览器交给它的厂商，Crossline 收不到；自家引擎的片段读完即删，每分钟清掉 2 分钟以上的残留（`sweep`），`dictation/` 不进备份（`deploy/server/backup.sh`）。

## 纠错（Skill `crossline-dictation-corrector`，低档，`INTERACTIVE_SKILLS` 优先级）

- 只改听错的字词、名称与代号、数字写法、标点和口头填充词（嗯、那个）；不改写、不润色、不增删意思。`validateDictationCorrection`（`packages/core/src/dictation.ts`）拒绝改动过多的回答（长度变到原文的一半以下或一倍半以上，或与原文的相似度低于 0.35–0.6，原文越长要求越高），先让模型重答，仍不行或失败就保留原文（`kept: "raw"`），从不阻塞输入。
- 上下文：本人的主线、项目、任务和里程碑名称（`dictationTerms`），当前页面所指的任务或主线，以及「语音输入用词」（下一节）。
- 设置 → 通用「语音输入」里可关（`voice.preferences.correct`），关了就不调模型。用的是本人的模型额度。

## 记住本人的改法

听写进框后，本人在那段文字里做的修改（失焦时或那段被改断时比较一次，5 分钟后不再跟踪）由 `lexiconEdits` 算出「听成 → 改成」的词对，经 `/api/voice/lexicon` 存为偏好（来源 `dictation`，范围 `dictation`，`refId dictation:<听成>`，同一听法只留最新一条，两边都不超过 16 个字）。只有纠错的提示读它（`dictationWordings`，最多 40 条）；别的模型上下文不读。设置 → 个性化里按「语音输入用词」列出，可逐条删除。

## 设置（`voice.preferences`，`apps/web/app/settings/voice-card.tsx`）

- 麦克风：开启 / 关闭（关闭后所有框都不显示麦克风）。
- 识别语言：跟随界面 / 普通话 / English / 粤语（`speechLang`）。普通话夹英文词选普通话即可。
- 纠正错字：开启（默认）/ 关闭。

首次在某个引擎上使用时先说明录音去哪、是否保存、纠错用额度（`localStorage crossline.voice.notice.<engine>`），点「开始说话」才开麦克风。

## 路由

| 路由 | 作用 |
|---|---|
| `GET /api/voice` → `/v1/voice/status` | 模式（server / local）、自家引擎状态、偏好 |
| `POST /api/voice/transcribe` | 原始 PCM（≥0.2 秒、≤3 分钟、偶数字节） |
| `POST /api/voice/correct` | 纠错；关闭时直接返回原文（`kept: "off"`） |
| `POST /api/voice/lexicon` | 记住本人的改法 |
| `POST /api/voice/model` | 本机安装版下载模型（需 `consent: true`） |
| `POST /api/settings/voice` | 三项设置 |

所有写入路由先过 `isCrossSiteWrite`；worker 的 `/v1/voice/*` 校验文件名（`^[a-z0-9-]{8,40}\.pcm$`，只认本工作区的上传目录）。

## 调研与取舍（2026-11-02）

- **浏览器自带识别**免费、即时，但音频发给浏览器厂商，iOS 主屏 App 与 Firefox 不可用，桌面壳常报 `network`。所以它是第一选择而不是唯一选择，首次使用时说清去向。
- **大模型网页端的做法**（ChatGPT、Claude、Gemini 的听写）：录完整段再识别，不做逐字实时；准确率靠强识别模型加上下文。**专门的听写应用**（Wispr Flow、Typeless、Superwhisper）在识别后再用一个语言模型清理：去填充词、改标点、按个人词典纠正名称，并从本人的改动里学词。我们采用后一种的「识别 + 轻纠错 + 个人词表」，但只纠错不改写：改写会把本人的原话变成模型的话，访谈和备注要的是原话。
- **先原文后替换**：不让模型的几秒等待挡住输入，也给本人看得见、撤得回的改动。
- **SenseVoice** 已在服务器上用于录音转写（`docs/phone-recording.md`），复用同一模型与容器，不另起一个识别服务；本机安装版没有浏览器识别时按需下载同一模型。

## 决定（2026-11-02，本人）

浏览器优先、自家兜底；先原文再替换；只纠错不改写；名称词表加记住改动；本机下载 SenseVoice；点按切换加长按松开；所有自由文字框；最长 3 分钟；语言跟随界面、设置可改；首次说明、音频即删。
