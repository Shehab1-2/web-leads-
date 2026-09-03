#!/usr/bin/env python3
"""Stage 1: pull local businesses from Apify and pre-classify by web presence.
See the skill instructions for usage."""

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ACTOR = "compass~crawler-google-places"
API_ROOT = "https://api.apify.com/v2"

# Approximate actor pricing, used only for the pre-run cost estimate.
USD_PER_PLACE = 0.0015

# A "website" on one of these hosts is not a real website. For a web-design
# pitch these are the best leads in the list: the business has an audience but
# nowhere of their own to send it.
SOCIAL_HOSTS = {
    "facebook.com", "m.facebook.com", "fb.com", "fb.me",
    "instagram.com", "linktr.ee", "linkin.bio", "beacons.ai", "carrd.co",
    "business.site",           # Google My Business auto-generated pages
    "sites.google.com",
    "yelp.com", "nextdoor.com", "tripadvisor.com",
    "twitter.com", "x.com", "tiktok.com", "youtube.com", "linkedin.com",
    "wa.me", "api.whatsapp.com", "t.me",
    "google.com", "goo.gl", "maps.app.goo.gl",
}

# Free/entry-tier website hosts. These ARE real sites, but a business still on
# the free subdomain years later is almost always running an untouched template.
FREE_HOSTS = {
    "wixsite.com", "weebly.com", "blogspot.com", "wordpress.com",
    "godaddysites.com", "square.site", "webnode.com", "jimdosite.com",
    "yolasite.com", "tripod.com", "angelfire.com", "webs.com",
    "myfreesites.net", "site123.me", "strikingly.com",
}


def log(msg):
    """Print ASCII-safe output. Windows consoles default to cp1252 and will
    raise UnicodeEncodeError on stray non-ASCII characters mid-run."""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode("ascii", "replace").decode("ascii"), flush=True)


def die(msg, code=1):
    log(f"ERROR: {msg}")
    sys.exit(code)


def api_request(url, method="GET", payload=None, timeout=60):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:600]
        if e.code == 401:
            die("Apify rejected the token (401). Check APIFY_API_TOKEN is the "
                "full token from https://console.apify.com/account/integrations")
        if e.code == 402:
            die("Apify says you are out of credit (402). Check your usage at "
                "https://console.apify.com/billing")
        if e.code == 404:
            die(f"Apify endpoint not found (404): {url}\n{detail}")
        die(f"Apify HTTP {e.code}: {detail}")
    except urllib.error.URLError as e:
        die(f"Could not reach the Apify API ({e.reason}).\n"
            "If you are running inside a sandboxed/cloud session, outbound "
            "network is probably blocked - run this from Claude Code on your "
            "own machine instead.")
    except TimeoutError:
        die("Timed out talking to the Apify API.")

    try:
        return json.loads(body)
    except json.JSONDecodeError:
        die(f"Apify returned non-JSON:\n{body[:600]}")


def start_run(niche, location, max_places, token):
    """Start the actor asynchronously.

    Deliberately NOT using run-sync-get-dataset-items: that endpoint hard-fails
    at 300 seconds, which a larger search can exceed, and it gives no progress
    signal while waiting. Starting + polling costs a few extra lines and removes
    that whole class of failure.
    """
    payload = {
        "searchStringsArray": [niche],
        "locationQuery": location,
        "maxCrawledPlacesPerSearch": max_places,
        "language": "en",
        "website": "allPlaces",   # we classify ourselves; see SOCIAL_HOSTS
        "skipClosedPlaces": True,
        "maxReviews": 0,          # keep the run cheap and fast
        "maxImages": 0,
        "maxQuestions": 0,
    }
    url = f"{API_ROOT}/acts/{ACTOR}/runs?token={urllib.parse.quote(token)}"
    resp = api_request(url, method="POST", payload=payload)
    data = resp.get("data") or {}
    run_id = data.get("id")
    dataset_id = data.get("defaultDatasetId")
    if not run_id or not dataset_id:
        die(f"Apify did not return a run id/dataset id. Response:\n"
            f"{json.dumps(resp)[:600]}")
    return run_id, dataset_id


def wait_for_run(run_id, token, max_wait_seconds=600):
    """Poll until the run finishes. Returns the terminal status."""
    url = f"{API_ROOT}/actor-runs/{run_id}?token={urllib.parse.quote(token)}"
    waited = 0
    delay = 5
    last_status = None
    while waited < max_wait_seconds:
        data = (api_request(url) or {}).get("data") or {}
        status = data.get("status")
        if status != last_status:
            log(f"  run status: {status}")
            last_status = status
        if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMING-OUT"):
            return status
        time.sleep(delay)
        waited += delay
        delay = min(delay + 2, 15)
    log(f"  still running after {max_wait_seconds}s - giving up on waiting.")
    log(f"  check it here: https://console.apify.com/actors/runs/{run_id}")
    return "TIMEOUT_WAITING"


def fetch_items(dataset_id, token):
    url = (f"{API_ROOT}/datasets/{dataset_id}/items"
           f"?token={urllib.parse.quote(token)}&clean=true&format=json")
    items = api_request(url, timeout=120)
    if not isinstance(items, list):
        die(f"Expected a list of places, got: {json.dumps(items)[:400]}")
    return items


def host_of(url):
    if not url:
        return ""
    try:
        netloc = urllib.parse.urlparse(url if "//" in url else "http://" + url).netloc
    except ValueError:
        return ""
    return netloc.lower().split(":")[0].removeprefix("www.")


def registrable(host):
    """Rough 'last two labels' domain. Good enough to match our host lists;
    we are not trying to be a full public-suffix implementation here."""
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def classify(website):
    """Decide whether a listed 'website' is actually a website."""
    if not website or not website.strip():
        return "no_website"
    host = host_of(website)
    if not host:
        return "no_website"
    base = registrable(host)
    if base in SOCIAL_HOSTS or host in SOCIAL_HOSTS:
        return "social_only"
    # free hosts appear as <business>.wixsite.com, so check the suffix too
    if base in FREE_HOSTS or any(host.endswith("." + h) for h in FREE_HOSTS):
        return "free_host"
    return "needs_check"


def slim(item):
    website = (item.get("website") or "").strip()
    return {
        "place_id": item.get("placeId") or "",
        "name": item.get("title") or "",
        "phone": item.get("phone") or item.get("phoneUnformatted") or "",
        "address": item.get("address") or "",
        "city": item.get("city") or "",
        "category": item.get("categoryName") or "",
        "website": website,
        "tier": classify(website),
        "rating": item.get("totalScore") or "",
        "reviews": item.get("reviewsCount") or "",
        "maps_url": item.get("url") or "",
    }


def load_seen(seen_path):
    """Previously surfaced businesses, so repeat runs don't re-pitch the same
    shops. Keyed by placeId, falling back to name+address for older rows."""
    seen_ids, seen_keys = set(), set()
    if not seen_path.exists():
        return seen_ids, seen_keys
    try:
        with open(seen_path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row.get("place_id"):
                    seen_ids.add(row["place_id"])
                key = (row.get("name", "").strip().lower(),
                       row.get("address", "").strip().lower())
                if any(key):
                    seen_keys.add(key)
    except OSError as e:
        log(f"  (warning: could not read {seen_path.name}: {e})")
    return seen_ids, seen_keys


def append_seen(seen_path, rows, niche, location):
    new = not seen_path.exists()
    with open(seen_path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["place_id", "name", "address", "phone", "tier",
                        "niche", "location", "first_seen", "status"])
        today = date.today().isoformat()
        for r in rows:
            w.writerow([r["place_id"], r["name"], r["address"], r["phone"],
                        r["tier"], niche, location, today, ""])


TIER_ORDER = {"no_website": 0, "social_only": 1, "free_host": 2, "needs_check": 3}


def main():
    ap = argparse.ArgumentParser(
        description="Find local businesses that need a website (stage 1).")
    ap.add_argument("--niche", required=True,
                    help='business type, e.g. "plumbers", "hair salons"')
    ap.add_argument("--location", required=True,
                    help='city/area, e.g. "Austin, TX" or "78704"')
    ap.add_argument("--max", type=int, default=15,
                    help="max places to pull (default 15)")
    ap.add_argument("--out-dir", default=".", help="where to write output files")
    ap.add_argument("--seen-file", default="seen_leads.csv",
                    help="running list of already-surfaced businesses")
    ap.add_argument("--include-seen", action="store_true",
                    help="do not filter out businesses from previous runs")
    ap.add_argument("--yes", action="store_true",
                    help="skip the confirmation prompt for large runs")
    args = ap.parse_args()

    token = os.environ.get("APIFY_API_TOKEN", "").strip()
    if not token:
        die("APIFY_API_TOKEN is not set.\n"
            '  PowerShell:  $env:APIFY_API_TOKEN = "apify_api_xxx"\n'
            "  bash/zsh:    export APIFY_API_TOKEN=apify_api_xxx\n"
            "  Get a token at https://console.apify.com/account/integrations")
    if not token.startswith("apify_api_"):
        log("  (warning: token does not start with 'apify_api_' - "
            "continuing anyway, but check it if the next step fails)")

    if args.max < 1:
        die("--max must be at least 1")
    if args.max > 200:
        die("--max above 200 is almost certainly a mistake for this workflow.")

    # Cost guard. Cheap, but on the free tier the monthly credit is small enough
    # that an accidental 3-digit run is worth one confirmation.
    est = args.max * USD_PER_PLACE
    if args.max > 50 and not args.yes:
        log(f"About to scrape up to {args.max} places (~${est:.2f}). "
            "Re-run with --yes to confirm.")
        sys.exit(2)

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    seen_path = out_dir / args.seen_file

    log(f"Searching Apify for: {args.niche} in {args.location} "
        f"(max {args.max}, est ~${est:.2f})")

    run_id, dataset_id = start_run(args.niche, args.location, args.max, token)
    log(f"  started run {run_id}")
    status = wait_for_run(run_id, token)
    if status not in ("SUCCEEDED", "TIMEOUT_WAITING"):
        die(f"Apify run ended with status {status}. "
            f"Details: https://console.apify.com/actors/runs/{run_id}")

    raw = fetch_items(dataset_id, token)
    log(f"  got {len(raw)} places back")
    if not raw:
        die("Apify returned zero places. That usually means the niche or "
            "location did not match anything - check the spelling, or try a "
            "broader area, before re-running.")

    rows, dupes = [], set()
    for item in raw:
        r = slim(item)
        if not r["name"]:
            continue
        key = r["place_id"] or (r["name"].lower(), r["address"].lower())
        if key in dupes:
            continue
        dupes.add(key)
        rows.append(r)

    skipped = 0
    if not args.include_seen:
        seen_ids, seen_keys = load_seen(seen_path)
        kept = []
        for r in rows:
            k = (r["name"].strip().lower(), r["address"].strip().lower())
            if (r["place_id"] and r["place_id"] in seen_ids) or k in seen_keys:
                skipped += 1
                continue
            kept.append(r)
        rows = kept

    rows.sort(key=lambda r: (TIER_ORDER.get(r["tier"], 9), -(r["reviews"] or 0)
                             if isinstance(r["reviews"], int) else 0))

    # Nothing new: stop before writing. Overwriting the previous run's CSV with
    # an empty file would quietly destroy a list the user may still be working.
    if not rows:
        log("")
        log(f"No new businesses - all {skipped} result(s) were already "
            "surfaced in an earlier run.")
        log("Nothing was written (your previous lead files are untouched).")
        log("Try a different niche or a nearby area, raise --max, or pass "
            "--include-seen to show them again anyway.")
        return

    # Name outputs after the search so a second search does not clobber the
    # first one's list.
    slug = re.sub(r"[^a-z0-9]+", "-",
                  f"{args.niche}-{args.location}".lower()).strip("-")[:60]
    raw_path = out_dir / f"leads_{slug}.json"
    csv_path = out_dir / f"leads_{slug}.csv"
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2)
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "tier", "name", "phone", "address", "city", "category",
            "website", "rating", "reviews", "maps_url", "place_id"])
        w.writeheader()
        w.writerows(rows)

    append_seen(seen_path, rows, args.niche, args.location)

    counts = {}
    for r in rows:
        counts[r["tier"]] = counts.get(r["tier"], 0) + 1

    log("")
    log("Results by tier:")
    for tier in ("no_website", "social_only", "free_host", "needs_check"):
        if counts.get(tier):
            log(f"  {tier:<12} {counts[tier]}")
    if skipped:
        log(f"  ({skipped} already surfaced in a previous run, filtered out)")
    log("")
    log(f"Wrote {csv_path}")
    log(f"Wrote {raw_path}")
    needs = counts.get("needs_check", 0)
    if needs:
        log(f"\nNext: {needs} business(es) have a real domain and need the "
            "browser check (stage 2 of the skill).")
    else:
        log("\nNo sites need the browser check - every lead is already "
            "classified from the Maps data.")


if __name__ == "__main__":
    main()
