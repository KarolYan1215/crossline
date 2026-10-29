import "server-only";
import { CALENDAR_SUBSCRIPTIONS_SETTING, CALENDAR_SYNC_FAILURE, localStamp, MAIL_ACCOUNTS_SETTING, PUSH_SUBSCRIPTIONS, SOURCE_FOLDERS_SETTING,
  type AccessContext, type CalendarSubscription, type CostSignal, type MailAccount, type SourceFolder } from "@crossline/core";
import { effectiveSchedulePreferences, getStore, loadCalendarConnectorState } from "./crossline";
import { publishStatus } from "./calendar-publish";
import { phoneDailyLatest, phoneHealthOn } from "./energy";
import { graphConfigured, isHostedBeta } from "./hosting";
import { tOf } from "./locale";

/** What kind of thing a row is, for its icon. */
export type ConnectionKind = "calendar" | "subscription" | "writer" | "mail" | "model" | "push" | "folder" | "health";
export type ConnectionRow = {
  id: string; kind: ConnectionKind; label: string; detail: string;
  /** ok: working; warn: broken or needs the person; off: not set up. */
  state: "ok" | "warn" | "off";
  status: string;
  /** The last time it worked, in the person's zone ("10/28 09:12"), when known. */
  lastOk?: string;
  /** What went wrong last, in words. */
  error?: string;
  /** Where it is fixed or set up: one of the settings modules or one of their cards. */
  action: { label: string; href: string };
};

const json = <T,>(raw: string | null | undefined, fallback: T): T => { try { return (JSON.parse(raw ?? "null") as T) ?? fallback; } catch { return fallback; } };

/**
 * The settings page's status overview (2026-10-28 redesign, docs/plans/page-drafts-1028/settings.html): every connection as one row —
 * what it is, whether it works, when it last worked, what went wrong, and the one place it is fixed. Read from the ledger only (the
 * quota is the one the page already reads), so the overview costs no extra call to the worker.
 */
export function connectionStatus(ctx: AccessContext, quota: CostSignal, options: { machine: boolean; phoneUrl: boolean }): ConnectionRow[] {
  const t = tOf(ctx);
  const store = getStore();
  const setting = (key: string) => store.getSetting(ctx.workspaceId, key);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const stamp = (iso: string | undefined | null) => iso ? localStamp(iso, zone) : undefined;
  const rows: ConnectionRow[] = [];

  // The Microsoft calendar (read sync), where this install can have one.
  if (graphConfigured() || !isHostedBeta()) {
    const calendar = loadCalendarConnectorState(ctx);
    const failure = json<{ message?: string; at?: string } | null>(setting(CALENDAR_SYNC_FAILURE), null);
    if (calendar.synced || failure) rows.push({ id: "calendar", kind: "calendar", label: t("Microsoft 日历"), detail: t("只读同步"),
      state: failure ? "warn" : "ok", status: failure ? t("读取失败") : t("只读同步中"),
      ...(calendar.lastChangeAt ? { lastOk: stamp(calendar.lastChangeAt)! } : {}),
      ...(failure ? { error: failure.message ? String(failure.message).slice(0, 120) : t("上次读取没有完成，下次自动重试") } : {}),
      action: { label: failure ? t("去修复") : t("管理"), href: "#calendar" } });
  }
  for (const sub of json<CalendarSubscription[]>(setting(CALENDAR_SUBSCRIPTIONS_SETTING), [])) rows.push({
    id: `ical:${sub.id}`, kind: "subscription", label: sub.label || sub.host, detail: t("订阅链接 · {{host}}", { host: sub.host }),
    state: sub.lastError ? "warn" : "ok", status: sub.lastError ? t("读取失败") : sub.lastReadAt ? t("已连接") : t("等待首次读取"),
    ...(sub.lastReadAt && !sub.lastError ? { lastOk: stamp(sub.lastReadAt)! } : {}),
    ...(sub.lastError ? { error: sub.lastError.slice(0, 120) } : {}),
    action: { label: sub.lastError ? t("去修复") : t("管理"), href: "#calendar-subscriptions" } });
  const publish = publishStatus(ctx);
  if (publish.account) {
    const failure = publish.failure && (!publish.last || publish.failure.at > publish.last.at) ? publish.failure : undefined;
    rows.push({ id: "writer", kind: "writer", label: t("Crossline 日历（写入）"), detail: t("排程自动写入，只改本应用建的事件"),
      state: failure ? "warn" : "ok", status: failure ? t("写入未完成") : t("自动写入中"),
      ...(publish.last ? { lastOk: stamp(publish.last.at)! } : {}), ...(failure ? { error: failure.text } : {}),
      action: { label: failure ? t("去修复") : t("管理"), href: "#calendar" } });
  }

  for (const account of json<MailAccount[]>(setting(MAIL_ACCOUNTS_SETTING), [])) rows.push({
    id: `mail:${account.id}`, kind: "mail", label: account.address, detail: account.triage ? t("只读 · 自动分拣") : t("只读 · 不分拣"),
    state: account.lastError ? "warn" : "ok", status: account.lastError ? t("读取失败") : t("已连接"),
    ...(account.lastCheckedAt ? { lastOk: stamp(account.lastCheckedAt)! } : {}),
    ...(account.lastError ? { error: account.lastError.message.slice(0, 120) } : {}),
    action: { label: account.lastError ? t("去修复") : t("管理"), href: "#mail" } });
  if (!rows.some((row) => row.kind === "mail")) rows.push({ id: "mail", kind: "mail", label: t("邮箱"), detail: t("只读（IMAP），不发信"),
    state: "off", status: t("未连接"), action: { label: t("去连接"), href: "#mail" } });

  // The model: the quota the page already read says whether a model answers at all.
  const quotaLeft = quota.available && !quota.money ? Math.min(...[quota.short, quota.long].filter(Boolean).map((window) => Math.round(100 - window!.usedPercent))) : undefined;
  rows.push({ id: "model", kind: "model", label: t("模型连接"), detail: quota.available
    ? quota.money ? t("API · 本月 ${{spent}} / ${{cap}}", { spent: quota.money.spent.toFixed(2), cap: quota.money.cap.toFixed(0) })
      : quotaLeft !== undefined && Number.isFinite(quotaLeft) ? t("额度剩 {{left}}%", { left: Math.max(0, quotaLeft) }) : t("已连接")
    : t("读不到额度"),
    state: !quota.available ? "warn" : quotaLeft !== undefined && quotaLeft <= 15 ? "warn" : "ok",
    status: !quota.available ? t("未连接或读不到") : quotaLeft !== undefined && quotaLeft <= 0 ? t("额度用尽") : t("可用"),
    action: { label: quota.available ? t("管理") : t("去连接"), href: "#model" } });

  if (options.phoneUrl) {
    const devices = json<unknown[]>(setting(PUSH_SUBSCRIPTIONS), []).length;
    rows.push({ id: "push", kind: "push", label: t("手机推送"), detail: devices ? t("{{count}} 台设备", { count: devices }) : t("添加到主屏幕后可收推送"),
      state: devices ? "ok" : "off", status: devices ? t("已开启") : t("未开启"), action: { label: devices ? t("管理") : t("去开启"), href: "#phone" } });
  }
  const health = phoneHealthOn(ctx.workspaceId);
  const latest = phoneDailyLatest(ctx.workspaceId);
  rows.push({ id: "health", kind: "health", label: t("手机健康数据"), detail: t("睡眠、静息心率、步数"),
    state: health ? "ok" : "off", status: health ? t("已开启") : t("未开启"), ...(latest ? { lastOk: latest.day.slice(5).replace("-", "/") } : {}),
    action: { label: health ? t("管理") : t("去开启"), href: "#energy" } });

  if (options.machine) for (const folder of json<SourceFolder[]>(setting(SOURCE_FOLDERS_SETTING), [])) rows.push({
    id: `folder:${folder.id}`, kind: "folder", label: folder.label || folder.path, detail: t("授权文件夹 · 已读 {{count}} 份", { count: folder.files ?? 0 }),
    state: "ok", status: t("读取中"), ...(folder.lastScanAt ? { lastOk: stamp(folder.lastScanAt)! } : {}),
    action: { label: t("管理"), href: "#calendar" } });
  return rows;
}
