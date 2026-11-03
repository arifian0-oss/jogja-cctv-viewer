# Camera Discovery Plan — Jogja CCTV Viewer

Living playbook for finding, validating, and integrating publicly-accessible live
camera streams in/around Yogyakarta. Updated 2026-11-03. Dataset: 492 cameras.

## 1. Objective

Continuously discover public-intent live video streams covering DIY province plus
~30 km beyond its borders (Klaten, Magelang, Purworejo border, Gunungkidul coast),
validate each one for real playability, and integrate into the viewer + playlist.

Hard boundary: only cameras whose operator intends them to be publicly viewable.
Never include default-password, leaked-credential, hacked, or otherwise
unauthorized private feeds.

## 2. Source inventory (status 2026-11-03)

### 2.1 Government CCTV portals
| Source | Access pattern | Status |
|---|---|---|
| cctv.jogjaprov.go.id | Open JSON API: `GET /api/v1/location-pins` → `stream_url` (HLS) | 433 streams integrated |
| Bantul (stream.bantulkab.go.id) | HLS `.m3u8` via `/memfs/<uuid>.m3u8` | 31 integrated |
| Magelang Dishub (cctv.dishub.magelangkab.go.id/live) | YouTube embeds scraped from page | 17 integrated — **IDs ROTATE, re-pull monthly** |
| Klaten (cctv.klaten.go.id) | Portal shows zero public cameras | Watch for changes |
| Jateng ATCS (gis.perhubungan.jatengprov.go.id/atcs) | JS app | Video-vs-snapshot undetermined |
| BPJT toll CCTV (bpjt.pu.go.id/cctv) | Open web listing | Jogja–Solo listed, no per-camera URLs |
| Bina Marga inframe (binamarga.pu.go.id/.../cctv_inframe) | JS app | No direct URLs recoverable |
| NTMC Polri (k3i.korlantas.polri.go.id/cctv_streaming) | Direct fetch failed | Retry |
| Jogja city (cctv.jogjakota.go.id) | Fetch timed out | Retry |
| Travoy / Tol Kita (Jasa Marga, BPJT) | App, free login | Not accessible without login — user decision |

### 2.2 Aggregators
| Source | Notes |
|---|---|
| webcamtaxi.com | Wonosari roundabout, Pantai Kukup, Pantai Baron integrated; watch DIY region page for new listings |
| webcamera24.com | SDN Karangrejek 2, RSUD Wonosari integrated; only DIY school/health listings |
| skylinewebcams.com | Merapi + Wonosari town listed; players unverified |
| windy.com / meteoblue | Still images only — skip |
| city-webcams.com | Auto-generated junk (same embed everywhere) — skip |
| everywebcam.com | Entries self-report OFFLINE — skip |

### 2.3 YouTube 24/7 lives
- JITV Pemda DIY (Merapi, Tugu, Nol KM, channel) — IDs rotate, re-check
- afarTV Merapi 4K (south flank), Srumbung Merapi north — community volcano cams
- Frekom/TAGANA community Merapi network — more cameras to discover
- Search patterns: `"CCTV <place> live 24 jam"`, `"<place> live"`, `"Merapi live"`

### 2.4 Venues & institutions (3 rounds: essentially empty)
No 24/7 public streams found for hotels, restaurants, cafes, resorts, malls,
stadiums (Mandala Krida, Among Rogo), hospitals, schools, or universities.
All institutional video is event-only (wisuda, webinars, ceremonies).
Re-sweep occasionally — new venues open, policies change.

## 3. Discovery methods

1. **Portal API enumeration** — check `/api/v1/*`, inspect network requests on
   portal pages for JSON camera lists.
2. **Page scraping** — extract `youtube.com/embed/<ID>` and `.m3u8` URLs from
   portal HTML with curl + grep.
3. **YouTube search & channels** — venue/place name + "live"; enumerate
   community channels (JITV, Frekom, afarTV) via yt-dlp for current live IDs.
4. **Aggregator region pages** — webcamtaxi/webcamera24 Indonesia/DIY listings.
5. **Social media** — IG/TikTok/FB lives are event-based; note as such, don't
   present as 24/7.

## 4. Validation protocol

1. **HLS**: HTTP 200 + `#EXTM3U` + newest segment fetchable via Range request.
   Follow master playlists (`#EXT-X-STREAM-INF`) into sub-playlists first.
2. **YouTube**: `yt-dlp --print live_status` (android player client); require
   `is_live`. IDs rotate — record the validation date per camera.
3. **Freshness**: stamp every camera with last-validated date; re-pull
   Magelang IDs monthly; re-check rotating YouTube IDs when a tile dies.
4. **Reject**: snapshot-only feeds, login-walled private streams, anything
   requiring credential bypass.

## 5. Integration checklist (per discovery round)

1. Append to `research_notes/jogja-cctv/cameras.json`
   (schema: name / group / lat / lng / url / type / source).
2. Append to `jogja-cctv.m3u` (same `#EXTINF` format, group-title per source).
3. Write validated table to a dated note in the research dir.
4. `artifact.edit` on `jogja-cctv-viewer` with the research dir.
5. `artifact.export` → push `index.html` to GitHub → pull on desktop.

## 6. Watchlist (revisit each round)

- [x] cctv.jogjakota.go.id — CRACKED 2026-11-03: `GET /home/getdata` needs
  `X-Requested-With: XMLHttpRequest` header; returns 151 cameras with HLS URLs on
  cctvjss.jogjakota.go.id; 147 verified live, integrated (round 4)
- [ ] Klaten portal — check for newly public cameras
- [ ] Gunungkidul & Bantul YouTube channels — skipped in round 1
- [ ] NTMC Polri portal — retry
- [ ] Travoy / "Jogja Istimewa" app contents — needs login (user decision)
- [ ] New Frekom / community Merapi cameras
- [ ] Magelang YouTube IDs — re-pull monthly (they rotate)
- [ ] webcamtaxi / webcamera24 DIY pages — new listings

## 7. History

- 2026-11-02: Round 1 — DIY portal (433) + Bantul (31) + JITV YouTube (4) = 468
- 2026-11-03: Round 2 — 20 km ring: Magelang Dishub (17) + Merapi north (1) = 486
- 2026-11-03: Round 3 — Gunungkidul/webcamtaxi (3) + webcamera24 (2) + afarTV (1) = 492
- 2026-11-03: Round 4 — Kota Yogyakarta ATCS portal cracked (147 live of 151) = 638
- 2026-11-03: Round 5 — Sleman portal cracked via live browser (Ant Media stream IDs, 9 live) = 647
- 2026-11-03: Venue/institution sweep — no 24/7 streams exist in these categories
