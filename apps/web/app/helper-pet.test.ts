import { describe, expect, test } from "vitest";
import { awayFor, AWAY_MS, clampDock, deskBubbleKey, gazeAt, isHelperShortcut, isNight, lookAt, LOOK_MAX, LOOK_RADIUS, parseDock, petPose, POSE_LABEL, shapeRects }
  from "./helper-pet";

describe("小帮手 as a desktop pet", () => {
  test("night is 23:00 to 07:00 by the browser's clock", () => {
    expect([23, 0, 3, 6].map(isNight)).toEqual([true, true, true, true]);
    expect([7, 12, 22].map(isNight)).toEqual([false, false, false]);
  });

  test("it sleeps only when there is nothing to say: idle, at night or with the person away", () => {
    expect(petPose("idle", { night: true, away: false })).toBe("sleep");
    expect(petPose("idle", { night: false, away: true })).toBe("sleep");
    expect(petPose("idle", { night: false, away: false })).toBe("idle");
    // Every other mood keeps its meaning whatever the hour.
    for (const mood of ["down", "thinking", "working", "unread"] as const) expect(petPose(mood, { night: true, away: true })).toBe(mood);
  });

  test("it leans toward a near pointer by at most LOOK_MAX px, and looks ahead when the pointer is far or on top of it", () => {
    expect(lookAt(100, 0)).toEqual({ x: LOOK_MAX, y: 0 });
    expect(lookAt(0, -50)).toEqual({ x: 0, y: -LOOK_MAX });
    const diagonal = lookAt(30, 40);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(LOOK_MAX, 0);
    expect(diagonal.x).toBeGreaterThan(0);
    expect(lookAt(LOOK_RADIUS + 1, 0)).toEqual({ x: 0, y: 0 });
    expect(lookAt(0.2, 0.2)).toEqual({ x: 0, y: 0 });
    expect(lookAt(Number.NaN, 0)).toEqual({ x: 0, y: 0 });
  });

  test("a dragged corner stays inside the window with a margin, even after the window shrank", () => {
    const size = { width: 60, height: 80 };
    const viewport = { width: 1000, height: 700 };
    expect(clampDock({ right: 300, bottom: 200 }, size, viewport)).toEqual({ right: 300, bottom: 200 });
    expect(clampDock({ right: -40, bottom: -10 }, size, viewport)).toEqual({ right: 8, bottom: 8 });
    expect(clampDock({ right: 5000, bottom: 5000 }, size, viewport)).toEqual({ right: 1000 - 60 - 8, bottom: 700 - 80 - 8 });
    // A window smaller than the corner itself pins it to the margin rather than producing a negative offset.
    expect(clampDock({ right: 100, bottom: 100 }, size, { width: 50, height: 50 })).toEqual({ right: 8, bottom: 8 });
  });

  test("only a well-formed remembered corner is used", () => {
    expect(parseDock(JSON.stringify({ right: 20, bottom: 40 }))).toEqual({ right: 20, bottom: 40 });
    expect(parseDock(null)).toBeNull();
    expect(parseDock("not json")).toBeNull();
    expect(parseDock(JSON.stringify({ right: "20", bottom: 40 }))).toBeNull();
    expect(parseDock(JSON.stringify({ right: null, bottom: 1 }))).toBeNull();
  });

  test("Alt+Shift+H opens it, read by key position so a layout or IME does not change it", () => {
    const key = { altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code: "KeyH" };
    expect(isHelperShortcut(key)).toBe(true);
    expect(isHelperShortcut({ ...key, ctrlKey: true })).toBe(false);
    expect(isHelperShortcut({ ...key, shiftKey: false })).toBe(false);
    expect(isHelperShortcut({ ...key, code: "KeyJ" })).toBe(false);
  });

  test("the desktop pet leans toward the pointer anywhere on the screen, a little, and looks straight ahead when the pointer is on it", () => {
    expect(gazeAt(5, 5)).toEqual({ x: 0, y: 0 });
    expect(gazeAt(800, 0)).toEqual({ x: LOOK_MAX, y: 0 });
    expect(gazeAt(-800, 0)).toEqual({ x: -LOOK_MAX, y: 0 });
    // Nearer means a smaller lean; it never exceeds LOOK_MAX however far the pointer is.
    expect(gazeAt(100, 0).x).toBeLessThan(LOOK_MAX);
    expect(Math.abs(gazeAt(0, 5000).y)).toBeLessThanOrEqual(LOOK_MAX / 2);
    expect(gazeAt(Number.NaN, 0)).toEqual({ x: 0, y: 0 });
  });

  test("away is the whole computer's idle time when the tray reports it, else this page's own", () => {
    expect(awayFor(AWAY_MS, 0)).toBe(true);
    expect(awayFor(1_000, AWAY_MS * 2)).toBe(false);
    expect(awayFor(null, AWAY_MS)).toBe(true);
    expect(awayFor(null, 1_000)).toBe(false);
  });

  test("the pet's bubble says its pose only when the figure alone does not", () => {
    expect(deskBubbleKey("idle")).toBeNull();
    expect(deskBubbleKey("sleep")).toBeNull();
    for (const pose of ["down", "thinking", "working", "unread"] as const) expect(deskBubbleKey(pose)).toBe(POSE_LABEL[pose]);
  });

  test("the tray's window shape is every drawn piece in whole px, empty pieces left out", () => {
    expect(shapeRects([{ x: 10.6, y: 20.2, width: 112.1, height: 168, radius: 14 }, { x: 0, y: 0, width: 0, height: 30, radius: 0 },
      { x: Number.NaN, y: 0, width: 5, height: 5, radius: 0 }])).toEqual([[10, 20, 113, 168, 14]]);
  });

  test("labels are in the UI's third person and name every pose", () => {
    for (const label of Object.values(POSE_LABEL)) expect(label).not.toMatch(/[你我]/);
    expect(POSE_LABEL.sleep).toContain("休息");
  });
});
