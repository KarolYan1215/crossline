import { describe, expect, it } from "vitest";
import { screenListedWith } from "./folder-classifier";

const files = [{ path: "a.md", size: 10, modified: 2 }, { path: "b.pdf", size: 20, modified: 1 }];

describe("screenListedWith (this computer's folders, 2026-11-23)", () => {
  it("passes the model's keep list through, with the device limit", async () => {
    let asked: number | undefined;
    const screen = screenListedWith(async (_folder, _files, limit) => { asked = limit; return { keep: ["b.pdf"], why: "" }; });
    expect(await screen("资料", files)).toEqual(["b.pdf"]);
    expect(asked).toBe(200);
  });

  it("leaves the files listed when the run could not happen", async () => {
    for (const code of ["CODEX_SUPERVISOR_UNAVAILABLE", "SPEND_LIMIT", "RUNTIME_UNCONNECTED", "MODEL_NOT_ADMITTED"]) {
      expect(await screenListedWith(async () => ({ blocked: code }))("资料", files)).toBeUndefined();
    }
  });

  it("falls back to the most recently changed when the model's answer failed", async () => {
    expect(await screenListedWith(async () => ({ blocked: "SKILL_SCHEMA_INVALID" }))("资料", files)).toBe("unavailable");
  });
});
