import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { CrosslineStore } from "@crossline/db";

type MaterialFile = { relativePath: string; content: string; mediaType: string; sourceRefs: string[] };
type SingleMaterialResult = { ok: true; artifact: { uri: string; mediaType: string; sourceRefs: string[]; createdAt: string } }
  | { ok: false; blocker: { code: string; message: string } };

/** Pure check, no filesystem writes — resolves `file` against `root` and refuses anything that would
 * land outside it or silently overwrite different content. Shared by `persistPreparedMaterials` (which
 * checks every file before writing any of them) and `persistAssistantMaterial` (one file) so the actual
 * safety property — path containment — exists in exactly one place. */
function checkContainment(root: string, file: MaterialFile):
  { ok: true; target: string } | { ok: false; blocker: { code: string; message: string } } {
  const target = path.resolve(root, file.relativePath);
  const relative = path.relative(root, target);
  if (!file.relativePath || path.isAbsolute(file.relativePath) || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, blocker: { code: "MATERIAL_PATH_OUTSIDE_ROOT", message: "材料路径越出获准目录；没有写入文件。" } };
  }
  if (existsSync(target) && readFileSync(target, "utf8") !== file.content) {
    return { ok: false, blocker: { code: "MATERIAL_ALREADY_EXISTS", message: "同名材料已存在且内容不同；没有覆盖。" } };
  }
  return { ok: true, target };
}

function writeChecked(target: string, content: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existsSync(target)) writeFileSync(target, content, "utf8");
}

/**
 * The assistant widget's "save this as a task material" sink — deliberately narrower than
 * `persistPreparedMaterials`: no `order.state === "preparing"` requirement (a snippet saved mid-chat is
 * an incremental addition, not "material prep for this order is now complete") and no
 * `materials.ready` transition (that event means prep finished, which this is not). Shares the exact
 * same path-containment check and the same `<data>/materials/<workOrderId>/` confinement as every
 * other material write in this app, via `checkContainment`/`writeChecked`.
 */
export function persistAssistantMaterial(store: CrosslineStore, input: {
  workspaceId: string; ownerId: string; workOrderId: string; /** The folder that holds one folder per work order. */ materialsDir?: string; file: MaterialFile;
}): SingleMaterialResult {
  if (!input.materialsDir || !path.isAbsolute(input.materialsDir)) {
    return { ok: false, blocker: { code: "MATERIAL_PROJECT_ROOT_REQUIRED", message: "需要已授权的绝对材料目录；未保存。" } };
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.workOrderId)) {
    return { ok: false, blocker: { code: "MATERIAL_PATH_OUTSIDE_ROOT", message: "材料路径越出获准目录；没有写入文件。" } };
  }
  const order = store.getWorkOrder(input.workspaceId, input.workOrderId);
  if (!order) return { ok: false, blocker: { code: "WORK_ORDER_NOT_FOUND", message: "找不到该作业。" } };
  const root = path.resolve(input.materialsDir, input.workOrderId);
  try {
    const checked = checkContainment(root, input.file);
    if (!checked.ok) return { ok: false, blocker: checked.blocker };
    mkdirSync(root, { recursive: true });
    writeChecked(checked.target, input.file.content);
    const artifact = { uri: pathToFileURL(checked.target).href, mediaType: input.file.mediaType,
      sourceRefs: input.file.sourceRefs, createdAt: new Date().toISOString() };
    store.saveMaterial({ id: randomUUID(), ownerId: input.ownerId, workspaceId: input.workspaceId,
      workOrderId: input.workOrderId, ...artifact });
    return { ok: true, artifact };
  } catch {
    return { ok: false, blocker: { code: "MATERIAL_PREPARATION_FAILED", message: "保存失败。" } };
  }
}
