#!/usr/bin/env python3
"""YouTube embed refresh for jogja-cctv-viewer — GitHub Actions version.

Runs inside the repo checkout (no VM, no secrets): keeps the YouTube live
IDs fresh by comparing them against the sources' CURRENT live sets, instead
of probing all 157 IDs one by one.

The dataset lives in data/ as JSON (data/groups.json + data/cameras/*.json);
this script loads that database, mutates camera dicts (url/type) in place,
writes the changed files back with 2-space indent, then regenerates
assets/js/data.js with `node tools/build-data.mjs` and commits both the JSON
and the generated file. assets/js/data.js is generated output — never edited
directly.

Method (few requests, gentle on YouTube):
  1. Fetch each source's current live set once — Magelang portal HTML,
     and one yt-dlp --flat-playlist per source channel's /streams page.
  2. Every YouTube entry whose video ID is still in its source's live set
     is OK. Any other entry is dead/rotated: find its replacement in the
     same source's live set by name, verify it is_live, swap it in.
     Note: set membership means "still among the channel's recent
     streams", not a live check — the VM daily cron's per-ID live_status
     sweep remains the liveness backstop, and the viewer's own error
     handling catches anything that slips through in between.
  3. Entries with no source mapping (one-off channels) fall back to a
     per-ID yt-dlp live_status check + oEmbed (401 = embedding disabled).
  4. If anything changed, regenerate data.js, verify it parses, commit
     data/ + assets/js/data.js and push to main (GitHub Pages redeploys
     on push).

Usage: python3 tools/yt-refresh-ci.py [--check-only]
Env: YT_REFRESH_WORK (repo root, default: current directory)
"""
import glob, json, os, re, subprocess, sys, time, urllib.request, urllib.error

CHECK_ONLY = "--check-only" in sys.argv
WORK = os.environ.get("YT_REFRESH_WORK", os.getcwd())
DATA_DIR = os.path.join(WORK, "data")
CAMERAS_DIR = os.path.join(DATA_DIR, "cameras")
BUILD_DATA = os.path.join(WORK, "tools", "build-data.mjs")
DATA_JS = os.path.join(WORK, "assets/js/data.js")
LOG = []

def log(msg):
    print(msg, flush=True)
    LOG.append(msg)

def is_valid_vid(vid):
    """YouTube video IDs are exactly 11 [A-Za-z0-9_-] chars. Anything else
    must never reach data.js: it loads as <script>, so a quote in an ID
    would break out of the string literal and run in every viewer
    (audit run-1, refresh-no-check-cert-unvalidated-vid)."""
    return isinstance(vid, str) and re.fullmatch(r"[A-Za-z0-9_-]{11}", vid) is not None

def yt_dlp(*args, timeout=90):
    # No --no-check-certificate here: this script runs on GitHub Actions
    # with normal TLS. (The VM's local refresh.py needs that flag for the
    # egress proxy's MITM cert — this CI script must never inherit it.)
    cmd = ["yt-dlp",
           "--extractor-args", "youtube:player_client=android"] + list(args)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip(), out.stderr.strip()
    except Exception as e:
        return "", f"EXC: {e}"

def live_status(vid):
    if not is_valid_vid(vid):
        return "", "invalid vid"
    out, err = yt_dlp("--print", "%(live_status)s",
                      f"https://www.youtube.com/watch?v={vid}", timeout=40)
    return (out.split("\n")[0] if out else ""), err

def oembed_status(vid):
    if not is_valid_vid(vid):
        return None
    url = (f"https://www.youtube.com/oembed?url="
           f"https://www.youtube.com/watch?v={vid}&format=json")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None

def channel_streams(channel_url):
    """One call returns the channel's current live set: [(id, title)]."""
    out, err = yt_dlp("--flat-playlist", "--print", "%(id)s | %(title)s",
                      channel_url, timeout=120)
    res = []
    for line in out.split("\n"):
        if " | " in line:
            vid, title = line.split(" | ", 1)
            vid = vid.strip()
            if not is_valid_vid(vid):
                log(f"  WARNING: skipping invalid video ID from yt-dlp: {vid!r}")
                continue
            res.append((vid, title.strip()))
    return res

def load_database():
    """Load data/groups.json + data/cameras/*.json + data/sources.json.
    Returns (groups, entries, docs, sources) where each entry holds a
    reference to the live dict inside its file's doc, so mutating the entry
    mutates the file content."""
    with open(os.path.join(DATA_DIR, "groups.json"), encoding="utf-8") as f:
        groups = {g["slug"]: g for g in json.load(f)}
    with open(os.path.join(DATA_DIR, "sources.json"), encoding="utf-8") as f:
        sources = json.load(f)
    docs = {}
    entries = []
    for path in sorted(glob.glob(os.path.join(CAMERAS_DIR, "*.json"))):
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        docs[path] = doc
        for cam in doc["cameras"]:
            if "youtube.com/watch?v=" not in cam["url"]:
                continue
            vid = cam["url"].split("watch?v=", 1)[1]
            entries.append({"name": cam["name"], "slug": doc["group"],
                            "vid": vid, "url": cam["url"],
                            "typ": cam.get("type", "yt"), "cam": cam,
                            "_path": path})
    return groups, entries, docs, sources

def main():
    groups, entries, docs, sources = load_database()
    log(f"found {len(entries)} YouTube entries")
    # group slug -> live set {vid: title}; filled lazily, one fetch per source
    live_sets = {}

    def source_for(entry):
        return sources.get(entry["slug"])

    def live_set_for(entry):
        src = source_for(entry)
        if src is None:
            return None
        key = entry["slug"]
        if key in live_sets:
            return live_sets[key]
        kind = src["kind"]
        live = {}
        if kind == "portal":
            url = src["url"]
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
                pairs = re.findall(
                    r"panel-heading'><center><a href='[^']*' *>([^<]+)</a>.*?"
                    r"<iframe src='https://www\.youtube\.com/embed/([A-Za-z0-9_-]+)'",
                    html, re.S)
                live = {v: n.strip() for n, v in pairs if is_valid_vid(v)}
                if len(live) != len(pairs):
                    log(f"  WARNING: skipped {len(pairs) - len(live)} invalid portal video ID(s)")
                log(f"  magelang portal: {len(live)} lives")
            except Exception as ex:
                log(f"  magelang portal fetch failed: {ex}")
        elif kind == "channel":
            url = src["url"]
            log(f"  fetching {url} ...")
            for vid, title in channel_streams(url):
                live[vid] = title
            log(f"  {url}: {len(live)} lives")
        elif kind == "bantul":
            for curl in src["urls"]:
                log(f"  fetching {curl} ...")
                for vid, title in channel_streams(curl):
                    live[vid] = title
                time.sleep(2)
            log(f"  bantul channels: {len(live)} lives")
        else:
            log(f"  WARNING: unknown source kind {kind!r} for {key}")
        live_sets[key] = live
        return live

    # Words that appear in nearly every Bantul/Gunungkidul/Magelang title and
    # therefore say nothing about WHICH camera it is. They must never be the
    # reason a replacement is picked (2026-11-06: "bantul" alone matched
    # Lapangan Paseban onto Pasar Bantul / Srandakan / Cinomati).
    GENERIC = {"live", "cctv", "24", "jam", "simpang", "view", "bantul",
               "gunungkidul", "magelang", "yogyakarta", "kota", "jogja",
               "pemantauan", "stream", "streams", "ptz"}
    DIRECTIONS = {"selatan", "utara", "barat", "timur",
                  "tenggara", "baratdaya", "timurlaut", "baratlaut"}

    def _words(text):
        return set(re.sub(r'[^a-z0-9]+', ' ', text.lower()).split())

    def _same_camera(ename, title):
        """True only if the candidate title is the same camera, not just the
        same regency or junction type. All distinctive (place) tokens of the
        entry name must appear in the title; direction words and numbers
        must agree (Paseban Utara != Paseban Barat, Patuk 1 != Patuk 2)."""
        ewords = _words(ename) - GENERIC
        twords = _words(title) - GENERIC
        enum = {w for w in ewords if w.isdigit()}
        if enum and not enum <= twords:
            return False
        edir = ewords & DIRECTIONS
        if edir and not edir <= twords:
            return False
        eplace = ewords - DIRECTIONS - enum
        if eplace:
            return eplace <= twords
        # Degenerate name (no place token at all): fall back to at least two
        # shared tokens, directions still enforced above.
        return len(ewords & twords) >= 2

    def match_in_live_set(entry, live):
        """Best name-match of an entry against a source live set.
        Only titles that pass _same_camera are candidates; among them the
        one sharing the most words wins. Returns (vid, title) or (None, None)."""
        best, best_score = None, 0
        for vid, title in live.items():
            if vid == entry["vid"]:
                continue
            if not _same_camera(entry["name"], title):
                continue
            score = len(_words(entry["name"]) & _words(title))
            if score > best_score:
                best, best_score = (vid, title), score
        return best if best else (None, None)

    dead, fixed = [], 0
    changed_paths = set()

    def flip_type(entry, new_typ):
        entry["cam"]["type"] = new_typ
        entry["typ"] = new_typ
        changed_paths.add(entry["_path"])

    def swap_url(entry, new_vid):
        entry["cam"]["url"] = f"https://www.youtube.com/watch?v={new_vid}"
        entry["vid"] = new_vid
        entry["url"] = entry["cam"]["url"]
        changed_paths.add(entry["_path"])

    for e in entries:
        # Embedding-disabled entries ("ytx") never get a player: only check
        # whether embedding came back, and flip them to playable.
        if e["typ"] == "ytx":
            oe = oembed_status(e["vid"])
            if oe == 200:
                flip_type(e, "yt")
                log(f"  FIXED {e['name'][:40]}: embedding re-enabled, back to playable")
                fixed += 1
            else:
                log(f"  OK   {e['name'][:40]} (no-embed)")
            continue
        live = live_set_for(e)
        if live is not None:
            if e["vid"] in live:
                # still live — but is it still embeddable?
                if oembed_status(e["vid"]) == 401:
                    flip_type(e, "ytx")
                    log(f"  FIXED {e['name'][:40]}: embedding disabled (error 150) -> no-embed")
                    fixed += 1
                else:
                    log(f"  OK   {e['name'][:40]}")
                continue
            # rotated or gone: first check the old ID itself — the channel's
            # /streams listing does not always show every live stream, and
            # an ID that is still live must never be swapped out (2026-11-06:
            # 10 Bantul entries were "dead" by listing but all still is_live).
            st, _ = live_status(e["vid"])
            if st == "is_live":
                log(f"  OK   {e['name'][:40]} (live, not in channel listing)")
                time.sleep(1)
                continue
            # genuinely dead: look for the replacement in the same source
            new_vid, title = match_in_live_set(e, live)
            if new_vid and not is_valid_vid(new_vid):
                log(f"  DEAD {e['name'][:40]} ({e['vid']}): replacement ID invalid, refusing to swap ({new_vid!r})")
                dead.append(e)
            elif new_vid:
                st, _ = live_status(new_vid)
                oe = oembed_status(new_vid)
                if st == "is_live" and oe != 401:
                    old_vid = e["vid"]
                    swap_url(e, new_vid)
                    log(f"  FIXED {e['name'][:40]}: {old_vid} -> {new_vid} ({title[:40]})")
                    fixed += 1
                else:
                    log(f"  DEAD {e['name'][:40]} ({e['vid']}): replacement {new_vid} not usable (live={st}, oembed={oe})")
                    dead.append(e)
            else:
                oe = oembed_status(e["vid"])
                why = "embedding disabled (error 150)" if oe == 401 else ("gone (404)" if oe == 404 else "no match in source")
                log(f"  DEAD {e['name'][:40]} ({e['vid']}): {why}")
                dead.append(e)
            time.sleep(1)
            continue
        # no source mapping: per-ID check
        st, _ = live_status(e["vid"])
        if st == "is_live":
            oe = oembed_status(e["vid"])
            if oe == 401:
                flip_type(e, "ytx")
                log(f"  FIXED {e['name'][:40]}: embedding disabled (error 150) -> no-embed")
                fixed += 1
            else:
                log(f"  OK   {e['name'][:40]}")
        else:
            log(f"  DEAD {e['name'][:40]} ({e['vid']}): {st or 'unknown'}")
            dead.append(e)
        time.sleep(2)

    log(f"\n== {len(dead)} dead, {fixed} fixed of {len(entries)} ==")
    if dead:
        for e in dead:
            log(f"  UNFIXED {e['name'][:50]} ({e['vid']}) [{groups.get(e['slug'], {}).get('name', '')}]")
    if CHECK_ONLY or not fixed:
        log("check-only mode" if CHECK_ONLY else "no fixes to push")
        return 0
    # Write back the changed JSON files (2-space indent), regenerate data.js,
    # and abort the push if either step fails.
    for path in sorted(changed_paths):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(docs[path], f, ensure_ascii=False, indent=2)
            f.write("\n")
    r = subprocess.run(["node", BUILD_DATA], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        log(f"ERROR: build-data failed, NOT pushing: {r.stdout[-500:]}{r.stderr[-500:]}")
        return 1
    r = subprocess.run(["node", "--check", DATA_JS], capture_output=True, timeout=15)
    if r.returncode != 0:
        log("ERROR: data.js syntax broken, NOT pushing")
        return 1
    r = subprocess.run(["git", "-C", WORK, "diff", "--quiet", "data", "assets/js/data.js"])
    if r.returncode == 0:
        log("no changes to commit")
        return 0
    subprocess.run(["git", "-C", WORK, "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(["git", "-C", WORK, "config", "user.email",
                    "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
    subprocess.run(["git", "-C", WORK, "add", "data", "assets/js/data.js"], check=True)
    subprocess.run(["git", "-C", WORK, "commit", "-m",
                    f"YouTube refresh: {fixed} rotated ID(s) fixed"], check=True)
    r = subprocess.run(["git", "-C", WORK, "push"], capture_output=True, text=True, timeout=120)
    log("push: " + ("OK" if r.returncode == 0 else f"FAILED: {r.stderr[:300]}"))
    return 0 if r.returncode == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
