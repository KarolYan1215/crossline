import { expect, test } from "@playwright/test";

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

test("Plan exposes B/C/A over one version and workflow redirects", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
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

test("Plan approval is confirmed and persisted", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome");
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
  await page.getByRole("button", { name: "记录中精力" }).click();
  await expect(page.getByText("已记录")).toBeVisible();
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

test("mobile navigation and reduced motion remain usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Approvals" })).toBeVisible();
  await expect(page.locator(".hero-action")).toBeVisible();
});
