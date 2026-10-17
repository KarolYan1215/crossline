import { TYPE_GROUPS, TYPE_TABLE } from "@crossline/core/assess";
import { TYPE_SUBTITLE } from "@crossline/core/assess-content";
import { LastResultLink } from "../components/last-result-link";
import { TestFlow } from "../components/test-flow";
import { LANDING_SAMPLES } from "../lib/samples";

/**
 * The landing page: one line, how long it takes, start — and 「查看我的结果」 for someone who has been here before. Below the button,
 * four of the sixteen types as they appear on a poster (figure, name, the self-mocking subtitle), so someone arriving from a post sees
 * what they will get before answering anything.
 */
export default function Page() {
  return <main className="as-main">
    <TestFlow after={<Samples />}>
      <p className="as-kicker">Crossline 速测</p>
      <h1>你怎么同时活好几条线</h1>
      <p>32 道题，再选几项你的样子，约 4–5 分钟。得到一张类型海报：你的思维模式、适合同时推进的 3 条主线，和最合拍的搭子。</p>
      <p className="as-note">基于自评的趣味测评，非心理诊断。</p>
      <LastResultLink />
    </TestFlow>
  </main>;
}

function Samples() {
  return <section className="as-samples" aria-labelledby="as-samples-title">
    <h2 id="as-samples-title">16 种类型，比如</h2>
    <ul>{LANDING_SAMPLES.map(({ code }) => {
      const group = TYPE_GROUPS[code.slice(0, 2)]!;
      return <li key={code} style={{ ["--group" as string]: group.colour, ["--group-tint" as string]: group.tint }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a static example figure */}
        <img src={`/samples/${code}.png`} alt="" width={240} height={360} />
        <p className="as-sample-name">{TYPE_TABLE[code]!.name} <span className="as-code">{code}</span></p>
        <p className="as-note">{TYPE_SUBTITLE[code]}</p>
      </li>;
    })}</ul>
    <p className="as-note">答完你也会得到一张：你的形象、类型、四个维度，和一个能拉朋友测关系的二维码。</p>
  </section>;
}
