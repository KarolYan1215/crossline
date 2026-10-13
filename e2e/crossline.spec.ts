import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_AVAILABILITY } from "../packages/core/src/index.js";
import { TEST_EMAIL, TEST_PASSWORD } from "./global-setup.js";
import { signUpAccount } from "./accounts.js";
import { ensurePortrait, openStore, realWorkspaceId } from "./ledger.js";

type BrowserFetchResult = { ok: boolean; status: number; body: string };

/**
 * Calls the app's own API from inside the page — `page.evaluate`'s `fetch`, not Playwright's
 * `APIRequestContext` (neither the standalone `request` fixture nor `page.request`). Better Auth's
 * session cookie is `Secure`, and only a real browser's network stack applies Chrome's loopback
 * exception that still sends a `Secure` cookie over plain `http://127.0.0.1` — `APIRequestContext` is
 * Playwright's own separate HTTP client and does not, so every call through it came back 401 regardless
 * of a valid session existing. `page.goto()` navigations were never affected by this; only fetches
 * issued from outside the browser were.
 */
async function apiFetch(page: Page, method: string, url: string, data?: unknown,
  headers?: Record<string, string>): Promise<BrowserFetchResult> {
  return page.evaluate(async ({ method, url, data, headers }) => {
    const response = await fetch(url, {
      method, headers: { "content-type": "application/json", ...headers },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {})
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }, { method, url, data, headers });
}

async function ensureScheduleSetup(page: Page): Promise<void> {
  await page.goto("/plan");
  const result = await apiFetch(page, "POST", "/api/settings/schedule", { timeZone: "America/Chicago", mode: "buffered",
    windows: DEFAULT_AVAILABILITY, importance: {
      "research-starter": "important", "startup-starter": "important",
      "media-starter": "important", "investment-starter": "ordinary"
    } });
  if (!result.ok) throw new Error(`schedule setup failed: ${result.status} ${result.body}`);
}

/**
 * A next step of the person's own for the phone's Today. Every desktop test runs before the first phone test, against the same ledger,
 * and several write work of the person's own and hand it in; once any exists the demo orders stop being recommended
 * (`withoutShadowingDemos`), so by the time the phone ran there was nothing left to recommend and the hero card was never drawn.
 */
function ensureOwnNextStep(): void {
  const store = openStore();
  try {
    const workspaceId = realWorkspaceId(store);
    if (store.listWorkOrders(workspaceId).some((order) => order.id === "e2e-mobile-next")) return;
    store.saveWorkOrder({ id: "e2e-mobile-next", ownerId: store.getWorkspaceOwnerId(workspaceId)!, workspaceId, identityId: "research", projectId: "",
      milestoneId: "", intent: "整理手机端测试笔记", state: "ready_for_human", riskTier: "routine",
      estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45, source: "llm_prior", observationCount: 0, confidence: "low" },
      payload: { dueDate: "2026-09-16", materialContract: [], evidenceContract: [] } });
  } finally { store.close(); }
}

/**
 * What a visual baseline may not depend on. The header count depends on what other tests have written by now, and
 * where the scheduler put a block (and for how many minutes) depends on a time-limited solve that gives a
 * different feasible answer when the machine is busy. Both are hidden, not masked, so they keep their place and
 * the layout around them is what is compared; the schedule itself is tested where it is computed.
 */
// The plan page's charts, ranking lists and capacity figures come from the same time-limited solve, so they are left out as well; the
// ranking and the overload list are removed rather than hidden because how many rows they hold changes their height.
const STABLE_FOR_SCREENSHOT = ".pending-badge,.dv-block,.dv-aside,.undo-trigger,.wk-block,.mo-chip[data-kind=\"scheduled\"],.ui-bar-value,.ui-bar-fill,"
  + ".task-card-slot a,.pl-hours,.pl-svg,.pl-gantt-track,.pl-gantt-end,.pl-inv-share{visibility:hidden}"
  + ".pl-rank-table,.pl-library,.pl-explain p,.pl-over-list,.pl-stat .pl-chart-foot,.forecast-delta{display:none}";

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop-chrome") await ensureScheduleSetup(page);
});


test("Today keeps capture semantic-only and health outside identity navigation", async ({ page }, testInfo) => {
  if (testInfo.project.name === "mobile-chrome") ensureOwnNextStep();
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByText("精力自评", { exact: true })).toBeVisible();
  await expect(page.locator(".composer select")).toHaveCount(0);
  await expect(page.locator('.composer textarea[name="title"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "提交完成证据" })).toHaveCount(0);
  // The next-step card carries its own primary action; the whole card opens the task dialog.
  await expect(page.locator('.task-card[data-variant="hero"] .task-actions')).toBeVisible();
  // The pending count depends on what other tests have written by now, so it is hidden (not masked: hidden keeps its place).
  await page.addStyleTag({ content: STABLE_FOR_SCREENSHOT });
  if (testInfo.project.name === "desktop-chrome") await expect(page).toHaveScreenshot("today-paper-grid.png", { fullPage: true });
});

test("a task card opens its dialog in place, and the dialog's full-page link shows the same task", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/");
  const hero = page.locator('.task-card[data-variant="hero"]');
  const title = (await hero.locator(".task-card-title").textContent())!.trim();
  // Clicking the card (not one of its controls) opens the dialog without leaving Today.
  await hero.locator(".task-card-title").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: title })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  for (const tab of ["步骤", "教程", "材料", "标准", "记录"]) await expect(dialog.getByRole("tab", { name: tab })).toBeVisible();
  // The task's own input box sits above the tabs: everything about the task, in words.
  await expect(dialog.locator(".task-entry textarea, .task-entry [contenteditable], .task-entry input").first()).toBeVisible();
  const full = dialog.getByRole("link", { name: "完整页面" });
  const href = await full.getAttribute("href");
  expect(href).toMatch(/^\/workbench\//);
  await full.click();
  await expect(page).toHaveURL(new RegExp(href!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
  await expect(page.locator(".subpage-header h1")).toHaveText(title);
});
test("Plan is the long view: no calendar, four charts over a chosen horizon, nothing to approve", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/plan");
  const plan = page.locator("[data-plan-version]");
  await expect(plan).toHaveAttribute("data-plan-version", "personal-plan-v1");
  // The calendar is on Today only (decided 2026-10-10).
  await expect(page.locator(".mo-cell, .wk-col, .dv-block")).toHaveCount(0);
  for (const chart of ["容量与需求", "里程碑完成预测", "主线投入：计划与实际", "估时准确度与节律"]) await expect(page.getByRole("region", { name: chart })).toBeVisible();
  await expect(page.getByRole("button", { name: "立即同步日历" })).toBeVisible();
  await expect(page.getByRole("button", { name: "发布到 Crossline 日历" })).toBeVisible();
  // Eight weekly bars by default; four once the horizon is switched, kept in the address.
  await expect(page.locator(".pl-cd-week")).toHaveCount(8);
  await Promise.all([page.waitForURL(/horizon=4/), page.getByRole("radiogroup", { name: "统计范围" }).getByRole("radio", { name: "4 周" }).click()]);
  await expect(page.locator(".pl-cd-week")).toHaveCount(4);
  // Each milestone row opens its drawer on 主线.
  await expect(page.locator('.pl-gantt-row[href^="/milestones?open="]').first()).toBeVisible();
  // The settings are three tabs; importance lives only in 「排程依据」.
  const settings = page.getByRole("radiogroup", { name: "设置项" });
  for (const tab of ["可用时段", "排程参数", "排程依据"]) await expect(settings.getByRole("radio", { name: tab })).toBeVisible();
  await expect(settings.getByRole("radio", { name: "重要性" })).toHaveCount(0);
  await page.goto("/plan");
  // The plan takes effect by default (docs/loop-and-scout.md §1): no version to approve, no differences to settle.
  await expect(page.getByText("批准本批变更")).toHaveCount(0);
  if (testInfo.project.name === "desktop-chrome") {
    await page.waitForTimeout(800);
    await page.addStyleTag({ content: STABLE_FOR_SCREENSHOT });
    await expect(page.locator(".subpage")).toHaveScreenshot("plan-diff.png");
  }
});

test("editing availability re-runs the scheduler instead of only storing a preference", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/plan");
  // The capacity chart says how many minutes the scheduler placed in the first week.
  const capacity = page.getByRole("region", { name: "容量与需求" });
  const scheduledMinutes = async () => Number(await capacity.getAttribute("data-scheduled-minutes"));
  const before = await scheduledMinutes();
  expect(before).toBeGreaterThan(0);

  // Paint the week down to one half hour on the grid: erase each row with one drag, then paint a single cell. A preference that
  // stored cleanly and changed nothing on screen would mean the schedule was still example data wearing the setting's clothes.
  const grid = page.locator(".pl-grid");
  await page.getByRole("radio", { name: "擦除" }).click();
  for (const row of await grid.locator("tbody tr").all()) {
    const first = (await row.locator("td").first().boundingBox())!, last = (await row.locator("td").last().boundingBox())!;
    await page.mouse.move(first.x + 3, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width - 3, last.y + last.height / 2, { steps: 60 });
    await page.mouse.up();
  }
  await page.getByRole("radio", { name: "高精力" }).click();
  await grid.locator("tbody tr").last().locator("td").nth(12).click();
  await page.getByRole("button", { name: "预览影响" }).click();
  await expect(page.getByRole("dialog", { name: "改动影响" })).toBeVisible();
  // While the preview is open the charts above draw the change, with the current values as ghosts.
  await expect(capacity.locator(".pl-preview-note")).toBeVisible();
  await expect(capacity.locator(".pl-usable-ghost")).toHaveCount(1);
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.getByRole("button", { name: "应用", exact: true }).click()]);
  expect(await scheduledMinutes()).toBeLessThan(before);

  // Put it back: these tests share one ledger, and a crippled week would silently change what every
  // later assertion is looking at.
  const restored = await apiFetch(page, "POST", "/api/plan/impact", { change: { kind: "availability", windows: DEFAULT_AVAILABILITY }, apply: true });
  expect(restored.status).toBe(200);
});

test("energy check keeps self report only and rejects the removed camera path", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "运行十二秒本地摄像头代理采样" })).toHaveCount(0);
  const submitted = page.waitForResponse((response) => response.url().endsWith("/api/energy-observations") && response.request().method() === "POST");
  await page.getByRole("button", { name: "记录中精力" }).click();
  expect((await submitted).ok()).toBe(true);
  // The dashboard reloads itself after a successful submission to reflect the new energy reading —
  // `apiFetch` below runs `page.evaluate` in that page's JS context, which a reload mid-flight destroys.
  await page.waitForLoadState("networkidle");
  const store = openStore();
  try { expect(store.listEnergyObservations(realWorkspaceId(store)).some((item) => item.level === "medium")).toBe(true); }
  finally { store.close(); }
  const cameraRejected = await apiFetch(page, "POST", "/api/energy-observations",
    { source: "camera_proxy", level: "unclassified", confidence: "low", aggregate: {} });
  expect(cameraRejected.status).toBe(400);
  expect(JSON.parse(cameraRejected.body)).toMatchObject({ code: "CAMERA_ENERGY_PATH_REMOVED" });
  const rawRejected = await apiFetch(page, "POST", "/api/energy-observations",
    { source: "self_report", level: "medium", confidence: "high", aggregate: {}, frame: "data:image/jpeg;base64,forbidden" });
  expect(rawRejected.status).toBe(400);
  expect(JSON.parse(rawRejected.body)).toMatchObject({ code: "RAW_MEDIA_OR_UNKNOWN_FIELD_FORBIDDEN" });
  const blinkRejected = await apiFetch(page, "POST", "/api/energy-observations",
    { source: "self_report", level: "medium", confidence: "high", aggregate: { meanBlinkProxy: 0.1 } });
  expect(blinkRejected.status).toBe(400);
  expect(JSON.parse(blinkRejected.body)).toMatchObject({ code: "AGGREGATE_FEATURES_ONLY" });
});

test("goal confirmation and permission-mode rejection persist through the real pages", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/milestones");
  // The deadline is edited where it is shown: the milestone's drawer, opened from its node on the timeline.
  await page.locator(".mt-node").filter({ hasText: "稳定推进当前实验与论文" }).click();
  const drawer = page.locator(".ui-sheet");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    drawer.locator('input[type="date"]').fill("2026-09-30", { force: true })
  ]);
  await page.locator(".mt-node").filter({ hasText: "稳定推进当前实验与论文" }).click();
  await expect(page.locator(".ui-sheet").locator('input[type="date"]')).toHaveValue("2026-09-30");
  await page.goto("/plan");
  // The confirmed deadline is the ◆ on that milestone's row of the finish-range chart.
  await expect(page.locator('.pl-gantt-deadline[data-deadline="2026-09-30"]')).toHaveCount(1);

  const store = openStore();
  try { store.appendEvent({ ownerId: "e2e-tester", workspaceId: realWorkspaceId(store),
    idempotencyKey: "e2e:insight-candidate", type: "flywheel.finding", entityId: "research-starter",
    payload: { milestoneId: "research-starter", summary: "可复用的实验记录模板",
      sourceUrl: "https://example.org/source", sourceTitle: "记录模板", retrievedAt: "2026-09-14T00:00:00Z",
      staleWhen: "方法变更" } }); }
  finally { store.close(); }
  // The default-approval switch lives in 设置 → 自动化与助手 now, and every decision on an insight is made in the weekly review.
  await page.goto("/settings#automation");
  const lowRisk = page.getByRole("radiogroup", { name: "低风险提案默认批准" });
  await lowRisk.getByRole("radio", { name: "默认批准" }).click();
  await expect(page.locator(".st-ok").first()).toBeVisible();
  await page.goto("/review");
  const insight = page.locator(".review-list li").filter({ hasText: "可复用的实验记录模板" });
  await expect(insight).toBeVisible();
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), insight.getByRole("button", { name: "拒绝" }).click()]);
  await expect(page.locator(".review-list li").filter({ hasText: "可复用的实验记录模板" })).toContainText("已拒绝");
  await page.goto("/settings#automation");
  await page.getByRole("radiogroup", { name: "低风险提案默认批准" }).getByRole("radio", { name: "逐项批准" }).click();
  await expect(page.locator(".st-ok").first()).toBeVisible();
  const rejected = openStore();
  try { expect(rejected.listEvents(realWorkspaceId(rejected), { type: "insight.rejected" })).toHaveLength(1); }
  finally { rejected.close(); }
  // Deliberately `page.request`, not `apiFetch`: a forged `Origin` header is exactly what this test
  // needs to send, and the Fetch spec makes `Origin` a forbidden header a page's own `fetch()` can never
  // override — only Playwright's separate `APIRequestContext` can set it. `isCrossSiteWrite` runs before
  // the session check, so the missing auth cookie this context still has (see `apiFetch`'s doc comment)
  // never even matters here: the forged Origin is refused first.
  const forbidden = await page.request.post("/api/goals/research-starter", {
    headers: { Origin: "https://attacker.example" },
    data: { importance: "ordinary", confirmedDeadline: null }
  });
  expect(forbidden.status()).toBe(403);
});

test("mobile navigation and reduced motion remain usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome");
  ensureOwnNextStep();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "今日" })).toBeVisible();
  // What is waiting and the settings sit behind the fifth tab.
  await expect(page.getByText("更多")).toBeVisible();
  await expect(page.locator('.task-card[data-variant="hero"]')).toBeVisible();
});

/**
 * The offline claim, tested against a real service worker for the first time.
 *
 * This could not be verified before: the suite ran `next dev`, and `next.config.mjs` disables Serwist
 * in development, so no service worker was ever registered here. It was not "unverified", it was
 * unverifiable, and no assertion written against that setup would have meant anything.
 */
test("the app opens with the network down, and the offline capture queues", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");

  await page.goto("/");
  // First load installs it; a second load is what puts it in control of the page.
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, { timeout: 30_000 });
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);

  // Proves the offline switch actually bit. Without this the test would pass just as happily if
  // `setOffline` were a no-op — Playwright's interception of service-worker requests has a history of
  // being unreliable, so the cut has to be demonstrated rather than assumed.
  const reachable = await page.evaluate(() => fetch("/api/health", { cache: "no-store" }).then(() => true, () => false));
  expect(reachable).toBe(false);

  await page.reload();
  // The headline claim: the shell came from the cache, not the server.
  await expect(page.getByRole("link", { name: "任务" })).toBeVisible();
  await expect(page.locator(".analog-clock")).toBeVisible();

  // And a capture taken while down is kept rather than lost.
  await page.locator('.composer textarea[name="title"]').fill("断网时记下的一条");
  await page.getByRole("button", { name: "发送" }).first().click();
  await expect(page.locator(".composer-status")).toContainText("已离线保存，联网后自动同步");

  const queued = await page.evaluate(async () => {
    // Workspace-scoped, not a fixed name (`crossline-offline-${workspaceId}`) — switching accounts on
    // the same browser must not read the previous account's queue. `OfflineReplay` remembers the id in
    // localStorage precisely so a check like this one, with no server round trip, can find it.
    const workspaceId = localStorage.getItem("crossline.offline.workspaceId");
    if (!workspaceId) throw new Error("workspace id was never remembered");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`crossline-offline-${workspaceId}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<number>((resolve, reject) => {
      const query = db.transaction("pending", "readonly").objectStore("pending").getAll();
      query.onsuccess = () => resolve(query.result.length);
      query.onerror = () => reject(query.error);
    });
  });
  expect(queued).toBe(1);

  await context.setOffline(false);
});

/**
 * Two devices signed into the same account is the normal shape of "offline workbench", not an edge
 * case — a phone that lost signal mid-session and a laptop that never did. `transitionWorkOrder`'s own
 * state preconditions (`startWorkOrderExecution` refuses anything but `approved`/`ready_for_human`) are
 * what the offline queue's conflict path leans on: replaying a stale command against a work order that
 * moved on comes back 409, and `classifyReplay` is what turns that into "review this" instead of either
 * "silently discard" or "corrupt the real state".
 */
test("a work order started on one device becomes a conflict when another device's queued command replays", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  const store = openStore();
  const workspaceId = realWorkspaceId(store);
  const id = "e2e-conflict-wo";
  try {
    store.saveWorkOrder({
      id, ownerId: "e2e-tester", workspaceId, identityId: "research", projectId: "p",
      milestoneId: "m", intent: "两台设备冲突测试", state: "ready_for_human", riskTier: "routine",
      estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
      payload: { materialContract: [], evidenceContract: [] }
    });
  } finally { store.close(); }

  // Device B loads the page first, while the order is still `ready_for_human`, then goes offline — its
  // UI keeps showing that stale state from here on, same as a phone that lost signal mid-session.
  const deviceB = await browser.newContext({ storageState: testInfo.project.use.storageState as string });
  const pageB = await deviceB.newPage();
  await pageB.goto("/workbench");
  await expect(pageB.locator(`#work-order-${id}`).getByRole("button", { name: "开始计时" })).toBeVisible();
  await deviceB.setOffline(true);

  // Device A — the default page — moves the same order past `active` entirely: `startWorkOrderExecution`
  // treats an already-`active` order as an idempotent no-op success (not a conflict — a genuine
  // double-click online must not error), so the order has to move somewhere `start` can no longer apply
  // at all for device B's stale `start` to actually collide with anything.
  await page.goto("/workbench");
  // 开始计时 starts the session and opens the task's own page; completion is in its 记录 tab.
  await Promise.all([
    page.waitForURL(new RegExp(`/workbench/${id}$`)),
    page.locator(`#work-order-${id}`).getByRole("button", { name: "开始计时" }).click()
  ]);
  await page.getByRole("tab", { name: "记录" }).click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.getByRole("button", { name: "完成（记为无证据）" }).click()
  ]);
  // Polled: `waitForNavigation` can resolve on the reload of the previous click before this completion's POST has
  // landed, and a single read then raced it (the page itself showed 「证据审查中」 a moment later).
  await expect.poll(() => {
    const afterA = openStore();
    try { return afterA.listWorkOrders(workspaceId).find((item) => item.id === id)?.state; }
    finally { afterA.close(); }
  }, { timeout: 10_000 }).toBe("evidence_review");

  // Device B, still believing the order is `ready_for_human`, starts it too — offline, so this queues
  // instead of failing outright.
  await pageB.locator(`#work-order-${id}`).getByRole("button", { name: "开始计时" }).click();
  await expect(pageB.locator(`#work-order-${id}`).getByRole("status")).toContainText("已离线保存，联网后自动同步");

  // Back online: `/` mounts `OfflineReplay`, which replays on load — the queued `start` hits a work
  // order that can no longer be started (`EXECUTION_NOT_STARTABLE`, a 409) and conflicts, rather than
  // either silently failing or corrupting the real state. Asserted on `/` itself, not by navigating on to
  // `/offline`: that second navigation raced against the service worker's own `/offline` fallback routing
  // (`apps/web/app/sw.ts`) and intermittently aborted — `OfflineReplay`'s banner already renders the same
  // conflict count and title inline.
  await deviceB.setOffline(false);
  await pageB.goto("/");
  await expect(pageB.getByText("1 条与其他设备冲突")).toBeVisible();
  await expect(pageB.getByText("两台设备冲突测试")).toBeVisible();

  await deviceB.close();
});

/**
 * The system's questions on Today, as a stack: something awaited that was due on top and a backplan that found two missing inputs
 * (shown under the milestone's name once) beneath it, stepped through with ‹ › and the arrow keys, each answered in place from options
 * already written out — one with a follow-up form prefilled from what the system knew — the next coming up by itself, and the 待确认
 * count going down, without a page reload.
 */
test("Today asks what only the person knows, with options and follow-ups, and moves to the next on answering", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/");
  const store = openStore();
  try {
    const workspaceId = realWorkspaceId(store);
    const milestone = store.listMilestones(workspaceId).filter((item) => item.status === "approved").at(-1)!;
    store.appendEvent({ ownerId: "e2e-tester", workspaceId, idempotencyKey: "e2e:backplan-blocked", type: "goal.backplan_blocked", entityId: milestone.id,
      payload: { milestoneVersion: milestone.version, code: "BACKPLAN_INPUT_BLOCKED", message: "缺组会录音",
        missing: [{ id: "m1", what: "组会录音", whoHas: "导师", message: "没有组会录音，无法列出要回应的质疑。" },
          { id: "m2", what: "导师批注", whoHas: "", message: "没有导师对初稿的批注。" }] } });
    store.saveWaitingItem({ id: "wait-e2e", ownerId: "e2e-tester", workspaceId, title: "实测数据", who: "师兄", expectedAt: "2026-09-14",
      approximate: true, followUpAt: "2026-09-14", state: "open", blocks: [], source: "manual" });
  } finally { store.close(); }
  await page.goto("/");
  const list = page.getByRole("region", { name: "待决事项" });
  await expect(list.getByRole("heading", { name: /^待决事项/ })).toBeVisible();
  // A stack: the most urgent (the awaited item, due today) on top, the milestone's missing inputs as the edge beneath it.
  const waiting = list.locator(".ask-card").filter({ hasText: "师兄的「实测数据」到了吗？" });
  await expect(waiting).toBeVisible();
  await expect(list.locator(".ask-peek").first()).toContainText("还缺 2 样东西");
  const group = list.locator(".ask-group");
  await expect(group).toHaveCount(0);
  // ‹ › and the arrow keys move through the stack without answering anything.
  await list.getByRole("button", { name: "下一项" }).click();
  await expect(group.getByRole("heading", { level: 3 })).toContainText("还缺 2 样东西");
  await expect(waiting).toHaveCount(0);
  await list.getByRole("button", { name: "上一项" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(waiting).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(group).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  // Answering the top one brings up the next by itself.
  await waiting.getByRole("button", { name: /^不等了/ }).click();
  await expect(list.locator(".ask-card").filter({ hasText: "实测数据」到了吗" })).toHaveCount(0);
  await expect(group.locator("h4")).toHaveText(["组会录音", "导师批注"]);
  const missing = group.locator(".ask-input").filter({ hasText: "组会录音" });
  await expect(missing).toContainText("没有组会录音，无法列出要回应的质疑。");
  const badge = page.locator(".running-head .pending-badge");
  const badgeMinusTotal = async () => (await badge.count() ? Number(await badge.textContent()) : 0)
    - await page.evaluate(async () => ((await (await fetch("/api/pending", { cache: "no-store" })).json()) as { total: number }).total);
  await missing.getByRole("button", { name: /已索取，等待中/ }).click();
  await expect(missing.getByLabel(/谁给/)).toHaveValue("导师");
  await missing.getByLabel("大约哪天到").fill("2026-09-16");
  await missing.getByRole("button", { name: "确定：已索取，等待中" }).click();
  await expect(list.getByText("组会录音", { exact: true })).toHaveCount(0);
  // The header's count follows the answer without a reload (it used to stay at the old number for up to a minute).
  await expect.poll(badgeMinusTotal).toBe(0);
  // Waiting on the recording raised its own 「到了吗？」 for the 16th, which now sits on top; the remaining input is the edge beneath.
  await list.locator(".ask-peek").filter({ hasText: "导师批注" }).click();
  const second = list.locator(".ask-card").filter({ hasText: "还缺：导师批注" });
  await second.getByRole("button", { name: /^自行获取/ }).click();
  await expect(second).toHaveCount(0);
  const after = openStore();
  try {
    const workspaceId = realWorkspaceId(after);
    expect(after.listWaitingItems(workspaceId).find((item) => item.title === "组会录音")).toMatchObject({ who: "导师", expectedAt: "2026-09-16", source: "backplan" });
    expect(after.listWaitingItems(workspaceId).find((item) => item.id === "wait-e2e")!.state).toBe("cancelled");
    expect(after.listEvents(workspaceId, { type: "ask.answered" })).toHaveLength(3);
  } finally { after.close(); }
});

// F1: the panel beside the day is the one place a block is looked at and acted on. The detail strip under the calendar is gone.
test("Today's day panel switches to a picked block's task, starts it there, and hands it in with a line and a file", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  // Its own task, so the week has a startable block whatever the tests before it started or finished.
  const seed = openStore();
  try {
    const workspaceId = realWorkspaceId(seed);
    seed.saveWorkOrder({ id: "e2e-panel-task", ownerId: seed.getWorkspaceOwnerId(workspaceId)!, workspaceId, identityId: "research", projectId: "",
      milestoneId: "", intent: "整理面板测试提纲", state: "approved", riskTier: "routine",
      estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { dueDate: "2026-09-16" } });
  } finally { seed.close(); }
  await page.goto("/");
  const calendar = page.getByRole("region", { name: "今天的时间轴" });
  const panel = calendar.locator(".dv-aside");
  await expect(panel.getByRole("heading", { name: "当日负荷" })).toBeVisible();
  await expect(page.locator(".cal-detail")).toHaveCount(0);
  const week = calendar.getByRole("tab", { name: "周", exact: true });
  await week.click();
  const blocks = calendar.locator('.wk-block[data-kind="scheduled"]');
  const count = await blocks.count();
  expect(count).toBeGreaterThan(0);

  // The week has no panel of its own: a block picked there opens its day with the block picked, and its task fills the panel.
  const title = (await blocks.first().locator("b").textContent())!.trim();
  await blocks.first().click();
  await expect(calendar.getByRole("tab", { name: "日", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("heading", { name: "选中的日程" })).toBeVisible();
  await expect(panel.locator(".dq-focus")).toContainText(title);
  await expect(panel.locator(".dq-focus .task-quick-edit")).toBeVisible();
  await panel.getByRole("button", { name: "返回下一项" }).click();
  await expect(panel.getByRole("heading", { name: "选中的日程" })).toHaveCount(0);

  // Start from a block whose task can start: the timer runs and the task page opens.
  let workOrderId = "";
  for (let index = 0; index < Math.min(count, 8) && !workOrderId; index += 1) {
    await week.click();
    const block = blocks.nth(index);
    const id = await block.getAttribute("data-work-order");
    await block.click();
    const start = panel.locator(".dq-focus").getByRole("button", { name: "开始计时" });
    if (!id || !(await start.count())) continue;
    await Promise.all([page.waitForURL(/\/workbench\//), start.click()]);
    workOrderId = id;
  }
  expect(workOrderId).not.toBe("");

  // Back on Today, the same task's block offers 完成并提交材料: one line, one file, 提交.
  await page.goto("/");
  await week.click();
  await calendar.locator(`.wk-block[data-work-order="${workOrderId}"]`).first().click();
  await panel.getByRole("button", { name: "完成并提交材料" }).click();
  const dialog = page.getByRole("dialog", { name: "完成并提交材料" });
  await dialog.getByLabel("完成说明").fill("完成结果段初稿并附上提纲");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "提纲.txt", mimeType: "text/plain", buffer: Buffer.from("提纲\n- 结果一\n") });
  await expect(dialog.getByText("提纲.txt")).toBeVisible();
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), dialog.getByRole("button", { name: "提交", exact: true }).click()]);

  const store = openStore();
  try {
    const workspaceId = realWorkspaceId(store);
    expect(store.listWorkOrders(workspaceId).find((order) => order.id === workOrderId)?.state).toBe("evidence_review");
    const claims = store.listEvidenceClaims(workspaceId).filter((claim) => claim.workOrderId === workOrderId);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(["file", "record"]);
  } finally { store.close(); }
});

// F2: the per-line cards at the bottom of Today became one graph of every line's milestones and the relations between them.
test("Today's flywheel graph draws each line around its goal and opens a milestone on the 主线 page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/");
  await expect(page.locator(".lines-strip")).toHaveCount(0);
  const graph = page.getByRole("region", { name: "飞轮图谱" });
  await expect(graph.locator('.fw-node[data-kind="anchor"]').first()).toBeVisible();
  await expect(graph.locator(".fw-lines li").first()).toContainText("项进行中");
  const node = graph.locator('.fw-node[data-kind="milestone"]').first();
  await expect(node).toBeVisible();
  // Zooming with the wheel changes the drawing without scrolling the page.
  const before = await node.getAttribute("transform");
  await graph.locator("svg.fw-graph").scrollIntoViewIfNeeded();
  const box = (await graph.locator("svg.fw-graph").boundingBox())!;
  // Away from the centre: a dot that sits exactly under the pointer stays put while the drawing scales about it.
  const at = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.8 };
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("svg.fw-graph")), at)).toBe(true);
  // The server-drawn graph shows before its script attaches, so the wheel is repeated until the drawing answers.
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => { await page.mouse.wheel(0, -200); return node.getAttribute("transform"); }).not.toBe(before);
  // Once it answers, a wheel turn zooms again and the page stays where it is.
  const zoomed = await node.getAttribute("transform");
  const scrolled = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => node.getAttribute("transform")).not.toBe(zoomed);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  await graph.getByRole("button", { name: "复位" }).click();
  await Promise.all([page.waitForURL(/\/milestones\?open=/), node.locator("circle").first().click()]);
});

// The poster in style A (decided 2026-10-12): the shareable half's first page and the 4:5 share card, from the fictional fixture.
// No figure is drawn in e2e, which keeps the picture stable; the card is moved on screen only to be photographed.
test("画像海报的视觉基线", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "one width is enough for a poster of fixed size");
  await ensurePortrait(page);
  await page.goto("/portrait");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // The poster is taller than the window: sticky bars would otherwise sit on its top edge in the photo.
  await page.addStyleTag({ content: ".running-head,.pt-toolbar{position:static !important}" });
  await expect(page.locator(".pt-page.pt-type").first()).toHaveScreenshot("portrait-share-half.png");
  await page.addStyleTag({ content: ".pt-offscreen{position:static !important;left:auto !important}" });
  await expect(page.locator(".pt-card")).toHaveScreenshot("portrait-card.png");
});

test("signing out deletes this browser's offline database for the workspace it was using", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/");
  const workspaceId = await page.evaluate(() => localStorage.getItem("crossline.offline.workspaceId"));
  expect(workspaceId).toBeTruthy();
  // Prove the database actually exists first, so "it's gone" afterward is not vacuously true.
  await page.evaluate((id) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(`crossline-offline-${id}`);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  }), workspaceId);

  // A session of this test's own: signing out revokes the session on the server, and the shared one from global-setup is what
  // the phone tests (which run after the desktop) still sign in with.
  const signIn = await apiFetch(page, "POST", "/api/auth/sign-in/email", { email: TEST_EMAIL, password: TEST_PASSWORD });
  expect(signIn.ok).toBe(true);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login/);

  const databases = await page.evaluate(() => indexedDB.databases());
  expect(databases.some((db) => db.name?.startsWith("crossline-offline-"))).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("crossline.offline.workspaceId"))).toBeNull();
});


test("未达可开始标准时打开今日页回到访谈，并写明还差什么；达标后停在今日页", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  const baseURL = testInfo.project.use.baseURL as string;
  const email = "e2e-start-gate@crossline.test", password = "Crossline-E2E-Gate-Pass-1!";
  await signUpAccount(baseURL, email, password, "E2E Gate");
  // A second account of its own, so the shared ledger's main account is not touched.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto("/login");
    expect((await apiFetch(page, "POST", "/api/auth/sign-in/email", { email, password })).ok).toBe(true);
    const before = (() => { const store = openStore(); try { return new Set(store.listWorkspaces().map((item) => item.id)); } finally { store.close(); } })();
    // The example board meets the start standard: the first visit lands on Today.
    await page.goto("/");
    await expect(page).toHaveURL(`${baseURL}/`);
    const store = openStore();
    let label = "";
    let restore = "";
    try {
      const workspaceId = store.listWorkspaces().map((item) => item.id).find((id) => !before.has(id));
      if (!workspaceId) throw new Error("the new account has no workspace");
      restore = store.getSetting(workspaceId, "lines.v1") ?? "";
      const lines = JSON.parse(restore) as Array<{ label: string; goal: string; goals?: string[] }>;
      label = lines[0]!.label;
      lines[0] = { ...lines[0]!, goal: "", goals: [] };
      store.setSetting(workspaceId, "lines.v1", JSON.stringify(lines));
      await page.goto("/");
      await expect(page).toHaveURL(/\/onboarding/);
      // The interview says what is missing: here, the first line's long-term goal, adopted under the portrait.
      const missing = page.getByRole("region", { name: "开始使用前还差" });
      await expect(missing).toContainText("开始使用前还差 1 项");
      await expect(missing).toContainText(label);
      store.setSetting(workspaceId, "lines.v1", restore);
    } finally { store.close(); }
    await page.goto("/");
    await expect(page).toHaveURL(`${baseURL}/`);
  } finally {
    await context.close();
  }
});
