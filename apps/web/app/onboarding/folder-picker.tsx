"use client";

import { useEffect, useState } from "react";
import { useT } from "../locale-context";
import { canPickDirectory, folderFromInput, pickDirectory, type PickedFolder } from "./upload-queue";

/**
 * 「选择文件夹」: pressing it is the decision (2026-11-22, no preview to confirm). The folder goes to `onFolders`, which leaves out keys
 * and private papers by code, has the model screen the rest and uploads what it keeps. Where the browser has the system's folder dialog
 * (Chromium) it is used, one folder per press; elsewhere the `webkitdirectory` input. Several folders can also be dropped on the page.
 */
export function FolderPicker({ onFolders }: { onFolders: (folders: PickedFolder[]) => void }) {
  const t = useT();
  const [native, setNative] = useState(false);
  useEffect(() => { setNative(canPickDirectory()); }, []);
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
