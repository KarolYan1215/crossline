import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ConnectFlow, ConnectWaiting, connectPhase } from "./connect-flow";

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

// W-233: whichever way works — an invite code, ChatGPT, an API, a node — the page goes on at once, and while it waits it says so.
test("the page waits with a line, never the choices, until it knows; any way that works moves it on", () => {
  expect(connectPhase({ chatgpt: undefined, api: undefined, connected: false, patient: false })).toBe("checking");
  expect(connectPhase({ chatgpt: false, api: undefined, connected: false, patient: false })).toBe("checking");
  // An invite (or a node) counts at once, even while the other reads are out.
  expect(connectPhase({ chatgpt: undefined, api: undefined, connected: true, patient: false })).toBe("entering");
  expect(connectPhase({ chatgpt: true, api: false, connected: true, patient: true })).toBe("entering");
  expect(connectPhase({ chatgpt: false, api: false, connected: false, patient: false })).toBe("choose");
  // A read that never answers does not hold the page: after CHECK_MS the choices are shown.
  expect(connectPhase({ chatgpt: undefined, api: undefined, connected: false, patient: true })).toBe("choose");
});

test("the first render is the waiting line; the choices are mounted but hidden, since they are what read the connection", () => {
  const html = renderToStaticMarkup(<ConnectFlow next="/onboarding" />);
  expect(html).toContain('role="status"');
  expect(html).toContain("正在检查这个账号的模型连接…");
  expect(html).toContain('class="connect-options" hidden=""');
});

test("entering says where it goes, and when the next page is slow offers a link to it", () => {
  const quick = renderToStaticMarkup(<ConnectWaiting phase="entering" next="/onboarding" slow={false} />);
  expect(quick).toContain("已连接，正在进入访谈…");
  expect(quick).not.toContain("href=");
  const slow = renderToStaticMarkup(<ConnectWaiting phase="entering" next="/onboarding" slow />);
  expect(slow).toContain('href="/onboarding"');
  expect(slow).toContain("直接进入访谈");
  expect(renderToStaticMarkup(<ConnectWaiting phase="entering" next="/" slow />)).toContain("已连接，正在打开…");
});
