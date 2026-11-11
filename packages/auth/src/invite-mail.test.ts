import { expect, test } from "vitest";
import { createInviteSender, inviteRequest, RESEND_EMAILS_URL, resendKeyOf } from "./index";

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Crossline//Calendar 1.0//ZH\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:x@crossline.lol\r\nDTSTAMP:20261110T080000Z\r\n"
  + "DTSTART:20261112T010000Z\r\nDTEND:20261112T013000Z\r\nSUMMARY:科研 · 组会\r\nSEQUENCE:1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

/** A fake network: every request is kept and answered with `status`; nothing leaves the test. */
function capture(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: "x" }), { status }); }) as unknown as typeof fetch;
  return { calls, fake };
}

test("an invitation goes to Resend's HTTP API with the .ics attached as text/calendar carrying its method (Outlook's meeting bar, 2026-11-11)", async () => {
  const { calls, fake } = capture();
  const send = createInviteSender({ from: "Crossline 日历 <calendar@mail.crossline.lol>", resendApiKey: "re_test", fetch: fake })!;
  await send({ to: "person@example.com", subject: "科研 · 组会", text: "Crossline 日历：科研 · 组会", method: "REQUEST", ics: ICS });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(RESEND_EMAILS_URL);
  expect(calls[0]!.init.method).toBe("POST");
  expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
  const body = JSON.parse(String(calls[0]!.init.body)) as ReturnType<typeof inviteRequest>;
  expect(body).toMatchObject({ from: "Crossline 日历 <calendar@mail.crossline.lol>", to: ["person@example.com"], subject: "科研 · 组会",
    text: "Crossline 日历：科研 · 组会", html: "<p>Crossline 日历：科研 · 组会</p>" });
  expect(body.attachments).toEqual([{ filename: "invite.ics", content: Buffer.from(ICS, "utf8").toString("base64"), content_type: "text/calendar; charset=UTF-8; method=REQUEST" }]);
  // The attached object decodes back to the exact calendar text.
  expect(Buffer.from(body.attachments[0]!.content, "base64").toString("utf8")).toBe(ICS);
});

test("a cancellation says method=CANCEL; a refused request throws so the path records its failure", async () => {
  const ok = capture();
  await createInviteSender({ from: "calendar@mail.crossline.lol", resendApiKey: "re_test", fetch: ok.fake })!(
    { to: "person@example.com", subject: "已取消", text: "removed", method: "CANCEL", ics: ICS.replace("METHOD:REQUEST", "METHOD:CANCEL") });
  const body = JSON.parse(String(ok.calls[0]!.init.body)) as ReturnType<typeof inviteRequest>;
  expect(body.attachments[0]).toMatchObject({ filename: "cancel.ics", content_type: "text/calendar; charset=UTF-8; method=CANCEL" });
  const refused = capture(422);
  await expect(createInviteSender({ from: "calendar@mail.crossline.lol", resendApiKey: "re_test", fetch: refused.fake })!(
    { to: "person@example.com", subject: "s", text: "t", method: "REQUEST", ics: ICS })).rejects.toThrow("RESEND_INVITE_FAILED:422");
});

test("only a Resend account sends invitations: never another SMTP relay, never without a key", () => {
  const smtp = { host: "smtp.resend.com", port: 465, user: "resend", password: "re_key", from: "x@mail.crossline.lol" };
  expect(resendKeyOf(smtp)).toBe("re_key");
  expect(resendKeyOf({ ...smtp, host: "smtp.gmail.com", user: "someone@gmail.com" })).toBeUndefined();
  expect(resendKeyOf({ ...smtp, user: "other" })).toBeUndefined();
  expect(resendKeyOf(undefined)).toBeUndefined();
  expect(createInviteSender({ from: "calendar@mail.crossline.lol" })).toBeUndefined();
});
