"use client";

import { useEffect, useState } from "react";
import { useT } from "../locale-context";
import { DesktopBridgeError, FOLDERS_CHANGED_EVENT, useDesktopShell, type DesktopShell } from "../../lib/desktop-bridge";
import { canPickDirectory, folderFromInput, pickDirectory, type PickedFolder } from "./upload-queue";

/**
 * 「选择文件夹」: pressing it is the decision (2026-11-22, no preview to confirm). The folder goes to `onFolders`, which leaves out keys
 * and private papers by code, has the model screen the rest and uploads what it keeps. Where the browser has the system's folder dialog
 * (Chromium) it is used, one folder per press; elsewhere the `webkitdirectory` input. Several folders can also be dropped on the page.
 *
 * In the installed copy's own window (docs/plans/desktop-window-1123.md) the system's folder dialog gives the real path, and the folder is
 * authorized as it is instead of uploaded: the worker leaves out keys and private papers by its rules, the model screens the rest by name
 * and only what it keeps is read in (the person's decision of 2026-11-23).
 */
export function FolderPicker({ onFolders, onAuthorized }: { onFolders: (folders: PickedFolder[]) => void; onAuthorized?: () => void }) {
  const t = useT();
  const shell = useDesktopShell();
  const [native, setNative] = useState(false);
  useEffect(() => { setNative(canPickDirectory()); }, []);
  if (shell) return <AuthorizeFolder shell={shell} onAuthorized={onAuthorized} />;
  const hint = <small>{t("选中就上传；密钥和私人证件单据不会上传，其余由模型挑出值得读的")}</small>;
  if (native) return <button type="button" className="ob-drop" onClick={() => void pickDirectory().then((folder) => { if (folder) onFolders([folder]); })}>
    <b>{t("选择文件夹")}</b>{hint}
  </button>;
  return <label className="ob-drop">
    {/* `webkitdirectory` is not in React's typings; every current browser supports it. */}
    <input type="file" multiple hidden {...{ webkitdirectory: "", directory: "" }}
      onChange={(event) => { const folder = folderFromInput(event.target.files); event.target.value = ""; if (folder) onFolders([folder]); }} />
    <b>{t("选择文件夹")}</b>{hint}
  </label>;
}

/** The window's 「选择文件夹」: the system dialog, then the folder authorized by its path. */
function AuthorizeFolder({ shell, onAuthorized }: { shell: DesktopShell; onAuthorized: (() => void) | undefined }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const pick = async () => {
    setNote("");
    const path = await shell.pickFolder(t("选择要授权给 Crossline 的文件夹")).catch((error: unknown) => {
      setNote(error instanceof DesktopBridgeError && error.code === "DESKTOP_BUSY" ? t("已经打开了一个选文件夹的窗口。") : t("没能打开选文件夹的窗口。"));
      return undefined;
    });
    if (!path) return;
    setBusy(true);
    const response = await fetch("/api/sources/folders", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add", path }) }).catch(() => undefined);
    const answer = await response?.json().catch(() => undefined) as { state?: string; message?: string } | undefined;
    setBusy(false);
    if (answer?.state !== "added") { setNote(answer?.message ?? t("后台服务没有连上，稍后再试。")); return; }
    setNote(t("已授权「{{name}}」，正在后台读取。", { name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path }));
    window.dispatchEvent(new Event(FOLDERS_CHANGED_EVENT));
    onAuthorized?.();
  };
  return <>
    <button type="button" className="ob-drop" disabled={busy} onClick={() => void pick()}>
      <b>{busy ? t("正在授权…") : t("选择文件夹")}</b>
      <small>{t("选中就授权：先按规则跳过密钥和私人证件单据，再由模型按文件名挑出值得读的导入")}</small>
    </button>
    {note && <p className="ob-muted" role="status">{note}</p>}
  </>;
}
