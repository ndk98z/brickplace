/** Default map edge in cells (ADR 0027). Grows in powers of two (2048, 4096) between seasons. */
export const DEFAULT_MAP_SIZE = 1024;
/** Edge of the open area a new canvas starts with, centred on the map (ADR 0027). */
export const DEFAULT_OPEN_EDGE = 512;
/** Edge of a tile, the unit clients download and subscribe to. */
export const TILE_SIZE = 256;
/** Edge of a region, the unit a MapShardDO will own once the core is sharded. */
export const REGION_SIZE = 1024;
/** The palette has exactly 32 colours so a colour fits in 5 bits. */
export const PALETTE_SIZE = 32;
export const DEFAULT_MAX_SHIELD = 5;
/** A shield layer expires 48 hours after it was placed (ADR 0007), in op log time (ms). */
export const DEFAULT_SHIELD_LIFETIME = 48 * 60 * 60 * 1000;
/** Hard ceiling: shields are stored in one byte per cell. */
export const SHIELD_CEILING = 255;
