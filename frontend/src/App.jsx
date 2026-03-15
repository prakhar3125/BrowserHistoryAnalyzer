import { useState, useMemo, useCallback, useRef, useEffect,
         useDeferredValue, Component } from "react"
import {
  Upload, ChevronRight, ChevronDown, Search, X, Clock,
  Download, RefreshCw, Shield, Database,
  Network, SortAsc, SortDesc, Loader, PanelRightClose, FileDown
} from "lucide-react"
import * as XLSX from "xlsx"
import { parseHistory } from "./parseHistory"

/* ═══════════════════════════════════════════════════════════
   THEME  —  #001437 navy · #d94642 red · #1da3dd blue
═══════════════════════════════════════════════════════════ */
const T = {
  bg:      "#001437",
  surf:    "#001d4a",
  panel:   "#00102e",
  card:    "#011f52",
  hover:   "#022460",
  border:  "#0b2d6b",
  border2: "#123580",

  blue:    "#1da3dd",
  red:     "#d94642",
  green:   "#2ecc8a",
  amber:   "#e8a020",
  purple:  "#9b7ae8",
  teal:    "#1ab8a8",

  t0:      "#c8d8f0",
  t1:      "#5a7da8",
  t2:      "#2a4870",
  t3:      "#152840",
  sel:     "#0a2e6e",
}

const TC = {
  TYPED:             T.green,   LINK:              T.blue,
  FORM_SUBMIT:       T.red,     RELOAD:            T.amber,
  AUTO_BOOKMARK:     T.teal,    GENERATED:         T.purple,
  KEYWORD:           T.purple,  KEYWORD_GENERATED: T.purple,
  AUTO_TOPLEVEL:     T.teal,    AUTO_SUBFRAME:     T.t2,
  MANUAL_SUBFRAME:   T.t2,
}

const MONO = "'Cascadia Code','JetBrains Mono','Fira Code','Consolas',monospace"

/* ═══════════════════════════════════════════════════════════
   ERROR BOUNDARY
   Wraps each page so a single bad data row cannot unmount the
   entire app. key={page} in App resets it on navigation.
═══════════════════════════════════════════════════════════ */
class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error("[ErrorBoundary]", error, info) }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 32, fontFamily: MONO, color: T.red, display: "flex", flexDirection: "column", gap: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>Render error: {this.state.error.message}</span>
        <button
          onClick={() => this.setState({ error: null })}
          style={{ padding: "4px 12px", background: T.card, border: `1px solid ${T.red}40`,
            color: T.red, fontSize: 10, fontFamily: MONO, borderRadius: 3, cursor: "pointer",
            alignSelf: "flex-start" }}
        >Retry</button>
      </div>
    )
    return this.props.children
  }
}

/* ═══════════════════════════════════════════════════════════
   UTILS
═══════════════════════════════════════════════════════════ */
const fmtDur = us => {
  if (!us) return "—"
  const s = us / 1e6
  if (s < 1)  return `${(us / 1000) | 0}ms`
  if (s < 60) return `${s.toFixed(1)}s`
  return `${(s / 60) | 0}m ${(s % 60) | 0}s`
}
const fmtBytes = b => {
  b = b || 0
  if (b < 1024)    return `${b}B`
  if (b < 1 << 20) return `${(b / 1024).toFixed(1)}KB`
  if (b < 1 << 30) return `${(b / (1 << 20)).toFixed(1)}MB`
  return `${(b / (1 << 30)).toFixed(2)}GB`
}

const tShow = (ts, tz) => (tz === "ist" ? ts?.ist : ts?.utc) || ts?.utc || ts?.ist || "—"
const tAlt  = (ts, tz) => (tz === "ist" ? ts?.utc : ts?.ist) || "—"
const tIST  = ts => ts?.ist || ts?.utc || "—"
const tUTC  = ts => ts?.utc || "—"

// FIX: use URL API — split-on-"//" crashes on chrome://, about:blank, data:, file:
const dom = url => {
  try {
    const { hostname } = new URL(url)
    return hostname.replace(/^www\./, "") || url.slice(0, 40)
  } catch {
    return url?.slice?.(0, 40) ?? ""
  }
}

/* ═══════════════════════════════════════════════════════════
   flattenTree
   Returns { rows, truncated }.
   FIX: truncated uses >= limit (was ===, which was off-by-one).
   Limit raised to 8 000 — more than enough for 1-month data.
   parentOf is passed in (memoized in PageTree, not rebuilt here).
═══════════════════════════════════════════════════════════ */
function flattenTree(rootIds, childrenMap, byId, openSet, filter, parentOf, limit = 8000) {
  const ft  = filter.toLowerCase()
  const out = []

  if (!ft) {
    const stack = [...rootIds].reverse().map(id => ({ id, depth: 0 }))
    while (stack.length && out.length < limit) {
      const { id, depth } = stack.pop()
      const v = byId[id]; if (!v) continue
      const kids   = childrenMap[id] || []
      const isOpen = openSet.has(id)
      out.push({ id, depth, hasKids: kids.length > 0, open: isOpen, dimmed: false })
      if (isOpen)
        for (let i = kids.length - 1; i >= 0; i--)
          stack.push({ id: kids[i], depth: depth + 1 })
    }
    return { rows: out, truncated: out.length >= limit }
  }

  // Pass 1: nodes that directly match the filter
  const selfMatch = new Set()
  for (const idStr of Object.keys(byId)) {
    const v = byId[idStr]; if (!v) continue
    if (
      (v.url   || "").toLowerCase().includes(ft) ||
      (v.title || "").toLowerCase().includes(ft)
    ) selfMatch.add(Number(idStr))
  }

  // Pass 2: walk up to mark ancestors as dimmed context rows
  const ancestorMatch = new Set()
  for (const id of selfMatch) {
    let cur = parentOf[id]
    while (cur !== undefined) {
      if (ancestorMatch.has(cur)) break
      ancestorMatch.add(cur); cur = parentOf[cur]
    }
  }

  // Pass 3: DFS render
  const stack = [...rootIds].reverse().map(id => ({ id, depth: 0 }))
  while (stack.length && out.length < limit) {
    const { id, depth } = stack.pop()
    const v = byId[id]; if (!v) continue
    const kids   = childrenMap[id] || []
    const isOpen = openSet.has(id)
    const isSelf = selfMatch.has(id)
    const isCtx  = !isSelf && ancestorMatch.has(id)

    if (isSelf)
      out.push({ id, depth, hasKids: kids.length > 0, open: isOpen, dimmed: false })
    else if (isCtx)
      out.push({ id, depth, hasKids: kids.length > 0, open: true,   dimmed: true  })

    if ((isSelf && isOpen) || isCtx)
      for (let i = kids.length - 1; i >= 0; i--)
        stack.push({ id: kids[i], depth: depth + 1 })
  }

  return { rows: out, truncated: out.length >= limit }
}

/* ═══════════════════════════════════════════════════════════
   useSort
═══════════════════════════════════════════════════════════ */
function useSort(data, def) {
  const [col, setCol] = useState(def)
  const [asc, setAsc] = useState(false)   // false = descending = newest first
  const toggle = c => { if (col === c) setAsc(a => !a); else { setCol(c); setAsc(true) } }

  const sorted = useMemo(() => {
    if (!col) return data
    return [...data].sort((a, b) => {
      let av = a[col], bv = b[col]
      if (av && typeof av === "object" && "unix_ms" in av) av = av.unix_ms ?? 0
      if (bv && typeof bv === "object" && "unix_ms" in bv) bv = bv.unix_ms ?? 0
      const na = Number(av), nb = Number(bv)
      if (!isNaN(na) && !isNaN(nb)) return asc ? na - nb : nb - na
      return asc
        ? String(av ?? "").localeCompare(String(bv ?? ""))
        : String(bv ?? "").localeCompare(String(av ?? ""))
    })
  }, [data, col, asc])

  return { sorted, col, asc, toggle }
}

/* ═══════════════════════════════════════════════════════════
   PRIMITIVES
═══════════════════════════════════════════════════════════ */
const Badge = ({ text, color }) => (
  <span style={{
    display: "inline-block", padding: "1px 7px", borderRadius: 3,
    fontSize: 10, fontFamily: MONO, fontWeight: 700, letterSpacing: .5,
    color, background: `${color}22`, border: `1px solid ${color}40`
  }}>{text}</span>
)

// FIX 1: position:"relative" added to <th> so the absolute resize handle
//         anchors to its own cell, not a higher positioned ancestor.
// FIX 2: `active` flag in mousedown prevents stale onMove from calling
//         onResize after the component unmounts mid-drag.
const TH = ({ children, width, onClick, sorted, onResize }) => {
  const handleMouseDown = e => {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startW = typeof width === "number" ? width : 100
    let active = true
    const onMove = mv => { if (active && onResize) onResize(Math.max(36, startW + mv.clientX - startX)) }
    const onUp   = () => {
      active = false
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup",   onUp)
      document.body.style.cursor = document.body.style.userSelect = ""
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup",   onUp)
    document.body.style.cursor     = "col-resize"
    document.body.style.userSelect = "none"
  }
  return (
    <th onClick={onClick} style={{
      padding: "7px 10px", textAlign: "left",
      fontSize: 10, fontFamily: MONO, fontWeight: 700, color: T.blue,
      background: T.panel, borderBottom: `1px solid ${T.border}`,
      whiteSpace: "nowrap",
      width:    typeof width === "number" ? width : undefined,
      minWidth: typeof width === "number" ? width : undefined,
      maxWidth: typeof width === "number" ? width : undefined,
      cursor: onClick ? "pointer" : "default",
      userSelect: "none",
      // FIX: sticky + relative together so resize handle positions correctly
      position: "sticky", top: 0, zIndex: 1,
      boxSizing: "border-box",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, paddingRight: 8 }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{children}</span>
        {sorted === "asc"  && <SortAsc  size={10} style={{ flexShrink: 0 }} />}
        {sorted === "desc" && <SortDesc size={10} style={{ flexShrink: 0 }} />}
      </div>
      {onResize && (
        <div onMouseDown={handleMouseDown} onClick={e => e.stopPropagation()} style={{
          position: "absolute", right: 0, top: 0, bottom: 0, width: 6,
          cursor: "col-resize", zIndex: 2, borderRight: "2px solid transparent", transition: "border-color .1s",
        }}
          onMouseEnter={e => { e.currentTarget.style.borderRightColor = T.blue }}
          onMouseLeave={e => { e.currentTarget.style.borderRightColor = "transparent" }}
        />
      )}
    </th>
  )
}

const TD = ({ children, color = T.t0, mono = true, truncate = true }) => (
  <td style={{
    padding: "6px 10px", fontSize: 11,
    fontFamily: mono ? MONO : undefined, color,
    whiteSpace: truncate ? "nowrap" : undefined,
    maxWidth: truncate ? 280 : undefined,
    overflow: truncate ? "hidden" : undefined,
    textOverflow: truncate ? "ellipsis" : undefined,
    borderBottom: `1px solid ${T.border}`,
  }}>{children}</td>
)

/* ═══════════════════════════════════════════════════════════
   UTC/IST PILL TOGGLE
═══════════════════════════════════════════════════════════ */
function TzToggle({ tz, setTz }) {
  return (
    <div style={{
      display: "flex", alignItems: "center",
      background: T.panel, border: `1px solid ${T.border}`,
      borderRadius: 4, overflow: "hidden", height: 26,
    }}>
      {["ist", "utc"].map(z => (
        <button key={z} onClick={() => setTz(z)} style={{
          padding: "0 10px", height: "100%",
          background: tz === z ? T.blue : "transparent",
          border: "none", color: tz === z ? "#fff" : T.t1,
          fontSize: 10, fontFamily: MONO, fontWeight: 700,
          cursor: "pointer", letterSpacing: .8,
          transition: "background .12s, color .12s",
        }}>
          {z.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   DETAIL PANEL CONTENT
═══════════════════════════════════════════════════════════ */
function DetailPanelContent({ item, type, tz }) {
  if (!item) return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", height: "100%", gap: 12, color: T.t2, padding: 24
    }}>
      <Database size={28} strokeWidth={1.2} />
      <span style={{ fontSize: 11, fontFamily: MONO }}>Select a row to inspect</span>
    </div>
  )

  const Row = ({ label, value, color = T.t0 }) => (
    <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, marginBottom: 10, alignItems: "start" }}>
      <span style={{ fontSize: 10, fontFamily: MONO, color: T.t2, textTransform: "uppercase", letterSpacing: .7, paddingTop: 1 }}>{label}</span>
      <span style={{ fontSize: 11, fontFamily: MONO, color, wordBreak: "break-all", lineHeight: 1.5 }}>{value || "—"}</span>
    </div>
  )
  const Sep = ({ title }) => (
    <div style={{ margin: "14px 0 8px", paddingBottom: 5, borderBottom: `1px solid ${T.border}` }}>
      <span style={{ fontSize: 9, fontFamily: MONO, color: T.blue, textTransform: "uppercase", letterSpacing: 1.4, fontWeight: 700 }}>{title}</span>
    </div>
  )

  if (type === "visit") {
    const v = item, tr = v.transition || {}, ctx = v.context || {}, cnt = v.content || {}
    const http = String(ctx.http_response_code || "")
    const httpColor = http.startsWith("4") || http.startsWith("5") ? T.red : http === "200" ? T.green : T.t0
    return (
      <div style={{ padding: "14px 16px" }}>
        <Row label="URL"       value={v.url}   color={T.blue} />
        <Row label="Title"     value={v.title} />
        <Row label="IST"       value={tIST(v.visit_time)} color={tz === "ist" ? T.t0 : T.t1} />
        <Row label="UTC"       value={tUTC(v.visit_time)} color={tz === "utc" ? T.t0 : T.t1} />
        <Row label="Visit ID"  value={String(v.visit_id)} color={T.t2} />
        <Sep title="Navigation" />
        <Row label="Transition" value={tr.core_type}                            color={TC[tr.core_type] || T.t0} />
        <Row label="Qualifiers" value={(tr.qualifiers || []).join(", ") || "—"} color={T.t1} />
        <Row label="From Visit" value={String(v.from_visit || "— root")} />
        <Row label="Opener"     value={String(v.opener_visit || "—")}           color={T.t1} />
        <Row label="Referrer"   value={v.external_referrer_url}                 color={T.blue} />
        <Row label="Duration"   value={fmtDur(v.visit_duration_us)} />
        <Row label="Source"     value={v.visit_source} />
        <Sep title="Sync" />
        <Row label="Synced"     value={v.is_known_to_sync ? "YES" : "no"} color={v.is_known_to_sync ? T.green : T.t2} />
        <Row label="Orig GUID"  value={v.originator_cache_guid}           color={T.t2} />
        <Row label="Orig Visit" value={String(v.originator_visit_id || "—")} />
        <Row label="App ID"     value={v.app_id} color={T.t1} />
        {Object.keys(ctx).length > 0 && <>
          <Sep title="Context" />
          <Row label="HTTP"       value={http || "—"}     color={httpColor} />
          <Row label="Win/Tab"    value={`${ctx.window_id} / ${ctx.tab_id}`} />
          <Row label="Tasks"      value={`${ctx.task_id}→${ctx.root_task_id}→${ctx.parent_task_id}`} color={T.t2} />
          <Row label="FG Dur"     value={fmtDur(ctx.total_foreground_duration_us)} />
          <Row label="Page End"   value={String(ctx.page_end_reason || "—")} />
          <Row label="Since Last" value={fmtDur(ctx.duration_since_last_visit)} />
        </>}
        {cnt.search_terms && <>
          <Sep title="Content" />
          <Row label="Search"     value={cnt.search_terms}          color={T.amber} />
          <Row label="S.URL"      value={cnt.search_normalized_url} color={T.blue} />
          <Row label="Lang"       value={cnt.page_language} />
          <Row label="Password"   value={String(cnt.password_state || 0)} color={cnt.password_state > 0 ? T.red : T.t2} />
          <Row label="Entities"   value={cnt.entities}   color={T.t1} />
          <Row label="Categories" value={cnt.categories} color={T.t1} />
        </>}
      </div>
    )
  }

  if (type === "download") {
    const dl = item
    return (
      <div style={{ padding: "14px 16px" }}>
        <Row label="File"      value={dl.target_path?.split(/[\\\/]/).pop()} />
        <Row label="Path"      value={dl.target_path} color={T.t1} />
        <Row label="State"     value={dl.state}
             color={dl.state === "COMPLETE" ? T.green : dl.state === "INTERRUPTED" ? T.red : T.amber} />
        <Sep title="File Info" />
        <Row label="MIME"      value={dl.mime_type} />
        <Row label="Orig MIME" value={dl.original_mime_type} color={T.t1} />
        <Row label="Hash"      value={dl.file_hash_hex?.slice(0, 40)} color={T.t2} />
        <Sep title="Timing" />
        <Row label="Start IST" value={tIST(dl.start_time)} color={tz === "ist" ? T.t0 : T.t1} />
        <Row label="Start UTC" value={tUTC(dl.start_time)} color={tz === "utc" ? T.t0 : T.t1} />
        <Row label="End IST"   value={tIST(dl.end_time)}   color={tz === "ist" ? T.t0 : T.t1} />
        <Row label="End UTC"   value={tUTC(dl.end_time)}   color={tz === "utc" ? T.t0 : T.t1} />
        <Row label="Size"      value={`${fmtBytes(dl.received_bytes)} / ${fmtBytes(dl.total_bytes)}`} />
        <Sep title="Attribution" />
        <Row label="Site URL"  value={dl.site_url}  color={T.blue} />
        <Row label="Tab URL"   value={dl.tab_url}   color={T.blue} />
        <Row label="Referrer"  value={dl.referrer}  color={T.blue} />
        <Row label="Method"    value={dl.http_method} />
        <Row label="By Ext"    value={`${dl.by_extension_name || "—"} (${dl.by_extension_id || "—"})`} />
        <Row label="ETag"      value={dl.etag} color={T.t2} />
        {dl.url_chain?.length > 0 && <>
          <Sep title="URL Chain" />
          {dl.url_chain.map(c => <Row key={c.index} label={`[${c.index}]`} value={c.url} color={T.blue} />)}
        </>}
      </div>
    )
  }
  return null
}

/* ═══════════════════════════════════════════════════════════
   SLIDE PANEL
   FIX 1: role="dialog" aria-modal="true" — screen readers know
          the context is restricted to this panel.
   FIX 2: Focus trap — when open, Tab/Shift-Tab cycle is contained
          inside the panel. Focus is seized on open and released
          on close. ESC still closes. Listener cleaned up on unmount.
═══════════════════════════════════════════════════════════ */
function SlidePanel({ item, type, tz, onClose }) {
  const open       = !!item
  const onCloseRef = useRef(onClose)
  const panelRef   = useRef(null)
  const closeRef   = useRef(null)

  useEffect(() => { onCloseRef.current = onClose })

  useEffect(() => {
    if (!open || !panelRef.current) return

    // Seize focus on open
    closeRef.current?.focus()

    const panel = panelRef.current
    const getFocusable = () => Array.from(panel.querySelectorAll(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ))

    const handleKey = e => {
      if (e.key === "Escape") { onCloseRef.current(); return }
      if (e.key !== "Tab") return
      const els = getFocusable()
      if (!els.length) return
      const first = els[0], last = els[els.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus() }
      } else {
        if (document.activeElement === last)  { e.preventDefault(); first?.focus() }
      }
    }

    document.addEventListener("keydown", handleKey)
    return () => document.removeEventListener("keydown", handleKey)
  }, [open])

  return (
    <>
      <div onClick={onClose} role="presentation" style={{
        position: "fixed", inset: 0, background: "rgba(0,5,20,0.55)", zIndex: 50,
        opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none",
        transition: "opacity 0.2s ease",
      }} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={type === "visit" ? "Visit Detail" : "Download Detail"}
        style={{
          position: "fixed", right: 0, top: 0, bottom: 0, width: 360,
          background: T.panel, borderLeft: `1px solid ${T.border2}`,
          zIndex: 51, display: "flex", flexDirection: "column",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.24s cubic-bezier(0.4,0,0.2,1)",
          boxShadow: open ? "-8px 0 40px rgba(0,5,20,0.7)" : "none",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", borderBottom: `1px solid ${T.border}`,
          flexShrink: 0, background: T.surf,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 2, height: 12, background: T.blue, borderRadius: 2 }} />
            <span style={{ fontSize: 9, fontFamily: MONO, color: T.blue, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.4 }}>
              {type === "visit" ? "Visit Detail" : "Download Detail"}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, fontFamily: MONO, color: T.t3 }}>ESC</span>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close detail panel"
              style={{
                background: T.card, border: `1px solid ${T.border}`, borderRadius: 4,
                cursor: "pointer", color: T.t1,
                display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = T.hover; e.currentTarget.style.color = T.t0 }}
              onMouseLeave={e => { e.currentTarget.style.background = T.card;  e.currentTarget.style.color = T.t1 }}
            ><X size={13} /></button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          <DetailPanelContent item={item} type={type} tz={tz} />
        </div>
        {item && (
          <div style={{
            padding: "6px 14px", borderTop: `1px solid ${T.border}`,
            fontSize: 9, fontFamily: MONO, color: T.t3, flexShrink: 0,
            display: "flex", alignItems: "center", gap: 5,
          }}>
            <PanelRightClose size={9} /> Click backdrop or ESC to close
          </div>
        )}
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════════════════════
   PAGE: BROWSE TREE

   FIX 1 — parentOf memoized here, not rebuilt inside flattenTree.
   FIX 2 — expandDepth uses iterative BFS (not recursive DFS).
   FIX 3 — flattenTree returns { rows, truncated }; amber warning shown.
   FIX 4 — useDeferredValue on filter; table dims while stale.
   FIX 5 — stable colResizers via useMemo (no new fn refs per render).
   FIX 6 — expandAll/collapseAll wrapped in useCallback.
   FIX 7 — expand toggle is a <button> (keyboard accessible) not <span>.
═══════════════════════════════════════════════════════════ */
function PageTree({ byId, childrenMap, rootIds, filter, tz }) {
  const [open, setOpen] = useState(new Set())
  const [sel,  setSel]  = useState(null)
  const [cols, setCols] = useState({ url: 440, time: 145, trans: 115, dur: 72, src: 70, tab: 45 })

  const deferredFilter = useDeferredValue(filter)
  const isStale        = filter !== deferredFilter

  // FIX 5: stable per-column resizers — setCols is guaranteed stable by React
  const colResizers = useMemo(() => ({
    url:   w => setCols(c => ({ ...c, url:   w })),
    time:  w => setCols(c => ({ ...c, time:  w })),
    trans: w => setCols(c => ({ ...c, trans: w })),
    dur:   w => setCols(c => ({ ...c, dur:   w })),
    src:   w => setCols(c => ({ ...c, src:   w })),
    tab:   w => setCols(c => ({ ...c, tab:   w })),
  }), [])

  // FIX 1: build once per data load
  const parentOf = useMemo(() => {
    const map = {}
    for (const [pid, kids] of Object.entries(childrenMap))
      for (const kid of kids) map[kid] = Number(pid)
    return map
  }, [childrenMap])

  const { rows: flat, truncated } = useMemo(() =>
    flattenTree(rootIds, childrenMap, byId, open, deferredFilter, parentOf),
    [rootIds, childrenMap, byId, open, deferredFilter, parentOf]
  )

  const toggle = useCallback(id => {
    setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  // FIX 6
  const expandAll = useCallback(() => {
    setOpen(new Set(Object.keys(childrenMap).map(Number)))
  }, [childrenMap])

  const collapseAll = useCallback(() => setOpen(new Set()), [])

  // FIX 2: iterative BFS — recursive DFS stack-overflows on deep chains
  const expandDepth = useCallback(max => {
    const add = new Set()
    const queue = rootIds.map(id => ({ id, d: 0 }))
    let qi = 0
    while (qi < queue.length) {
      const { id, d } = queue[qi++]
      if (d >= max) continue
      const kids = childrenMap[id] || []
      if (kids.length) { add.add(id); for (const kid of kids) queue.push({ id: kid, d: d + 1 }) }
    }
    setOpen(add)
  }, [rootIds, childrenMap])

  const selVisit = byId[sel]

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6, padding: "7px 14px",
          background: T.surf, borderBottom: `1px solid ${T.border}`, flexShrink: 0
        }}>
          {[
            ["Expand All", expandAll],
            ["Collapse",   collapseAll],
            ["Depth 1",    () => expandDepth(1)],
            ["Depth 2",    () => expandDepth(2)],
            ["Depth 3",    () => expandDepth(3)],
          ].map(([t, fn]) => (
            <button key={t} onClick={fn} style={{
              padding: "3px 9px", background: T.card,
              border: `1px solid ${T.border2}`, color: T.t0,
              fontSize: 10, fontFamily: MONO, borderRadius: 3, cursor: "pointer"
            }}>{t}</button>
          ))}

          <div style={{ marginLeft: 10, display: "flex", alignItems: "center", gap: 10, borderLeft: `1px solid ${T.border}`, paddingLeft: 10 }}>
            {Object.entries({ TYPED: TC.TYPED, LINK: TC.LINK, FORM: TC.FORM_SUBMIT, RELOAD: TC.RELOAD, KW: TC.KEYWORD }).map(([k, c]) => (
              <span key={k} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, fontFamily: MONO, color: c }}>
                <span style={{ width: 5, height: 5, borderRadius: 1, background: c, display: "inline-block", flexShrink: 0 }} />
                {k}
              </span>
            ))}
          </div>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            {truncated && (
              <span style={{
                fontSize: 9, fontFamily: MONO, color: T.amber,
                background: `${T.amber}14`, border: `1px solid ${T.amber}30`,
                padding: "2px 7px", borderRadius: 3,
              }}>⚠ limit reached — collapse nodes to see more</span>
            )}
            {isStale && (
              <span style={{ fontSize: 9, fontFamily: MONO, color: T.t3 }}>filtering…</span>
            )}
            <span style={{ fontSize: 10, fontFamily: MONO, color: T.t2 }}>
              {flat.length.toLocaleString()} nodes
            </span>
          </div>
        </div>

        {/* Tree table — FIX 4: dims while deferred filter is catching up */}
        <div style={{ flex: 1, overflow: "auto", opacity: isStale ? 0.6 : 1, transition: "opacity 0.15s" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                <TH width={cols.url}   onResize={colResizers.url}>URL / Navigation Chain</TH>
                <TH width={cols.time}  onResize={colResizers.time}>Time ({tz.toUpperCase()})</TH>
                <TH width={cols.trans} onResize={colResizers.trans}>Transition</TH>
                <TH width={cols.dur}   onResize={colResizers.dur}>Duration</TH>
                <TH width={cols.src}   onResize={colResizers.src}>Source</TH>
                <TH width={cols.tab}   onResize={colResizers.tab}>Tab</TH>
                <TH>Title</TH>
              </tr>
            </thead>
            <tbody>
              {flat.map(({ id, depth, hasKids, open: isOpen, dimmed }) => {
                const v = byId[id]; if (!v) return null
                const tr  = v.transition || {}
                const ctx = v.context    || {}
                const isSel = sel === id
                const tc    = TC[tr.core_type]
                return (
                  <tr
                    key={id}
                    onClick={() => setSel(id)}
                    tabIndex={0}
                    aria-selected={isSel}
                    onKeyDown={e => (e.key === "Enter" || e.key === " ") && setSel(id)}
                    style={{ background: isSel ? T.sel : "transparent", cursor: "pointer", opacity: dimmed ? 0.28 : 1 }}
                    onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = T.hover }}
                    onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = "transparent" }}
                  >
                    <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap", overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", paddingLeft: depth * 16, gap: 4 }}>

                        {/* FIX 7: <button> not <span> — Tab-reachable, Enter/Space activates */}
                        <button
                          onClick={e => { e.stopPropagation(); if (hasKids) toggle(id) }}
                          onKeyDown={e => {
                            if ((e.key === "Enter" || e.key === " ") && hasKids) {
                              e.stopPropagation(); toggle(id)
                            }
                          }}
                          aria-expanded={hasKids ? isOpen : undefined}
                          aria-label={isOpen ? "Collapse" : "Expand"}
                          disabled={!hasKids}
                          style={{
                            width: 26, height: 26, display: "flex", alignItems: "center",
                            justifyContent: "center", flexShrink: 0, borderRadius: 4,
                            cursor: hasKids ? "pointer" : "default",
                            background: hasKids ? `${T.blue}14` : "transparent",
                            border: hasKids ? `1px solid ${T.blue}30` : "1px solid transparent",
                            color: isOpen ? T.blue : T.t1, padding: 0,
                          }}
                          onMouseEnter={e => { if (hasKids) e.currentTarget.style.background = `${T.blue}28` }}
                          onMouseLeave={e => { e.currentTarget.style.background = hasKids ? `${T.blue}14` : "transparent" }}
                        >
                          {hasKids
                            ? (isOpen ? <ChevronDown size={17} strokeWidth={2.2} /> : <ChevronRight size={17} strokeWidth={2.2} />)
                            : <span style={{ width: 17 }} />}
                        </button>

                        <span style={{
                          fontSize: 11, fontFamily: MONO, color: tc || T.t0,
                          overflow: "hidden", textOverflow: "ellipsis", display: "block",
                          maxWidth: cols.url - depth * 16 - 30,
                        }}>
                          {v.url}
                        </span>
                      </div>
                    </td>
                    <TD color={T.t1}>{tShow(v.visit_time, tz)}</TD>
                    <TD>{tr.core_type && <Badge text={tr.core_type} color={tc || T.t1} />}</TD>
                    <TD color={T.t1}>{fmtDur(v.visit_duration_us)}</TD>
                    <TD color={T.t2}>{v.visit_source}</TD>
                    <TD color={T.t2}>{ctx.tab_id ?? ""}</TD>
                    <TD color={T.t1} truncate>{v.title}</TD>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <SlidePanel item={selVisit} type="visit" tz={tz} onClose={() => setSel(null)} />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   PAGE: TIMELINE

   FIX 1 — DOUBLE-SORT REMOVED.
            Old code: useMemo sorted, then useSort sorted again.
            Both ran on every render = O(n log n) wasted work.
            Now: useMemo only FILTERS. useSort owns ALL sorting.
            default "visit_time" + asc=false → newest first on load.
   FIX 2 — useDeferredValue keeps typing instantaneous.
   FIX 3 — stable colResizers via useMemo.
═══════════════════════════════════════════════════════════ */
function PageTimeline({ data, byId, filter, tz }) {
  const [sel,  setSel]  = useState(null)
  const [page, setPage] = useState(0)
  const [cols, setCols] = useState({ time: 182, domain: 160, title: 190, trans: 115, dur: 72, http: 46, tab: 46 })
  const PER = 200

  const deferredFilter = useDeferredValue(filter)
  const isStale        = filter !== deferredFilter

  const colResizers = useMemo(() => ({
    time:   w => setCols(c => ({ ...c, time:   w })),
    domain: w => setCols(c => ({ ...c, domain: w })),
    title:  w => setCols(c => ({ ...c, title:  w })),
    trans:  w => setCols(c => ({ ...c, trans:  w })),
    dur:    w => setCols(c => ({ ...c, dur:    w })),
    http:   w => setCols(c => ({ ...c, http:   w })),
    tab:    w => setCols(c => ({ ...c, tab:    w })),
  }), [])

  // FIX 1: filter only — useSort handles all sorting below
  const visits = useMemo(() => {
    const ft = deferredFilter.toLowerCase()
    return (data.visits || []).filter(v =>
      !ft ||
      (v.url   || "").toLowerCase().includes(ft) ||
      (v.title || "").toLowerCase().includes(ft)
    )
  }, [data.visits, deferredFilter])

  // Single sort pass — default "visit_time" descending (asc=false = newest first)
  const { sorted, col, asc, toggle } = useSort(visits, "visit_time")

  useEffect(() => { setPage(0) }, [deferredFilter, col, asc])

  const pages    = Math.ceil(sorted.length / PER) || 1
  const pageData = sorted.slice(page * PER, (page + 1) * PER)
  const selVisit = byId[sel]

  const hdr = (label, field, colKey) => (
    <TH key={label} width={cols[colKey]} onResize={colResizers[colKey]}
        onClick={() => toggle(field)}
        sorted={col === field ? (asc ? "asc" : "desc") : undefined}>
      {label}
    </TH>
  )

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 14px",
          background: T.surf, borderBottom: `1px solid ${T.border}`, flexShrink: 0
        }}>
          <span style={{ fontSize: 10, fontFamily: MONO, color: T.t2 }}>
            {sorted.length.toLocaleString()} visits
          </span>
          <span style={{ fontSize: 10, fontFamily: MONO, color: T.t3 }}>·</span>
          <span style={{ fontSize: 10, fontFamily: MONO, color: T.t2 }}>
            Page {page + 1} / {pages}
          </span>
          {isStale && (
            <span style={{ fontSize: 9, fontFamily: MONO, color: T.t3, marginLeft: 4 }}>filtering…</span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              style={{ padding: "3px 9px", background: T.card, border: `1px solid ${T.border2}`,
                color: page === 0 ? T.t3 : T.t0, fontSize: 10, fontFamily: MONO,
                borderRadius: 3, cursor: page === 0 ? "not-allowed" : "pointer" }}>←</button>
            <button onClick={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}
              style={{ padding: "3px 9px", background: T.card, border: `1px solid ${T.border2}`,
                color: page >= pages - 1 ? T.t3 : T.t0, fontSize: 10, fontFamily: MONO,
                borderRadius: 3, cursor: page >= pages - 1 ? "not-allowed" : "pointer" }}>→</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", opacity: isStale ? 0.6 : 1, transition: "opacity 0.15s" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                {hdr(`Time (${tz.toUpperCase()})`, "visit_time", "time")}
                {hdr("Domain",                      "url",        "domain")}
                {hdr("Title",                       "title",      "title")}
                <TH width={cols.trans} onResize={colResizers.trans}>Transition</TH>
                <TH width={cols.dur}   onResize={colResizers.dur}>Duration</TH>
                <TH width={cols.http}  onResize={colResizers.http}>HTTP</TH>
                <TH width={cols.tab}   onResize={colResizers.tab}>Tab</TH>
                <TH>Referrer</TH>
              </tr>
            </thead>
            <tbody>
              {pageData.map((v, i) => {
                const tr    = v.transition || {}
                const ctx   = v.context    || {}
                const isSel = sel === v.visit_id
                const tc    = TC[tr.core_type]
                const http  = String(ctx.http_response_code || "")
                const hc    = http.startsWith("4") || http.startsWith("5") ? T.red
                            : http === "200" ? T.green : T.t1
                return (
                  <tr
                    key={v.visit_id}
                    onClick={() => setSel(v.visit_id)}
                    tabIndex={0}
                    aria-selected={isSel}
                    onKeyDown={e => (e.key === "Enter" || e.key === " ") && setSel(v.visit_id)}
                    style={{ background: isSel ? T.sel : i % 2 === 0 ? "transparent" : `${T.surf}70`, cursor: "pointer" }}
                    onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = T.hover }}
                    onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = i % 2 === 0 ? "transparent" : `${T.surf}70` }}
                  >
                    <td style={{ padding: "4px 10px", borderBottom: `1px solid ${T.border}`, fontFamily: MONO, whiteSpace: "nowrap" }}>
                      <div style={{ fontSize: 11, color: T.t0, lineHeight: 1.3 }}>{tShow(v.visit_time, tz)}</div>
                      <div style={{ fontSize: 9,  color: T.t3, lineHeight: 1.3, marginTop: 1 }}>{tAlt(v.visit_time, tz)}</div>
                    </td>
                    <TD color={tc || T.t0}>{dom(v.url)}</TD>
                    <TD color={T.t1} truncate>{v.title}</TD>
                    <TD>{tr.core_type && <Badge text={tr.core_type} color={tc || T.t1} />}</TD>
                    <TD color={T.t1}>{fmtDur(v.visit_duration_us)}</TD>
                    <TD color={hc}>{http || "—"}</TD>
                    <TD color={T.t2}>{ctx.tab_id ?? ""}</TD>
                    <TD color={T.t2} truncate>{v.external_referrer_url}</TD>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <SlidePanel item={selVisit} type="visit" tz={tz} onClose={() => setSel(null)} />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   PAGE: DOWNLOADS
   FIX 1 — dlById O(1) map replaces O(n) dls.find() on every render.
   FIX 2 — stable colResizers via useMemo.
   FIX 3 — useDeferredValue on filter.
═══════════════════════════════════════════════════════════ */
function PageDownloads({ data, filter, tz }) {
  const [sel,  setSel]  = useState(null)
  const [cols, setCols] = useState({ time: 145, file: 220, size: 76, state: 95, mime: 160 })

  const colResizers = useMemo(() => ({
    time:  w => setCols(c => ({ ...c, time:  w })),
    file:  w => setCols(c => ({ ...c, file:  w })),
    size:  w => setCols(c => ({ ...c, size:  w })),
    state: w => setCols(c => ({ ...c, state: w })),
    mime:  w => setCols(c => ({ ...c, mime:  w })),
  }), [])

  const deferredFilter = useDeferredValue(filter)

  const dls = useMemo(() => {
    const ft = deferredFilter.toLowerCase()
    return (data.downloads || [])
      .filter(d => {
        const nm = d.target_path?.split(/[\\\/]/).pop() || ""
        return !ft || nm.toLowerCase().includes(ft) || (d.site_url || "").toLowerCase().includes(ft)
      })
      .sort((a, b) => (b.start_time?.unix_ms || 0) - (a.start_time?.unix_ms || 0))
  }, [data.downloads, deferredFilter])

  // FIX 1: build lookup from source data once; O(1) access vs O(n) find
  const dlById = useMemo(() =>
    Object.fromEntries((data.downloads || []).map(d => [d.download_id, d])),
  [data.downloads])

  const selDl = sel != null ? dlById[sel] : null

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <div style={{
          padding: "7px 14px", background: T.surf,
          borderBottom: `1px solid ${T.border}`, flexShrink: 0,
          fontSize: 10, fontFamily: MONO, color: T.t2,
          display: "flex", alignItems: "center",
        }}>
          <span>{dls.length.toLocaleString()} downloads</span>
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                <TH width={cols.time}  onResize={colResizers.time}>Start ({tz.toUpperCase()})</TH>
                <TH width={cols.file}  onResize={colResizers.file}>Filename</TH>
                <TH width={cols.size}  onResize={colResizers.size}>Size</TH>
                <TH width={cols.state} onResize={colResizers.state}>State</TH>
                <TH width={cols.mime}  onResize={colResizers.mime}>MIME</TH>
                <TH>Referrer</TH>
              </tr>
            </thead>
            <tbody>
              {dls.map((dl, i) => {
                const isSel = sel === dl.download_id
                const sc    = dl.state === "COMPLETE" ? T.green : dl.state === "INTERRUPTED" ? T.red : T.amber
                const fname = dl.target_path?.split(/[\\\/]/).pop() || "—"
                return (
                  <tr
                    key={dl.download_id}
                    onClick={() => setSel(dl.download_id)}
                    tabIndex={0}
                    aria-selected={isSel}
                    onKeyDown={e => (e.key === "Enter" || e.key === " ") && setSel(dl.download_id)}
                    style={{ background: isSel ? T.sel : i % 2 === 0 ? "transparent" : `${T.surf}70`, cursor: "pointer" }}
                    onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = T.hover }}
                    onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = i % 2 === 0 ? "transparent" : `${T.surf}70` }}
                  >
                    <TD color={T.t1}>{tShow(dl.start_time, tz)}</TD>
                    <TD color={T.t0}>{fname}</TD>
                    <TD color={T.t1}>{fmtBytes(dl.total_bytes || dl.received_bytes)}</TD>
                    <TD color={sc}>{dl.state}</TD>
                    <TD color={T.t1}>{dl.mime_type}</TD>
                    <TD color={T.t2} truncate>{dl.referrer}</TD>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <SlidePanel item={selDl} type="download" tz={tz} onClose={() => setSel(null)} />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   TIME FILTER PICKER
═══════════════════════════════════════════════════════════ */
const PRESETS = [
  { label: "6h",  hours: 6   },
  { label: "24h", hours: 24  },
  { label: "48h", hours: 48  },
  { label: "7d",  hours: 168 },
  { label: "30d", hours: 720 },
  { label: "All", hours: null },
]

function TimeFilterPicker({ days, setDays, hoursExtra, setHoursExtra, allTime, setAllTime }) {
  const applyPreset = h => {
    if (h === null) { setAllTime(true); return }
    setAllTime(false); setDays(Math.floor(h / 24)); setHoursExtra(h % 24)
  }
  const num = {
    width: 44, padding: "3px 5px", background: "transparent",
    border: `1px solid ${T.border}`, borderRadius: 3,
    color: allTime ? T.t2 : T.t0, fontSize: 11, fontFamily: MONO,
    textAlign: "center", outline: "none",
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {PRESETS.map(p => {
          const on = p.hours === null ? allTime : !allTime && (days * 24 + hoursExtra) === p.hours
          return (
            <button key={p.label} onClick={() => applyPreset(p.hours)} style={{
              padding: "3px 10px", fontSize: 10, fontFamily: MONO,
              background: on ? `${T.blue}20` : "transparent",
              border: `1px solid ${on ? T.blue : T.border}`,
              color: on ? T.blue : T.t2, borderRadius: 3, cursor: "pointer", transition: "all .1s",
            }}
              onMouseEnter={e => { if (!on) { e.currentTarget.style.borderColor = T.blue; e.currentTarget.style.color = T.t1 } }}
              onMouseLeave={e => { if (!on) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.t2 } }}
            >{p.label}</button>
          )
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: allTime ? 0.3 : 1, transition: "opacity .15s" }}>
        <span style={{ fontSize: 10, fontFamily: MONO, color: T.t2 }}>Last</span>
        <input type="number" min={0} max={3650} value={days} style={num}
          onChange={e => { setAllTime(false); setDays(Math.max(0, parseInt(e.target.value) || 0)) }} />
        <span style={{ fontSize: 10, fontFamily: MONO, color: T.t2 }}>d</span>
        <input type="number" min={0} max={23} value={hoursExtra} style={num}
          onChange={e => { setAllTime(false); setHoursExtra(Math.min(23, Math.max(0, parseInt(e.target.value) || 0))) }} />
        <span style={{ fontSize: 10, fontFamily: MONO, color: T.t2 }}>h</span>
        {!allTime && <span style={{ fontSize: 10, fontFamily: MONO, color: T.t3, marginLeft: 4 }}>= {days * 24 + hoursExtra}h</span>}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   DROP ZONE
═══════════════════════════════════════════════════════════ */
function DropZone({ onLoad }) {
  const [drag,       setDrag]       = useState(false)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const [days,       setDays]       = useState(2)
  const [hoursExtra, setHoursExtra] = useState(0)
  const [allTime,    setAllTime]    = useState(false)
  const ref = useRef()

  const upload = async file => {
    const totalHours = allTime ? null : (days * 24 + hoursExtra)
    setLoading(true); setError(null)
    try {
      const buffer = await file.arrayBuffer()
      const json   = await parseHistory({ fileBuffer: buffer, browser: "Unknown", profile: "Default", hours: totalHours })
      if (!json.visits) throw new Error("Missing visits — is this a valid Chromium History SQLite file?")
      onLoad(json)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleFile = file => { if (file) upload(file) }

  return (
    <div
      onDragOver={e  => { e.preventDefault(); setDrag(true) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false) }}
      onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]) }}
      style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        background: T.bg,
        backgroundImage: `radial-gradient(ellipse 55% 40% at 50% 52%, ${T.surf}cc 0%, transparent 75%)`,
        outline: drag ? `2px solid ${T.blue}` : "2px solid transparent",
        outlineOffset: "-2px",
        transition: "outline-color .15s, background .15s",
        cursor: loading ? "wait" : "default",
        position: "relative",
      }}
    >
      {drag && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: `${T.blue}08`, pointerEvents: "none", zIndex: 10,
        }}>
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
            padding: "24px 40px", background: `${T.panel}ee`,
            border: `1.5px solid ${T.blue}60`, borderRadius: 12, backdropFilter: "blur(8px)",
          }}>
            <Upload size={28} color={T.blue} strokeWidth={1.5} />
            <span style={{ fontSize: 13, fontFamily: MONO, color: T.blue, fontWeight: 700 }}>Release to load</span>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32 }}>
        <img src="/image.png" alt="logo" style={{
          width: 42, height: 42, objectFit: "contain", borderRadius: 9, flexShrink: 0,
          border: "1.5px solid rgba(255,255,255,0.25)",
        }} />
        <div>
          <div style={{ fontSize: 13, fontFamily: MONO, fontWeight: 700, color: T.t0, letterSpacing: .4 }}>
            SecOps Browser History Analyzer
          </div>
        </div>
      </div>

      <div style={{
        width: 430, background: T.panel,
        border: `1px solid ${error ? `${T.red}50` : T.border}`,
        borderRadius: 8, overflow: "hidden",
        boxShadow: `0 24px 64px rgba(0,8,30,0.5)`, transition: "border-color .15s",
      }}>
        <div
          onClick={() => !loading && ref.current.click()}
          style={{
            padding: "26px 36px 20px", display: "flex", flexDirection: "column",
            alignItems: "center", gap: 10,
            cursor: loading ? "wait" : "pointer", borderBottom: `1px solid ${T.border}`,
          }}
        >
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: loading ? `${T.blue}18` : T.card,
            border: `1px solid ${loading ? `${T.blue}55` : T.border2}`,
            display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s",
          }}>
            {loading
              ? <Loader size={15} color={T.blue} strokeWidth={1.5} style={{ animation: "spin 1s linear infinite" }} />
              : <Upload size={15} color={T.t1} strokeWidth={1.5} />
            }
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 13, fontFamily: MONO, fontWeight: 700, color: T.t0, marginBottom: 5 }}>
              {loading ? "Parsing…" : "Drop anywhere or click to browse"}
            </div>
            {!loading && (
              <div style={{ fontSize: 10, fontFamily: MONO, color: T.t2, lineHeight: 1.9 }}>
                Raw Chromium{" "}
                <code style={{ color: T.blue, background: `${T.blue}14`, padding: "1px 5px", borderRadius: 3 }}>History</code>
                {" SQLite file"}
              </div>
            )}
          </div>
        </div>

        {!loading && (
          <div style={{ padding: "13px 20px 16px" }} onClick={e => e.stopPropagation()}>
            <div style={{
              fontSize: 9, fontFamily: MONO, color: T.t2,
              textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10,
              display: "flex", alignItems: "center", gap: 5,
            }}>
              <Clock size={9} color={T.t2} /> Time Range
            </div>
            <TimeFilterPicker
              days={days} setDays={setDays}
              hoursExtra={hoursExtra} setHoursExtra={setHoursExtra}
              allTime={allTime} setAllTime={setAllTime}
            />
          </div>
        )}
      </div>

      {error && (
        <div style={{
          marginTop: 10, width: 430, padding: "9px 13px",
          background: `${T.red}0d`, border: `1px solid ${T.red}2a`,
          borderRadius: 6, display: "flex", alignItems: "flex-start", gap: 8,
        }}>
          <div style={{ width: 4, height: 4, borderRadius: "50%", background: T.red, marginTop: 4, flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 10, fontFamily: MONO, color: `${T.red}bb`, lineHeight: 1.5 }}>{error}</span>
          <button onClick={() => setError(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: T.t2, padding: 0, display: "flex", flexShrink: 0 }}>
            <X size={10} />
          </button>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.3 }
        input[type=number] { -moz-appearance: textfield }
      `}</style>
      <input
        ref={ref}
        type="file"
        aria-label="Upload Chromium History SQLite file"
        style={{ display: "none" }}
        onChange={e => handleFile(e.target.files[0])}
      />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   NAV PAGES REGISTRY
═══════════════════════════════════════════════════════════ */
const PAGES = [
  { key: "tree",      icon: Network,  label: "Browse Tree" },
  { key: "timeline",  icon: Clock,    label: "Timeline"    },
  { key: "downloads", icon: Download, label: "Downloads"   },
]

/* ═══════════════════════════════════════════════════════════
   MAIN APP

   FIX 1 — useDeferredValue on filter: input stays instant,
            pages get the deferred value for heavy useMemos.
   FIX 2 — exportToExcel yields to browser paint (setTimeout 0)
            before starting synchronous XLSX work.
   FIX 3 — duplicate divider removed.
   FIX 4 — ErrorBoundary wraps each page; key={page} resets
            it on navigation so errors don't bleed across tabs.
═══════════════════════════════════════════════════════════ */
export default function App() {
  const [data,      setData]      = useState(null)
  const [page,      setPage]      = useState("tree")
  const [filter,    setFilter]    = useState("")
  const [tz,        setTz]        = useState("ist")
  const [exporting, setExporting] = useState(false)

  // FIX 1: input binds to `filter`; pages receive `deferredFilter`
  const deferredFilter = useDeferredValue(filter)

  const byId = useMemo(() =>
    data ? Object.fromEntries((data.visits || []).map(v => [v.visit_id, v])) : {}
  , [data])

  const childrenMap = useMemo(() =>
    data
      ? Object.fromEntries(Object.entries(data.children_map || {}).map(([k, v]) => [Number(k), v]))
      : {}
  , [data])

  const rootIds = useMemo(() => data?.root_visit_ids || [], [data])

  // FIX 2: yield to browser before heavy synchronous XLSX serialization
  const exportToExcel = useCallback(async () => {
    if (!data) return
    setExporting(true)
    await new Promise(r => setTimeout(r, 0))   // let the disabled-button state paint first
    try {
      const wb = XLSX.utils.book_new()

      const visitRows = (data.visits || []).map(v => {
        const tr  = v.transition || {}
        const ctx = v.context    || {}
        const cnt = v.content    || {}
        return {
          "Visit ID":      v.visit_id,
          "URL":           v.url             || "",
          "Title":         v.title           || "",
          "Time (IST)":    tIST(v.visit_time),
          "Time (UTC)":    tUTC(v.visit_time),
          "Transition":    tr.core_type      || "",
          "Qualifiers":    (tr.qualifiers    || []).join(", "),
          "Duration (us)": v.visit_duration_us || 0,
          "From Visit":    v.from_visit      || 0,
          "Visit Source":  v.visit_source    || "",
          "Synced":        v.is_known_to_sync ? "YES" : "no",
          "HTTP Code":     ctx.http_response_code || "",
          "Tab ID":        ctx.tab_id        ?? "",
          "Window ID":     ctx.window_id     ?? "",
          "Referrer":      v.external_referrer_url || "",
          "Search Terms":  cnt.search_terms  || "",
          "App ID":        v.app_id          || "",
          "Orig GUID":     v.originator_cache_guid || "",
        }
      })
      const wsVisits = XLSX.utils.json_to_sheet(visitRows)
      wsVisits["!cols"] = [
        {wch:8},{wch:80},{wch:40},{wch:22},{wch:22},{wch:16},{wch:20},
        {wch:12},{wch:10},{wch:14},{wch:6},{wch:8},{wch:7},{wch:9},{wch:60},{wch:30},{wch:20},{wch:36},
      ]
      XLSX.utils.book_append_sheet(wb, wsVisits, "Visits")

      const dlRows = (data.downloads || []).map(dl => ({
        "Download ID":   dl.download_id,
        "Filename":      dl.target_path?.split(/[\\\/]/).pop() || "",
        "Full Path":     dl.target_path   || "",
        "State":         dl.state         || "",
        "Start (IST)":   tIST(dl.start_time),
        "Start (UTC)":   tUTC(dl.start_time),
        "End (IST)":     tIST(dl.end_time),
        "End (UTC)":     tUTC(dl.end_time),
        "Total Bytes":   dl.total_bytes   || 0,
        "Recv Bytes":    dl.received_bytes || 0,
        "MIME":          dl.mime_type     || "",
        "Orig MIME":     dl.original_mime_type || "",
        "Site URL":      dl.site_url      || "",
        "Tab URL":       dl.tab_url       || "",
        "Referrer":      dl.referrer      || "",
        "HTTP Method":   dl.http_method   || "",
        "By Extension":  dl.by_extension_name || "",
        "Hash (SHA256)": dl.file_hash_hex || "",
        "ETag":          dl.etag          || "",
      }))
      const wsDl = XLSX.utils.json_to_sheet(dlRows)
      wsDl["!cols"] = [
        {wch:11},{wch:40},{wch:70},{wch:12},{wch:22},{wch:22},{wch:22},{wch:22},
        {wch:12},{wch:12},{wch:30},{wch:30},{wch:60},{wch:60},{wch:60},{wch:10},{wch:24},{wch:66},{wch:20},
      ]
      XLSX.utils.book_append_sheet(wb, wsDl, "Downloads")

      const ts = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "")
      XLSX.writeFile(wb, `history_export_${ts}.xlsx`)
    } finally {
      setExporting(false)
    }
  }, [data])

  /* Landing */
  if (!data) return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: T.bg }}>
      <DropZone onLoad={setData} />
    </div>
  )

  /* Dashboard */
  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: T.bg, fontFamily: MONO, overflow: "hidden"
    }}>

      {/* TOP NAV */}
      <div style={{
        display: "flex", alignItems: "center", flexShrink: 0,
        background: T.panel, borderBottom: `1px solid ${T.border}`,
        height: 44,
      }}>
        {/* Logo + title */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "0 16px 0 14px", borderRight: `1px solid ${T.border}`,
          height: "100%", flexShrink: 0,
        }}>
          <img src="/image.png" alt="logo" style={{
            width: 32, height: 32, objectFit: "contain", borderRadius: 9, flexShrink: 0,
            border: "1.5px solid rgba(255,255,255,0.25)",
          }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: T.t0, letterSpacing: .3, whiteSpace: "nowrap" }}>
            SecOps Browser History Analyzer
          </span>
        </div>

        {/* Nav tabs */}
        <div style={{ display: "flex", alignItems: "center", height: "100%" }}>
          {PAGES.map(({ key, icon: Icon, label }) => {
            const active = page === key
            return (
              <button key={key} onClick={() => setPage(key)} style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "0 14px", height: "100%",
                background: "transparent", border: "none",
                borderBottom: `2px solid ${active ? T.blue : "transparent"}`,
                borderTop: "2px solid transparent",
                color: active ? T.t0 : T.t2, fontSize: 11, fontFamily: MONO,
                cursor: "pointer", transition: "color .12s, border-color .12s",
              }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.color = T.t1 }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.color = T.t2 }}
              >
                <Icon size={11} strokeWidth={active ? 2.2 : 1.5} color={active ? T.blue : "currentColor"} />
                {label}
              </button>
            )
          })}
        </div>

        {/* Right controls */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, paddingRight: 12 }}>

          {/* Search — binds to `filter` for instant feedback */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            background: T.card, border: `1px solid ${T.border}`,
            borderRadius: 4, padding: "0 8px", height: 26,
          }}>
            <Search size={11} color={T.t2} />
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter URL / title…"
              style={{
                background: "transparent", border: "none", outline: "none",
                color: T.t0, fontSize: 10, fontFamily: MONO,
                width: 190, caretColor: T.blue,
              }}
            />
            {filter && (
              <button onClick={() => setFilter("")}
                style={{ background: "none", border: "none", cursor: "pointer", color: T.t2, padding: 0, display: "flex" }}>
                <X size={10} />
              </button>
            )}
          </div>

          <TzToggle tz={tz} setTz={setTz} />

          {/* FIX 3: single divider — duplicate removed */}
          <div style={{ width: 1, height: 18, background: T.border }} />

          {/* Export Excel — FIX 2: shows "Exporting…" while busy */}
          <button
            onClick={exportToExcel}
            disabled={exporting}
            style={{
              padding: "3px 10px", height: 26,
              background: exporting ? `${T.green}08` : `${T.green}14`,
              border: `1px solid ${T.green}40`,
              color: exporting ? T.t2 : T.green,
              fontSize: 10, fontFamily: MONO, borderRadius: 4,
              cursor: exporting ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", gap: 5,
              transition: "background .12s, border-color .12s",
            }}
            onMouseEnter={e => { if (!exporting) { e.currentTarget.style.background = `${T.green}28`; e.currentTarget.style.borderColor = `${T.green}80` } }}
            onMouseLeave={e => { if (!exporting) { e.currentTarget.style.background = `${T.green}14`; e.currentTarget.style.borderColor = `${T.green}40` } }}
          >
            <FileDown size={11} /> {exporting ? "Exporting…" : "Export .xlsx"}
          </button>

          {/* New File */}
          <button
            onClick={() => { setData(null); setFilter(""); setPage("tree"); setTz("ist") }}
            style={{
              padding: "3px 10px", height: 26, background: T.card,
              border: `1px solid ${T.border2}`, color: T.t1,
              fontSize: 10, fontFamily: MONO, borderRadius: 4, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 5,
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = T.blue; e.currentTarget.style.color = T.t0 }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border2; e.currentTarget.style.color = T.t1 }}
          >
            <RefreshCw size={10} /> New File
          </button>
        </div>
      </div>

      {/* PAGE CONTENT — FIX 4: ErrorBoundary per page, key resets on nav */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <ErrorBoundary key={page}>
          {page === "tree"      && <PageTree      byId={byId} childrenMap={childrenMap} rootIds={rootIds} filter={deferredFilter} tz={tz} />}
          {page === "timeline"  && <PageTimeline  data={data} byId={byId} filter={deferredFilter} tz={tz} />}
          {page === "downloads" && <PageDownloads data={data} filter={deferredFilter} tz={tz} />}
        </ErrorBoundary>
      </div>
    </div>
  )
}