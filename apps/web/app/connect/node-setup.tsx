"use client";

import { useT } from "../locale-context";
import { ComputeNodeRow, NodeDownload } from "../settings/device-card";
import { Stepper } from "../ui/stepper";

/**
 * The person's own computer as a node, on the hosted site (2026-11-05, docs/hosted-hardening.md §3): one of the ways to connect on the
 * first page after signing up, the pairing code included — before, the node was found only in 设置 → 通用, which a new person never
 * reached. Since 2026-11-06 the person's ChatGPT can also be signed in on the server, so this is a choice, not the only way. The steps are
 * numbered with the download as a button; the page moves on by itself once the node is online, which it is only once ChatGPT is signed in on it.
 */
export function NodeSetupSteps({ onReady }: { onReady: (ready: boolean) => void }) {
  const t = useT();
  return <section className="st-card node-setup" aria-label={t("用自己的电脑连接 ChatGPT")}>
    <header><h3>{t("用自己的电脑连接 ChatGPT")}</h3><small>{t("约 5 分钟，只需做一次。目前只有 Windows 10 / 11 版本。")}</small></header>
    <Stepper label={t("安装节点的步骤")} steps={[
      { title: t("下载并安装「Crossline 节点」"), state: "current", detail: t("安装包 Crossline-Node-Setup.exe，在要当节点的那台电脑上下载"), action: <NodeDownload /> },
      { title: t("双击运行，遇到提示点「仍要运行」"), detail: t("Windows 弹出「Windows 已保护你的电脑」时，点「更多信息」，再点「仍要运行」（安装包没有商业签名，属正常情况）。") },
      { title: t("把配对码填进下面的「独立节点」"), detail: t("装好后会自动打开节点设置页（只在那台电脑上能打开），页面上有一个配对码，形如 ABCD-EFGH。点「配对」，核对电脑名称后点「确认配对」。") },
      { title: t("在节点设置页登录 ChatGPT"), detail: t("点「登录 ChatGPT」，用本人的 ChatGPT 账号登录。模型从此在那台电脑上用这个账号自己的额度运行。") },
      { title: t("显示「已连接」后自动进入访谈"), detail: t("电脑关机时，访谈和规划会等它再开机。") }
    ]} />
    <ComputeNodeRow onReady={onReady} everyMs={5_000} download={false} />
  </section>;
}
