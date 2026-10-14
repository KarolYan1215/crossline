import { LastResultLink } from "../components/last-result-link";
import { TestFlow } from "../components/test-flow";

/** The landing page: one line, how long it takes, start — and 「查看我的结果」 for someone who has been here before. */
export default function Page() {
  return <main className="as-main">
    <TestFlow>
      <p className="as-kicker">Crossline 速测</p>
      <h1>你怎么同时活好几条线</h1>
      <p>32 道题，再选几项你的样子，约 4–5 分钟。得到一张类型海报：你的思维模式、适合同时推进的 3 条主线，和最合拍的搭子。</p>
      <p className="as-note">基于自评的趣味测评，非心理诊断。</p>
      <LastResultLink />
    </TestFlow>
  </main>;
}
