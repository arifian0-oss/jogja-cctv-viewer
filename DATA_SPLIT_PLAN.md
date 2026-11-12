# Data split plan — CCTV database as editable files

Status: **plan only, not implemented.** Written 2026-11-12.

## Objective

Move the 801-camera dataset out of the single 112 KB line in `assets/js/data.js`
into per-source JSON files under `data/`. Adding or removing a camera then touches
exactly one line of one JSON file plus one command — never `app.js` or `index.html`.

## Architecture

| Path | Role |
| --- | --- |
| `data/groups.json` | Ordered array of `{ slug, name, short, color }`, one per existing group, in current order. Array order still defines the numeric group index emitted to `CAMS[i][1]`. |
| `data/cameras/NN-<slug>.json` | 20 files, one per source. Each holds `group` (slug), an optional `note`, and `cameras[]` of `{ name, lat, lng, url, type? }`. `lat`/`lng` are both numbers or both `null`; `type` is `"yt"`, `"ytx"`, or omitted for HLS. A group may span several files (`04-dishub-atcs.json` vs `15-sleman-24jam.json`); ordering within a group is filename sort, then array order. |
| `data/sources.json` | CI source mapping by group slug (`kind`, `url`), replacing substring matching on group names. |
| `assets/js/data.js` | Becomes **generated output**: same provenance header plus a "generated — do not edit" banner, then `var GROUPS` and `var CAMS` in the identical compact positional format, one line per array. |
| `tools/split-data.mjs` | One-time extractor. |
| `tools/build-data.mjs` | Generator + validator. |
| `data/README.md` | The editing manual. |

Consumers need no change: the runtime regex in `app.js:108–114`, the parsers in
`tools/yt-refresh-ci.py`, and `tools/build-standalone.mjs` all keep working
against the generated file at the same path.

## Phase 1 — Migration scaffolding (no behaviour change)

1. `tools/split-data.mjs` parses the existing positional literal (same regex family
   as `yt-refresh-ci.py`, extended to HLS URLs), emits `groups.json`, the 20 camera
   files, and `sources.json`, deriving slugs from each group's `short` label.
2. Round-trip proof inside the same script: regenerate into a temp file and
   deep-compare both arrays. Must report 801/801 cameras and 20/20 groups, zero
   differences. Any drift is a hard failure.
3. `tools/build-data.mjs` reads `groups.json` plus globbed `data/cameras/*.json`,
   orders by group array order → filename → array, and serialises compact
   positional entries.
4. Number formatting must emit plain decimals only — an exponent such as `1e-7`
   breaks both consumer regexes. Strings use `JSON.stringify` escaping so `\"` and
   `\\` survive the `(?:[^"\\]|\\.)+` pattern.
5. Validation, each error naming the file and entry:
   - globally unique `name`
   - known group slug
   - lat/lng paired and in range
   - `url` starting `https://`
   - YouTube URLs matching `watch?v=` plus exactly 11 `[A-Za-z0-9_-]`
   - `type` in `{hls, yt, ytx}`
   - colour matching `#rrggbb`
   - unique slug, name and short
6. Deterministic output — re-running with no edits produces a zero-byte `git diff`.

## Phase 2 — Switch consumers (depends on Phase 1)

7. `package.json`: add `"data": "node tools/build-data.mjs"`; `"build"` runs `data`
   then `build-standalone`; add `"split-data"`.
8. `index.html` lines 23, 202, 203: replace the three hardcoded "801" strings with
   `id`-tagged spans (`#camCount`, `#ytCount`, `#recheckCount`) filled at boot from
   `CAMS.length` and `CAMS.filter(isYtAny).length`. Counts become self-maintaining.
9. `app.js` line 9/18: convert `DEAD_NOW` from index keys `{4,28,105,207,261}` to
   camera-name keys resolved during migration, and look up by `c[0]`. This is the
   only app logic change and it removes the last index coupling.
10. Confirm nothing else depends on array order: `findCam`, `state.status`,
    `routeState.matched`, `placePosByCam`, `camByPlacePos` are all derived at runtime.

## Phase 3 — CI and docs (depends on Phase 2)

11. `tools/yt-refresh-ci.py`: load the JSON database instead of regexing `data.js`;
    keep the live-set matching logic (`_same_camera`, generic-word filtering,
    `live_status`, `oembed_status`) but mutate dict fields (`cam["url"]`,
    `cam["type"]`) instead of string-replacing raw literals; write back with 2-space
    indent.
12. After mutation, run `node tools/build-data.mjs`; abort the push if it exits
    non-zero or `node --check` fails on the output; then
    `git add data assets/js/data.js`.
13. `.github/workflows/youtube-refresh.yml`: insert a pinned `actions/setup-node`
    step before the refresh step, matching the repo's existing SHA-pinning
    convention.
14. `data/README.md`: three recipes — add a camera, remove a camera, add a new
    source file — plus the field table, validation rules, and the mandatory
    sequence "edit JSON → `npm run data` → rebuild `standalone.html` → commit JSON +
    `data.js`".
15. Update `README.md` (layout table, commands, drop the stale "681"),
    `DISCOVERY_PLAN.md` §5 (checklist now points at `data/cameras/*.json`), and
    `plan-update.md` (architecture note; the "CAMS 452" reference becomes
    historical prose).

## Phase 4 — Cleanup

16. Mark `tools/extract-monolith.mjs` deprecated in `README.md`; keep the file for
    history but never re-run it.

## Verification

1. `node tools/split-data.mjs` → 801 cameras, 20 groups, zero-diff round-trip.
2. `npm run data` → `node --check assets/js/data.js` passes; arrays still single-line.
3. Parser parity: both the `app.js` regex and the `yt-refresh-ci.py` regex find 157
   YouTube entries (114 `yt`, 43 `ytx`) and 801 camera tuples in the regenerated file.
4. `npm run build` → `standalone.html` rebuilt; `git diff --stat` shows only
   expected files.
5. `index.html` over `file://`: no console errors, 20 chips with correct counts,
   list total 801, map pins render, one HLS and one YouTube camera play.
6. `standalone.html` over `file://`: same checks, offline.
7. Add-a-camera test: append a dummy entry to `data/cameras/05-bantul.json`,
   `npm run data`, confirm it appears with no edits to `app.js` or `index.html`;
   remove it and confirm it disappears.
8. Duplicate name → generator exits non-zero with a clear message.
9. Negative tests: bad colour, `lat` without `lng`, 10-character YouTube ID — each
   rejected with file and index.
10. CI dry run: `python3 tools/yt-refresh-ci.py --check-only`, then on a scratch
    branch force one `type` flip to exercise JSON write → regenerate → stage →
    commit.
11. `grep` for hardcoded `801`/`681` in HTML and Markdown returns nothing.

## Accepted trade-offs

- Camera list order becomes grouped by source instead of chronological append
  order, because files group cameras.
- `data.js` stays a committed generated artifact (GitHub Pages serves it as-is);
  contributors must edit JSON, not `data.js`.
- `data/cameras/` ships to Pages at roughly 500 KB but is never fetched at runtime
  — no page-weight impact.
- Out of scope: ES modules, a dev server, runtime JSON loading, a test framework.

## Follow-up (not part of this split)

Optional `tools/cctv-cli.mjs` behind `npm run cctv -- add|remove|move|list` that
edits the JSON by name and regenerates automatically.
