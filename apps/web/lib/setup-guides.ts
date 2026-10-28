/**
 * The setup guides shown beside each 「接入」/「连接」/「生成令牌」 button in 设置 (2026-10-21, the owner's request: every connection has its
 * tutorial next to its button, by provider, with the official pages and the usual mistakes). Pure data, drawn by `app/ui/setup-guide.tsx`;
 * the field names in the phone guides are the ones `/api/health/sleep`, `/api/capture/shortcut`, `/api/records` and
 * `/api/recordings/upload` actually read (lib/energy.ts `storeHealthSummary`, core `healthRecordsFromPhone`), never invented ones.
 *
 * Every sentence here is a whole Chinese key (docs/i18n.md, rule 2): `SetupGuide` shows each through `t()`, so no sentence is built from
 * pieces; a value to copy (an address, a field name) is its own fact and stays as it is.
 */
export type GuideLink = { label: string; url: string };
/** A value the person copies or types somewhere else: shown whole, selectable, never cut off. */
export type GuideFact = { label: string; value: string };
export type GuideProvider = { id: string; label: string; steps: string[]; facts?: GuideFact[]; links?: GuideLink[]; note?: string | undefined;
  /** A provider that cannot be connected, said as such instead of failing at the button. */
  unsupported?: boolean };
export type GuideProblem = { symptom: string; fix: string };
export type SetupGuideSpec = { title: string; intro?: string; providers: GuideProvider[]; problems?: GuideProblem[] };

const IMAP_PORT: GuideFact = { label: "端口", value: "993（SSL）" };

export const MAIL_GUIDE: SetupGuideSpec = {
  title: "接入教程：各家邮箱的授权码与服务器",
  intro: "邮箱只读接入：用应用专用密码或授权码，不用邮箱的登录密码。填好地址和授权码后点「接入」，先试连一次，连上才保存。",
  providers: [
    { id: "gmail", label: "Gmail", steps: [
      "在电脑浏览器登录要接入的 Google 账号。",
      "打开「两步验证」页面并开启；已开启的跳过这一步。没有两步验证，Google 不提供应用专用密码。",
      "打开「应用专用密码」页面，名称填 Crossline，点「创建」。",
      "页面显示 16 位密码（四组字母）。复制后粘贴到下方「应用专用密码或授权码」一栏，中间的空格可以保留。",
      "地址填完整的 Gmail 地址，点「接入」。"],
    facts: [{ label: "IMAP 服务器", value: "imap.gmail.com" }, IMAP_PORT],
    links: [{ label: "Google 两步验证", url: "https://myaccount.google.com/signinoptions/twosv" }, { label: "Google 应用专用密码", url: "https://myaccount.google.com/apppasswords" }],
    note: "学校或公司的 Google 账号，管理员可能关闭了应用专用密码（页面提示「您要查找的设置不适用于您的账号」），这类账号暂时接不了。" },
    { id: "qq", label: "QQ 邮箱 / Foxmail", steps: [
      "在电脑浏览器登录 QQ 邮箱网页版。",
      "点「设置」→「账号」；新版界面在「账号与安全」→「安全设置」。",
      "找到「POP3/IMAP/SMTP/Exchange/CardDAV 服务」，开启「IMAP/SMTP 服务」。",
      "按提示用绑定的手机发送验证短信，页面显示 16 位授权码。",
      "复制授权码粘贴到下方；地址填 QQ 邮箱地址（数字@qq.com、英文名@qq.com 或 @foxmail.com 都可以），点「接入」。"],
    facts: [{ label: "IMAP 服务器", value: "imap.qq.com" }, IMAP_PORT],
    links: [{ label: "QQ 邮箱网页版", url: "https://mail.qq.com" }],
    note: "授权码只显示一次，忘了就再生成一个。修改 QQ 密码后，旧的授权码可能失效。" },
    { id: "netease", label: "网易 163 / 126 / yeah", steps: [
      "在电脑浏览器登录网易邮箱网页版。",
      "点页面顶部的「设置」→「POP3/SMTP/IMAP」。",
      "开启「IMAP/SMTP 服务」，按提示用手机验证。",
      "点「新增授权密码」，复制显示的授权码。",
      "地址填完整邮箱地址，授权码粘贴到下方，点「接入」。"],
    facts: [{ label: "163 邮箱", value: "imap.163.com" }, { label: "126 邮箱", value: "imap.126.com" }, { label: "yeah 邮箱", value: "imap.yeah.net" }, IMAP_PORT],
    links: [{ label: "163 邮箱网页版", url: "https://mail.163.com" }, { label: "126 邮箱网页版", url: "https://mail.126.com" }],
    note: "授权码被删除或过期后需要重新生成，再移除这个邮箱、用新授权码重新接入。" },
    { id: "icloud", label: "iCloud", steps: [
      "在浏览器登录 Apple 账户页面；Apple 账户需要已开启双重认证。",
      "进入「登录与安全」→「App 专用密码」，点「生成 App 专用密码」，名称填 Crossline。",
      "复制显示的密码（格式 xxxx-xxxx-xxxx-xxxx），粘贴到下方。",
      "地址填 iCloud 邮箱地址（@icloud.com 或 @me.com）。Apple 账户的登录邮箱如果是别家的地址，这里仍填 iCloud 邮箱地址。点「接入」。"],
    facts: [{ label: "IMAP 服务器", value: "imap.mail.me.com" }, IMAP_PORT],
    links: [{ label: "Apple 账户", url: "https://account.apple.com" }] },
    { id: "yahoo", label: "Yahoo", steps: [
      "在浏览器登录 Yahoo 账号的「账号安全」页面。",
      "点「生成应用密码」（Generate app password），名称填 Crossline。",
      "复制显示的密码粘贴到下方，地址填 Yahoo 邮箱地址，点「接入」。"],
    facts: [{ label: "IMAP 服务器", value: "imap.mail.yahoo.com" }, IMAP_PORT],
    links: [{ label: "Yahoo 账号安全", url: "https://login.yahoo.com/account/security" }] },
    { id: "sina", label: "新浪邮箱", steps: [
      "在电脑浏览器登录新浪邮箱网页版。",
      "点「设置」→「客户端 POP/IMAP/SMTP」，开启 IMAP 服务。",
      "按提示生成授权码，复制后粘贴到下方，地址填新浪邮箱地址，点「接入」。"],
    facts: [{ label: "IMAP 服务器", value: "imap.sina.com" }, IMAP_PORT],
    links: [{ label: "新浪邮箱网页版", url: "https://mail.sina.com.cn" }] },
    { id: "aliyun", label: "阿里邮箱（个人版）", steps: [
      "在电脑浏览器登录阿里邮箱网页版。",
      "在「设置」里开启 POP3/SMTP/IMAP 服务。",
      "设置里提供授权码时生成并使用授权码；没有这一项时用邮箱密码。地址填完整邮箱地址，点「接入」。"],
    facts: [{ label: "IMAP 服务器", value: "imap.aliyun.com" }, IMAP_PORT],
    links: [{ label: "阿里邮箱网页版", url: "https://mail.aliyun.com" }] },
    { id: "other", label: "企业与学校邮箱", steps: [
      "向管理员或邮箱帮助页确认两件事：是否允许 IMAP 收信，以及 IMAP 服务器地址。",
      "企业邮箱要求「客户端专用密码」或授权码时，在它的设置里生成；没有这项要求的，用邮箱密码。",
      "填地址和密码后点「接入」。系统认不出这个域名时，表单会多出「IMAP 服务器」一栏：填上第 1 步问到的地址，再点「接入」。"],
    facts: [{ label: "腾讯企业邮", value: "imap.exmail.qq.com" }, { label: "阿里企业邮", value: "imap.qiye.aliyun.com" },
      { label: "网易企业邮", value: "imap.qiye.163.com" }, { label: "端口", value: "993（SSL）" }],
    note: "服务器只接受域名，不接受 IP 地址或内网名称。学校邮箱若是 Microsoft 365（Outlook），见「Outlook / Hotmail / 组织邮箱」一栏，用转发接入；若是 Google（Gmail），按 Gmail 一栏操作。" },
    { id: "outlook", label: "Outlook / Hotmail / 组织邮箱", unsupported: true, steps: [
      "微软已停止用密码读取 Outlook.com、Hotmail、Live 和 Microsoft 365 邮箱，只允许 OAuth 登录；Crossline 暂不支持这类邮箱。多数学校和公司邮箱（如 @wisc.edu）就是 Microsoft 365。",
      "替代办法是转发。先在这里接入一个 Gmail、QQ 或 163 邮箱（Gmail 用应用密码）。",
      "用组织账号登录 Outlook 网页版（学校、公司账号在 outlook.office.com，个人账号在 outlook.live.com），进入「设置」→「邮件」→「转发」。",
      "开启转发，填第 2 步接入的邮箱地址，勾选「保留转发邮件的副本」，点「保存」。",
      "之后组织邮箱收到的新邮件会进那个邮箱，Crossline 每 15 分钟读一次并分拣。转发由本人在 Outlook 里开启和关闭。"],
    links: [{ label: "组织账号转发设置", url: "https://outlook.office.com/mail/options/mail/forwarding" },
      { label: "个人账号转发设置", url: "https://outlook.live.com/mail/0/options/mail/forwarding" }],
    note: "学校或公司可能禁止自动转发到外部地址：Outlook 不让保存，或转发的邮件一直没有到，就是组织策略挡住了，需要向 IT 部门申请。组织日历不受影响，可在「日历与连接」里用设备码或订阅链接接入。" }
  ],
  problems: [
    { symptom: "提示密码不对、认证失败", fix: "多半填的是登录密码，或授权码没复制全。重新生成应用专用密码或授权码，完整粘贴后再接入。" },
    { symptom: "表单多出「IMAP 服务器」一栏", fix: "这个域名不在常见邮箱里。按「企业与学校邮箱」一栏问到服务器地址后填入。" },
    { symptom: "提示连不上服务器", fix: "邮箱还没开启 IMAP，或服务器地址写错。到邮箱的网页版设置里确认已开启 IMAP。" },
    { symptom: "接入后显示「读取失败」", fix: "授权码被删除、过期，或改过账号密码。生成新的授权码，移除这个邮箱，再用新授权码接入。" }
  ]
};

const MAIL_DOMAINS: Record<string, string> = {
  "gmail.com": "gmail", "googlemail.com": "gmail", "qq.com": "qq", "foxmail.com": "qq", "163.com": "netease", "126.com": "netease", "yeah.net": "netease",
  "icloud.com": "icloud", "me.com": "icloud", "mac.com": "icloud", "yahoo.com": "yahoo", "sina.com": "sina", "sina.cn": "sina", "aliyun.com": "aliyun"
};
const MICROSOFT = /(^|\.)(outlook\.com|hotmail\.com|live\.com|msn\.com|office365\.com)$/i;

/** The provider tab a typed address belongs to: a known domain's own, Microsoft's (not supported), else the corporate one; none while unfinished. */
export function mailGuideId(address: string): string | undefined {
  const domain = address.trim().toLowerCase().split("@")[1] ?? "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return undefined;
  return MAIL_DOMAINS[domain] ?? (MICROSOFT.test(domain) ? "outlook" : "other");
}

/** Where the phone posts to: the hosted address, or this computer over the private network. */
export type PhoneBase = { base: string; privateNetwork: boolean };
const networkNote = ({ privateNetwork }: PhoneBase) => privateNetwork ? "手机要连着同一私有网络（Tailscale）才能把数据发到这台电脑。" : undefined;
const shortcutSetup = "在 iPhone「快捷指令」App 底部点「自动化」→ 右上角「+」新建，触发条件选好后选「立即运行」，并关掉「运行前询问」，之后每天无需操作。";

/**
 * 手机健康数据 (docs/energy-and-ecosystem.md §5): sleep, bed and wake moments and the day's readings to `/api/health/sleep`, with the health
 * token. Health Auto Export's own format is read only for weight, dietary energy and workouts (`healthRecordsFromPhone`); sleep and heart
 * rate still come through the shortcut fields.
 */
export function phoneHealthGuide(at: PhoneBase): SetupGuideSpec {
  const url = `${at.base}/api/health/sleep`;
  const request: GuideFact[] = [{ label: "URL", value: url }, { label: "方法", value: "POST" }, { label: "头部", value: "Authorization = Bearer 健康令牌（Bearer 后有一个空格）" },
    { label: "请求体", value: "JSON" }];
  const fields: GuideFact[] = [
    { label: "events", value: "数组，每项 type = bed（入睡）或 wake（起床），at = 时刻（ISO 8601）" },
    { label: "sleep", value: "数组，每段睡眠 start、end（ISO 8601）；一晚的几段会合成一段" },
    { label: "day", value: "日期 yyyy-MM-dd，下列当天数值都记在这一天" },
    { label: "restingHr", value: "静息心率，次/分" }, { label: "hrvMs", value: "心率变异性，毫秒" }, { label: "steps", value: "步数" },
    { label: "daylightMin", value: "日照时间，分钟" }, { label: "wristTempDeltaC", value: "手腕温度与平时的差值，摄氏度（Apple Watch）" },
    { label: "weightKg、kcal、workouts", value: "有健康主线时可加：体重（千克）、当天摄入能量（千卡）、体能训练（每项 id、start、minutes、type）" }];
  return {
    title: "接入教程：手机健康数据",
    intro: "手机把睡眠、起床与入睡时刻和当天的心率、步数、日照发到 Crossline，精力推算据此校准。只保存时刻和当天的汇总数字；缺的字段不填即可。",
    providers: [
      { id: "iphone", label: "iPhone 快捷指令", steps: [
        "在本卡点「生成健康令牌」，复制令牌。令牌只显示这一次，生成即开启「手机健康数据」。",
        shortcutSetup,
        "起床时刻：触发条件选「睡眠」→「醒来」（或「闹钟」→「已停止」）。动作加「获取 URL 内容」，按下方「请求」填写；请求体 JSON 加一个数组 events，内含一个词典：type = wake，at = 「当前日期」（日期格式选 ISO 8601）。",
        "入睡时刻：再建一个自动化，触发条件选「睡眠」→「就寝时间开始」（或打开「睡眠」专注模式时），动作同上，type 改为 bed。",
        "晨间汇总：再建一个自动化，触发条件选「特定时间」每天 9:00。先加「查找健康样本」，类型「睡眠分析」、开始日期在过去 1 天内；用「重复每一项」把每段的开始和结束日期（ISO 8601）写成词典 start、end，加到变量「睡眠」。",
        "同一个自动化里，再用「查找健康样本」取过去 1 天「静息心率」「心率变异性」的平均值，「步数」「日照时间」的总和；有 Apple Watch 时取「手腕温度」。",
        "最后加「获取 URL 内容」，请求同上；请求体 JSON：sleep = 变量「睡眠」，day = 当前日期（格式 yyyy-MM-dd），以及 restingHr、hrvMs、steps、daylightMin、wristTempDeltaC。",
        "在自动化里点一次运行做测试：返回内容里有 \"ok\":true 就是收到了，本卡的「依据」会多出手机记录的晚数。"],
      facts: [...request, ...fields], note: networkNote(at) },
      { id: "auto-export", label: "iPhone · Health Auto Export", steps: [
        "Health Auto Export 是 App Store 上的第三方 App，它的「REST API」自动导出可以替代上面的晨间汇总，只用于体重、膳食能量和体能训练。",
        "在本卡点「生成健康令牌」，复制令牌。",
        "在 Health Auto Export 里新建自动化，类型选 REST API，URL 填下方地址，Headers 加 Authorization = Bearer 健康令牌，导出格式选 JSON。",
        "指标选「体重」（weight_body_mass）、「膳食能量」（dietary_energy），并勾选体能训练；同步周期选每天。",
        "睡眠、起床与入睡时刻、心率和步数不从这个 App 的格式读取，仍按「iPhone 快捷指令」一栏设置。"],
      facts: request, links: [{ label: "Health Auto Export（App Store）", url: "https://apps.apple.com/app/health-auto-export-json-csv/id1115567069" }], note: networkNote(at) },
      { id: "android", label: "Android", steps: [
        "确认手机上的手环、手表或健康 App 把睡眠、心率和步数写入 Health Connect（Android 14 起系统自带，更早的版本在应用商店安装）。",
        "在本卡点「生成健康令牌」，复制令牌。",
        "安装一个能读取 Health Connect、并能定时向网址发送 JSON 的自动化应用（如 Tasker），给它读取 Health Connect 的权限。",
        "每天早上运行一次：POST 到下方地址，头部 Authorization = Bearer 健康令牌，请求体 JSON 用与 iPhone 相同的字段，并加 source = android-health。",
        "入睡与起床时刻可在「睡眠模式」开启和关闭时各发一次 events（type = bed 或 wake）。",
        "运行一次做测试：返回内容里有 \"ok\":true 就是收到了。"],
      facts: [...request, { label: "source", value: "android-health" }, ...fields], note: networkNote(at) }
    ],
    problems: [
      { symptom: "返回 HEALTH_TOKEN_INVALID", fix: "令牌粘错，或之后又点过「重新生成」（旧令牌立即失效）。复制最新的令牌，确认写成「Bearer 令牌」，中间一个空格。" },
      { symptom: "返回 HEALTH_NOT_ENABLED", fix: "「手机健康数据」开关是关的。打开它，或重新生成健康令牌（生成即开启）。" },
      { symptom: "返回 INVALID_JSON", fix: "「获取 URL 内容」的请求体没有选 JSON。改选 JSON 后再运行。" },
      { symptom: "返回 \"ok\":true 但「依据」里没有手机记录", fix: "时间不是 ISO 8601 格式，或一段睡眠短于半小时、长于 16 小时，这类数据不保存。检查日期格式。" },
      { symptom: "自动化没有按时运行", fix: "自动化里要选「立即运行」并关掉「运行前询问」；低电量模式下 iPhone 可能推迟运行。" },
      ...(at.privateNetwork ? [{ symptom: "快捷指令提示无法连接服务器", fix: "手机没有连上私有网络（Tailscale），或运行 Crossline 的电脑没开。" }] : [])
    ]
  };
}

/** Siri 「记一下」: one dictated line to `/api/capture/shortcut` with the capture token (30 an hour, 240 characters). */
export function captureShortcutGuide(at: PhoneBase): SetupGuideSpec {
  return {
    title: "接入教程：Siri「记一下」",
    intro: "对 Siri 说一句话，直接进收集，随后自动分析。收集令牌只能写收集，不能读任何内容。",
    providers: [{ id: "iphone", label: "iPhone 快捷指令", steps: [
      "在本卡点「生成收集令牌」，复制令牌（只显示这一次）。",
      "打开「快捷指令」App，点右上角「+」新建快捷指令，命名「记一下」。",
      "加动作「听写文本」。",
      "加动作「获取 URL 内容」，按下方填写；请求体 JSON 加一个文本字段 text，值选上一步的「听写的文本」。",
      "说「嘿 Siri，记一下」，再说要收集的内容。返回 \"ok\":true 就是收到了。"],
    facts: [{ label: "URL", value: `${at.base}/api/capture/shortcut` }, { label: "方法", value: "POST" },
      { label: "头部", value: "Authorization = Bearer 收集令牌" }, { label: "请求体", value: "JSON，text = 听写的文本（不超过 240 字）" }],
    note: networkNote(at) }],
    problems: [
      { symptom: "返回 CAPTURE_TOKEN_INVALID", fix: "令牌粘错或已重新生成。复制最新的收集令牌。" },
      { symptom: "返回 INVALID_TASK_INPUT", fix: "text 为空或超过 240 字。确认 text 选的是「听写的文本」。" },
      { symptom: "返回 CAPTURE_RATE_LIMITED", fix: "一小时内已收集 30 条，过一会儿再说。" }
    ]
  };
}

/** 自动记账 from the phone: a Wallet transaction or a payment notification to `/api/records` with the records token. */
export function recordsGuide(at: PhoneBase): SetupGuideSpec {
  const request: GuideFact[] = [{ label: "URL", value: `${at.base}/api/records` }, { label: "方法", value: "POST" }, { label: "头部", value: "Authorization = Bearer 记账令牌" }];
  return {
    title: "接入教程：手机自动记账",
    intro: "有财富主线时，付款提醒和到账通知自动成为收支记录。最稳的来源是银行与商家的提醒邮件（在「日历与连接」接入邮箱）；手机是补充。记账令牌只能写收支记录。",
    providers: [
      { id: "wallet", label: "iPhone 钱包", steps: [
        "在本卡点「生成记账令牌」，复制令牌。",
        "在 iPhone「快捷指令」App 底部点「自动化」→ 右上角「+」新建，触发条件选「交易」并选卡片后选「立即运行」，并关掉「运行前询问」，之后每天无需操作。",
        "动作加「获取 URL 内容」，按下方填写；请求体 JSON 加数组 records，内含一个词典：clientId = 当前日期，domain = wealth，kind = expense，value = 金额，currency = CNY，merchant = 商户，at = 当前日期。",
        "用这张卡付一笔，看返回内容里有 \"ok\":true。"],
      facts: request, note: "苹果的「交易」自动化偶尔不触发或超时，漏掉的由邮件补上。" },
      { id: "android", label: "Android 通知转发", steps: [
        "在本卡点「生成记账令牌」，复制令牌。",
        "安装通知转发类自动化应用（如 MacroDroid、Tasker），给它读取通知的权限。",
        "设为微信、支付宝或银行 App 发出通知时运行：POST 到下方地址，请求体 JSON 加数组 notifications，内含一个词典：id（通知的唯一编号）、app、title、text、at。",
        "只有写明一个金额的付款或到账通知会记下，其余忽略。"],
      facts: request }
    ],
    problems: [
      { symptom: "返回 RECORDS_TOKEN_INVALID", fix: "令牌粘错或已重新生成。复制最新的记账令牌。" },
      { symptom: "返回 RECORDS_RATE_LIMITED", fix: "一小时内发送过多，过一会儿自动恢复。" },
      { symptom: "返回 \"ok\":true 但没有新记录", fix: "通知里没有写明唯一一个金额，或同一笔已经记过。" }
    ]
  };
}

/** Phone recordings uploaded to the server (docs/phone-recording.md 「服务器转写」), iPhone Voice Memos shared to a shortcut. */
export function recordingUploadGuide(endpoint: string): SetupGuideSpec {
  return {
    title: "接入教程：手机录音上传",
    providers: [{ id: "iphone", label: "iPhone 语音备忘录", steps: [
      "在本卡点「生成上传令牌」，复制令牌（只显示这一次）。",
      "「快捷指令」App → 新建快捷指令，命名「上传到 Crossline」；在「ⓘ」里打开「在共享表单中显示」，接收类型只留「媒体」和「文件」。",
      "加「获取名称」（输入：快捷指令输入），再加「URL 编码」编码这个名称。",
      "加「获取 URL 内容」：网址填下方地址，并在末尾接上编码后的名称；方法 POST；请求头 Authorization = Bearer 上传令牌；请求体选「文件」，文件选「快捷指令输入」。",
      "加「显示通知」，内容选「URL 的内容」。",
      "用 iPhone 自带的「语音备忘录」录音（锁屏后继续录）；录完点开这条录音 →「…」→「共享」→「上传到 Crossline」。分享菜单里找不到时，把 App 那一排滑到最右「更多」把它加进来。",
      "通知里出现 \"ok\":true 且 size 是几十万以上的数字，就是收到了真实的录音。"],
    facts: [{ label: "网址", value: endpoint }, { label: "方法", value: "POST" }, { label: "请求头", value: "Authorization = Bearer 上传令牌" }],
    note: "不用另装 App。同一个录音传两次只转一次。「查找录音」动作只交出录音标题，拿不到音频，所以每条录音要分享一次。单个录音不超过 300 MB，每天合计不超过 3 GB。" }],
    problems: [
      { symptom: "通知显示 RECORDING_TOKEN_INVALID", fix: "令牌粘错或已重新生成。复制最新的上传令牌。" },
      { symptom: "通知显示 RECORDING_SERVER_NOT_ENABLED", fix: "本卡的「服务器转写」是关的。先打开。" },
      { symptom: "通知显示 RECORDING_TYPE_UNSUPPORTED", fix: "传上来的不是录音（报错里写着收到的类型和开头文字）。确认是从语音备忘录的「共享」进入，而不是「查找录音」动作。" },
      { symptom: "录音中途停了", fix: "录音时别的 App 开始放声音，语音备忘录会停止录音。长时间录音前先试录几分钟。" }
    ]
  };
}

/** Recordings synced into an authorized folder and transcribed on this computer (docs/phone-recording.md). */
export const LOCAL_RECORDING_GUIDE: SetupGuideSpec = {
  title: "接入教程：手机录音同步到这台电脑",
  intro: "录音不经过服务器：手机把录音同步进电脑上的一个文件夹，授权这个文件夹，再打开本卡的「转写」。",
  providers: [
    { id: "iphone", label: "iPhone · Just Press Record", steps: [
      "在 App Store 购买安装 Just Press Record（自带的「语音备忘录」不行：Windows 上的 iCloud 云盘看不到它的文件）。",
      "在 Just Press Record 的设置里打开 iCloud 同步；iPhone「设置」→ 本人姓名 → iCloud → iCloud 云盘里也打开它。",
      "电脑从 Microsoft Store 安装 Apple 的「iCloud」，用同一个 Apple 账户登录，勾选「iCloud 云盘」。",
      "在文件资源管理器打开 iCloudDrive，找到 Just Press Record 的文件夹，右键 →「始终保留在此设备上」。",
      "在「日历与连接」→「授权文件夹」授权这个文件夹（只授权它，不要授权整个 iCloudDrive），再回本卡打开「转写」，按提示下载语音识别模型。"],
    links: [{ label: "iCloud for Windows", url: "https://apps.microsoft.com/detail/9PKTQ5699M62" }],
    note: "每段录音不要超过 3 小时，超过的不转写。试录后最多约 17 分钟出现「转写.txt」。" },
    { id: "android", label: "Android · Syncthing", steps: [
      "选一个能在后台长时间录音、能自动分段的录音 App，格式选 m4a/aac 或 opus、单声道、32–64 kbps，并在系统设置里关掉它的电池优化。",
      "安装 Syncthing-Fork（F-Droid 或其 GitHub 发布页），同样关掉电池优化；电脑安装 Windows 版 Syncthing，两边互相添加设备。",
      "在手机上共享录音 App 的保存目录，类型选「仅发送」；电脑上接受时选一个专门的文件夹，类型选「仅接收」。",
      "在「日历与连接」→「授权文件夹」授权电脑上的这个文件夹，再回本卡打开「转写」。"],
    links: [{ label: "Syncthing 下载", url: "https://syncthing.net/downloads/" }] }
  ],
  problems: [
    { symptom: "录音一直排队不转写", fix: "语音识别模型还没下载：本卡出现「同意并下载」时点它。" },
    { symptom: "列出「读取失败」的录音", fix: "文件只在云端没下载到电脑。对 iCloudDrive 里那个文件夹选「始终保留在此设备上」。" }
  ]
};

/** Notifications to this device: iPhone only for the home-screen app on https. */
export function phonePushGuide(privateNetwork: boolean): SetupGuideSpec {
  return {
    title: "接入教程：手机与电脑推送",
    providers: [
      { id: "iphone", label: "iPhone / iPad", steps: [
        privateNetwork ? "用 Safari 打开上面 https 开头的地址（手机需连着同一私有网络 Tailscale）并登录。" : "用 Safari 打开上面的地址并登录。",
        "点底部「分享」→「添加到主屏幕」。",
        "从主屏幕上的 Crossline 图标打开，进入「设置」→「通用」→「手机访问」。",
        "点「在这台设备上开启推送」，在弹窗里允许通知。",
        "点「发一条测试推送」，几秒内应收到。"], note: "需要 iOS 16.4 或更高版本；在 Safari 标签页里打开时没有推送，必须从主屏幕图标打开。" },
      { id: "android", label: "Android", steps: [
        privateNetwork ? "用 Chrome 打开上面 https 开头的地址（手机需连着同一私有网络 Tailscale）并登录。" : "用 Chrome 打开上面的地址并登录。",
        "（可选）点菜单「添加到主屏幕」或「安装应用」。",
        "进入「设置」→「通用」→「手机访问」，点「在这台设备上开启推送」，允许通知。",
        "点「发一条测试推送」。"] },
      { id: "desktop", label: "电脑", steps: [
        "在 Chrome、Edge 或 Safari 打开 Crossline 并登录，进入「设置」→「通用」→「手机访问」。",
        "点「在这台设备上开启推送」，允许通知。",
        "点「发一条测试推送」。Windows 上若没弹出，到「设置」→「系统」→「通知」里打开浏览器的通知。"] }
    ],
    problems: [
      { symptom: "按钮不出现，提示只给主屏幕 App 推送", fix: "iPhone 按上面第 2、3 步从主屏幕图标打开。" },
      { symptom: "提示没有得到通知权限", fix: "之前点过「不允许」。iPhone 在「设置」→「通知」→ Crossline 里打开；浏览器在网站设置里允许通知后再点开启。" },
      { symptom: "测试推送显示已发出但没收到", fix: "专注模式或勿扰模式拦下了通知，在专注模式里允许 Crossline。" }
    ]
  };
}

/** The Crossline calendar's writer account: a Microsoft device-code sign-in. */
export const CALENDAR_WRITER_GUIDE: SetupGuideSpec = {
  title: "接入教程：写入 Crossline 日历的账号",
  intro: "排好的时段写进 Outlook 里一本名为 Crossline 的日历，首次写入时自动创建；其他日历只读不写。",
  providers: [{ id: "microsoft", label: "微软账号", steps: [
    "点「获取登录代码」，这里会显示一串代码和微软的登录地址。",
    "打开那个地址，输入代码，用存放日历的微软账号登录（个人 Outlook.com 账号或学校、公司账号）。",
    "页面列出要授予的权限：读取本人资料、读写日历。同意后关闭页面。",
    "回到这里，几秒内自动更新，并立即写入一次。手机上的 Outlook 或系统日历订阅同一账号后即可看到 Crossline 日历。"],
  links: [{ label: "微软设备登录页", url: "https://microsoft.com/devicelogin" }] }],
  problems: [
    { symptom: "微软页面提示需要管理员批准", fix: "学校或公司账号不允许本人授权第三方应用。改用个人微软账号，或请管理员批准。" },
    { symptom: "提示代码已过期", fix: "代码约 15 分钟内有效，回到这里再点「获取登录代码」。" }
  ]
};

/** A calendar by its private subscription link: each app's own steps (core `SUBSCRIPTION_GUIDES`), with the page each one is made on. */
export function subscriptionGuide(guides: Array<{ app: string; url: string; steps: string[] }>): SetupGuideSpec {
  return {
    title: "接入教程：各日历的订阅链接",
    intro: "订阅链接是日历的只读地址，不用登录。点上面所用的日历会打开它的设置页，同时在这里展开对应的步骤。",
    providers: guides.map((guide) => ({ id: guide.app, label: guide.app, steps: guide.steps, links: [{ label: guide.app, url: guide.url }] })),
    problems: [
      { symptom: "接入成功但没有读到日程", fix: "全天日程（节假日、生日）和标为「空闲」的日程不读入；只读未来九周有具体时间的日程。" },
      { symptom: "提示链接打不开或不是日历", fix: "拷贝的是网页地址而不是订阅链接。订阅链接以 webcal:// 开头，或以 https:// 开头、以 .ics 结尾。" },
      { symptom: "Outlook（工作或学校）里没有「发布日历」", fix: "学校或公司关闭了发布。改用 Outlook 手机 App 或网页版把课表复制到个人日历，或向管理员申请。" },
      { symptom: "过了一段时间显示读取失败", fix: "日历里重新生成或关闭了私密地址，旧链接失效。移除后用新链接重新接入。" }
    ]
  };
}

/** Google and Outlook calendars as ChatGPT connectors of the account's Codex. */
export const CALENDAR_APPS_GUIDE: SetupGuideSpec = {
  title: "接入教程：ChatGPT 日历连接器",
  intro: "这里的连接只用于显示状态，暂不把日程读入计划；要让日历进入计划，用「订阅日历」。",
  providers: [{ id: "chatgpt", label: "Google / Outlook 日历", steps: [
    "点「连接 Google 日历」或「连接 Outlook 日历」，打开 ChatGPT 的连接页面。",
    "用与「模型连接」相同的 ChatGPT 账号登录。",
    "点「连接」，按提示登录 Google 或微软账号并授权读取日历。",
    "回到这里点「已连接，刷新」。"] }],
  problems: [{ symptom: "提示尚未连接模型服务", fix: "先在本页「模型连接」用 ChatGPT 账号连接，再连接日历。" }]
};

/** Authorized folders: how to get a folder's full path on each system. */
export const SOURCE_FOLDER_GUIDE: SetupGuideSpec = {
  title: "接入教程：取得文件夹的完整路径",
  providers: [
    { id: "windows", label: "Windows", steps: [
      "在文件资源管理器里选中要授权的文件夹（不要点进去）。",
      "右键 →「复制文件地址」；Windows 10 上按住 Shift 再右键 →「复制为路径」。",
      "粘贴到下方，点「查看」。路径两端的引号会自动去掉。",
      "看过将读取的文件数，勾掉不需要的子文件夹，再点授权。"] },
    { id: "mac", label: "macOS", steps: [
      "在访达里选中要授权的文件夹。",
      "按住 Option 键右键 →「将……拷贝为路径名称」。",
      "粘贴到下方，点「查看」，看过将读取的文件后授权。"] }
  ],
  problems: [
    { symptom: "提示不能授权这个位置", fix: "整个磁盘、用户主文件夹、系统和程序数据文件夹不能授权。选一个具体的子文件夹，如「D:\\课程资料」。" },
    { symptom: "提示找不到这个文件夹", fix: "路径要写完整（从盘符或根目录开始）。用上面的方法复制，比手打可靠。" }
  ]
};

/**
 * A computer as a device of the hosted account (docs/device-mode.md): the token made on the hosted 「这台电脑」 card, pasted on the
 * computer's own `/device` page. Shown beside both buttons.
 */
export const DEVICE_LINK_GUIDE: SetupGuideSpec = {
  title: "连接教程：把电脑设为这个账号的设备",
  intro: "连接后，电脑上的 Crossline 只读本机的屏幕活动、作息、键鼠节律、授权文件夹和录音，结果立即发到网页版；计划、任务、访谈和所有模型工作只在网页版进行，额度不再花两遍。",
  providers: [
    { id: "windows", label: "Windows 上的 Crossline", steps: [
      "在网页版打开 设置 → 通用 →「这台电脑」，点「生成设备令牌」。令牌只显示一次，复制下来。",
      "在那台电脑的浏览器打开下方的设备页地址（要先登录电脑上的 Crossline）。",
      "「网页版地址」填网页版的地址，「设备令牌」粘贴刚才复制的令牌，点「连接」。电脑先用令牌问一次网页版，通过才保存。",
      "几秒后后台服务以设备模式重启，设备页显示待发送和上次送达的时间；电脑上的其他页面从此打开网页版。",
      "在设备页确认屏幕活动、作息、键鼠节律、录音转写和文件夹的开关；它们留在电脑上，连接不会改。",
      "（可选）让这台电脑替网页版跑本账号的模型工作：网页版「这台电脑」和设备页的「作为算力节点」都选「开启」。电脑关机或断网时自动回到服务器。"],
    facts: [{ label: "设备页", value: "http://127.0.0.1:3210/device" }, { label: "网页版地址", value: "https://app.crossline.lol" }],
    note: "令牌用 Windows 自带的数据保护加密保存，只有当前 Windows 用户能读取，不进账本、不进备份。" }
  ],
  problems: [
    { symptom: "提示令牌无效或已撤销", fix: "在网页版「这台电脑」重新生成令牌：再生成一次，旧令牌立即失效。" },
    { symptom: "设备页提示网页版拒绝了发送", fix: "令牌被撤销或换了新的。在设备页先「断开」，再用新令牌「连接」。没发出去的内容留在电脑上，连上后补发。" },
    { symptom: "连接后设备页一直显示后台服务没有响应", fix: "后台服务没有被自动拉起（例如用命令行手动启动的）。重新运行启动脚本 scripts\\start-crossline.ps1。" }
  ]
};

/** Where each preset's API key is made (apps/worker/src/model-provider.ts `PROVIDER_PRESETS`). */
const KEY_PAGES: Array<{ id: string; label: string; url: string; note?: string }> = [
  { id: "deepseek", label: "DeepSeek", url: "https://platform.deepseek.com/api_keys", note: "需先在开放平台充值。" },
  { id: "kimi", label: "Kimi", url: "https://platform.moonshot.cn/console/api-keys", note: "需先在开放平台充值。" },
  { id: "qwen", label: "通义千问", url: "https://bailian.console.aliyun.com/", note: "在阿里云百炼控制台开通模型服务，再到「API-KEY」页创建。" },
  { id: "glm", label: "智谱 GLM", url: "https://open.bigmodel.cn/usercenter/apikeys" },
  { id: "claude", label: "Claude", url: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", label: "Gemini", url: "https://aistudio.google.com/apikey" },
  { id: "openai", label: "OpenAI API", url: "https://platform.openai.com/api-keys", note: "API 按用量单独计费，与 ChatGPT 订阅无关。" },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/settings/keys" }
];

export function modelProviderGuide(local: boolean): SetupGuideSpec {
  return {
    title: "接入教程：各家模型的 API key",
    intro: "模型只承担检验通过的功能；联网搜索、画图和能执行命令的助手仍由 ChatGPT 登录承担。",
    providers: [
      ...KEY_PAGES.map((page) => ({ id: page.id, label: page.label, steps: [
        "打开下方链接里的 API key 页面，登录或注册。",
        "新建一个 API key，名称填 Crossline，复制显示的密钥（多数平台只显示一次）。",
        "在本卡「添加一个模型」里选这一家，接口地址和模型名已填好，可以按需修改。",
        "把密钥粘贴到「API key」一栏，点「保存」。保存后自动检验每项功能的回答格式，约需几分钟，可以离开此页。"],
      links: [{ label: "API key 页面", url: page.url }], ...(page.note ? { note: page.note } : {}) })),
      local
        ? { id: "ollama", label: "本机 Ollama", steps: [
          "在运行 Crossline 的这台电脑上安装 Ollama。",
          "在终端运行 ollama pull qwen3:8b 下载模型（约 5 GB），或换成想用的模型。",
          "在本卡选「本机 Ollama」，API key 留空，点「保存」。"],
          links: [{ label: "Ollama 下载", url: "https://ollama.com/download" }], note: "本机模型不计费，但检验和日常运行都比云端慢。" }
        : { id: "ollama", label: "本机 Ollama", unsupported: true, steps: ["网页版连接不到本人电脑上的模型；本机模型只在本人电脑上安装的 Crossline 里可用。"] }
    ],
    problems: [
      { symptom: "检验结果「未通过」", fix: "模型答不出要求的格式。勾选「这个接口只支持 JSON 模式」后重新检验，或换一个更大的模型。" },
      { symptom: "保存时提示密钥无效或余额不足", fix: "密钥复制不全，或平台账户需要先充值。" }
    ]
  };
}

/** 「按链接添加」 a public skill: where the repository and the directory holding SKILL.md are. */
export const SKILL_LINK_GUIDE: SetupGuideSpec = {
  title: "接入教程：按链接添加公开 skill",
  providers: [{ id: "github", label: "GitHub", steps: [
    "在 GitHub 上打开 skill 所在的仓库，找到含有 SKILL.md 的那个文件夹。",
    "打开这个文件夹，复制浏览器地址栏里的链接（形如 https://github.com/作者/仓库/tree/main/skills/名称），粘贴到「仓库链接」，「目录」可以不填。",
    "或者「仓库链接」只填 https://github.com/作者/仓库，「目录」填 SKILL.md 所在的目录，如 skills/teach。",
    "选它服务的主线，点「按链接添加」。取回后先经代码扫描与模型审查，几分钟后结果出现在列表里。"] }],
  problems: [
    { symptom: "提示只收 GitHub 公开仓库", fix: "私有仓库和其他网站的地址不能添加。" },
    { symptom: "结果显示「只用文字」", fix: "扫描发现脚本有风险，脚本没有安装；在该 skill 的详情里可以查看扫描结果并决定是否允许。" }
  ]
};

/**
 * 「从其他工具导入」 (docs/personal-agent.md §9, 2026-10-28): where each tool keeps the token the person makes for themselves, and how a
 * list without an API comes in (an export, a paste, a screenshot). The menu names are the tools' own, quoted as they appear.
 */
export const IMPORT_GUIDE: SetupGuideSpec = {
  title: "导入教程：各工具的令牌与导出",
  intro: "只读取，不改原工具里的任何东西（Todoist 可选择在 Crossline 完成后关闭原任务，默认关闭）。读到的条目先给出建议，一屏核对后才收进来。",
  providers: [
    { id: "todoist", label: "Todoist", steps: [
      "在电脑浏览器登录 Todoist 网页版。",
      "点左上角头像 →「设置」→「集成」→「开发者」。",
      "复制「API 令牌」（40 位字母数字），粘贴到下方「令牌」一栏，点「接入」。",
      "接入后先读一遍全部未完成任务，给出核对清单；以后每天读一次新增的任务，可以关闭。"],
    links: [{ label: "Todoist 集成设置", url: "https://app.todoist.com/app/settings/integrations/developer" }, { label: "Todoist API 文档", url: "https://developer.todoist.com/api/v1/" }],
    note: "令牌能读写整个 Todoist 账号，只保存在服务器的加密存储里，不进账本和备份。断开即删除；在 Todoist 里重新生成令牌，旧令牌也立即失效。" },
    { id: "ticktick", label: "TickTick / 滴答清单", steps: [
      "TickTick：在电脑浏览器登录 TickTick 网页版，点头像 →「Settings」→「Account」→「API Token」，生成并复制令牌，粘贴到下方，点「接入」。",
      "滴答清单（国内版）没有这个令牌：在网页版「设置」→「账户与安全」→「生成备份」，下载 CSV 文件，在下方「上传 CSV 或截图」里上传。",
      "TickTick 也可以用同样的备份 CSV 导入：「Settings」→「Account」→「Generate Backup」。"],
    links: [{ label: "TickTick 网页版", url: "https://ticktick.com/webapp" }, { label: "滴答清单网页版", url: "https://dida365.com/webapp" }, { label: "TickTick 开放 API", url: "https://developer.ticktick.com/docs/openapi.md" }],
    note: "TickTick 不回写：在 Crossline 完成的任务不会改动 TickTick。" },
    { id: "notion", label: "Notion", steps: [
      "打开 Notion 的集成页面，点「New integration」，类型选「Internal」，名称填 Crossline，工作区选存放待办的那一个，保存。",
      "在集成的「Capabilities」里只勾选「Read content」，复制「Internal Integration Secret」（以 ntn_ 开头）。",
      "在 Notion 里打开要导入的数据库，点右上角「…」→「Connections」→ 选 Crossline。没有这一步，集成看不到这个数据库。",
      "回到这里粘贴令牌，点「接入」，在出现的列表里选这个数据库。"],
    facts: [{ label: "读取的属性", value: "标题、状态（Status / Select / 勾选框）、第一个日期属性、多选标签" }],
    links: [{ label: "Notion 集成页面", url: "https://www.notion.so/profile/integrations" }, { label: "Notion API 文档", url: "https://developers.notion.com/docs/create-a-notion-integration" }],
    note: "Notion 不回写。状态是 Done、Complete 或「已完成」的条目会建议为「已做完」。" },
    { id: "other", label: "其他工具（粘贴、CSV、截图）", steps: [
      "能导出 CSV 的工具（Microsoft To Do 通过第三方导出、Things、Any.do、OmniFocus、Excel 表格）：导出后在下方上传 CSV。第一行要有标题列（Title、Content、Task、任务、标题之一），日期列和状态列会一并读取。",
      "只有文字的清单（备忘录、微信收藏、Markdown）：全选复制，粘贴到下方文本框，一行一条，带「[x]」的视为已做完。",
      "只能截图的（手机 App 的清单页）：截图后上传，系统逐行读出文字；读截图要用 ChatGPT 登录的模型。"] }
  ],
  problems: [
    { symptom: "提示令牌无效或已被撤销", fix: "令牌复制不全，或已在原工具里重新生成过。重新复制完整令牌后再接入。" },
    { symptom: "Notion 提示看不到任何数据库", fix: "数据库还没有连接到这个集成：在数据库页面右上角「…」→「Connections」里选 Crossline。" },
    { symptom: "上传 CSV 后没有读到条目", fix: "第一行缺少标题列。在表格里把任务名那一列的表头改成 Title 再导出。" }
  ]
};
