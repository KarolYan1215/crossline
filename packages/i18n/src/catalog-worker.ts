import { registerCatalog } from "./index";
import common from "../locales/en/common.json";
import core_a from "../locales/en/core-a.json";
import core_b from "../locales/en/core-b.json";
import worker from "../locales/en/worker.json";

/** The English the worker reads (docs/i18n.md). Imported once, for its effect, at the worker's entry. */
for (const catalog of [common, core_a, core_b, worker]) registerCatalog(catalog as Record<string, string>);
