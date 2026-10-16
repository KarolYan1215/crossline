import { DeadLetters } from "./dead-letters";
import { Say } from "../locale-context";

/** The service worker's offline fallback: precached with no request context, so its words are translated on the client (docs/i18n.md). */
export default function OfflinePage() {
  return <main className="offline-page"><div>
    <span className="brand-mark">C</span>
    <h1><Say text={"当前处于离线状态"} /></h1>
    <p><Say text={"已缓存的今日计划仍可查看。恢复连接后，收集事件会继续同步。"} /></p>
    <DeadLetters />
    <a href="/"><Say text={"重试"} /></a>
  </div></main>;
}
