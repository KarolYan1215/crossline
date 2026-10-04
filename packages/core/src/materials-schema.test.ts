import { expect, test } from "vitest";
import { pathIsContained, PREFIX_THE_APP_OWNS } from "./materials-schema";

test.each([
  ["../escape.md", "a parent traversal"],
  ["/absolute.md", "an absolute path"],
  ["C:/windows.md", "a drive letter"],
  ["notes\\windows.md", "a backslash separator"],
  ["./here.md", "a dot segment"]
])("%s is refused as a material path (%s)", (relativePath) => {
  // The path check fails closed on every spelling of "somewhere else" rather than trying to normalise them.
  expect(pathIsContained(relativePath)).toBe(false);
});

test("a plain relative path is contained, and one repeating the folder the app owns is recognised", () => {
  expect(pathIsContained("notes/summary.md")).toBe(true);
  // Real-run behaviour: told to write beneath .crossline-materials/<id>/, the model put that prefix in the path.
  expect(PREFIX_THE_APP_OWNS.test(".crossline-materials/work-order-1/summary.md")).toBe(true);
});
