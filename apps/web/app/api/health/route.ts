export const dynamic = "force-dynamic";

// A pure liveness probe — the worker polls this to know the web process is up, and the offline e2e
// test only checks whether it is reachable at all. It used to also report a specific workspace's work
// order count, which made it silently a single-workspace-only endpoint; a liveness check should not
// require knowing (or being logged in as) anyone in particular.
export function GET() {
  return Response.json({ status: "ok", checkedAt: new Date().toISOString() });
}
