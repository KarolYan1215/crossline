import { DeadLetters } from "./dead-letters";

export default function OfflinePage() {
  return <main className="offline-page"><div>
    <span className="brand-mark">C</span>
    <h1>当前处于离线状态</h1>
    <p>已缓存的今日计划仍可查看。恢复连接后，收集事件会继续同步。</p>
    <DeadLetters />
    <a href="/">重试</a>
  </div></main>;
}
