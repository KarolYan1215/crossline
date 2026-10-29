import { expect, test } from "vitest";
import { isLinkNeed, linksFromMail } from "./mail-links";

test("only https links on the sender's own domain are kept, without tracking, at most three (W-158)", () => {
  const body = "Please verify your identity: https://www.glaciertax.com/verify?token=abc123&utm_source=mail.\n"
    + "Help: https://support.glaciertax.com/faq ; elsewhere https://evil.example/login and http://www.glaciertax.com/old\n"
    + "Again https://www.glaciertax.com/verify?token=abc123";
  expect(linksFromMail(body, "noreply@glaciertax.com")).toEqual(["https://www.glaciertax.com/verify?token=abc123", "https://support.glaciertax.com/faq"]);
  expect(linksFromMail(body, "")).toEqual([]);
  expect(linksFromMail("https://a.x.com/1 https://b.x.com/2 https://c.x.com/3 https://d.x.com/4", "n@x.com")).toHaveLength(3);
  expect(linksFromMail("https://user:pw@x.com/a https://x.com:8443/b", "n@x.com")).toEqual([]);
});

test("a need is for a link when it says so", () => {
  expect(isLinkNeed({ what: "GLACIER 身份验证链接" })).toBe(true);
  expect(isLinkNeed({ what: "the registration URL" })).toBe(true);
  expect(isLinkNeed({ what: "月末持仓 CSV" })).toBe(false);
});
