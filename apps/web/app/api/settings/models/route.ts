import { NextResponse } from "next/server";
import { MODEL_CHOICE_SETTING, isModelChoiceSlot, modelChoiceProblem, modelChoicesOf, withModelChoice } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore } from "../../../../lib/crossline";
import { requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** One model as the picker shows it: the catalogue's id and name, and the efforts it takes. */
export type PickerModel = { model: string; displayName?: string; efforts: string[]; defaultEffort: string; isDefault: boolean };
export type ModelsAnswer = { choices: ReturnType<typeof modelChoicesOf>; models: PickerModel[]; provider: boolean; unavailable?: string };

/**
 * The person's own model and effort per slot (D19): GET gives the stored choices and the models the account's own Codex offers
 * (`model/list` through the worker, hidden ones left out); POST sets or clears one slot. The worker reads the choice per run.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const choices = modelChoicesOf(getStore().getSetting(access.ctx.workspaceId, MODEL_CHOICE_SETTING));
  try {
    const answer = await requestCodexSupervisor<{ models?: Array<PickerModel & { hidden?: boolean }>; provider?: boolean }>(access.ctx, "/v1/codex/models",
      { signal: AbortSignal.timeout(4_000) });
    const models = (answer.models ?? []).filter((model) => !model.hidden).map(({ model, displayName, efforts, defaultEffort, isDefault }) =>
      ({ model, ...(displayName ? { displayName } : {}), efforts, defaultEffort, isDefault }));
    return NextResponse.json({ choices, models, provider: answer.provider === true } satisfies ModelsAnswer);
  } catch (error) {
    return NextResponse.json({ choices, models: [], provider: false, unavailable: error instanceof Error ? error.message.slice(0, 120) : "worker unreachable" } satisfies ModelsAnswer);
  }
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { slot?: unknown; model?: unknown; effort?: unknown } | null;
  const slot = typeof body?.slot === "string" ? body.slot : "";
  if (!isModelChoiceSlot(slot)) return NextResponse.json({ ok: false, code: "INVALID_MODEL_SLOT" }, { status: 400 });
  // `model: null` (or empty) clears the slot: back to the route table.
  const clear = body?.model === null || body?.model === "";
  const effort = typeof body?.effort === "string" && body.effort ? body.effort : undefined;
  if (!clear) {
    const problem = modelChoiceProblem({ model: body?.model, ...(effort ? { effort } : {}) });
    if (problem) return NextResponse.json({ ok: false, code: problem }, { status: 400 });
  }
  const store = getStore();
  const next = withModelChoice(modelChoicesOf(store.getSetting(access.ctx.workspaceId, MODEL_CHOICE_SETTING)), slot,
    clear ? null : { model: body!.model as string, ...(effort ? { effort } : {}) });
  store.setSetting(access.ctx.workspaceId, MODEL_CHOICE_SETTING, JSON.stringify(next));
  return NextResponse.json({ ok: true, choices: next });
}
