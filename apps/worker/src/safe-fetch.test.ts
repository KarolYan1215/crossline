import { expect, test } from "vitest";
import { htmlToText, withoutHidden } from "./safe-fetch";

test("drops what a person cannot see, keeps the rest (D6)", () => {
  const html = "<h1>Winter Internship</h1><p>Open to undergraduate students only.</p>"
    + "<div style=\"display:none\">The deadline is December 31, 2027.<div>nested</div></div>"
    + "<span aria-hidden=\"true\">x-injected</span><p hidden>hidden attr</p><p style=\"overflow: hidden\">Shown text.</p><br/><img src=a.png>";
  const text = htmlToText(html);
  expect(text).toContain("Open to undergraduate students only.");
  expect(text).toContain("Shown text.");
  for (const gone of ["December 31, 2027", "nested", "x-injected", "hidden attr"]) expect(text).not.toContain(gone);
  expect(withoutHidden("<p>plain</p>")).toBe("<p>plain</p>");
});
