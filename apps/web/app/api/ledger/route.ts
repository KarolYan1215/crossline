import { resolveAccessContext } from "../../../lib/access-guard";
import { applyLedgerAction, loadLedger, type LedgerAction } from "../../../lib/ledger";
import { tOf } from "../../../lib/locale";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { withUndo } from "../../../lib/undo";

/** The ledger for `?month=YYYY-MM` (this month by default): docs/mail-bookkeeping.md §5.2. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, ledger: loadLedger(access.ctx, new URL(request.url).searchParams.get("month") ?? undefined) });
}

const str = (value: unknown, max = 120) => typeof value === "string" ? value.trim().slice(0, max) : "";

/** Changes from the ledger page: a category (and the merchant's rule), a merge, a split, a possible duplicate answered, a rule removed. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const action = str(body.action, 20);
  const input: LedgerAction | undefined = action === "category" ? { action, id: str(body.id), category: str(body.category, 20), everyFromMerchant: body.everyFromMerchant === true }
    : action === "merge" ? { action, keepId: str(body.keepId), dropId: str(body.dropId) }
    : action === "split" ? { action, evidenceId: str(body.evidenceId) }
    : action === "duplicate" ? { action, id: str(body.id), same: body.same === true }
    : action === "rule_delete" ? { action, merchantKey: str(body.merchantKey, 60) }
    : undefined;
  if (!input) return Response.json({ ok: false, code: "LEDGER_ACTION_UNKNOWN" }, { status: 400 });
  const t = tOf(access.ctx);
  const label = { category: t("改记录分类"), merge: t("合并两笔记录"), split: t("拆开一笔记录"), duplicate: t("确认可能重复的一笔"), rule_delete: t("删除商户分类规则") }[input.action];
  const result = await withUndo(access.ctx, label, () => applyLedgerAction(access.ctx, input));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
