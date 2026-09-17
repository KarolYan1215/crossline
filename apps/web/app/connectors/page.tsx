import { SubpageShell } from "../subpage-shell";
import { CodexAccountControl } from "./codex-account-control";
import { CalendarSources } from "./calendar-sources";
import { loadCalendarConnectorState } from "../../lib/crossline";

export const dynamic = "force-dynamic";

/**
 * Declared targets that genuinely have no credentials and have never run. Anything whose state can be
 * observed is read from the ledger instead of listed here — a page that prints "not connected" next to
 * a connector that is working is worse than no page.
 */
const declared = [
  ["个人 Outlook · Crossline", "Microsoft Graph", "唯一日历写入目标（Gate 3，仍关闭）"],
  ["Microsoft To Do · Crossline", "Microsoft Graph", "专用列表双向同步（Gate 3，仍关闭）"],
  ["Google Calendar", "Codex 官方插件", "只读现实约束"],
  ["content-ops", "本机适配器", "提交任务与读取真实状态"],
  ["Longbridge", "只读 allowlist", "美股与 ETF 研究"]
] as const;

export default function ConnectorsPage() {
  const calendar = loadCalendarConnectorState();
  return <SubpageShell eyebrow="写后验证" title="连接目标"
    description="工作日历一行是观测到的真实状态；其余各行是声明的目标，尚未配置凭据，也没有跑过任何探测。">
    <section className="status-grid">
      <CodexAccountControl />
      <CalendarSources />
      <article className="status-card">
        <span className="status-badge">{calendar.synced ? "只读同步中" : "尚未连接"}</span>
        <h2>工作日历（Microsoft Graph）</h2>
        {calendar.synced
          ? <p>
              自有 Entra 应用 · 委派只读<br />
              今日已导入 {calendar.importedBlocks} 个现实块到计划<br />
              {calendar.lastChangeAt
                ? `最近一次变化：${calendar.lastChangeAt.slice(0, 16).replace("T", " ")} · ${calendar.lastChangeCount} 项`
                : "自上次同步以来日历没有变化"}
            </p>
          : <p>
              自有 Entra 应用 · 委派只读<br />
              还没有跑过一次同步。设置 `CROSSLINE_MS_CLIENT_ID` 并完成一次设备码登录后，worker 会自行拉取。
            </p>}
        <details><summary>诊断代码</summary>
          <code>{calendar.synced ? "GRAPH_READ_ONLY_SYNCED" : "GRAPH_NOT_SIGNED_IN"}</code>
        </details>
      </article>
      {declared.map(([name, channel, scope]) => <article className="status-card" key={name}>
        <span className="status-badge">尚未连接</span><h2>{name}</h2>
        <p>{channel}<br />{scope}<br />未配置凭据，未执行探测。</p>
        <details><summary>诊断代码</summary><code>CONNECTOR_NOT_CONFIGURED</code></details>
      </article>)}
    </section>
  </SubpageShell>;
}
