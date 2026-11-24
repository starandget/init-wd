import bundledFeatured from "../../catalog/featured.json";
import type { FeaturedApp, FeaturedCatalog } from "@/types";

export const APP_POOL_CATALOG = bundledFeatured as FeaturedCatalog;
export const APP_POOL: FeaturedApp[] = APP_POOL_CATALOG.apps;

const starterPackGroups = APP_POOL_CATALOG.starter_pack ?? [];

export const STARTER_PACK_CATEGORIES: string[] = starterPackGroups.map(
  (g) => g.group
);

const poolById = new Map<string, FeaturedApp>(
  APP_POOL.map((app) => [app.id, app])
);

/**
 * 「新机启航」初始装机清单：完全由 catalog/featured.json 的 starter_pack 驱动。
 */
export const STAR_VAULT_APPS: FeaturedApp[] = starterPackGroups.flatMap(
  (section) =>
    section.apps.flatMap((poolId) => {
      const base = poolById.get(poolId);
      if (!base) return [];
      return [
        {
          ...base,
          category: section.group,
        },
      ];
    })
);
