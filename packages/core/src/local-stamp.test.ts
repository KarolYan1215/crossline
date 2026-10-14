import { expect, test } from "vitest";
import { localStamp } from "./local-stamp";

test("a UTC instant is shown on the person's clock, the evening before when UTC has passed midnight", () => {
  expect(localStamp("2026-10-14T03:46:00.000Z", "America/Chicago")).toBe("10/13 22:46");
  expect(localStamp("2026-10-07T08:26:00.000Z", "America/Chicago")).toBe("10/7 03:26");
  expect(localStamp("2026-10-07T08:26:00.000Z", "Asia/Shanghai")).toBe("10/7 16:26");
});
