"use client";

import { useEffect, useState } from "react";
import { LAST_RESULT_KEY } from "../lib/flow";
import { useT } from "./locale-context";
import { readStored } from "./storage";

/** 「查看我的结果」 when this browser has taken the test before. */
export function LastResultLink({ label }: { label?: string }) {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => { setToken(readStored("local", LAST_RESULT_KEY)); }, []);
  return token ? <a className="as-button" href={`/r/${encodeURIComponent(token)}`}>{label ?? t("查看我的结果")}</a> : null;
}
