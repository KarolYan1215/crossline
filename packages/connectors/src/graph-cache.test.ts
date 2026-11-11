import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { graphCachePlugin } from "./index";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("on a Linux server the Microsoft sign-ins are one encrypted file under the data dir, and refused without a key", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "graph-cache-"));
  dirs.push(dir);
  const env = { CROSSLINE_SECRET_KEY: randomBytes(32).toString("base64"), CROSSLINE_DATA_DIR: dir };
  const plugin = await graphCachePlugin(undefined, "linux", env);
  let held = "";
  const cache = { deserialize: (text: string) => { held = text; }, serialize: () => JSON.stringify({ Account: { a: { username: "person@example.com" } } }) };
  await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: cache } as never);
  const file = path.join(dir, "secrets", "_machine", "msal-graph-cache.enc");
  expect(readdirSync(path.dirname(file))).toEqual(["msal-graph-cache.enc"]);
  expect(readFileSync(file).toString("latin1")).not.toContain("person@example.com");
  await (await graphCachePlugin(undefined, "linux", env)).beforeCacheAccess({ cacheHasChanged: false, tokenCache: cache } as never);
  expect(held).toContain("person@example.com");
  await expect(graphCachePlugin(undefined, "linux", { CROSSLINE_DATA_DIR: dir })).rejects.toThrow("GRAPH_CACHE_NEEDS_SECRET_KEY");
});
