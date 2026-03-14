// src/parseHistory.js
// ─────────────────────────────────────────────────────────────
// Chromium History Extractor — pure browser, zero backend
// Produces IDENTICAL JSON schema to server.py
// Uses sql.js (SQLite compiled to WASM) — file never leaves browser
// ─────────────────────────────────────────────────────────────
let _SQL = null

async function getSqlJs() {
  if (_SQL) return _SQL

  // Load sql-wasm.js from public/ as a plain browser script
  await new Promise((resolve, reject) => {
    if (window.initSqlJs) return resolve()
    const s    = document.createElement("script")
    s.src      = "/sql-wasm.js"
    s.onload   = resolve
    s.onerror  = () => reject(new Error("Failed to load /sql-wasm.js — did you copy it to public/?"))
    document.head.appendChild(s)
  })

  _SQL = await window.initSqlJs({ locateFile: () => "/sql-wasm.wasm" })
  return _SQL
}
// ══════════════════════════════════════════════════════════════
//  CONSTANTS — mirrors server.py exactly
// ══════════════════════════════════════════════════════════════

// Chromium epoch: microseconds since 1601-01-01 UTC
// In JS milliseconds: Date.UTC(1601, 0, 1) = -11644473600000
const CHROMIUM_EPOCH_MS = -11644473600000

const TRANSITION_TYPES = {
  0: "LINK",          1: "TYPED",            2: "AUTO_BOOKMARK",
  3: "AUTO_SUBFRAME", 4: "MANUAL_SUBFRAME",   5: "GENERATED",
  6: "AUTO_TOPLEVEL", 7: "FORM_SUBMIT",       8: "RELOAD",
  9: "KEYWORD",      10: "KEYWORD_GENERATED",
}

const TRANSITION_QUALIFIERS = {
  0x01000000: "BLOCKED",          0x02000000: "FORWARD_BACK",
  0x04000000: "FROM_ADDRESS_BAR", 0x08000000: "HOME_PAGE",
  0x10000000: "FROM_API",         0x20000000: "CHAIN_START",
  0x40000000: "CHAIN_END",        0x80000000: "CLIENT_REDIRECT",
}

const DOWNLOAD_STATES = {
  0: "IN_PROGRESS", 1: "COMPLETE",   2: "CANCELLED",
  3: "INTERRUPTED",  4: "DANGEROUS",
}

const DANGER_TYPES = {
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

const VISIT_SOURCES = {
  0: "SYNCED", 1: "BROWSED",          2: "EXTENSION",
  3: "FIREFOX_IMPORTED", 4: "IE_IMPORTED", 5: "SAFARI_IMPORTED",
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

// Chromium timestamps are microseconds since 1601 and exceed
// Number.MAX_SAFE_INTEGER (~9e15). We SELECT them as CAST(col AS TEXT)
// and parse with BigInt to avoid floating-point precision loss.
function convertTimestamp(tsStr) {
  if (tsStr === null || tsStr === undefined || tsStr === "" || tsStr === "0")
    return { utc: null, ist: null, unix_ms: null }
  try {
    const ts      = BigInt(tsStr)
    const unix_ms = Number(ts / 1000n) + CHROMIUM_EPOCH_MS
    const d       = new Date(unix_ms)
    const utc     = d.toISOString().replace(/\.\d{3}Z$/, "Z")

    // IST = UTC + 5h 30m
    const istOffset = (5 * 60 + 30) * 60 * 1000
    const di        = new Date(unix_ms + istOffset)
    const p         = n => String(n).padStart(2, "0")
    const ist       = `${di.getUTCFullYear()}-${p(di.getUTCMonth() + 1)}-${p(di.getUTCDate())} `
                    + `${p(di.getUTCHours())}:${p(di.getUTCMinutes())}:${p(di.getUTCSeconds())} IST`

    return { utc, ist, unix_ms }
  } catch {
    return { utc: null, ist: null, unix_ms: null }
  }
}

// Returns BigInt micros — used in WHERE clause via string interpolation
function nowChromiumMicros() {
  return BigInt(Date.now() - CHROMIUM_EPOCH_MS) * 1000n
}

function cutoffMicros(hours) {
  return nowChromiumMicros() - BigInt(Math.floor(hours * 3_600 * 1_000_000))
}

function decodeTransition(raw) {
  const core       = (raw || 0) & 0xFF
  const qualifiers = []
  for (const [maskStr, name] of Object.entries(TRANSITION_QUALIFIERS)) {
    if ((raw || 0) & Number(maskStr)) qualifiers.push(name)
  }
  return {
    raw:        raw || 0,
    core_type:  TRANSITION_TYPES[core] ?? `UNKNOWN(${core})`,
    qualifiers,
  }
}

function hexFromBlob(val) {
  if (!val) return ""
  if (val instanceof Uint8Array)
    return Array.from(val).map(b => b.toString(16).padStart(2, "0")).join("")
  if (typeof val === "string") return val
  return ""
}

async function sha256Hex(arrayBuffer) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", arrayBuffer)
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, "0")).join("")
  } catch {
    return ""
  }
}

function nowIstString() {
  const p      = n => String(n).padStart(2, "0")
  const offset = (5 * 60 + 30) * 60 * 1000
  const d      = new Date(Date.now() + offset)
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} IST`
}

// ══════════════════════════════════════════════════════════════
//  SQL HELPER
// ══════════════════════════════════════════════════════════════

// sql.js API: prepare → bind → step → getAsObject → free
// getAsObject() returns {columnName: value} just like Python's sqlite3.Row
function queryAll(db, sql, params) {
  try {
    const stmt = db.prepare(sql)
    if (params && params.length) stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════
//  TABLE EXTRACTORS
//  Each function mirrors the corresponding method in server.py
// ══════════════════════════════════════════════════════════════

// mirrors: ChromiumHistoryExtractor.fetch_urls()
function fetchUrls(db, cutoff) {
  const where = cutoff ? `WHERE last_visit_time > ${cutoff}` : ""
  const rows  = queryAll(db, `
    SELECT id, url, title, visit_count, typed_count,
           CAST(last_visit_time AS TEXT) AS last_visit_time_str, hidden
    FROM urls ${where}
  `)
  const urls = {}
  for (const r of rows) {
    urls[r.id] = {
      url:             r.url             || "",
      title:           r.title           || "",
      visit_count:     r.visit_count     || 0,
      typed_count:     r.typed_count     || 0,
      last_visit_time: convertTimestamp(r.last_visit_time_str),
      hidden:          !!r.hidden,
    }
  }
  return urls
}

// mirrors: ChromiumHistoryExtractor.fetch_visits()
function fetchVisits(db, cutoff) {
  const where = cutoff ? `WHERE visit_time > ${cutoff}` : ""
  const rows  = queryAll(db, `
    SELECT id, url,
           CAST(visit_time AS TEXT)     AS visit_time_str,
           from_visit,
           external_referrer_url,
           transition,
           segment_id,
           visit_duration,
           incremented_omnibox_typed_score,
           opener_visit,
           originator_cache_guid,
           originator_visit_id,
           originator_from_visit,
           originator_opener_visit,
           is_known_to_sync,
           consider_for_ntp_most_visited,
           visited_link_id,
           app_id
    FROM visits ${where}
    ORDER BY visit_time DESC
  `)
  return rows.map(r => ({
    visit_id:                      r.id,
    url_id:                        r.url,
    visit_time:                    convertTimestamp(r.visit_time_str),
    from_visit:                    r.from_visit                    || 0,
    external_referrer_url:         r.external_referrer_url         || "",
    transition:                    decodeTransition(r.transition),
    segment_id:                    r.segment_id                    || 0,
    visit_duration_us:             r.visit_duration                || 0,
    visit_duration_sec:            r.visit_duration
                                     ? +(r.visit_duration / 1_000_000).toFixed(2) : 0,
    incremented_omnibox_typed:     !!r.incremented_omnibox_typed_score,
    opener_visit:                  r.opener_visit                  || 0,
    originator_cache_guid:         r.originator_cache_guid         || "",
    originator_visit_id:           r.originator_visit_id           || 0,
    originator_from_visit:         r.originator_from_visit         || 0,
    originator_opener_visit:       r.originator_opener_visit       || 0,
    is_known_to_sync:              !!r.is_known_to_sync,
    consider_for_ntp_most_visited: !!r.consider_for_ntp_most_visited,
    visited_link_id:               r.visited_link_id               || 0,
    app_id:                        r.app_id                        || "",
  }))
}

// mirrors: ChromiumHistoryExtractor.fetch_visit_sources()
function fetchVisitSources(db) {
  const map = {}
  for (const r of queryAll(db, "SELECT id, source FROM visit_source")) {
    map[r.id] = VISIT_SOURCES[r.source] ?? `UNKNOWN(${r.source})`
  }
  return map
}

// mirrors: ChromiumHistoryExtractor.fetch_context_annotations()
function fetchContextAnnotations(db) {
  const map  = {}
  const rows = queryAll(db, `
    SELECT visit_id,
           context_annotation_flags,
           duration_since_last_visit,
           page_end_reason,
           total_foreground_duration,
           browser_type,
           window_id,
           tab_id,
           task_id,
           root_task_id,
           parent_task_id,
           response_code
    FROM context_annotations
  `)
  for (const r of rows) {
    map[r.visit_id] = {
      context_annotation_flags:      r.context_annotation_flags     || 0,
      duration_since_last_visit:     r.duration_since_last_visit     || 0,
      page_end_reason:               r.page_end_reason               || 0,
      total_foreground_duration_us:  r.total_foreground_duration     || 0,
      total_foreground_duration_sec: r.total_foreground_duration
                                       ? +(r.total_foreground_duration / 1_000_000).toFixed(2) : 0,
      browser_type:                  r.browser_type                  || 0,
      window_id:                     r.window_id                     || 0,
      tab_id:                        r.tab_id                        || 0,
      task_id:                       r.task_id                       || 0,
      root_task_id:                  r.root_task_id                  || 0,
      parent_task_id:                r.parent_task_id                || 0,
      http_response_code:            r.response_code                 || 0,
    }
  }
  return map
}

// mirrors: ChromiumHistoryExtractor.fetch_content_annotations()
function fetchContentAnnotations(db) {
  const map  = {}
  const rows = queryAll(db, `
    SELECT visit_id,
           visibility_score,
           floc_protected_score,
           categories,
           page_topics_model_version,
           annotation_flags,
           entities,
           related_searches,
           search_normalized_url,
           search_terms,
           alternative_title,
           page_language,
           password_state,
           has_url_keyed_image
    FROM content_annotations
  `)
  for (const r of rows) {
    map[r.visit_id] = {
      visibility_score:          r.visibility_score          || 0,
      floc_protected_score:      r.floc_protected_score      || 0,
      categories:                r.categories                || "",
      page_topics_model_version: r.page_topics_model_version || 0,
      annotation_flags:          r.annotation_flags          || 0,
      entities:                  r.entities                  || "",
      related_searches:          r.related_searches          || "",
      search_normalized_url:     r.search_normalized_url     || "",
      search_terms:              r.search_terms              || "",
      alternative_title:         r.alternative_title         || "",
      page_language:             r.page_language             || "",
      password_state:            r.password_state            || 0,
      has_url_keyed_image:       !!r.has_url_keyed_image,
    }
  }
  return map
}

// mirrors: ChromiumHistoryExtractor.fetch_downloads()
function fetchDownloads(db, cutoff) {
  const where = cutoff ? `WHERE start_time > ${cutoff}` : ""
  const rows  = queryAll(db, `
    SELECT id,
           guid,
           current_path,
           target_path,
           CAST(start_time       AS TEXT) AS start_time_str,
           CAST(end_time         AS TEXT) AS end_time_str,
           CAST(last_access_time AS TEXT) AS last_access_time_str,
           received_bytes,
           total_bytes,
           state,
           danger_type,
           interrupt_reason,
           hash,
           opened,
           transient,
           referrer,
           site_url,
           tab_url,
           tab_referrer_url,
           http_method,
           by_ext_id,
           by_ext_name,
           by_web_app_id,
           etag,
           last_modified,
           mime_type,
           original_mime_type
    FROM downloads ${where}
    ORDER BY start_time DESC
  `)
  return rows.map(r => {
    const chains = queryAll(
      db,
      "SELECT chain_index, url FROM downloads_url_chains WHERE id=? ORDER BY chain_index",
      [r.id]
    )
    return {
      download_id:        r.id,
      guid:               r.guid               || "",
      current_path:       r.current_path       || "",
      target_path:        r.target_path        || "",
      start_time:         convertTimestamp(r.start_time_str),
      end_time:           convertTimestamp(r.end_time_str),
      last_access_time:   convertTimestamp(r.last_access_time_str),
      received_bytes:     r.received_bytes     || 0,
      total_bytes:        r.total_bytes        || 0,
      state:              DOWNLOAD_STATES[r.state]    ?? `UNKNOWN(${r.state})`,
      danger_type:        DANGER_TYPES[r.danger_type] ?? `UNKNOWN(${r.danger_type})`,
      interrupt_reason:   r.interrupt_reason   || 0,
      file_hash_hex:      hexFromBlob(r.hash),
      opened:             !!r.opened,
      transient:          !!r.transient,
      referrer:           r.referrer           || "",
      site_url:           r.site_url           || "",
      tab_url:            r.tab_url            || "",
      tab_referrer_url:   r.tab_referrer_url   || "",
      http_method:        r.http_method        || "",
      by_extension_id:    r.by_ext_id          || "",
      by_extension_name:  r.by_ext_name        || "",
      by_web_app_id:      r.by_web_app_id      || "",
      etag:               r.etag               || "",
      last_modified:      r.last_modified      || "",
      mime_type:          r.mime_type          || "",
      original_mime_type: r.original_mime_type || "",
      url_chain:          chains.map(c => ({ index: c.chain_index, url: c.url })),
    }
  })
}

// mirrors: ChromiumHistoryExtractor.fetch_keyword_searches()
function fetchKeywordSearches(db, cutoff) {
  const tsAnd = cutoff ? `AND u.last_visit_time > ${cutoff}` : ""
  const rows  = queryAll(db, `
    SELECT kst.keyword_id,
           kst.url_id,
           kst.term,
           kst.normalized_term,
           u.url,
           u.title,
           CAST(u.last_visit_time AS TEXT) AS last_visit_time_str
    FROM keyword_search_terms kst
    JOIN urls u ON kst.url_id = u.id
    WHERE 1=1 ${tsAnd}
    ORDER BY u.last_visit_time DESC
  `)
  return rows.map(r => ({
    keyword_id:      r.keyword_id,
    url_id:          r.url_id,
    search_term:     r.term            || "",
    normalized_term: r.normalized_term || "",
    search_url:      r.url             || "",
    page_title:      r.title           || "",
    last_visit_time: convertTimestamp(r.last_visit_time_str),
  }))
}

// mirrors: ChromiumHistoryExtractor.fetch_meta()
function fetchMeta(db) {
  const meta = {}
  for (const r of queryAll(db, "SELECT key, CAST(value AS TEXT) AS value FROM meta")) {
    meta[r.key] = r.value
  }
  return meta
}


// mirrors: ChromiumHistoryExtractor.build_visit_tree()
// Priority: from_visit first, opener_visit as fallback (handles Ctrl+click new tabs)
function buildVisitTree(visits, urls, visitSources, ctxMap, cntMap) {
  const enriched = {}

  for (const v of visits) {
    const vid  = v.visit_id
    const urlD = urls[v.url_id] || {}
    enriched[vid] = {
      ...v,
      url:             urlD.url         || "",
      title:           urlD.title       || "",
      url_visit_count: urlD.visit_count || 0,
      url_typed_count: urlD.typed_count || 0,
      url_hidden:      urlD.hidden      || false,
      visit_source:    visitSources[vid] || "BROWSED",
      context:         ctxMap[vid]      || {},
      content:         cntMap[vid]      || {},
      children:        [],
      depth:           0,
    }
  }

  const childrenMap = {}
  const roots       = []

  for (const [vidStr, data] of Object.entries(enriched)) {
    const vid = Number(vidStr)
    let parent = data.from_visit
    if (!(parent && enriched[parent] && parent !== vid)) {
      parent = data.opener_visit
    }
    if (parent && enriched[parent] && parent !== vid) {
      if (!childrenMap[parent]) childrenMap[parent] = []
      childrenMap[parent].push(vid)
    } else {
      roots.push(vid)
    }
  }
    const byTime = (a, b) =>
    (enriched[b]?.visit_time?.unix_ms || 0) - (enriched[a]?.visit_time?.unix_ms || 0)
  roots.sort(byTime)
  for (const kids of Object.values(childrenMap)) kids.sort(byTime)
  // BFS depth assignment — avoids call stack overflow on deep histories
  const queue = roots.map(r => [r, 0])
  let qi = 0
  while (qi < queue.length) {
    const [nid, d] = queue[qi++]
    if (enriched[nid]) {
      enriched[nid].depth = d
      for (const ch of (childrenMap[nid] || [])) {
        queue.push([ch, d + 1])
      }
    }
  }

  for (const [nid, kids] of Object.entries(childrenMap)) {
    if (enriched[nid]) enriched[nid].children = kids
  }

  return { enriched, childrenMap, roots }
}

// ══════════════════════════════════════════════════════════════
//  MAIN EXPORT
//  Replaces the fetch() call in DropZone — same output shape as server.py
// ══════════════════════════════════════════════════════════════

export async function parseHistory({
  fileBuffer,           // ArrayBuffer — from File.arrayBuffer()
  browser  = "Unknown",
  profile  = "Default",
  hours    = null,      // null = all time  |  number = last N hours
}) {
  // 1. Load WASM engine — reads from /sql-wasm.wasm in public/
  const SQL = await getSqlJs()
const db  = new SQL.Database(new Uint8Array(fileBuffer))

  // 2. Time filter cutoff (BigInt, safe for 64-bit Chromium timestamps)
  const cutoff = hours ? cutoffMicros(hours) : null

  // 3. SHA-256 of source bytes — mirrors Python's file_sha256()
  const sourceHash = await sha256Hex(fileBuffer)

  // 4. Extract all tables
  const urls      = fetchUrls(db, cutoff)
  const visits    = fetchVisits(db, cutoff)
  const vsrc      = fetchVisitSources(db)
  const ctx       = fetchContextAnnotations(db)
  const cnt       = fetchContentAnnotations(db)
  const downloads = fetchDownloads(db, cutoff)
  const searches  = fetchKeywordSearches(db, cutoff)
  const meta      = fetchMeta(db)

  // 5. Free WASM memory — equivalent to conn.close()
  db.close()

  // 6. Build navigation tree
  const { enriched, childrenMap, roots } = buildVisitTree(
    visits, urls, vsrc, ctx, cnt
  )

  // 7. Stats — mirrors server.py stats block exactly
  const transitionCounts = {}
  for (const v of visits) {
    const t = v.transition.core_type
    transitionCounts[t] = (transitionCounts[t] || 0) + 1
  }

  const dangerousDls = downloads.filter(
    d => !["NOT_DANGEROUS", "USER_VALIDATED"].includes(d.danger_type)
  )
  const syncedVisits = visits.filter(v => v.is_known_to_sync)
  const extReferrers = visits.filter(v => v.external_referrer_url)
  const uniqueTerms  = [...new Set(searches.map(s => s.search_term))]

  const nowUtc = new Date()

  // 8. Return — IDENTICAL top-level keys and nested structure to server.py
  return {
    extraction_meta: {
      extracted_at_utc:  nowUtc.toISOString().replace(/\.\d{3}Z$/, "Z"),
      extracted_at_ist:  nowIstString(),
      browser,
      profile,
      source_sha256:     sourceHash,
      hours_filter:      hours,
      db_meta:           meta,
      extractor_version: "2.1.0-js",
      analyst_note:      "Parsed entirely in-browser via sql.js WASM. No data left the device.",
    },

    stats: {
      total_url_records:        Object.keys(urls).length,
      total_visits:             visits.length,
      total_root_sessions:      roots.length,
      total_downloads:          downloads.length,
      dangerous_downloads:      dangerousDls.length,
      total_keyword_searches:   searches.length,
      unique_search_terms:      uniqueTerms.length,
      synced_visits:            syncedVisits.length,
      visits_with_ext_referrer: extReferrers.length,
      transition_breakdown:     transitionCounts,
      db_version:               meta.version ?? "?",
      hours_filter:             hours,
    },

    visits:           Object.values(enriched),
    root_visit_ids:   roots,

    // String keys — matches Python's {str(k): v for k, v in children_map.items()}
    children_map: Object.fromEntries(
      Object.entries(childrenMap).map(([k, v]) => [String(k), v])
    ),
    urls: Object.fromEntries(
      Object.entries(urls).map(([k, v]) => [String(k), v])
    ),

    downloads,
    keyword_searches: searches,
  }
}
