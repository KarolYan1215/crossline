"use client";

import { useState } from "react";

/** One record as the card lists it (docs/domain-lines.md). */
export type RecordRow = { id: string; kind: string; at: string; value: number; unit: string; currency: string; category: string; source: string };
/** What a domain line's card shows: this month's money or this week's exercise and the latest weight, and the last records. */
export type DomainRecordsCard = {
  domain: "wellness" | "wealth";
  month: string; currency: string; income: number; expense: number; savingsRate: number | null;
  categories: Array<{ category: string; amount: number }>;
  workouts: number; workoutMinutes: number; weight: { value: number; at: string } | null;
  recent: RecordRow[];
};

const SOURCE: Record<string, string> = { input: "输入框", mail: "邮件", phone: "手机", confirm: "完成确认", photo: "截图" };
const KIND: Record<string, string> = { income: "收入", expense: "支出", workout: "运动", weight: "体重", meal: "饮食", metric: "指标" };
const money = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

/**
 * The numbers on a 健康 / 财富 line card, read from its records (never a model's estimate): a wealth line's month — income, spending,
 * the savings rate and the three largest spending categories as bars — or a wellness line's week and latest weight. 「最近记录」 opens the
 * last thirty with where each came from; a wrong one is removed (undoable from 待确认 「最近操作」).
 */
export function DomainRecords({ card }: { card: DomainRecordsCard }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const remove = async (id: string) => {
    setStatus("删除中…");
    const response = await fetch(`/api/records?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) { setStatus("未删除，请重试"); return; }
    location.reload();
  };
  const largest = Math.max(1, ...card.categories.map((item) => item.amount));
  return <div className="lb-records">
    {card.domain === "wealth" ? <>
      <p className="lb-records-line"><span>{card.month.slice(5).replace(/^0/, "")} 月</span>
        <span>收入 {money(card.income)}</span><span>支出 {money(card.expense)}</span>
        <span>{card.savingsRate === null ? "储蓄率 —" : `储蓄率 ${card.savingsRate}%`}</span>
        {card.currency !== "CNY" && <span className="mono">{card.currency}</span>}</p>
      {card.categories.length > 0 && <ul className="lb-records-bars" aria-label="本月支出最多的类别">
        {card.categories.slice(0, 3).map((item) => <li key={item.category}>
          <span>{item.category}</span><span className="lb-records-bar" style={{ width: `${Math.round(item.amount / largest * 100)}%` }} aria-hidden="true" />
          <span className="mono">{money(item.amount)}</span></li>)}
      </ul>}
    </> : <p className="lb-records-line"><span>近 7 天运动 {card.workouts} 次 · {card.workoutMinutes} 分钟</span>
      <span>{card.weight ? `体重 ${card.weight.value} kg（${card.weight.at.slice(5)}）` : "体重 —"}</span></p>}
    {card.recent.length > 0 ? <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>最近记录（{card.recent.length}）</summary>
      <ul className="lb-records-list">
        {card.recent.map((row) => <li key={row.id}>
          <span className="mono">{row.at.slice(5, 10)}</span>
          <span>{KIND[row.kind] ?? row.kind}{row.category ? ` · ${row.category}` : ""}</span>
          <span className="mono">{row.kind === "income" || row.kind === "expense" ? `${money(row.value)} ${row.currency}` : `${row.value} ${row.unit}`}</span>
          <small className="muted">{SOURCE[row.source] ?? row.source}</small>
          <button type="button" className="text-button" aria-label={`删除 ${row.at.slice(5, 10)} 的这条记录`} onClick={() => void remove(row.id)}>删除</button>
        </li>)}
      </ul>
      {status && <small role="status">{status}</small>}
    </details> : <small className="muted">还没有记录：在输入框说「午饭 35」「跑步 30 分钟」，或在设置里接入邮箱与手机。</small>}
  </div>;
}
