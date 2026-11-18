/**
 * What a reset keeps: the machine-owner mark (`deployment.runtimeOwner`), the model connection (`model.provider`, the worker's
 * `MODEL_PROVIDER_SETTING`, and its `model.provider.*` events), the monthly cap of a pay-per-use login, and the person's own computer:
 * the compute node's pairing, switch and token (`node.*`) and the linked device's token (`device.token.sha256`). On the hosted site the
 * node is the model connection, and a reset that dropped it left the interview with no model (W-227, 2026-11-06).
 *
 * The calendar writers' setup and records stay too (2026-11-17): which paths are on and the Microsoft account (`calendar.write.*`), what
 * each path wrote (`calendar.published`, `calendar.published.google`, `calendar.imip.*`) and the feed's token (`calendar.feed.*`). A reset
 * that dropped the records left every event already written on the person's calendars with nothing that knew it was Crossline's — never
 * moved or removed again, and written a second time by the next plan. Kept, the next publish sees the emptied plan and withdraws them
 * under the writers' usual rules: only its own events, never one the person changed, only those still to come.
 */
export const RESET_KEEPS = {
  settingPrefixes: ["deployment.", "model.provider", "model.budget", "model.sponsor", "node.", "device.token",
    "calendar.write.", "calendar.published", "calendar.imip.", "calendar.feed."],
  eventTypePrefixes: ["model.provider"]
};
