"use client";

import type { Fact, Identity } from "./onboarding-types";
import { LineNetwork, type NetworkEdge } from "../ui/line-network";

/** `flywheel_<to>_<kind>` facts, keyed on the line they come from. */
export type Link = { from: string; to: string; kind: string; explanation: string; status: Fact["status"]; slot: string };

export function linksFrom(facts: Fact[]): Link[] {
  return facts.filter((fact) => fact.slot.startsWith("flywheel_")).flatMap((fact) => {
    const [, to, ...kind] = fact.slot.split("_");
    return to && kind.length ? [{ from: fact.identityId, to, kind: kind.join("_"), explanation: fact.value, status: fact.status, slot: fact.slot }] : [];
  });
}

/**
 * The interview's proposed connections between lines as one network: every guess is drawn (dashed) until the person says it does not
 * hold, which removes it; one they confirm turns solid. What is left is their flywheel.
 */
export function FlywheelPreview({ identities, lines, facts, onConfirm, onRemove }: {
  identities: Identity[]; lines?: Array<{ id: string; rank: number | null; hard: boolean }>; facts: Fact[];
  onConfirm: (link: Link) => void; onRemove: (link: Link) => void;
}) {
  const links = linksFrom(facts);
  const byId = new Map(links.map((link) => [`${link.from}:${link.slot}`, link]));
  const edges: NetworkEdge[] = links.map((link) => ({ id: `${link.from}:${link.slot}`, from: link.from, to: link.to, kind: link.kind,
    explanation: link.explanation, status: link.status === "confirmed" ? "confirmed" : "candidate" }));
  const rankOf = new Map((lines ?? []).map((line) => [line.id, line]));
  return <div className="ob-block">
    <LineNetwork lines={identities.map((identity) => ({ ...identity, rank: rankOf.get(identity.id)?.rank ?? null, hard: rankOf.get(identity.id)?.hard ?? false }))}
      edges={edges} onConfirm={(edge) => onConfirm(byId.get(edge.id)!)} onReject={(edge) => onRemove(byId.get(edge.id)!)} />
  </div>;
}
