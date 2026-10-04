import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LocalActivityConsent } from "./local-activity-consent";

test("a first-time visitor is offered the three levels, and an answered one sees nothing", () => {
  const asking = renderToStaticMarkup(<LocalActivityConsent asked={false} />);
  expect(asking).toContain("开启（应用+窗口）");
  expect(asking).toContain("只记活跃分钟数");
  expect(asking).toContain("不开启");
  expect(renderToStaticMarkup(<LocalActivityConsent asked />)).toBe("");
});

test("someone who agreed to minutes only is asked once about the detailed level, because the promise changed", () => {
  const upgrading = renderToStaticMarkup(<LocalActivityConsent asked upgrade />);
  expect(upgrading).toContain("多了一档");
  expect(upgrading).toContain("升级（应用+窗口）");
  expect(upgrading).toContain("保持只记分钟数");
  // It says what stays true, in the same breath as what is new.
  expect(upgrading).toContain("不会发给任何模型");
});
