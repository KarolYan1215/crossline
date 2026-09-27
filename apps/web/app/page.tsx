import { DashboardView } from "./dashboard-view";
import { loadDashboard } from "../lib/crossline";
import { requireSessionContext } from "../lib/access-guard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ctx = await requireSessionContext();
  return <DashboardView data={await loadDashboard(ctx)} />;
}

