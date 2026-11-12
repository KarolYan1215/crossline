import { resolveAccessContext } from "../../../lib/access-guard";
import { tOf } from "../../../lib/locale";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { withUndo } from "../../../lib/undo";
import { applyWealthAction, loadWealth, type WealthAction } from "../../../lib/wealth";

/** Assets, liabilities, net worth and the budget (docs/ledger-wealth.md). */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, wealth: loadWealth(access.ctx) });
}

const str = (value: unknown, max = 120) => typeof value === "string" ? value.trim().slice(0, max) : "";
const num = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;

/** One change from the page, each undoable. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const action = str(body.action, 20);
  const input: WealthAction | undefined =
    action === "account_add" ? { action, name: str(body.name, 60), accountClass: str(body.accountClass, 20), currency: str(body.currency, 3), note: str(body.note, 200) }
    : action === "account_edit" ? { action, id: str(body.id), name: str(body.name, 60), note: str(body.note, 200) }
    : action === "account_archive" ? { action, id: str(body.id), archived: body.archived === true }
    : action === "account_delete" ? { action, id: str(body.id) }
    : action === "snapshot" ? { action, accountId: str(body.accountId), on: str(body.on, 10), value: num(body.value) }
    : action === "snapshot_delete" ? { action, id: str(body.id) }
    : action === "holding" ? { action, accountId: str(body.accountId), symbol: str(body.symbol, 20), quantity: num(body.quantity), price: Number.isFinite(num(body.price)) ? num(body.price) : 0 }
    : action === "holding_delete" ? { action, id: str(body.id) }
    : action === "base_currency" ? { action, currency: str(body.currency, 3) }
    : action === "spending_only" ? { action, on: body.on === true }
    : action === "budget" ? { action, monthly: Number.isFinite(num(body.monthly)) ? num(body.monthly) : null, ...(str(body.currency, 3) ? { currency: str(body.currency, 3) } : {}),
      categories: Object.fromEntries(Object.entries(body.categories && typeof body.categories === "object" ? body.categories as Record<string, unknown> : {}).map(([key, value]) => [key, num(value)])) }
    : undefined;
  if (!input) return Response.json({ ok: false, code: "WEALTH_ACTION_UNKNOWN" }, { status: 400 });
  const t = tOf(access.ctx);
  const label = {
    account_add: t("新增账户"), account_edit: t("修改账户"), account_archive: t("归档账户"), account_delete: t("删除账户"), snapshot: t("记一次余额"),
    snapshot_delete: t("删除一次余额"), holding: t("修改持仓"), holding_delete: t("删除持仓"), base_currency: t("修改本位币"), budget: t("修改预算"), spending_only: t("切换「只记开销」")
  }[input.action];
  const result = await withUndo(access.ctx, label, () => applyWealthAction(access.ctx, input));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
