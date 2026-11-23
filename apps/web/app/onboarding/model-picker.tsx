"use client";

import { useEffect, useState } from "react";
import { MODEL_CHOICE_SLOTS, SPONSOR_MODEL_CHOICE, type ModelChoice, type ModelChoiceSlot, type ModelChoices } from "@crossline/core";
import { useT } from "../locale-context";
import type { ModelsAnswer, PickerModel } from "../api/settings/models/route";
import "./model-picker.css";

/** Each effort in the person's words; the catalogue decides which of them a model takes. */
const EFFORT_LABEL: Record<string, string> = { none: "不思考", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "极高" };
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh"];

// One read for every picker on a page (Settings shows three, the interview one); dropped after a write so the next page reads afresh.
let shared: Promise<ModelsAnswer | undefined> | undefined;
const readModels = () => shared ??= fetch("/api/settings/models", { cache: "no-store" })
  .then((response) => response.ok ? response.json() as Promise<ModelsAnswer> : undefined).catch(() => undefined);

/** The model a choice names, from the account's list; a chosen model the account no longer lists is still shown, as such. */
const optionsFor = (models: PickerModel[], choice: ModelChoice | undefined): Array<PickerModel & { missing?: boolean }> =>
  choice && !models.some((model) => model.model === choice.model) ? [...models, { model: choice.model, efforts: [], defaultEffort: "", isDefault: false, missing: true }] : models;

/** The sponsored model as the person reads it: the provider's own name without the vendor prefix or a thinking cap. */
const sponsorName = (model: string) => (model.split("/").pop() ?? model).replace(/@think:.*$/, "");

/**
 * The model and reasoning effort for one slot (D19), like Codex's own picker: the models the account's Codex lists (`model/list`), and only
 * the efforts the chosen model takes. 「默认」 leaves the slot to the route table. A choice applies from the next turn or run; it is never
 * stepped down when the quota is tight and never swapped for another model (packages/codex/src/skill-runner.ts). `compact` is the
 * interview's form beside its input box. An account that can also use the developer's sponsored model sees it as its own group (chosen
 * as `SPONSOR_MODEL_CHOICE`, no effort to pick) and as the default (2026-11-22, the owner's decision).
 */
export function ModelPicker({ slot, label, compact = false }: { slot: ModelChoiceSlot; label?: string; compact?: boolean }) {
  const t = useT();
  const [answer, setAnswer] = useState<ModelsAnswer>();
  const [loaded, setLoaded] = useState(false);
  const [choice, setChoice] = useState<ModelChoice>();
  const [status, setStatus] = useState<"" | "saved" | "failed">("");
  useEffect(() => {
    let live = true;
    void readModels().then((read) => {
      if (!live) return;
      setAnswer(read);
      setChoice((read?.choices as ModelChoices | undefined)?.[slot]);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [slot]);

  const save = async (next: ModelChoice | undefined) => {
    const previous = choice;
    setChoice(next);
    setStatus("");
    const response = await fetch("/api/settings/models", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot, model: next?.model ?? null, ...(next?.effort ? { effort: next.effort } : {}) }) }).catch(() => null);
    shared = undefined;
    if (!response?.ok) setChoice(previous);
    setStatus(response?.ok ? "saved" : "failed");
  };

  if (!loaded) return compact ? null : <small className="muted">{t("正在读取模型列表…")}</small>;
  const sponsor = answer?.sponsor;
  const sponsorPicked = choice?.model === SPONSOR_MODEL_CHOICE;
  const models = optionsFor(answer?.models ?? [], sponsorPicked ? undefined : choice);
  // Nothing to choose from: the interview's box stays as it was; Settings says why.
  if (!models.length && !sponsor && !sponsorPicked) return compact ? null : <small className="muted">{answer?.provider
    ? t("这个账号的模型由「模型连接」里的服务提供；这里的选择只作用于 ChatGPT 登录。")
    : t("模型列表暂时读不到：连接 ChatGPT 后可选。")}</small>;
  const current = sponsorPicked ? undefined : models.find((model) => model.model === choice?.model);
  const efforts = current ? EFFORT_ORDER.filter((effort) => current.efforts.includes(effort)) : [];
  const name = (model: PickerModel & { missing?: boolean }) => model.missing ? t("{{model}}（这个账号没有）", { model: model.model })
    : model.displayName ?? model.model;
  const what = t(label ?? MODEL_CHOICE_SLOTS.find((item) => item.key === slot)?.label ?? "模型");

  return <span className={compact ? "model-picker model-picker-compact" : "model-picker"} role="group" aria-label={t("{{what}}的模型与思考强度", { what })}>
    <select aria-label={t("{{what}}的模型", { what })} value={choice?.model ?? ""}
      onChange={(event) => void save(event.target.value ? { model: event.target.value } : undefined)}>
      <option value="">{sponsor ? t("默认（赞助模型 {{model}}）", { model: sponsorName(sponsor.model) }) : t("默认模型")}</option>
      {models.length > 0 && <optgroup label={t("ChatGPT")}>
        {models.map((model) => <option key={model.model} value={model.model}>{name(model)}</option>)}
      </optgroup>}
      {(sponsor || sponsorPicked) && <optgroup label={t("赞助模型")}>
        <option value={SPONSOR_MODEL_CHOICE}>{sponsor ? sponsorName(sponsor.model) : t("赞助模型（这个账号没有）")}</option>
      </optgroup>}
    </select>
    {current && efforts.length > 0 && <select aria-label={t("{{what}}的思考强度", { what })} value={choice?.effort ?? ""}
      onChange={(event) => void save({ model: current.model, ...(event.target.value ? { effort: event.target.value } : {}) })}>
      <option value="">{current.defaultEffort ? t("默认强度（{{effort}}）", { effort: t(EFFORT_LABEL[current.defaultEffort] ?? current.defaultEffort) }) : t("默认强度")}</option>
      {efforts.map((effort) => <option key={effort} value={effort}>{t(EFFORT_LABEL[effort] ?? effort)}</option>)}
    </select>}
    {sponsorPicked && sponsor?.blocked && <small className="st-fail">{sponsor.blocked}</small>}
    {status && <small role="status" className={status === "saved" ? "st-ok" : "st-fail"}>
      {status === "failed" ? t("未保存") : compact ? t("下一轮生效") : t("已保存，下一次运行生效")}</small>}
  </span>;
}
