import { describe, expect, test } from "vitest";
import { clampDock, isHelperShortcut, isNight, lookAt, LOOK_MAX, LOOK_RADIUS, parseDock, petPose, POSE_LABEL } from "./helper-pet";

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

  test("labels are in the UI's third person and name every pose", () => {
    for (const label of Object.values(POSE_LABEL)) expect(label).not.toMatch(/[你我]/);
    expect(POSE_LABEL.sleep).toContain("休息");
  });
});
