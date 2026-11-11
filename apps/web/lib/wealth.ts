import "server-only";
import { randomUUID } from "node:crypto";
import {
  accountValues, baseCurrencyFor, converterFrom, holdingPrice, isAccountClass, isFxCurrency, netWorthOn, netWorthSeries, parseBudget, staleAccounts, wealthProblem, BROKERAGE_SYMBOL, ACCOUNT_CLASSES, FX_CURRENCIES, HOLDING_CLASSES, type AccessContext, type AccountClass, type AccountValue, type Budget, type Converter,
  type NetWorthPoint, type WealthAccount, type WealthHolding
} from "@crossline/core";
import { appNow, effectiveSchedulePreferences, getStore } from "./crossline";
import { localeFor } from "./locale";
import { personToday } from "./records";

/** Settings (all under `ledger.`, so an undo puts them back): the person's base currency and budget. */
export const BASE_CURRENCY_SETTING = "ledger.baseCurrency";
export const BUDGET_SETTING = "ledger.budget";
/** 「这个月不更新」 on the 更新余额 card, by month. */
export const BALANCE_SKIP_SETTING = "ledger.balances.skip:";

/** The currency totals are shown in: the person's choice, else the region they live in (docs/ledger-wealth.md §3). */
export function baseCurrency(ctx: AccessContext): { code: string; chosen: boolean } {
  const chosen = getStore().getSetting(ctx.workspaceId, BASE_CURRENCY_SETTING);
  if (chosen && isFxCurrency(chosen)) return { code: chosen, chosen: true };
  return { code: baseCurrencyFor(effectiveSchedulePreferences(ctx).preferences.timeZone, localeFor(ctx)), chosen: false };
}

export const budgetOf = (ctx: AccessContext): Budget => parseBudget(getStore().getSetting(ctx.workspaceId, BUDGET_SETTING));

/** Every cached FX rate, as one converter (the cache is small: one row per currency per working day). */
export const fxConverter = (): Converter => converterFrom(getStore().listMarketPrices({ kinds: ["fx"] }));

/** `priceStale`: the last quote is older than `QUOTE_MAX_AGE_DAYS`, so it is shown with its day and `value` is null. */
export type HoldingView = WealthHolding & { valuePrice: number | null; valueCurrency: string; priceOn: string; priceSource: string; priceStale: boolean; value: number | null };
export type WealthView = {
  today: string; base: string; baseChosen: boolean; currencies: string[]; classes: AccountClass[];
  /** The latest day an FX rate is cached for, "" with none (offline from the first start, or never fetched). */
  rateDay: string;
  now: NetWorthPoint; series: NetWorthPoint[];
  accounts: Array<AccountValue & { holdings: HoldingView[]; valued: boolean }>;
  /** Accounts the month's 更新余额 card lists. */
  stale: string[];
  budget: Budget;
};

/** The assets-and-liabilities half of the ledger page. */
export function loadWealth(ctx: AccessContext): WealthView {
  const store = getStore();
  const today = personToday(ctx);
  const { code: base, chosen } = baseCurrency(ctx);
  const accounts = store.listWealthAccounts(ctx.workspaceId);
  const snapshots = store.listWealthSnapshots(ctx.workspaceId);
  const holdings = store.listWealthHoldings(ctx.workspaceId);
  const prices = store.listMarketPrices({ kinds: ["quote", "crypto"] });
  const fx = fxConverter();
  const values = accountValues(accounts, snapshots, fx, base, today);
  return {
    today, base, baseChosen: chosen, currencies: [...FX_CURRENCIES], classes: [...ACCOUNT_CLASSES], rateDay: fx.latestDay,
    now: netWorthOn(accounts, snapshots, fx, base, today), series: netWorthSeries(accounts, snapshots, fx, base, today),
    accounts: values.map((item) => {
      const own = holdings.filter((holding) => holding.accountId === item.account.id);
      return { ...item, valued: HOLDING_CLASSES.includes(item.account.accountClass) && own.length > 0,
        holdings: own.map((holding) => {
          const price = holdingPrice(holding, item.account.accountClass, prices, today);
          const converted = price && !price.stale ? fx.convert(holding.quantity * price.price, price.currency || item.account.currency, item.account.currency, price.on || today) : null;
          return { ...holding, valuePrice: price?.price ?? null, valueCurrency: price?.currency ?? "", priceOn: price?.on ?? "", priceSource: price?.source ?? "", priceStale: price?.stale ?? false,
            value: converted ? Math.round(converted.value * 100) / 100 : null };
        }) };
    }),
    stale: staleAccounts(accounts, snapshots, holdings, today.slice(0, 7)).map((account) => account.id),
    budget: budgetOf(ctx)
  };
}

export type WealthAction =
  | { action: "account_add"; name: string; accountClass: string; currency: string; note: string }
  | { action: "account_edit"; id: string; name: string; note: string }
  | { action: "account_archive"; id: string; archived: boolean }
  | { action: "account_delete"; id: string }
  | { action: "snapshot"; accountId: string; on: string; value: number }
  | { action: "snapshot_delete"; id: string }
  | { action: "holding"; accountId: string; symbol: string; quantity: number; price: number }
  | { action: "holding_delete"; id: string }
  | { action: "base_currency"; currency: string }
  | { action: "budget"; monthly: number | null; categories: Record<string, number> };

type Result = { ok: true; id?: string } | { ok: false; code: string; message?: string };

/** What the page (and the 小帮手's card) changes; each runs inside the route's `withUndo`, whose snapshot covers the wealth rows. */
export function applyWealthAction(ctx: AccessContext, input: WealthAction, source: "person" | "assistant" = "person"): Result {
  const store = getStore();
  const ws = ctx.workspaceId;
  const now = appNow().toISOString();
  const account = (id: string) => store.listWealthAccounts(ws).find((item) => item.id === id);
  switch (input.action) {
    case "account_add": {
      const name = input.name.trim().slice(0, 60);
      if (!name) return { ok: false, code: "WEALTH_NAME_EMPTY" };
      if (!isAccountClass(input.accountClass)) return { ok: false, code: "WEALTH_CLASS_UNKNOWN" };
      const currency = input.currency.trim().toUpperCase() || baseCurrency(ctx).code;
      const problem = wealthProblem({ currency });
      if (problem) return { ok: false, code: "WEALTH_INVALID", message: problem };
      const id = `acct-${randomUUID().slice(0, 8)}`;
      store.saveWealthAccount(ws, { id, name, accountClass: input.accountClass, currency, note: input.note.trim().slice(0, 200), archivedAt: "", createdAt: now });
      return { ok: true, id };
    }
    case "account_edit": {
      const found = account(input.id);
      if (!found) return { ok: false, code: "WEALTH_ACCOUNT_NOT_FOUND" };
      const name = input.name.trim().slice(0, 60);
      if (!name) return { ok: false, code: "WEALTH_NAME_EMPTY" };
      store.saveWealthAccount(ws, { ...found, name, note: input.note.trim().slice(0, 200) });
      return { ok: true, id: found.id };
    }
    case "account_archive": {
      const found = account(input.id);
      if (!found) return { ok: false, code: "WEALTH_ACCOUNT_NOT_FOUND" };
      store.saveWealthAccount(ws, { ...found, archivedAt: input.archived ? now : "" });
      return { ok: true, id: found.id };
    }
    case "account_delete": return store.deleteWealthRow(ws, "wealth_accounts", input.id) ? { ok: true } : { ok: false, code: "WEALTH_ACCOUNT_NOT_FOUND" };
    case "snapshot": {
      const found = account(input.accountId);
      if (!found) return { ok: false, code: "WEALTH_ACCOUNT_NOT_FOUND" };
      const on = input.on || personToday(ctx);
      const problem = wealthProblem({ balance: input.value, at: on });
      if (problem) return { ok: false, code: "WEALTH_INVALID", message: problem };
      if (on > personToday(ctx)) return { ok: false, code: "WEALTH_DATE_FUTURE" };
      store.saveWealthSnapshot(ws, { id: `snap-${randomUUID().slice(0, 8)}`, accountId: found.id, on, value: Math.round(input.value * 100) / 100, source, createdAt: now });
      return { ok: true, id: found.id };
    }
    case "snapshot_delete": return store.deleteWealthRow(ws, "wealth_snapshots", input.id) ? { ok: true } : { ok: false, code: "WEALTH_SNAPSHOT_NOT_FOUND" };
    case "holding": {
      const found = account(input.accountId);
      if (!found) return { ok: false, code: "WEALTH_ACCOUNT_NOT_FOUND" };
      const symbol = input.symbol.trim().toUpperCase();
      const problem = wealthProblem({ accountClass: found.accountClass, symbol, quantity: input.quantity, price: input.price });
      if (problem || !symbol) return { ok: false, code: "WEALTH_INVALID", message: problem || "symbol" };
      const existing = store.listWealthHoldings(ws).find((item) => item.accountId === found.id && item.symbol === symbol);
      if (input.quantity === 0) return existing && store.deleteWealthRow(ws, "wealth_holdings", existing.id) ? { ok: true } : { ok: false, code: "WEALTH_HOLDING_NOT_FOUND" };
      // A typed price is the person's own (used until a newer quote); none keeps what was there.
      const price = input.price > 0 ? { price: input.price, priceCurrency: found.currency, priceOn: personToday(ctx) }
        : { price: existing?.price ?? 0, priceCurrency: existing?.priceCurrency ?? "", priceOn: existing?.priceOn ?? "" };
      store.saveWealthHolding(ws, { id: existing?.id ?? `hold-${randomUUID().slice(0, 8)}`, accountId: found.id, symbol, quantity: input.quantity, ...price, updatedAt: now });
      return { ok: true, id: found.id };
    }
    case "holding_delete": return store.deleteWealthRow(ws, "wealth_holdings", input.id) ? { ok: true } : { ok: false, code: "WEALTH_HOLDING_NOT_FOUND" };
    case "base_currency": {
      const code = input.currency.trim().toUpperCase();
      if (!isFxCurrency(code)) return { ok: false, code: "WEALTH_CURRENCY_UNSUPPORTED" };
      store.setSetting(ws, BASE_CURRENCY_SETTING, code);
      return { ok: true };
    }
    case "budget": {
      const categories = Object.fromEntries(Object.entries(input.categories).filter(([category, cap]) => category.trim() && Number.isFinite(cap) && cap > 0)
        .map(([category, cap]) => [category.trim().slice(0, 20), Math.round(cap * 100) / 100]));
      const monthly = input.monthly !== null && Number.isFinite(input.monthly) && input.monthly > 0 ? Math.round(input.monthly * 100) / 100 : null;
      store.setSetting(ws, BUDGET_SETTING, JSON.stringify({ monthly, categories }));
      return { ok: true };
    }
  }
}

/**
 * The 小帮手's 「更新资产」 card (`wealth.update`): a balance, or a position when a symbol is given, on the account of that name — created
 * with the class and currency the card showed when there is none yet. Confirmed by the person on the card; undone like any other change.
 */
export function wealthFromAssistant(ctx: AccessContext, args: { account: string; accountClass: string; currency: string; balance: number; symbol: string; quantity: number; at: string }): Result & { created?: boolean } {
  const store = getStore();
  const name = args.account.trim();
  if (!name) return { ok: false, code: "WEALTH_NAME_EMPTY" };
  const key = name.toLowerCase();
  let found: WealthAccount | undefined = store.listWealthAccounts(ctx.workspaceId).find((item) => !item.archivedAt && item.name.toLowerCase() === key);
  let created = false;
  if (!found) {
    const symbol = args.symbol.trim().toUpperCase();
    const accountClass = args.accountClass || (!symbol ? "cash" : BROKERAGE_SYMBOL.test(symbol) ? "brokerage" : "crypto");
    const added = applyWealthAction(ctx, { action: "account_add", name, accountClass, currency: args.currency, note: "" }, "assistant");
    if (!added.ok) return added;
    found = store.listWealthAccounts(ctx.workspaceId).find((item) => item.id === added.id)!;
    created = true;
  }
  const result = args.symbol.trim()
    ? applyWealthAction(ctx, { action: "holding", accountId: found.id, symbol: args.symbol, quantity: args.quantity, price: 0 }, "assistant")
    : applyWealthAction(ctx, { action: "snapshot", accountId: found.id, on: args.at, value: args.balance }, "assistant");
  return result.ok ? { ...result, created } : result;
}

/** Every wealth row, keyed `table:id`, for the undo snapshot. */
export function wealthRows(workspaceId: string): Map<string, string> {
  const store = getStore();
  return new Map<string, string>([
    ...store.listWealthAccounts(workspaceId).map((row) => [`wealth_accounts:${row.id}`, JSON.stringify(row)] as const),
    ...store.listWealthSnapshots(workspaceId).map((row) => [`wealth_snapshots:${row.id}`, JSON.stringify(row)] as const),
    ...store.listWealthHoldings(workspaceId).map((row) => [`wealth_holdings:${row.id}`, JSON.stringify(row)] as const)
  ]);
}

export type WealthRowEntry = { key: string; row: string | null };
/** Puts rows back as they were (null: the row did not exist, so it goes). Accounts first, so their balances have one to belong to. */
export function restoreWealthRows(workspaceId: string, entries: WealthRowEntry[]): void {
  const store = getStore();
  const order = (key: string) => key.startsWith("wealth_accounts:") ? 0 : 1;
  for (const entry of [...entries].sort((a, b) => order(a.key) - order(b.key))) {
    const [table, id] = [entry.key.slice(0, entry.key.indexOf(":")), entry.key.slice(entry.key.indexOf(":") + 1)] as ["wealth_accounts" | "wealth_snapshots" | "wealth_holdings", string];
    // A row the operation added goes (an account added with it takes its balances along, which are also in the list).
    if (entry.row === null) { store.deleteWealthRow(workspaceId, table, id); continue; }
    const row = JSON.parse(entry.row);
    if (table === "wealth_accounts") store.saveWealthAccount(workspaceId, row);
    else if (table === "wealth_snapshots") { store.deleteWealthRow(workspaceId, table, id); store.saveWealthSnapshot(workspaceId, row); }
    else { store.deleteWealthRow(workspaceId, table, id); store.saveWealthHolding(workspaceId, row); }
  }
}
