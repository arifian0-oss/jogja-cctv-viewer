# Camera database — editing manual

The viewer’s camera dataset lives here as JSON, not in code.
`assets/js/data.js` is **generated output** — never edit it by hand.

## Layout

| Path | Role |
| --- | --- |
| `groups.json` | Ordered array of `{ slug, name, short, color }`, one per group. Array order defines the numeric group index emitted to `CAMS[i][1]`. |
| `cameras/NN-<slug>.json` | One file per source. Each holds `group` (slug), an optional `note`, and `cameras[]`. Ordering: group array order → filename sort → array order. |
| `sources.json` | CI source mapping by group slug (`kind`, `url`/`urls`). Only the four YouTube sources are listed; every other camera falls back to a per-ID live check. |

## Fields

| Field | Type | Rule |
| --- | --- | --- |
| `name` | string | Required, non-empty. Unique **within its group**. The same name may appear in another group only as a deliberate HLS/YouTube mirror of the same camera (one HLS copy, one `yt`/`ytx` copy); same-kind cross-group duplicates are rejected. |
| `lat`, `lng` | number \| null | Both numbers or both `null` (one camera, the JITV channel entry, has no coordinates). In range: lat −90…90, lng −180…180. Plain decimals only — never exponents. |
| `url` | string | Required, must start with `https://`. |
| `type` | `"yt"` \| `"ytx"` \| `"hls"` \| omitted | `"yt"` = YouTube live (playable embed); `"ytx"` = YouTube live but embedding disabled (Watch-on-YouTube card, never a player); omitted or `"hls"` = HLS stream. A YouTube `watch?v=` URL must carry type `"yt"` or `"ytx"` and exactly 11 `[A-Za-z0-9_-]` characters; a non-YouTube URL must not carry `"yt"`/`"ytx"`. |
| `group` (file) | slug | Must be a slug from `groups.json` and must match the file’s own `NN-<slug>.json` name. |
| `slug` (groups) | string | Lowercase letters/digits/hyphens, derived from the group’s `short` label. Unique, as are `name` and `short`. |
| `color` (groups) | string | `#rrggbb`. |

Every validation error names the file and the entry index, e.g.
`data/cameras/05-bantul.json entry 12 ("Foo"): lat/lng must both be numbers or both null`.

## Mandatory sequence

After any edit to the JSON:

```sh
npm run data            # validate + regenerate assets/js/data.js
npm run build           # rebuild standalone.html (runs `data` first)
```

Then commit the JSON **and** `assets/js/data.js` (and `standalone.html` when
it changed). `npm run data` on its own is deterministic — re-running it with
no edits produces a zero-byte `git diff`.

## Recipe 1 — add a camera

1. Pick the file for its source, e.g. `cameras/05-bantul.json`.
2. Append `{ "name": "...", "lat": -7.7, "lng": 110.3, "url": "https://..." }`
   (add `"type": "yt"` for a YouTube live) to its `cameras` array.
3. Run `npm run data` and `npm run build`, check the camera appears in the
   list, commit the JSON + `data.js` + `standalone.html`.

## Recipe 2 — remove a camera

1. Delete its entry from its `cameras/NN-<slug>.json` file.
2. Run `npm run data` and `npm run build`, check the total dropped by one,
   commit the JSON + `data.js` + `standalone.html`.

## Recipe 3 — add a new source file

1. If the source is a new group, append `{ "slug", "name", "short", "color" }`
   to `groups.json` first (slug from the `short` label, lowercase with `-`).
2. Create `cameras/NN-<slug>.json` (`NN` = next number, `group` = the slug)
   with its `cameras` array.
3. If the source is a YouTube channel/portal the refresh jobs should track,
   add it to `sources.json` (`kind`: `"portal"`, `"channel"`, or `"bantul"`
   with a `urls` list).
4. Run `npm run data` and `npm run build`, check the new group chip appears
   with the right count, commit everything above.

## Notes

- Camera order in the viewer is grouped by source (group order, then file,
  then array) — not the old chronological append order. Nothing in the app
  depends on absolute indices: lookups are by name, and the map/list/wall
  index maps are derived at runtime.
- The refresh jobs (`tools/yt-refresh-ci.py` hourly on GitHub Actions,
  `~/workspace/youtube-refresh/refresh.py` daily on the VM) edit this JSON
  and regenerate `data.js` themselves; their fixes flow through the same
  files, so a hand edit and a refresh can never silently clobber each other.
- `tools/split-data.mjs` was the one-time extractor that built this
  directory from the old single-line `data.js`. Keep it for history; the
  database is the source of truth now.
