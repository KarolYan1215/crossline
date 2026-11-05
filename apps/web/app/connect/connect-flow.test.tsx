import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ConnectFlow } from "./connect-flow";

// The page once rendered the control only after it knew the answer, while the control was what asked: it waited forever, blank.
test("the connection control is on the page from the first render, so it can read whether the account is connected", () => {
  const html = renderToStaticMarkup(<ConnectFlow next="/onboarding" />);
  expect(html).toContain('aria-label="模型连接"');
  expect(html).toContain("连接后自动进入访谈");
});

// An account may connect another model's API instead of ChatGPT (decided 2026-10-17): the card is on the connect page, not only in settings.
test("the connect page offers another model's API beside ChatGPT", () => {
  const html = renderToStaticMarkup(<ConnectFlow next="/onboarding" />);
  expect(html).toContain("或者用其他模型的 API");
  expect(html).toContain('aria-label="其他模型"');
});

// The hosted site signs no guest's ChatGPT in on the server (2026-11-05): installing and pairing a node is walked through right here.
test("on the hosted site the connect page walks through installing and pairing the person's own computer; elsewhere it does not", () => {
  const hosted = renderToStaticMarkup(<ConnectFlow next="/onboarding" hosted />);
  expect(hosted).toContain('aria-label="用自己的电脑连接 ChatGPT"');
  expect(hosted).toContain("Crossline-Node-Setup.exe");
  expect(hosted).toContain("Crossline-Node-Guide.pdf");
  expect(hosted).toContain("仍要运行");
  expect(renderToStaticMarkup(<ConnectFlow next="/onboarding" />)).not.toContain("用自己的电脑连接 ChatGPT");
});
