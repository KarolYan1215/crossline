import "server-only";
import type { AccessContext } from "@crossline/core";
// The `./capability` subpath, not the package root: the root entry pulls in the Codex sidecar-spawning
// code, and the web app must never spawn Codex itself — only ask the worker's supervisor over HTTP
// (`apps/web/app/api/captures/[id]/analyze/route.test.ts` enforces this by mocking the root specifier
// to throw). `capability.ts` has no such dependency, so it gets its own export.
import { signCapability } from "@crossline/codex/capability";

export type CodexBlocker = { code: string; message: string };

export class CodexSupervisorRequestError extends Error {
  constructor(readonly status: number, readonly blocker: CodexBlocker) {
    super(blocker.message);
  }
}

function supervisorUrl(): URL {
  const url = new URL(process.env.CROSSLINE_CODEX_SUPERVISOR_URL ?? "http://127.0.0.1:3211");
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) {
    throw new CodexSupervisorRequestError(503, {
      code: "CODEX_SUPERVISOR_URL_NOT_LOOPBACK",
      message: "Codex supervisor URL must use loopback"
    });
  }
  return url;
}

/**
 * The supervisor's own boot id, needed to sign a capability the worker will accept (see
 * `packages/codex/src/capability.ts`). `/v1/codex/status` is the one route left uncapability-gated for
 * exactly this reason — everything else needs a token stamped with this value first.
 */
async function fetchSupervisorBootId(): Promise<string> {
  const response = await fetch(new URL("/v1/codex/status", supervisorUrl()), {
    cache: "no-store", signal: AbortSignal.timeout(5_000)
  }).catch(() => undefined);
  const body = await response?.json().catch(() => undefined) as { supervisorBootId?: unknown } | undefined;
  if (!response?.ok || typeof body?.supervisorBootId !== "string") {
    throw new CodexSupervisorRequestError(503, {
      code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex supervisor is unavailable"
    });
  }
  return body.supervisorBootId;
}

export async function requestCodexSupervisor<T>(ctx: AccessContext, pathname: string, init?: RequestInit): Promise<T> {
  try {
    const secret = process.env.CROSSLINE_SUPERVISOR_CAPABILITY_SECRET;
    if (!secret) {
      throw new CodexSupervisorRequestError(503, {
        code: "CAPABILITY_SECRET_MISSING", message: "CROSSLINE_SUPERVISOR_CAPABILITY_SECRET is not configured"
      });
    }
    const supervisorBootId = await fetchSupervisorBootId();
    const method = init?.method ?? "GET";
    const capability = signCapability({
      principalId: ctx.principalId, workspaceId: ctx.workspaceId, role: ctx.role,
      operation: `${method} ${pathname}`, requestId: ctx.requestId, supervisorBootId
    }, secret);
    const response = await fetch(new URL(pathname, supervisorUrl()), {
      ...init,
      headers: { ...init?.headers, "x-crossline-capability": capability },
      cache: "no-store",
      signal: init?.signal ?? AbortSignal.timeout(5_000)
    });
    const body = await response.json() as { blocker?: CodexBlocker } & T;
    if (!response.ok) {
      throw new CodexSupervisorRequestError(response.status, body.blocker ?? {
        code: "CODEX_SUPERVISOR_REQUEST_FAILED",
        message: "Codex supervisor request failed"
      });
    }
    return body;
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) throw error;
    throw new CodexSupervisorRequestError(503, {
      code: "CODEX_SUPERVISOR_UNAVAILABLE",
      message: "Codex supervisor is unavailable"
    });
  }
}
