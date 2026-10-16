"use client";

import { useEffect, useState } from "react";
import { forecastDiff, type ForecastSummary } from "../../lib/forecast-diff";
import { useT } from "../locale-context";

const KEY = "crossline.forecast.lastViewed.v1";
/** `storageKey` keeps one remembered forecast per horizon, so switching from four weeks to eight is not reported as a change. */
export function ForecastDelta({ forecast, storageKey = "" }: { forecast: ForecastSummary; storageKey?: string }) {
  const t = useT();
  const [changes, setChanges] = useState<string[]>([]);
  useEffect(() => {
    const key = storageKey ? `${KEY}.${storageKey}` : KEY;
    try {
      const previous = localStorage.getItem(key);
      if (previous) setChanges(forecastDiff(JSON.parse(previous) as ForecastSummary, forecast));
      localStorage.setItem(key, JSON.stringify(forecast));
    } catch { /* Local comparison is optional; the authoritative forecast is still visible. */ }
  }, [forecast, storageKey]);
  return changes.length > 0 && <div role="status" className="forecast-delta">
    <strong>{t("与上次查看时相比")}</strong>
    <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul>
  </div>;
}
