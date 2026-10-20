import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("../../../lib/codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { issueDeviceToken } from "../../../lib/energy";
import { TEST_CTX } from "../../../lib/test-support";
import { POST } from "./route";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const post = (token: string, body: unknown) => POST(new Request("http://127.0.0.1:3210/api/records", { method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));

test("the phone's records token writes payment notifications and Wallet transactions once each, and nothing else can use it", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const { workspace } = store.createPrincipalWithWorkspace("phone-owner", "个人");
  const ctx = { ...TEST_CTX, workspaceId: workspace.id };
  const token = issueDeviceToken(ctx, "records");
  const body = {
    notifications: [{ id: "n1", app: "微信", title: "微信支付", text: "向 瑞幸咖啡 支付 ¥18.80", at: "2026-10-19T08:00:00+08:00" },
      { id: "n2", app: "淘宝", title: "双十一", text: "满 300 减 50", at: "" }],
    records: [{ clientId: "wallet-1", domain: "wealth", kind: "expense", value: 42.5, currency: "usd", merchant: "Whole Foods", at: "2026-10-19" },
      { clientId: "bad", domain: "wealth", kind: "weight", value: 70 }]
  };
  const first = await (await post(token, body)).json() as { stored: number; duplicates: number; skipped: Array<{ id: string; reason: string }> };
  expect(first).toMatchObject({ stored: 2, duplicates: 0 });
  expect(first.skipped.map((item) => item.id)).toEqual(["bad", "n2"]);
  expect(store.listRecords(workspace.id).map((item) => [item.value, item.currency, item.category, item.source])).toEqual([[42.5, "USD", "Whole Foods", "phone"], [18.8, "CNY", "", "phone"]]);
  // The same notification relayed again is the same payment.
  expect(await (await post(token, body)).json()).toMatchObject({ stored: 0, duplicates: 2 });
  // A health or capture token cannot write records, and a records token cannot write health summaries.
  const health = issueDeviceToken(ctx, "health");
  expect((await post(health, body)).status).toBe(401);
});
