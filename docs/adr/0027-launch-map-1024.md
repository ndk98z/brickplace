# 0027. Launch map 1024², opening from 512² in steps of 128

- Status: accepted
- Date: 2026-10-25
- Amends: 0004 (map size and open area), 0013 (default growth step)

## Context

ADR 0004 set a 2048² map opening from 1024² and growing 256 cells a side at 70% fill. At
launch the player count is unknown and likely small; 4.2 M cells would look empty for a long
time, which is the failure ADR 0004 itself warns about for larger maps. The size is pinned in
each canvas's stored config when the canvas is created (`initialConfig`). No production canvas
exists yet, so this is the cheap moment to change it; staging ran 2048² code for a day, and a
canvas it created then is replaced by a new one (a season canvas, ADR 0021), not resized.

## Decision

- Map 1024×1024 at launch (`DEFAULT_MAP_SIZE`); the maximum still only grows in powers of
  two, now 2048² then 4096², and only between seasons (a new canvas per season, ADR 0021).
- The open area starts at 512×512 in the centre (`DEFAULT_OPEN_EDGE`) and grows 128 cells a
  side at 70% fill (`DEFAULT_OPEN_GROWTH`): 512² → 768² → 1024².
- Tiles stay 256² (16 tiles) and regions 1024² (one region): boundaries still align, and the
  sharding unit does not change.

The proportions are those of ADR 0004 at half the edge (start at half the edge, step an
eighth), so `tools/sim`'s season pacing carries over per player density: the same pacing
needs a quarter of the players.

## Consequences

- Fewer players fill the map; the grid in CanvasDO is about 2 MiB instead of 8 MiB, and
  initial-grid sends and checkpoints shrink by four. The overview stays 512², at factor 2.
- Capacity is a quarter of ADR 0004's: a busy first season fills sooner and fights harder.
  The answer is a larger map next season, not resizing a live canvas.
- The client still builds its map store from `DEFAULT_MAP_SIZE`. Over the CDN it refuses a
  map of another size; over the socket it only warns, after drawing the grid with the wrong
  stride. Changing the default again needs a new season's canvas and a client release
  together, and the socket path should then refuse a mismatch too.
