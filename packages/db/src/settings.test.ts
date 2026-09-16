import { expect, test } from "vitest";
import { CrosslineStore } from "./index";

test("consent is three-valued: never asked is not the same as declined", () => {
  const store = new CrosslineStore(":memory:");
  try {
    expect(store.getSetting("w", "localActivity.consent")).toBeUndefined();
    store.setSetting("w", "localActivity.consent", "denied");
    expect(store.getSetting("w", "localActivity.consent")).toBe("denied");
    store.setSetting("w", "localActivity.consent", "granted");
    expect(store.getSetting("w", "localActivity.consent")).toBe("granted");
    // Consent travels with a backup, so a restore cannot quietly re-enable collection.
    expect(store.exportSnapshot("w").tables.settings)
      .toEqual([expect.objectContaining({ key: "localActivity.consent", value: "granted" })]);
  } finally { store.close(); }
});
