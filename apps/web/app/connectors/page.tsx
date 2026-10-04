import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Connections live in the settings page now; an old link or bookmark lands there. */
export default function ConnectorsPage() {
  redirect("/settings#connections");
}
