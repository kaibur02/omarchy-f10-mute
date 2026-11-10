// F10 Mute — Omarchy shell service plugin (io.github.kaibur02.omarchy-f10-mute).
//
// Toggle audio for the focused app only, with a click-through indicator drawn
// over that app's window. Enable/disable from Omarchy menu → Setup → Plugins,
// or `omarchy plugin enable|disable io.github.kaibur02.omarchy-f10-mute`.
//
// Lifecycle: the shell creates this object when the plugin is enabled and
// destroys it when it is disabled (or reloaded). Everything lives here:
//   * the on/off flag read by the static F10 bind in ~/.config/hypr/f10mute.lua
//     (added by setup-keybind.sh, only with the user's consent):
//     a disabled plugin makes that bind pass F10 on to the focused app
//   * the stream watcher and the overlay window
// State (muted apps + WirePlumber restore keys) is saved to
// ~/.local/state/f10mute/state.json on every change and reconciled on start,
// so a shell crash, plugin reload or re-enable resumes exactly where it was.
//
// Config: ~/.config/f10mute/config.json (hot-reloaded). See README.md.
// IPC:    omarchy-shell f10mute <toggle|preview|status|unmuteAll|...>
//
// Overlay focus/input safety (same guarantees as the stock Omarchy OSD):
//   * WlrLayershell.layer: Overlay       above all windows, including fullscreen
//   * WlrLayershell.keyboardFocus: None  can never receive keyboard focus
//   * mask: Region {}                    empty input region: pointer events
//                                        pass straight through to the app
//   * exclusionMode: Ignore              reserves no space, moves nothing
//   * unmapped (visible: false) between toggles

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import qs.Commons
import "logic.js" as Logic

Item {
  id: root

  // Injected by the shell.
  property var shell: null
  property var manifest: null

  // Distinguishes this instance from the next one when the plugin is reloaded
  // (old destruction and new creation can interleave).
  readonly property string instanceToken: "i" + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36)

  // ---------------------------------------------------------------- paths
  function xdg(name, fallback) {
    return Quickshell.env(name) || (Quickshell.env("HOME") + fallback)
  }
  readonly property string configPath: Quickshell.env("F10MUTE_CONFIG") || (xdg("XDG_CONFIG_HOME", "/.config") + "/f10mute/config.json")
  readonly property string statePath: xdg("XDG_STATE_HOME", "/.local/state") + "/f10mute/state.json"

  // ---------------------------------------------------------------- config
  readonly property var cfg: Logic.normalizeConfig({
    corner: cfgRaw.corner, margin: cfgRaw.margin, size: cfgRaw.size,
    opacity: cfgRaw.opacity, holdMs: cfgRaw.holdMs, fadeMs: cfgRaw.fadeMs
  })

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: console.log("f10mute: config loaded", JSON.stringify(root.cfg))

    JsonAdapter {
      id: cfgRaw
      property string corner: Logic.DEFAULT_CONFIG.corner
      property real margin: Logic.DEFAULT_CONFIG.margin
      property real size: Logic.DEFAULT_CONFIG.size
      property real opacity: Logic.DEFAULT_CONFIG.opacity
      property real holdMs: Logic.DEFAULT_CONFIG.holdMs
      property real fadeMs: Logic.DEFAULT_CONFIG.fadeMs
    }
  }

  // ---------------------------------------------------------------- state
  // Apps muted by F10 Mute, keyed by the window's pid:
  //   { pid, start, names: [..], byName: bool, label }
  // `start` is the process start time; a saved entry whose pid now belongs to
  // a different process (recycled pid after a reboot) is discarded.
  property var muted: ({})
  readonly property int mutedCount: Object.keys(muted).length

  // WirePlumber restore keys ("name:Chromium", "id:mpv") that F10 Mute muted.
  // WirePlumber saves our mute under that key and re-applies it to every new
  // stream with the same key: other apps sharing the name, or the same app on
  // its next launch. Such restored mutes on streams that do not belong to a
  // muted app are undone.
  property var ownKeys: ({})
  readonly property int ownKeyCount: Object.keys(ownKeys).length

  FileView {
    id: stateFile
    path: root.statePath
    blockLoading: true
    printErrors: false
    atomicWrites: true
  }

  function writeState() {
    stateFile.setText(Logic.serializeState(root.muted, root.ownKeys))
  }

  function setMuted(next) {
    root.muted = next
    root.writeState()
  }

  function setOwnKey(key, on) {
    if (!key || !!root.ownKeys[key] === on) return
    var next = Object.assign({}, root.ownKeys)
    if (on) next[key] = true
    else delete next[key]
    root.ownKeys = next
    root.writeState()
  }

  function pruneDead(procs) {
    var r = Logic.pruneTracked(root.muted, procs)
    if (r.dropped.length === 0) return
    for (var i = 0; i < r.dropped.length; i++)
      console.log("f10mute: forgetting exited app", r.dropped[i].label, r.dropped[i].pid)
    root.setMuted(r.kept)
  }

  function setStreamMute(stream, on) {
    Quickshell.execDetached(["pactl", "set-sink-input-mute", String(stream.index), on ? "1" : "0"])
    root.setOwnKey(stream.restoreKey, on)
  }

  // One `sh` round trip gathers everything; sections are split in logic.js.
  function queryCommand(sections) {
    var script =
      'for s in "$@"; do\n' +
      '  printf "\\n%s %s\\n" "' + Logic.MARK + '" "$s"\n' +
      '  case $s in\n' +
      '    window)   hyprctl -j activewindow ;;\n' +
      '    clients)  hyprctl -j clients ;;\n' +
      '    monitors) hyprctl -j monitors ;;\n' +
      '    binds)    hyprctl -j binds ;;\n' +
      '    sinks)    pactl -f json list sink-inputs ;;\n' +
      '    pclients) pactl -f json list clients ;;\n' +
      '    ps)       LC_ALL=C ps -eo pid=,ppid=,lstart= ;;\n' +
      '  esac\n' +
      'done'
    return ["sh", "-c", script, "f10mute"].concat(sections)
  }

  // ---------------------------------------------------------------- toggle
  property var pendingRequest: null

  function request(mode, address) {
    var req = { mode: mode, address: address || "" }
    if (toggleProc.running) { root.pendingRequest = req; return }
    toggleProc.req = req
    var sections = mode === "unmuteAll"
      ? ["sinks", "pclients", "ps"]
      : [req.address ? "clients" : "window", "monitors", "sinks", "pclients", "ps"]
    toggleProc.command = root.queryCommand(sections)
    toggleProc.running = true
  }

  function handleUnmuteAll(sec) {
    var procs = Logic.parseProcs(sec.ps)
    var streams = Logic.buildStreams(Logic.parseJson(sec.sinks, []), Logic.parseJson(sec.pclients, []))
    for (var key in root.muted) {
      var matched = Logic.matchStreams(streams, root.muted[key], procs.ppid)
      for (var i = 0; i < matched.length; i++) if (matched[i].mute) root.setStreamMute(matched[i], false)
    }
    console.log("f10mute: unmuted all", JSON.stringify(Object.keys(root.muted)))
    root.setMuted({})
  }

  function handleToggle(text, req) {
    var sec = Logic.splitSections(text)
    if (req.mode === "unmuteAll") { root.handleUnmuteAll(sec); return }

    var win = Logic.pickWindow(sec, req.address)
    if (!win) { console.log("f10mute: no focused window with a pid; nothing to do"); return }

    var procs = Logic.parseProcs(sec.ps)
    var ppid = procs.ppid
    root.pruneDead(procs)
    var streams = Logic.buildStreams(Logic.parseJson(sec.sinks, []), Logic.parseJson(sec.pclients, []))
    var key = String(win.pid)
    var tracked = root.muted[key] || null
    var res = tracked
      ? { target: tracked, matched: Logic.matchStreams(streams, tracked, ppid) }
      : Logic.resolveTarget(win, streams, ppid)

    var nowMuted
    if (req.mode === "preview") {
      nowMuted = !!tracked || (res.matched.length > 0 && res.matched.every(function (s) { return s.mute }))
    } else {
      nowMuted = Logic.decideMuted(!!tracked, res.matched)
      for (var i = 0; i < res.matched.length; i++) {
        if (res.matched[i].mute !== nowMuted) root.setStreamMute(res.matched[i], nowMuted)
        else if (!nowMuted) root.setOwnKey(res.matched[i].restoreKey, false)
      }
      var next = Object.assign({}, root.muted)
      if (nowMuted) {
        next[key] = {
          pid: Number(win.pid), start: procs.start[key] || "", names: res.target.names,
          byName: res.target.byName, label: String(win["class"] || "?").slice(0, 128)
        }
      } else {
        delete next[key]
      }
      root.setMuted(next)
      console.log("f10mute:", nowMuted ? "MUTED" : "UNMUTED", win["class"], "pid", win.pid,
                  "streams", JSON.stringify(res.matched.map(function (s) { return s.index + ":" + s.label })),
                  res.target.byName ? "(matched by name)" : "")
    }

    var mon = Logic.findMonitor(Logic.parseJson(sec.monitors, []), win.monitor)
    if (mon) root.showOverlay(Logic.overlayRect(win, mon, root.cfg), nowMuted)
  }

  Process {
    id: toggleProc
    property var req: null
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try { root.handleToggle(text, toggleProc.req) }
        catch (e) { console.warn("f10mute: toggle failed:", e) }
        if (root.pendingRequest) retryTimer.restart()
      }
    }
  }

  Timer {
    id: retryTimer
    interval: 5
    onTriggered: {
      if (toggleProc.running) { restart(); return }
      var req = root.pendingRequest
      root.pendingRequest = null
      if (req) root.request(req.mode, req.address)
    }
  }

  // ---------------------------------------------------------------- enforce
  // Runs once on start (reconciling the saved state with what is actually
  // playing), then on every stream appearance/change while anything is muted
  // or a restore key of ours may still be saved as muted.
  readonly property bool watching: mutedCount > 0 || ownKeyCount > 0

  function handleEnforce(text) {
    var sec = Logic.splitSections(text)
    var procs = Logic.parseProcs(sec.ps)
    root.pruneDead(procs)
    if (!root.watching) return
    var streams = Logic.buildStreams(Logic.parseJson(sec.sinks, []), Logic.parseJson(sec.pclients, []))
    var actions = Logic.planEnforce(streams, root.muted, procs.ppid, root.ownKeys)
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i]
      console.log("f10mute:", a.mute ? "muting stream" : "undoing restored mute on stream",
                  a.index, a.label, "(" + a.reason + ")")
      root.setStreamMute(a, a.mute)
    }
  }

  Process {
    id: enforceProc
    command: root.queryCommand(["sinks", "pclients", "ps"])
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try { root.handleEnforce(text) }
        catch (e) { console.warn("f10mute: enforce failed:", e) }
      }
    }
  }

  Timer {
    id: enforceTimer
    interval: 30
    onTriggered: {
      if (enforceProc.running) { restart(); return }
      enforceProc.running = true
    }
  }

  Process {
    id: subscribeProc
    running: root.watching
    command: ["pactl", "subscribe"]
    stdout: SplitParser {
      onRead: function (line) {
        // 'change' too: WirePlumber may apply a restored mute just after 'new'.
        if (/'(new|change)' on sink-input/.test(line)) enforceTimer.restart()
      }
    }
    onExited: if (root.watching) resubscribeTimer.restart()
  }

  Timer {
    id: resubscribeTimer
    interval: 1000
    onTriggered: if (root.watching && !subscribeProc.running) subscribeProc.running = true
  }

  // ---------------------------------------------------------------- keybind
  // The bind itself is static, in ~/.config/hypr/f10mute.lua (added by
  // setup-keybind.sh when the user runs it or clicks "Add keybind").
  // This plugin never creates or removes binds at runtime: doing
  // that through `hyprctl dispatch` crashed Hyprland 0.56.2. It only sets a
  // plain Lua flag the bind reads on every press:
  //   enabled  -> the key toggles mute (via the global shortcut below)
  //   disabled -> the bind passes the key on to the focused app
  // The flag is re-set after every Hyprland config reload. The owner token
  // stops an old instance (plugin reload) from clearing a newer one's flag.
  readonly property string bindDescription: "Toggle audio mute for focused app (F10 Mute)"
  readonly property string setupScript: decodeURIComponent(String(Qt.resolvedUrl("setup-keybind.sh")).replace(/^file:\/\//, ""))
  property bool bindMissingNotified: false

  function setFlag(on) {
    var tok = "'" + root.instanceToken + "'"
    var lua = on
      ? "function() _G.f10mute_enabled = true _G.f10mute_owner = " + tok + " end"
      : "function() if _G.f10mute_owner == " + tok + " then _G.f10mute_enabled = false end end"
    Quickshell.execDetached(["hyprctl", "dispatch", lua])
  }

  // Read-only check that the static bind is installed; tells the user once if not.
  function handleBinds(text) {
    var binds = Logic.parseJson(Logic.splitSections(text).binds, [])
    var found = null
    for (var i = 0; i < binds.length; i++) if (binds[i] && binds[i].description === root.bindDescription) { found = binds[i]; break }
    if (found) {
      console.log("f10mute: active; Hyprland bind present (key", found.key, "modmask", found.modmask + ")")
      root.bindMissingNotified = false
    } else if (!root.bindMissingNotified) {
      root.bindMissingNotified = true
      var body = "F10 Mute needs its keybind in your Hyprland config. \"Add keybind\" adds ~/.config/hypr/f10mute.lua and one require line to hyprland.lua (backed up first)."
      console.warn("f10mute: keybind not installed; offering setup")
      Quickshell.execDetached(["omarchy-notification-send", "-u", "normal", "-g", Logic.GLYPH_MUTED, "F10 Mute", body,
                               "--action", "Add keybind", "bash", root.setupScript])
    }
  }

  Process {
    id: bindsProc
    command: root.queryCommand(["binds"])
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try { root.handleBinds(text) }
        catch (e) { console.warn("f10mute: bind check failed:", e) }
      }
    }
  }

  Timer {
    id: bindCheckTimer
    interval: 300
    onTriggered: {
      if (bindsProc.running) { restart(); return }
      bindsProc.running = true
    }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (event.name === "configreloaded") {
        root.setFlag(true)
        bindCheckTimer.restart()
      }
    }
  }

  GlobalShortcut {
    appid: "f10mute"
    name: "toggle"
    description: "Toggle audio mute for the focused app"
    onPressed: root.request("toggle", "")
  }

  // ---------------------------------------------------------------- IPC
  IpcHandler {
    target: "f10mute"
    function toggle(): string { root.request("toggle", ""); return "ok" }
    function toggleAddress(address: string): string { root.request("toggle", address); return "ok" }
    function preview(): string { root.request("preview", ""); return "ok" }
    function previewAddress(address: string): string { root.request("preview", address); return "ok" }
    function unmuteAll(): string { root.request("unmuteAll", ""); return "ok" }
    function status(): string {
      return JSON.stringify({ config: root.cfg, muted: root.muted, ownKeys: Object.keys(root.ownKeys) })
    }
    function ping(): string { return "ok" }
  }

  // ---------------------------------------------------------------- lifecycle
  Component.onCompleted: {
    Quickshell.execDetached(["mkdir", "-p", root.statePath.replace(/\/[^\/]*$/, "")])
    var saved = Logic.parseState(stateFile.text())
    root.muted = saved.muted
    root.ownKeys = saved.ownKeys
    console.log("f10mute: started; restored", root.mutedCount, "muted app(s),", root.ownKeyCount, "restore key(s)")
    root.setFlag(true)
    bindCheckTimer.start()
    enforceTimer.start()   // reconcile saved state with the live streams
  }

  Component.onDestruction: {
    root.setFlag(false)
    console.log("f10mute: stopped; state kept in", root.statePath)
  }

  // ---------------------------------------------------------------- overlay
  property string ovScreen: ""
  property int ovX: 0
  property int ovY: 0
  property bool ovMuted: false

  readonly property var ovScreenObj: {
    var screens = Quickshell.screens || []
    for (var i = 0; i < screens.length; i++) if (screens[i] && screens[i].name === root.ovScreen) return screens[i]
    return null
  }

  function showOverlay(rect, isMuted) {
    root.ovScreen = rect.screen
    root.ovX = rect.x
    root.ovY = rect.y
    root.ovMuted = isMuted
    if (!root.ovScreenObj) { console.warn("f10mute: no screen named", rect.screen); return }
    overlay.visible = true
    fade.restart()
  }

  PanelWindow {
    id: overlay
    visible: false
    screen: root.ovScreenObj
    color: "transparent"

    anchors { top: true; left: true }
    margins { top: root.ovY; left: root.ovX }
    implicitWidth: root.cfg.size
    implicitHeight: root.cfg.size

    WlrLayershell.namespace: "f10mute"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore
    mask: Region {}

    Rectangle {
      id: badge
      anchors.fill: parent
      opacity: 0
      radius: Math.round(width * 0.26)
      color: Qt.rgba(0.06, 0.06, 0.07, 0.72)
      border.width: 1
      border.color: Qt.rgba(1, 1, 1, 0.14)

      Text {
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: root.ovMuted ? Logic.GLYPH_MUTED : Logic.GLYPH_ENABLED
        color: root.ovMuted ? "#ff8a80" : "#f5f5f5"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: Math.round(badge.width * 0.5)
      }
    }
  }

  // Fades honour Omarchy's "animations off" (Style.duration -> 0): the badge
  // then simply appears, stays holdMs, and disappears.
  SequentialAnimation {
    id: fade
    NumberAnimation { target: badge; property: "opacity"; to: root.cfg.opacity; duration: Style.duration(60) }
    PauseAnimation { duration: root.cfg.holdMs }
    NumberAnimation { target: badge; property: "opacity"; to: 0; duration: Style.duration(root.cfg.fadeMs); easing.type: Easing.InQuad }
    ScriptAction { script: overlay.visible = false }
  }
}
