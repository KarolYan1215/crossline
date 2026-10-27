import { describe, expect, it } from "vitest";
import { unplacedTaskIds } from "./unplaced";

describe("unplacedTaskIds", () => {
  it("counts tasks, not steps, and leaves out work deliberately left for later", () => {
    const ids = unplacedTaskIds([
      { taskId: "wo-a#v1s1", code: "CAPACITY" }, { taskId: "wo-a#v1s2", code: "CAPACITY" },
      { taskId: "wo-b", code: "DEADLINE" }, { taskId: "wo-c", code: "Q4_NEEDS_DATE_OR_PROMOTION" }
    ]);
    expect([...ids]).toEqual(["wo-a", "wo-b"]);
  });
});
