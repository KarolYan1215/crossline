import { afterEach, expect, test } from "vitest";
import { setDesignNoteProvider, setInstructionsProvider, withDesignNote } from "./skill-runner";

afterEach(() => { setDesignNoteProvider(undefined); setInstructionsProvider(undefined); });

test("every Skill's run note carries the Skill's own note and then 「给 Crossline 的话」, each framed; nothing set leaves the run note alone", () => {
  expect(withDesignNote("run note", "crossline:crossline-tutor")).toBe("run note");
  expect(withDesignNote(undefined, "crossline:crossline-tutor")).toBeUndefined();
  setDesignNoteProvider(() => "教程先给结论");
  setInstructionsProvider(() => "称呼我小严");
  const note = withDesignNote("run note", "crossline:crossline-tutor")!;
  expect(note.startsWith("run note\n\n")).toBe(true);
  expect(note.indexOf("教程先给结论")).toBeLessThan(note.indexOf("称呼我小严"));
  expect(note).toContain("never Crossline's safety boundaries");
  setDesignNoteProvider(undefined);
  expect(withDesignNote(undefined, "x")).toMatch(/称呼我小严$/);
});
