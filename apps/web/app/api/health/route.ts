import { getStore, WORKSPACE_ID } from "../../../lib/crossline";

export const dynamic = "force-dynamic";

export function GET() {
  const store = getStore();
  return Response.json({
    status: "ok",
    workspaceId: WORKSPACE_ID,
    workOrderCount: store.listWorkOrders(WORKSPACE_ID).length,
    checkedAt: new Date().toISOString()
  });
}
