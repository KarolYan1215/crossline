import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

test("the change token moves on a write by this connection and on one by another, and not on reads", () => {
  dir = mkdtempSync(path.join(tmpdir(), "crossline-token-"));
  const file = path.join(dir, "ledger.db");
  const web = new CrosslineStore(file);
  const worker = new CrosslineStore(file);
  const first = web.changeToken();
  web.getSetting("ws", "x");
  expect(web.changeToken()).toBe(first);
  web.setSetting("ws", "x", "1");
  const second = web.changeToken();
  expect(second).not.toBe(first);
  worker.setSetting("ws", "y", "2");
  expect(web.changeToken()).not.toBe(second);
  web.close(); worker.close();
});
