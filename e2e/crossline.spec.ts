import { expect, test } from "@playwright/test";
import path from "node:path";
// Relative, not @crossline/db: the repo root is not a workspace package and has no such dependency.
import { CrosslineStore } from "../packages/db/src/index.js";
import { DEFAULT_AVAILABILITY } from "../packages/core/src/index.js";

/**
 * Two pending diffs on the starter plan, written the way a calendar sync writes them.
 *
 * The seeded ledger used to ship two example diffs so the C lens had something to show. They pointed
 * at example blocks that no longer exist — the AI lane is the scheduler's real output now — so they
 * were removed, and with them the only thing the approval flow could be driven against. A test that
 * needs a precondition should create it: this opens the same SQLite file the server has open (WAL,
 * two writers, which is how this app already runs) rather than putting demo rows back in production.
 */
async function seedPendingChanges(baseURL: string): Promise<void> {
  // Touch a page first: the plan version is created by the server's own first-run seeding, and a
  // change row cannot reference a plan that does not exist yet.
  await fetch(`${baseURL}/plan`);
  const store = new CrosslineStore(path.join(process.env.CROSSLINE_E2E_DATA_DIR!, "crossline.db"));
  try {
    const workspaceId = "personal-crossline";
    if (store.listPlanChanges("personal-plan-v1").length > 0) return;
    const event = store.appendEvent({
      ownerId: "local-owner", workspaceId, idempotencyKey: "e2e:plan-diff",
      type: "calendar.synced", entityId: "personal-plan-v1", payload: { source: "e2e" }
    });
    for (const [index, explanation] of ["把写作挪到上午的高精力段", "为下午的会议让出一小时"].entries()) {
      store.savePlanChange({
        id: `e2e-change-${index + 1}`, ownerId: "local-owner", workspaceId,
        planVersionId: "personal-plan-v1", kind: "move", triggerEventId: event.eventId,
        explanation, status: "pending"
      });
    }
  } finally { store.close(); }
}

async function ensureScheduleSetup(baseURL: string): Promise<void> {
  await fetch(`${baseURL}/plan`);
  const result = await fetch(`${baseURL}/api/settings/schedule`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeZone: "America/Chicago", mode: "buffered",
      windows: DEFAULT_AVAILABILITY, importance: {
        "research-starter": "important", "startup-starter": "important",
        "media-starter": "important", "investment-starter": "ordinary"
      } }) });
  expect(result.ok).toBe(true);
}

test.beforeEach(async ({ baseURL }, testInfo) => {
  if (testInfo.project.name === "desktop-chrome") await ensureScheduleSetup(baseURL!);
});


test("Today keeps capture semantic-only and health outside identity navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByText("CARE / CAPACITY")).toBeVisible();
  await expect(page.locator(".capture-form select")).toHaveCount(0);
  await expect(page.locator('.capture-form input[name="title"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "提交完成证据" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "前往作业台执行并提交证据" })).toHaveAttribute("href", /\/workbench#work-order-/);
  if (testInfo.project.name === "desktop-chrome") await expect(page).toHaveScreenshot("today-paper-grid.png", { fullPage: true });
});

test("Plan exposes B/C/A over one version and workflow redirects", async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await seedPendingChanges(baseURL!);
  await page.goto("/plan");
  const plan = page.locator("[data-plan-version]");
  await expect(plan).toHaveAttribute("data-plan-version", "personal-plan-v1");
  await expect(page.getByRole("tab", { name: "B · 双轨时间轴" })).toBeVisible();
  await page.getByRole("tab", { name: "C · 计划差异" }).click();
  await expect(page.getByText("批准本批变更")).toBeVisible();
  if (testInfo.project.name === "desktop-chrome") {
    await page.waitForTimeout(800);
    await expect(page.locator(".subpage")).toHaveScreenshot("plan-diff.png");
  }
  await page.goto("/workflow");
  await expect(page).toHaveURL(/\/workbench$/);
});

test("editing availability re-runs the scheduler instead of only storing a preference", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/plan");
  // Suggestions are explicitly unapproved; real calendar blocks remain read-only.
  const scheduled = page.locator(".lane-track article").filter({ hasText: "建议·未批准" });
  const before = await scheduled.count();
  expect(before).toBeGreaterThan(0);

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
  await page.request.post("/api/settings/availability", { data: { windows: DEFAULT_AVAILABILITY } });
});

test("Plan approval is confirmed and persisted", async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await seedPendingChanges(baseURL!);
  await page.goto("/plan");
  await page.getByRole("tab", { name: "C · 计划差异" }).click();
  await page.getByRole("button", { name: "批准本批变更" }).click();
  await expect(page.getByRole("dialog")).toContainText("批准 Plan v1");
  await page.getByRole("button", { name: "确认批准" }).click();
  // R7 localised the status chip; the assertion must follow the text the page actually renders.
  await expect(page.locator("[data-plan-version]")).toContainText("已批准");
  const changeTab = page.getByRole("tab", { name: "C · 计划差异" });
  await expect(changeTab).toBeEnabled();
  await page.waitForLoadState("networkidle");
  await changeTab.click();
  await expect(changeTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("本版本已批准")).toBeVisible();
  // Scoped to the change ledger: "已批准" also labels the plan version and the blocks.
  await expect(page.locator(".change-ledger article span").filter({ hasText: "已批准" })).toHaveCount(2);
});

test("energy check keeps self report only and rejects the removed camera path", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "运行十二秒本地摄像头代理采样" })).toHaveCount(0);
  const submitted = page.waitForResponse((response) => response.url().endsWith("/api/energy-observations") && response.request().method() === "POST");
  await page.getByRole("button", { name: "记录中精力" }).click();
  expect((await submitted).ok()).toBe(true);
  const store = new CrosslineStore(path.join(process.env.CROSSLINE_E2E_DATA_DIR!, "crossline.db"));
  try { expect(store.listEnergyObservations("personal-crossline").some((item) => item.level === "medium")).toBe(true); }
  finally { store.close(); }
  const cameraRejected = await request.post("/api/energy-observations", {
    data: { source: "camera_proxy", level: "unclassified", confidence: "low", aggregate: {} }
  });
  expect(cameraRejected.status()).toBe(400);
  expect(await cameraRejected.json()).toMatchObject({ code: "CAMERA_ENERGY_PATH_REMOVED" });
  const rawRejected = await request.post("/api/energy-observations", {
    data: { source: "self_report", level: "medium", confidence: "high", aggregate: {}, frame: "data:image/jpeg;base64,forbidden" }
  });
  expect(rawRejected.status()).toBe(400);
  expect(await rawRejected.json()).toMatchObject({ code: "RAW_MEDIA_OR_UNKNOWN_FIELD_FORBIDDEN" });
  const blinkRejected = await request.post("/api/energy-observations", {
    data: { source: "self_report", level: "medium", confidence: "high", aggregate: { meanBlinkProxy: 0.1 } }
  });
  expect(blinkRejected.status()).toBe(400);
  expect(await blinkRejected.json()).toMatchObject({ code: "AGGREGATE_FEATURES_ONLY" });
});

test("goal confirmation and permission-mode rejection persist through the real pages", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
  await page.goto("/milestones");
  const goal = page.locator(".milestone-admin-list > li").filter({ hasText: "稳定推进当前实验与论文" });
  await goal.locator('input[type="date"]').fill("2026-09-30");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    goal.getByRole("button", { name: "确认目标约束" }).click()
  ]);
  await expect(goal.locator('input[type="date"]')).toHaveValue("2026-09-30");
  await page.goto("/plan");
  await expect(page.getByText("已确认硬截止 2026-09-30")).toBeVisible();

  const store = new CrosslineStore(path.join(process.env.CROSSLINE_E2E_DATA_DIR!, "crossline.db"));
  try { store.appendEvent({ ownerId: "local-owner", workspaceId: "personal-crossline",
    idempotencyKey: "e2e:insight-candidate", type: "flywheel.finding", entityId: "research-starter",
    payload: { milestoneId: "research-starter", summary: "可复用的实验记录模板",
      sourceUrl: "https://example.org/source", sourceTitle: "记录模板", retrievedAt: "2026-09-14T00:00:00Z",
      staleWhen: "方法变更" } }); }
  finally { store.close(); }
  await page.goto("/approvals");
  await expect(page.getByRole("button", { name: "开启默认批准" })).toBeVisible();
  await page.getByRole("button", { name: "开启默认批准" }).click();
  await expect(page.getByRole("button", { name: "关闭默认批准" })).toBeVisible();
  const insight = page.locator(".permission-mode-panel li").filter({ hasText: "可复用的实验记录模板" });
  await expect(insight).toBeVisible();
  await insight.getByRole("button", { name: "拒绝" }).click();
  await expect(page.locator(".permission-mode-panel li").filter({ hasText: "可复用的实验记录模板" })).toHaveCount(0);
  const rejected = new CrosslineStore(path.join(process.env.CROSSLINE_E2E_DATA_DIR!, "crossline.db"));
  try { expect(rejected.listEvents("personal-crossline", { type: "insight.rejected" })).toHaveLength(1); }
  finally { rejected.close(); }
  const forbidden = await request.post("/api/goals/research-starter", {
    headers: { Origin: "https://attacker.example" },
    data: { importance: "ordinary", confirmedDeadline: null }
  });
  expect(forbidden.status()).toBe(403);
});

test("mobile navigation and reduced motion remain usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Approvals" })).toBeVisible();
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
  await expect(page.getByRole("link", { name: "Workbench" })).toBeVisible();
  await expect(page.locator(".analog-clock")).toBeVisible();

  // And a capture taken while down is kept rather than lost.
  await page.getByPlaceholder("写下一项任务、想法，或粘贴一个链接…").fill("断网时记下的一条");
  await page.getByRole("button", { name: "CAPTURE ↗" }).click();
  await expect(page.getByRole("status")).toContainText("已离线保存，联网后自动同步");

  const queued = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("crossline-offline", 1);
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
