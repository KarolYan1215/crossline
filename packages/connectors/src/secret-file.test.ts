import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDpapiSecretStore } from "./secret-file";

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
