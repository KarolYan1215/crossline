import { NextResponse } from "next/server";
import { saveMilestoneEdit, type MilestoneInput } from "../../../lib/crossline";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import type { SuccessCriterion } from "@crossline/core";

const MEASURE_KINDS = new Set(["count", "threshold", "artifact", "judgement"]);

/** Shape-checks what the browser sent before it reaches the store's own criterion rules. */
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

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const input = (body ?? {}) as Record<string, unknown>;
  const criteria = readCriteria(input.successCriteria ?? []);
  if (!criteria) return NextResponse.json({ ok: false, code: "INVALID_CRITERIA" }, { status: 400 });
  if (typeof input.identityId !== "string" || typeof input.title !== "string") {
    return NextResponse.json({ ok: false, code: "INVALID_MILESTONE" }, { status: 400 });
  }
  const status = input.status === "draft" || input.status === "approved" || input.status === "archived"
    ? input.status : undefined;
  if (!status) return NextResponse.json({ ok: false, code: "INVALID_STATUS" }, { status: 400 });

  const payload: MilestoneInput = {
    ...(typeof input.id === "string" ? { id: input.id } : {}),
    identityId: input.identityId,
    projectId: typeof input.projectId === "string" ? input.projectId : "",
    title: input.title,
    status,
    successCriteria: criteria
  };
  const result = saveMilestoneEdit(payload);
  if (!result.ok) return NextResponse.json(result, { status: result.code === "MILESTONE_NOT_FOUND" ? 404 : 400 });
  return NextResponse.json(result);
}
