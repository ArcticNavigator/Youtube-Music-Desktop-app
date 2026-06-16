# ═══════════════════════════════════════════════════════════════════════════════
# data.py — Supabase first-login record client (Phase 2, items #4–6)
# ═══════════════════════════════════════════════════════════════════════════════
#
# The app never holds the service_role key. All privileged DB access goes through
# our Supabase Edge Functions, which verify the caller's Google token and act as that
# user. This module is the sidecar's thin client for those functions.
#
#   record_first_login(access_token)  → POST /first-login   (idempotent; ≤100 cap in DB)
#   get_my_data(access_token)         → GET  /me-data       (data-subject export)
#   delete_my_data(access_token)      → DELETE /me-data      (erasure)
#   signups_open()                    → GET  /signups-open  (cap UX hint)
#
# We send the Supabase anon key on every call (so it works whether or not the
# function has JWT verification on), and the Google token in the body (first-login)
# or the X-Google-Token header (me-data) — never in Authorization, which the anon key
# occupies. Approximate location is resolved ON-DEVICE: whoami tells us our public IP
# (which only ever reaches our own Supabase), then geoip2 looks it up against the
# bundled DB-IP .mmdb. If that file isn't present, the record is written without
# location (graceful) rather than failing.

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE / ".env")

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
ANON_KEY = os.getenv("SUPABASE_ANON_KEY") or ""
_FUNCTIONS = f"{SUPABASE_URL}/functions/v1" if SUPABASE_URL else ""

# Bump when the pre-sign-in notice wording materially changes (stored per record).
POLICY_VERSION = "1"

_GEOIP_DIR = _HERE / "data"


def _geoip_db() -> Path | None:
    """Locate the bundled DB-IP .mmdb. DB-IP names its files with a month suffix
    (e.g. dbip-city-lite-2026-06.mmdb), so we glob rather than hard-code — monthly
    refreshes just drop in. Returns the newest match, or None if none is present."""
    if not _GEOIP_DIR.exists():
        return None
    files = sorted(_GEOIP_DIR.glob("dbip-city-lite*.mmdb")) or sorted(_GEOIP_DIR.glob("*.mmdb"))
    return files[-1] if files else None


def is_configured() -> bool:
    return bool(_FUNCTIONS and ANON_KEY)


def _call(path: str, method: str = "GET", body: dict | None = None,
          google_token: str | None = None) -> dict:
    if not is_configured():
        raise RuntimeError("Supabase is not configured (SUPABASE_URL / SUPABASE_ANON_KEY).")
    headers = {
        "apikey": ANON_KEY,
        "Authorization": f"Bearer {ANON_KEY}",
        "Content-Type": "application/json",
    }
    if google_token:
        headers["X-Google-Token"] = google_token
    payload = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{_FUNCTIONS}/{path}", data=payload, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode()
            out = json.loads(raw) if raw else {}
            out["_status"] = resp.status
            return out
    except urllib.error.HTTPError as e:
        raw = e.read().decode() if e.fp else ""
        out = json.loads(raw) if raw.startswith("{") else {"error": raw or "http_error"}
        out["_status"] = e.code
        return out


# ── Location (on-device) ──────────────────────────────────────────────────────

def _public_ip() -> str | None:
    try:
        return (_call("whoami").get("ip")) or None
    except Exception:
        return None


def _resolve_location(ip: str | None) -> dict:
    """Coarse city/region/country from the bundled DB-IP db. {} if unavailable."""
    db = _geoip_db()
    if not ip or not db:
        return {}
    try:
        import geoip2.database
        with geoip2.database.Reader(str(db)) as reader:
            r = reader.city(ip)
            region = r.subdivisions.most_specific.name if r.subdivisions else None
            return {"city": r.city.name, "region": region, "country": r.country.name}
    except Exception:
        return {}


# ── Edge-function calls ────────────────────────────────────────────────────────

def signups_open() -> dict:
    """{open, count}. Fails OPEN — a transient error must not block a returning user."""
    try:
        r = _call("signups-open")
        return {"open": bool(r.get("open", True)), "count": r.get("count")}
    except Exception:
        return {"open": True, "count": None}


def record_first_login(access_token: str) -> dict:
    """Idempotent first-login write. Returns {ok, created} or {ok:False, error:'signups_full'}."""
    loc = _resolve_location(_public_ip())
    body = {
        "access_token": access_token,
        "location_city": loc.get("city"),
        "location_region": loc.get("region"),
        "location_country": loc.get("country"),
        "policy_version": POLICY_VERSION,
    }
    r = _call("first-login", method="POST", body=body)
    if r.get("error") == "signups_full" or r.get("_status") == 403:
        return {"ok": False, "error": "signups_full"}
    if r.get("error"):
        raise RuntimeError(str(r.get("error")))
    return {"ok": bool(r.get("ok")), "created": bool(r.get("created"))}


def get_my_data(access_token: str) -> dict:
    """Data-subject export: the caller's own stored row (or null)."""
    r = _call("me-data", method="GET", google_token=access_token)
    return {"data": r.get("data")}


def delete_my_data(access_token: str) -> dict:
    """Data-subject erasure: hard-delete the caller's row."""
    r = _call("me-data", method="DELETE", google_token=access_token)
    return {"ok": bool(r.get("ok"))}
