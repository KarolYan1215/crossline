import { CodexAccountControl } from "./codex-account-control";
import { CalendarSources } from "./calendar-sources";
import { TailscaleTrust } from "./tailscale-trust";
import { DeviceLeases } from "./device-leases";
import { loadCalendarConnectorState } from "../../lib/crossline";
import type { AccessContext } from "@crossline/core";

/**
 * What this machine is connected to, as observed: the Codex account, the calendar and its sources, the tailnet,
 * and the devices allowed to queue work offline. Part of the settings page; there is no separate page for it.
 */
export function ConnectionsSection({ ctx }: { ctx: AccessContext }) {
  const calendar = loadCalendarConnectorState(ctx);
  return <>
    <section className="status-grid">
      <CodexAccountControl />
      <article className="status-card">
        <span className="status-badge">已开启</span>
        <h2>Codex 跨运行 memory</h2>
        <p>
          每次技能调用不再是全新上下文；模型自己积累的记忆会影响之后的回答，同样的输入不再保证同样的输出。<br />
          记忆数据存在 Codex 自己的 CODEX_HOME 里，不在这个 App 的 SQLite 账本中，
          `pnpm export`/`backup-crossline.ps1` 都不会备份它。
        </p>
        <details><summary>诊断代码</summary><code>CODEX_MEMORIES_ENABLED</code></details>
      </article>
      <CalendarSources />
      <TailscaleTrust />
      <DeviceLeases />
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
    </section>
  </>;
}
