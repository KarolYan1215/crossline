import { spawnAppServerLines } from "@crossline/codex";
import type { AppServerLines } from "./agent";

/** A linked device's own Codex runtime for the compute node: the checkout's binary and this machine's Codex login (docs/compute-node.md). */
export const localAppServer = (): AppServerLines => spawnAppServerLines();
