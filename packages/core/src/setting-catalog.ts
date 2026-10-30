/**
 * Every setting the input box may change (the owner's decision of 2026-10-30: the box reaches every setting the person has). One generic
 * action, `setting.change {key, target, value}`, names a key of this catalog; the web carries it out through the same function the
 * settings page or its route uses (`apps/web/lib/setting-change.ts`), after the person confirms a card that shows 当前 → 改成 and what
 * follows. Privacy consents are in it too, both ways, and their card carries the settings card's own explanation word for word.
 *
 * Credentials and destructive items are deliberately not in it — passwords, API keys, the model provider's key, mail passwords, device,
 * health, capture, records and recording tokens, node pairing, the calendar writer's sign-in, resetting or deleting the account, folder
 * authorization and purge: the box answers those with `settings.open`, a link to the card where the person does it themselves, and never
 * repeats a secret.
 */
import { BACKGROUND_KINDS } from "./background";
import { AGENT_CATEGORIES } from "./agent-dispatch";

/** What a key is about: nothing (one value per account), or one object the person names by id. */
export type SettingTarget = "" | "milestone" | "task" | "automation" | "mailbox" | "block" | "background" | "category";
export type SettingValueSpec =
  /** `values`: each allowed value with its label (Chinese key, shown in the person's language). */
  | { type: "enum"; values: Record<string, string> }
  | { type: "number"; min: number; max: number; unit: string }
  | { type: "date" }
  | { type: "text"; max: number }
  /** Each line's share of the week in whole percents: `lineId=40,lineId=30` (together at most 100; empty goes back to what was said). */
  | { type: "shares" }
  /** A block's new time: `YYYY-MM-DD HH:MM-HH:MM` in the person's zone. */
  | { type: "slot" };
/** Settings page anchors (`/settings#…`) a card or a link points at. */
export const SETTINGS_SECTIONS = { general: "通用", phone: "手机访问与推送", device: "这台电脑", calendar: "日历与连接", mail: "邮箱", model: "模型连接",
  notify: "时间与提醒", travel: "出行", automation: "自动化与助手", automations: "自动化", background: "后台任务", personal: "个性化", skills: "Skill 库",
  privacy: "隐私与屏幕活动", energy: "精力与手机健康", recordings: "录音转写", usage: "用量与体检" } as const;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;
export const SETTINGS_SECTION_IDS = Object.keys(SETTINGS_SECTIONS) as SettingsSection[];

export type SettingEntry = {
  label: string; target: SettingTarget; value: SettingValueSpec;
  /** One line on the card saying what follows from the change. */
  consequence: string;
  /** A privacy consent: turned on and off only with the settings card's own explanation (`explain`, word for word) on the card. */
  consent?: true; explain?: readonly string[];
  section: SettingsSection | "plan" | "milestones" | "task";
};

const ON_OFF = { on: "开启", off: "关闭" };
/** Turning a recording consent off asks what becomes of what was transcribed, as its settings card does. */
const KEEP_OFF = { on: "开启", off_keep: "关闭并保留已转写的文字", off_delete: "关闭并删除已转写的文字" };
const percent = (min: number, max: number, unit: string): SettingValueSpec => ({ type: "number", min, max, unit });

export const SETTING_CATALOG = {
  "schedule.lineShares": { label: "主线份额", target: "", value: { type: "shares" }, consequence: "按新的份额重排本周及以后的工作", section: "plan" },
  "schedule.preset": { label: "排程预设", target: "", value: { type: "enum", values: { buffered: "留缓冲", asap: "尽早完成" } }, consequence: "四个排程参数改为该预设，重排日程", section: "plan" },
  "schedule.gapMinutes": { label: "任务间隔", target: "", value: percent(0, 30, "分钟"), consequence: "相邻任务块之间留出的休息，重排日程", section: "plan" },
  "schedule.maxDailyShare": { label: "每日最高占用", target: "", value: percent(50, 100, "%"), consequence: "每天可用时间最多排满的比例，重排日程", section: "plan" },
  "schedule.focusCapMinutes": { label: "单段专注上限", target: "", value: percent(0, 180, "分钟"), consequence: "一个任务连续占用的最长时间（0 为不限），超出部分换到别的时段", section: "plan" },
  "schedule.deadlineBufferDays": { label: "截止前缓冲", target: "", value: percent(0, 5, "天"), consequence: "工作按提前这些天完成来排；排不下时自动放宽", section: "plan" },
  "notify.level": { label: "推送档位", target: "", value: { type: "enum", values: { off: "关闭", less: "少", normal: "标准", more: "多" } }, consequence: "桌面与手机通知的多少", section: "notify" },
  "language": { label: "语言", target: "", value: { type: "enum", values: { zh: "中文", en: "English" } }, consequence: "界面、通知和之后新生成的内容改用该语言", section: "general" },
  "background.paused": { label: "后台任务暂停", target: "background", value: { type: "enum", values: { paused: "暂停", running: "运行" } }, consequence: "这类后台工作暂停或恢复；正在进行的会做完", section: "background" },
  "background.quotaSaver": { label: "节省额度", target: "", value: { type: "enum", values: ON_OFF }, consequence: "开启时非核心的后台工作只在额度宽裕或夜间运行", section: "background" },
  "agent.paused": { label: "助手暂停", target: "", value: { type: "enum", values: { paused: "暂停", running: "运行" } }, consequence: "助手不再自行开始新工作；正在进行的会做完", section: "automation" },
  "agent.autoHandoff": { label: "自动交给 Agent", target: "", value: { type: "enum", values: ON_OFF }, consequence: "日程上系统能做的步骤到时由助手自动开始", section: "automation" },
  "permission.mode": { label: "许可模式", target: "", value: { type: "enum", values: ON_OFF }, consequence: "开启后符合条件的提案在页面停留一段时间后自动生效", section: "automation" },
  "agent.category": { label: "助手能力", target: "category", value: { type: "enum", values: ON_OFF }, consequence: "助手是否可以自行做这一类工作", section: "automation" },
  "automation.status": { label: "自动化", target: "automation", value: { type: "enum", values: { active: "运行", off: "暂停" } }, consequence: "这个自动化暂停或恢复运行", section: "automations" },
  "mail.triage": { label: "邮件整理", target: "mailbox", value: { type: "enum", values: ON_OFF }, consequence: "这个邮箱的新邮件是否由系统整理成待办与日期", section: "mail" },
  "mail.bookkeeping": { label: "自动记账", target: "mailbox", value: { type: "enum", values: ON_OFF }, consequence: "这个邮箱里银行与购物邮件的金额是否记成收支", section: "mail" },
  "mail.replyDrafts": { label: "回复草稿", target: "", value: { type: "enum", values: ON_OFF }, consequence: "等本人回复的邮件是否由助手起草回复（不发送）", section: "mail" },
  "archetypes.curationPeriod": { label: "整理新任务类型", target: "", value: { type: "enum", values: { off: "关闭", biweekly: "每两周", monthly: "每月" } },
    consequence: "系统多久总结一次反复出现的新任务类型", section: "personal" },
  "milestone.deadline": { label: "里程碑截止日", target: "milestone", value: { type: "date" }, consequence: "这个里程碑的工作按新截止日重排", section: "milestones" },
  "milestone.title": { label: "里程碑名称", target: "milestone", value: { type: "text", max: 200 }, consequence: "改名，不影响日程", section: "milestones" },
  "task.completionMode": { label: "完成方式", target: "task", value: { type: "enum", values: { self_evident: "点完成即验收", needs_assessment: "完成后再问结果" } },
    consequence: "按下完成后是否还要在空闲时询问结果", section: "task" },
  "task.familiarity": { label: "熟悉程度", target: "task", value: { type: "enum", values: { near: "熟悉领域·从简", mid: "一般熟悉·按步骤", far: "新领域·附讲解" } },
    consequence: "这条主线这类工作的讲解多少，之后同类任务照此准备", section: "task" },
  "energyAdvice.dismiss": { label: "本周精力建议", target: "", value: { type: "enum", values: { dismissed: "忽略" } }, consequence: "本周的精力时段建议不再显示；下周的新建议照常显示", section: "plan" },
  "block.lock": { label: "时间块锁定", target: "block", value: { type: "enum", values: { locked: "锁定在此时间", unlocked: "解除锁定" } },
    consequence: "锁定后重排时这一块不动；解除后由排程重新安排", section: "plan" },
  "block.move": { label: "时间块改时间", target: "block", value: { type: "slot" }, consequence: "这一块移到新时间并锁定，其余工作绕开它重排", section: "plan" },
  "autostart": { label: "开机自启", target: "", value: { type: "enum", values: ON_OFF }, consequence: "Windows 登录后是否自动启动 Crossline", section: "general" },
  "telemetry": { label: "使用数据回传", target: "", value: { type: "enum", values: ON_OFF }, consequence: "是否把不含内容的使用数据发给开发者", section: "privacy" },
  // Privacy consents: on and off, each with the settings card's own explanation.
  "consent.sleepTracking": { label: "作息记录", target: "", value: { type: "enum", values: ON_OFF }, consequence: "关闭即删除已记的作息", consent: true, section: "energy",
    explain: ["只记电脑 4 小时以上无活动（如夜间）的开始与结束时刻，用于推算睡眠；关闭即删除"] },
  "consent.inputRhythm": { label: "键鼠节律", target: "", value: { type: "enum", values: ON_OFF }, consequence: "关闭即删除已记的节律", consent: true, section: "energy",
    explain: ["只记每 15 分钟内有输入的秒数、5 秒以上的停顿次数和鼠标移动距离；不记按键、内容和窗口；关闭即删除"] },
  "consent.camera": { label: "摄像头精力采样", target: "", value: { type: "enum", values: ON_OFF }, consequence: "关闭即删除已存的采样数", consent: true, section: "energy",
    explain: ["仅电脑、页面在前台时：每 20 分钟开 20 秒，在本机算眨眼、闭眼比例与心率，只存这几个数；画面不存不传；关闭即删除"] },
  "consent.phoneHealth": { label: "手机健康数据", target: "", value: { type: "enum", values: ON_OFF }, consequence: "关闭即删除手机记录，健康令牌失效", consent: true, section: "energy",
    explain: ["手机快捷指令发来的睡眠、起床与入睡时刻，以及当天的心率、手腕温度、步数和日照；生成健康令牌即开启；关闭即删除，令牌失效"] },
  "consent.screenActivity": { label: "屏幕活动", target: "", value: { type: "enum", values: { off: "不读取屏幕活动", minutes: "只记每天的活跃分钟数，不记应用与窗口",
    detail: "记录应用与窗口标题；标题只存本机，14 天后抹除，不发给模型" } }, consequence: "屏幕活动的记录级别", consent: true, section: "privacy",
    explain: ["不记录按键、不截屏、不上传；银行、密码管理器、无痕窗口不记录"] },
  "consent.agentHistory": { label: "Codex 与 Claude Code 使用记录", target: "", value: { type: "enum", values: ON_OFF }, consequence: "关闭即删除统计", consent: true, section: "privacy",
    explain: ["只读每条记录的时间和所在文件夹，不读对话内容；用于了解习惯与进度，不用于排程"] },
  "consent.recordings": { label: "录音自动转写", target: "", value: { type: "enum", values: KEEP_OFF }, consequence: "关闭后不再转写新录音", consent: true, section: "recordings",
    explain: ["手机录音同步到已授权的文件夹后，在这台电脑上转写成文字放进材料；录音不上传，也不留副本", "录到别人说话前，需让对方知情，并遵守当地关于录音的法律。"] },
  "consent.serverRecordings": { label: "录音在服务器转写", target: "", value: { type: "enum", values: KEEP_OFF }, consequence: "关闭后不再接收上传，还没转写的录音会删除", consent: true,
    section: "recordings", explain: ["手机快捷指令把录音上传到服务器，本人时区夜间 1–6 点用 SenseVoice 转写成文字放进材料；录音转完即删，不进备份",
      "录到别人说话前，需让对方知情，并遵守当地关于录音的法律。"] },
  "consent.voiceprint": { label: "识别本人声音", target: "", value: { type: "enum", values: ON_OFF }, consequence: "关闭即删除声纹", consent: true, section: "recordings",
    explain: ["用语音备忘录录 30 秒到 2 分钟只有本人说话的内容（念一段文字即可），录完「共享 → 存储到文件」，再在这里选那个文件。只保存从中算出的一串数字（声纹），不保存录音；别人的声音只在单个录音里区分，不保存。关闭即删除。"] }
} as const satisfies Record<string, SettingEntry>;

export type SettingKey = keyof typeof SETTING_CATALOG;
export const SETTING_KEYS = Object.keys(SETTING_CATALOG) as SettingKey[];
export const isSettingKey = (value: unknown): value is SettingKey => typeof value === "string" && value in SETTING_CATALOG;

/** What the box may name as a target: the objects of the moment (the web knows them; the core checks against them). */
export type SettingTargets = { milestones: Set<string>; tasks: Set<string>; automations?: Set<string>; mailboxes?: Set<string>; blocks?: Set<string>;
  lines: Set<string> };

/** Words that name a credential or something destructive: never a setting the box changes, only a link to where the person does it. */
const CREDENTIAL = /password|passwd|api.?key|secret|token|credential|pair|login|sign.?in|密码|密钥|令牌|口令|授权码|配对|登录|删除|清空|重置|reset|delete|purge/i;
export const isCredentialKey = (key: string): boolean => CREDENTIAL.test(key);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLOT = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** `lineId=40,lineId=30` as a map of whole percents, or undefined when a part is not one. */
export function parseShares(value: string): Record<string, number> | undefined {
  if (!value.trim()) return {};
  const entries = value.split(/[,，;；\s]+/).filter(Boolean).map((part) => part.split("="));
  if (entries.some((pair) => pair.length !== 2 || !pair[0] || !/^\d{1,3}$/.test(pair[1] ?? ""))) return undefined;
  return Object.fromEntries(entries.map(([line, share]) => [line!, Number(share)]));
}

/** `YYYY-MM-DD HH:MM-HH:MM` as its parts, or undefined. */
export function parseSlot(value: string): { day: string; start: string; end: string } | undefined {
  const match = SLOT.exec(value.trim());
  if (!match) return undefined;
  const slot = { day: match[1]!, start: `${match[2]}:${match[3]}`, end: `${match[4]}:${match[5]}` };
  return slot.end > slot.start ? slot : undefined;
}

/* i18n-ignore-start: why a setting change cannot run, sent back to the model to repair against */
/** Why `setting.change` cannot be carried out as given, in words the model can repair against; "" when it can. */
export function settingProblem(args: { key: string; target: string; value: string }, refs: SettingTargets): string {
  if (!isSettingKey(args.key)) {
    return isCredentialKey(args.key) ? `「${args.key}」是凭据或不可撤回的操作，输入框不修改：用 settings.open 给出设置页链接，不复述任何密码或密钥`
      : `「${args.key}」不是可修改的设置（用 list_settings 查键名）`;
  }
  const entry: SettingEntry = SETTING_CATALOG[args.key];
  const target = args.target.trim(), value = args.value.trim();
  const known = { milestone: refs.milestones, task: refs.tasks, automation: refs.automations, mailbox: refs.mailboxes, block: refs.blocks } as const;
  if (entry.target === "background" && !BACKGROUND_KINDS.some((kind) => kind.kind === target)) return `target 须是后台任务种类之一：${BACKGROUND_KINDS.map((kind) => kind.kind).join("、")}`;
  if (entry.target === "category" && !(target in AGENT_CATEGORIES)) return `target 须是助手能力之一：${Object.keys(AGENT_CATEGORIES).join("、")}`;
  if (entry.target && entry.target !== "background" && entry.target !== "category" && !known[entry.target]?.has(target))
    return `target「${target}」不是现有的${entry.target}（用 list_settings 或对应查询查 id）`;
  if (!entry.target && target) return "这个设置不针对某个对象，target 留空";
  const spec: SettingValueSpec = entry.value;
  switch (spec.type) {
    case "enum": return value in spec.values ? "" : `value 须是 ${Object.keys(spec.values).join(" / ")} 之一`;
    case "number": { const n = Number(value); return value && Number.isFinite(n) && n >= spec.min && n <= spec.max ? "" : `value 须是 ${spec.min}–${spec.max} 的数（${spec.unit}）`; }
    case "date": return DAY.test(value) ? "" : "value 须为 YYYY-MM-DD";
    case "text": return value && value.length <= spec.max ? "" : `value 须是 1–${spec.max} 字的文字`;
    case "shares": {
      const shares = parseShares(value);
      if (!shares) return "value 须写成 lineId=百分数，逗号分隔（如 research=50,startup=30）";
      const unknown = Object.keys(shares).filter((line) => !refs.lines.has(line));
      if (unknown.length) return `这些不是主线 id：${unknown.join("、")}`;
      return Object.values(shares).reduce((sum, share) => sum + share, 0) <= 100 ? "" : "各主线份额合计不能超过 100";
    }
    case "slot": return parseSlot(value) ? "" : "value 须为 YYYY-MM-DD HH:MM-HH:MM，且结束晚于开始";
  }
}
/* i18n-ignore-end */

/** The catalog as the model reads it (`list_settings`): key, label, what it is about, allowed values, and whether it is a consent. */
export function settingCatalogLines(): string[] {
  // i18n-ignore-start: model context
  return SETTING_KEYS.map((key) => {
    const entry: SettingEntry = SETTING_CATALOG[key];
    const spec: SettingValueSpec = entry.value;
    const values = spec.type === "enum" ? Object.entries(spec.values).map(([value, label]) => `${value}=${label}`).join(" / ")
      : spec.type === "number" ? `${spec.min}–${spec.max} ${spec.unit}` : spec.type === "date" ? "YYYY-MM-DD" : spec.type === "text" ? `文字 ≤${spec.max}`
      : spec.type === "shares" ? "lineId=百分数,…（合计 ≤100；空为按访谈所说）" : "YYYY-MM-DD HH:MM-HH:MM";
    return `${key} | ${entry.label} | target：${entry.target || "无"} | ${values}${entry.consent ? " | 隐私同意" : ""}`;
  });
  // i18n-ignore-end
}
