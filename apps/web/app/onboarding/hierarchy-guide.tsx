/**
 * The opening picture of how the system thinks (decided 2026-10-08): six layers from who the person is becoming down to the hour on the
 * calendar, each with how it is written and what the system does with it. Abstract on top (why), concrete at the bottom (how): identity
 * goals keep pursuit going, achieved states make progress checkable, actions and steps make starting easy.
 */
const LAYERS: Array<{ name: string; form: string; example: string; does: string }> = [
  { name: "主线", form: "身份名词", example: "研究者", does: "排程、配色与优先级的单位；最多两条为硬约束" },
  { name: "长期目标", form: "成为 ___ 的 <身份>", example: "成为能独立立项的研究者", does: "描述性的方向，不设日期、不会「完成」；每条主线可多个" },
  { name: "里程碑", form: "已达成的状态", example: "课程总评达到 A−", does: "有截止日与可验证标准，按日期排在时间轴上" },
  { name: "任务", form: "动词开头的短动作", example: "完成作业 2", does: "30 分钟–8 小时；带说明、材料与教程" },
  { name: "步骤", form: "具体可执行的一步", example: "核对题目与提交格式", does: "逐个排进可用时段，完成即推进任务进度" },
  { name: "日程", form: "日历上的时段", example: "周四 9:00–9:30", does: "硬约束的固定日程是骨架，其余排在空档里" }
];

export function HierarchyGuide() {
  return <figure className="ob-guide" aria-label="Crossline 的分层">
    <figcaption><b>从「成为谁」到「此刻做什么」</b><small className="muted">访谈先了解现状与主线，再据此生成长期目标、里程碑与任务。</small></figcaption>
    <ol>{LAYERS.map((layer, index) => <li key={layer.name} style={{ marginLeft: `${index * 14}px` }}>
      <b>{layer.name}</b>
      <span className="ob-guide-form">{layer.form}</span>
      <span className="ob-guide-example">例：{layer.example}</span>
      <small>{layer.does}</small>
    </li>)}</ol>
  </figure>;
}
