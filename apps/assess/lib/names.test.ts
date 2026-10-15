import { expect, test } from "vitest";
import { withName } from "./names";

test("a nickname runs straight into Chinese text, and is spaced after Latin letters or digits", () => {
  expect(withName("小鹿", "的")).toBe("小鹿的");
  expect(withName("Leo", "邀请你")).toBe("Leo 邀请你");
  expect(withName("阿乔2", "的")).toBe("阿乔2 的");
});
