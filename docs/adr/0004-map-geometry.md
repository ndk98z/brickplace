# 0004. Map geometry: 2048², tiles of 256, regions of 1024

- Status: accepted; map size and open area amended by 0027 (1024², 512² start, step 128)
- Date: 2026-10-23

## Context

r/place ran on 1000² to about 3000×2000 canvases with 5-minute cooldowns. BrickPlace places
four cells per brick every 60 s, so a 5000² map would stay empty at small scale.

## Decision

- Map 2048×2048 at launch; the maximum only grows, in powers of two (4096², 8192²).
- Tiles of 256×256 (64 tiles): the unit clients download and subscribe to.
- Regions of 1024×1024 (4 regions): the unit a MapShardDO will own; each holds exactly 4×4 tiles.
- The open area starts at 1024×1024 in the centre and grows 256 cells per side.
- A cell index fits in 22 bits; one byte per cell (filled, 5-bit colour, 2 link bits) plus one
  byte of shield layers.

## Consequences

Every boundary aligns, so no tile spans two regions. At large scale the cooldown and open
area must scale with concurrent players, or the map grows; at 1M CCU a fixed 2048² map would
fill in about 2 minutes.
