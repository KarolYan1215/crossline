import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RuntimeAlert } from "./runtime-banner";

test("a worker that is down is an alert with what stopped, not a question among the decisions", () => {
  const html = renderToStaticMarkup(<RuntimeAlert status={{ code: "worker_down", title: "后台服务没有运行", message: "自动分析已停止。" }} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain("后台服务没有运行");
  expect(html).not.toContain("去连接");
});

test("a signed-out runtime says where to sign in", () => {
  const html = renderToStaticMarkup(<RuntimeAlert status={{ code: "signed_out", title: "模型服务未登录", message: "已暂停。" }} />);
  expect(html).toContain('href="/settings#model"');
});
