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
import rituals from "../locales/en/rituals.json";
import redesign_today from "../locales/en/redesign-today.json";
import redesign_tasks from "../locales/en/redesign-tasks.json";
import redesign_plan from "../locales/en/redesign-plan.json";
import redesign_settings from "../locales/en/redesign-settings.json";
import redesign_rituals from "../locales/en/redesign-rituals.json";
import month_sim from "../locales/en/month-sim.json";
import fixes_1029 from "../locales/en/fixes-1029.json";
import closed_loop from "../locales/en/closed-loop.json";
import concierge_settings from "../locales/en/concierge-settings.json";

/** Every English catalogue, for the web app and the worker (server-side size does not matter; the web's client reads the same set). */
export const ALL_CATALOGS = [common, core_a, core_b, assess, web_settings, web_onboarding, web_plan, web_shell, web_tasks, web_lib, worker, task_import, rituals, redesign_today, redesign_tasks, redesign_plan, redesign_settings, redesign_rituals, month_sim, fixes_1029, closed_loop, concierge_settings] as Array<Record<string, string>>;
