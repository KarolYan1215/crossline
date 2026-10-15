"use client";

import { useEffect, useState } from "react";
import { LAST_RESULT_KEY } from "../lib/flow";
import { readStored } from "./storage";

/** 「查看我的结果」 when this browser has taken the test before. */
export function LastResultLink({ label = "查看我的结果" }: { label?: string }) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => { setToken(readStored("local", LAST_RESULT_KEY)); }, []);
  return token ? <a className="as-button" href={`/r/${encodeURIComponent(token)}`}>{label}</a> : null;
}
