/**
 * What a reset keeps: the machine-owner mark (`deployment.runtimeOwner`), the model connection (`model.provider`, the worker's
 * `MODEL_PROVIDER_SETTING`, and its `model.provider.*` events), the monthly cap of a pay-per-use login, and the person's own computer:
 * the compute node's pairing, switch and token (`node.*`) and the linked device's token (`device.token.sha256`). On the hosted site the
 * node is the model connection, and a reset that dropped it left the interview with no model (W-227, 2026-11-06).
 */
export const RESET_KEEPS = { settingPrefixes: ["deployment.", "model.provider", "model.budget", "model.sponsor", "node.", "device.token"], eventTypePrefixes: ["model.provider"] };
