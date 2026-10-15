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

test("an inline formula is typeset by KaTeX, text around it and a price stay text", () => {
  const html = renderToStaticMarkup(<Markdown text={"波长 $\\lambda=h/\\sqrt{2m_eE}$，约 **$2.74\\ \\mathrm{nm}$**。票价 $5 和 $10。"} />);
  expect(html).toContain("<span class=\"md-math\"><span class=\"katex\">");
  expect(html).toContain("<math");
  expect(html).toContain("katex-html");
  // The source survives only as KaTeX's own MathML annotation, never as visible text with its dollar signs.
  expect(html).not.toContain("$\\lambda");
  expect(html).toMatch(/<b><span class="md-math">/);
  expect(html).toContain("票价 $5 和 $10。");
});

test("a display formula on its own lines is typeset as a block", () => {
  const html = renderToStaticMarkup(<Markdown text={"推导：\n\n$$\nW=\\sqrt{\\frac{2\\epsilon_s}{q}\\left(\\frac1{N_A}+\\frac1{N_D}\\right)V}\n$$\n\n结束。"} />);
  expect(html).toMatch(/<div class="md-math md-math-display"><span class="katex-display">/);
  expect(html).toContain("<p>结束。</p>");
  expect(renderToStaticMarkup(<Markdown text={"$$ E=mc^2 $$"} />)).toContain("katex-display");
});

test("a formula KaTeX cannot read, or that is not LaTeX, is shown as written", () => {
  expect(renderToStaticMarkup(<Markdown text={"见 $\\frac{1}{$ 处"} />)).toContain("见 $\\frac{1}{$ 处");
  expect(renderToStaticMarkup(<Markdown text={"路径 $repo\\CLAUDE.md$ 不是公式"} />)).toContain("$repo\\CLAUDE.md$");
  // Unicode text inside a formula is not LaTeX: strict mode refuses it rather than guessing.
  expect(renderToStaticMarkup(<Markdown text={"$缺少$"} />)).toContain("<p>$缺少$</p>");
  expect(renderToStaticMarkup(<Markdown text={"$$\n\\frac{1}{\n$$"} />)).toContain("<p>$$\n\\frac{1}{\n$$</p>");
});

test("nothing in a formula is run: a script tag and KaTeX's own escape hatches stay inert", () => {
  const scripted = renderToStaticMarkup(<Markdown text={"$x<script>alert(1)</script>$ 与 $$<img src=x onerror=alert(1)>$$"} />);
  expect(scripted).not.toMatch(/<script|<img/i);
  // trust:false refuses links, classes and raw HTML commands; the source is shown as text instead.
  for (const tex of ["\\href{javascript:alert(1)}{x}", "\\htmlClass{evil}{x}", "\\url{https://example.com}", "\\includegraphics{x.png}"]) {
    const html = renderToStaticMarkup(<Markdown text={`$${tex}$`} />);
    expect(html).not.toMatch(/<a\s|href=|class="evil"|<img/i);
    expect(html).toContain(`<p>$${tex}$</p>`);
  }
});
