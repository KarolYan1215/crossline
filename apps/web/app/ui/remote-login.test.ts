import { expect, test } from "vitest";
import { framePoint, remoteWindowSize } from "./remote-login";

test("a computer gets the desktop window, a phone one its own width", () => {
  expect(remoteWindowSize(1440, 900)).toEqual({ width: 1280, height: 800 });
  expect(remoteWindowSize(390, 844)).toEqual({ width: 390, height: 654 });
  expect(remoteWindowSize(320, 600)).toEqual({ width: 360, height: 560 });
});

test("a pointer is sent as a fraction of the frame, whatever size it is drawn at", () => {
  const rect = { left: 100, top: 50, width: 640, height: 400 };
  expect(framePoint(420, 250, rect)).toEqual({ x: 0.5, y: 0.5 });
  expect(framePoint(0, 1000, rect)).toEqual({ x: 0, y: 1 });
});
