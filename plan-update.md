# Plan Update — GPX Route Import + On-Route CCTV Filter

**Date:** 2026-11-06
**Status:** awaiting implementation approval
**Supersedes:** session plan v1

## Summary

Let a user import a `.gpx` track, draw it on the camera map, and keep only
cameras within a 100 m corridor of the track — in the map pins, the camera
list, and `Fill from list` / `Add row`.

Buffer: selectable 25 / 50 / 75 / 100 m, default 100 m.
Scope: map pins + camera list + wall fill (all via `matches()`).
Persistence: none — the route lives for the session only.

## Verified map contracts (from assets/vendor/hatchmaps.js)

- `MapHelpers.mountMap()` returns only `{ destroy, selectPlace }`; the raw
  MapLibre instance is not exposed.
- Drawing is supported through the `overlays` option:
  `[{ id, data: <GeoJSON>, layers: [<layer spec>], before }]`. The overlay `id`
  becomes the GeoJSON source id; layer specs pass straight to `map.addLayer`.
- **Blocker 1 — `before` default:** omitting `before` defaults to the literal
  string `"insert-here"`, which never exists. MapLibre fires
  `Cannot add layer "..." before non-existing layer "insert-here"`, the app
  treats it as fatal and falls back to `meta-light` or the map fallback.
  Every overlay must pass `before: ""` (falsy ⇒ append on top). Do not use
  `before: "places-pins"` either — the pin layer does not exist yet when
  overlays are added.
- Overlays mount before pins, so route layers naturally render beneath the
  camera pins.
- Overlay layer ids must be unique map-wide.
- Overlay layers are included in the tooltip hit-test list; the tooltip div is
  rendered whenever a feature is hit, even for an empty render. Route features
  must carry `properties.label` (use the GPX/track name).
- **Blocker 2 — pin index mapping (pre-existing bug):** `places` become GeoJSON
  with feature id and `properties.index` equal to the *position in the places
  array*; any caller-supplied `index` is ignored. `onSelectPlace(pos)` therefore
  receives a places position, but `loadMain()` expects a CAMS index. Because the
  no-coord "JITV Jogja Istimewa TV (24 jam)" entry sits mid-list, every camera
  after it currently opens the wrong stream when its pin is tapped.
  `selectPlace(state.mainIdx)` has the mirror bug.
- Passing `center` suppresses the map's own `fitBounds`; `zoom` defaults to 13
  when a center is supplied.

## Implementation

### Phase 1 — GPX parsing + proximity model (`assets/js/app.js`)

1. `parseGpxText(text)` → `{ name, segments, error }` using `DOMParser`.
   Namespace-tolerant `trkseg/trkpt` groups, `rte/rtept` fallback, coordinate
   range validation, at least two distinct points, ignore ele/time.
2. `haversineM`, `pointToSegmentM` (local equirectangular projection),
   `distanceToRouteM`, plus route length in km.
3. `computeRouteMatch(segments, radiusM)` → `{ distM, matched, count, lengthKm }`
   with a bbox prefilter and decimation above ~20k points.
4. Module-level `routeState` holding `active`, `filter`, `name`, `segments`,
   `geojson`, `endpoints`, `bbox`, `lengthKm`, `matched`, `radiusM`.

### Phase 2 — Map integration + filtering

5. `buildMapPlaces()` rebuilds `mapPlaces` (skip cameras without coordinates;
   skip non-matching cameras when the route filter is on) and maintains a
   CAMS-index ↔ places-position map.
6. Index fix (required): `onSelectPlace(pos)` resolves `mapPlaces[pos].index`
   before calling `loadMain()`; `loadMain()` and `mountMapNow()` call
   `selectPlace(placePosOfCam(camIdx))` and skip when the camera is filtered out.
7. `mountMapNow()` when a route is loaded:
   - `overlays` with `before: ""` on every entry;
   - ids `gpx-route` (source) with `gpx-route-casing` + `gpx-route-line`, and
     `gpx-ends` with `gpx-ends-dot`;
   - route features carry `properties.label` = track name;
   - `center`/`zoom` from `fitRouteView()`, otherwise today's default view.
8. `applyRouteFilter()`: recompute matches → rebuild places → remount map →
   `applyFilter()` → refresh route status.
9. `matches(i)` gains the route clause so list, search/chips, and wall fill stay
   consistent.

### Phase 3 — Controls (`index.html`, `assets/css/styles.css`, `assets/js/app.js`)

10. Insert `.route-bar` after `.map-head`: Import GPX button + hidden file
    input (`accept=".gpx,application/gpx+xml,application/xml"`), buffer select,
    on-route toggle (`aria-pressed`), Clear route, and a `role="status"`
    `aria-live="polite"` status line. Update the map intro copy.
11. Wire file read (`file.text()`), parse errors, radius change, toggle, clear,
    and input reset so the same file can be re-imported. When the map is
    unavailable, still filter the list and say so in the status.
12. Styles: `.route-bar`, `.route-status`, `.route-status.err` using existing
    design tokens.

### Phase 4 — Build

13. `npm run build` regenerates `standalone.html` (no new source files, so the
    build script is unchanged).

## Files

- `assets/js/app.js` — parsing, proximity, `buildMapPlaces`, `mountMapNow`,
  `applyRouteFilter`, `matches`, selection index fix.
- `index.html` — `.route-bar` markup and map intro copy.
- `assets/css/styles.css` — route bar/status styles.
- `standalone.html` — regenerated build artifact.
- `assets/vendor/maphelpers.js` — reference only (`heatmapOverlay`,
  `mountChoropleth` show the overlays shape); do not edit.
- `tools/build-standalone.mjs` — unchanged.

## Verification

1. Import a GPX; route renders on every basemap provider; console has no
   "before non-existing layer" error and the map never falls back.
2. Hover the route line → tooltip shows the route label, never an empty box.
3. Click pins late in the list (Magelang, Purworejo, Kota YouTube) → the correct
   camera opens and the highlighted pin matches the stage camera.
4. Buffer 25→100 m, toggle off/on, Clear → counts, pins, and view are correct;
   route and filter survive a basemap switch.
5. Search and region chips combine correctly with the route filter;
   `Fill from list` / `Add row` pick on-route cameras.
6. Route far from DIY → 0 cameras + empty-state message; stage/wall camera
   outside the route keeps playing.
7. Invalid, empty, single-point, and multi-segment GPX files are handled.
8. A ~50k-point GPX imports in under a second; panning stays smooth.
9. `npm run build` exits 0 and `standalone.html` contains `#gpxFile`.

## Decisions

- No vendor bundle edits and no React-internals hacks; overlays + remount only.
- The map remounts on import / radius / toggle / clear, matching the existing
  basemap-switch behavior; the fitted route view is reapplied.
- `before: ""` is mandatory on overlays (see Blocker 1).
- The pin index translation is included because route filtering invalidates
  positional indexing; it also fixes the existing JITV off-by-one bug.
- The JITV channel camera (no coordinates) is excluded whenever the route filter
  is on.
- Random camera is unchanged and ignores the route filter.

## Deferred

- Showing each row's distance to the route.
- Drag-and-drop `.gpx` onto the map.
- Remembering the last route in `localStorage`.
