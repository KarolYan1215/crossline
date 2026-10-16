import { registerCatalog } from "./index";
import { ALL_CATALOGS } from "./catalog-all";

/** The English the worker writes (notifications, asks, messages to the person). Imported once, for its effect, at the worker's entry. */
for (const catalog of ALL_CATALOGS) registerCatalog(catalog);
