import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createWriteLogin, safeVerificationUri } from "./calendar-write-login";

let store: CrosslineStore;
let ws: string;
beforeEach(() => { store = new CrosslineStore(":memory:"); ws = store.createPrincipalWithWorkspace("u", "w").workspace.id; });
afterEach(() => store.close());

test("the code goes to the page; once the person signs in with it, that account is the one written with", async () => {
  let finish: (value: { username: string }) => void = () => undefined;
  const session = {
    loginWithDeviceCode: (onCode: (info: { userCode: string; verificationUri: string; message: string }) => void) => {
      onCode({ userCode: "ABCD-1234", verificationUri: "https://microsoft.com/devicelogin", message: "" });
      return new Promise<{ username: string }>((resolve) => { finish = resolve; });
    },
    listAccounts: async () => [{ id: "acct-1", username: "Someone@Example.edu" }]
  };
  const login = createWriteLogin(store, { session: async () => session, ownerOf: () => "owner" });
  expect(await login.start(ws)).toMatchObject({ state: "waiting", userCode: "ABCD-1234", verificationUri: "https://microsoft.com/devicelogin" });
  // Asking again while one waits returns the same code rather than starting a second login.
  expect(await login.start(ws)).toMatchObject({ userCode: "ABCD-1234" });
  expect(store.getSetting(ws, "calendar.write.account")).toBeUndefined();
  finish({ username: "someone@example.edu" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(login.status(ws)).toMatchObject({ state: "done" });
  expect(store.getSetting(ws, "calendar.write.account")).toBe("acct-1");
  expect(JSON.stringify(store.listEvents(ws, { type: "calendar.write.authorized" })[0]!.payload)).not.toContain("example");
});

test("without Microsoft configured nothing starts; only Microsoft's own pages are offered as the place to sign in", async () => {
  expect(await createWriteLogin(store, { session: async () => undefined, ownerOf: () => "owner" }).start(ws)).toMatchObject({ state: "failed", code: "GRAPH_NOT_CONFIGURED" });
  expect(safeVerificationUri("https://login.microsoft.com/device")).toBe("https://login.microsoft.com/device");
  expect(safeVerificationUri("http://microsoft.com/devicelogin")).toBeUndefined();
  expect(safeVerificationUri("https://microsoft.com.evil.example/devicelogin")).toBeUndefined();
});
