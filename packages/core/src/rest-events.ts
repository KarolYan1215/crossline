/**
 * Calendar events that are rest, not a commitment (walkthrough W-156, 2026-10-29): 「今晚 9 点以后不要再排工作了」 became a 21:00–23:59
 * 「休息」 event, and the day panel then read 「固定日程 7.5 小时」 — rest counted with the classes and meetings. Rest still keeps work
 * off those hours (it stays a busy block for the scheduler); it is only not counted as fixed schedule, and the evening wrap-up takes the
 * person's last working hour as ending where it begins.
 *
 * By title (meals, sleep, a break, 「不排工作」), unless the title also names something attended (a lunch seminar, a dinner meeting);
 * and by free/busy where the calendar says it (`showAs: free`, iCal `TRANSPARENT`, which the iCal reader already leaves out).
 */
// i18n-ignore-start: patterns matched against calendar titles
const REST = /休息|午休|小憩|放松|下班|收工|不(?:再)?(?:排|安排)?工作|勿扰|睡觉|睡眠|就寝|午饭|午餐|晚饭|晚餐|早餐|早饭|吃饭|用餐|\b(?:break|rest|lunch|dinner|breakfast|sleep|nap|off[- ]work|downtime|do not disturb)\b/i;
const ATTENDED = /会议|组会|例会|讲座|课|研讨|答辩|面试|约见|seminar|meeting|talk|workshop|class|lecture|interview|sync|1:1|office hours/i;
// i18n-ignore-end

export function isRestEvent(event: { title: string; showAs?: string | undefined }): boolean {
  if (event.showAs && /^(free|transparent)$/i.test(event.showAs)) return true;
  return REST.test(event.title) && !ATTENDED.test(event.title);
}
