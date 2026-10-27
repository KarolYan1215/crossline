import { expect, test } from "vitest";
import { personSetting } from "./manualbook";

test("the researcher is told where the person is only from what they confirmed", () => {
  expect(personSetting([
    { identityId: "person", slot: "city", value: "杭州", status: "confirmed" },
    { identityId: "person", slot: "所在国家", value: "假设：中国", status: "inferred" },
    { identityId: "person", slot: "language", value: "假设：中文", status: "confirmed" },
    { identityId: "startup", slot: "city", value: "上海", status: "confirmed" },
    { identityId: "person", slot: "name", value: "周", status: "confirmed" }
  ])).toEqual(["杭州"]);
});
