import { setReplyDrafts } from "../../../../lib/mail-drafts";
import { writeGuard } from "../../agent/guard";

/** 「需要回复的邮件，先起草再提醒我」 on or off (`{ on: boolean }`, docs/personal-agent.md §3.1). Drafts already written stay. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  if (typeof guard.body.on !== "boolean") return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  setReplyDrafts(guard.ctx, guard.body.on);
  return Response.json({ ok: true, on: guard.body.on });
}
