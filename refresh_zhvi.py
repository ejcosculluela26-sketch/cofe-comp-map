"""
refresh_zhvi.py — Enrich cofe-comp-map/data.json with Zillow Home Value Index
(ZHVI) at the ZIP level. Used both locally (after export_data.py) and monthly
via a GitHub Action. Idempotent — safe to re-run.

Data sources (all free, no API key):
  - Zillow Research ZHVI (ZIP-level, mid-tier SFR+condo, smoothed, seasonally adjusted)
    https://www.zillow.com/research/data/  — updated ~3rd Thursday of each month
  - US Census 2024 ZCTA Gazetteer (ZIP centroids, lat/lng for nearest-ZIP fallback)

For each comp:
  1. Extract 5-digit ZIP from its address
  2. If that ZIP has a ZHVI value, use it directly
  3. Otherwise (industrial-heavy ZIPs often lack ZHVI), find the nearest ZIP within
     3 miles of the comp's coordinates that DOES have a ZHVI value, and use that.
  4. If no ZIP within 3 miles has ZHVI, leave zhvi as null.

Run locally:
    python3 refresh_zhvi.py           # uses cached downloads if present
    python3 refresh_zhvi.py --force   # re-downloads ZHVI (use for monthly refresh)
"""

import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from math import atan2, cos, radians, sin, sqrt
from pathlib import Path

ZHVI_URL = (
    "https://files.zillowstatic.com/research/public_csvs/zhvi/"
    "Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv"
)
ZCTA_URL = (
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
    "2024_Gazetteer/2024_Gaz_zcta_national.zip"
)

# Script lives inside cofe-comp-map/, so data.json is next to it.
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_JSON = SCRIPT_DIR / "data.json"
OVERLAY_JSON = SCRIPT_DIR / "zhvi_overlay.json"
CACHE_DIR = SCRIPT_DIR / ".zhvi_cache"

ZIP_RE = re.compile(r"\b(\d{5})(?:-\d{4})?\b")
MAX_FALLBACK_MILES = 3.0

# Target-market bounding boxes for the wealth-cloud overlay.
# (lat_min, lat_max, lng_min, lng_max) — padded a bit beyond metro core
# to catch suburban ZIPs on the edges of each market.
#
# South Florida: expanded to cover the full peninsula south of ~Vero Beach,
# including the Gulf coast (Naples, Fort Myers, Marco Island) which was
# incorrectly excluded in earlier versions — that's why the SFL heatmap
# looked patchy / east-coast-only.
MARKET_BOXES = {
    "Houston":       (28.9, 30.6, -96.4, -94.3),
    "DFW":           (31.9, 33.7, -97.9, -96.0),
    "San Antonio":   (28.9, 30.1, -99.1, -97.4),
    "Austin":        (29.7, 31.1, -98.6, -96.9),
    "South Florida": (24.4, 27.8, -82.3, -79.8),
    "Orlando":       (28.1, 29.1, -81.9, -80.7),
    "Tampa":         (27.2, 28.6, -83.1, -81.8),
    "Atlanta":       (33.1, 34.4, -85.1, -83.6),
    "Charlotte":     (34.8, 35.7, -81.3, -80.3),
}


def log(msg):
    print(msg, flush=True)


def download(url, dest, force=False):
    CACHE_DIR.mkdir(exist_ok=True)
    if dest.exists() and not force:
        log(f"  cache hit: {dest.name}")
        return
    log(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "cofe-comp-map/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())
    log(f"  saved:   {dest.name} ({dest.stat().st_size:,} bytes)")


def load_zhvi(force=False):
    """Return ({zip5: latest ZHVI float}, 'YYYY-MM-DD')."""
    path = CACHE_DIR / "zhvi.csv"
    download(ZHVI_URL, path, force=force)

    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        date_cols = [i for i, h in enumerate(header) if re.match(r"\d{4}-\d{2}-\d{2}", h)]
        if not date_cols:
            sys.exit("error: ZHVI CSV has no date columns — schema may have changed")
        latest_col = date_cols[-1]
        latest_date = header[latest_col]
        try:
            zip_col = header.index("RegionName")
        except ValueError:
            sys.exit("error: ZHVI CSV missing 'RegionName' column")

        result = {}
        for row in reader:
            if len(row) <= latest_col:
                continue
            z = str(row[zip_col]).strip().zfill(5)
            try:
                v = float(row[latest_col])
                if v > 0:
                    result[z] = v
            except ValueError:
                pass
    log(f"  parsed ZHVI for {len(result):,} ZIPs (latest month: {latest_date})")
    return result, latest_date


def load_zcta_centroids(force=False):
    """Return {zip5: (lat, lng)} for every US ZCTA."""
    path = CACHE_DIR / "zcta.zip"
    download(ZCTA_URL, path, force=force)

    result = {}
    with zipfile.ZipFile(path) as zf:
        txt_name = next((n for n in zf.namelist() if n.endswith(".txt")), None)
        if not txt_name:
            sys.exit("error: ZCTA zip has no .txt file inside")
        with zf.open(txt_name) as f:
            text = io.TextIOWrapper(f, encoding="utf-8")
            reader = csv.DictReader(text, delimiter="\t")
            reader.fieldnames = [(fn or "").strip() for fn in (reader.fieldnames or [])]
            lat_key = next((k for k in reader.fieldnames if k.upper() == "INTPTLAT"), None)
            lng_key = next((k for k in reader.fieldnames if k.upper() == "INTPTLONG"), None)
            zip_key = next((k for k in reader.fieldnames if k.upper() in ("GEOID", "GEOID20")), None)
            if not (lat_key and lng_key and zip_key):
                sys.exit(f"error: unexpected ZCTA columns: {reader.fieldnames}")
            for row in reader:
                z = (row.get(zip_key) or "").strip().zfill(5)
                try:
                    result[z] = (float(row[lat_key]), float(row[lng_key]))
                except (ValueError, TypeError):
                    pass
    log(f"  parsed centroids for {len(result):,} ZCTAs")
    return result


def extract_zip(addr):
    if not addr:
        return None
    m = ZIP_RE.search(addr)
    return m.group(1) if m else None


def haversine_mi(lat1, lon1, lat2, lon2):
    R = 3958.8  # miles
    dl = radians(lat2 - lat1)
    dg = radians(lon2 - lon1)
    a = sin(dl / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dg / 2) ** 2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))


def build_zhvi_centroid_list(zhvi, centroids):
    """Filter centroids to only ZIPs that have ZHVI, for fast nearest-search."""
    return [(z, lat, lng) for z, (lat, lng) in centroids.items() if z in zhvi]


def nearest_zhvi_zip(lat, lng, zhvi_centroids):
    """Return (zip, distance_mi) for the closest ZHVI-bearing ZIP. None if lat/lng missing."""
    if lat is None or lng is None:
        return None, None
    best_dist = float("inf")
    best_zip = None
    cos_lat = cos(radians(lat))
    # Use a cheap lat/lng box to skip far-away ZIPs, then haversine the survivors.
    # 3 miles ~= 0.044° lat, and 0.044/cos(lat)° lng.
    max_deg_lat = 0.05
    max_deg_lng = 0.05 / max(cos_lat, 0.1)
    for z, zlat, zlng in zhvi_centroids:
        if abs(zlat - lat) > max_deg_lat:
            continue
        if abs(zlng - lng) > max_deg_lng:
            continue
        d = haversine_mi(lat, lng, zlat, zlng)
        if d < best_dist:
            best_dist = d
            best_zip = z
    if best_zip is not None and best_dist <= MAX_FALLBACK_MILES:
        return best_zip, best_dist
    return None, None


def enrich(entries, zhvi, centroids):
    zhvi_centroids = build_zhvi_centroid_list(zhvi, centroids)
    stats = {"direct": 0, "nearest": 0, "miss": 0, "no_coord": 0}
    for e in entries:
        # Primary: ZIP parsed from address
        z = extract_zip(e.get("a"))
        if z and z in zhvi:
            e["zhvi"] = int(round(zhvi[z]))
            e["zhvi_src"] = z
            stats["direct"] += 1
            continue
        # Fallback: nearest ZHVI-bearing ZIP within 3 miles of the pin
        lat = e.get("lat")
        lng = e.get("lng")
        if lat is None or lng is None:
            e["zhvi"] = None
            e["zhvi_src"] = ""
            stats["no_coord"] += 1
            continue
        nz, dist = nearest_zhvi_zip(lat, lng, zhvi_centroids)
        if nz is not None:
            e["zhvi"] = int(round(zhvi[nz]))
            e["zhvi_src"] = f"{nz}~{dist:.1f}mi"
            stats["nearest"] += 1
        else:
            e["zhvi"] = None
            e["zhvi_src"] = ""
            stats["miss"] += 1
    return stats


def build_overlay(zhvi, centroids):
    """
    Build a compact overlay payload: all ZIPs inside any MARKET_BOXES that have
    both a ZHVI value and a centroid. Output shape is a list of 4-element arrays
    [lat, lng, zhvi_int, zip_str] so the frontend can render a heatmap AND a
    debug dots mode with clickable tooltips.
    """
    points = []
    per_market = {m: [] for m in MARKET_BOXES}  # list of (zip, lat, lng, value)
    for z, (lat, lng) in centroids.items():
        if z not in zhvi:
            continue
        for name, (la_min, la_max, lo_min, lo_max) in MARKET_BOXES.items():
            if la_min <= lat <= la_max and lo_min <= lng <= lo_max:
                v = int(round(zhvi[z]))
                points.append([round(lat, 5), round(lng, 5), v, z])
                per_market[name].append((z, lat, lng, v))
                break
    return points, per_market


def diagnostic_log(per_market):
    """Log top/bottom ZIPs per market so we can spot-check the heatmap against reality."""
    for name, rows in per_market.items():
        if not rows:
            log(f"  [{name}] NO ZIPs in box — check bounding box!")
            continue
        rows_sorted = sorted(rows, key=lambda r: r[3], reverse=True)
        top = rows_sorted[:5]
        bot = rows_sorted[-5:]
        n = len(rows_sorted)
        avg = sum(r[3] for r in rows_sorted) / n
        log(f"  [{name}] {n} ZIPs, avg ${avg:,.0f}")
        log(f"    top 5:    " + ", ".join(f"{r[0]} (${r[3]:,})" for r in top))
        log(f"    bottom 5: " + ", ".join(f"{r[0]} (${r[3]:,})" for r in bot))


def write_overlay(points, latest_date, market_boxes):
    payload = {
        "updated": latest_date,
        "points": points,
        "boxes": {name: list(box) for name, box in market_boxes.items()},
    }
    with open(OVERLAY_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))


def main():
    force = "--force" in sys.argv

    if not DATA_JSON.exists():
        sys.exit(f"error: {DATA_JSON} not found — run export_data.py first")

    log("Loading Zillow ZHVI...")
    zhvi, latest_date = load_zhvi(force=force)

    log("Loading Census ZCTA centroids...")
    centroids = load_zcta_centroids(force=force)

    log(f"Loading {DATA_JSON.name}...")
    with open(DATA_JSON, encoding="utf-8") as f:
        entries = json.load(f)
    log(f"  loaded {len(entries):,} comps")

    log("Enriching comps with ZHVI...")
    stats = enrich(entries, zhvi, centroids)

    with open(DATA_JSON, "w", encoding="utf-8") as f:
        json.dump(entries, f, separators=(",", ":"))

    log("Building market-wide ZHVI overlay...")
    overlay_points, per_market = build_overlay(zhvi, centroids)
    write_overlay(overlay_points, latest_date, MARKET_BOXES)
    overlay_size = OVERLAY_JSON.stat().st_size

    log("")
    log("=" * 60)
    log(f"  ZHVI latest month:      {latest_date}")
    log("  --- comp enrichment ---")
    log(f"  direct ZIP match:       {stats['direct']:>6,}")
    log(f"  nearest ZIP (<3 miles): {stats['nearest']:>6,}")
    log(f"  no nearby ZIP w/ZHVI:   {stats['miss']:>6,}")
    log(f"  no coordinates at all:  {stats['no_coord']:>6,}")
    log("  --- market overlay ---")
    log(f"  overlay ZIPs total:     {len(overlay_points):>6,}")
    for m, rows in per_market.items():
        log(f"    {m:<15}      {len(rows):>6,}")
    log(f"  overlay file size:      {overlay_size:>6,} bytes")
    log("=" * 60)
    log("")
    log("Per-market diagnostic (spot-check these against reality):")
    diagnostic_log(per_market)
    log("")
    log(f"{DATA_JSON.name} updated with ZHVI values as of {latest_date}")
    log(f"{OVERLAY_JSON.name} written with {len(overlay_points):,} market ZIP points")


if __name__ == "__main__":
    main()
