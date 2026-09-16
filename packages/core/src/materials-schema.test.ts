import { expect, test } from "vitest";
import { validateMaterialPreparation, type MaterialContext } from "./materials-schema";

const context: MaterialContext = {
  version: "crossline.materials.v1",
  workOrder: { id: "work-order-1", intent: "准备组会材料", identityId: "research", milestoneId: "milestone-1" },
  materialContract: [{ id: "contract-0", description: "一页方法学摘要", required: true }],
  availableInputs: [{ id: "input-0", text: "上周的实验记录" }],
  budget: { mode: "normal" }
};

const artifact = (overrides: Partial<{ relativePath: string; content: string; mediaType: string; sourceRefs: string[] }> = {}) => ({
  relativePath: "summary.md", content: "# 摘要", mediaType: "text/markdown",
  sourceRefs: ["contract-0"], ...overrides
});
const output = (artifacts: ReturnType<typeof artifact>[]) => ({ artifacts, unresolvedQuestions: [], blockers: [] });

test("a well-formed preparation passes through unchanged", () => {
  const result = validateMaterialPreparation(output([artifact(), artifact({ relativePath: "notes/raw.txt", mediaType: "text/plain" })]), context);
  expect(result.artifacts).toHaveLength(2);
});

test.each([
  ["../escape.md", "a parent traversal"],
  ["/absolute.md", "an absolute path"],
  ["C:/windows.md", "a drive letter"],
  ["notes\\windows.md", "a backslash separator"],
  ["./here.md", "a dot segment"]
])("%s is refused as a material path (%s)", (relativePath) => {
  // This Skill's output becomes files in the user's own project, so the path check fails closed on
  // every spelling of "somewhere else" rather than trying to normalise them.
  expect(() => validateMaterialPreparation(output([artifact({ relativePath })]), context))
    .toThrow("MATERIAL_PATH_OUTSIDE_ROOT");
});

test("two artifacts cannot claim the same path", () => {
  expect(() => validateMaterialPreparation(output([artifact(), artifact()]), context))
    .toThrow("MATERIAL_DUPLICATE_PATH");
});

test("a media type the writer cannot honestly produce is refused", () => {
  // Everything is written as UTF-8 text; recording "image/png" would make the provenance row a lie.
  expect(() => validateMaterialPreparation(output([artifact({ mediaType: "image/png" })]), context))
    .toThrow("MATERIAL_MEDIA_TYPE_UNSUPPORTED");
});

test("provenance must name something this app supplied, or a URL actually read", () => {
  expect(validateMaterialPreparation(output([artifact({ sourceRefs: ["https://example.org/paper"] })]), context).artifacts)
    .toHaveLength(1);
  expect(validateMaterialPreparation(output([artifact({ sourceRefs: ["input-0", "work-order-1"] })]), context).artifacts)
    .toHaveLength(1);
  // An id nobody supplied looks checkable and is not, which is worse than citing nothing.
  expect(() => validateMaterialPreparation(output([artifact({ sourceRefs: ["contract-9"] })]), context))
    .toThrow("MATERIAL_SOURCE_UNKNOWN");
});

test("content is capped across all artifacts, not just each one", () => {
  const big = () => artifact({ relativePath: `${Math.random()}.md`, content: "x".repeat(200_000) });
  expect(() => validateMaterialPreparation(output([big(), big(), big(), big(), big(), big()]), context))
    .toThrow("MATERIAL_TOO_LARGE");
});

test("a Skill that stopped keeps its reason, and nothing is written", () => {
  const blocked = { artifacts: [artifact()], unresolvedQuestions: [], blockers: [
    { code: "INPUT_UNAVAILABLE", message: "实验记录不在可用输入里。" }
  ] };
  try {
    validateMaterialPreparation(blocked, context);
    throw new Error("expected the preparation to be refused");
  } catch (error) {
    expect((error as Error).message).toBe("MATERIAL_BLOCKED");
    expect((error as Error & { detail?: string }).detail).toBe("实验记录不在可用输入里。");
  }
});

test("a path that repeats the folder the app owns is refused, not silently nested", () => {
  // Real-run behaviour: told to write beneath <projectRoot>/.crossline-materials/<id>/, the model put
  // that prefix in relativePath. Resolving it against that same folder filed the artifact one level
  // too deep — contained, so nothing failed, and simply in the wrong place.
  expect(() => validateMaterialPreparation(
    output([artifact({ relativePath: ".crossline-materials/work-order-1/summary.md" })]), context))
    .toThrow("MATERIAL_PATH_REPEATS_ROOT");
});
