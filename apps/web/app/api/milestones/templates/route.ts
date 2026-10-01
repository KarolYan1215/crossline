import { NextResponse } from "next/server";
import { saveMilestoneTemplate, type MilestoneTemplateInput } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import type { SuccessCriterion } from "@crossline/core";

const MEASURE_KINDS = new Set(["count", "threshold", "artifact", "judgement"]);
const TEMPLATE_KINDS = new Set(["deliverable", "threshold", "validation", "recurring_cadence", "decision"]);

/** Same shape-check `/api/milestones` runs on `successCriteria` — duplicated rather than imported
 * because a Next.js route module may only export HTTP method handlers. */
function readCriteria(value: unknown): SuccessCriterion[] | undefined {
  if (!Array.isArray(value) || value.length > 10) return undefined;
  const criteria: SuccessCriterion[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    const measure = item.measure as Record<string, unknown> | undefined;
    if (typeof item.id !== "string" || typeof item.statement !== "string" || typeof item.required !== "boolean") return undefined;
    if (!measure || typeof measure.kind !== "string" || !MEASURE_KINDS.has(measure.kind)) return undefined;
    if (item.evidenceOf !== undefined && item.evidenceOf !== "output" && item.evidenceOf !== "outcome") return undefined;
    criteria.push({
      id: item.id, statement: item.statement, required: item.required,
      ...(item.evidenceOf ? { evidenceOf: item.evidenceOf as "output" | "outcome" } : {}),
      measure: measure as SuccessCriterion["measure"]
    });
  }
  return criteria;
}

/** A user — or, on their explicit request, the assistant widget — adding a new milestone template. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const input = (body ?? {}) as Record<string, unknown>;
  const criteria = readCriteria(input.successCriteriaDefaults ?? []);
  if (!criteria) return NextResponse.json({ ok: false, code: "INVALID_CRITERIA" }, { status: 400 });
  if (typeof input.identityId !== "string" || typeof input.titleHint !== "string" || typeof input.kind !== "string"
    || !TEMPLATE_KINDS.has(input.kind)) {
    return NextResponse.json({ ok: false, code: "INVALID_TEMPLATE" }, { status: 400 });
  }
  const payload: MilestoneTemplateInput = {
    identityId: input.identityId, kind: input.kind as MilestoneTemplateInput["kind"],
    titleHint: input.titleHint, successCriteriaDefaults: criteria
  };
  const result = saveMilestoneTemplate(access.ctx, payload);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
