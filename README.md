# jogja-cctv-viewer

Live public CCTV viewer for Yogyakarta, Indonesia — camera grid, map, and video wall.

## Two editions, one codebase

| File | Use |
| --- | --- |
| `index.html` | Modular page. Loads small, cacheable files from `assets/`. Best for GitHub Pages / normal hosting. |
| `standalone.html` | Single-file build with everything inlined. Best for copying to a USB stick or opening offline. |

Both share the same source — edit the modular files, then rebuild the single file.

## Layout

```
index.html                  Page markup (no inline CSS/JS)
assets/css/styles.css       All styles, including the fullscreen wall
assets/js/data.js           GROUPS + CAMS dataset (681 cameras)
assets/js/app.js            Viewer logic (players, wall, map, recording…)
assets/vendor/              HatchMaps, MapHelpers, hls.js (decoded from the old base64 blobs)
assets/vendor/maplibre-gl.css
tools/build-standalone.mjs  Inlines everything into standalone.html
tools/extract-monolith.mjs  One-time splitter for the old single file
```

## Commands

```powershell
npm run build        # regenerate standalone.html from the modular files
npm run split-legacy # re-split a monolithic index.html (only needed once)
```

No dependencies — Node 18+ is enough.

## Fullscreen wall

The page wall keeps its rounded 2×2 / 3×3 / 4×4 presets. Fullscreen is
edge-to-edge (no padding, gaps, borders, or rounded corners) and **unlimited**:
`Add camera` / `Add row` append more tiles and the grid scrolls. On exit, extra
tiles fold back into the nearest page preset (up to 4×4).
