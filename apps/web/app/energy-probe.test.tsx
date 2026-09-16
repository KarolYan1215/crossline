import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { EnergyProbe } from "./energy-probe";

const source = readFileSync(new URL("./energy-probe.tsx", import.meta.url), "utf8");

describe("energy probe", () => {
  test("keeps the L/M/H self-report path", () => {
    const html = renderToStaticMarkup(<EnergyProbe />);
    for (const label of ["记录低精力", "记录中精力", "记录高精力"]) expect(html).toContain(label);
  });

  test("no longer offers a camera sampling control", () => {
    const html = renderToStaticMarkup(<EnergyProbe />);
    expect(html).not.toContain("12s");
    expect(html).not.toContain("摄像头");
  });

  test("contains no camera capture, MediaPipe import or CDN reference", () => {
    for (const forbidden of ["getUserMedia", "@mediapipe/tasks-vision", "cdn.jsdelivr.net", "mediapipe-models", "camera_proxy", "eyeBlink"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
