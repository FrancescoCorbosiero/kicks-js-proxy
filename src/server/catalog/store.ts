import "server-only";
import type { CatalogStore } from "./service";
import { getFreshBySkus, getAnyBySkus, upsertCatalog, countCatalog } from "./repo";

/** DB-backed CatalogStore used in production (tests inject a fake). */
export const dbCatalogStore: CatalogStore = {
  getFresh: getFreshBySkus,
  getAny: getAnyBySkus,
  upsert: upsertCatalog,
  count: countCatalog,
};
