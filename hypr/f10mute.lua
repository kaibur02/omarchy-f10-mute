-- F10 Mute (Omarchy plugin io.github.kaibur02.omarchy-f10-mute) — Hyprland side.
--
-- Copied to ~/.config/hypr/f10mute.lua and loaded from hyprland.lua by
-- setup-keybind.sh (run it from the plugin folder, or click "Add keybind" on
-- the plugin's notification). `setup-keybind.sh --remove` takes it out again.
--
-- The bind is defined here, statically, like any other bind. The plugin never
-- creates or removes binds at runtime (doing that through `hyprctl dispatch`
-- crashed Hyprland 0.56.2). It only sets one plain Lua flag:
--   _G.f10mute_enabled = true   while the plugin is enabled (set on start and
--                                after every config reload)
--   _G.f10mute_enabled = false  when it is disabled
-- Enabled:  the key goes to the plugin (Hyprland global shortcut, no process spawned).
-- Disabled: the key is passed on to the focused app, as if nothing were bound.

-- The key. Only this exact combo is taken; F10 with other modifiers still
-- reaches apps. Examples: "F10", "SUPER + F10", "CTRL + ALT + M".
-- setup-keybind.sh keeps your choice when it updates this file.
local KEY = "F10"

local PLUGIN_ID = "io.github.kaibur02.omarchy-f10-mute"

-- If the plugin was removed without running `setup-keybind.sh --remove`, bind
-- nothing: the key stays completely free.
local plugin_manifest = (os.getenv("HOME") or "") .. "/.config/omarchy/plugins/" .. PLUGIN_ID .. "/manifest.json"
local probe = io.open(plugin_manifest, "r")
if not probe then return end
probe:close()

local MODS, BARE_KEY = "", KEY
do
  local mods, key = KEY:match("^(.*)%+%s*([^%s+]+)%s*$")
  if key then MODS, BARE_KEY = mods:gsub("%s*%+%s*", " "):gsub("^%s+", ""):gsub("%s+$", ""), key end
end

local function key_state(state)
  local spec = { key = BARE_KEY, state = state }
  if MODS ~= "" then spec.mods = MODS end
  hl.dispatch(hl.dsp.send_key_state(spec))
end

local function pass_through()
  key_state("down")
  hl.timer(function() key_state("up") end, { timeout = 30, type = "oneshot" })
end

function _G.f10mute_press()
  if _G.f10mute_enabled == true then
    hl.dispatch(hl.dsp.global("f10mute:toggle"))
  else
    pass_through()
  end
end

-- dont_inhibit keeps the key working in fullscreen games and apps that grab
-- the keyboard (keyboard-shortcuts-inhibit).
o.bind(KEY, "Toggle audio mute for focused app (F10 Mute)", function() _G.f10mute_press() end, { dont_inhibit = true })

-- The badge fades itself; skip Hyprland's ~400 ms layer fade so it appears at once.
hl.layer_rule({ match = { namespace = "^f10mute$" }, no_anim = true, animation = "none" })
