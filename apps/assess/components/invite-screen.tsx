"use client";

import { useEffect, useState } from "react";
import { api, type ClientErrorCode } from "../lib/api-client";
import type { InviteView } from "../lib/contract";
import { errorMessage } from "../lib/flow";
import { DISCLAIMER } from "./result-screen";
import { TestFlow } from "./test-flow";
import { TypeHeading, groupStyle } from "./type-summary";

/**
 * Someone's invitation: who invited, their figure and type, then the same test carrying the invitation, so the pair card is made the
 * moment it is done. The test is there at once (a reload mid-test resumes while the invitation loads); only a dead link replaces it.
 */
export function InviteScreen({ token }: { token: string }) {
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [failure, setFailure] = useState<ClientErrorCode | null>(null);
  useEffect(() => {
    let live = true;
    void api.getInvite(token).then((result) => { if (!live) return; if (result.ok) setInvite(result.data); else setFailure(result.code); });
    return () => { live = false; };
  }, [token]);

  if (failure === "NOT_FOUND" || failure === "INVITE_NOT_FOUND") return <main className="as-main"><section className="as-sheet">
    <h1>邀请链接已失效</h1>
    <p>链接可能已过期，或者对方已删除结果。你仍可以自己测一测。</p>
    <a className="as-button as-primary" href="/">自己测一测</a>
  </section></main>;

  const inviter = invite?.nickname || "你的朋友";
  return <main className="as-main" style={invite ? groupStyle(invite.type) : undefined}>
    <TestFlow inviteToken={token} startLabel="开始测">
      <p className="as-kicker">Crossline 速测</p>
      <h1>{invite ? `${inviter} 邀请你测测你们是什么关系` : "测测你们是什么关系"}</h1>
      {invite ? <div className="as-inviter">
        {/* eslint-disable-next-line @next/next/no-img-element -- the inviter's figure, a plain image */}
        <img className="as-figure" src={invite.avatar.url} alt={`${inviter}的形象`} width={160} height={160} />
        <TypeHeading type={invite.type} as="h2" />
      </div> : failure ? <p className="as-error" role="alert">{errorMessage(failure)}</p> : <p className="as-note" role="status">正在读取邀请…</p>}
      <p>32 道题，约 4–5 分钟。答完当场看到你们的双人卡。</p>
      <p className="as-note">{DISCLAIMER}</p>
    </TestFlow>
  </main>;
}
