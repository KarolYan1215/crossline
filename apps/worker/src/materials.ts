import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { CrosslineStore } from "@crossline/db";

type MaterialFile = { relativePath: string; content: string; mediaType: string; sourceRefs: string[] };
type MaterialResult = { ok: true; artifacts: Array<{ uri: string; mediaType: string; sourceRefs: string[]; createdAt: string }> }
  | { ok: false; blocker: { code: string; message: string } };

const blocked = (code: string, message: string): MaterialResult => ({ ok: false, blocker: { code, message } });

export function persistPreparedMaterials(store: CrosslineStore, input: {
  workspaceId: string; ownerId: string; workOrderId: string; projectRoot?: string; files: MaterialFile[];
}): MaterialResult {
  if (!input.projectRoot || !path.isAbsolute(input.projectRoot)) {
    return blocked("MATERIAL_PROJECT_ROOT_REQUIRED", "材料准备需要已授权的绝对项目根目录；你仍可人工自备材料。");
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.workOrderId)) {
    return blocked("MATERIAL_PATH_OUTSIDE_ROOT", "材料路径越出获准目录；没有写入文件。");
  }
  const order = store.listWorkOrders(input.workspaceId).find((item) => item.id === input.workOrderId);
  if (!order || order.state !== "preparing") return blocked("MATERIALS_NOT_PREPARING", "作业当前不在材料准备阶段。");
  const root = path.resolve(input.projectRoot, ".crossline-materials", input.workOrderId);
  const outputs: Array<{ uri: string; mediaType: string; sourceRefs: string[]; createdAt: string }> = [];
  try {
    for (const file of input.files) {
      const target = path.resolve(root, file.relativePath);
      const relative = path.relative(root, target);
      if (!file.relativePath || path.isAbsolute(file.relativePath) || relative.startsWith("..") || path.isAbsolute(relative)) {
        return blocked("MATERIAL_PATH_OUTSIDE_ROOT", "材料路径越出获准目录；没有写入文件。");
      }
      if (existsSync(target) && readFileSync(target, "utf8") !== file.content) {
        return blocked("MATERIAL_ALREADY_EXISTS", "同名材料已存在且内容不同；没有覆盖。");
      }
    }
    mkdirSync(root, { recursive: true });
    for (const file of input.files) {
      const target = path.resolve(root, file.relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      if (!existsSync(target)) writeFileSync(target, file.content, "utf8");
      const artifact = { uri: pathToFileURL(target).href, mediaType: file.mediaType,
        sourceRefs: file.sourceRefs, createdAt: new Date().toISOString() };
      store.saveMaterial({ id: randomUUID(), ownerId: input.ownerId, workspaceId: input.workspaceId,
        workOrderId: input.workOrderId, ...artifact });
      outputs.push(artifact);
    }
    store.transitionWorkOrder(input.workspaceId, input.workOrderId, { type: "materials.ready" },
      `materials-ready:${input.workOrderId}:ai`);
    return { ok: true, artifacts: outputs };
  } catch {
    return blocked("MATERIAL_PREPARATION_FAILED", "材料准备失败；你仍可人工自备材料。");
  }
}
