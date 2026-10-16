import { providerSummary } from "./provider";

/**
 * The image settings, said once per process in the server log (`avatar.provider`: the service, model and size chosen, or why there is
 * none; never the key), so a missing or wrong provider is visible without a test draw. Called at start by `instrumentation.ts` and again,
 * as a no-op, by the pipeline. The flag lives on `globalThis` so every bundle of the one server process shares it.
 */
export function announceAvatarProvider(): void {
  const flags = globalThis as { __assessAvatarAnnounced?: boolean };
  if (flags.__assessAvatarAnnounced) return;
  flags.__assessAvatarAnnounced = true;
  console.info(JSON.stringify({ event: "avatar.provider", ...providerSummary() }));
}
