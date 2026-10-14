"use client";

import type { ProposedAction } from "@crossline/core";
import type { CardChoices } from "../../lib/conversation";

const LABEL: Record<string, string> = {
  title: "标题", context: "补充", lineId: "主线", dueDate: "截止", milestoneId: "里程碑", workOrderId: "任务", date: "日期", minutes: "分钟",
  stepId: "步骤", text: "内容", who: "谁", energy: "精力", level: "精力", note: "备注", startTime: "开始", endTime: "结束", until: "截至", location: "地点",
  target: "目标", label: "名称", reason: "原因", weight: "重要性", reminder: "提醒的话", time: "时间"
};
const ENERGY = [["low", "低"], ["medium", "中"], ["high", "高"]] as const;

/** Which fields of an action the person may change on the card; the rest (ids of asks and operations, the decision itself) are what was understood. */
export function editableFields(item: ProposedAction): string[] {
  switch (item.action) {
    case "task.create": return ["title", "lineId", "dueDate", "milestoneId"];
    case "task.op": {
      const type = item.args.type;
      if (type === "due" || type === "defer") return ["workOrderId", "date"];
      if (type === "estimate") return ["workOrderId", "stepId", "minutes"];
      if (type === "step_done") return ["workOrderId", "stepId"];
      if (type === "waiting") return ["workOrderId", "who", "text", "date"];
      if (type === "energy") return ["workOrderId", "energy", "text"];
      return ["workOrderId", "text"];
    }
    case "note.add": return ["text"];
    case "profile.tell": return ["text", "lineId"];
    case "workflow.request": return ["text", "lineId", "reminder", "time"];
    case "energy.report": return ["level", "note"];
    case "event.create": return ["title", "date", "startTime", "endTime", "until", "location", "lineId"];
    case "goal.add": return ["lineId", "title"];
    case "milestone.draft": return ["lineId", "title", "date", "target"];
    case "line.add": return ["label"];
    case "proposal.decide": return ["reason"];
    case "agent_result.review": return ["note"];
    case "importance.set": return ["weight"];
    default: return [];
  }
}

/**
 * The fields of one proposed action, editable in place (字段点改). Ids are chosen by name from the open tasks, their steps, the lines and
 * the milestones; dates and times are the browser's own pickers. Only what the person changes is sent, and it is checked again before it runs.
 */
export function CardFields({ item, value, choices, onChange }: {
  item: ProposedAction; value: Record<string, unknown>; choices: CardChoices | null;
  onChange: (field: string, next: unknown) => void;
}) {
  const args = { ...(item.args as Record<string, unknown>), ...value };
  const task = choices?.tasks.find((entry) => entry.id === args.workOrderId);
  return <div className="card-fields">{editableFields(item).map((field) => {
    const current = args[field];
    const id = `${item.action}-${field}`;
    const input = (() => {
      switch (field) {
        case "date": case "dueDate": case "until":
          return <input id={id} type="date" value={String(current ?? "")} onChange={(event) => onChange(field, event.target.value)} />;
        case "startTime": case "endTime": case "time":
          return <input id={id} type="time" value={String(current ?? "")} onChange={(event) => onChange(field, event.target.value)} />;
        case "minutes": case "weight":
          return <input id={id} type="number" min={field === "weight" ? 0 : 5} max={field === "weight" ? 100 : 480} value={Number(current ?? 0)}
            onChange={(event) => onChange(field, Number(event.target.value))} />;
        case "energy": case "level":
          return <select id={id} value={String(current ?? "")} onChange={(event) => onChange(field, event.target.value)}>
            {ENERGY.map(([key, word]) => <option key={key} value={key}>{word}</option>)}</select>;
        case "workOrderId":
          return <select id={id} value={String(current ?? "")} onChange={(event) => onChange(field, event.target.value)}>
            {(choices?.tasks ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select>;
        case "stepId":
          return <select id={id} value={String(current ?? "")} onChange={(event) => onChange(field, event.target.value)}>
            <option value="">（整个任务）</option>
            {(task?.steps ?? []).map((step) => <option key={step.id} value={step.id}>{step.title}</option>)}</select>;
        case "lineId":
          return <select id={id} value={String(current ?? "")} onChange={(event) => onChange(field, event.target.value)}>
            <option value="">（不指定）</option>
            {(choices?.lines ?? []).map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}</select>;
        case "milestoneId":
          return <select id={id} value={String(current ?? "")} onChange={(event) => onChange(field, event.target.value)}>
            <option value="">（不关联）</option>
            {(choices?.milestones ?? []).map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title}</option>)}</select>;
        default:
          return <input id={id} type="text" value={String(current ?? "")} onChange={(event) => onChange(field, event.target.value)} />;
      }
    })();
    return <label key={field} htmlFor={id}><span>{LABEL[field] ?? field}</span>{input}</label>;
  })}</div>;
}
