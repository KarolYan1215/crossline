"use client";

import { useEffect, useState } from "react";
import type { ForecastResult } from "@crossline/planner";
import { forecastDiff } from "../../lib/forecast-diff";

const KEY = "crossline.forecast.lastViewed.v1";
export function ForecastDelta({ forecast }: { forecast: ForecastResult }) {
  const [changes, setChanges] = useState<string[]>([]);
  useEffect(() => {
    try {
      const previous = localStorage.getItem(KEY);
      if (previous) setChanges(forecastDiff(JSON.parse(previous) as ForecastResult, forecast));
      localStorage.setItem(KEY, JSON.stringify(forecast));
    } catch { /* Local comparison is optional; the authoritative forecast is still visible. */ }
  }, [forecast]);
  return changes.length > 0 && <div role="status" className="forecast-delta">
    <strong>与你上次查看的预测相比</strong>
    <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul>
  </div>;
}
