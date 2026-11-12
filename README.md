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
data/groups.json            Group order: slug, name, short, colour
data/cameras/*.json         One file per source — edit these, not data.js
data/sources.json           CI source mapping by group slug
data/README.md              Editing manual (recipes + validation rules)
assets/js/data.js           GROUPS + CAMS dataset — GENERATED, run `npm run data`
assets/js/app.js            Viewer logic (players, wall, map, recording…)
assets/vendor/              HatchMaps, MapHelpers, hls.js (decoded from the old base64 blobs)
assets/vendor/maplibre-gl.css
tools/build-data.mjs        Regenerates data.js from data/ (validate + serialise)
tools/split-data.mjs        One-time extractor that built data/ from the old data.js
tools/build-standalone.mjs  Inlines everything into standalone.html
tools/extract-monolith.mjs  One-time splitter for the old single file (deprecated, keep for history)
```

## Commands

```powershell
npm run data         # validate data/ and regenerate assets/js/data.js
npm run build        # regenerate data.js, then standalone.html from the modular files
npm run split-data   # one-time extractor that built data/ (already run; keep for history)
npm run split-legacy # re-split a monolithic index.html (only needed once)
```

No dependencies — Node 18+ is enough.

## Fullscreen wall

The page wall keeps its rounded 2×2 / 3×3 / 4×4 presets. Fullscreen is
edge-to-edge (no padding, gaps, borders, or rounded corners) and **unlimited**:
`Add camera` / `Add row` append more tiles and the grid scrolls. On exit, extra
tiles fold back into the nearest page preset (up to 4×4).
