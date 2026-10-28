import common from "../locales/en/common.json";
import core_a from "../locales/en/core-a.json";
import core_b from "../locales/en/core-b.json";
import assess from "../locales/en/assess.json";
import web_settings from "../locales/en/web-settings.json";
import web_onboarding from "../locales/en/web-onboarding.json";
import web_plan from "../locales/en/web-plan.json";
import web_shell from "../locales/en/web-shell.json";
import web_tasks from "../locales/en/web-tasks.json";
import web_lib from "../locales/en/web-lib.json";
import worker from "../locales/en/worker.json";
import task_import from "../locales/en/import.json";

/** Every English catalogue, for the web app and the worker (server-side size does not matter; the web's client reads the same set). */
export const ALL_CATALOGS = [common, core_a, core_b, assess, web_settings, web_onboarding, web_plan, web_shell, web_tasks, web_lib, worker, task_import] as Array<Record<string, string>>;
