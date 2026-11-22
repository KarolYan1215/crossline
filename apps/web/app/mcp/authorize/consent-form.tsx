"use client";

import { useState } from "react";
import { MCP_TOKENS_MAX, type McpScope } from "@crossline/core";
import { SegmentedControl } from "../../ui/controls";
import { useT } from "../../locale-context";

/**
 * 允许 / 拒绝 on the consent page, with the scope (never more than the AI asked for) and the name its writes will carry. The answer comes
 * back as an address and the page goes there itself: the site's `form-action 'self'` would stop a form redirected to another site.
 */
export function ConsentForm({ query, writeAsked, defaultLabel }: { query: string; writeAsked: boolean; defaultLabel: string }) {
  const t = useT();
  const [label, setLabel] = useState(defaultLabel);
  const [scope, setScope] = useState<McpScope>(writeAsked ? "write" : "read");
  const [state, setState] = useState<{ busy: boolean; message: string }>({ busy: false, message: "" });
  const decide = async (allow: boolean) => {
    setState({ busy: true, message: t("处理中…") });
    const response = await fetch("/api/mcp/oauth/consent", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, allow, scope, label }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; redirect?: string; code?: string } | undefined;
    if (body?.ok && body.redirect) { window.location.assign(body.redirect); return; }
    setState({ busy: false, message: body?.code === "MCP_TOKENS_FULL" ? t("最多 {{count}} 个令牌，先撤销一个不用的", { count: MCP_TOKENS_MAX }) : t("没有处理成功，请重试。") });
  };
  return <div>
    <p><label>{t("名称", { context: "field" })}{" "}
      <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={40} autoComplete="off" style={{ width: "12em" }} /></label></p>
    <p className="muted">{t("用它的 AI 叫什么；它的每次写入都会标上这个名字")}</p>
    {writeAsked
      ? <SegmentedControl label={t("权限")} value={scope} options={[{ value: "read", label: t("只读") }, { value: "write", label: t("读写") }]} onChange={(next) => setScope(next as McpScope)} />
      : null}
    <p className="muted">{scope === "write" ? t("可以读，也可以记下一件事、回答待决事项、记录完成") : t("只能读：今天的安排、待决事项和任务")}</p>
    <p>
      <button type="button" className="primary-button" disabled={state.busy || !label.trim()} onClick={() => void decide(true)}>{t("允许")}</button>{" "}
      <button type="button" className="secondary-button" disabled={state.busy} onClick={() => void decide(false)}>{t("拒绝")}</button>
    </p>
    {state.message && <p role="status">{state.message}</p>}
  </div>;
}
