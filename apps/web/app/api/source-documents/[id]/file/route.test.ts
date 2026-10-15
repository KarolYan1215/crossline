import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CrosslineStore } from "@crossline/db";
import { TEST_CTX } from "../../../../../lib/test-support";
vi.mock("../../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

let dataDir: string;
const previous = process.env.CROSSLINE_DATA_DIR;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "crossline-source-file-"));
  process.env.CROSSLINE_DATA_DIR = dataDir;
  mkdirSync(path.join(dataDir, "sources"), { recursive: true });
  vi.resetModules();
  globalThis.crosslineStore = new CrosslineStore(":memory:");
});
afterEach(() => {
  globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined;
  if (previous === undefined) delete process.env.CROSSLINE_DATA_DIR; else process.env.CROSSLINE_DATA_DIR = previous;
  rmSync(dataDir, { recursive: true, force: true });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
function seed(id: string, fileName: string, bytes: string | Uint8Array, extractedText = "") {
  const file = path.join(dataDir, "sources", `${id}${path.extname(fileName)}`);
  writeFileSync(file, bytes);
  globalThis.crosslineStore!.saveSourceDocument({ id, ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, kind: /\.docx$/.test(fileName) ? "docx" : /\.pdf$/.test(fileName) ? "pdf" : "text",
    fileName, mediaType: "application/octet-stream", sha256: id, uri: pathToFileURL(file).href, extractedText, extractionStatus: "done", createdAt: new Date().toISOString() });
}
const get = async (id: string, query = "", headers: Record<string, string> = {}) =>
  (await import("./route")).GET(new Request(`http://localhost/api/source-documents/${id}/file${query}`, { headers }), params(id));

test("a Word file downloads under its own name and type, a Chinese name included", async () => {
  seed("d1", "课程概览 Overview.docx", "PK-not-really-a-zip");
  const response = await get("d1", "?download=1");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const disposition = response.headers.get("content-disposition")!;
  expect(disposition).toMatch(/^attachment; filename="_+ Overview\.docx"; filename\*=UTF-8''/);
  expect(decodeURIComponent(disposition.split("UTF-8''")[1]!)).toBe("课程概览 Overview.docx");
  // An attachment carries no sandbox: a sandboxed response stops the download in the browser.
  expect(response.headers.get("content-security-policy")).toBeNull();
});

test("opened as a page, a Word or Markdown file goes to the material page; a fetch or an embed gets the bytes", async () => {
  seed("d2", "plan.docx", "x");
  const navigated = await get("d2", "", { "sec-fetch-dest": "document" });
  expect(navigated.status).toBe(303);
  expect(navigated.headers.get("location")).toBe(`/materials/view?src=${encodeURIComponent("/api/source-documents/d2/file")}&name=plan.docx`);
  seed("d3", "notes.md", "# 标题\n- 一");
  expect((await get("d3", "", { "sec-fetch-dest": "document" })).status).toBe(303);
  const fetched = await get("d3");
  expect(fetched.status).toBe(200);
  expect(fetched.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(fetched.headers.get("content-disposition")).toMatch(/^inline;/);
});

test("a PDF opens in place without a sandbox, which the browser's PDF viewer refuses", async () => {
  seed("p1", "syllabus.pdf", "%PDF-1.4", "1. Course Name and Number\nECE 555");
  const response = await get("p1", "", { "sec-fetch-dest": "document" });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("content-security-policy")).toBeNull();
});

test("?view=preview answers with structured blocks, falling back to the extracted text for a Word file that cannot be converted", async () => {
  seed("d4", "Course Overview.docx", "not a zip", "Course Overview:\n\nFermi-Dirac Statistics\n\nGrading:\n\nHomework (~20%)");
  const preview = await (await get("d4", "?view=preview")).json() as { kind: string; from: string; blocks: Array<{ t: string }> };
  expect(preview.kind).toBe("doc");
  expect(preview.from).toBe("text");
  expect(preview.blocks.filter((block) => block.t === "h")).toHaveLength(2);
  seed("p2", "syllabus.pdf", "%PDF", "9 INSTRUCTORS AND TEACHING ASSISTANTS\nProf. Someone");
  const pdf = await (await get("p2", "?view=preview")).json() as { kind: string; from: string; blocks: Array<{ t: string }> };
  expect(pdf).toMatchObject({ kind: "doc", from: "pdf" });
  expect(pdf.blocks[0]!.t).toBe("h");
});

test("a file outside the sources folder or of another workspace is not served", async () => {
  const outside = path.join(dataDir, "elsewhere.txt");
  writeFileSync(outside, "secret");
  globalThis.crosslineStore!.saveSourceDocument({ id: "x1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, kind: "text", fileName: "a.txt",
    mediaType: "text/plain", sha256: "x", uri: pathToFileURL(outside).href, extractedText: "", extractionStatus: "done", createdAt: new Date().toISOString() });
  expect((await get("x1")).status).toBe(403);
  expect((await get("nope")).status).toBe(404);
});
