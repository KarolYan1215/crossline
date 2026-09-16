import "server-only";

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

export async function requestCodexSupervisor<T>(pathname: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(new URL(pathname, supervisorUrl()), {
      ...init,
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
