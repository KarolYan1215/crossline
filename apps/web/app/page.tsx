import { DashboardView } from "./dashboard-view";
import { loadDashboard } from "../lib/crossline";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return <DashboardView data={loadDashboard()} />;
}

