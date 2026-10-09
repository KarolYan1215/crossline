import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";

test("model-written Markdown is drawn as headings, lists and bold, and never as HTML", () => {
  const html = renderToStaticMarkup(<Markdown text={"主线：完成作业。\n\n## 假设\n- 共 **5** 题\n- 平台可访问\n\n1. 读题\n2. 作答\n<script>x</script>"} />);
  expect(html).toContain("<h5>假设</h5>");
  expect(html).toContain("<ul><li>共 <b>5</b> 题</li><li>平台可访问</li></ul>");
  expect(html).toContain("<ol><li>读题</li><li>作答</li></ol>");
  expect(html).not.toContain("##");
  expect(html).toContain("&lt;script&gt;");
});
