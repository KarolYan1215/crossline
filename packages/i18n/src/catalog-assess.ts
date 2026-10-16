import { registerCatalog } from "./index";
import common from "../locales/en/common.json";
import core_a from "../locales/en/core-a.json";
import core_b from "../locales/en/core-b.json";
import assess from "../locales/en/assess.json";

/** The English the assess reads (docs/i18n.md). Imported once, for its effect, at the assess's entry. */
for (const catalog of [common, core_a, core_b, assess]) registerCatalog(catalog as Record<string, string>);
