import { redirect } from "next/navigation";

/** 「报告」 became the workflow part of 「Agent 产出」 (2026-11-10); a report itself is still read at /reports/<id>. */
export default function ReportsPage() {
  redirect("/outputs?source=workflow");
}
