import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { reproduceDeliverables, reproductionReason } from "./reproduce";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "crossline-repro-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sha = (file: string) => createHash("sha256").update(readFileSync(path.join(dir, file))).digest("hex");
/** The deliverable as the run made it, and the script it left. */
const made = (script: string, outputs: Record<string, string>) => {
  writeFileSync(path.join(dir, "run.mjs"), script);
  for (const [name, content] of Object.entries(outputs)) writeFileSync(path.join(dir, name), content);
  return Object.keys(outputs).map((name) => ({ path: name, sha256: sha(name) }));
};
const WRITE_TABLE = "import { writeFileSync } from 'node:fs';\nwriteFileSync('table.csv', 'a,b\\n1,2\\n');\n";

test("a run that delivered no report, chart or data needs nothing", async () => {
  writeFileSync(path.join(dir, "notes.md"), "笔记");
  expect(await reproduceDeliverables(dir, [{ path: "notes.md", sha256: sha("notes.md") }])).toEqual({ needed: false });
});

test("a data file without a run script is held, with the reason said", async () => {
  writeFileSync(path.join(dir, "table.csv"), "a,b\n1,2\n");
  const result = await reproduceDeliverables(dir, [{ path: "table.csv", sha256: sha("table.csv") }]);
  expect(result).toMatchObject({ needed: true, reproduced: false, problem: "missing" });
  expect(reproductionReason(result)).toBe("交付的报告、图表或数据没有附上能重新生成它们的 run 脚本");
});

test("a script that makes the same file again in a copy reproduces it, and the task directory is left as it was", async () => {
  const artifacts = made(WRITE_TABLE, { "table.csv": "a,b\n1,2\n" });
  const before = readdirSync(dir).sort();
  expect(await reproduceDeliverables(dir, artifacts)).toEqual({ needed: true, reproduced: true, script: "run.mjs", files: ["table.csv"] });
  expect(readdirSync(dir).sort()).toEqual(before);
  expect(readdirSync(tmpdir()).filter((name) => name.startsWith("crossline-reproduce-") && readdirSync(path.join(tmpdir(), name)).includes("run.mjs"))).toEqual([]);
});

test("the delivered file is removed from the copy: a script that makes nothing does not pass on the old file", async () => {
  const artifacts = made("console.log('nothing');\n", { "table.csv": "a,b\n1,2\n" });
  expect(await reproduceDeliverables(dir, artifacts)).toMatchObject({ reproduced: false, problem: "mismatch", mismatched: ["table.csv"] });
});

test("a file that comes out different (a timestamp) is a mismatch, reported by name", async () => {
  const artifacts = made("import { writeFileSync } from 'node:fs';\nwriteFileSync('report.html', '<p>' + Date.now() + Math.random() + '</p>');\n", { "report.html": "<p>1</p>" });
  const result = await reproduceDeliverables(dir, artifacts);
  expect(result).toMatchObject({ reproduced: false, problem: "mismatch", mismatched: ["report.html"] });
  expect(reproductionReason(result)).toBe("重新运行 run 脚本生成的 report.html 与交付的不一致");
});

test("a script that names a connection is not re-run; one that fails or never ends is held", async () => {
  expect(await reproduceDeliverables(dir, made("const r = await fetch('https://example.com');\n", { "table.csv": "x" }))).toMatchObject({ reproduced: false, problem: "network" });
  expect(await reproduceDeliverables(dir, made("throw new Error('boom');\n", { "table.csv": "x" }))).toMatchObject({ reproduced: false, problem: "failed", detail: expect.stringContaining("boom") });
  expect(await reproduceDeliverables(dir, made("for (;;) {}\n", { "table.csv": "x" }), { timeoutMs: 1_000 })).toMatchObject({ reproduced: false, problem: "timeout" });
}, 20_000);
