import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Prepared, preparedFiles } from "./prepared";

const output = (taskId: string, status: string, names: string[]) => ({ taskId, title: "x", status, stepId: "", files: names.map((name) => ({ path: `out/${name}`, name })) });

test("what the assistant has ready is linked where the work is done; failed or refused runs are not", () => {
  const detail = { id: "ece548-review", preparedMaterials: [{ id: "m", uri: "file:///data/materials/ece548-review/manual.md", fileName: "manual.md", mediaType: "text/markdown" }],
    agentOutputs: [output("t1", "accepted", ["材料目录.md"]), output("t2", "needs_review", ["公式表.md", "样题清单.md", "错题本.md", "extract_inputs.ps1"]), output("t3", "blocked", ["半成品.md"])] };
  expect(preparedFiles(detail).map((file) => file.name)).toEqual(["材料目录.md", "公式表.md", "样题清单.md", "错题本.md"]);
  const html = renderToStaticMarkup(<Prepared detail={detail} />);
  expect(html).toContain("已备好");
  expect(html).toContain('href="/workbench/ece548-review#tutorial"');
  expect(html).toContain("材料目录.md");
  expect(html).toContain("另有 1 份");
  expect(html).not.toContain("半成品.md");
  expect(renderToStaticMarkup(<Prepared detail={{ id: "x", preparedMaterials: [], agentOutputs: [] }} />)).toBe("");
});
