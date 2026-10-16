import "server-only";
import { portraitType, taskTitleOf, type AccessContext, type Ask, type PortraitReport } from "@crossline/core";
import { getStore } from "../../lib/crossline";
import { stateLabelFor } from "../../lib/labels";
import { tOf } from "../../lib/locale";
import type { AskPreviewData, AskPreviews } from "./types";

const param = (href: string, name: string) => {
  try { return new URL(href, "http://x").searchParams.get(name) ?? undefined; } catch { return undefined; }
};
const segmentAfter = (href: string, prefix: string) => {
  const match = new RegExp(`^${prefix}([^/?#]+)`).exec(href);
  return match ? decodeURIComponent(match[1]!) : undefined;
};

/**
 * The summary each card with a `preview` opens in place: the portrait's type and figure, the milestone drafts it is about, a task's steps,
 * the opening of a file. Read once per page load; a preview whose thing cannot be found is left out and the card keeps only its link.
 */
export function loadAskPreviews(ctx: AccessContext, asks: Ask[]): AskPreviews {
  const store = getStore();
  const previews: AskPreviews = {};
  let portrait: AskPreviewData | null | undefined;
  for (const ask of asks) {
    const preview = ask.preview;
    if (!preview) continue;
    try {
      if (preview.kind === "portrait") {
        portrait ??= portraitPreview(ctx);
        if (portrait) previews[ask.id] = portrait;
      } else if (preview.kind === "milestones") {
        const open = param(preview.href, "open");
        const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
        const items = store.listMilestones(ctx.workspaceId).filter((item) => item.status !== "archived")
          .filter((item) => open ? item.id === open : item.status === "draft" && (!ask.line || item.identityId === ask.line))
          .sort((a, b) => (anchors.get(a.id) ?? "9999").localeCompare(anchors.get(b.id) ?? "9999")).slice(0, 6)
          .map((item) => ({ title: item.title, status: item.status, line: item.identityId, ...(anchors.get(item.id) ? { deadline: anchors.get(item.id)! } : {}) }));
        if (items.length) previews[ask.id] = { kind: "milestones", items };
      } else if (preview.kind === "task") {
        const id = segmentAfter(preview.href, "/workbench/") ?? ask.entityId;
        const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === id);
        if (order) {
          const due = (order.payload as { dueDate?: string } | undefined)?.dueDate;
          const steps = store.getStepPlan(ctx.workspaceId, order.id)?.steps ?? [];
          previews[ask.id] = { kind: "task", title: taskTitleOf(order), state: tOf(ctx)(stateLabelFor(order.state, false)), ...(due ? { due } : {}),
            steps: steps.slice(0, 8).map((step) => ({ title: step.title, done: step.status === "done" })) };
        }
      } else if (preview.kind === "file") {
        const id = segmentAfter(preview.href, "/api/source-documents/") ?? ask.entityId;
        const doc = store.listSourceDocuments(ctx.workspaceId).find((item) => item.id === id);
        if (doc) previews[ask.id] = { kind: "file", fileName: doc.fileName, excerpt: doc.extractedText.replace(/\s+/g, " ").trim().slice(0, 280) };
      }
    } catch { /* a preview that cannot be read leaves the card with its link */ }
  }
  return previews;
}

function portraitPreview(ctx: AccessContext): AskPreviewData | null {
  const store = getStore();
  let saved: { version?: number; report?: PortraitReport } = {};
  try { saved = JSON.parse(store.getSetting(ctx.workspaceId, "portrait.report") ?? "{}"); } catch { /* none */ }
  const report = saved.report;
  if (!report) return null;
  let drawn: { version?: number; images?: Record<string, { at?: string }> } = {};
  try { drawn = JSON.parse(store.getSetting(ctx.workspaceId, "portrait.images") ?? "{}"); } catch { /* none */ }
  const figure = drawn.version === saved.version ? drawn.images?.character : undefined;
  const type = portraitType(report);
  return {
    kind: "portrait",
    ...(figure ? { image: `/api/portrait/image/character?v=${encodeURIComponent(figure.at ?? String(saved.version ?? ""))}` } : {}),
    ...(type ? { code: type.code, name: type.name } : {}),
    ...(report.cover.tagline ? { tagline: report.cover.tagline } : {}),
    ...(report.cover.portrait ? { summary: report.cover.portrait.slice(0, 220) } : {}),
    keywords: (report.cover.keywords ?? []).slice(0, 5)
  };
}
