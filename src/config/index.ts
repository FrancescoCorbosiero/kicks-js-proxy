import rawConfig from "./hub.config";
import { HubConfigSchema, type BlockConfig, type HubConfig } from "./schema";

/**
 * The validated Hub configuration. Pure data, no env reads — safe to import
 * from client components (the nav) as well as the server.
 */
export const hubConfig: HubConfig = HubConfigSchema.parse(rawConfig);

const HIDDEN: BlockConfig = { show: "hidden", edit: { pins: false, exclude: false, fallback: false } };

/** How the Vetrina treats a block type: its own entry, else "*", else hidden. */
export function blockConfig(blockName: string, config: HubConfig = hubConfig): BlockConfig {
  return config.vetrina.blocks[blockName] ?? config.vetrina.blocks["*"] ?? HIDDEN;
}

export type { BlockConfig, HubConfig, RailFallback } from "./schema";
export { RAIL_FALLBACKS } from "./schema";
