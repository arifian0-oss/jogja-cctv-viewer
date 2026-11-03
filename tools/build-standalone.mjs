#!/usr/bin/env node
/**
 * Builds the single-file edition (`standalone.html`) from the modular sources.
 *
 *   index.html + assets/css/styles.css + assets/js/*.js + assets/vendor/*
 *      -> standalone.html (one file, no local dependencies)
 *
 * Run with:  npm run build     (or: node tools/build-standalone.mjs)
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let html = read("index.html");

/* Inline the two stylesheets in the same order the page loads them. */
html = html.replace(
  /<link rel="stylesheet" href="assets\/vendor\/maplibre-gl\.css"\s*\/>/,
  () => `<style>\n${read("assets/vendor/maplibre-gl.css")}\n</style>`
);
html = html.replace(
  /<link rel="stylesheet" href="assets\/css\/styles\.css"\s*\/>/,
  () => `<style>\n${read("assets/css/styles.css")}\n</style>`
);

/* Inline the scripts in load order. `</script` inside bundled strings is
   escaped so it cannot terminate the surrounding tag early. */
const scripts = [
  "assets/vendor/hatchmaps.js",
  "assets/vendor/maphelpers.js",
  "assets/vendor/maplibre.js",
  "assets/js/data.js",
  "assets/js/app.js"
];

for (const src of scripts) {
  const tag = `<script src="${src}"></script>`;
  if (!html.includes(tag)) throw new Error(`Missing script tag for ${src}`);
  const js = read(src).replace(/<\/script/gi, "<\\/script");
  html = html.replace(tag, () => `<script>\n${js}\n</script>`);
}

const out = path.join(root, "standalone.html");
fs.writeFileSync(out, html, "utf8");
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`Built standalone.html (${kb} KB) from ${scripts.length} scripts + 2 stylesheets`);
