import { beforeEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "../../../../../../lib/test-support";

const files: Record<string, string> = {};
vi.mock("../../../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));
vi.mock("../../../../../../lib/agent", () => ({
  outputNames: () => ({ ["a".repeat(64)]: "Course Schedule" }),
  readTaskFile: (_ctx: unknown, _id: string, relative: string) => relative in files ? { body: Buffer.from(files[relative]!), type: "application/octet-stream" } : undefined,
  loadTaskAudit: (_ctx: unknown, id: string) => id === "agent-1" ? { artifacts: [
    { path: "ECE548_期中1_材料目录.docx", purpose: "期中 1 材料目录" }, { path: "ECE548_期中1_材料目录.md", purpose: "目录源文件" },
    { path: "scripts/build.py", purpose: "生成脚本" }, { path: "缺口清单.md", purpose: "缺口" }] } : undefined
}));

beforeEach(() => { for (const key of Object.keys(files)) delete files[key]; });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = async (id: string, query: string, headers: Record<string, string> = {}) =>
  (await import("./route")).GET(new Request(`http://localhost/api/agent/tasks/${id}/file${query}`, { headers }), params(id));

test("the assistant's Word file downloads under its own name instead of a nameless 「file」", async () => {
  files["out/ECE548_期中1_材料目录_初版.docx"] = "PK";
  const response = await get("agent-1", `?path=${encodeURIComponent("out/ECE548_期中1_材料目录_初版.docx")}&download=1`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("wordprocessingml");
  expect(decodeURIComponent(response.headers.get("content-disposition")!.split("UTF-8''")[1]!)).toBe("ECE548_期中1_材料目录_初版.docx");
  expect(response.headers.get("content-security-policy")).toBeNull();
});

test("a link that opens the assistant's Markdown goes to the material page; an image opens in place, sandboxed", async () => {
  files["notes.md"] = "# 目录\n- L1";
  files["chart.png"] = "png";
  const page = await get("agent-1", "?path=notes.md", { "sec-fetch-dest": "document" });
  expect(page.status).toBe(303);
  expect(page.headers.get("location")).toContain(encodeURIComponent("/api/agent/tasks/agent-1/file?path=notes.md"));
  const image = await get("agent-1", "?path=chart.png", { "sec-fetch-dest": "document" });
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("content-security-policy")).toContain("sandbox");
});

test("?view=preview draws Markdown and a CSV as data, never HTML", async () => {
  files["ledger.csv"] = "文件,状态\n讲义 L1,已有\n\"作业, HW1\",缺";
  const table = await (await get("agent-1", "?path=ledger.csv&view=preview")).json();
  expect(table).toEqual({ kind: "table", header: ["文件", "状态"], rows: [["讲义 L1", "已有"], ["作业, HW1", "缺"]], totalRows: 2 });
  files["a.md"] = "<script>alert(1)</script>";
  const markdown = await (await get("agent-1", "?path=a.md&view=preview")).json();
  expect(markdown).toMatchObject({ kind: "markdown", text: "<script>alert(1)</script>" });
});

test("?view=outputs groups the run's files by use and leaves its scripts out", async () => {
  const grouped = await (await get("agent-1", "?view=outputs")).json() as { groups: Array<{ group: string; items: Array<{ path: string; previewPath?: string }> }>; hidden: number };
  expect(grouped.hidden).toBe(1);
  expect((grouped as unknown as { names: Record<string, string> }).names).toEqual({ ["a".repeat(64)]: "Course Schedule" });
  expect(grouped.groups.map((entry) => entry.group)).toEqual(["材料目录", "缺口清单"]);
  expect(grouped.groups[0]!.items[0]).toMatchObject({ path: "ECE548_期中1_材料目录.docx", previewPath: "ECE548_期中1_材料目录.md" });
  expect((await get("agent-2", "?view=outputs")).status).toBe(404);
});

test("a file not in the task's directory is not served", async () => {
  expect((await get("agent-1", "?path=missing.md")).status).toBe(404);
});
