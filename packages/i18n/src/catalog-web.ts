import { registerCatalog } from "./index";
import { ALL_CATALOGS } from "./catalog-all";

/** The English the web reads (docs/i18n.md). Imported once, for its effect, at the web's entry. */
for (const catalog of ALL_CATALOGS) registerCatalog(catalog);
