import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ALLOWED_ATTACHMENT_TYPES, attachmentMediaType } from "./attachments";

test("what the assistant delivers can be handed in: Markdown, CSV and JSON are allowed, by type or, with none, by extension", () => {
  for (const type of ["text/markdown", "text/csv", "application/json"]) expect(ALLOWED_ATTACHMENT_TYPES[type]).toBeTruthy();
  // Windows browsers send `.md` with no type.
  expect(attachmentMediaType("", "首篇笔记提纲与来源.md")).toBe("text/markdown");
  expect(attachmentMediaType("application/octet-stream", "data.csv")).toBe("text/csv");
  // A claimed type stands; an unknown extension stays unknown and is refused.
  expect(attachmentMediaType("image/png", "a.md")).toBe("image/png");
  expect(ALLOWED_ATTACHMENT_TYPES[attachmentMediaType("", "run.exe")]).toBeUndefined();
});
