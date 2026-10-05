/**
 * What the dock shows on its stations, live. Every field is best-effort: null
 * means "couldn't tell", and the station simply shows no number.
 */
export interface DockStatus {
  /** Products in the catalog. */
  catalog: number | null;
  /** Catalog products the store doesn't carry yet — the Publish step's work. */
  toPublish: number | null;
  /** Orders still to fulfil (local status new or processing). */
  openOrders: number | null;
  /** When the last live sync wrote to the store (ISO), else null. */
  lastSyncAt: string | null;
  /** A store pull is advancing right now. */
  pulling: boolean;
}

export const EMPTY_DOCK_STATUS: DockStatus = {
  catalog: null,
  toPublish: null,
  openOrders: null,
  lastSyncAt: null,
  pulling: false,
};
