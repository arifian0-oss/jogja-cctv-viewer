# Camera Discovery Plan — Jogja CCTV Viewer

Living playbook for finding, validating, and integrating publicly-accessible live
camera streams in/around Yogyakarta. Updated 2026-11-06. Dataset: 801 cameras.

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
4. Update `assets/js/data.js` (GROUPS / CAMS) in the viewer repo.
5. `npm run build` → commit `index.html`, `assets/` and `standalone.html` → push
   to GitHub → pull on desktop.

## 6. Watchlist (revisit each round)

- [x] cctv.jogjakota.go.id — CRACKED 2026-11-03: `GET /home/getdata` needs
  `X-Requested-With: XMLHttpRequest` header; returns 151 cameras with HLS URLs on
  cctvjss.jogjakota.go.id; 147 verified live, integrated (round 4)
- [x] Klaten portal — check for newly public cameras (re-checked 2026-11-06: portal unreachable from VM, cached crawl shows zero public cameras; Klaten PTZ cams exist but no public stream URL is exposed)
- [x] Gunungkidul & Bantul YouTube channels — added 2026-11-06 rescan (23 Bantul YT, 19 Gunungkidul YT, 19 webcamera24)
- [ ] NTMC Polri portal — retry (2026-11-06: /cctv_streaming 404s, site login-gated; NTMC YouTube only ended broadcasts)
- [ ] Travoy / "Jogja Istimewa" app contents — needs login (user decision) (2026-11-06: app-only, no public web streams; an account would only give in-app viewing)
- [ ] Gunungkidul smart city CCTV (app-smartcity.gunungkidulkab.go.id/cctv) — DOWN 2026-11-03 (server-side outage, not a block); retry later. Its feeds link out to Kominfo Gunungkidul YouTube lives. (2026-11-06: still down, possible geo-block of non-ID traffic)
- [ ] New Frekom / community Merapi cameras
- [x] Magelang YouTube IDs — re-pull monthly (they rotate) (re-pulled 2026-11-06: no existing IDs rotated, 3 new junctions added)
- [x] webcamtaxi / webcamera24 DIY pages — new listings (swept 2026-11-06: 19 webcamera24 added; webcamtaxi Baron dead; skylinewebcams stale/mislabelled — skip)
- [ ] Sleman 24jam portal — re-check via live browser (Cloudflare-walled for curl)
- [ ] Toll/highway portals via live browser — BPJT + Bina Marga unreachable from VM (documented login-free); leads: mudik.pu.go.id/cctv-tol/?id_ruas=jogja-solo, jasamargalive.com, rttmc.dephub.go.id/rttmc/livecctv
- [ ] Purworejo LEKJO — 23 HLS added 2026-11-06, 40–70 km out (beyond the ~30 km border; user chose to include)

## 7. History

- 2026-11-02: Round 1 — DIY portal (433) + Bantul (31) + JITV YouTube (4) = 468
- 2026-11-03: Round 2 — 20 km ring: Magelang Dishub (17) + Merapi north (1) = 486
- 2026-11-03: Round 3 — Gunungkidul/webcamtaxi (3) + webcamera24 (2) + afarTV (1) = 492
- 2026-11-03: Round 4 — Kota Yogyakarta ATCS portal cracked (147 live of 151) = 638
- 2026-11-03: Round 5 — Sleman portal cracked via live browser (Ant Media stream IDs, 9 live) = 647
- 2026-11-03: Venue/institution sweep — no 24/7 streams exist in these categories
- 2026-11-03: Round 6 — from-zero sweep: 5 Bantul official YouTube + 28 Kominfo Gunungkidul YouTube + 1 Frekom Merapi + Lapangan Pemda Gunungkidul = 682, then dedup to 668
- 2026-11-05: 2 JITV lives discontinued by the channel (Merapi, Tugu) removed; 5 Bantul YouTube cams found embedding-disabled (oEmbed 401, error 150) and switched to no-embed cards = 666
- 2026-11-06: Rescan round — 136 new validated (30 Kota Yogyakarta YouTube simulcasts, 23 Bantul YouTube, 23 Purworejo LEKJO HLS, 19 Gunungkidul YouTube + 19 webcamera24, 8 Kota ATCS, 5 Bantul HLS, 3 Magelang, 3 JITV, 2 DIY, 1 afarTV VR180); drifted Pantai Baron entry renamed to Pasar Playen; 1 dead Bantul YouTube entry removed = 801
- 2026-11-06: Refresh matcher hardened after 10 false "dead" Bantul flags — a channel's /streams listing misses live streams, so the CI refresher now re-checks the old ID's live_status before declaring it dead; the name-match now requires all distinctive place tokens plus direction/number agreement (generic tokens like "bantul"/"simpang" can no longer cause a swap — it had matched Lapangan Paseban onto Pasar Bantul/Srandakan/Cinomati). Same rule applied to the VM daily refresher. Two same-name "CCTV Simpang Palbapang" entries disambiguated (Magelang vs Bantul); 8 rotated Magelang IDs synced from data.js into cameras.json + the .m3u.
