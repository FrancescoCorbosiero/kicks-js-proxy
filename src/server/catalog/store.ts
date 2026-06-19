import "server-only";
import type { CatalogStore } from "./service";
import { getFreshBySkus, upsertCatalog } from "./repo";

/** DB-backed CatalogStore used in production (tests inject a fake). */
export const dbCatalogStore: CatalogStore = {
  getFresh: getFreshBySkus,
  upsert: upsertCatalog,
};
