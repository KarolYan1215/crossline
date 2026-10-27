import { BACKGROUND_BLOCKER, QUOTA_SAVER_SETTING, QUOTA_SAVER_TOLD_SETTING, backgroundSpend, engagementTier, quotaSaverReading, saverStopsNonCore,
  spendAllows, tFor, zoneWeekStart, type BackgroundSpend, type CostSignal, type QuotaSaver, type SpendKind } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { localeOf } from "./locale";
import { sayToPerson } from "./workflow-smith";

/**
 * Reads the quota for one workspace's background passes and records the reason when it pauses them, so a paused
 * background is something the person is told about rather than a tick that silently does nothing.
 */
export function createBackgroundSpend(store: CrosslineStore, readCost: (workspaceId: string) => Promise<CostSignal>, now = () => new Date()) {
  return async (workspaceId: string): Promise<BackgroundSpend> => {
    const signal = await readCost(workspaceId).catch((error: unknown): CostSignal =>
      ({ available: false, reason: error instanceof Error ? error.message : String(error) }));
    // Spending follows the person: how recently they did something themselves decides what may run at all.
    const since = store.listWorkspaces().find((workspace) => workspace.id === workspaceId)?.createdAt;
    const spend = { ...backgroundSpend(signal, localeOf(store, workspaceId)), engagement: engagementTier(store.lastPersonActivity(workspaceId), now(), since),
      saver: quotaSaverFor(store, workspaceId, now()) };
    const recorded = store.getSetting(workspaceId, BACKGROUND_BLOCKER);
    if (spend.blocker) {
      // Written only when the reason changes, so `at` says since when, not when the tick last looked.
      // A new reset time (a window rolled over, or a reading that first carries one) is written too.
      const previous = recorded ? JSON.parse(recorded) as { code?: string; resetsAt?: string } : undefined;
      if (!previous || previous.code !== spend.blocker.code || previous.resetsAt !== spend.blocker.resetsAt)
        store.setSetting(workspaceId, BACKGROUND_BLOCKER, JSON.stringify({ ...spend.blocker,
          at: previous?.code === spend.blocker.code && "at" in (previous ?? {}) ? (previous as { at: string }).at : new Date().toISOString() }));
    } else if (recorded) store.setSetting(workspaceId, BACKGROUND_BLOCKER, "");
    return spend;
  };
}

/** The person's zone, as every other worker pass reads it: the schedule's preference, else the deployment's, else Chicago. */
function personZone(store: CrosslineStore, workspaceId: string): string {
  let zone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  try {
    const preferred = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: unknown } | null)?.timeZone;
    if (typeof preferred === "string" && preferred) { new Intl.DateTimeFormat("en", { timeZone: preferred }); zone = preferred; }
  } catch { /* the default */ }
  return zone;
}

/** 节省额度 for this moment: the switch, the person's night, and whether non-core work has reached its share of this week. */
export function quotaSaverFor(store: CrosslineStore, workspaceId: string, now: Date): QuotaSaver {
  const zone = personZone(store, workspaceId);
  return quotaSaverReading({ raw: store.getSetting(workspaceId, QUOTA_SAVER_SETTING), now, zone,
    usage: store.modelUsageByPurpose(workspaceId, zoneWeekStart(now, zone).at) });
}

/**
 * The gate for one non-core pass (`spendAllows` with `nonCore`), which also tells the person — once a week, with no figures — when the
 * saver is what holds that work back.
 */
export function nonCoreAllowed(store: CrosslineStore, workspaceId: string, spend: BackgroundSpend, kind: SpendKind, now = new Date()): boolean {
  if (spendAllows(spend, kind, { nonCore: true })) return true;
  if (spend.saver && saverStopsNonCore(spend, kind) && store.getSetting(workspaceId, QUOTA_SAVER_TOLD_SETTING) !== spend.saver.week) {
    store.setSetting(workspaceId, QUOTA_SAVER_TOLD_SETTING, spend.saver.week);
    const t = tFor(localeOf(store, workspaceId));
    sayToPerson(store, workspaceId, t("本周非必需的后台工作（公开技能搜寻、主线调研、夜间飞轮、画像重写等）已到节省额度的上限，下周一起再继续；访谈、收集分析、拆步骤、助手代办等照常运行。"),
      "quota_saver", `quota-saver:${spend.saver.week}`, [{ label: t("后台任务设置"), href: "/settings#background" }], now);
  }
  return false;
}
