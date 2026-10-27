import { expect, test } from "vitest";
import { captureProgress } from "./capture-progress";

test("a 收集 card says where its capture got to, not what it said when written (W-16)", () => {
  expect(captureProgress({ state: "captured" }, undefined)).toBeUndefined();
  expect(captureProgress({ state: "blocked" }, undefined)).toMatchObject({ href: "/approvals" });
  const order = (state: string) => ({ id: "c1", state, title: "把门店名单发给陈默" });
  expect(captureProgress({ state: "promoted" }, order("approved"))).toEqual({ message: "已生成任务「把门店名单发给陈默」", href: "/workbench/c1" });
  expect(captureProgress({ state: "promoted" }, order("accepted"))?.message).toBe("任务「把门店名单发给陈默」已完成");
  expect(captureProgress({ state: "promoted" }, order("awaiting_plan_approval"))?.message).toContain("等本人批准");
});
