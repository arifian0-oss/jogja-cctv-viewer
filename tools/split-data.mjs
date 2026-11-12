#!/usr/bin/env node
/**
 * split-data.mjs — one-time extractor: split the single-line dataset in
 * assets/js/data.js into the JSON database under data/.
 *
 *   data/groups.json            ordered [{ slug, name, short, color }]
 *   data/cameras/NN-<slug>.json one file per source (NN = 1-based group order)
 *   data/sources.json           CI source mapping by group slug
 *
 *   node tools/split-data.mjs [--force]
 *
 * Parsing uses JSON.parse on the two literals, not the regex family the plan
 * sketches: the literals are valid JSON, so a full parse is exact (a regex
 * would have to re-derive the string-escape rules the app.js pattern
 * already encodes). The round-trip proof below is the safety net either way.
 *
 * Round-trip proof (hard failure on any drift): the freshly written JSON is
 * loaded back through build-data.mjs and re-serialised; the parsed arrays
 * must match the originals exactly — GROUPS in order, CAMS as a multiset
 * (the output order is grouped by source, not the old chronological append
 * order — an accepted trade-off in the plan, so CAMS is compared
 * order-insensitively). Must report 801/801 cameras and 20/20 groups.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDatabase, serializeDataJs, slugify, validateDatabase } from "./build-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_JS = path.join(ROOT, "assets/js/data.js");
const DATA_DIR = path.join(ROOT, "data");
const CAMERAS_DIR = path.join(DATA_DIR, "cameras");
const FORCE = process.argv.includes("--force");

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function main() {
  if (fs.existsSync(path.join(DATA_DIR, "groups.json")) && !FORCE) {
    console.error("split-data: data/groups.json already exists — refusing to overwrite (use --force to re-run)");
    process.exit(1);
  }
  const src = fs.readFileSync(DATA_JS, "utf8");
  const groupsRaw = src.match(/var GROUPS\s*=\s*(\[[\s\S]*?\]);/);
  const camsRaw = src.match(/var CAMS\s*=\s*(\[[\s\S]*?\]);/);
  if (!groupsRaw || !camsRaw) throw new Error("could not find var GROUPS / var CAMS in data.js");
  const origGroups = JSON.parse(groupsRaw[1]);
  const origCams = JSON.parse(camsRaw[1]);
  console.log(`parsed data.js: ${origCams.length} cameras, ${origGroups.length} groups`);

  // Slugs from the short label; must be unique across groups.
  const slugs = origGroups.map((g) => slugify(g.short));
  const firstSeen = new Map();
  slugs.forEach((s, i) => {
    if (!s) throw new Error(`group ${i} (${JSON.stringify(origGroups[i].short)}): empty slug`);
    if (firstSeen.has(s)) throw new Error(`slug collision: ${JSON.stringify(s)} (groups ${firstSeen.get(s)} and ${i})`);
    firstSeen.set(s, i);
  });

  const groups = origGroups.map((g, i) => ({ slug: slugs[i], name: g.name, short: g.short, color: g.color }));

  // Per-group camera lists, in original CAMS order within each group.
  const perGroup = groups.map(() => []);
  origCams.forEach(([name, gidx, lat, lng, url, type]) => {
    const cam = { name, lat, lng, url };
    if (type === "yt" || type === "ytx") cam.type = type;
    perGroup[gidx].push(cam);
  });

  fs.mkdirSync(CAMERAS_DIR, { recursive: true });
  writeJson(path.join(DATA_DIR, "groups.json"), groups);
  groups.forEach((g, i) => {
    const nn = String(i + 1).padStart(2, "0");
    writeJson(path.join(CAMERAS_DIR, `${nn}-${g.slug}.json`), {
      group: g.slug,
      cameras: perGroup[i],
    });
    console.log(`  ${nn}-${g.slug}.json: ${perGroup[i].length} cameras`);
  });

  // CI source mapping, keyed by slug — replaces the substring matching on
  // group names in tools/yt-refresh-ci.py.
  writeJson(path.join(DATA_DIR, "sources.json"), {
    magelang: { kind: "portal", url: "https://cctv.dishub.magelangkab.go.id/live" },
    "gunungkidul-youtube": { kind: "channel", url: "https://www.youtube.com/@KominfoGunungkidul/streams" },
    "jitv-youtube": { kind: "channel", url: "https://www.youtube.com/@JitvPemdaDIY/streams" },
    "bantul-youtube": {
      kind: "bantul",
      urls: [
        "https://www.youtube.com/channel/UCdkc9vAwtyoI9N0oAdsNB3g/streams",
        "https://www.youtube.com/channel/UCFCoIkiISgT8YJGP_JtbJTQ/streams",
      ],
    },
  });

  // ---- Round-trip proof: JSON -> regenerate -> compare with the originals.
  const db = loadDatabase(ROOT);
  const { mirrors } = validateDatabase(db);
  const regen = serializeDataJs(db);
  const regenGroups = JSON.parse(regen.match(/var GROUPS\s*=\s*(\[[\s\S]*?\]);/)[1]);
  const regenCams = JSON.parse(regen.match(/var CAMS\s*=\s*(\[[\s\S]*?\]);/)[1]);
  const canon = (arr) => arr.map((e) => JSON.stringify(e)).sort();
  const groupsOk = JSON.stringify(regenGroups) === JSON.stringify(origGroups);
  const camsOk = JSON.stringify(canon(regenCams)) === JSON.stringify(canon(origCams));
  console.log(
    `round-trip: ${regenCams.length}/${origCams.length} cameras, ` +
      `${regenGroups.length}/${origGroups.length} groups, ` +
      `${mirrors.length} known HLS/YouTube mirror pairs`
  );
  if (!groupsOk) throw new Error("ROUND-TRIP FAILED: GROUPS differ from the original");
  if (!camsOk) throw new Error("ROUND-TRIP FAILED: CAMS differ from the original (as a multiset)");
  if (regenCams.length !== origCams.length || regenGroups.length !== origGroups.length) {
    throw new Error("ROUND-TRIP FAILED: counts differ");
  }
  console.log("round-trip: zero differences — split is exact");
}

try {
  main();
} catch (err) {
  console.error(`split-data: ${err.message}`);
  process.exit(1);
}
