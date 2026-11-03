"use client";

import { useState } from "react";
import type { VoiceLanguage, VoicePreferences } from "@crossline/core";
import { SegmentedControl } from "../ui/controls";
import { useT } from "../locale-context";
import { refreshVoiceStatus } from "../ui/voice/voice-input";

const LANGUAGES = ["auto", "zh", "en", "yue"] as const;

/**
 * 语音输入 in Settings → 通用 (docs/voice-input.md): whether every free-text box shows its microphone, the language it listens for, and
 * whether a model corrects what was heard against the person's names. Each choice saves on click and goes back if the save fails.
 */
export function VoiceCard({ initial }: { initial: VoicePreferences }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [failed, setFailed] = useState(false);
  const save = async (patch: Partial<VoicePreferences>) => {
    const before = value;
    setValue({ ...value, ...patch }); setFailed(false);
    const response = await fetch("/api/settings/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) })
      .catch(() => undefined);
    if (!response?.ok) { setValue(before); setFailed(true); return; }
    refreshVoiceStatus();
  };
  const onOff = [{ value: "on", label: t("开启") }, { value: "off", label: t("关闭") }] as const;
  return <section className="st-card" aria-label={t("语音输入")} id="voice">
    <header><h3>{t("语音输入")}</h3><small>{t("每个文字框右下角的麦克风；录音不保存")}</small></header>
    <div className="st-row"><span className="st-row-label">{t("麦克风")}<small>{t("关闭后所有文字框不再显示麦克风。")}</small></span>
      <SegmentedControl label={t("语音输入")} value={value.enabled ? "on" : "off"} onChange={(next) => void save({ enabled: next === "on" })} options={onOff} />
    </div>
    <div className="st-row"><span className="st-row-label">{t("识别语言")}<small>{t("说普通话夹英文词时选普通话即可。")}</small></span>
      <SegmentedControl label={t("识别语言")} value={value.language} onChange={(next) => void save({ language: next as VoiceLanguage })}
        options={LANGUAGES.map((value) => ({ value, label: { auto: t("跟随界面"), zh: t("普通话"), en: "English", yue: t("粤语") }[value] }))} />
    </div>
    <div className="st-row"><span className="st-row-label">{t("纠正错字")}<small>{t("按主线、项目和任务的名称纠正听错的字词，只改错字和标点，不改写原话；使用模型额度。")}</small></span>
      <SegmentedControl label={t("纠正错字")} value={value.correct ? "on" : "off"} onChange={(next) => void save({ correct: next === "on" })} options={onOff} />
    </div>
    {failed && <small role="status" className="st-fail">{t("未保存")}</small>}
  </section>;
}
