import type {
  CollectionCondition,
  CollectionPreview,
  HoldReason,
  RuleProblem,
  SmartCollection,
} from "@core/collections";

/**
 * The automatic categories as the Hub's pages use them. The server builds
 * these (src/server/actions/collections.ts); client components import only
 * these types.
 */

export type { CollectionCondition, CollectionPreview, HoldReason, RuleProblem };

/** A collection with what the runs found about it. */
export interface CollectionView extends SmartCollection {
  /** Products in the category now (null: never counted). */
  members: number | null;
  /** Waiting for a confirmation: why, and what it would change. */
  held: { reason: HoldReason; joining: number; leaving: number } | null;
  /** "category_missing" | "loop" | the store's reason for refusing a product. */
  lastError: string | null;
  lastRunAt: string | null;
  updatedAt: string;
}

/** A product category to pick from. */
export interface CategoryOption {
  id: number;
  name: string;
  path: string;
  /** Its automatic collection, when it has one. */
  collectionId: string | null;
}

export interface TermOption {
  id: number;
  name: string;
  /** With its parents, for the hierarchical taxonomies. */
  path: string;
}

export interface AttributeOption {
  key: string;
  name: string;
  options: string[];
}

/** What the rule editor offers: the store's own terms, the attributes its products carry. */
export interface CollectionOptions {
  categories: CategoryOption[];
  tags: TermOption[];
  brands: TermOption[];
  attributes: AttributeOption[];
}

export interface IndexView {
  /** Products the index holds. */
  products: number;
  /** When a read last brought anything in (ISO). */
  lastSeen: string | null;
}

export interface RunnerView {
  running: "full" | "check" | "apply" | null;
  progress: { done: number; total: number | null } | null;
  queued: number;
  lastCheckAt: string | null;
  lastFullAt: string | null;
  lastError: string | null;
  /** False: the store ignores "modified after", only the daily full read picks changes up. */
  incremental: boolean | null;
  /** Minutes between automatic checks; 0 = only in the daily sync / by hand. */
  everyMinutes: number;
  /** The scheduler runs at all on this server. */
  scheduled: boolean;
  /** Most products an automatic run moves per category before asking. */
  maxChanges: number;
  /** Products the last decision moved. */
  lastMoved: number | null;
  /** The shop's time zone, for the times shown. */
  timeZone: string;
}

export interface ChangeView {
  id: string;
  at: string;
  collectionId: string | null;
  categoryName: string;
  productId: number;
  sku: string;
  productName: string;
  action: "add" | "remove";
  trigger: "auto" | "manual" | "product";
  error: string | null;
}

/** What the page polls while a run is going. */
export interface CollectionsStatus {
  configured: boolean;
  /** Working on the Vetrina's demo shop (VETRINA_SOURCE=fixture), not the real store. */
  demo: boolean;
  collections: CollectionView[];
  index: IndexView;
  runner: RunnerView;
  changes: ChangeView[];
}

export interface CollectionsState extends CollectionsStatus {
  options: CollectionOptions | null;
  /** Why the options could not be read from the store (it did not answer). */
  optionsError: string | null;
}

/** A rule as the editor sends it. */
export interface CollectionDraft {
  /** Absent: a new collection. */
  id?: string;
  /** The category it manages — or, for a new one, `newCategory`. */
  termId?: number;
  newCategory?: { name: string; parent: number };
  match: "all" | "any";
  conditions: CollectionCondition[];
  enabled: boolean;
}

/** What is wrong with a draft: the rule's own problems, or no category chosen. */
export type DraftProblem = RuleProblem | { kind: "noCategory" };

export interface DraftCheck {
  problems: DraftProblem[];
  preview: CollectionPreview | null;
}

/** The rule editor opened on one category: its rule (if it has one) and the choices. */
export interface TermEditor {
  view: CollectionView | null;
  options: CollectionOptions;
  /** Products the store index holds: none means nothing can be previewed yet. */
  indexProducts: number;
  demo: boolean;
}

/** A product's tags, as the product sheet edits them. */
export interface ProductTagsView {
  tags: TermOption[];
  /** Every tag on the store, offered as you type. */
  available: TermOption[];
  /** The automatic categories the product is in now (names). */
  inCollections: string[];
}

/** What saving a product's tags did. */
export interface ProductTagsResult {
  tags: TermOption[];
  /** Automatic categories it joined and left at once (names). */
  joined: string[];
  left: string[];
  /** The categories follow shortly: a longer run was going. */
  pending: boolean;
  /** The store refused the category change (the tags are saved). */
  error: string | null;
}

/** The automatic category behind a homepage rail, as the Vetrina shows it. */
export interface RailCollection {
  id: string;
  enabled: boolean;
  match: "all" | "any";
  conditions: CollectionCondition[];
  members: number | null;
  held: { reason: HoldReason; joining: number; leaving: number } | null;
  lastError: string | null;
}
