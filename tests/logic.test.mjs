// Unit tests for logic.js. Run: node --test tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"

const src = readFileSync(new URL("../logic.js", import.meta.url), "utf8").replace(/^\.pragma library\s*$/m, "")
const L = vm.runInThisContext("(function(){" + src + "\nreturn ({" +
  "MARK, normalizeConfig, splitSections, parseJson, parsePs, isDescendantOrSelf, buildStreams, " +
  "streamMatches, matchStreams, resolveTarget, decideMuted, planEnforce, overlayRect, monitorLogical, pickWindow, windowNameTokens, " +
  "parseProcs, pruneTracked, parseState, serializeState })})()")

// Process tree: 1 ─ 100 (chromium) ─ 110 (audio service) ─ 111
//                 └ 200 (kitty) ─ 210 (bash) ─ 220 (mpv)
//                 └ 300 (other app)
const ppid = L.parsePs("  1 0\n100 1\n110 100\n111 110\n200 1\n210 200\n220 210\n300 1\n")

const sinks = [
  { index: 10, client: 1, mute: false, properties: { "application.name": "Chromium", "application.process.id": "110", "application.process.binary": "chromium" } },
  { index: 11, client: 2, mute: false, properties: { "media.name": "pw-play" } }, // native: pid only on client
  { index: 12, client: 3, mute: true, properties: { "application.name": "Other", "application.process.id": "300" } },
  { index: 13, client: 4, mute: false, properties: { "application.name": "Spotify", "application.process.id": "2", "pipewire.access.portal.app_id": "com.spotify.Client" } },
]
const clients = [
  { index: 1, properties: {} },
  { index: 2, properties: { "application.process.id": "220", "application.process.binary": "mpv", "application.name": "mpv" } },
  { index: 3, properties: {} },
  { index: 4, properties: {} },
]
const streams = L.buildStreams(sinks, clients)

test("parsePs", () => {
  assert.equal(ppid["220"], 210)
  assert.equal(ppid["1"], 0)
})

test("descendants", () => {
  assert.ok(L.isDescendantOrSelf(111, 100, ppid))
  assert.ok(L.isDescendantOrSelf(100, 100, ppid))
  assert.ok(!L.isDescendantOrSelf(300, 100, ppid))
  assert.ok(!L.isDescendantOrSelf(100, 1, ppid), "pid 1 must never be a root")
  assert.ok(!L.isDescendantOrSelf(999, 100, ppid), "unknown pid")
})

test("buildStreams joins client pid and names", () => {
  const s11 = streams.find(s => s.index === 11)
  assert.equal(s11.pid, 220)
  assert.ok(s11.names.includes("mpv"))
  const s13 = streams.find(s => s.index === 13)
  assert.ok(s13.sandboxed)
  assert.ok(s13.names.includes("client"), "last segment of app id")
  assert.ok(s13.names.includes("com.spotify.client"))
})

test("browser audio child process matches the browser window", () => {
  const r = L.resolveTarget({ pid: 100, class: "chromium" }, streams, ppid)
  assert.deepEqual(r.matched.map(s => s.index), [10])
  assert.equal(r.target.byName, false)
})

test("terminal window owns audio of programs run inside it", () => {
  const r = L.resolveTarget({ pid: 200, class: "kitty" }, streams, ppid)
  assert.deepEqual(r.matched.map(s => s.index), [11])
})

test("other apps are never touched", () => {
  const r = L.resolveTarget({ pid: 300, class: "other" }, streams, ppid)
  assert.deepEqual(r.matched.map(s => s.index), [12])
})

test("flatpak stream matched by app id, not by its namespace pid", () => {
  const r = L.resolveTarget({ pid: 5000, class: "com.spotify.Client" }, streams, ppid)
  assert.deepEqual(r.matched.map(s => s.index), [13])
  // pid 2 inside the sandbox must not be mistaken for a host process
  assert.ok(!L.streamMatches(streams.find(s => s.index === 13), { pid: 2, names: [], byName: false }, ppid))
})

test("name fallback only when pid tree finds nothing", () => {
  // Window pid 400 (not in tree), class mpv -> fallback by name
  const r = L.resolveTarget({ pid: 400, class: "mpv" }, streams, ppid)
  assert.deepEqual(r.matched.map(s => s.index), [11])
  assert.equal(r.target.byName, true)
  // No streams at all -> empty, pid target kept for pre-muting
  const r2 = L.resolveTarget({ pid: 400, class: "nothing" }, streams, ppid)
  assert.equal(r2.matched.length, 0)
  assert.equal(r2.target.byName, false)
})

test("decideMuted", () => {
  assert.equal(L.decideMuted(true, []), false, "tracked -> unmute")
  assert.equal(L.decideMuted(false, []), true, "no streams -> pre-mute")
  assert.equal(L.decideMuted(false, [{ mute: false }]), true)
  assert.equal(L.decideMuted(false, [{ mute: true }, { mute: false }]), true, "partially muted -> mute all")
  assert.equal(L.decideMuted(false, [{ mute: true }]), false, "already muted elsewhere -> unmute")
})

test("normalizeConfig", () => {
  const c = L.normalizeConfig({ corner: "Bottom_Left", size: 9999, opacity: "x", margin: -5 })
  assert.equal(c.corner, "bottom-left")
  assert.equal(c.size, 512)
  assert.equal(c.opacity, 0.7)
  assert.equal(c.margin, 0)
  assert.equal(L.normalizeConfig({ corner: "middle" }).corner, "top-right")
  assert.equal(L.normalizeConfig(null).holdMs, 1000)
})

test("splitSections / pickWindow", () => {
  const m = L.MARK
  const text = `\n${m} window\n{"pid": 5, "at": [0,0], "size": [10,10]}\n${m} ps\n1 0\n`
  const s = L.splitSections(text)
  assert.equal(L.pickWindow(s, "").pid, 5)
  assert.equal(L.parsePs(s.ps)["1"], 0)
  assert.equal(L.pickWindow(L.splitSections(`${m} window\n{}\n`), ""), null, "no active window")
  const c = L.splitSections(`${m} clients\n[{"address":"0xa","pid":1},{"address":"0xb","pid":2}]\n`)
  assert.equal(L.pickWindow(c, "0xb").pid, 2)
  assert.equal(L.pickWindow(c, "0xc"), null)
})

const cfg = L.normalizeConfig({ corner: "top-right", margin: 20, size: 60 })
// Monitor with a negative origin and offset (like DP-1 here: x 1920, y -110).
const mon = { id: 0, name: "DP-1", x: 1920, y: -110, width: 2560, height: 1440, scale: 1, transform: 0 }

test("overlay corners are relative to the window on its monitor", () => {
  const win = { at: [1920 + 100, -110 + 50], size: [800, 600] }
  const at = corner => L.overlayRect(win, mon, { ...cfg, corner })
  assert.deepEqual(at("top-right"), { screen: "DP-1", x: 100 + 800 - 20 - 60, y: 50 + 20 })
  assert.deepEqual(at("top-left"), { screen: "DP-1", x: 120, y: 70 })
  assert.deepEqual(at("bottom-left"), { screen: "DP-1", x: 120, y: 50 + 600 - 20 - 60 })
  assert.deepEqual(at("bottom-right"), { screen: "DP-1", x: 820, y: 570 })
  assert.deepEqual(at("center"), { screen: "DP-1", x: 100 + 370, y: 50 + 270 })
})

test("fullscreen window", () => {
  const r = L.overlayRect({ at: [1920, -110], size: [2560, 1440] }, mon, cfg)
  assert.deepEqual(r, { screen: "DP-1", x: 2560 - 80, y: 20 })
})

test("partly off-screen window (scrolling layout) uses its visible part", () => {
  const r = L.overlayRect({ at: [1920 + 2000, -110 + 0], size: [1200, 1440] }, mon, cfg)
  assert.equal(r.x, 2560 - 20 - 60, "right edge clipped to monitor")
})

test("tiny window shrinks the margin instead of overflowing", () => {
  const r = L.overlayRect({ at: [1920 + 10, -110 + 10], size: [70, 70] }, mon, cfg)
  assert.deepEqual(r, { screen: "DP-1", x: 10 + 5, y: 10 + 5 })
})

test("scaled and rotated monitors use logical size", () => {
  const m = L.monitorLogical({ name: "X", x: 0, y: 0, width: 3840, height: 2160, scale: 2, transform: 1 })
  assert.equal(m.width, 1080)
  assert.equal(m.height, 1920)
})

test("restore keys follow WirePlumber's application.id / application.name rule", () => {
  const st = L.buildStreams([
    { index: 1, client: 9, properties: { "application.name": "Chromium" } },
    { index: 2, client: 9, properties: { "application.name": "mpv", "application.id": "mpv" } },
    { index: 3, client: 9, properties: {} },
  ], [{ index: 9, properties: {} }])
  assert.deepEqual(st.map(s => s.restoreKey), ["name:Chromium", "id:mpv", ""])
})

test("planEnforce mutes tracked apps and undoes leaked restored mutes", () => {
  const st = L.buildStreams([
    // tracked app (chromium window pid 100), new unmuted stream -> mute
    { index: 1, client: 0, mute: false, properties: { "application.name": "Chromium", "application.process.id": "110" } },
    // tracked app, already muted -> nothing
    { index: 2, client: 0, mute: true, properties: { "application.name": "Chromium", "application.process.id": "111" } },
    // other app sharing the name, muted by WirePlumber restore -> unmute
    { index: 3, client: 0, mute: true, properties: { "application.name": "Chromium", "application.process.id": "300" } },
    // other app muted by the user in a mixer, key never muted by us -> leave
    { index: 4, client: 0, mute: true, properties: { "application.name": "Firefox", "application.process.id": "300" } },
    // other app unmuted -> leave
    { index: 5, client: 0, mute: false, properties: { "application.name": "Chromium", "application.process.id": "220" } },
  ], [])
  const tracked = { "100": { pid: 100, names: ["chromium"], byName: false } }
  const acts = L.planEnforce(st, tracked, ppid, { "name:Chromium": true })
  assert.deepEqual(acts.map(a => [a.index, a.mute, a.reason]), [[1, true, "tracked:100"], [3, false, "restored-leak"]])
  // Nothing tracked any more (app exited while muted): the next launch's restored mute is undone
  const acts2 = L.planEnforce(st, {}, ppid, { "name:Chromium": true })
  assert.deepEqual(acts2.map(a => [a.index, a.mute]), [[2, false], [3, false]])
  // No keys of ours, nothing tracked -> never touch anything
  assert.deepEqual(L.planEnforce(st, {}, ppid, {}), [])
})

test("name tokens: reverse-DNS last segment only", () => {
  assert.deepEqual([...L.windowNameTokens({ class: "Minecraft* 1.20.1" })], ["minecraft* 1.20.1"])
  assert.deepEqual([...L.windowNameTokens({ class: "org.mozilla.firefox", initialClass: "firefox" })].sort(), ["firefox", "org.mozilla.firefox"])
})

test("parseProcs keeps start times (LC_ALL=C lstart)", () => {
  const p = L.parseProcs("    1     0 Mon Nov 10 09:00:01 2026\n  4242     1 Mon Nov 10 10:15:30 2026\n")
  assert.equal(p.ppid["4242"], 1)
  assert.equal(p.start["4242"], "Mon Nov 10 10:15:30 2026")
  assert.equal(L.parsePs("5 1\n")["5"], 1, "two-column input still works")
})

test("pruneTracked drops exited apps and recycled pids", () => {
  const procs = L.parseProcs("100 1 Mon Nov 10 10:00:00 2026\n200 1 Mon Nov 10 11:00:00 2026\n")
  const tracked = {
    "100": { pid: 100, start: "Mon Nov 10 10:00:00 2026", label: "same process" },
    "200": { pid: 200, start: "Sun Nov  9 08:00:00 2026", label: "pid recycled" },
    "300": { pid: 300, start: "", label: "exited" },
  }
  const r = L.pruneTracked(tracked, procs)
  assert.deepEqual(Object.keys(r.kept), ["100"])
  assert.deepEqual(r.dropped.map(e => e.label).sort(), ["exited", "pid recycled"])
  // entries saved without a start time are kept while the pid exists
  assert.deepEqual(Object.keys(L.pruneTracked({ "100": { pid: 100 } }, procs).kept), ["100"])
})

test("state round-trips and rejects junk", () => {
  const muted = { "4242": { pid: 4242, start: "Mon Nov 10 10:15:30 2026", names: ["brave"], byName: false, label: "Brave" } }
  const back = L.parseState(L.serializeState(muted, { "name:Brave": true }))
  assert.deepEqual(JSON.parse(JSON.stringify(back.muted)), muted)
  assert.deepEqual(Object.keys(back.ownKeys), ["name:Brave"])
  const junk = L.parseState(JSON.stringify({
    muted: { "1": { pid: 1 }, "abc": { pid: 5 }, "7": { pid: 8 }, "9": "x", "10": { pid: 10, names: [1, "ok", "x".repeat(500)], label: 5 } },
    ownKeys: ["ok", 3, "y".repeat(999)]
  }))
  assert.deepEqual(Object.keys(junk.muted), ["10"])
  assert.deepEqual([...junk.muted["10"].names], ["ok"])
  assert.equal(junk.muted["10"].label, "?")
  assert.deepEqual(Object.keys(junk.ownKeys), ["ok"])
  assert.deepEqual(Object.keys(L.parseState("not json").muted), [])
  // v1 state (ownKeys only) still loads
  assert.deepEqual(Object.keys(L.parseState('{"ownKeys":["name:pw-play"]}').ownKeys), ["name:pw-play"])
})
