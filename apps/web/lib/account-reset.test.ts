import { expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DEVICE_TOKEN_SETTING, NODE_COMPUTE_SETTING, NODE_PAIRED_SETTING, NODE_TOKEN_SETTING } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./auth", () => ({ getAuth: vi.fn() }));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn() }));
import { RESET_KEEPS } from "./account-deletion";

/** 「清空数据重新开始」 keeps the person's own computer: on the hosted site the node is the model connection (W-227). */
test("a reset keeps the compute node's pairing and the device token, and clears the rest", () => {
  const store = new CrosslineStore(":memory:");
  const ws = "w";
  for (const [key, value] of [[NODE_TOKEN_SETTING, "h"], [NODE_PAIRED_SETTING, "{}"], [NODE_COMPUTE_SETTING, "on"], [DEVICE_TOKEN_SETTING, "d"], ["onboarding.tone", "neutral"]] as const)
    store.setSetting(ws, key, value);
  store.resetWorkspace(ws, RESET_KEEPS);
  expect([NODE_TOKEN_SETTING, NODE_PAIRED_SETTING, NODE_COMPUTE_SETTING, DEVICE_TOKEN_SETTING].map((key) => store.getSetting(ws, key))).toEqual(["h", "{}", "on", "d"]);
  expect(store.getSetting(ws, "onboarding.tone")).toBeUndefined();
  store.close();
});
