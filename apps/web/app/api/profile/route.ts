import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { getStore } from "../../../lib/crossline";
import { identityLines } from "../../../lib/lines";

/**
 * The person's own edits to their profile: confirm or correct a fact the interview inferred, reject one,
 * and add, rename or archive a project. A fact written here is `confirmed` with source `user` — the person
 * is the one source that needs no quote — and the store never lets a later guess overwrite it.
 */
const SLOT = /^[a-z][a-z0-9_]{1,39}$|^flywheel_[a-z]+_[a-z_]+$/;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* validated below */ }
  const store = getStore();
  const identities = new Set(identityLines(ctx).map((pack) => pack.id));
  const identityId = text(body.identityId, 80);
  const now = new Date().toISOString();
  const invalid = (code: string) => NextResponse.json({ ok: false, code }, { status: 400 });

  switch (body.action) {
    case "confirm_fact": {
      const projectId = text(body.projectId, 80), slot = text(body.slot, 80), value = text(body.value, 600);
      const current = store.listProfileFacts(ctx.workspaceId).find((fact) => fact.identityId === identityId && fact.projectId === projectId && fact.slot === slot);
      const next = value || current?.value;
      if (!identities.has(identityId) || !SLOT.test(slot) || !next) return invalid("PROFILE_FACT_INVALID");
      store.upsertProfileFact({ workspaceId: ctx.workspaceId, identityId, projectId, slot, value: next, status: "confirmed",
        sourceRef: "user", sourceQuote: "", updatedAt: now });
      return NextResponse.json({ ok: true });
    }
    case "remove_fact": {
      const removed = store.deleteProfileFact(ctx.workspaceId, identityId, text(body.projectId, 80), text(body.slot, 80));
      return NextResponse.json({ ok: removed });
    }
    case "save_project": {
      const name = text(body.name, 120);
      const id = text(body.id, 80) || `project-${randomUUID().slice(0, 8)}`;
      if (!identities.has(identityId) || !name || !ID.test(id)) return invalid("PROJECT_INVALID");
      const existing = store.listProjects(ctx.workspaceId, { includeArchived: true }).find((project) => project.id === id);
      store.saveProject({ id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, identityId: existing?.identityId ?? identityId, name,
        status: "active", summary: text(body.summary, 500) || existing?.summary || "", createdAt: existing?.createdAt ?? now, updatedAt: now });
      return NextResponse.json({ ok: true, id });
    }
    case "archive_project": {
      const id = text(body.id, 80);
      const existing = store.listProjects(ctx.workspaceId).find((project) => project.id === id);
      if (!existing) return invalid("PROJECT_NOT_FOUND");
      store.saveProject({ ...existing, status: "archived", updatedAt: now });
      return NextResponse.json({ ok: true });
    }
    default:
      return invalid("PROFILE_ACTION_UNKNOWN");
  }
}
