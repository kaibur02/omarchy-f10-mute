.pragma library
// F10 Mute (Omarchy plugin io.github.kaibur02.omarchy-f10-mute) — pure logic, no QML types.
// Unit-tested by tests/logic.test.mjs.
//
// Data sources (gathered by Service.qml in one `sh -c` round trip):
//   window     `hyprctl -j activewindow`      (or `clients` when targeting an address)
//   monitors   `hyprctl -j monitors`
//   sinks      `pactl -f json list sink-inputs` (one entry per app playback stream)
//   clients    `pactl -f json list clients`     (owning process of each stream)
//   ps         `LC_ALL=C ps -eo pid=,ppid=,lstart=` (process tree + start times)
//
// Why clients: native PipeWire streams (pw-play, mpv, SDL games…) do not carry
// application.process.id on the stream itself, only on the client. For
// PulseAudio-API clients `pipewire.sec.pid` is the pipewire-pulse server's pid,
// so it is never used here; `application.process.id` is.

var MARK = "@@F10MUTE@@"

var CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right", "center"]

var DEFAULT_CONFIG = {
  corner: "top-right",
  margin: 24,
  size: 64,
  opacity: 0.7,
  holdMs: 1000,
  fadeMs: 400
}

// Nerd Font glyphs (JetBrainsMono Nerd Font, Omarchy's default font).
var GLYPH_ENABLED = String.fromCodePoint(0xF057E) // nf-md-volume_high
var GLYPH_MUTED = String.fromCodePoint(0xF075F)   // nf-md-volume_mute (speaker with slash)

function clampNum(v, lo, hi, dflt) {
  var n = Number(v)
  if (!isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

function normalizeConfig(raw) {
  raw = raw || {}
  var corner = String(raw.corner || DEFAULT_CONFIG.corner).toLowerCase().trim().replace(/[_ ]/g, "-")
  if (CORNERS.indexOf(corner) < 0) corner = DEFAULT_CONFIG.corner
  return {
    corner: corner,
    margin: Math.round(clampNum(raw.margin, 0, 500, DEFAULT_CONFIG.margin)),
    size: Math.round(clampNum(raw.size, 16, 512, DEFAULT_CONFIG.size)),
    opacity: clampNum(raw.opacity, 0.05, 1, DEFAULT_CONFIG.opacity),
    holdMs: Math.round(clampNum(raw.holdMs, 0, 10000, DEFAULT_CONFIG.holdMs)),
    fadeMs: Math.round(clampNum(raw.fadeMs, 0, 10000, DEFAULT_CONFIG.fadeMs))
  }
}

// Split the combined command output into named sections:
//   "@@F10MUTE@@ name\n<payload>\n@@F10MUTE@@ other\n..."
function splitSections(text) {
  var out = {}
  var cur = null
  var buf = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.indexOf(MARK) === 0) {
      if (cur !== null) out[cur] = buf.join("\n")
      cur = line.slice(MARK.length).trim()
      buf = []
    } else if (cur !== null) {
      buf.push(line)
    }
  }
  if (cur !== null) out[cur] = buf.join("\n")
  return out
}

function parseJson(text, fallback) {
  try {
    var t = String(text || "").trim()
    return t ? JSON.parse(t) : fallback
  } catch (e) {
    return fallback
  }
}

// `LC_ALL=C ps -eo pid=,ppid=,lstart=` ->
//   { ppid: { "1": 0, ... }, start: { "1": "Mon Nov 10 09:00:01 2026", ... } }
// The start time makes a saved pid safe to trust after a restart: a recycled
// pid (e.g. after a reboot) belongs to a process with a different start time.
function parseProcs(text) {
  var ppid = {}
  var start = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].trim().match(/^(\d+)\s+(\d+)(?:\s+(.+))?$/)
    if (!m) continue
    ppid[m[1]] = Number(m[2])
    if (m[3]) start[m[1]] = m[3].replace(/\s+/g, " ").trim()
  }
  return { ppid: ppid, start: start }
}

function parsePs(text) {
  return parseProcs(text).ppid
}

// Split tracked apps into those still alive (same pid AND same start time)
// and those that exited or whose pid was recycled.
function pruneTracked(tracked, procs) {
  var kept = {}
  var dropped = []
  for (var key in tracked) {
    var e = tracked[key]
    var alive = procs.ppid[key] !== undefined
    if (alive && e.start && procs.start[key] && procs.start[key] !== e.start) alive = false
    if (alive) kept[key] = e
    else dropped.push(e)
  }
  return { kept: kept, dropped: dropped }
}

// ------------------------------------------------------------- state file
// The state file is re-read after any restart or crash, so it is validated
// like any other untrusted input.
function cleanString(v, max) {
  return typeof v === "string" && v.length <= max ? v : ""
}

function parseState(text) {
  var raw = parseJson(text, {})
  var state = { muted: {}, ownKeys: {} }
  if (!raw || typeof raw !== "object") return state
  var m = raw.muted && typeof raw.muted === "object" ? raw.muted : {}
  var count = 0
  for (var key in m) {
    if (++count > 256) break
    var e = m[key]
    var pid = Number(key)
    if (!e || typeof e !== "object" || !(pid > 1) || String(pid) !== key || Number(e.pid) !== pid) continue
    var names = Array.isArray(e.names) ? e.names.filter(function (n) { return cleanString(n, 128) }).slice(0, 16) : []
    state.muted[key] = {
      pid: pid, names: names, byName: e.byName === true,
      label: cleanString(e.label, 128) || "?", start: cleanString(e.start, 64)
    }
  }
  var keys = Array.isArray(raw.ownKeys) ? raw.ownKeys.slice(0, 256) : []
  for (var i = 0; i < keys.length; i++) {
    var k = cleanString(keys[i], 256)
    if (k) state.ownKeys[k] = true
  }
  return state
}

function serializeState(muted, ownKeys) {
  return JSON.stringify({ version: 2, muted: muted, ownKeys: Object.keys(ownKeys) }, null, 2) + "\n"
}

function isDescendantOrSelf(pid, rootPid, ppid) {
  pid = Number(pid); rootPid = Number(rootPid)
  if (!(pid > 0) || !(rootPid > 1)) return false
  for (var hops = 0; hops < 128 && pid > 1; hops++) {
    if (pid === rootPid) return true
    var parent = ppid[String(pid)]
    if (parent === undefined) return false
    pid = parent
  }
  return false
}

function lastSegment(s) {
  var parts = String(s).split(".")
  return parts[parts.length - 1]
}

function addToken(set, s) {
  if (s === undefined || s === null) return
  var t = String(s).toLowerCase().trim()
  if (!t) return
  set[t] = true
  // Reverse-DNS ids (com.spotify.Client, org.mozilla.firefox) also match by
  // their last segment. Not for things like "Minecraft* 1.20.1".
  if (/^[a-z][\w-]*(\.[a-z][\w-]*)+$/.test(t)) {
    var last = lastSegment(t)
    if (last.length >= 3) set[last] = true
  }
}

function windowNameTokens(win) {
  var set = {}
  addToken(set, win["class"])
  addToken(set, win.initialClass)
  return Object.keys(set)
}

// Join sink-inputs with their clients into a flat stream list.
function buildStreams(sinkInputs, clients) {
  var byIndex = {}
  for (var i = 0; i < (clients || []).length; i++) byIndex[String(clients[i].index)] = clients[i]
  var streams = []
  for (var j = 0; j < (sinkInputs || []).length; j++) {
    var s = sinkInputs[j]
    var sp = s.properties || {}
    var client = byIndex[String(s.client)] || {}
    var cp = client.properties || {}
    var pid = Number(sp["application.process.id"] || cp["application.process.id"] || 0)
    var appId = sp["pipewire.access.portal.app_id"] || cp["pipewire.access.portal.app_id"] || ""
    var names = {}
    addToken(names, sp["application.process.binary"] || cp["application.process.binary"])
    addToken(names, sp["application.name"] || cp["application.name"])
    addToken(names, sp["application.id"] || cp["application.id"])
    addToken(names, appId)
    // WirePlumber's restore-stream remembers volume/mute per application.id
    // (if set) else per application.name, so mutes "leak" to any app sharing it.
    var appIdProp = sp["application.id"] || cp["application.id"]
    var appName = sp["application.name"] || cp["application.name"]
    var restoreKey = appIdProp ? "id:" + appIdProp : (appName ? "name:" + appName : "")
    streams.push({
      index: Number(s.index),
      mute: s.mute === true,
      restoreKey: restoreKey,
      pid: pid,
      sandboxed: !!appId || cp["pipewire.access"] === "flatpak",
      names: Object.keys(names),
      label: String(sp["application.name"] || cp["application.name"] || sp["media.name"] || "?")
    })
  }
  return streams
}

function namesIntersect(a, b) {
  for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) return true
  return false
}

// target = { pid, names, byName }
// A stream belongs to the target when its owning process is the window's
// process or any descendant of it (browsers' audio services, Electron helpers,
// games launched from a terminal…). Name matching is a fallback for sandboxed
// (Flatpak) clients whose pid is from another pid namespace, or when the target
// was explicitly matched by name because the pid tree found nothing.
function streamMatches(stream, target, ppid) {
  if (!stream.sandboxed && stream.pid > 0 && isDescendantOrSelf(stream.pid, target.pid, ppid)) return true
  if ((stream.sandboxed || target.byName) && namesIntersect(stream.names, target.names)) return true
  return false
}

function matchStreams(streams, target, ppid) {
  return streams.filter(function (s) { return streamMatches(s, target, ppid) })
}

// Resolve the streams for a freshly focused window. Tries the pid tree first;
// falls back to name matching only if that finds nothing.
function resolveTarget(win, streams, ppid) {
  var target = { pid: Number(win.pid), names: windowNameTokens(win), byName: false }
  var matched = matchStreams(streams, target, ppid)
  if (matched.length === 0) {
    var byName = { pid: target.pid, names: target.names, byName: true }
    var m2 = matchStreams(streams, byName, ppid)
    if (m2.length > 0) { target = byName; matched = m2 }
  }
  return { target: target, matched: matched }
}

// Toggle decision: muted by us -> unmute. Otherwise, if the app has streams and
// all of them are already muted (e.g. WirePlumber restored a saved mute, or the
// user muted it in a mixer) -> unmute. Otherwise -> mute (also pre-mutes apps
// with no stream yet: their streams are muted as they appear).
function decideMuted(trackedMuted, matched) {
  if (trackedMuted) return false
  if (matched.length > 0 && matched.every(function (s) { return s.mute })) return false
  return true
}

// Work out what to do with the current streams while apps are muted.
//   tracked:  { key: target } apps muted by f10mute
//   ownKeys:  { restoreKey: true } WirePlumber restore keys f10mute has muted
// Returns [{ index, mute, reason, restoreKey }]:
//   * unmuted stream of a tracked app            -> mute it
//   * muted stream of an untracked app whose restore key we muted
//     (WirePlumber restored our mute onto it)    -> unmute it
function planEnforce(streams, tracked, ppid, ownKeys) {
  var actions = []
  for (var i = 0; i < streams.length; i++) {
    var s = streams[i]
    var owner = null
    for (var key in tracked) {
      if (streamMatches(s, tracked[key], ppid)) { owner = key; break }
    }
    if (owner !== null && !s.mute) {
      actions.push({ index: s.index, mute: true, reason: "tracked:" + owner, restoreKey: s.restoreKey, label: s.label })
    } else if (owner === null && s.mute && s.restoreKey && ownKeys[s.restoreKey]) {
      actions.push({ index: s.index, mute: false, reason: "restored-leak", restoreKey: s.restoreKey, label: s.label })
    }
  }
  return actions
}

function monitorLogical(mon) {
  var scale = Number(mon.scale) > 0 ? Number(mon.scale) : 1
  var w = Number(mon.width) / scale
  var h = Number(mon.height) / scale
  if (Number(mon.transform) % 2 === 1) { var t = w; w = h; h = t }
  return { name: mon.name, x: Number(mon.x), y: Number(mon.y), width: w, height: h }
}

function findMonitor(monitors, id) {
  for (var i = 0; i < (monitors || []).length; i++) if (monitors[i].id === id) return monitors[i]
  return null
}

// Overlay placement in monitor-local logical pixels, inside the visible part of
// the window (scrolling layouts can push windows partly off-screen).
function overlayRect(win, mon, cfg) {
  var m = monitorLogical(mon)
  var wx = Number(win.at[0]) - m.x, wy = Number(win.at[1]) - m.y
  var ww = Number(win.size[0]), wh = Number(win.size[1])
  var left = Math.max(0, wx), top = Math.max(0, wy)
  var right = Math.min(m.width, wx + ww), bottom = Math.min(m.height, wy + wh)
  if (right - left < 1 || bottom - top < 1) { left = 0; top = 0; right = m.width; bottom = m.height }
  var s = cfg.size
  var pad = Math.min(cfg.margin, Math.max(0, Math.floor((right - left - s) / 2)), Math.max(0, Math.floor((bottom - top - s) / 2)))
  var x, y
  var c = cfg.corner
  if (c === "center") {
    x = left + (right - left - s) / 2
    y = top + (bottom - top - s) / 2
  } else {
    x = c.indexOf("left") >= 0 ? left + pad : right - pad - s
    y = c.indexOf("top") === 0 ? top + pad : bottom - pad - s
  }
  x = Math.round(Math.min(Math.max(0, x), Math.max(0, m.width - s)))
  y = Math.round(Math.min(Math.max(0, y), Math.max(0, m.height - s)))
  return { screen: m.name, x: x, y: y }
}

// Pick the window: the active one, or a specific address among `clients`.
function pickWindow(sections, address) {
  if (address) {
    var list = parseJson(sections.clients, [])
    for (var i = 0; i < list.length; i++) if (list[i].address === address) return list[i]
    return null
  }
  var w = parseJson(sections.window, null)
  return w && Number(w.pid) > 0 && w.at && w.size ? w : null
}
