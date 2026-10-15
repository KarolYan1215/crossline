import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { HelperFace, helperMood, plainText, previewText } from "./helper-state";

test("the figure says the most pressing thing: the background stopped, then thinking, then the assistant at work, then a new message", () => {
  const none = { down: false, thinking: false, working: false, unread: false };
  expect(helperMood(none)).toBe("idle");
  expect(helperMood({ ...none, unread: true })).toBe("unread");
  expect(helperMood({ ...none, unread: true, working: true })).toBe("working");
  expect(helperMood({ ...none, working: true, thinking: true })).toBe("thinking");
  expect(helperMood({ down: true, thinking: true, working: true, unread: true })).toBe("down");
});

test("the face is the figure's upper half in a frame, hidden from screen readers (the button carries the label)", () => {
  const html = renderToStaticMarkup(<HelperFace src="/api/portrait/image/character?v=1" size="button" mood="unread" />);
  expect(html).toContain('class="helper-face"');
  expect(html).toContain('data-mood="unread"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("/api/portrait/image/character?v=1");
});

test("the bubble's text is cut by characters with an ellipsis, and a cut inside a 「」 quote closes the quote", () => {
  expect(previewText("短消息")).toBe("短消息");
  const real = "1 项任务已自动生效并排进日程：整理 ECE 548 讲义目录。24 小时内可在待确认页「最近自动生效」撤销，撤销后回到待批准。";
  const cut = previewText(real, 50);
  expect(Array.from(cut).length).toBeLessThanOrEqual(51);
  expect(cut).not.toMatch(/「$/);
  expect(cut.endsWith("…") || cut.endsWith("…」")).toBe(true);
  // Cut inside the quote: the quote is closed after the ellipsis.
  expect(previewText("可在待确认页「最近自动生效」撤销", 10)).toBe("可在待确认页「最近…」");
  // Cut right after the opening quote: the bare quote is dropped rather than left open.
  expect(previewText("24 小时内可在待确认页「最近自动生效」撤销", 14)).toBe("24 小时内可在待确认页…");
  // Characters outside the BMP count as one and are never split.
  expect(previewText("😀😀😀😀😀", 3)).toBe("😀😀…");
});

test("Markdown marks are taken out before the text is shown or looked for on the page", () => {
  expect(plainText("**今天** 有 [两件事](/plan) 要做：\n- `ECE 548` 作业")).toBe("今天 有 两件事 要做： ECE 548 作业");
});
