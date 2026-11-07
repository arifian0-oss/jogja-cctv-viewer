#!/usr/bin/env node
/**
 * One-time (idempotent) splitter for the legacy monolithic index.html.
 *
 * Reads the self-contained page and writes the modular source tree:
 *   assets/css/styles.css
 *   assets/js/data.js        (GROUPS + CAMS dataset)
 *   assets/js/app.js         (viewer logic)
 *   assets/vendor/*.js       (decoded base64 bundles)
 *   assets/vendor/maplibre-gl.css
 *   index.html               (slim page that links the files above)
 *
 * Run once with:  node tools/extract-monolith.mjs
 * After that, edit the modular files and rebuild the single file with
 * `node tools/build-standalone.mjs`.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const entry = path.join(root, "index.html");
const html = fs.readFileSync(entry, "utf8");

const dirs = ["assets/css", "assets/js", "assets/vendor"];
for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });

const write = (p, s) => fs.writeFileSync(path.join(root, p), s, "utf8");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

/** Remove a fixed indent from every non-empty line. */
function dedent(text, n = 6) {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line.startsWith(pad) ? line.slice(n) : line))
    .join("\n");
}

/* ---------------------------------------------------------------- styles */
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error("No <style> block found in index.html");
write("assets/css/styles.css", dedent(styleMatch[1]).trim() + "\n");

const cssDataUri = html.match(/<link rel="stylesheet" href="data:text\/css;base64,([^"]+)"\s*\/>/);
if (!cssDataUri) throw new Error("No base64 stylesheet link found in index.html");
write("assets/vendor/maplibre-gl.css", Buffer.from(cssDataUri[1], "base64").toString("utf8"));

/* -------------------------------------------------------------- vendor js */
/* The third bundle is hls.js 1.5.13, not MapLibre — MapLibre lives inside
   hatchmaps.js. It was long misnamed maplibre.js; renamed 2026-11-07. */
const vendorNames = ["hatchmaps", "maphelpers", "hls"];
let vendorIndex = 0;
const vendorRe = /<script src="data:application\/javascript;base64,([^"]+)"><\/script>/g;
let vm;
while ((vm = vendorRe.exec(html))) {
  const name = vendorNames[vendorIndex];
  if (!name) throw new Error("More base64 scripts than expected");
  write(`assets/vendor/${name}.js`, Buffer.from(vm[1], "base64").toString("utf8"));
  vendorIndex++;
}
if (vendorIndex !== vendorNames.length) {
  throw new Error(`Expected ${vendorNames.length} base64 scripts, found ${vendorIndex}`);
}

/* ---------------------------------------------------------------- app js */
const appStart = html.lastIndexOf("<script>");
const appEnd = html.lastIndexOf("</script>");
if (appStart === -1 || appEnd <= appStart) throw new Error("Application <script> not found");

const appContent = html.slice(appStart + "<script>".length, appEnd);
const strictIdx = appContent.indexOf('"use strict";');
if (strictIdx === -1) throw new Error('Application script has no "use strict";');

const body = appContent.slice(strictIdx + '"use strict";'.length).replace(/^\s*\r?\n/, "");
const splitAt = body.indexOf("var $ = function (s)");
if (splitAt === -1) throw new Error("Could not find the data/application boundary");

const dataPart = body.slice(0, splitAt).trimEnd();
const appPart = body.slice(splitAt).trimEnd();

write("assets/js/data.js", dedent('"use strict";\n\n' + dataPart) + "\n");
write("assets/js/app.js", dedent('"use strict";\n\n' + appPart) + "\n");

/* ------------------------------------------------------------ slim page */
let page = html;

page = page.replace(
  /<link rel="stylesheet" href="data:text\/css;base64,[^"]+"\s*\/>/,
  '<link rel="stylesheet" href="assets/vendor/maplibre-gl.css" />'
);
page = page.replace(
  /<style>[\s\S]*?<\/style>/,
  '<link rel="stylesheet" href="assets/css/styles.css" />'
);

let pageVendorIndex = 0;
page = page.replace(
  /<script src="data:application\/javascript;base64,[^"]+"><\/script>/g,
  () => `<script src="assets/vendor/${vendorNames[pageVendorIndex++]}.js"></script>`
);

const pageAppStart = page.lastIndexOf("<script>");
const pageAppEnd = page.lastIndexOf("</script>");
page =
  page.slice(0, pageAppStart) +
  '<script src="assets/js/data.js"></script>\n' +
  '    <script src="assets/js/app.js"></script>' +
  page.slice(pageAppEnd + "</script>".length);

write("index.html", page);
console.log("Split complete:");
console.log("  assets/css/styles.css");
for (const n of vendorNames) console.log(`  assets/vendor/${n}.js`);
console.log("  assets/js/data.js");
console.log("  assets/js/app.js");
console.log("  index.html (modular)");
