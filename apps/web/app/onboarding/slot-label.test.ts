import { expect, test } from "vitest";
import { slotLabel } from "./profile-panel";

// W-7: every recorded fact read 「备注」, so a name, a city and a career all looked the same.
test("a fact is labelled by its kind: a known key, a person's key, a prefix, then the key's words; never a bare key", () => {
  expect(slotLabel("what")).toBe("在做什么");
  expect(slotLabel("city")).toBe("所在城市");
  expect(slotLabel("name")).toBe("称呼");
  expect(slotLabel("meeting_times")).toBe("上课时间");
  expect(slotLabel("date_ece548_midterm")).toBe("日期");
  expect(slotLabel("work_experience")).toBe("经历");
  expect(slotLabel("course_goal")).toBe("目标");
  expect(slotLabel("proposal_deadline")).toBe("截止");
  expect(slotLabel("trial_users")).toBe("进展");
  expect(slotLabel("zzz")).toBe("其他");
  const labels = ["name", "city", "work_experience", "school", "trial_users"].map(slotLabel);
  expect(new Set(labels).size).toBe(labels.length);
});
