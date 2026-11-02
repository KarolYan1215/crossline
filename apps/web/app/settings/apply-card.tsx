"use client";

import { useState } from "react";
import { SLOT_LABEL, STOP_LABEL, type ApplicationSlot, type FormRunState, type FormStop } from "@crossline/core";
import { useT } from "../locale-context";

export type ApplyItem = { slot: ApplicationSlot; sensitive: boolean; present: boolean; value?: string; usedBy: Array<{ title: string; at: string }> };
export type ApplyRun = {
  id: string; title: string; host: string; state: FormRunState; pageNo: number; stoppedFor?: FormStop; stopDetail?: string; missingSlot?: ApplicationSlot;
  heldBecause: string[]; checklist: Array<{ field: string; shown: string }>; problems: string[]; injections: number; refused: number;
  shots: number; confirmation?: string; submittedBy?: "system" | "person"; calendar: boolean; updatedAt: string;
};

const STATE_LABEL: Record<FormRunState, string> = { queued: "排队中", filling: "正在填写", waiting_person: "等本人处理", ready_to_submit: "等本人提交",
  submitted: "已提交，等确认", confirmed: "已确认", stopped: "已停止" };

/**
 * 报名资料卡 (docs/opportunity-agent.md §12–§13): each item the form filler may use, where it came from, which registrations used it,
 * edited and deleted here; a sensitive item is shown only as held, never its value. Below it, every registration being filled or filled,
 * with why it stopped, what is about to be submitted and the screenshots.
 */
export function ApplyCard({ items, runs, screen }: { items: ApplyItem[]; runs: ApplyRun[]; screen: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState<ApplicationSlot | undefined>();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const post = async (url: string, method: "POST" | "DELETE", body?: unknown) => {
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => undefined);
    if (!response?.ok) {
      const code = await response?.json().then((json: { code?: string }) => json.code ?? "").catch(() => "") ?? "";
      setNote(code === "FORM_NEEDS_SCREEN" ? t("这台服务器没有屏幕，代填要在本人电脑上运行") : code.startsWith("PROFILE_") ? t("格式不对，没有保存") : t("没有完成，请重试"));
      return false;
    }
    setNote("");
    window.location.reload();
    return true;
  };
  const save = async (slot: ApplicationSlot) => { if (await post(`/api/apply-profile/${slot}`, "POST", { value: draft })) { setEditing(undefined); setDraft(""); } };

  return <section className="st-card" aria-label={t("报名资料卡")}>
    <header><h3>{t("报名资料卡")}</h3><small>{t("代填报名表时只用这里的内容；敏感项只存在本机密钥库，不进账本、导出和备份")}</small></header>
    {items.map((item) => <div className="st-row" key={item.slot}>
      <span className="st-row-label">{t(SLOT_LABEL[item.slot])}{item.sensitive && <> · {t("敏感")}</>}
        <small>{!item.present ? t("未填") : item.sensitive ? t("已保存在本机") : item.value}
          {item.usedBy.length > 0 && <> · {t("用于 {{count}} 次报名：{{titles}}", { count: item.usedBy.length, titles: item.usedBy.slice(0, 3).map((use) => use.title).join("、") })}</>}</small></span>
      {editing === item.slot
        ? <span className="st-inline-form">
            <input aria-label={t(SLOT_LABEL[item.slot])} type={item.sensitive ? "password" : "text"} autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <button type="button" className="secondary-button" onClick={() => void save(item.slot)}>{t("保存")}</button>
            <button type="button" className="text-button" onClick={() => { setEditing(undefined); setDraft(""); }}>{t("取消")}</button>
          </span>
        : <span className="st-inline-form">
            <button type="button" className="secondary-button" onClick={() => { setEditing(item.slot); setDraft(item.sensitive ? "" : item.value ?? ""); }}>{item.present ? t("修改") : t("填写")}</button>
            {item.present && <button type="button" className="text-button" onClick={() => void post(`/api/apply-profile/${item.slot}`, "DELETE")}>{t("删除")}</button>}
          </span>}
    </div>)}

    <h4>{t("代填的报名")}</h4>
    {!screen && <p className="muted">{t("这台服务器没有屏幕，代填要在本人电脑上运行")}</p>}
    {runs.length === 0 ? <p className="muted">{t("还没有报名。在机会卡上点「报名」后会出现在这里。")}</p> : runs.map((run) => <article key={run.id} className="st-run">
      <p className="st-run-head"><b>{run.title}</b> · {t(STATE_LABEL[run.state])}
        {run.state === "waiting_person" && run.stoppedFor && <> · {run.stoppedFor === "missing_slot" && run.missingSlot ? t("缺「{{slot}}」", { slot: t(SLOT_LABEL[run.missingSlot]) }) : t(STOP_LABEL[run.stoppedFor])}</>}</p>
      <p className="muted">{run.host} · {t("第 {{page}} 页", { page: run.pageNo })}{run.stopDetail ? ` · ${run.stopDetail}` : ""}
        {run.injections > 0 && <> · {t("页面里有 {{count}} 处试图指挥代填的文字，已忽略", { count: run.injections })}</>}
        {run.refused > 0 && <> · {t("规则拦下 {{count}} 个动作", { count: run.refused })}</>}</p>
      {run.heldBecause.length > 0 && <p>{t("没有自动提交，因为：{{why}}", { why: run.heldBecause.map((item) => t(item)).join("；") })}</p>}
      {run.problems.length > 0 && <p>{t("提交前总核提出：{{problems}}", { problems: run.problems.join("；") })}</p>}
      {run.checklist.length > 0 && <ul className="st-checklist">{run.checklist.map((item, index) => <li key={index}>{item.field}：{item.shown}</li>)}</ul>}
      {run.confirmation && <p>{t("确认：{{quote}}", { quote: run.confirmation })}{run.calendar ? ` · ${t("已写入日历")}` : ""}</p>}
      {run.shots > 0 && <p><a href={`/api/forms/${run.id}/shot?n=-1`} target="_blank" rel="noreferrer">{t("最近一张截图")}</a></p>}
      <div className="st-inline-form">
        {(run.state === "waiting_person" || run.state === "ready_to_submit") && <>
          <button type="button" className="secondary-button" onClick={() => void post(`/api/forms/${run.id}/front`, "POST")}>{t("显示窗口")}</button>
          {run.state === "waiting_person" && <button type="button" className="secondary-button" onClick={() => void post(`/api/forms/${run.id}/continue`, "POST")}>{t("继续")}</button>}
          <button type="button" className="secondary-button" onClick={() => void post(`/api/forms/${run.id}/submitted`, "POST")}>{t("本人已提交")}</button>
        </>}
        {run.state === "submitted" && <button type="button" className="secondary-button" onClick={() => void post(`/api/forms/${run.id}/confirm`, "POST")}>{t("已收到确认")}</button>}
        {run.state !== "confirmed" && run.state !== "stopped" && <button type="button" className="text-button" onClick={() => void post(`/api/forms/${run.id}/stop`, "POST")}>{t("停止")}</button>}
      </div>
    </article>)}
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}
