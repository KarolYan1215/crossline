import { expect, test } from "@playwright/test";
import { openStore, realWorkspaceId } from "./ledger.js";

// Chromium's fake camera (a moving test pattern, no face) and an auto-accepted permission prompt: enough to prove the whole page side
// of 摄像头精力采样 runs — MediaPipe's wasm from /mediapipe-wasm under the CSP, the model from /mediapipe, the camera opened and closed
// again — without a person in front of a lens. With no face in the frames the window has no aggregate, so nothing is posted.
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }, permissions: ["camera"] });

test("摄像头精力采样: with its consent the desktop page opens the camera for one window, runs the face model locally and closes it again", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "desktop only by design");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" || message.text().startsWith("camera-sampler")) errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  const wasm = page.waitForResponse((response) => response.url().includes("/mediapipe-wasm/") && response.url().endsWith(".wasm"), { timeout: 60_000 });
  const model = page.waitForResponse((response) => response.url().endsWith("/mediapipe/face_landmarker.task"), { timeout: 60_000 });
  await page.goto("/settings");
  await page.evaluate(async () => {
    localStorage.removeItem("crossline.camera.lastSampleAt");
    await fetch("/api/settings/energy-signals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signal: "camera", on: true }) });
  });
  await page.goto("/settings");
  await expect(page.getByRole("status").filter({ hasText: "摄像头采样中" })).toBeVisible({ timeout: 30_000 }).catch((error) => { throw new Error(`${error}\n${errors.join("\n")}`); });
  expect((await wasm).status()).toBe(200);
  expect((await model).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "摄像头采样中" })).toHaveCount(0, { timeout: 60_000 });
  expect(await page.evaluate(() => Number(localStorage.getItem("crossline.camera.lastSampleAt")) > 0)).toBe(true);
  expect(errors.filter((text) => /wasm|Content Security Policy|mediapipe|getUserMedia/i.test(text))).toEqual([]);
  // Off deletes what was kept and refuses what comes after.
  const store = openStore();
  try {
    const off = await page.evaluate(async () => (await fetch("/api/settings/energy-signals", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ signal: "camera", on: false }) })).status);
    expect(off).toBe(200);
    expect(store.listEnergyObservations(realWorkspaceId(store)).filter((item) => item.source === "camera_aggregate")).toEqual([]);
  } finally { store.close(); }
});
