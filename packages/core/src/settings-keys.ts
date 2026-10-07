/**
 * Setting keys read by both the web app and the worker. A key spelled in two places drifts: the plan
 * explainer read `goal.<id>` while the web app wrote `goal.settings:<id>`, so the explainer never saw a
 * goal marked important or a confirmed deadline. One builder, imported by both sides.
 */
export const goalSettingKey = (milestoneId: string) => `goal.settings:${milestoneId}`;
