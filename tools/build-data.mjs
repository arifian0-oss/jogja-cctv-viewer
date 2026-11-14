#!/usr/bin/env node
/**
 * build-data.mjs — regenerate assets/js/data.js from the JSON database.
 *
 *   data/groups.json            ordered [{ slug, name, short, color }]
 *   data/cameras/NN-<slug>.json one file per source:
 *                               { group, cameras: [{ name, lat, lng, url, type? }] }
 *   data/sources.json           CI source mapping by group slug
 *      -> assets/js/data.js     generated: var GROUPS + var CAMS, same compact
 *                               positional format as before, one line per array.
 *
 * Edit the JSON, then run:  npm run data
 * (npm run build runs this first, so standalone.html always embeds fresh data.)
 *
 * Output is deterministic: re-running with no edits produces a zero-byte diff.
 * Number formatting emits plain decimals only — an exponent such as 1e-7 would
 * break the app.js fresh-YouTube-ID regex, which only accepts [-0-9.] coords.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const CAMERAS_DIR = path.join(DATA_DIR, "cameras");
const OUT_DEFAULT = path.join(ROOT, "assets/js/data.js");

/* Provenance header copied verbatim from the original hand-written data.js
   (everything before `var GROUPS`), plus the generated-file banner below. */
const HEADER = "\"use strict\";\n\n/* Camera data: [name, groupIndex, lat, lng, streamUrl, type?] — type \"yt\" marks a YouTube live\n   embed; everything else is an HLS stream. 468 DIY cameras verified live 2026-11-02:\n   362 via the Pemda DIY portal, plus a deep-find pass (~22:00 WIB) that revived 71 portal\n   streams and added 31 from bantulkab.go.id and 4 JITV YouTube lives. A 2026-11-03 pass\n   beyond the DIY border (~20 km ring) added 17 Dishub Kabupaten Magelang junction cameras\n   (YouTube embeds; IDs read from cctv.dishub.magelangkab.go.id that day — they rotate) and\n   one Merapi north-flank YouTube live, for 486 total. A round-3 pass the same day added\n   six more YouTube lives: three Gunungkidul webcams listed on webcamtaxi.com (Wonosari\n   roundabout — confirmed live that day; Pantai Kukup and Pantai Baron — listed there, live\n   status not individually re-confirmed at add time), two Diskominfo Gunungkidul traffic\n   cameras via webcamera24.com (SDN Karangrejek 2 and the RSUD Wonosari intersection, both\n   shown online on that day's crawl), and afarTV's 24/7 Merapi 4K stream on the south flank\n   (listed live that day; a direct check was rate-limited, not a negative) — 492 total.\n   A round-4 pass the same day added 146 cameras from Kota Yogyakarta's own ATCS portal\n   cctv.jogjakota.go.id (PTZ junctions, Gajah Wong / Winongo / Ngentak river monitors and\n   Malioboro pedestrian cams; HLS on cctvjss.jogjakota.go.id, each verified live that day;\n   one duplicate listing dropped) — 638 total.\n   A round-5 pass the same day added 9 cameras from Sleman regency's 24-hour portal\n   24jam.slemankab.go.id (UGM/UNY district: Godean, UIN, Amplaz, Jombor, Pelemgurih,\n   Maguwo, both Krasak bridge directions and Prambanan; HLS on ant.slemankab.go.id,\n   Ant Media Server app CCTVLUARPEMDA). These streams sit behind Cloudflare and were\n   verified live 2026-11-03 via the live browser; coordinates are intersection-level\n   approximations — 647 total.\n   A round-6 pass the same day added 34 cameras from two official regency YouTube\n   channels plus one community stream: 5 from CCTV Pemerintah Kabupaten Bantul\n   (Simpang Jejeran north and south views, Simpang Korpri, Simpang Lima Bejen and\n   the Masjid Agung play area), 28 from Kominfo Gunungkidul (Wonosari town cameras,\n   markets, schools, intersections and Pantai Baron), and Frekom_86's Merapi multi-cam + seismogram stream in YouTube 24/7.\n   YouTube live IDs rotate when their channels restart the streams; these IDs were\n   pulled fresh and live-validated with yt-dlp on 2026-11-03 — 681 total.\n   A round-7 addition later the same day added one more Kominfo Gunungkidul\n   YouTube live (Lapangan Pemda Gunungkidul, verified live ~18:53 WIB) — 682 total.\n   A 2026-11-06 rescan round added 136 cameras (30 Kota Yogyakarta YouTube\n   simulcasts, 23 Bantul YouTube, 23 Purworejo LEKJO HLS, 19 Gunungkidul YouTube +\n   19 webcamera24, 8 Kota ATCS, 5 Bantul HLS, 3 Magelang, 3 JITV, 2 DIY, 1 afarTV\n   VR180), renamed the drifted Pantai Baron entry to Pasar Playen, and removed 1\n   dead Bantul YouTube entry — 801 total.\n   Portal cameras flap\n   on and off (maintenance, nights, brief 500s), so no baked-in status stays true for long:\n   the page re-probes only the on-stage cameras from the viewer's own connection on open\n   (runRecheck auto mode; the Recheck button tests all 801), and the players retry with\n   backoff instead of declaring a camera dead on one hiccup. */\n";
const BANNER = `/* GENERATED FILE — DO NOT EDIT BY HAND.
   Edit data/groups.json and data/cameras/*.json, then run: npm run data
   (tools/build-data.mjs regenerates this file deterministically.) */
`;

export function slugify(short) {
  return short
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Plain-decimal rendering of a coordinate (or null). JSON.stringify would
    emit exponents for very small values (1e-7); the consumer regexes only
    accept [-0-9.], so expand exponent notation to a plain decimal. */
export function fmtNum(n) {
  if (n === null) return "null";
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`fmtNum: not a finite number: ${JSON.stringify(n)}`);
  }
  const s = String(n);
  if (!/[eE]/.test(s)) return s;
  // Expand e.g. 1e-7 -> 0.0000001, 1.5e+21 -> 1500000000000000000000.
  const [mant, expStr] = s.split(/[eE]/);
  const exp = parseInt(expStr, 10);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  const dotAt = mant.replace("-", "").indexOf(".");
  const intDigits = dotAt === -1 ? digits.length : dotAt;
  const point = intDigits + exp;
  let out;
  if (point <= 0) out = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = digits.slice(0, point) + "." + digits.slice(point);
  return (neg ? "-" : "") + out;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`${path.relative(ROOT, p)}: invalid JSON: ${err.message}`);
  }
}

/**
 * Load the JSON database. Returns { groups, files, cameras } where each
 * camera carries { name, gidx, lat, lng, url, type, file, index } — file/index
 * are provenance for error messages and are stripped on serialise.
 * Ordering: group array order -> filename sort -> array order.
 */
export function loadDatabase(root = ROOT) {
  const dataDir = path.join(root, "data");
  const camerasDir = path.join(dataDir, "cameras");
  const groups = readJson(path.join(dataDir, "groups.json"));
  if (!Array.isArray(groups)) throw new Error("data/groups.json: not an array");
  const gidxBySlug = new Map(groups.map((g, i) => [g.slug, i]));

  const files = fs
    .readdirSync(camerasDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const perGroup = new Map(); // slug -> [{ file, doc }]
  for (const file of files) {
    const m = file.match(/^(\d{2})-(.+)\.json$/);
    if (!m) throw new Error(`data/cameras/${file}: name must be NN-<slug>.json`);
    const doc = readJson(path.join(camerasDir, file));
    if (doc.group !== m[2]) {
      throw new Error(
        `data/cameras/${file}: group field ${JSON.stringify(doc.group)} does not match filename slug ${JSON.stringify(m[2])}`
      );
    }
    if (!gidxBySlug.has(doc.group)) {
      throw new Error(`data/cameras/${file}: unknown group slug ${JSON.stringify(doc.group)}`);
    }
    if (!Array.isArray(doc.cameras)) {
      throw new Error(`data/cameras/${file}: cameras is not an array`);
    }
    (perGroup.get(doc.group) || perGroup.set(doc.group, []).get(doc.group)).push({ file, doc });
  }

  const cameras = [];
  groups.forEach((g, gi) => {
    for (const { file, doc } of perGroup.get(g.slug) || []) {
      doc.cameras.forEach((c, i) => {
        cameras.push({ ...c, gidx: gi, file, index: i });
      });
    }
  });
  return { groups, files, cameras };
}

const YT_RE = /^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validate the loaded database. Throws an Error naming the file and entry on
 * the first problem. Cross-group same-name pairs are the deliberate HLS /
 * YouTube mirrors of one camera (19 in the initial split) — accepted only
 * when the two copies differ in kind (one HLS, one yt/ytx); same-kind
 * cross-group duplicates are an error, as are same-group duplicates.
 * Returns { mirrors } — the accepted cross-group pairs, for the log.
 */
export function validateDatabase(db) {
  const seenSlug = new Set(), seenName = new Set(), seenShort = new Set();
  db.groups.forEach((g, i) => {
    const where = `data/groups.json[${i}]`;
    if (typeof g.slug !== "string" || !SLUG_RE.test(g.slug)) {
      throw new Error(`${where}: bad slug ${JSON.stringify(g.slug)}`);
    }
    if (seenSlug.has(g.slug)) throw new Error(`${where}: duplicate slug ${JSON.stringify(g.slug)}`);
    seenSlug.add(g.slug);
    if (typeof g.name !== "string" || !g.name) throw new Error(`${where}: bad name`);
    if (seenName.has(g.name)) throw new Error(`${where}: duplicate group name ${JSON.stringify(g.name)}`);
    seenName.add(g.name);
    if (typeof g.short !== "string" || !g.short) throw new Error(`${where}: bad short`);
    if (seenShort.has(g.short)) throw new Error(`${where}: duplicate group short ${JSON.stringify(g.short)}`);
    seenShort.add(g.short);
    if (typeof g.color !== "string" || !COLOR_RE.test(g.color)) {
      throw new Error(`${where}: bad colour ${JSON.stringify(g.color)} (want #rrggbb)`);
    }
  });

  const byGroupName = new Map(); // "gidx:name" -> camera
  const byName = new Map(); // name -> [cameras]
  for (const c of db.cameras) {
    const where = `data/cameras/${c.file} entry ${c.index} (${JSON.stringify(c.name)})`;
    if (typeof c.name !== "string" || !c.name) throw new Error(`${where}: bad name`);
    const latOk = c.lat === null || (typeof c.lat === "number" && Number.isFinite(c.lat));
    const lngOk = c.lng === null || (typeof c.lng === "number" && Number.isFinite(c.lng));
    if ((c.lat === null) !== (c.lng === null) || !latOk || !lngOk) {
      throw new Error(`${where}: lat/lng must both be numbers or both null`);
    }
    if (c.lat !== null && (c.lat < -90 || c.lat > 90)) throw new Error(`${where}: lat out of range: ${c.lat}`);
    if (c.lng !== null && (c.lng < -180 || c.lng > 180)) throw new Error(`${where}: lng out of range: ${c.lng}`);
    if (typeof c.url !== "string" || !c.url.startsWith("https://")) {
      throw new Error(`${where}: url must start with https://`);
    }
    const yt = c.url.match(YT_RE);
    if (c.url.includes("youtube.com/watch?v=") && !yt) {
      throw new Error(`${where}: YouTube URL must be watch?v= plus exactly 11 [A-Za-z0-9_-]`);
    }
    if (c.type !== undefined && !["hls", "yt", "ytx"].includes(c.type)) {
      throw new Error(`${where}: bad type ${JSON.stringify(c.type)} (want hls, yt or ytx)`);
    }
    if (yt && c.type !== "yt" && c.type !== "ytx") {
      throw new Error(`${where}: YouTube URL needs type "yt" or "ytx"`);
    }
    if (!yt && c.type !== undefined && c.type !== "hls") {
      throw new Error(`${where}: non-YouTube URL must not have type "yt"/"ytx"`);
    }
    const key = `${c.gidx}:${c.name}`;
    if (byGroupName.has(key)) {
      throw new Error(`${where}: duplicate name in group ${JSON.stringify(db.groups[c.gidx].slug)} (first in ${byGroupName.get(key).file})`);
    }
    byGroupName.set(key, c);
    (byName.get(c.name) || byName.set(c.name, []).get(c.name)).push(c);
  }

  const mirrors = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const kinds = new Set(list.map((c) => (c.url.match(YT_RE) ? "yt" : "hls")));
    if (kinds.size > 1) {
      mirrors.push({ name, copies: list.map((c) => `${db.groups[c.gidx].slug} (${c.type || "hls"})`) });
    } else {
      const where = list.map((c) => `data/cameras/${c.file} entry ${c.index}`).join(", ");
      throw new Error(`duplicate name ${JSON.stringify(name)} in same kind across groups: ${where}`);
    }
  }
  return { mirrors };
}

/** Serialise the loaded database to the data.js file text. */
export function serializeDataJs(db) {
  const groupsLit = JSON.stringify(
    db.groups.map((g) => ({ name: g.name, short: g.short, color: g.color }))
  );
  const camsLit =
    "[" +
    db.cameras
      .map((c) => {
        const type = c.type === "yt" || c.type === "ytx" ? `,"${c.type}"` : "";
        return `[${JSON.stringify(c.name)},${c.gidx},${fmtNum(c.lat)},${fmtNum(c.lng)},${JSON.stringify(c.url)}${type}]`;
      })
      .join(",") +
    "]";
  return `${HEADER}${BANNER}var GROUPS = ${groupsLit};\nvar CAMS = ${camsLit};\n`;
}

export function buildDataJs(outPath = OUT_DEFAULT) {
  const db = loadDatabase();
  const { mirrors } = validateDatabase(db);
  const text = serializeDataJs(db);
  fs.writeFileSync(outPath, text, "utf8");
  const yt = db.cameras.filter((c) => c.type === "yt").length;
  const ytx = db.cameras.filter((c) => c.type === "ytx").length;
  console.log(
    `wrote ${path.relative(ROOT, outPath)}: ${db.cameras.length} cameras, ` +
      `${db.groups.length} groups (${yt} yt + ${ytx} ytx), ` +
      `${mirrors.length} known HLS/YouTube mirror pairs`
  );
  return db;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    buildDataJs(process.argv[2] ? path.resolve(process.argv[2]) : OUT_DEFAULT);
  } catch (err) {
    console.error(`build-data: ${err.message}`);
    process.exit(1);
  }
}
