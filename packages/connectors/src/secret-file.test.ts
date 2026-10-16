import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDpapiSecretStore, createKeyFileSecretStore } from "./secret-file";

test("off Windows with a master key: AES-GCM files that open only with that key and in their own slot", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-secrets-"));
  try {
    const key = Buffer.alloc(32, 7).toString("base64");
    const secrets = createDpapiSecretStore(dir, "linux", { CROSSLINE_SECRET_KEY: key });
    await secrets.write("ws-1", "ical-a", "https://calendar.example/private-token");
    const file = path.join(dir, "secrets", "ws-1", "ical-a.enc");
    expect(readFileSync(file).toString("latin1")).not.toContain("private-token");
    expect(await secrets.read("ws-1", "ical-a")).toBe("https://calendar.example/private-token");
    await expect(createKeyFileSecretStore(dir, Buffer.alloc(32, 8).toString("base64")).read("ws-1", "ical-a")).rejects.toThrow();
    secrets.remove("ws-1", "ical-a");
    expect(existsSync(file)).toBe(false);
    // Without a key it stays refused, never plain text.
    await expect(createDpapiSecretStore(dir, "linux", {}).write("ws-1", "x", "y")).rejects.toThrow("SECRET_STORE_UNAVAILABLE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const dataDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "crossline-secrets-")); dirs.push(dir); return dir; };

test.runIf(process.platform === "win32")("a key is written encrypted under data/secrets/<workspace>, read back, and removed", async () => {
  const dir = dataDir();
  const secrets = createDpapiSecretStore(dir);
  await secrets.write("ws-1", "provider-key", "sk-test-value-1234");
  const file = path.join(dir, "secrets", "ws-1", "provider-key.bin");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file).toString("latin1")).not.toContain("sk-test-value");
  expect(await secrets.read("ws-1", "provider-key")).toBe("sk-test-value-1234");
  expect(await secrets.read("ws-2", "provider-key")).toBeUndefined();
  secrets.remove("ws-1", "provider-key");
  expect(await secrets.read("ws-1", "provider-key")).toBeUndefined();
});

test("off Windows a key is refused, never written in plain text", async () => {
  const dir = dataDir();
  await expect(createDpapiSecretStore(dir, "linux").write("ws-1", "provider-key", "sk-x")).rejects.toThrow("SECRET_STORE_UNAVAILABLE");
  expect(existsSync(path.join(dir, "secrets"))).toBe(false);
});
