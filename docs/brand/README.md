# Brand assets

The BrickPlace mark is a small wall of bricks in running bond, in the four logo colours
(`#ff6b3d`, `#3d7bff`, `#ffd23f`, `#2bb673`); no two touching bricks share a colour. The name,
logo and icons are reserved, see [TRADEMARKS.md](../../TRADEMARKS.md).

| File                      | Use                                                           |
| ------------------------- | ------------------------------------------------------------- |
| `logo-mark.svg`           | Header and dialogs, beside the "BrickPlace" wordmark          |
| `favicon.svg`             | Browser tab: two rows, bigger bricks, readable at 16 px       |
| `app-icon.svg`            | Web app manifest, social avatars (dark rounded tile)          |
| `app-icon-full-bleed.svg` | Apple touch icon and stores that round the corners themselves |
| `lockup.svg`              | Mark + wordmark on light backgrounds (ink `#171b26`)          |
| `lockup-white.svg`        | Mark + wordmark on dark backgrounds                           |
| `lockup-dark-tile.svg`    | Mark + wordmark on its own dark tile, for any background      |

The wordmark is Fredoka 700 converted to outlines, so the lockups need no font installed.

`png/` holds square exports of each at common sizes (`<name>-<px>.png`, transparent outside
the tile). The client serves `logo.svg`, `favicon.svg`, `favicon.ico` (16/32/48),
`icon-192.png`, `icon-512.png` and `apple-touch-icon.png` (180) from `apps/client/public/`;
they are copies of these files, so change both together.
