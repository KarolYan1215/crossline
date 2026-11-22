import { describe, expect, test } from "vitest";
import { chooseFromFolder, collectDropped, folderFromInput, uploadInParallel, UPLOAD_CONCURRENCY } from "./upload-queue";
import { FOLDER_UPLOAD_LIMIT } from "./folder-pick";

const file = (name: string, modified = 0) => new File(["x"], name, { lastModified: modified });

// A dropped folder as Chromium hands it over: `readEntries` answers at most `batch` entries per call and then an empty list.
function directory(name: string, children: unknown[], batch = 100) {
  return { isFile: false, isDirectory: true, name, createReader: () => {
    let at = 0;
    return { readEntries: (ok: (entries: unknown[]) => void) => { const slice = children.slice(at, at + batch); at += slice.length; ok(slice); } };
  } };
}
const fileEntry = (name: string) => ({ isFile: true, isDirectory: false, name, file: (ok: (file: File) => void) => ok(file(name)) });

describe("dropping", () => {
  test("several folders are walked to the end, past readEntries' batches, beside loose files", async () => {
    const many = Array.from({ length: 250 }, (_, index) => fileEntry(`n${index}.md`));
    const a = directory("a", [...many, directory("sub", [fileEntry("deep.md")])]);
    const b = directory("b", [fileEntry("plan.md")]);
    const loose = file("cv.pdf");
    const items = [a, b, null].map((entry, index) => ({ kind: "file", webkitGetAsEntry: () => entry ?? fileEntry("cv.pdf"), getAsFile: () => index === 2 ? loose : null }));
    const dropped = await collectDropped({ items, files: [] } as unknown as DataTransfer);
    expect(dropped.folders.map((folder) => [folder.name, folder.files.length])).toEqual([["a", 251], ["b", 1]]);
    expect(dropped.folders[0]!.files.some((item) => item.path === "a/sub/deep.md")).toBe(true);
    expect(dropped.loose.map((item) => item.name)).toEqual(["cv.pdf"]);
  });

  test("files alone are taken as they are", async () => {
    const files = [file("a.md")];
    expect(await collectDropped({ items: [{ kind: "file", webkitGetAsEntry: () => fileEntry("a.md"), getAsFile: () => files[0] }], files } as unknown as DataTransfer))
      .toEqual({ loose: files, folders: [] });
  });
});

describe("choosing from a folder", () => {
  const folder = { name: "docs", files: ["docs/plan.md", "docs/LICENSE.txt", "docs/api_key.txt", "docs/W-2 2023.pdf", "docs/photo.jpg"]
    .map((path, index) => ({ path, file: file(path.split("/").pop()!, index) })) };

  test("code leaves out credentials and private papers first; the model screens the rest", async () => {
    let asked: unknown;
    const choice = await chooseFromFolder(folder, async (body) => { asked = body; return { ok: true, keep: ["docs/plan.md", "docs/elsewhere.md"], why: "许可证不读" }; });
    expect((asked as { files: Array<{ path: string }> }).files.map((item) => item.path)).toEqual(["docs/LICENSE.txt", "docs/plan.md"]);
    expect(choice.files.map((item) => item.name)).toEqual(["plan.md"]);
    expect(choice.left).toEqual({ credentials: 1, sensitive: 1, skipped: 1, screened: 1 });
    expect(choice.why).toBe("许可证不读");
  });

  test("without the model's answer the most recently changed go, up to the limit", async () => {
    const big = { name: "f", files: Array.from({ length: FOLDER_UPLOAD_LIMIT + 3 }, (_, index) => ({ path: `f/n${index}.md`, file: file(`n${index}.md`, index) })) };
    const choice = await chooseFromFolder(big, async () => undefined);
    expect(choice.files).toHaveLength(FOLDER_UPLOAD_LIMIT);
    expect(choice.files[0]!.name).toBe(`n${FOLDER_UPLOAD_LIMIT + 2}.md`);
  });

  test("a webkitdirectory pick is one folder named by its first segment", () => {
    const picked = Object.assign(file("plan.md"), { webkitRelativePath: "work/plan.md" });
    expect(folderFromInput([picked] as unknown as FileList)).toEqual({ name: "work", files: [{ path: "work/plan.md", file: picked }] });
  });
});

test("files go up several at a time, and one that fails does not stop the others", async () => {
  let inFlight = 0, most = 0;
  const files = Array.from({ length: 12 }, (_, index) => file(`f${index}.md`));
  const progress: number[] = [];
  const outcomes = await uploadInParallel(files, async (item) => {
    inFlight += 1; most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    if (item.name === "f3.md") throw new Error("network");
    return item.name === "f5.md" ? { ok: false, refused: "像是密钥" } : { ok: true };
  }, (done) => progress.push(done));
  expect(most).toBe(UPLOAD_CONCURRENCY);
  expect(outcomes.filter((item) => item.ok)).toHaveLength(10);
  expect(outcomes[3]).toMatchObject({ ok: false });
  expect(outcomes[5]).toMatchObject({ ok: false, refused: "像是密钥" });
  expect(progress.at(-1)).toBe(12);
});
