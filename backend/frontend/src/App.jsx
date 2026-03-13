import { useState, useMemo, useCallback, useRef, useEffect } from "react"
import {
  Upload, ChevronRight, ChevronDown, Search, X, Clock,
  Download, RefreshCw, AlertTriangle, Shield, Database,
  Network, SortAsc, SortDesc, Loader, PanelRightClose
} from "lucide-react"

/* ═══════════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════════ */
const T = {
  bg:      "#07080e", surf:    "#0c0d16", panel:   "#10111c",
  card:    "#151622", hover:   "#1a1b28", border:  "#1f2032",
  border2: "#272840",
  blue:    "#4f8ef7", cyan:    "#1fb6d4", green:   "#2ecc8a",
  red:     "#e85858", amber:   "#e8a020", purple:  "#9b7ae8",
  teal:    "#1ab8a8",
  t0:      "#dde0f0", t1:      "#7e82a0", t2:      "#40425a",
  t3:      "#252638",
  sel:     "#1a2c55",
}

const TC = {
  TYPED:             T.green,  LINK:              T.blue,
  FORM_SUBMIT:       T.red,    RELOAD:            T.amber,
  AUTO_BOOKMARK:     T.cyan,   GENERATED:         T.purple,
  KEYWORD:           T.purple, KEYWORD_GENERATED: T.purple,
  AUTO_TOPLEVEL:     T.teal,   AUTO_SUBFRAME:     T.t2,
  MANUAL_SUBFRAME:   T.t2,
}

const MONO = "'Cascadia Code','JetBrains Mono','Fira Code','Consolas',monospace"
const API_BASE = "http://localhost:5000"

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
const tIST = ts => ts?.ist || ts?.utc || "—"
const tUTC = ts => ts?.utc || "—"
const dom  = url => {
  try { return url.split("//")[1].split("/")[0].replace(/^www\./, "") }
  catch { return url?.slice(0, 40) || "" }
}

function flattenTree(rootIds, childrenMap, byId, openSet, filter, limit = 4000) {
  const ft    = filter.toLowerCase()
  const out   = []
  const stack = [...rootIds].reverse().map(id => ({ id, depth: 0 }))
  while (stack.length && out.length < limit) {
    const { id, depth } = stack.pop()
    const v = byId[id]
    if (!v) continue
    const url   = v.url   || ""
    const title = v.title || ""
    const kids  = childrenMap[id] || []
    const match = !ft || url.toLowerCase().includes(ft) || title.toLowerCase().includes(ft)
    if (match) out.push({ id, depth, hasKids: kids.length > 0, open: openSet.has(id) })
    if (openSet.has(id) || (!match && ft)) {
      for (let i = kids.length - 1; i >= 0; i--)
        stack.push({ id: kids[i], depth: depth + 1 })
    }
  }
  return out
}

/* ═══════════════════════════════════════════════════════════
   STYLE PRIMITIVES
═══════════════════════════════════════════════════════════ */
const Badge = ({ text, color }) => (
  <span style={{
    display: "inline-block", padding: "1px 7px", borderRadius: 3,
    fontSize: 10, fontFamily: MONO, fontWeight: 700, letterSpacing: .5,
    color, background: `${color}18`, border: `1px solid ${color}30`
  }}>{text}</span>
)

/* ═══════════════════════════════════════════════════════════
   TH  —  resizable column header
═══════════════════════════════════════════════════════════ */
const TH = ({ children, width, onClick, sorted, onResize }) => {
  const handleMouseDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = typeof width === "number" ? width : 100
    const onMove = (mv) => {
      onResize && onResize(Math.max(36, startW + mv.clientX - startX))
    }
    const onUp = () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup",   onUp)
      document.body.style.cursor     = ""
      document.body.style.userSelect = ""
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup",   onUp)
    document.body.style.cursor     = "col-resize"
    document.body.style.userSelect = "none"
  }

  return (
    <th
      onClick={onClick}
      style={{
        padding: "7px 10px", textAlign: "left",
        fontSize: 10, fontFamily: MONO, fontWeight: 700, color: T.blue,
        background: T.panel, borderBottom: `1px solid ${T.border}`,
        whiteSpace: "nowrap",
        width:    typeof width === "number" ? width : undefined,
        minWidth: typeof width === "number" ? width : undefined,
        maxWidth: typeof width === "number" ? width : undefined,
        cursor: onClick ? "pointer" : "default",
        userSelect: "none", position: "sticky", top: 0, zIndex: 1,
        boxSizing: "border-box",
        position: "sticky",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, paddingRight: 8 }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
          {children}
        </span>
        {sorted === "asc"  && <SortAsc  size={10} style={{ flexShrink: 0 }} />}
        {sorted === "desc" && <SortDesc size={10} style={{ flexShrink: 0 }} />}
      </div>

      {/* Resize handle — blue edge on hover */}
      {onResize && (
        <div
          onMouseDown={handleMouseDown}
          onClick={e => e.stopPropagation()}
          style={{
            position: "absolute", right: 0, top: 0, bottom: 0, width: 6,
            cursor: "col-resize", zIndex: 2,
            borderRight: "2px solid transparent",
            transition: "border-color .1s",
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
    whiteSpace:   truncate ? "nowrap"   : undefined,
    maxWidth:     truncate ? 280        : undefined,
    overflow:     truncate ? "hidden"   : undefined,
    textOverflow: truncate ? "ellipsis" : undefined,
    borderBottom: `1px solid ${T.border}`
  }}>
    {children}
  </td>
)

function useSort(data, def) {
  const [col, setCol] = useState(def)
  const [asc, setAsc] = useState(false)
  const toggle = c => { if (col === c) setAsc(a => !a); else { setCol(c); setAsc(true) } }
  const sorted = useMemo(() => {
    if (!col) return data
    return [...data].sort((a, b) => {
      const av = String(a[col] || ""), bv = String(b[col] || "")
      return asc ? av.localeCompare(bv) : bv.localeCompare(av)
    })
  }, [data, col, asc])
  return { sorted, col, asc, toggle }
}

/* ═══════════════════════════════════════════════════════════
   DETAIL PANEL CONTENT
═══════════════════════════════════════════════════════════ */
function DetailPanelContent({ item, type }) {
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
    const v   = item
    const tr  = v.transition || {}
    const ctx = v.context    || {}
    const cnt = v.content    || {}
    const http = String(ctx.http_response_code || "")
    const httpColor = http.startsWith("4") || http.startsWith("5") ? T.red
                    : http === "200" ? T.green : T.t0
    return (
      <div style={{ padding: "14px 16px" }}>
        <Row label="URL"       value={v.url}   color={T.cyan} />
        <Row label="Title"     value={v.title} color={T.t0} />
        <Row label="IST"       value={tIST(v.visit_time)} />
        <Row label="UTC"       value={tUTC(v.visit_time)} color={T.t1} />
        <Row label="Visit ID"  value={String(v.visit_id)} color={T.t2} />
        <Sep title="Navigation" />
        <Row label="Transition" value={tr.core_type}                           color={TC[tr.core_type] || T.t0} />
        <Row label="Qualifiers" value={(tr.qualifiers || []).join(", ") || "—"} color={T.t1} />
        <Row label="From Visit" value={String(v.from_visit || "— root")} />
        <Row label="Opener"     value={String(v.opener_visit || "—")}          color={T.t1} />
        <Row label="Referrer"   value={v.external_referrer_url}                color={T.cyan} />
        <Row label="Duration"   value={fmtDur(v.visit_duration_us)} />
        <Row label="Source"     value={v.visit_source} />
        <Sep title="Sync" />
        <Row label="Synced"     value={v.is_known_to_sync ? "YES" : "no"} color={v.is_known_to_sync ? T.green : T.t2} />
        <Row label="Orig GUID"  value={v.originator_cache_guid} color={T.t2} />
        <Row label="Orig Visit" value={String(v.originator_visit_id || "—")} />
        <Row label="App ID"     value={v.app_id} color={T.t1} />
        {Object.keys(ctx).length > 0 && <>
          <Sep title="Context" />
          <Row label="HTTP"       value={http || "—"}                                        color={httpColor} />
          <Row label="Win/Tab"    value={`${ctx.window_id} / ${ctx.tab_id}`} />
          <Row label="Tasks"      value={`${ctx.task_id}→${ctx.root_task_id}→${ctx.parent_task_id}`} color={T.t2} />
          <Row label="FG Dur"     value={fmtDur(ctx.total_foreground_duration_us)} />
          <Row label="Page End"   value={String(ctx.page_end_reason || "—")} />
          <Row label="Since Last" value={fmtDur(ctx.duration_since_last_visit)} />
        </>}
        {cnt.search_terms && <>
          <Sep title="Content" />
          <Row label="Search"     value={cnt.search_terms}          color={T.amber} />
          <Row label="S.URL"      value={cnt.search_normalized_url} color={T.cyan} />
          <Row label="Lang"       value={cnt.page_language} />
          <Row label="Password"   value={String(cnt.password_state || 0)} color={cnt.password_state > 0 ? T.red : T.t2} />
          <Row label="Entities"   value={cnt.entities}   color={T.t1} />
          <Row label="Categories" value={cnt.categories} color={T.t1} />
        </>}
      </div>
    )
  }

  if (type === "download") {
    const dl     = item
    const danger = dl.danger_type || "NOT_DANGEROUS"
    const safe   = danger === "NOT_DANGEROUS" || danger === "USER_VALIDATED"
    return (
      <div style={{ padding: "14px 16px" }}>
        <Row label="File"      value={dl.target_path?.split(/[\\\/]/).pop()} color={T.t0} />
        <Row label="Path"      value={dl.target_path}   color={T.t1} />
        <Row label="State"     value={dl.state}
             color={dl.state === "COMPLETE" ? T.green : dl.state === "INTERRUPTED" ? T.red : T.amber} />
        <Sep title="Risk" />
        <Row label="Danger"    value={danger} color={safe ? T.green : T.red} />
        <Row label="MIME"      value={dl.mime_type} />
        <Row label="Orig MIME" value={dl.original_mime_type} color={T.t1} />
        <Row label="Hash"      value={dl.file_hash_hex?.slice(0, 40)} color={T.t2} />
        <Sep title="Timing" />
        <Row label="Start"     value={tIST(dl.start_time)} />
        <Row label="End"       value={tIST(dl.end_time)} />
        <Row label="Size"      value={`${fmtBytes(dl.received_bytes)} / ${fmtBytes(dl.total_bytes)}`} />
        <Sep title="Attribution" />
        <Row label="Site URL"  value={dl.site_url}  color={T.cyan} />
        <Row label="Tab URL"   value={dl.tab_url}   color={T.cyan} />
        <Row label="Referrer"  value={dl.referrer}  color={T.cyan} />
        <Row label="Method"    value={dl.http_method} />
        <Row label="By Ext"    value={`${dl.by_extension_name || "—"} (${dl.by_extension_id || "—"})`} />
        <Row label="ETag"      value={dl.etag} color={T.t2} />
        {dl.url_chain?.length > 0 && <>
          <Sep title="URL Chain" />
          {dl.url_chain.map(c => <Row key={c.index} label={`[${c.index}]`} value={c.url} color={T.cyan} />)}
        </>}
      </div>
    )
  }

  return null
}

/* ═══════════════════════════════════════════════════════════
   SLIDE PANEL  — drawer from right
═══════════════════════════════════════════════════════════ */
function SlidePanel({ item, type, onClose }) {
  const open = !!item

  useEffect(() => {
    if (!open) return
    const handler = e => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, onClose])

  const typeLabel = type === "visit" ? "VISIT DETAIL" : "DOWNLOAD DETAIL"

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.45)",
          zIndex: 50,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.22s ease",
        }}
      />

      {/* Drawer */}
      <div style={{
        position: "fixed", right: 0, top: 0, bottom: 0,
        width: 360,
        background: T.panel,
        borderLeft: `1px solid ${T.border2}`,
        zIndex: 51,
        display: "flex", flexDirection: "column",
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.24s cubic-bezier(0.4, 0, 0.2, 1)",
        boxShadow: open ? "-12px 0 48px rgba(0,0,0,0.6)" : "none",
      }}>

        {/* Drawer header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", borderBottom: `1px solid ${T.border}`,
          flexShrink: 0, background: T.surf,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 2, height: 12, background: T.blue, borderRadius: 2 }} />
            <span style={{
              fontSize: 9, fontFamily: MONO, color: T.blue,
              fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.4
            }}>{typeLabel}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, fontFamily: MONO, color: T.t3 }}>ESC to close</span>
            <button
              onClick={onClose}
              title="Close panel"
              style={{
                background: T.card, border: `1px solid ${T.border}`,
                borderRadius: 5, cursor: "pointer", color: T.t1,
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 26, transition: "all .1s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = T.hover; e.currentTarget.style.color = T.t0 }}
              onMouseLeave={e => { e.currentTarget.style.background = T.card;  e.currentTarget.style.color = T.t1 }}
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflow: "auto" }}>
          <DetailPanelContent item={item} type={type} />
        </div>

        {/* Footer */}
        {item && (
          <div style={{
            padding: "6px 14px", borderTop: `1px solid ${T.border}`,
            fontSize: 9, fontFamily: MONO, color: T.t3, flexShrink: 0,
            display: "flex", alignItems: "center", gap: 6
          }}>
            <PanelRightClose size={9} />
            Click backdrop or press ESC to close
          </div>
        )}
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════════════════════
   PAGE: BROWSE TREE
═══════════════════════════════════════════════════════════ */
function PageTree({ byId, childrenMap, rootIds, filter }) {
  const [open, setOpen] = useState(new Set())
  const [sel,  setSel]  = useState(null)
  const [cols, setCols] = useState({ url: 440, time: 145, trans: 115, dur: 72, src: 70, tab: 45 })
  const rz = key => w => setCols(c => ({ ...c, [key]: w }))

  const flat = useMemo(() =>
    flattenTree(rootIds, childrenMap, byId, open, filter),
    [rootIds, childrenMap, byId, open, filter]
  )

  const toggle = useCallback(id => {
    setOpen(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }, [])

  const expandAll = () => {
    const s = new Set()
    Object.keys(childrenMap).forEach(k => s.add(Number(k)))
    setOpen(s)
  }
  const collapseAll = () => setOpen(new Set())
  const expandDepth = max => {
    const add = new Set()
    const dfs = (id, d) => {
      if (d >= max) return
      const kids = childrenMap[id] || []
      if (kids.length) { add.add(id); kids.forEach(k => dfs(k, d + 1)) }
    }
    rootIds.forEach(r => dfs(r, 0))
    setOpen(add)
  }

  const selVisit = byId[sel]

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6, padding: "8px 14px",
          background: T.panel, borderBottom: `1px solid ${T.border}`, flexShrink: 0
        }}>
          {[
            ["Expand All",   expandAll],
            ["Collapse All", collapseAll],
            ["Depth 1",      () => expandDepth(1)],
            ["Depth 2",      () => expandDepth(2)],
            ["Depth 3",      () => expandDepth(3)],
          ].map(([t, fn]) => (
            <button key={t} onClick={fn} style={{
              padding: "4px 10px", background: T.card,
              border: `1px solid ${T.border2}`, color: T.t0,
              fontSize: 10, fontFamily: MONO, borderRadius: 4, cursor: "pointer"
            }}>{t}</button>
          ))}
          <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: MONO, color: T.t2 }}>
            {flat.length.toLocaleString()} nodes
          </span>
        </div>

        {/* Legend */}
        <div style={{
          display: "flex", alignItems: "center", gap: 14, padding: "5px 14px",
          background: T.surf, borderBottom: `1px solid ${T.border}`, flexShrink: 0
        }}>
          {Object.entries({
            TYPED: TC.TYPED, LINK: TC.LINK, FORM: TC.FORM_SUBMIT,
            RELOAD: TC.RELOAD, KW: TC.KEYWORD, SYNC: T.purple
          }).map(([k, c]) => (
            <span key={k} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, fontFamily: MONO, color: c }}>
              <span style={{ width: 6, height: 6, borderRadius: 2, background: c, display: "inline-block" }} />
              {k}
            </span>
          ))}
        </div>

        {/* Tree list */}
        <div style={{ flex: 1, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                <TH width={cols.url}   onResize={rz("url")}>URL / Navigation Chain</TH>
                <TH width={cols.time}  onResize={rz("time")}>Time (IST)</TH>
                <TH width={cols.trans} onResize={rz("trans")}>Transition</TH>
                <TH width={cols.dur}   onResize={rz("dur")}>Duration</TH>
                <TH width={cols.src}   onResize={rz("src")}>Source</TH>
                <TH width={cols.tab}   onResize={rz("tab")}>Tab</TH>
                <TH>Title</TH>
              </tr>
            </thead>
            <tbody>
              {flat.map(({ id, depth, hasKids, open: isOpen }) => {
                const v   = byId[id]; if (!v) return null
                const tr  = v.transition || {}
                const ctx = v.context    || {}
                const isSel = sel === id
                const tc    = TC[tr.core_type]
                return (
                  <tr
                    key={id}
                    onClick={() => setSel(id)}
                    style={{ background: isSel ? T.sel : "transparent", cursor: "pointer" }}
                    onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = T.hover }}
                    onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = "transparent" }}
                  >
                    <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap", overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", paddingLeft: depth * 16, gap: 4 }}>
                        <span
  onClick={e => { e.stopPropagation(); toggle(id) }}
  style={{
    width: 18, height: 18, display: "flex", alignItems: "center",
    justifyContent: "center", cursor: hasKids ? "pointer" : "default",
    flexShrink: 0, borderRadius: 3,
    background: hasKids ? `${T.blue}14` : "transparent",
    border: hasKids ? `1px solid ${T.blue}28` : "1px solid transparent",
    transition: "background .12s, border-color .12s",
    color: isOpen ? T.blue : T.t1,
  }}
  onMouseEnter={e => { if (hasKids) e.currentTarget.style.background = `${T.blue}28` }}
  onMouseLeave={e => { if (hasKids) e.currentTarget.style.background = hasKids ? `${T.blue}14` : "transparent" }}
>
  {hasKids
    ? (isOpen
        ? <ChevronDown  size={13} strokeWidth={2.2} />
        : <ChevronRight size={13} strokeWidth={2.2} />)
    : <span style={{ width: 13 }} />
  }
</span>

                        <span style={{
                          fontSize: 11, fontFamily: MONO, color: tc || T.t0,
                          overflow: "hidden", textOverflow: "ellipsis", display: "block",
                          maxWidth: cols.url - depth * 16 - 30,
                        }}>
                          {v.url}
                        </span>
                      </div>
                    </td>
                    <TD color={T.t1}>{tIST(v.visit_time)}</TD>
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

      {/* Slide panel */}
      <SlidePanel item={selVisit} type="visit" onClose={() => setSel(null)} />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   PAGE: TIMELINE
═══════════════════════════════════════════════════════════ */
function PageTimeline({ data, byId, filter }) {
  const [sel,  setSel]  = useState(null)
  const [page, setPage] = useState(0)
  const [cols, setCols] = useState({ time: 148, domain: 160, title: 190, trans: 115, dur: 72, http: 46, tab: 46 })
  const rz = key => w => setCols(c => ({ ...c, [key]: w }))
  const PER = 200

  const visits = useMemo(() => {
    const ft = filter.toLowerCase()
    return (data.visits || [])
      .filter(v => !ft || (v.url || "").toLowerCase().includes(ft) || (v.title || "").toLowerCase().includes(ft))
      .sort((a, b) => (b.visit_time?.unix_ms || 0) - (a.visit_time?.unix_ms || 0))
  }, [data.visits, filter])

  const { sorted, col, asc, toggle } = useSort(visits, null)
  const page_data = sorted.slice(page * PER, (page + 1) * PER)
  const pages     = Math.ceil(sorted.length / PER)
  const selVisit  = byId[sel]

  const hdr = (label, field, colKey) => (
    <TH
      key={label}
      width={cols[colKey]}
      onResize={rz(colKey)}
      onClick={() => toggle(field)}
      sorted={col === field ? (asc ? "asc" : "desc") : undefined}
    >
      {label}
    </TH>
  )

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 14px",
          background: T.panel, borderBottom: `1px solid ${T.border}`, flexShrink: 0
        }}>
          <span style={{ fontSize: 10, fontFamily: MONO, color: T.t2 }}>
            {sorted.length.toLocaleString()} visits
          </span>
          <span style={{ fontSize: 10, fontFamily: MONO, color: T.t3 }}>·</span>
          <span style={{ fontSize: 10, fontFamily: MONO, color: T.t2 }}>
            Page {page + 1} / {pages}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{
                padding: "3px 9px", background: T.card, border: `1px solid ${T.border2}`,
                color: page === 0 ? T.t3 : T.t0, fontSize: 10, fontFamily: MONO,
                borderRadius: 3, cursor: page === 0 ? "not-allowed" : "pointer"
              }}>←</button>
            <button
              onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              style={{
                padding: "3px 9px", background: T.card, border: `1px solid ${T.border2}`,
                color: page >= pages - 1 ? T.t3 : T.t0, fontSize: 10, fontFamily: MONO,
                borderRadius: 3, cursor: page >= pages - 1 ? "not-allowed" : "pointer"
              }}>→</button>
          </div>
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                {hdr("Time (IST)", "visit_time", "time")}
                {hdr("Domain",     "url",         "domain")}
                {hdr("Title",      "title",        "title")}
                <TH width={cols.trans} onResize={rz("trans")}>Transition</TH>
                <TH width={cols.dur}   onResize={rz("dur")}>Duration</TH>
                <TH width={cols.http}  onResize={rz("http")}>HTTP</TH>
                <TH width={cols.tab}   onResize={rz("tab")}>Tab</TH>
                <TH>Referrer</TH>
              </tr>
            </thead>
            <tbody>
              {page_data.map((v, i) => {
                const tr   = v.transition || {}
                const ctx  = v.context    || {}
                const isSel = sel === v.visit_id
                const tc   = TC[tr.core_type]
                const http = String(ctx.http_response_code || "")
                const hc   = http.startsWith("4") || http.startsWith("5") ? T.red
                           : http === "200" ? T.green : T.t1
                return (
                  <tr
                    key={v.visit_id}
                    onClick={() => setSel(v.visit_id)}
                    style={{ background: isSel ? T.sel : i % 2 === 0 ? "transparent" : T.surf, cursor: "pointer" }}
                    onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = T.hover }}
                    onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = i % 2 === 0 ? "transparent" : T.surf }}
                  >
                    <TD color={T.t1}>{tIST(v.visit_time)}</TD>
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

      {/* Slide panel */}
      <SlidePanel item={selVisit} type="visit" onClose={() => setSel(null)} />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   PAGE: DOWNLOADS  (no Danger column)
═══════════════════════════════════════════════════════════ */
function PageDownloads({ data, filter }) {
  const [sel,  setSel]  = useState(null)
  const [cols, setCols] = useState({ time: 145, file: 220, size: 76, state: 95, mime: 140, domain: 180 })
  const rz = key => w => setCols(c => ({ ...c, [key]: w }))

  const dls = useMemo(() => {
    const ft = filter.toLowerCase()
    return (data.downloads || [])
      .filter(d => {
        const nm = d.target_path?.split(/[\\\/]/).pop() || ""
        return !ft || nm.toLowerCase().includes(ft) || (d.site_url || "").toLowerCase().includes(ft)
      })
      .sort((a, b) => (b.start_time?.unix_ms || 0) - (a.start_time?.unix_ms || 0))
  }, [data.downloads, filter])

  const selDl = sel != null ? dls.find(d => d.download_id === sel) : null

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Toolbar */}
        <div style={{
          padding: "7px 14px", background: T.panel,
          borderBottom: `1px solid ${T.border}`, flexShrink: 0,
          fontSize: 10, fontFamily: MONO, color: T.t2,
          display: "flex", alignItems: "center", gap: 10
        }}>
          <span>{dls.length} downloads</span>
          {dls.some(d => !["NOT_DANGEROUS", "USER_VALIDATED"].includes(d.danger_type)) && (
            <span style={{ color: T.red, display: "flex", alignItems: "center", gap: 4 }}>
              <AlertTriangle size={10} />
              {dls.filter(d => !["NOT_DANGEROUS", "USER_VALIDATED"].includes(d.danger_type)).length} flagged
            </span>
          )}
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                <TH width={cols.time}   onResize={rz("time")}>Start Time</TH>
                <TH width={cols.file}   onResize={rz("file")}>Filename</TH>
                <TH width={cols.size}   onResize={rz("size")}>Size</TH>
                <TH width={cols.state}  onResize={rz("state")}>State</TH>
                <TH width={cols.mime}   onResize={rz("mime")}>MIME</TH>
                <TH width={cols.domain} onResize={rz("domain")}>Domain</TH>
                <TH>Referrer</TH>
              </tr>
            </thead>
            <tbody>
              {dls.map((dl, i) => {
                const isSel = sel === dl.download_id
                const sc    = dl.state === "COMPLETE" ? T.green
                            : dl.state === "INTERRUPTED" ? T.red : T.amber
                const fname = dl.target_path?.split(/[\\\/]/).pop() || "—"
                return (
                  <tr
                    key={dl.download_id}
                    onClick={() => setSel(dl.download_id)}
                    style={{ background: isSel ? T.sel : i % 2 === 0 ? "transparent" : T.surf, cursor: "pointer" }}
                    onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = T.hover }}
                    onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = i % 2 === 0 ? "transparent" : T.surf }}
                  >
                    <TD color={T.t1}>{tIST(dl.start_time)}</TD>
                    <TD color={T.t0}>{fname}</TD>
                    <TD color={T.t1}>{fmtBytes(dl.total_bytes || dl.received_bytes)}</TD>
                    <TD color={sc}>{dl.state}</TD>
                    <TD color={T.t1}>{dl.mime_type}</TD>
                    <TD color={T.t1}>{dom(dl.site_url || "")}</TD>
                    <TD color={T.t2} truncate>{dl.referrer}</TD>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Slide panel */}
      <SlidePanel item={selDl} type="download" onClose={() => setSel(null)} />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   TIME FILTER PICKER
═══════════════════════════════════════════════════════════ */
const PRESETS = [
  { label: "6h",  sublabel: "6 hours",   hours: 6   },
  { label: "24h", sublabel: "1 day",     hours: 24  },
  { label: "48h", sublabel: "2 days",    hours: 48  },
  { label: "7d",  sublabel: "1 week",    hours: 168 },
  { label: "30d", sublabel: "1 month",   hours: 720 },
  { label: "All", sublabel: "No filter", hours: null },
]

function TimeFilterPicker({ days, setDays, hoursExtra, setHoursExtra, allTime, setAllTime }) {

  const applyPreset = (hours) => {
    if (hours === null) { setAllTime(true); return }
    setAllTime(false)
    setDays(Math.floor(hours / 24))
    setHoursExtra(hours % 24)
  }

  const inputStyle = {
    width: 64, padding: "7px 10px",
    background: T.bg,
    border: `1px solid ${allTime ? T.border : T.border2}`,
    borderRadius: 6, color: allTime ? T.t3 : T.t0,
    fontSize: 14, fontFamily: MONO,
    textAlign: "center", outline: "none",
    transition: "border-color .15s, color .15s",
  }

  return (
    <div style={{ width: "100%" }}>

      {/* Section header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 7,
        marginBottom: 12,
      }}>
        <Clock size={11} color={T.blue} />
        <span style={{
          fontSize: 10, fontFamily: MONO, color: T.blue,
          textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700
        }}>Data Time Filter</span>
      </div>

      {/* Preset chips */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {PRESETS.map(p => {
          const isActive = p.hours === null
            ? allTime
            : !allTime && (days * 24 + hoursExtra) === p.hours
          return (
            <button key={p.label} onClick={() => applyPreset(p.hours)} style={{
              padding: "5px 14px",
              fontSize: 11, fontFamily: MONO,
              background: isActive ? T.blue : T.surf,
              border: `1px solid ${isActive ? T.blue : T.border2}`,
              color: isActive ? "#fff" : T.t1,
              borderRadius: 20, cursor: "pointer",
              transition: "all .12s",
              fontWeight: isActive ? 700 : 400,
            }}
            onMouseEnter={e => { if (!isActive) { e.currentTarget.style.borderColor = T.blue; e.currentTarget.style.color = T.t0 } }}
            onMouseLeave={e => { if (!isActive) { e.currentTarget.style.borderColor = T.border2; e.currentTarget.style.color = T.t1 } }}
            >{p.label}</button>
          )
        })}
      </div>

      {/* Manual inputs row */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 14px",
        background: T.surf,
        border: `1px solid ${allTime ? T.border : T.border2}`,
        borderRadius: 8,
        opacity: allTime ? 0.45 : 1,
        transition: "opacity .15s, border-color .15s",
      }}>
        <span style={{ fontSize: 12, fontFamily: MONO, color: T.t1, whiteSpace: "nowrap" }}>Last</span>

        <input
          type="number" min={0} max={3650} value={days}
          onChange={e => { setAllTime(false); setDays(Math.max(0, parseInt(e.target.value) || 0)) }}
          style={inputStyle}
        />
        <span style={{ fontSize: 12, fontFamily: MONO, color: T.t1 }}>days</span>

        <input
          type="number" min={0} max={23} value={hoursExtra}
          onChange={e => { setAllTime(false); setHoursExtra(Math.min(23, Math.max(0, parseInt(e.target.value) || 0))) }}
          style={inputStyle}
        />
        <span style={{ fontSize: 12, fontFamily: MONO, color: T.t1 }}>hours</span>

        {/* Divider */}
        <div style={{ width: 1, height: 22, background: T.border, marginLeft: 4 }} />

        {/* All-time toggle */}
        <div
          onClick={() => setAllTime(a => !a)}
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}
        >
          <div style={{
            width: 34, height: 18, borderRadius: 9,
            background: allTime ? T.blue : T.border2,
            position: "relative", transition: "background .15s", flexShrink: 0,
          }}>
            <div style={{
              width: 14, height: 14, borderRadius: 7, background: "#fff",
              position: "absolute", top: 2,
              left: allTime ? 17 : 2,
              transition: "left .15s",
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
            }} />
          </div>
          <span style={{
            fontSize: 12, fontFamily: MONO,
            color: allTime ? T.blue : T.t2,
            transition: "color .15s",
          }}>All time</span>
        </div>
      </div>

      {/* Summary */}
      <div style={{
        marginTop: 8, fontSize: 10, fontFamily: MONO,
        color: allTime ? T.teal : T.t2,
        display: "flex", alignItems: "center", gap: 5,
        transition: "color .15s",
      }}>
        <span style={{
          display: "inline-block", width: 5, height: 5, borderRadius: "50%",
          background: allTime ? T.teal : T.blue, flexShrink: 0
        }} />
        {allTime
          ? "No filter — full history will be loaded"
          : `Fetching last ${days > 0 ? `${days}d ` : ""}${hoursExtra > 0 ? `${hoursExtra}h` : days === 0 ? "0h" : ""}`.trim()
            + ` (${days * 24 + hoursExtra}h total)`
        }
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

  const totalHours = allTime ? null : (days * 24 + hoursExtra)

  const upload = async (file) => {
    setLoading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append("file",    file)
      form.append("browser", "Unknown")
      form.append("profile", "Default")
      if (totalHours !== null) form.append("hours", String(totalHours))

      const res  = await fetch(`${API_BASE}/api/parse`, { method: "POST", body: form })
      const json = await res.json()

      if (!res.ok)       throw new Error(json.error || `Server error: ${res.status}`)
      if (!json.visits)  throw new Error("Missing visits field. Is this a valid Chromium History file?")

      onLoad(json)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleFile = file => { if (file) upload(file) }

  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center",
      justifyContent: "center", background: T.bg,
      flexDirection: "column", gap: 16
    }}>

      <div
        onDragOver={e  => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e  => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]) }}
        onClick={() => !loading && ref.current.click()}
        style={{
          width: 580, padding: "36px 44px 32px",
          background: drag ? T.hover : T.card,
          border: `2px dashed ${drag ? T.blue : error ? T.red : T.border2}`,
          borderRadius: 14,
          display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
          cursor: loading ? "wait" : "pointer",
          transition: "all .15s",
          boxShadow: drag ? `0 0 0 4px ${T.blue}18` : "none",
          opacity: loading ? .75 : 1,
        }}
      >
        {/* Icon */}
        <div style={{
          width: 52, height: 52, borderRadius: 12, background: T.panel,
          border: `1px solid ${loading ? T.blue : T.border2}`,
          display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          {loading
            ? <Loader size={22} color={T.blue} strokeWidth={1.5} style={{ animation: "spin 1s linear infinite" }} />
            : <Upload size={22} color={T.blue} strokeWidth={1.5} />
          }
        </div>

        {/* Text */}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 15, fontFamily: MONO, fontWeight: 700, color: T.t0, marginBottom: 6 }}>
            {loading ? "Parsing History file…" : "Drop Chromium History File"}
          </div>
          {!loading && (
            <div style={{ fontSize: 11, fontFamily: MONO, color: T.t2, lineHeight: 1.7 }}>
              Drop the raw{" "}
              <code style={{ color: T.blue, background: `${T.blue}15`, padding: "1px 5px", borderRadius: 3 }}>History</code>
              {" "}SQLite file here or{" "}
              <span style={{ color: T.blue }}>click to browse</span>
              <br />
              <span style={{ color: T.t3, fontSize: 10 }}>
                %LOCALAPPDATA%\...\User Data\Default\History
              </span>
            </div>
          )}
          {loading && (
            <div style={{ fontSize: 11, fontFamily: MONO, color: T.t2, lineHeight: 1.7 }}>
              Sending to backend parser…
              {totalHours !== null && (
                <><br /><span style={{ color: T.t3, fontSize: 10 }}>Filtering last {totalHours}h of data</span></>
              )}
            </div>
          )}
        </div>

        {/* Divider */}
        {!loading && (
          <div style={{ width: "100%", height: 1, background: T.border, margin: "2px 0" }} />
        )}

        {/* Time filter (stop click-through to file picker) */}
        {!loading && (
          <div style={{ width: "100%" }} onClick={e => e.stopPropagation()}>
            <TimeFilterPicker
              days={days}             setDays={setDays}
              hoursExtra={hoursExtra} setHoursExtra={setHoursExtra}
              allTime={allTime}       setAllTime={setAllTime}
            />
          </div>
        )}

        {/* Browser badge */}
        {!loading && (
          <div style={{
            fontSize: 10, fontFamily: MONO, color: T.t3,
            padding: "4px 12px", background: T.panel,
            borderRadius: 20, border: `1px solid ${T.border}`
          }}>
            Edge · Chrome · Brave · Vivaldi · Opera · Chromium
          </div>
        )}
      </div>

      {/* Error box */}
      {error && (
        <div style={{
          width: 580, padding: "12px 16px",
          background: `${T.red}12`, border: `1px solid ${T.red}40`,
          borderRadius: 8, display: "flex", alignItems: "flex-start", gap: 10
        }}>
          <AlertTriangle size={14} color={T.red} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 11, fontFamily: MONO, color: T.red, fontWeight: 700, marginBottom: 4 }}>
              Parse Failed
            </div>
            <div style={{ fontSize: 11, fontFamily: MONO, color: T.t1, wordBreak: "break-word" }}>
              {error}
            </div>
            <button
              onClick={() => setError(null)}
              style={{ marginTop: 8, fontSize: 10, fontFamily: MONO, color: T.blue, background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.4 }
        input[type=number] { -moz-appearance: textfield }
      `}</style>

      <input
        ref={ref}
        type="file"
        style={{ display: "none" }}
        onChange={e => handleFile(e.target.files[0])}
      />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   PAGES REGISTRY
═══════════════════════════════════════════════════════════ */
const PAGES = [
  { key: "tree",      icon: Network,  label: "Browse Tree" },
  { key: "timeline",  icon: Clock,    label: "Timeline"    },
  { key: "downloads", icon: Download, label: "Downloads"   },
]

/* ═══════════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════════ */
export default function App() {
  const [data,   setData]   = useState(null)
  const [page,   setPage]   = useState("tree")
  const [filter, setFilter] = useState("")

  const byId = useMemo(() =>
    data ? Object.fromEntries((data.visits || []).map(v => [v.visit_id, v])) : {}
  , [data])

  const childrenMap = useMemo(() =>
    data
      ? Object.fromEntries(
          Object.entries(data.children_map || {}).map(([k, v]) => [Number(k), v])
        )
      : {}
  , [data])

  const rootIds = useMemo(() => data?.root_visit_ids || [], [data])
  const stats   = data?.stats || {}
  const meta    = data?.extraction_meta || {}

  /* ── Landing ─────────────────────────────────────────── */
  if (!data) return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: T.bg, fontFamily: MONO }}>
      <div style={{
        padding: "14px 20px", background: T.panel,
        borderBottom: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", gap: 10
      }}>
        <Shield size={16} color={T.blue} strokeWidth={1.5} />
        <span style={{ fontSize: 13, fontFamily: MONO, fontWeight: 700, color: T.t0 }}>
          SecOps
        </span>
        <span style={{ fontSize: 9, color: T.blue, fontFamily: MONO }}>SOC · v2.1</span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: T.t3, fontFamily: MONO }}>
          Backend: <span style={{ color: T.t2 }}>{API_BASE}</span>
        </span>
      </div>
      <DropZone onLoad={setData} />
    </div>
  )

  /* ── Dashboard ───────────────────────────────────────── */
  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: T.bg, fontFamily: MONO, overflow: "hidden"
    }}>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", flexShrink: 0,
        background: T.panel, borderBottom: `1px solid ${T.border}`, height: 48
      }}>

        {/* Logo */}
        <div style={{
          padding: "0 20px", display: "flex", alignItems: "center",
          gap: 8, borderRight: `1px solid ${T.border}`, height: "100%"
        }}>
          <Shield size={15} color={T.blue} strokeWidth={1.5} />
          <span style={{ fontSize: 12, fontWeight: 700, color: T.t0 }}>SecOps</span>
          <span style={{ fontSize: 9, color: T.blue }}>SOC</span>
        </div>

        {/* New File */}
        <button
          onClick={() => { setData(null); setFilter(""); setPage("tree") }}
          style={{
            margin: "0 8px 0 12px", padding: "4px 10px",
            background: T.card, border: `1px solid ${T.border2}`,
            color: T.t1, fontSize: 10, fontFamily: MONO,
            borderRadius: 4, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 5
          }}
        >
          <RefreshCw size={10} /> New File
        </button>

        <div style={{ width: 1, height: 24, background: T.border }} />

        {/* Filter */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 12px", flex: 1 }}>
          <Search size={12} color={T.t2} />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter by URL or title…"
            style={{
              background: "transparent", border: "none", outline: "none",
              color: T.t0, fontSize: 11, fontFamily: MONO,
              width: 320, caretColor: T.blue
            }}
          />
          {filter && (
            <button
              onClick={() => setFilter("")}
              style={{ background: "none", border: "none", cursor: "pointer", color: T.t2, padding: 0, display: "flex" }}
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Live stats */}
        <div style={{
          padding: "0 16px", borderLeft: `1px solid ${T.border}`,
          fontSize: 10, color: T.t2, height: "100%",
          display: "flex", alignItems: "center", gap: 8, flexShrink: 0
        }}>
          <span style={{ color: T.green }}>{(stats.total_visits || 0).toLocaleString()}</span>
          <span style={{ color: T.t3 }}>visits</span>
          <span style={{ color: T.t3 }}>·</span>
          <span style={{ color: T.cyan }}>{(stats.total_url_records || 0).toLocaleString()}</span>
          <span style={{ color: T.t3 }}>urls</span>
          <span style={{ color: T.t3 }}>·</span>
          <span style={{ color: T.amber }}>{stats.total_downloads || 0}</span>
          <span style={{ color: T.t3 }}>dl</span>
          {stats.hours_filter && (
            <>
              <span style={{ color: T.t3 }}>·</span>
              <span style={{ color: T.teal }}>last {stats.hours_filter}h</span>
            </>
          )}
          {stats.dangerous_downloads > 0 && (
            <>
              <span style={{ color: T.t3 }}>·</span>
              <span style={{ color: T.red, display: "flex", alignItems: "center", gap: 3 }}>
                <AlertTriangle size={10} />{stats.dangerous_downloads} danger
              </span>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Sidebar */}
        <div style={{
          width: 168, background: T.panel,
          borderRight: `1px solid ${T.border}`,
          flexShrink: 0, display: "flex", flexDirection: "column"
        }}>
          <div style={{ height: 10 }} />

          {PAGES.map(({ key, icon: Icon, label }) => {
            const active = page === key
            return (
              <button
                key={key}
                onClick={() => setPage(key)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 14px", background: "transparent", border: "none",
                  borderLeft: `2px solid ${active ? T.blue : "transparent"}`,
                  color: active ? T.t0 : T.t2, cursor: "pointer",
                  fontSize: 11, fontFamily: MONO, textAlign: "left",
                  transition: "all .1s",
                  backgroundColor: active ? T.hover : "transparent"
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.backgroundColor = T.card }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.backgroundColor = "transparent" }}
              >
                <Icon size={13} strokeWidth={active ? 2 : 1.5} color={active ? T.blue : T.t2} />
                {label}
              </button>
            )
          })}

          {/* Sidebar stats */}
          <div style={{ marginTop: "auto", padding: "12px 14px", borderTop: `1px solid ${T.border}` }}>
            {[
              ["Browser",  meta.browser  || "—"],
              ["Profile",  meta.profile  || "—"],
              ["Filter",   stats.hours_filter ? `last ${stats.hours_filter}h` : "all time"],
              ["Visits",   (stats.total_visits || 0).toLocaleString()],
              ["URLs",     (stats.total_url_records || 0).toLocaleString()],
              ["DLs",      stats.total_downloads || 0],
              ["Synced",   stats.synced_visits || 0],
              ["Sessions", stats.total_root_sessions || 0],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 9, color: T.t3, fontFamily: MONO }}>{k}</span>
                <span style={{
                  fontSize: 9, color: T.t1, fontFamily: MONO,
                  maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Page content */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {page === "tree"      && (
            <PageTree
              byId={byId}
              childrenMap={childrenMap}
              rootIds={rootIds}
              filter={filter}
            />
          )}
          {page === "timeline"  && (
            <PageTimeline
              data={data}
              byId={byId}
              filter={filter}
            />
          )}
          {page === "downloads" && (
            <PageDownloads
              data={data}
              filter={filter}
            />
          )}
        </div>
      </div>

      {/* Status bar */}
      <div style={{
        height: 22, background: T.panel, borderTop: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", padding: "0 14px",
        flexShrink: 0, gap: 16
      }}>
        <span style={{ fontSize: 9, fontFamily: MONO, color: T.t3 }}>
          Parsed: {(meta.extracted_at_ist || "").slice(0, 19)}
        </span>
        <span style={{ fontSize: 9, fontFamily: MONO, color: T.t3 }}>·</span>
        <span style={{ fontSize: 9, fontFamily: MONO, color: T.t3 }}>
          SHA256: {(meta.source_sha256 || "").slice(0, 24)}{meta.source_sha256 ? "…" : ""}
        </span>
        <span style={{ fontSize: 9, fontFamily: MONO, color: T.t3 }}>·</span>
        <span style={{ fontSize: 9, fontFamily: MONO, color: T.t3 }}>
          DB v{meta.db_meta?.version || "?"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 9, fontFamily: MONO, color: T.t3 }}>
          SecOps SOC · v2.1 · {API_BASE}
        </span>
      </div>
    </div>
  )
}
