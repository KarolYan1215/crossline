"use client";

import { useEffect, useState } from "react";
import { InvitePanel } from "../connect/invite-panel";

type Quota = { verdict: "ok" | "tight" | "insufficient" | "spent"; message: string; plan?: string; roundsLeft?: number; remainingRounds: number };

/**
 * Whether the ChatGPT quota will carry the interview (lib/interview-quota.ts), asked again after every round and after a round that
 * stopped on a spent quota. Silent while it will; otherwise it says so in numbers and offers the way on — Plus, or an invite code.
 */
export function QuotaNotice({ rounds, usageLimitHit }: { rounds: number; usageLimitHit: boolean }) {
  const [quota, setQuota] = useState<Quota>();
  useEffect(() => {
    void fetch(`/api/onboarding/quota${usageLimitHit ? "?limit=1" : ""}`, { cache: "no-store" })
      .then((response) => response.json()).then((body: Quota) => setQuota(body)).catch(() => undefined);
  }, [rounds, usageLimitHit]);
  if (!quota || quota.verdict === "ok" || !quota.message) return null;
  return <div className="ob-quota" data-verdict={quota.verdict} role={quota.verdict === "spent" ? "alert" : "status"}>
    <p>{quota.message}</p>
    <InvitePanel plan={quota.plan} onRedeemed={() => location.reload()} />
  </div>;
}
