"use client";

import { NODE_GUIDE_URL, NODE_INSTALLER_URL } from "@crossline/core";
import { useT } from "../locale-context";
import { ComputeNodeRow } from "../settings/device-card";

/**
 * Connecting with the person's own ChatGPT on the hosted site (2026-11-05, docs/hosted-hardening.md §3): the server signs no guest's
 * subscription in, so the model runs on their own computer as a compute node. Every step is here, on the first page after signing up,
 * the pairing code included: before, the node was found only in 设置 → 通用, which a new person never reached. The page moves on by
 * itself once the node is online, which it is only once ChatGPT is signed in on it.
 */
export function NodeSetupSteps({ onReady }: { onReady: (ready: boolean) => void }) {
  const t = useT();
  return <section className="st-card node-setup" aria-label={t("用自己的电脑连接 ChatGPT")}>
    <header><h3>{t("用自己的电脑连接 ChatGPT")}</h3><small>{t("约 5 分钟，只需做一次。目前只有 Windows 10 / 11 版本。")}</small></header>
    <ol className="codex-steps">
      <li>{t("在这台 Windows 电脑上下载安装包：")} <a href={NODE_INSTALLER_URL} target="_blank" rel="noreferrer">{t("下载 Crossline 节点")}</a>{" · "}
        <a href={NODE_GUIDE_URL} target="_blank" rel="noreferrer">{t("图文教程（PDF）")}</a></li>
      <li>{t("双击运行。Windows 弹出「Windows 已保护你的电脑」时，点「更多信息」，再点「仍要运行」（安装包没有商业签名，属正常情况）。")}</li>
      <li>{t("装好后会自动打开节点设置页（只在那台电脑上能打开），页面上有一个配对码，形如 ABCD-EFGH。把它填进下面的「独立节点」，点「配对」，核对电脑名称后点「确认配对」。")}</li>
      <li>{t("回到节点设置页，点「登录 ChatGPT」，用本人的 ChatGPT 账号登录。模型从此在那台电脑上用这个账号自己的额度运行。")}</li>
      <li>{t("下面显示「已连接」后，这一页自动进入访谈。电脑关机时，访谈和规划会等它再开机。")}</li>
    </ol>
    <ComputeNodeRow onReady={onReady} everyMs={5_000} />
  </section>;
}
