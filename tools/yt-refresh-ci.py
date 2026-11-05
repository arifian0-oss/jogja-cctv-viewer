#!/usr/bin/env python3
"""YouTube embed refresh for jogja-cctv-viewer — GitHub Actions version.

Runs inside the repo checkout (no VM, no secrets): keeps the YouTube live
IDs in assets/js/data.js fresh by comparing them against the sources'
CURRENT live sets, instead of probing all 62 IDs one by one.

Method (few requests, gentle on YouTube):
  1. Fetch each source's current live set once — Magelang portal HTML,
     and one yt-dlp --flat-playlist per source channel's /streams page.
  2. Every data.js entry whose video ID is still in its source's live set
     is OK. Any other entry is dead/rotated: find its replacement in the
     same source's live set by name, verify it is_live, swap it in.
     Note: set membership means "still among the channel's recent
     streams", not a live check — the VM daily cron's per-ID live_status
     sweep remains the liveness backstop, and the viewer's own error
     handling catches anything that slips through in between.
  3. Entries with no source mapping (one-off channels) fall back to a
     per-ID yt-dlp live_status check + oEmbed (401 = embedding disabled).
  4. If anything changed, commit assets/js/data.js and push to main
     (GitHub Pages redeploys on push).

Usage: python3 tools/yt-refresh-ci.py [--check-only]
Env: YT_REFRESH_WORK (repo root, default: current directory)
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error

CHECK_ONLY = "--check-only" in sys.argv
WORK = os.environ.get("YT_REFRESH_WORK", os.getcwd())
DATA_JS = os.path.join(WORK, "assets/js/data.js")
LOG = []

def log(msg):
    print(msg, flush=True)
    LOG.append(msg)

def yt_dlp(*args, timeout=90):
    cmd = ["yt-dlp", "--no-check-certificate",
           "--extractor-args", "youtube:player_client=android"] + list(args)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip(), out.stderr.strip()
    except Exception as e:
        return "", f"EXC: {e}"

def live_status(vid):
    out, err = yt_dlp("--print", "%(live_status)s",
                      f"https://www.youtube.com/watch?v={vid}", timeout=40)
    return (out.split("\n")[0] if out else ""), err

def oembed_status(vid):
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
            res.append((vid.strip(), title.strip()))
    return res

def main():
    src = open(DATA_JS, encoding="utf-8").read()
    gm = re.search(r'(?:var|let|const)\s+GROUPS\s*=\s*\[(.*?)\];', src, re.S)
    groups = {}
    if gm:
        objs = re.findall(r'\{\s*"name"\s*:\s*"((?:[^"\\]|\\.)+)"', gm.group(1))
        for i, g in enumerate(objs):
            groups[str(i)] = g
    entries = []
    for m in re.finditer(
            r'\["((?:[^"\\]|\\.)+)",(\d+),((?:-?[\d.]+|null)),((?:-?[\d.]+|null)),'
            r'"(https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11}))"(?:,"(yt|ytx)")?\]', src):
        entries.append({"name": m.group(1), "gidx": m.group(2),
                        "vid": m.group(6), "url": m.group(5),
                        "typ": m.group(7) or "yt",
                        "raw": m.group(0)})
    log(f"found {len(entries)} YouTube entries")

    # Sources: group substring -> ("portal", url) | ("channel", url)
    SOURCES = {
        "Magelang": ("portal", "https://cctv.dishub.magelangkab.go.id/live"),
        "Gunungkidul (YouTube)": ("channel", "https://www.youtube.com/@KominfoGunungkidul/streams"),
        "JITV": ("channel", "https://www.youtube.com/@JitvPemdaDIY/streams"),
        "Bantul (YouTube)": ("bantul", None),
    }
    BANTUL_CHANNELS = [
        "https://www.youtube.com/channel/UCdkc9vAwtyoI9N0oAdsNB3g/streams",
        "https://www.youtube.com/channel/UCFCoIkiISgT8YJGP_JtbJTQ/streams",
    ]
    # group -> live set {vid: title}; filled lazily, one fetch per source
    live_sets = {}

    def source_key(entry):
        g = groups.get(entry["gidx"], "")
        for key in SOURCES:
            if key in g:
                return key
        return None

    def live_set_for(entry):
        key = source_key(entry)
        if key is None:
            return None
        if key in live_sets:
            return live_sets[key]
        kind, url = SOURCES[key]
        live = {}
        if kind == "portal":
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
                pairs = re.findall(
                    r"panel-heading'><center><a href='[^']*' *>([^<]+)</a>.*?"
                    r"<iframe src='https://www\.youtube\.com/embed/([A-Za-z0-9_-]+)'",
                    html, re.S)
                live = {v: n.strip() for n, v in pairs}
                log(f"  magelang portal: {len(live)} lives")
            except Exception as ex:
                log(f"  magelang portal fetch failed: {ex}")
        elif kind == "channel":
            log(f"  fetching {url} ...")
            for vid, title in channel_streams(url):
                live[vid] = title
            log(f"  {url}: {len(live)} lives")
        elif kind == "bantul":
            for curl in BANTUL_CHANNELS:
                log(f"  fetching {curl} ...")
                for vid, title in channel_streams(curl):
                    live[vid] = title
                time.sleep(2)
            log(f"  bantul channels: {len(live)} lives")
        live_sets[key] = live
        return live

    def match_in_live_set(entry, live):
        """Best name-match of an entry against a source live set.
        Scores word overlap and takes the best title; numbered cameras
        (Patuk 1 vs Patuk 2) must agree on the number token. Returns
        (vid, title) or (None, None)."""
        ename = re.sub(r'^(live|cctv|pemantauan)\s+', '', entry["name"].lower())
        ename = re.sub(r'[^a-z0-9 ]', '', ename)
        ewords = set(ename.split()) - {"live", "cctv", "24", "jam"}
        enum = {w for w in ewords if w.isdigit()}
        best, best_score, best_matched = None, 0, set()
        for vid, title in live.items():
            if vid == entry["vid"]:
                continue
            twords = set(re.sub(r'[^a-z0-9 ]', '', title.lower()).split())
            if enum and not enum <= twords:
                continue
            matched = ewords & twords
            if len(matched) > best_score:
                best, best_score, best_matched = (vid, title), len(matched), matched
        if best and (best_score >= 2 or (best_score == 1 and
                                          len(max(best_matched, key=len)) >= 5)):
            return best
        return None, None

    def flip_type(raw, new_typ):
        """Swap an entry's trailing type: ,"yt"] <-> ,"ytx"] (or add one)."""
        if raw.endswith(',"yt"]'):
            return raw[:-6] + ',"' + new_typ + '"]'
        if raw.endswith(',"ytx"]'):
            return raw[:-7] + ',"' + new_typ + '"]'
        return raw[:-2] + ',"' + new_typ + '"]'

    dead, fixed = [], 0
    for e in entries:
        # Embedding-disabled entries ("ytx") never get a player: only check
        # whether embedding came back, and flip them to playable.
        if e["typ"] == "ytx":
            oe = oembed_status(e["vid"])
            if oe == 200:
                src = src.replace(e["raw"], flip_type(e["raw"], "yt"))
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
                    src = src.replace(e["raw"], flip_type(e["raw"], "ytx"))
                    log(f"  FIXED {e['name'][:40]}: embedding disabled (error 150) -> no-embed")
                    fixed += 1
                else:
                    log(f"  OK   {e['name'][:40]}")
                continue
            # rotated or gone: look for the replacement in the same source
            new_vid, title = match_in_live_set(e, live)
            if new_vid:
                st, _ = live_status(new_vid)
                oe = oembed_status(new_vid)
                if st == "is_live" and oe != 401:
                    old_url, new_url = e["url"], f"https://www.youtube.com/watch?v={new_vid}"
                    src = src.replace(old_url, new_url)
                    log(f"  FIXED {e['name'][:40]}: {e['vid']} -> {new_vid} ({title[:40]})")
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
                src = src.replace(e["raw"], flip_type(e["raw"], "ytx"))
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
            log(f"  UNFIXED {e['name'][:50]} ({e['vid']}) [{groups.get(e['gidx'], '')}]")
    if CHECK_ONLY or not fixed:
        log("check-only mode" if CHECK_ONLY else "no fixes to push")
        return 0
    open(DATA_JS, "w", encoding="utf-8").write(src)
    r = subprocess.run(["node", "--check", DATA_JS], capture_output=True, timeout=15)
    if r.returncode != 0:
        log("ERROR: data.js syntax broken, NOT pushing")
        return 1
    r = subprocess.run(["git", "-C", WORK, "diff", "--quiet", "assets/js/data.js"])
    if r.returncode == 0:
        log("no changes to commit")
        return 0
    subprocess.run(["git", "-C", WORK, "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(["git", "-C", WORK, "config", "user.email",
                    "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
    subprocess.run(["git", "-C", WORK, "add", "assets/js/data.js"], check=True)
    subprocess.run(["git", "-C", WORK, "commit", "-m",
                    f"YouTube refresh: {fixed} rotated ID(s) fixed"], check=True)
    r = subprocess.run(["git", "-C", WORK, "push"], capture_output=True, text=True, timeout=120)
    log("push: " + ("OK" if r.returncode == 0 else f"FAILED: {r.stderr[:300]}"))
    return 0 if r.returncode == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
