"use client";
import { useEffect } from "react";
import { useT } from "../locale-context";

export const OUTPUTS_PAGE = "/outputs?source=file";

/**
 * Where 「助手产出」 was (2026-10-19 to 2026-11-10): the folder moved to 「Agent 产出」. A fragment never reaches the server, so the old
 * address `/settings#outputs` — and this module's own index entry — is sent on from here, in the page.
 */
export function OutputsMoved() {
  const t = useT();
  useEffect(() => {
    const follow = () => { if (location.hash === "#outputs") location.replace(OUTPUTS_PAGE); };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return <section className="st-card" aria-label={t("助手产出")}>
    <header><h3>{t("助手产出")}</h3><small>{t("助手交出的文件、工作流报告和任务结果都在「Agent 产出」，可按来源和主线筛选。")}</small></header>
    <p><a className="secondary-button" href={OUTPUTS_PAGE}>{t("打开 Agent 产出")}</a></p>
  </section>;
}
