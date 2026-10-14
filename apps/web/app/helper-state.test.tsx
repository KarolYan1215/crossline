import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { HelperFace, helperMood } from "./helper-state";

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
