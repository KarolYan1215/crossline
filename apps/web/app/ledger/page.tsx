import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { loadLedger } from "../../lib/ledger";
import { tOf } from "../../lib/locale";
import { SubpageShell } from "../subpage-shell";
import { LedgerBoard } from "./ledger-board";
import "./ledger.css";

export const dynamic = "force-dynamic";

/** The ledger (docs/mail-bookkeeping.md §5.2): every booked money record of a month, drawn, with the recurring charges and the list. */
export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const { month } = await searchParams;
  const t = tOf(ctx);
  return <SubpageShell active={"主线"} title={t("总账")} serif description={t("邮件、手机和输入框记下的每一笔，去重后汇成一本账；数字都由记录算出。")}>
    <LedgerBoard view={loadLedger(ctx, month)} />
  </SubpageShell>;
}
