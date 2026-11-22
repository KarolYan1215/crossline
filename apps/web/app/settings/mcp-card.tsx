"use client";

import { useEffect, useState } from "react";
import { MCP_TOKENS_MAX, type McpScope } from "@crossline/core";
import { SegmentedControl } from "../ui/controls";
import { useLocale, useT } from "../locale-context";
import { intlLocale, type Locale } from "../../lib/i18n";

type TokenView = { id: string; label: string; scopes: McpScope[]; createdAt: string; lastUsedAt?: string; client?: string };
const time = (iso: string, locale: Locale) => new Date(iso).toLocaleString(intlLocale(locale), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * 「在其他 AI 里用 Crossline」 (docs/mcp-server.md §4): a token per outside agent (Claude Code, Codex…), read-only or read-write, shown
 * once, revocable one by one; or a connection the agent made by signing in (claude.ai, ChatGPT: OAuth, §4.3), listed and revoked the same
 * way. The agent can then read today's schedule, list and answer pending questions, write a line into the inbox
 * and record work done — nothing else, and every write shows in 最近操作 with the agent's name.
 */
export function McpCard() {
  const t = useT();
  const locale = useLocale();
  const [tokens, setTokens] = useState<TokenView[] | undefined>();
  const [label, setLabel] = useState("Claude Code");
  const [scope, setScope] = useState<McpScope>("read");
  const [made, setMade] = useState<{ token: string; label: string } | undefined>();
  const [note, setNote] = useState("");
  const [origin, setOrigin] = useState("");
  const [oauth, setOauth] = useState(false);
  const load = async () => {
    const response = await fetch("/api/mcp/tokens", { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { tokens?: TokenView[]; oauth?: boolean } | undefined;
    if (body?.tokens) setTokens(body.tokens);
    setOauth(body?.oauth === true);
  };
  useEffect(() => { setOrigin(window.location.origin); void load(); }, []);
  const issue = async () => {
    const response = await fetch("/api/mcp/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label, scope }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; token?: string; code?: string } | undefined;
    if (!body?.ok || !body.token) {
      setNote(body?.code === "MCP_TOKENS_FULL" ? t("最多 {{count}} 个令牌，先撤销一个不用的", { count: MCP_TOKENS_MAX })
        : body?.code === "MCP_TOKEN_LABEL_INVALID" ? t("名称需 1–40 个字") : t("没有生成，请重试"));
      return;
    }
    setMade({ token: body.token, label: label.trim() });
    setNote(t("令牌只显示这一次。"));
    void load();
  };
  const revoke = async (id: string) => {
    const response = await fetch(`/api/mcp/tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    setNote(response?.ok ? t("已撤销：用它的 AI 下一次调用会被拒绝。") : t("没有撤销，请重试"));
    void load();
  };
  const endpoint = `${origin}/api/mcp`;
  const shown = made?.token ?? "<token>";
  // i18n-ignore-start: commands the person pastes into a terminal or config file
  const claude = `claude mcp add --transport http crossline ${endpoint} --header "Authorization: Bearer ${shown}"`;
  const codex = `[mcp_servers.crossline]\nurl = "${endpoint}"\nbearer_token_env_var = "CROSSLINE_MCP_TOKEN"`;
  // i18n-ignore-end
  return <section className="st-card" aria-label={t("在其他 AI 里用 Crossline")} id="mcp">
    <header><h3>{t("在其他 AI 里用 Crossline")}</h3>
      <small>{t("让 Claude Code、Codex 等通过 MCP 读今天的安排、回答待决事项、记下一件事、记录完成；不能发信、报名、付款或改外部日历。每次写入都出现在最近操作里，注明是哪个 AI，24 小时内可撤销。")}</small></header>
    {(tokens ?? []).map((token) => <div className="st-row" key={token.id}>
      <span className="st-row-label">{token.label}<small>{[token.scopes.includes("write") ? t("读写") : t("只读"),
        ...(token.client ? [t("登录连接 · {{host}}", { host: token.client })] : []), t("生成于 {{when}}", { when: time(token.createdAt, locale) }),
        token.lastUsedAt ? t("最近使用 {{when}}", { when: time(token.lastUsedAt, locale) }) : t("还没用过")].join(" · ")}</small></span>
      <button type="button" className="secondary-button" onClick={() => void revoke(token.id)}>{t("撤销")}</button></div>)}
    <label className="st-row"><span className="st-row-label">{t("名称", { context: "field" })}<small>{t("用它的 AI 叫什么；它的每次写入都会标上这个名字")}</small></span>
      <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={40} autoComplete="off" style={{ width: "12em" }} /></label>
    <div className="st-row"><span className="st-row-label">{t("权限")}<small>{scope === "write" ? t("可以读，也可以记下一件事、回答待决事项、记录完成") : t("只能读：今天的安排、待决事项和任务")}</small></span>
      <SegmentedControl label={t("权限")} value={scope} options={[{ value: "read", label: t("只读") }, { value: "write", label: t("读写") }]} onChange={(next) => setScope(next as McpScope)} /></div>
    <div className="st-row"><span className="st-row-label">{t("生成令牌")}</span>
      <button type="button" className="primary-button" disabled={!label.trim()} onClick={() => void issue()}>{t("生成令牌")}</button></div>
    {made && <div className="st-row"><span className="st-row-label">{t("「{{label}}」的令牌", { label: made.label })}<small>{t("复制到下面的配置里；关掉这页后无法再看到")}</small></span>
      <code className="mono" style={{ userSelect: "all", wordBreak: "break-all" }}>{made.token}</code></div>}
    {note && <p role="status" className="st-note">{note}</p>}
    {/* Shown once the page knows its own address, which the commands carry. */}
    {origin && <details className="st-row">
      <summary>{t("怎么接入")}</summary>
      <p className="muted">{t("服务地址")}: <code className="mono" style={{ userSelect: "all" }}>{endpoint}</code></p>
      <p className="muted">{t("Claude Code：在终端运行")}</p>
      <pre className="mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", userSelect: "all" }}>{claude}</pre>
      <p className="muted">{t("Codex：写进 ~/.codex/config.toml，令牌放进环境变量 CROSSLINE_MCP_TOKEN")}</p>
      <pre className="mono" style={{ whiteSpace: "pre-wrap", userSelect: "all" }}>{codex}</pre>
      {oauth ? <>
        <p className="muted">{t("claude.ai：设置 → 连接器 → 添加自定义连接器，填上面的服务地址，再按提示登录 Crossline 并允许。ChatGPT：在开发者模式里新建连接器，填同一个地址，认证选 OAuth。不需要令牌。")}</p>
        {!origin.startsWith("https://") && <p className="muted">{t("它们要从网上连到这里：用网页版 Crossline 的地址，本机地址连不上。")}</p>}
      </> : <p className="muted">{t("这个 Crossline 没有开放登录连接：claude.ai 与 ChatGPT 连不上，请用上面的令牌。")}</p>}
    </details>}
  </section>;
}
