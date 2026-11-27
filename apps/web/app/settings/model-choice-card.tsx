import { MODEL_CHOICE_SLOTS } from "@crossline/core";
import { ModelPicker } from "../onboarding/model-picker";
import { tFor, type Locale } from "../../lib/i18n";

/** What each slot covers, in the person's words. */
const SLOT_NOTE: Record<string, string> = {
  "crossline-onboarding": "访谈输入框旁也能改，从下一轮生效",
  "crossline-onboarding-extract": "把访谈里说过的整理进账本",
  "crossline-research:onboarding": "访谈中的核实与后台调研",
  "*": "上面没单独设的其余工作"
};

/**
 * Settings → 模型 (D19): a default model and reasoning effort for the interview, its 整理层 and 调研层, and every other Skill. A slot left
 * at 默认 keeps the existing route table (packages/codex/src/model-policy.ts), or the sponsored model where the account has it. A chosen model is not stepped down when the quota is tight
 * and is never swapped for another: a spent quota or a model the account lacks is said as such.
 */
export function ModelChoiceCard({ locale }: { locale?: Locale }) {
  const t = tFor(locale);
  return <section className="st-card" aria-label={t("模型与思考强度")}>
    <header><h3>{t("模型与思考强度")}</h3>
      <small>{t("未设的按每项工作的难度自动分配；能用赞助模型时默认用它。选定的模型在额度紧张时也不降档；额度用尽时如实告知，不换成别的模型。")}</small></header>
    <div className="model-picker-rows">
      {MODEL_CHOICE_SLOTS.map((slot) => <div className="st-row" key={slot.key}>
        <span className="st-row-label">{t(slot.label)}<small>{t(SLOT_NOTE[slot.key]!)}</small></span>
        <ModelPicker slot={slot.key} label={slot.label} />
      </div>)}
    </div>
  </section>;
}
