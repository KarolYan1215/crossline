import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LocaleProvider } from "../locale-context";
import { QuestionCard } from "./question-card";
import type { Question } from "./onboarding-types";

const render = (question: Question) => renderToStaticMarkup(<LocaleProvider locale="zh">
  <QuestionCard question={question} answer={{ picked: [], other: "" }} onChange={() => {}} identities={[]} projects={[]} disabled={false} />
</LocaleProvider>);

test("a day question takes words or a day off the calendar, not a list of ranges (2026-11-14)", () => {
  const html = render({ id: "cv-when", kind: "free", text: "投简历这件事，你打算大概什么时候投出去？", options: [], allowOther: true, identityId: "", projectId: "" });
  expect(html).toContain('type="date"');
  expect(html).toContain("明年一季度");
  const other = render({ id: "busy", kind: "free", text: "每周什么时间段有空？", options: [], allowOther: true, identityId: "", projectId: "" });
  expect(other).not.toContain('type="date"');
});
