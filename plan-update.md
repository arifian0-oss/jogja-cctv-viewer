# Plan update — 2026-11-06

Living status/plan note for the Jogja CCTV viewer. Updated after each
rescan or infrastructure change; history lives in DISCOVERY_PLAN.md.

## Current state
- **801 cameras, 20 groups, 157 YouTube lives** (114 playable + 43 no-embed cards)
- Live site: https://arifian0-oss.github.io/jogja-cctv-viewer/
- Repo: `arifian0-oss/jogja-cctv-viewer` (public, GitHub Pages)
- Data: `assets/js/data.js` is the source of truth; `cameras.json` +
  `jogja-cctv.m3u` (in `~/workspace/research_notes/jogja-cctv/` and
  `~/workspace/`) are manual syncs — refresh jobs only update data.js,
  so rotations drift them until synced.

## Done 2026-11-06
- **Rescan round: +136 cameras** (666 → 801) — 30 Kota Yogyakarta YouTube,
  23 Bantul YouTube, 23 Purworejo LEKJO HLS, 19+19 Gunungkidul, 8 Kota ATCS,
  5 Bantul HLS, 3 Magelang, 3 JITV, 2 DIY, 1 afarTV VR180. Drifted Pantai
  Baron renamed to Pasar Playen; 1 dead Bantul entry removed.
- **Refresh matcher hardened** (`89603a5`) — a replacement now needs all
  distinctive place tokens plus direction/number agreement (generic words
  like "bantul"/"simpang" can no longer cause a swap); the old ID's
  live_status is re-checked before declaring it dead, because a channel's
  /streams listing misses live streams (10 false "dead" Bantul flags).
  Same rule applied to the VM daily refresher.
- **"CCTV Simpang Palbapang" disambiguated** into (Magelang) and (Bantul);
  8 rotated Magelang IDs synced from data.js into cameras.json + the .m3u.
- **Hourly Actions refresh flipped Pasar Playen to a no-embed card**
  (`4651db7`) — embedding disabled on YouTube's side (error 150).

## Refresh setup (running)
- Hourly GitHub Actions (primary): set-based checks vs each source's live set.
- VM cron `youtube-embed-daily-refresh` (~05:23 WIB): per-ID live_status backstop.

## Open
- Sleman / Klaten / toll portals (BPJT, Bina Marga) — need a live-browser
  round; all blocked from the VM.
- Kominfo Gunungkidul existing entries — re-validation pass (IDs
  drift/repurpose; Baron → Playen proved it).
- Surakarta (Solo) — 96 FLV cameras found, not integrated (needs flv.js).
  Open user yes/no.
