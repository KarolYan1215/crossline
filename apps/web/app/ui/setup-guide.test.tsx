import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { SetupGuide } from "./setup-guide";
import { MAIL_GUIDE } from "../../lib/setup-guides";

test("a guide is one advanced fold: a tab per provider, the chosen one's steps and values, its official pages in a new tab, the usual mistakes", () => {
  const html = renderToStaticMarkup(<SetupGuide guide={MAIL_GUIDE} selected="qq" open />);
  expect(html).toMatch(/^<details class="advanced setup-guide" open="">/);
  expect(html).toContain('aria-pressed="true">QQ 邮箱 / Foxmail</button>');
  expect(html).toContain("开启「IMAP/SMTP 服务」");
  expect(html).toContain("imap.qq.com");
  expect(html).not.toContain("imap.gmail.com");
  expect(html).toContain('href="https://mail.qq.com" target="_blank" rel="noopener noreferrer"');
  expect(html).toContain("常见出错");
});

test("without a choice the first provider is shown, and the fold starts closed", () => {
  const html = renderToStaticMarkup(<SetupGuide guide={MAIL_GUIDE} />);
  expect(html).toMatch(/^<details class="advanced setup-guide">/);
  expect(html).toContain('aria-pressed="true">Gmail</button>');
});