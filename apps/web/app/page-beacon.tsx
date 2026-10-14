"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/** On an installed copy, tells the server which page was opened; the server keeps only the route template (`lib/telemetry.ts`). */
export function PageBeacon() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname || pathname === "/login" || pathname === "/offline") return;
    void fetch("/api/telemetry/page", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: pathname }),
      keepalive: true }).catch(() => undefined);
  }, [pathname]);
  return null;
}
