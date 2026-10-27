import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { handleSourceFolderRequest, readJsonBody, sendJson, type SourceFolderHandlers } from "@crossline/codex";
import { verifyCapability } from "@crossline/codex/capability";
import { tFor, type Locale } from "@crossline/core";

/**
 * A linked device's loopback server (docs/device-mode.md), on the port the supervisor would use, so the local web app's `/device` page
 * works unchanged: the folder routes (the folders are on this machine), the link itself, and the speech model's status and one-time
 * download. Everything else — every route that would run a model — answers `DEVICE_MODE`: there is no Codex here to run it.
 *
 * Every route but the status one checks the same capability token the supervisor does (signed by the web app with the shared secret),
 * so nothing else on the loopback can drive it.
 */
export type DeviceServerOptions = {
  port: number;
  host?: string;
  capabilitySecret: string | undefined;
  folders: SourceFolderHandlers;
  link: { handle: (method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined) => Promise<{ status: number; body: unknown } | undefined> };
  transcription: { status: () => Promise<unknown>; download: () => Promise<unknown> };
  /** The workspace's language, for the few answers this server words itself (docs/i18n.md). */
  locale?: (workspaceId: string) => Locale | undefined;
};

export function startDeviceServer(options: DeviceServerOptions): Promise<{ server: Server; url: string; bootId: string; stop: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const bootId = randomUUID();
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
    try {
      if (request.method === "GET" && pathname === "/v1/codex/status") { sendJson(response, 200, { state: "device", supervisorBootId: bootId }); return; }
      let workspaceId = "";
      if (options.capabilitySecret) {
        const verified = verifyCapability(request.headers["x-crossline-capability"] as string | undefined, options.capabilitySecret,
          { operation: `${request.method} ${pathname}`, supervisorBootId: bootId });
        if (!verified.ok) { sendJson(response, 401, { blocker: { code: verified.code, message: "Use the local Web API" } }); return; }
        workspaceId = verified.capability.workspaceId;
      }
      if (pathname.startsWith("/v1/sources/folders") && await handleSourceFolderRequest(request, response, pathname, workspaceId, options.folders)) return;
      if (pathname === "/v1/device/link" || pathname === "/v1/device/node") {
        const method = request.method ?? "GET";
        if (method !== "GET" && request.headers.origin) { sendJson(response, 403, { blocker: { code: "SYNC_REQUEST_FORBIDDEN", message: "Use the local Web API" } }); return; }
        const answer = await options.link.handle(method, pathname, workspaceId, method === "GET" ? undefined : await readJsonBody(request).catch(() => undefined));
        if (answer) { sendJson(response, answer.status, answer.body); return; }
      }
      if (request.method === "GET" && pathname === "/v1/transcription/status") { sendJson(response, 200, await options.transcription.status()); return; }
      if (request.method === "POST" && pathname === "/v1/transcription/download") {
        if (request.headers.origin) { sendJson(response, 403, { blocker: { code: "SYNC_REQUEST_FORBIDDEN", message: "Use the local Web API" } }); return; }
        sendJson(response, 200, await options.transcription.download());
        return;
      }
      sendJson(response, 404, { blocker: { code: "DEVICE_MODE", message: tFor(options.locale?.(workspaceId))("这台电脑是网页版账号的设备：模型工作在网页版进行。") } });
    } catch {
      sendJson(response, 500, { blocker: { code: "DEVICE_SERVER_FAILED", message: tFor(undefined)("没有完成这次操作") } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({ server, url: `http://${host}:${port}`, bootId, stop: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
