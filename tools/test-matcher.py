#!/usr/bin/env python3
"""Unit tests for the camera-name matcher shared by the two refreshers.

Loads the matcher straight out of both scripts — tools/yt-refresh-ci.py
(hourly GitHub Actions) and ~/workspace/youtube-refresh/refresh.py (daily
VM cron) — and asserts they behave identically on every case.

Covers:
  * the 16 legacy _same_camera cases from the 2026-11-06 hardening
    (generic words can never trigger a swap; directions/numbers agree);
  * the 2026-11-12 Kodim regression: "Kodim Gunungkidul" (one distinctive
    token) must NOT claim "Bunderan Kodim Gunungkidul"'s stream, while
    Bunderan itself MUST claim it — via both the ownership guard and the
    unique-best-claim rule, each tested in isolation;
  * single-token entries can still be fixed when unambiguous;
  * ties are refused, owned IDs are never handed out, own vid excluded.

Usage: python3 tools/test-matcher.py   (exit 0 = all pass)
"""
import importlib.util
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CI = load_module("yt_refresh_ci", os.path.join(REPO, "tools", "yt-refresh-ci.py"))
VM = load_module("vm_refresh",
                 os.path.expanduser("~/workspace/youtube-refresh/refresh.py"))
MODULES = {"ci": CI, "vm": VM}

failures = []


def check(label, got, want):
    if got != want:
        failures.append(f"{label}: got {got!r}, want {want!r}")
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
    else:
        print(f"  ok   {label}")


# --- _same_camera: legacy cases (2026-11-06) -------------------------------
# (ename, title, expected)
SAME_CASES = [
    # generic words alone never trigger a swap
    ("Lapangan Paseban Bantul", "CCTV Lapangan Paseban Bantul", True),
    ("Lapangan Paseban Bantul", "CCTV Pasar Bantul", False),
    ("Lapangan Paseban Bantul", "CCTV Simpang Srandakan", False),
    ("Lapangan Paseban Bantul", "CCTV Tanjakan Cinomati Bantul", False),
    # directions must agree
    ("CCTV Simpang Paseban View Utara Bantul",
     "CCTV Simpang Paseban View Barat Bantul", False),
    ("Simpang Korpri View Selatan Bantul",
     "CCTV Simpang Korpri View Barat Bantul", False),
    ("CCTV Simpang Gose View Timur Utara Bantul",
     "CCTV Simpang Gose View Barat Daya Bantul", False),
    # numbers must agree
    ("Simpang Patuk 1", "CCTV Simpang Patuk 2", False),
    ("Simpang Patuk 1", "CCTV Simpang Patuk 1", True),
    # hyphen split, plain matches, plain misses
    ("Alun-Alun Kidul", "LIVE ALUN ALUN KIDUL", True),
    ("Pantai Baron", "LIVE PANTAI BARON", True),
    ("Pantai Baron", "LIVE PANTAI KUKUP", False),
    # rename disambiguation is human-facing; the matcher still matches
    # either Palbapang (the group/source keeps them apart)
    ("CCTV Simpang Palbapang (Magelang)",
     "CCTV Simpang Palbapang Bantul", True),
    # the Kodim pair: pairwise _same_camera still says True for both —
    # the false match is caught one level up, in _pick_replacement
    ("Kodim Gunungkidul",
     "LIVE PEMANTAUAN CCTV LALULINTAS KODIM GUNUNGKIDUL", True),
    ("Kodim Gunungkidul",
     "LIVE PEMANTAUAN BUNDERAN KODIM GUNUNGKIDUL", True),
    ("JITV Jogja Istimewa TV (24 jam)", "JITV Jogja Istimewa TV", True),
]

# --- _pick_replacement: regression + guard cases (2026-11-12) --------------
# (label, name, vid, candidates, siblings, owned, expected_vid_or_None)
KODIM_TITLE = "LIVE PEMANTAUAN BUNDERAN KODIM GUNUNGKIDUL"
KODIM_OK_TITLE = "LIVE PEMANTAUAN CCTV LALULINTAS KODIM GUNUNGKIDUL"
PICK_CASES = [
    # A. Kodim regression, both layers active: owned + better claimant
    ("kodim/owned+claim",
     "Kodim Gunungkidul", "QiIkBSYNZMU",
     [("FQ5n4lLHq7I", KODIM_TITLE)],
     ["Bunderan Kodim Gunungkidul"], {"FQ5n4lLHq7I"}, None),
    # B. unique-best claim alone (ID unowned — fresh rotation): Bunderan's
    # 2 place tokens beat Kodim's 1, so Kodim must not claim it
    ("kodim/claim-only",
     "Kodim Gunungkidul", "QiIkBSYNZMU",
     [("NEWVID12345", KODIM_TITLE)],
     ["Bunderan Kodim Gunungkidul"], set(), None),
    # C. Bunderan itself claims its own title (more specific wins)
    ("bunderan/claims-own",
     "Bunderan Kodim Gunungkidul", "OLDVID00001",
     [("FQ5n4lLHq7I", KODIM_TITLE)],
     ["Kodim Gunungkidul"], set(), "FQ5n4lLHq7I"),
    # D. single-token entry still fixable when unambiguous
    ("kodim/unambiguous",
     "Kodim Gunungkidul", "QiIkBSYNZMU",
     [("NEWVID12345", KODIM_OK_TITLE)],
     ["Simpang Pakelan", "Simpang Salaman"], set(), "NEWVID12345"),
    # E. tie: two 1-token siblings both match the title -> refuse
    ("tie/refused",
     "Kodim Gunungkidul", "QiIkBSYNZMU",
     [("NEWVID12345", "PASAR KODIM GUNUNGKIDUL")],
     ["Pasar Kodim"], set(), None),
    # F. ownership guard alone: name matches, but the ID belongs to
    # another entry
    ("owned/refused",
     "Simpang Pakelan", "OLDVID00001",
     [("VIDPAKELAN1", "CCTV SIMPANG PAKELAN")],
     [], {"VIDPAKELAN1"}, None),
    # G. own vid is never a candidate
    ("own-vid/excluded",
     "Simpang Pakelan", "VIDPAKELAN1",
     [("VIDPAKELAN1", "CCTV SIMPANG PAKELAN")],
     [], set(), None),
    # H. directions still enforced at pick level
    ("direction/refused",
     "Simpang Paseban View Utara Bantul", "OLDVID00001",
     [("VIDPASEBAN1", "CCTV Simpang Paseban View Barat Bantul")],
     [], set(), None),
    # I. plain happy path: unique match, unowned
    ("plain/match",
     "Simpang Pakelan", "OLDVID00001",
     [("VIDPAKELAN1", "CCTV SIMPANG PAKELAN")],
     ["Simpang Salaman"], set(), "VIDPAKELAN1"),
]


def main():
    print("== _same_camera (legacy) ==")
    for ename, title, want in SAME_CASES:
        for mname, mod in MODULES.items():
            got = mod._same_camera(ename, title)
            check(f"[{mname}] {ename!r} vs {title[:35]!r}", got, want)
    print("== _place_tokens specificity ==")
    for mname, mod in MODULES.items():
        check(f"[{mname}] Kodim tokens", mod._place_tokens("Kodim Gunungkidul"),
              {"kodim"})
        check(f"[{mname}] Bunderan tokens",
              mod._place_tokens("Bunderan Kodim Gunungkidul"),
              {"bunderan", "kodim"})
    print("== _pick_replacement (2026-11-12) ==")
    for label, name, vid, cands, sibs, owned, want in PICK_CASES:
        for mname, mod in MODULES.items():
            got, _ = mod._pick_replacement(name, vid, list(cands),
                                           list(sibs), set(owned))
            check(f"[{mname}] {label}", got, want)
    print()
    if failures:
        print(f"FAILED: {len(failures)} case(s)")
        return 1
    total = len(SAME_CASES) * 2 + 4 + len(PICK_CASES) * 2
    print(f"ALL {total} CHECKS PASSED (both modules agree)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
