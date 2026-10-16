import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { QUIZ_ITEMS } from "@crossline/core/assess";
import { emptyFlow } from "../lib/flow";
import { fixtureResult } from "../lib/fixtures";
import { EmailStep } from "./email-step";
import { DrawingCard, FigureTile } from "./figure";
import { SavableImage, withVersion } from "./poster";
import { QuizStep } from "./quiz-step";
import { AxesList, axisLean } from "./type-summary";

const noop = () => {};
const emailStep = (extra: Partial<Parameters<typeof EmailStep>[0]> = {}) => renderToStaticMarkup(<EmailStep
  fields={{ email: "", nickname: "", sendEmail: emptyFlow().sendEmail, website: "" }} problems={{ email: null, nickname: null }}
  error={null} busy={false} invited={false} onChange={noop} onSubmit={noop} onBack={noop} {...extra} />);

test("the email step's checkbox is ticked by default and says what it does", () => {
  const html = emailStep();
  const box = /<input[^>]*name="sendEmail"[^>]*>/.exec(html)?.[0] ?? "";
  expect(box).toContain("type=\"checkbox\"");
  expect(box).toContain("checked=\"\"");
  expect(html).toContain("把结果链接发到我的邮箱");
  // What the address is for, how long it is kept and how to delete it, said before it is asked for.
  expect(html).toContain("邮箱只用来");
  expect(html).toContain("结果保存 90 天后自动删除");
  expect(html).toContain("一个邮箱最多测 3 次，只保留最新一次");
  expect(html).toContain("「删除我的结果」");
  expect(html).toContain("不发营销邮件");
  expect(html).toContain("这次结果会自动带进 App");
  expect(html).toContain("你的昵称（可选）");
});

test("the honeypot is present, named website, out of the tab order, away from autofill and hidden from people", () => {
  const html = emailStep();
  const trap = /<div class="as-trap" aria-hidden="true">.*?<\/div>/.exec(html)?.[0] ?? "";
  const input = /<input[^>]*name="website"[^>]*>/.exec(trap)?.[0] ?? "";
  expect(input).toContain("tabindex=\"-1\"");
  expect(input).toMatch(/autoComplete="off"/i);
  const css = readFileSync(new URL("../app/assess.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.as-trap\{position:absolute;left:-10000px/);
});

test("a refusal shows its wording, and a dead invitation offers to go on without it", () => {
  const html = emailStep({ error: "这个邀请链接已失效", onSubmitWithoutInvite: noop });
  expect(html).toContain("role=\"alert\"");
  expect(html).toContain("不带邀请提交");
});

test("a statement screen is one native radio group of five, with progress and the chosen answer checked", () => {
  const flow = { ...emptyFlow(), step: "quiz" as const, startedAt: 0, index: 1, answers: { q1: 2, q2: 5 } };
  const html = renderToStaticMarkup(<QuizStep flow={flow} onChoose={noop} onBack={noop} onNext={noop} />);
  expect(html.match(/type="radio"/g)).toHaveLength(5);
  expect(html).toContain(QUIZ_ITEMS[1]!.text);
  expect(html).toContain("aria-valuenow=\"2\"");
  expect(html.match(/<input[^>]*checked=""[^>]*>/g)).toEqual([expect.stringContaining("value=\"5\"")]);
  expect(html).toContain("上一题");
});

test("the poster is a plain image with the long-press hint and real downloads, and a redraw busts only real addresses", () => {
  const html = renderToStaticMarkup(<SavableImage src="/api/poster/x.png" alt="海报" width={1080} height={1440} downloadName="p.png"
    extra={{ src: "/api/poster/x-long.png", label: "长图", downloadName: "l.png" }} />);
  expect(html).toContain("<img src=\"/api/poster/x.png\"");
  expect(html).toContain("长按图片保存");
  expect(html).toContain("download=\"p.png\"");
  expect(html).toContain("下载长图");
  expect(withVersion("/api/poster/x.png", 7)).toBe("/api/poster/x.png?v=7");
  expect(withVersion("/a.png?s=1", 7)).toBe("/a.png?s=1&v=7");
  expect(withVersion("data:image/svg+xml,x", 7)).toBe("data:image/svg+xml,x");
});

test("an axis reads as the pole leaned to and its percentage", () => {
  const type = fixtureResult("x").type;
  for (const axis of type.axes) expect(axisLean(axis).percent).toBeGreaterThanOrEqual(50);
  expect(renderToStaticMarkup(<AxesList type={type} />)).toContain("理论估算");
});

test("a figure is the person's own drawing or the type's code, never the shared template; while it is drawn the poster waits", () => {
  const type = fixtureResult("x").type;
  const ready = renderToStaticMarkup(<FigureTile avatar={{ state: "ready", url: "/api/avatar/t.png?v=1" }} type={type} alt="小林的形象" width={120} height={180} />);
  expect(ready).toContain("<img");
  expect(ready).toContain("size=small");
  for (const state of ["queued", "drawing", "template"] as const) {
    const html = renderToStaticMarkup(<FigureTile avatar={{ state, url: "/api/avatar/t.png" }} type={type} alt="小林的形象" width={120} height={180} />);
    expect(html).not.toContain("<img");
    expect(html).toContain(type.code);
    expect(html.includes("data-waiting")).toBe(state !== "template");
  }
  const waiting = renderToStaticMarkup(<DrawingCard type={type} />);
  expect(waiting).toContain("正在画你的专属形象");
  expect(waiting).not.toContain("<img");
});
