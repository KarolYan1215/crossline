import { afterEach, beforeEach, expect, test } from "vitest";
import { RUNTIME_OWNER_SETTING } from "@crossline/core";
import { CrosslineStore, aiToolsFor, assistantAvailable } from "./index";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

// A guest's plans handed gathering steps to the shell assistant, which runs only for the machine owner (2026-10-15 walkthrough).
test("only the machine owner's account is offered the assistant; before any owner is marked, the one account has it", () => {
  const owner = store.createPrincipalWithWorkspace("owner", "o").workspace.id;
  const guest = store.createPrincipalWithWorkspace("guest", "g").workspace.id;
  expect(assistantAvailable(store, guest)).toBe(true);
  store.setSetting(owner, RUNTIME_OWNER_SETTING, "1");
  expect(assistantAvailable(store, owner)).toBe(true);
  expect(assistantAvailable(store, guest)).toBe(false);
  expect(aiToolsFor(store, owner).some((tool) => tool.kind === "assistant")).toBe(true);
  expect(aiToolsFor(store, guest).some((tool) => tool.kind === "assistant")).toBe(false);
  expect(aiToolsFor(store, guest).length).toBeGreaterThan(0);
});
