import type { IncomingMessage, ServerResponse } from "node:http";

export declare const BUSY_BODY: string;
export declare function busy(response: ServerResponse): void;
export declare function createLine(options: {
  limit: number;
  memoryHigh?: () => boolean;
  maxQueued?: number;
  maxWaitMs?: number;
  slotMaxMs?: number;
  record?: (route: string, waitedMs: number, servedMs: number) => void;
  log?: (event: Record<string, unknown>) => void;
  routeOf?: (url: string | undefined) => string;
}): {
  inLine: (request: Pick<IncomingMessage, "url">, response: ServerResponse, work: () => unknown) => void;
  state: () => { active: number; waiting: number };
};
