import { TYPE_GROUPS, TYPE_TABLE } from "@crossline/core/assess";
import { TYPE_SUBTITLE } from "@crossline/core/assess-content";
import { LastResultLink } from "../components/last-result-link";
import { TestFlow } from "../components/test-flow";
import { tFor, type Translate } from "../lib/i18n";
import { getLocale } from "../lib/locale-server";
import { LANDING_SAMPLES } from "../lib/samples";

/**
 * The landing page: one line, how long it takes, start — and 「查看我的结果」 for someone who has been here before. Below the button,
 * four of the sixteen types as they appear on a poster (figure, name, the self-mocking subtitle), so someone arriving from a post sees
 * what they will get before answering anything.
 */
export default async function Page() {
  const t = tFor(await getLocale());
  return <main className="as-main">
    <TestFlow after={<Samples t={t} />}>
      <p className="as-kicker">{t("Crossline 速测")}</p>
      <h1>{t("你在 AI 时代会是什么样的超级个体")}</h1>
      <p>{t("36 个场景二选一，再选几项你的样子，约 5 分钟。得到一张类型海报：你是 16 种 AI 时代超级个体里的哪一种、AI 替你干什么、你不让 AI 碰什么、思想相近的名人，和最合拍的搭子。")}</p>
      <p className="as-note">{t("基于自评的趣味测评，非心理诊断。")}</p>
      <LastResultLink />
    </TestFlow>
  </main>;
}

function Samples({ t }: { t: Translate }) {
  return <section className="as-samples" aria-labelledby="as-samples-title">
    <h2 id="as-samples-title">{t("16 种类型，比如")}</h2>
    <ul>{LANDING_SAMPLES.map(({ code }) => {
      const group = TYPE_GROUPS[code.slice(0, 2)]!;
      return <li key={code} style={{ ["--group" as string]: group.colour, ["--group-tint" as string]: group.tint }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a static example figure */}
        <img src={`/samples/${code}.png`} alt="" width={240} height={360} />
        <p className="as-sample-name">{t(TYPE_TABLE[code]!.name)}</p>
        <p className="as-note">{t(TYPE_SUBTITLE[code]!)}</p>
      </li>;
    })}</ul>
    <p className="as-note">{t("答完你也会得到一张：你的形象、类型、四个维度，和一个能拉朋友测关系的二维码。")}</p>
  </section>;
}
