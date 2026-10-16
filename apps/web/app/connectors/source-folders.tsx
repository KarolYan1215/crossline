"use client";
import { useCallback, useEffect, useState } from "react";
import { groupPattern, type SourceFolder } from "@crossline/core";
import { useLocale, useT } from "../locale-context";

type PreviewFile = { relative: string; size: number; nameOnly?: true; duplicates?: number };
type PreviewGroup = { name: string; files: number; nameOnly: number; bytes: number; list: PreviewFile[]; more: number };
type Preview = { state: "preview"; path: string; label: string; files: number; nameOnly: number; bytes: number; skippedDirectories: number;
  over: number; duplicates: number; truncated: boolean; limit: number; groups: PreviewGroup[];
  sensitive: Array<PreviewFile & { reason: string }>; sensitiveCount: number; credentials: Array<{ relative: string; reason: string }>; credentialCount: number };
const megabytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const toggled = (set: Set<string>, item: string) => { const next = new Set(set); if (next.has(item)) next.delete(item); else next.add(item); return next; };
/** A translated sentence whose `<b>…</b>` spans are drawn bold, so a number in the middle of a sentence stays bold in either language. */
function Bold({ text }: { text: string }) {
  return <>{text.split(/<b>(.*?)<\/b>/).map((part, index) => index % 2 ? <b key={index}>{part}</b> : part)}</>;
}
const inGroup = (relative: string, group: string) => group ? relative.startsWith(`${group}/`) : !relative.includes("/");

/**
 * Authorized folders (docs/onboarding-v3.md 「文件夹授权」). The person gives a folder's path; before anything is read the card shows what
 * would be read by subfolder, each group and file can be left out, and files that look like private papers are left out unless ticked
 * back; credentials are listed as never read, with nothing to tick. Past the limit the person narrows it or takes the most recently changed. The choices are kept with the folder and can be changed
 * later; revoking keeps what was read unless the person chooses to delete it too.
 */
export function SourceFolders({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const en = useLocale() === "en";
  const [folders, setFolders] = useState<SourceFolder[] | undefined>();
  const [lines, setLines] = useState<Array<{ id: string; label: string }>>([]);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<Preview | undefined>();
  const [offGroups, setOffGroups] = useState<Set<string>>(new Set());
  const [offFiles, setOffFiles] = useState<Set<string>>(new Set());
  const [onSensitive, setOnSensitive] = useState<Set<string>>(new Set());
  const [recent, setRecent] = useState(false);
  const [revoking, setRevoking] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // Folders are on the computer Crossline runs on: only its owner's account may authorize one (a guest uploads files instead).
  const [available, setAvailable] = useState(true);
  // A path names a folder on the computer Crossline runs on; opened from anywhere else (the hosted app) it would name a folder on the
  // server, so the card shows only on that computer and the interview's 「选择文件夹」 uploads from the browser instead.
  const [local, setLocal] = useState(false);
  useEffect(() => { setLocal(["127.0.0.1", "localhost"].includes(location.hostname)); }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/sources/folders", { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { folders?: SourceFolder[]; lines?: Array<{ id: string; label: string }>; available?: boolean } | undefined;
    setAvailable(body?.available !== false);
    setFolders(body?.folders ?? []);
    setLines(body?.lines ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While a folder is being read for the first time, look again every few seconds.
  const reading = folders?.some((folder) => !folder.lastScanAt) ?? false;
  // 「正在后台读取」 is said only while it is true.
  const authorized = t("已授权，正在后台读取。");
  useEffect(() => { if (!reading) setMessage((now) => now === authorized ? "" : now); }, [reading, folders, authorized]);
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => void load().then(() => onChanged?.()), 4000);
    return () => clearInterval(timer);
  }, [reading, load, onChanged]);

  const post = async (body: object) => {
    const response = await fetch("/api/sources/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    return await response?.json().catch(() => undefined) as ({ state?: string; message?: string; saved?: boolean; removed?: number } & Partial<Omit<Preview, "state">>) | undefined;
  };
  const look = async () => {
    setBusy(true); setMessage(""); setPreview(undefined);
    setOffGroups(new Set()); setOffFiles(new Set()); setOnSensitive(new Set()); setRecent(false);
    const answer = await post({ action: "preview", path: draft });
    if (answer?.state === "preview") setPreview(answer as Preview); else setMessage(answer?.message ?? t("后台服务没有连上，稍后再试。"));
    setBusy(false);
  };

  // What the choices in the preview add up to, worked out here so the counts follow every tick.
  const chosen = preview ? (() => {
    let files = 0, bytes = 0;
    for (const group of preview.groups) {
      if (offGroups.has(group.name)) continue;
      files += group.files; bytes += group.bytes;
      for (const file of group.list) if (!file.nameOnly && offFiles.has(file.relative)) { files -= 1; bytes -= file.size; }
    }
    for (const file of preview.sensitive) if (!file.nameOnly && onSensitive.has(file.relative)) { files += 1; bytes += file.size; }
    return { files, bytes, over: Math.max(0, files - preview.limit) };
  })() : undefined;

  const authorize = async () => {
    if (!preview) return;
    setBusy(true);
    const exclude = [...[...offGroups].map(groupPattern), ...[...offFiles].filter((relative) => ![...offGroups].some((group) => inGroup(relative, group)))];
    const answer = await post({ action: "add", path: preview.path, exclude, include: [...onSensitive] });
    if (answer?.state === "added") { setPreview(undefined); setDraft(""); setMessage(authorized); }
    else setMessage(answer?.message ?? t("没能授权这个文件夹。"));
    await load();
    onChanged?.();
    setBusy(false);
  };
  const saveRules = async (folder: SourceFolder, exclude: string[], include: string[]) => {
    setBusy(true);
    const answer = await post({ action: "exclusions", id: folder.id, exclude, include });
    setMessage(answer?.saved ? (answer.removed ? t("已更新排除列表，从资料中移除 {{count}} 个文件。", { count: answer.removed }) : t("已更新排除列表。")) : answer?.message ?? t("没能更新排除列表。"));
    await load();
    onChanged?.();
    setBusy(false);
  };
  const toggleLine = async (folder: SourceFolder, lineId: string) => {
    const next = folder.lines.includes(lineId) ? folder.lines.filter((id) => id !== lineId) : [...folder.lines, lineId];
    setFolders((all) => all?.map((item) => item.id === folder.id ? { ...item, lines: next, linesBy: "person" } : item));
    await post({ action: "lines", id: folder.id, lines: next });
    await load();
  };
  const revoke = async (id: string, purge: boolean) => {
    setBusy(true);
    const response = await fetch(`/api/sources/folders?id=${encodeURIComponent(id)}${purge ? "&purge=1" : ""}`, { method: "DELETE" }).catch(() => undefined);
    const answer = await response?.json().catch(() => undefined) as { removed?: boolean; purged?: number } | undefined;
    setMessage(answer?.removed ? (purge ? t("已取消授权，删除了 {{count}} 个已读入的文件。", { count: answer.purged ?? 0 }) : t("已取消授权，已读入的内容保留。")) : t("没能取消授权，稍后再试。"));
    setRevoking(undefined);
    await load();
    onChanged?.();
    setBusy(false);
  };

  if (!available || !local) return null;
  return <section className="st-card source-folders" aria-label={t("授权文件夹")}>
    <header><h3>{t("授权文件夹")}</h3><small>{t("读取文件夹里能读的文件（PDF、Word、文本），之后有新文件或改动会自动重读")}</small></header>
    {folders?.map((folder) => <div className="source-folder" key={folder.id}>
      <div className="st-row">
        <span className="st-row-label">{folder.label}
          <small>{folder.lastError ? folder.lastError
            : !folder.lastScanAt ? t("正在读取…")
            : [t("已读 {{count}} 个文件", { count: folder.files ?? 0 }), ...(folder.nameOnly ? [t("{{count}} 个只记文件名", { count: folder.nameOnly })] : []),
              ...(folder.duplicates ? [t("{{count}} 个相同副本只读一份", { count: folder.duplicates })] : [])].join(en ? ", " : "，")
              + (folder.over ? (en ? "; " : "；") + t("超出上限，最早改动的 {{count}} 个未读", { count: folder.over }) : "")}</small>
        </span>
        <button type="button" className="ob-btn ob-quiet secondary-button" disabled={busy} onClick={() => setRevoking(revoking === folder.id ? undefined : folder.id)}>{t("取消授权")}</button>
      </div>
      {revoking === folder.id && <div className="source-folder-revoke" role="group" aria-label={t("取消授权 {{folder}}", { folder: folder.label })}>
        <p>{t("取消后不再读取这个文件夹。已读入的 {{count}} 个文件默认保留，计划和材料可能已用到它们。", { count: (folder.files ?? 0) + (folder.nameOnly ?? 0) })}</p>
        <div className="sf-actions">
          <button type="button" className="ob-btn secondary-button" disabled={busy} onClick={() => void revoke(folder.id, false)}>{t("取消授权，保留已读内容")}</button>
          <button type="button" className="ob-btn secondary-button" disabled={busy} onClick={() => void revoke(folder.id, true)}>{t("取消授权并删除已读内容")}</button>
          <button type="button" className="ob-btn ob-quiet secondary-button" disabled={busy} onClick={() => setRevoking(undefined)}>{t("返回")}</button>
        </div>
      </div>}
      {lines.length > 0 && folder.lastScanAt && <div className="source-folder-lines" role="group" aria-label={t("{{folder}} 属于哪些主线", { folder: folder.label })}>
        <small>{folder.linesBy === "person" ? t("属于") : folder.linesBy === "model" ? t("推测属于") : t("还没归到主线")}</small>
        {lines.map((line) => <button key={line.id} type="button" className="ob-chip" data-line={line.id} aria-pressed={folder.lines.includes(line.id)}
          onClick={() => void toggleLine(folder, line.id)}>{line.label}</button>)}
        {folder.linesBy === "model" && folder.linesWhy && <small className="gen">{folder.linesWhy}</small>}
      </div>}
      <FolderRules folder={folder} busy={busy} onSave={(exclude, include) => void saveRules(folder, exclude, include)} />
    </div>)}
    <form className="source-folders-form" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void look(); }}>
      <input value={draft} onChange={(event) => { setDraft(event.target.value); setPreview(undefined); }} placeholder={t("文件夹完整路径，如 D:\\课程资料")}
        aria-label={t("文件夹路径")} disabled={busy} spellCheck={false} />
      <button type="submit" className="ob-btn secondary-button" disabled={busy || !draft.trim()}>{busy && !preview ? t("查看中…") : t("查看")}</button>
    </form>
    {preview && chosen && <div className="source-folders-preview" role="status">
      <p><Bold text={[[t("将读取 <b>{{count}}</b> 个文件（共 {{size}}）", { count: Math.min(chosen.files, preview.limit), size: megabytes(chosen.bytes) }),
        ...(preview.nameOnly ? [t("另有 {{count}} 个只记文件名", { count: preview.nameOnly })] : [])].join(en ? ", " : "，"),
        ...(preview.duplicates ? [t("{{count}} 个相同副本只读一份", { count: preview.duplicates })] : []),
        ...(preview.skippedDirectories ? [t("跳过 {{count}} 个依赖、缓存或隐藏文件夹", { count: preview.skippedDirectories })] : []),
        ...(preview.truncated ? [t("文件夹太大，只看了前 20 万项")] : [])].join(en ? "; " : "；") + (en ? "." : "。")} /></p>
      {chosen.over > 0 && <div className="sf-over">
        <p><Bold text={t("超出上限 {{limit}} 个，多了 <b>{{over}}</b> 个。可以勾掉一些子文件夹，或只读最近改动的 {{limit}} 个。", { limit: preview.limit, over: chosen.over })} /></p>
        <label className="sf-check"><input type="checkbox" checked={recent} onChange={(event) => setRecent(event.target.checked)} />{t("只读最近改动的 {{limit}} 个", { limit: preview.limit })}</label>
      </div>}
      <ul className="sf-groups" aria-label={t("按子文件夹")}>
        {preview.groups.map((group) => <li key={group.name || "/"}>
          <label className="sf-check"><input type="checkbox" checked={!offGroups.has(group.name)} onChange={() => setOffGroups((set) => toggled(set, group.name))} />
            <span className="sf-name">{group.name || t("（文件夹本身的文件）")}</span>
            <small>{[t("{{count}} 个", { count: group.files }), megabytes(group.bytes), ...(group.nameOnly ? [t("{{count}} 个只记文件名", { count: group.nameOnly })] : [])].join(" · ")}</small></label>
          {!offGroups.has(group.name) && <details><summary>{t("逐个查看")}</summary><ul>
            {group.list.map((file) => <li key={file.relative}><label className="sf-check">
              <input type="checkbox" checked={!offFiles.has(file.relative)} onChange={() => setOffFiles((set) => toggled(set, file.relative))} />
              <span className="sf-name">{group.name ? file.relative.slice(group.name.length + 1) : file.relative}</span>
              <small>{file.nameOnly ? t("只记文件名") : megabytes(file.size)}{file.duplicates ? ` · ${t("另有 {{count}} 个相同副本", { count: file.duplicates })}` : ""}</small></label></li>)}
            {group.more > 0 && <li><small>{t("另有 {{count}} 个较早的文件未列出", { count: group.more })}</small></li>}
          </ul></details>}
        </li>)}
      </ul>
      {preview.sensitiveCount > 0 && <details className="sf-sensitive" open>
        <summary>{t("已自动排除（疑似敏感）{{count}} 个", { count: preview.sensitiveCount })}</summary>
        <ul>{preview.sensitive.map((file) => <li key={file.relative}><label className="sf-check">
          <input type="checkbox" checked={onSensitive.has(file.relative)} onChange={() => setOnSensitive((set) => toggled(set, file.relative))} />
          <span className="sf-name">{file.relative}</span><small>{t(file.reason)}</small></label></li>)}</ul>
      </details>}
      {preview.credentialCount > 0 && <details className="sf-sensitive" open>
        <summary>{t("凭据，永不读取：{{count}} 个", { count: preview.credentialCount })}</summary>
        <ul>{preview.credentials.map((file) => <li key={file.relative} className="sf-check">
          <span className="sf-name">{file.relative}</span><small>{t(file.reason)}</small></li>)}</ul>
      </details>}
      <button type="button" className="ob-btn primary-button" disabled={busy || chosen.files + preview.nameOnly === 0 || (chosen.over > 0 && !recent)} onClick={() => void authorize()}>{t("授权并读取")}</button>
    </div>}
    {message && <p role="status" className="muted">{message}</p>}
  </section>;
}

/** What an authorized folder leaves out: the person's exclusions, files left out as suspected private papers, and those ticked back. */
function FolderRules({ folder, busy, onSave }: { folder: SourceFolder; busy: boolean; onSave: (exclude: string[], include: string[]) => void }) {
  const t = useT();
  const [adding, setAdding] = useState("");
  const exclude = folder.exclude ?? [], include = folder.include ?? [];
  const auto = (folder.autoExcluded ?? []).filter((file) => !file.hard), credentials = (folder.autoExcluded ?? []).filter((file) => file.hard);
  if (!folder.lastScanAt && !exclude.length) return null;
  return <details className="sf-rules">
    <summary>{t("排除列表（{{count}}）", { count: exclude.length + auto.length + credentials.length })}</summary>
    {credentials.length > 0 && <><small>{t("凭据，永不读取：{{count}} 个", { count: credentials.length })}</small>
      <ul aria-label={t("凭据")}>{credentials.map((file) => <li key={file.relative}><span className="sf-name">{file.relative}</span><small>{t(file.reason)}</small></li>)}</ul></>}
    {exclude.length > 0 && <ul aria-label={t("本人排除")}>{exclude.map((pattern) => <li key={pattern}>
      <span className="sf-name">{pattern === "*" ? t("（文件夹本身的文件）") : pattern}</span>
      <button type="button" className="ob-btn ob-quiet secondary-button" disabled={busy} onClick={() => onSave(exclude.filter((item) => item !== pattern), include)}>{t("恢复读取")}</button></li>)}</ul>}
    {auto.length > 0 && <><small>{t("已自动排除（疑似敏感）{{count}} 个", { count: auto.length })}</small>
      <ul aria-label={t("自动排除")}>{auto.map((file) => <li key={file.relative}>
        <span className="sf-name">{file.relative}</span><small>{t(file.reason)}</small>
        <button type="button" className="ob-btn ob-quiet secondary-button" disabled={busy} onClick={() => onSave(exclude, [...include, file.relative])}>{t("仍然读取")}</button></li>)}</ul></>}
    {include.length > 0 && <><small>{t("已勾回读取")}</small>
      <ul aria-label={t("勾回读取")}>{include.map((relative) => <li key={relative}>
        <span className="sf-name">{relative}</span>
        <button type="button" className="ob-btn ob-quiet secondary-button" disabled={busy} onClick={() => onSave(exclude, include.filter((item) => item !== relative))}>{t("排除")}</button></li>)}</ul></>}
    <form className="source-folders-form" onSubmit={(event) => { event.preventDefault(); if (adding.trim()) { onSave([...exclude, adding.trim()], include); setAdding(""); } }}>
      <input value={adding} onChange={(event) => setAdding(event.target.value)} placeholder={t("子文件夹或文件，可用 *")} aria-label={t("添加排除")} disabled={busy} spellCheck={false} />
      <button type="submit" className="ob-btn secondary-button" disabled={busy || !adding.trim()}>{t("排除")}</button>
    </form>
  </details>;
}
