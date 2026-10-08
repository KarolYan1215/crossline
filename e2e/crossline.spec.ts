import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
// Relative, not @crossline/db: the repo root is not a workspace package and has no such dependency.
import { CrosslineStore } from "../packages/db/src/index.js";
import { DEFAULT_AVAILABILITY } from "../packages/core/src/index.js";

function openStore(): CrosslineStore {
  return new CrosslineStore(path.join(process.env.CROSSLINE_E2E_DATA_DIR!, "crossline.db"));
}

/**
 * `global-setup.ts` signs in the one e2e test account once per run, and its first authenticated request
 * is what creates that account's principal+workspace row (`requireAccessContext`'s
 * `createPrincipalWithWorkspace`) — there is no hardcoded workspace id to read any more, real accounts
 * get a real generated one. A fresh per-run database has exactly one, so the first is the right one.
 */
function realWorkspaceId(store: CrosslineStore): string {
  const workspace = store.listWorkspaces()[0];
  if (!workspace) throw new Error("No workspace exists yet — did global-setup.ts's sign-in run?");
  return workspace.id;
}

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

/**
 * Two pending diffs on the starter plan, written the way a calendar sync writes them.
 *
 * The seeded ledger used to ship two example diffs so the C lens had something to show. They pointed
 * at example blocks that no longer exist — the AI lane is the scheduler's real output now — so they
 * were removed, and with them the only thing the approval flow could be driven against. A test that
 * needs a precondition should create it: this opens the same SQLite file the server has open (WAL,
 * two writers, which is how this app already runs) rather than putting demo rows back in production.
 */
async function seedPendingChanges(page: Page): Promise<void> {
  // Touch a page first: the plan version is created by the server's own first-run seeding, and a
  // change row cannot reference a plan that does not exist yet.
  await page.goto("/plan");
  const store = openStore();
  try {
    const workspaceId = realWorkspaceId(store);
    if (store.listPlanChanges(workspaceId, "personal-plan-v1").length > 0) return;
    const event = store.appendEvent({
      ownerId: "e2e-tester", workspaceId, idempotencyKey: "e2e:plan-diff",
      type: "calendar.synced", entityId: "personal-plan-v1", payload: { source: "e2e" }
    });
    for (const [index, explanation] of ["把写作挪到上午的高精力段", "为下午的会议让出一小时"].entries()) {
      store.savePlanChange({
        id: `e2e-change-${index + 1}`, ownerId: "e2e-tester", workspaceId,
        planVersionId: "personal-plan-v1", kind: "move", triggerEventId: event.eventId,
        explanation, status: "pending"
      });
    }
  } finally { store.close(); }
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
 * What a visual baseline may not depend on. The header count depends on what other tests have written by now, and
 * where the scheduler put a block (and for how many minutes) depends on a time-limited solve that gives a
 * different feasible answer when the machine is busy. Both are hidden, not masked, so they keep their place and
 * the layout around them is what is compared; the schedule itself is tested where it is computed.
 */
const STABLE_FOR_SCREENSHOT = ".pending-badge,.dt-block,.dt-label-col small,.wk-block,.mo-chip[data-kind=\"scheduled\"]{visibility:hidden}";

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop-chrome") await ensureScheduleSetup(page);
});


test("Today keeps capture semantic-only and health outside identity navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByText("精力自评", { exact: true })).toBeVisible();
  await expect(page.locator(".capture-form select")).toHaveCount(0);
  await expect(page.locator('.capture-form input[name="title"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "提交完成证据" })).toHaveCount(0);
  // 工作块F: 下一行动卡片直接内嵌开始/暂停/完成+证据操作（ExecutionActions），不再只是一个跳转链接；
  // 独立详情页的入口被保留为一个单独的小链接。
  await expect(page.locator(".hero-action .execution-actions")).toBeVisible();
  await expect(page.locator(".hero-action a.hero-detail-link")).toHaveAttribute("href", /\/workbench\//);
  // The pending count depends on what other tests have written by now, so it is hidden (not masked: hidden keeps its place).
  await page.addStyleTag({ content: STABLE_FOR_SCREENSHOT });
  if (testInfo.project.name === "desktop-chrome") await expect(page).toHaveScreenshot("today-paper-grid.png", { fullPage: true });
});

test("a task card's preview drawer opens in place, and its standalone-page link shows the same task", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/");
  const hero = page.locator(".hero-action");
  const title = (await hero.locator(".hero-title").textContent())!.trim();

  // The corner preview button opens the drawer without navigating away from Today.
  await hero.locator(".card-preview-button").click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".task-detail-view h2")).toHaveText(title);
  await expect(page).toHaveURL(/\/$/);

  // Its own "独立页面查看" link is the same destination the hero card's own "查看完整详情" link points to
  // (工作块F内嵌了开始/暂停/完成+证据操作，但独立详情页承载的背景资料、材料清单、执行记录等仍只在那里
  // 展示，所以 hero 卡片单独保留了一个指向它的小链接), and the standalone page renders the identical task.
  const detailLink = drawer.getByRole("link", { name: "⤢ 独立页面查看" });
  const href = await detailLink.getAttribute("href");
  expect(href).toMatch(/^\/workbench\//);
  await expect(hero.locator("a.hero-detail-link")).toHaveAttribute("href", href!);
  await detailLink.click();
  await expect(page).toHaveURL(new RegExp(href!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
  await expect(page.locator(".task-detail-view h2")).toHaveText(title);
});

test("Plan is one calendar with day, week and month over one version", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await seedPendingChanges(page);
  await page.goto("/plan");
  const plan = page.locator("[data-plan-version]");
  await expect(plan).toHaveAttribute("data-plan-version", "personal-plan-v1");
  for (const view of ["日", "周", "月"]) await expect(page.getByRole("tab", { name: view, exact: true })).toBeVisible();
  // The three views are one list of blocks at three scales: the month shows the same plan's days.
  await page.getByRole("tab", { name: "月", exact: true }).click();
  await expect(page.locator(".mo-cell")).toHaveCount(42);
  await page.getByRole("tab", { name: "周", exact: true }).click();
  await expect(page.locator(".wk-col")).toHaveCount(7);
  // Pending differences announce themselves and open their fold, so the decision is one look away.
  await expect(page.getByRole("link", { name: /项差异待处理/ })).toBeVisible();
  await expect(page.getByText("批准本批变更")).toBeVisible();
  if (testInfo.project.name === "desktop-chrome") {
    await page.waitForTimeout(800);
    await page.addStyleTag({ content: STABLE_FOR_SCREENSHOT });
    await expect(page.locator(".subpage")).toHaveScreenshot("plan-diff.png");
  }
});

test("editing availability re-runs the scheduler instead of only storing a preference", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/plan");
  // Suggestions are explicitly unapproved; real calendar blocks remain read-only.
  await page.getByRole("tab", { name: "周", exact: true }).click();
  const scheduled = page.locator('.wk-block[data-kind="scheduled"]');
  const before = await scheduled.count();
  expect(before).toBeGreaterThan(0);

  await page.getByText("可用时间与排程偏好").click();
  await page.getByText(/^可用时间 · /).click();
  // Close every declared window down to five minutes — below the minimum usable slot, so the honest
  // result is an empty lane. A preference that stored cleanly and changed nothing on screen would mean
  // the schedule was still example data wearing the setting's clothes.
  for (const row of await page.locator(".availability-row").all()) {
    await row.locator("input[type=time]").first().fill("08:00");
    await row.locator("input[type=time]").nth(1).fill("08:05");
  }
  await page.getByRole("button", { name: "保存并重排" }).click();
  await expect(scheduled).toHaveCount(0);

  // Put it back: these tests share one ledger, and a crippled week would silently change what every
  // later assertion is looking at.
  await apiFetch(page, "POST", "/api/settings/availability", { windows: DEFAULT_AVAILABILITY });
});

test("Plan approval is confirmed and persisted", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await seedPendingChanges(page);
  await page.goto("/plan");
  await page.getByRole("button", { name: "批准本批变更" }).click();
  await expect(page.getByRole("dialog")).toContainText("批准计划 v1");
  await page.getByRole("button", { name: "确认批准" }).click();
  // R7 localised the status chip; the assertion must follow the text the page actually renders.
  await expect(page.locator("[data-plan-version]")).toContainText("已批准");
  await page.waitForLoadState("networkidle");
  // Nothing is pending any more, so the differences fold closes; open it to read what was decided.
  await page.getByText(/^计划差异（/).click();
  await expect(page.getByText("本版本已批准")).toBeVisible();
  // Scoped to the change ledger: "已批准" also labels the plan version and the blocks.
  await expect(page.locator(".change-ledger article span").filter({ hasText: "已批准" })).toHaveCount(2);
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
  await page.getByText(/^里程碑列表与编辑/).click();
  const goal = page.locator(".milestone-admin-list > li").filter({ hasText: "稳定推进当前实验与论文" });
  await goal.getByText("调整重要性与截止日").click();
  await goal.locator('input[type="date"]').fill("2026-09-30");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    goal.getByRole("button", { name: "确认目标约束" }).click()
  ]);
  await expect(goal.locator('input[type="date"]')).toHaveValue("2026-09-30");
  await page.goto("/plan");
  await page.getByText(/^未来 8 周/).click();
  await expect(page.getByText("已确认硬截止 2026-09-30")).toBeVisible();

  const store = openStore();
  try { store.appendEvent({ ownerId: "e2e-tester", workspaceId: realWorkspaceId(store),
    idempotencyKey: "e2e:insight-candidate", type: "flywheel.finding", entityId: "research-starter",
    payload: { milestoneId: "research-starter", summary: "可复用的实验记录模板",
      sourceUrl: "https://example.org/source", sourceTitle: "记录模板", retrievedAt: "2026-09-14T00:00:00Z",
      staleWhen: "方法变更" } }); }
  finally { store.close(); }
  await page.goto("/approvals");
  // Folded until it is switched on: an optional feature should not be the first thing on the page people come to to decide things.
  await page.getByText(/^默认批准（可选）/).click();
  await expect(page.getByRole("button", { name: "开启默认批准" })).toBeVisible();
  await page.getByRole("button", { name: "开启默认批准" }).click();
  await expect(page.getByRole("button", { name: "关闭默认批准" })).toBeVisible();
  const insight = page.locator(".permission-mode-panel li").filter({ hasText: "可复用的实验记录模板" });
  await expect(insight).toBeVisible();
  await insight.getByRole("button", { name: "拒绝" }).click();
  await expect(page.locator(".permission-mode-panel li").filter({ hasText: "可复用的实验记录模板" })).toHaveCount(0);
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "今日" })).toBeVisible();
  // What is waiting and the settings sit behind the fifth tab.
  await expect(page.getByText("更多")).toBeVisible();
  await expect(page.locator(".hero-action")).toBeVisible();
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
  await page.getByPlaceholder("写下一项任务、想法，或粘贴一个链接…").fill("断网时记下的一条");
  await page.getByRole("button", { name: "收集" }).click();
  await expect(page.getByRole("status")).toContainText("已离线保存，联网后自动同步");

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
  await expect(pageB.locator(`#work-order-${id}`).getByRole("button", { name: "开始执行" })).toBeVisible();
  await deviceB.setOffline(true);

  // Device A — the default page — moves the same order past `active` entirely: `startWorkOrderExecution`
  // treats an already-`active` order as an idempotent no-op success (not a conflict — a genuine
  // double-click online must not error), so the order has to move somewhere `start` can no longer apply
  // at all for device B's stale `start` to actually collide with anything.
  await page.goto("/workbench");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.locator(`#work-order-${id}`).getByRole("button", { name: "开始执行" }).click()
  ]);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.locator(`#work-order-${id}`).getByRole("button", { name: "完成（记为无证据）" }).click()
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
  await pageB.locator(`#work-order-${id}`).getByRole("button", { name: "开始执行" }).click();
  await expect(pageB.getByRole("status")).toContainText("已离线保存，联网后自动同步");

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
 * The system's questions on Today: a backplan that found two missing inputs (shown under the milestone's name once) and
 * something awaited that was due, each answered in place from options already written out — one with a follow-up form
 * prefilled from what the system knew — and the next coming up, and the 待确认 count going down, without a page reload.
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
  const list = page.getByRole("region", { name: "需要你回答" });
  await expect(list.getByRole("heading", { name: /^需要你一句话/ })).toBeVisible();
  const group = list.locator(".ask-group");
  await expect(group.getByRole("heading", { level: 3 })).toContainText("还缺 2 样东西");
  await expect(group.locator("h4")).toHaveText(["组会录音", "导师批注"]);
  const missing = group.locator(".ask-input").filter({ hasText: "组会录音" });
  await expect(missing).toContainText("没有组会录音，无法列出要回应的质疑。");
  const badge = page.locator(".running-head .pending-badge");
  const badgeMinusTotal = async () => (await badge.count() ? Number(await badge.textContent()) : 0)
    - await page.evaluate(async () => ((await (await fetch("/api/pending", { cache: "no-store" })).json()) as { total: number }).total);
  await missing.getByRole("button", { name: /已经要了，在等/ }).click();
  await expect(missing.getByLabel(/谁给/)).toHaveValue("导师");
  await missing.getByLabel("大约哪天到").fill("2026-09-16");
  await missing.getByRole("button", { name: "确定：已经要了，在等" }).click();
  await expect(list.getByText("组会录音", { exact: true })).toHaveCount(0);
  // The header's count follows the answer without a reload (it used to stay at the old number for up to a minute).
  await expect.poll(badgeMinusTotal).toBe(0);
  const second = list.locator(".ask-card").filter({ hasText: "还缺：导师批注" });
  await second.getByRole("button", { name: /^我自己去弄/ }).click();
  await expect(second).toHaveCount(0);
  const waiting = list.locator(".ask-card").filter({ hasText: "师兄的「实测数据」到了吗？" });
  await expect(waiting).toBeVisible();
  await waiting.getByRole("button", { name: /^不等了/ }).click();
  await expect(list.locator(".ask-card").filter({ hasText: "实测数据」到了吗" })).toHaveCount(0);
  const after = openStore();
  try {
    const workspaceId = realWorkspaceId(after);
    expect(after.listWaitingItems(workspaceId).find((item) => item.title === "组会录音")).toMatchObject({ who: "导师", expectedAt: "2026-09-16", source: "backplan" });
    expect(after.listWaitingItems(workspaceId).find((item) => item.id === "wait-e2e")!.state).toBe("cancelled");
    expect(after.listEvents(workspaceId, { type: "ask.answered" })).toHaveLength(3);
  } finally { after.close(); }
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

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login/);

  const databases = await page.evaluate(() => indexedDB.databases());
  expect(databases.some((db) => db.name?.startsWith("crossline-offline-"))).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("crossline.offline.workspaceId"))).toBeNull();
});

