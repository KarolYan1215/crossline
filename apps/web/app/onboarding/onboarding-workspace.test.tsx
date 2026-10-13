import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { MaterialsFirst, StartCard } from "./onboarding-workspace";

const lines = [{ id: "media", label: "创作者", rank: null, hard: false, goals: [], goalParts: [] }];

test("未达可开始时写明还差哪几项、在哪里补；没有「开始使用」", () => {
  const html = renderToStaticMarkup(<StartCard readyToStart={false} lines={lines} missing={[
    { id: "line_goal:media", label: "「创作者」已选定至少一个长期目标", detail: "从候选中采用或自己写一个", owner: "person" },
    { id: "line_project:media", label: "「创作者」有当前项目，且知道截止或没有截止", detail: "缺截止（或说明没有截止）：小红书", owner: "interview" }]} />);
  expect(html).toContain("开始使用前还差 2 项");
  expect(html).toContain("「创作者」已选定至少一个长期目标");
  expect(html).toContain("在右侧画像下为「创作者」采用长期目标");
  expect(html).toContain("缺截止（或说明没有截止）：小红书");
  expect(html).not.toContain("开始使用</a>");
});

test("达标后出现「开始使用」，并说明画像访谈在同一处继续", () => {
  const html = renderToStaticMarkup(<StartCard readyToStart lines={lines} missing={[]} />);
  expect(html).toMatch(/<a[^>]*href="\/"[^>]*>开始使用<\/a>/);
  expect(html).toContain("画像访谈在同一处继续，问题也会列在待决事项");
  expect(html).not.toContain("开始使用前还差");
});

test("第一步是材料：上传入口与「读完材料，开始访谈」；没有材料时是「没有材料，直接开始」", () => {
  const doc = { id: "d1", fileName: "Syllabus.pdf", kind: "pdf", extractionStatus: "done" as const };
  const withFiles = renderToStaticMarkup(<MaterialsFirst documents={[doc]} busy={false} onUpload={() => {}} onStart={() => {}} />);
  expect(withFiles).toContain("第一步：添加材料");
  expect(withFiles).toContain("添加文件");
  expect(withFiles).toContain("Syllabus.pdf");
  expect(withFiles).toContain("读完材料，开始访谈");
  const empty = renderToStaticMarkup(<MaterialsFirst documents={[]} busy={false} onUpload={() => {}} onStart={() => {}} />);
  expect(empty).toContain("没有材料，直接开始");
  expect(empty).not.toContain("读完材料，开始访谈");
});
