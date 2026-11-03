import { describe, expect, it } from "vitest";
import { linkTarget } from "./link-targets";

describe("linkTarget", () => {
  const origin = "https://app.crossline.lol";
  it("opens an in-app link marked _blank in the same tab", () => {
    expect(linkTarget("/api/agent/tasks/x/file?path=a.md", "_blank", origin)).toBe("same");
    expect(linkTarget("https://app.crossline.lol/materials/1", "_blank", origin)).toBe("same");
  });
  it("leaves an in-app link with no target alone", () => expect(linkTarget("/plan", "", origin)).toBeNull());
  it("opens an off-app link in a new tab", () => expect(linkTarget("https://github.com/x", "", origin)).toBe("new"));
  it("leaves an off-app link already in a new tab, and mailto", () => {
    expect(linkTarget("https://github.com/x", "_blank", origin)).toBeNull();
    expect(linkTarget("mailto:a@b.c", "", origin)).toBeNull();
  });
});
