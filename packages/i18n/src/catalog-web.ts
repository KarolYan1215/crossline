import { registerCatalog } from "./index";
import common from "../locales/en/common.json";
import core_a from "../locales/en/core-a.json";
import core_b from "../locales/en/core-b.json";
import web_settings from "../locales/en/web-settings.json";
import web_onboarding from "../locales/en/web-onboarding.json";
import web_plan from "../locales/en/web-plan.json";
import web_shell from "../locales/en/web-shell.json";
import web_lib from "../locales/en/web-lib.json";

/** The English the web reads (docs/i18n.md). Imported once, for its effect, at the web's entry. */
for (const catalog of [common, core_a, core_b, web_settings, web_onboarding, web_plan, web_shell, web_lib]) registerCatalog(catalog as Record<string, string>);
