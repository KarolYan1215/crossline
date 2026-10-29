/**
 * Fixed headings outside the portrait that are set in the poster's serif (`.pt-serif`, docs/onboarding-v3.md: the login and the
 * interview share the portrait's editorial style). Strings written in code only — the self-hosted subset is cut to exactly these
 * characters (`posterSerifText` → `scripts/poster-font-subset.ts`), so anything typed by a person or a model never uses it.
 */
export const LOGIN_SERIF = { brand: "Crossline", tagline: "几条人生主线，排进同一张日历", panel: "登录", signup: "注册", reset: "重置密码",
  newPassword: "设置新密码", setPassword: "设置登录密码" } as const;

export const INTERFACE_SERIF_STRINGS: readonly string[] = [...Object.values(LOGIN_SERIF)];

/**
 * The frame's display serif (`.ds-serif`, 2026-10-28 redesign of Today): the wordmark, the day's big date and clock, and the card titles.
 * Latin letters and digits come from the self-hosted Source Serif 4 Latin subset; the Chinese characters of these titles come from
 * `display-serif.woff2`, cut by `scripts/poster-font-subset.ts --display` to exactly `displaySerifText()`. A title added here needs the
 * subset rebuilt (`display-serif.test.ts` fails until it is). Strings written in code only, like the poster's.
 */
/* i18n-ignore-start: the characters the font subset must hold, not text shown from here (the titles are translated where they are shown).
   The plan page and 主线 (2026-10-28 redesign) add their page and card titles, and the day count in 主线's head. */
export const DISPLAY_SERIF = { energy: "今日精力", overview: "今日概览", needs: "件需要处理", calendar: "日历", input: "输入", flywheel: "飞轮图谱",
  plan: "计划", capacity: "容量与需求", shares: "各线排程份额", unplaced: "排不下的原因", time: "时段与精力", lineShares: "主线份额", advanced: "高级",
  estimates: "估时准确度", lines: "主线", timeline: "时间轴", days: "天",
  // Page and card titles of the other pages (2026-10-29: every page title in the display serif, not only Today, 计划 and 主线).
  pages: " 件需要处理· 天· 条主线 ·  条已批准关系 ·  条候选· 条待定·/ 步·24 小时内可撤销·Skill 库·不做了·不在这里处理·个性化·主线·主线份额·今天·今天开始过的块·今日概览·今日精力·任务·任务库·保·保守 ·候选关系·停转提示·剩余·助手 · ·可按推荐处理·各线排程 vs 份额·后台任务·周复盘·回看·在等·录音转写·待判断的问题·待确认·待验收 · ·总账·截止·截止优先，其余按份额分配·打包参数与排程顺序·打开今日·打开计划 →·排不下的原因·接下来·推到下周·收工·收集、修改、回答、提问，先确认再生效·日历·日历与连接·时段与精力·时间与提醒·时间轴·明天·最近自动生效 · ·未定·未来  周 · 每周小时·本周信息域扩展·本周做完后的累不累·本周刻度·本周各线投入·本周承诺·本周洞察提案·本周自动验收·本周调研结论·本机读什么、发到哪里。连接网页版后，这是电脑上唯一留下的页面。·欢迎回来·现在·用量与体检·确认后的影响·确认时间块·精力与手机健康·网页版不是谁的电脑：在本人电脑上的 Crossline 打开这个页面。·自动化与助手·补记·要拍板的·计划·记为完成的块·距 ·跨主线复用·输入·还没有排·这台电脑·进度·连接状态·通用·那天开始过的块·邮件、手机和输入框记下的每一笔，去重后汇成一本账；数字都由记录算出。·里程碑达成标准·隐私与屏幕活动·飞轮图谱·高级" } as const;
/* i18n-ignore-end */

/** The Chinese characters the display subset must hold, sorted and unique. */
export function displaySerifText(): string {
  return [...new Set(Object.values(DISPLAY_SERIF).join(""))].filter((char) => /[^\x00-\xff]/.test(char)).sort().join("");
}
