"""
server.py
─────────────────────────────────────────────────────────────────
Chromium History Parser — Flask API Backend
Drop raw Chromium History (SQLite) file → returns structured JSON
─────────────────────────────────────────────────────────────────
Install:
    pip install flask flask-cors

Run:
    python server.py
    → http://localhost:5000

Endpoints:
    POST /api/parse   multipart/form-data  field: "file" (raw History SQLite)
                      optional form fields: browser, profile
    GET  /api/health
─────────────────────────────────────────────────────────────────
"""

import os
import json
import sqlite3
import hashlib
import logging
import tempfile
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from pathlib import Path

from flask import Flask, request, Response
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("HistoryAPI")


# ══════════════════════════════════════════════════════════════
#  CONSTANTS
# ══════════════════════════════════════════════════════════════

EPOCH_START = datetime(1601, 1, 1, tzinfo=timezone.utc)

TRANSITION_TYPES = {
    0: "LINK",          1: "TYPED",           2: "AUTO_BOOKMARK",
    3: "AUTO_SUBFRAME", 4: "MANUAL_SUBFRAME",  5: "GENERATED",
    6: "AUTO_TOPLEVEL", 7: "FORM_SUBMIT",      8: "RELOAD",
    9: "KEYWORD",      10: "KEYWORD_GENERATED",
}

TRANSITION_QUALIFIERS = {
    0x01000000: "BLOCKED",          0x02000000: "FORWARD_BACK",
    0x04000000: "FROM_ADDRESS_BAR", 0x08000000: "HOME_PAGE",
    0x10000000: "FROM_API",         0x20000000: "CHAIN_START",
    0x40000000: "CHAIN_END",        0x80000000: "CLIENT_REDIRECT",
}

DOWNLOAD_STATES = {
    0: "IN_PROGRESS", 1: "COMPLETE",   2: "CANCELLED",
    3: "INTERRUPTED",  4: "DANGEROUS",
}

DANGER_TYPES = {
    0:  "NOT_DANGEROUS",             1:  "DANGEROUS_FILE",
    2:  "DANGEROUS_URL",             3:  "DANGEROUS_CONTENT",
    4:  "MAYBE_DANGEROUS_CONTENT",   5:  "UNCOMMON_CONTENT",
    6:  "USER_VALIDATED",            7:  "DANGEROUS_HOST",
    8:  "POTENTIALLY_UNWANTED",      9:  "ALLOWLISTED_BY_POLICY",
    10: "ASYNC_SCANNING",            11: "BLOCKED_PASSWORD_PROTECTED",
    12: "BLOCKED_TOO_LARGE",         13: "SENSITIVE_CONTENT_WARNING",
    14: "SENSITIVE_CONTENT_BLOCK",   15: "DEEP_SCANNED_SAFE",
    16: "DEEP_SCANNED_OPENED_DANGEROUS", 17: "PROMPT_FOR_SCANNING",
}

VISIT_SOURCES = {
    0: "SYNCED", 1: "BROWSED", 2: "EXTENSION",
    3: "FIREFOX_IMPORTED", 4: "IE_IMPORTED", 5: "SAFARI_IMPORTED",
}


# ══════════════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════════════

def convert_timestamp(ts: int) -> dict:
    """Chromium microseconds-since-1601 → UTC + IST dict."""
    if not ts:
        return {"utc": None, "ist": None, "unix_ms": None}
    try:
        dt_utc = EPOCH_START + timedelta(microseconds=ts)
        ist    = timezone(timedelta(hours=5, minutes=30))
        dt_ist = dt_utc.astimezone(ist)
        return {
            "utc":     dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "ist":     dt_ist.strftime("%Y-%m-%d %H:%M:%S IST"),
            "unix_ms": int(dt_utc.timestamp() * 1000),
        }
    except Exception:
        return {"utc": None, "ist": None, "unix_ms": None}


def now_chromium_micros() -> int:
    return int((datetime.now(timezone.utc) - EPOCH_START).total_seconds() * 1_000_000)


def cutoff_micros(hours: float) -> int:
    return now_chromium_micros() - int(hours * 3_600 * 1_000_000)


def decode_transition(raw: int) -> dict:
    core       = raw & 0xFF
    qualifiers = [name for mask, name in TRANSITION_QUALIFIERS.items() if raw & mask]
    return {
        "raw":        raw,
        "core_type":  TRANSITION_TYPES.get(core, f"UNKNOWN({core})"),
        "qualifiers": qualifiers,
    }


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_json(val):
    if isinstance(val, bytes):
        return val.hex()
    return val


# ══════════════════════════════════════════════════════════════
#  EXTRACTOR
# ══════════════════════════════════════════════════════════════

class ChromiumHistoryExtractor:
    """
    Parses a raw Chromium History SQLite file.
    Works on an already-safe copy (uploaded temp file) — no extra DB copy needed.
    """

    def __init__(self, source_path: str, browser: str = "Unknown",
                 profile: str = "Default", hours: float = None):
        self.source_path = source_path
        self.browser     = browser
        self.profile     = profile
        self.hours       = hours
        self.conn        = None
        self.cutoff      = cutoff_micros(hours) if hours else 0

    def connect(self):
        # Source is already a safe temp upload — connect read-only directly
        self.conn = sqlite3.connect(f"file:{self.source_path}?mode=ro", uri=True)
        self.conn.text_factory = lambda x: x.decode("utf-8", errors="replace")
        self.conn.row_factory  = sqlite3.Row

    def close(self):
        if self.conn:
            self.conn.close()

    # ── Table: urls ────────────────────────────────────────────
    def fetch_urls(self) -> dict:
        where = f"WHERE last_visit_time > {self.cutoff}" if self.cutoff else ""
        rows  = self.conn.execute(f"""
            SELECT id, url, title, visit_count, typed_count, last_visit_time, hidden
            FROM urls {where}
        """).fetchall()
        return {
            r["id"]: {
                "url":             r["url"],
                "title":           r["title"] or "",
                "visit_count":     r["visit_count"],
                "typed_count":     r["typed_count"],
                "last_visit_time": convert_timestamp(r["last_visit_time"]),
                "hidden":          bool(r["hidden"]),
            }
            for r in rows
        }

    # ── Table: visits ──────────────────────────────────────────
    def fetch_visits(self) -> list:
        where = f"WHERE visit_time > {self.cutoff}" if self.cutoff else ""
        rows  = self.conn.execute(f"""
            SELECT id, url, visit_time, from_visit, external_referrer_url,
                   transition, segment_id, visit_duration,
                   incremented_omnibox_typed_score, opener_visit,
                   originator_cache_guid, originator_visit_id,
                   originator_from_visit, originator_opener_visit,
                   is_known_to_sync, consider_for_ntp_most_visited,
                   visited_link_id, app_id
            FROM visits {where}
            ORDER BY visit_time DESC
        """).fetchall()
        result = []
        for r in rows:
            result.append({
                "visit_id":                      r["id"],
                "url_id":                        r["url"],
                "visit_time":                    convert_timestamp(r["visit_time"]),
                "from_visit":                    r["from_visit"],
                "external_referrer_url":         r["external_referrer_url"] or "",
                "transition":                    decode_transition(r["transition"]),
                "segment_id":                    r["segment_id"],
                "visit_duration_us":             r["visit_duration"],
                "visit_duration_sec":            round(r["visit_duration"] / 1_000_000, 2) if r["visit_duration"] else 0,
                "incremented_omnibox_typed":     bool(r["incremented_omnibox_typed_score"]),
                "opener_visit":                  r["opener_visit"],
                "originator_cache_guid":         r["originator_cache_guid"] or "",
                "originator_visit_id":           r["originator_visit_id"],
                "originator_from_visit":         r["originator_from_visit"],
                "originator_opener_visit":       r["originator_opener_visit"],
                "is_known_to_sync":              bool(r["is_known_to_sync"]),
                "consider_for_ntp_most_visited": bool(r["consider_for_ntp_most_visited"]),
                "visited_link_id":               r["visited_link_id"],
                "app_id":                        r["app_id"] or "",
            })
        return result

    # ── Table: visit_source ────────────────────────────────────
    def fetch_visit_sources(self) -> dict:
        try:
            rows = self.conn.execute("SELECT id, source FROM visit_source").fetchall()
            return {
                r["id"]: VISIT_SOURCES.get(r["source"], f"UNKNOWN({r['source']})")
                for r in rows
            }
        except Exception:
            return {}

    # ── Table: context_annotations ────────────────────────────
    def fetch_context_annotations(self) -> dict:
        try:
            rows = self.conn.execute("""
                SELECT visit_id, context_annotation_flags,
                       duration_since_last_visit, page_end_reason,
                       total_foreground_duration, browser_type,
                       window_id, tab_id, task_id, root_task_id,
                       parent_task_id, response_code
                FROM context_annotations
            """).fetchall()
            return {
                r["visit_id"]: {
                    "context_annotation_flags":      r["context_annotation_flags"],
                    "duration_since_last_visit":     r["duration_since_last_visit"],
                    "page_end_reason":               r["page_end_reason"],
                    "total_foreground_duration_us":  r["total_foreground_duration"],
                    "total_foreground_duration_sec": round(r["total_foreground_duration"] / 1_000_000, 2) if r["total_foreground_duration"] else 0,
                    "browser_type":                  r["browser_type"],
                    "window_id":                     r["window_id"],
                    "tab_id":                        r["tab_id"],
                    "task_id":                       r["task_id"],
                    "root_task_id":                  r["root_task_id"],
                    "parent_task_id":                r["parent_task_id"],
                    "http_response_code":            r["response_code"],
                }
                for r in rows
            }
        except Exception:
            return {}

    # ── Table: content_annotations ────────────────────────────
    def fetch_content_annotations(self) -> dict:
        try:
            rows = self.conn.execute("""
                SELECT visit_id, visibility_score, floc_protected_score,
                       categories, page_topics_model_version, annotation_flags,
                       entities, related_searches, search_normalized_url,
                       search_terms, alternative_title, page_language,
                       password_state, has_url_keyed_image
                FROM content_annotations
            """).fetchall()
            return {
                r["visit_id"]: {
                    "visibility_score":          r["visibility_score"],
                    "floc_protected_score":      r["floc_protected_score"],
                    "categories":                r["categories"] or "",
                    "page_topics_model_version": r["page_topics_model_version"],
                    "annotation_flags":          r["annotation_flags"],
                    "entities":                  r["entities"] or "",
                    "related_searches":          r["related_searches"] or "",
                    "search_normalized_url":     r["search_normalized_url"] or "",
                    "search_terms":              r["search_terms"] or "",
                    "alternative_title":         r["alternative_title"] or "",
                    "page_language":             r["page_language"] or "",
                    "password_state":            r["password_state"],
                    "has_url_keyed_image":       bool(r["has_url_keyed_image"]),
                }
                for r in rows
            }
        except Exception:
            return {}

    # ── Table: downloads ──────────────────────────────────────
    def fetch_downloads(self) -> list:
        where = f"WHERE start_time > {self.cutoff}" if self.cutoff else ""
        try:
            rows = self.conn.execute(f"""
                SELECT id, guid, current_path, target_path, start_time, received_bytes,
                       total_bytes, state, danger_type, interrupt_reason, hash,
                       end_time, opened, last_access_time, transient,
                       referrer, site_url, tab_url, tab_referrer_url,
                       http_method, by_ext_id, by_ext_name, by_web_app_id,
                       etag, last_modified, mime_type, original_mime_type
                FROM downloads {where}
                ORDER BY start_time DESC
            """).fetchall()
        except Exception:
            return []

        result = []
        for r in rows:
            try:
                chains = self.conn.execute(
                    "SELECT chain_index, url FROM downloads_url_chains WHERE id=? ORDER BY chain_index",
                    (r["id"],)
                ).fetchall()
            except Exception:
                chains = []
            result.append({
                "download_id":        r["id"],
                "guid":               r["guid"],
                "current_path":       r["current_path"],
                "target_path":        r["target_path"],
                "start_time":         convert_timestamp(r["start_time"]),
                "end_time":           convert_timestamp(r["end_time"]),
                "last_access_time":   convert_timestamp(r["last_access_time"]),
                "received_bytes":     r["received_bytes"],
                "total_bytes":        r["total_bytes"],
                "state":              DOWNLOAD_STATES.get(r["state"], f"UNKNOWN({r['state']})"),
                "danger_type":        DANGER_TYPES.get(r["danger_type"], f"UNKNOWN({r['danger_type']})"),
                "interrupt_reason":   r["interrupt_reason"],
                "file_hash_hex":      r["hash"].hex() if isinstance(r["hash"], bytes) else "",
                "opened":             bool(r["opened"]),
                "transient":          bool(r["transient"]),
                "referrer":           r["referrer"],
                "site_url":           r["site_url"],
                "tab_url":            r["tab_url"],
                "tab_referrer_url":   r["tab_referrer_url"],
                "http_method":        r["http_method"],
                "by_extension_id":    r["by_ext_id"],
                "by_extension_name":  r["by_ext_name"],
                "by_web_app_id":      r["by_web_app_id"],
                "etag":               r["etag"],
                "last_modified":      r["last_modified"],
                "mime_type":          r["mime_type"],
                "original_mime_type": r["original_mime_type"],
                "url_chain":          [{"index": c["chain_index"], "url": c["url"]} for c in chains],
            })
        return result

    # ── Table: keyword_search_terms ───────────────────────────
    def fetch_keyword_searches(self) -> list:
        where = f"AND u.last_visit_time > {self.cutoff}" if self.cutoff else ""
        try:
            rows = self.conn.execute(f"""
                SELECT kst.keyword_id, kst.url_id, kst.term, kst.normalized_term,
                       u.url, u.title, u.last_visit_time
                FROM keyword_search_terms kst
                JOIN urls u ON kst.url_id = u.id
                WHERE 1=1 {where}
                ORDER BY u.last_visit_time DESC
            """).fetchall()
            return [
                {
                    "keyword_id":      r["keyword_id"],
                    "url_id":          r["url_id"],
                    "search_term":     r["term"],
                    "normalized_term": r["normalized_term"],
                    "search_url":      r["url"],
                    "page_title":      r["title"] or "",
                    "last_visit_time": convert_timestamp(r["last_visit_time"]),
                }
                for r in rows
            ]
        except Exception:
            return []

    # ── Tree Builder ──────────────────────────────────────────
    def build_visit_tree(self, visits: list, urls: dict, visit_sources: dict,
                         context_ann: dict, content_ann: dict) -> tuple:
        """
        Builds parent→child navigation tree.
        Priority: from_visit first, opener_visit fallback.
        This correctly handles new-tab navigations (Ctrl+click).
        """
        enriched = {}
        for v in visits:
            vid   = v["visit_id"]
            uid   = v["url_id"]
            url_d = urls.get(uid, {})
            enriched[vid] = {
                **v,
                "url":             url_d.get("url", ""),
                "title":           url_d.get("title", ""),
                "url_visit_count": url_d.get("visit_count", 0),
                "url_typed_count": url_d.get("typed_count", 0),
                "url_hidden":      url_d.get("hidden", False),
                "visit_source":    visit_sources.get(vid, "BROWSED"),
                "context":         context_ann.get(vid, {}),
                "content":         content_ann.get(vid, {}),
                "children":        [],
                "depth":           0,
            }

        children_map: dict = defaultdict(list)
        roots = []

        for vid, data in enriched.items():
            parent = data["from_visit"]
            if not (parent and parent in enriched and parent != vid):
                parent = data.get("opener_visit")
            if parent and parent in enriched and parent != vid:
                children_map[parent].append(vid)
            else:
                roots.append(vid)

        # BFS depth assignment (avoids recursion limit on deep histories)
        queue = [(r, 0) for r in roots]
        while queue:
            nid, d = queue.pop(0)
            if nid in enriched:
                enriched[nid]["depth"] = d
                for ch in children_map[nid]:
                    queue.append((ch, d + 1))

        for nid, ch_list in children_map.items():
            if nid in enriched:
                enriched[nid]["children"] = ch_list

        return enriched, dict(children_map), roots

    # ── Meta ──────────────────────────────────────────────────
    def fetch_meta(self) -> dict:
        meta = {}
        try:
            for row in self.conn.execute("SELECT key, CAST(value AS BLOB) FROM meta"):
                key = row[0]
                raw = row[1]
                if isinstance(raw, bytes):
                    try:
                        meta[key] = raw.decode("utf-8")
                    except Exception:
                        meta[key] = f"<binary {len(raw)}b: {raw[:16].hex()}>"
                else:
                    meta[key] = raw
        except Exception:
            pass
        return meta

    # ── Main Extract ──────────────────────────────────────────
    def extract(self) -> dict:
        self.connect()
        try:
            log.info(f"  Extracting {self.browser}/{self.profile}")

            urls      = self.fetch_urls()
            log.info(f"     urls: {len(urls):,}")
            visits    = self.fetch_visits()
            log.info(f"     visits: {len(visits):,}")
            vsrc      = self.fetch_visit_sources()
            ctx       = self.fetch_context_annotations()
            cnt       = self.fetch_content_annotations()
            downloads = self.fetch_downloads()
            log.info(f"     downloads: {len(downloads)}")
            searches  = self.fetch_keyword_searches()
            log.info(f"     searches: {len(searches)}")

            enriched, children_map, roots = self.build_visit_tree(
                visits, urls, vsrc, ctx, cnt
            )
            meta = self.fetch_meta()

            transition_counts: dict = defaultdict(int)
            for v in visits:
                transition_counts[v["transition"]["core_type"]] += 1

            dangerous_dls = [
                d for d in downloads
                if d["danger_type"] not in ("NOT_DANGEROUS", "USER_VALIDATED")
            ]
            synced_visits = [v for v in visits if v["is_known_to_sync"]]
            ext_referrers = [v for v in visits if v["external_referrer_url"]]
            unique_terms  = list({s["search_term"] for s in searches})

            stats = {
                "total_url_records":        len(urls),
                "total_visits":             len(visits),
                "total_root_sessions":      len(roots),
                "total_downloads":          len(downloads),
                "dangerous_downloads":      len(dangerous_dls),
                "total_keyword_searches":   len(searches),
                "unique_search_terms":      len(unique_terms),
                "synced_visits":            len(synced_visits),
                "visits_with_ext_referrer": len(ext_referrers),
                "transition_breakdown":     dict(transition_counts),
                "db_version":               meta.get("version", "?"),
                "hours_filter":             self.hours,
            }

            return {
                "extraction_meta": {
                    "extracted_at_utc":  datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "extracted_at_ist":  datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST"),
                    "browser":           self.browser,
                    "profile":           self.profile,
                    "source_sha256":     file_sha256(self.source_path),
                    "hours_filter":      self.hours,
                    "db_meta":           meta,
                    "extractor_version": "2.1.0",
                    "analyst_note":      "Timestamps: Chromium epoch (μs since 1601-01-01 UTC). Tree: from_visit with opener_visit fallback.",
                },
                "stats":           stats,
                "visits":          list(enriched.values()),
                "root_visit_ids":  roots,
                "children_map":    {str(k): v for k, v in children_map.items()},
                "urls":            {str(k): v for k, v in urls.items()},
                "downloads":       downloads,
                "keyword_searches": searches,
            }
        finally:
            self.close()


# ══════════════════════════════════════════════════════════════
#  FLASK ROUTES
# ══════════════════════════════════════════════════════════════

@app.route("/api/parse", methods=["POST"])
def parse_history():
    if "file" not in request.files:
        return Response(
            json.dumps({"error": "No file uploaded. Send the raw Chromium History SQLite file as field 'file'."}),
            status=400, mimetype="application/json"
        )

    f       = request.files["file"]
    browser = request.form.get("browser", "Unknown")
    profile = request.form.get("profile", "Default")

    # hours filter — empty string or missing means no filter (all time)
    hours_raw = request.form.get("hours", "").strip()
    try:
        hours = float(hours_raw) if hours_raw else None
    except ValueError:
        hours = None

    log.info(f"Upload: {f.filename!r}  browser={browser}  profile={profile}  hours={hours}")

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".db", prefix="chromium_hist_")
    try:
        os.close(tmp_fd)
        f.save(tmp_path)

        extractor = ChromiumHistoryExtractor(
            source_path=tmp_path,
            browser=browser,
            profile=profile,
            hours=hours,          # ← was missing before
        )
        data = extractor.extract()

        s = data["stats"]
        log.info(f"  Done — visits: {s['total_visits']:,}  downloads: {s['total_downloads']}")

        return Response(
            json.dumps(data, default=safe_json, ensure_ascii=False),
            status=200, mimetype="application/json"
        )
    except Exception as e:
        log.error(f"Extraction failed: {e}", exc_info=True)
        return Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)



@app.route("/api/health", methods=["GET"])
def health():
    return Response(
        json.dumps({"status": "ok", "version": "2.1.0"}),
        status=200, mimetype="application/json"
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000, host="0.0.0.0")
