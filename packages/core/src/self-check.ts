/**
 * Crossline checks itself (2026-11-04, the owner: 「让 crossline 系统本身具有调试和修复的能力」). Each feature has a probe; a failure with a known
 * cause is repaired by the system and only recorded (shown on 系统体检), and one it cannot repair is said to the person once. Rules only,
 * no model: a probe reads state, a repair puts it right the way the person would by hand.
 */
export const SELF_CHECK_SETTING = "selfcheck.last";
export const SELF_CHECK_DAY_SETTING = "selfcheck.day";
export const SELF_CHECK_EVENT = "selfcheck.ran";

export type CheckStatus = "ok" | "repaired" | "failing" | "skipped";
export type CheckResult = {
  id: string; status: CheckStatus;
  /** A stable code for what was wrong (`OUTPUT_FILE_MISSING`); empty when ok. */
  code: string;
  /** What was found and what was done, in the person's language. */
  detail: string;
  at: string;
};
export type SelfCheckRecord = { at: string; results: CheckResult[] };

/** The features a probe covers, in the order 系统体检 lists them. Labels are the person's words for the feature. */
export const SELF_CHECK_FEATURES: Record<string, string> = {
  outputs: "助手产出文件",
  workflows: "自建工作流",
  mail: "邮箱与回信草稿",
  automations: "自动化",
  remoteBrowser: "托管登录浏览器",
  node: "算力节点",
  sandbox: "沙箱命令行",
  assistant: "助手中途提问",
};

export function readSelfCheck(raw: unknown): SelfCheckRecord | undefined {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) as SelfCheckRecord : raw as SelfCheckRecord | undefined;
    return value && Array.isArray(value.results) ? value : undefined;
  } catch { return undefined; }
}

/** Failing results the person has not been told about this week: told once per feature and code per ISO week. */
export const tellKey = (result: CheckResult, day: string): string => {
  const date = new Date(`${day}T12:00:00Z`);
  const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  return `selfcheck:${result.id}:${result.code}:${monday}`;
};
