import { afterEach, beforeEach, expect, test } from "vitest";
import { RUNTIME_OWNER_SETTING } from "@crossline/core";
import { CrosslineStore, TOOLS_ASSISTANT_GOOD_FOR, aiToolsFor, assistantAvailable, assistantMode } from "./index";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

// A guest's plans handed gathering steps to the shell assistant, which runs only for the machine owner (2026-10-15 walkthrough); since
// 2026-10-19 a guest has the assistant without a shell, and its plans are told what that one does.
test("the machine owner's assistant has a shell; every other account's works through Crossline's functions and is described as such", () => {
  const owner = store.createPrincipalWithWorkspace("owner", "o").workspace.id;
  const guest = store.createPrincipalWithWorkspace("guest", "g").workspace.id;
  expect(assistantAvailable(store, guest)).toBe(true);
  store.setSetting(owner, RUNTIME_OWNER_SETTING, "1");
  expect(assistantAvailable(store, owner)).toBe(true);
  expect(assistantAvailable(store, guest)).toBe(false);
  expect(aiToolsFor(store, owner).some((tool) => tool.kind === "assistant")).toBe(true);
  expect(assistantMode(store, owner)).toBe("shell");
  expect(assistantMode(store, guest)).toBe("tools");
  expect(aiToolsFor(store, guest).find((tool) => tool.kind === "assistant")?.goodFor).toBe(TOOLS_ASSISTANT_GOOD_FOR);
  expect(assistantMode(store, owner, { CROSSLINE_PUBLIC_BETA: "1" })).toBe("tools");
});
