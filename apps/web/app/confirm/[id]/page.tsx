import { notFound } from "next/navigation";
import { SubpageShell } from "../../subpage-shell";
import { requireSessionContext } from "../../../lib/access-guard";
import { confirmView } from "../../../lib/confirm";
import { ConfirmForm } from "../confirm-form";
import "../confirm.css";

export const dynamic = "force-dynamic";

/** The page a completion check opens (docs/loop-and-scout.md §3): what the block was, and one or two taps to say what happened. */
export default async function ConfirmPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSessionContext();
  const { id } = await params;
  const view = confirmView(ctx, id);
  if (!view) notFound();
  return <SubpageShell active="今日" title="确认时间块">
    <ConfirmForm view={view} />
  </SubpageShell>;
}
