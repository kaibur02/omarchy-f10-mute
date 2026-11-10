#!/usr/bin/env bash
# F10 Mute — add or remove the Hyprland keybind.
#
#   setup-keybind.sh            add (or update) the keybind
#   setup-keybind.sh --remove   remove it
#
# Run it from the plugin folder:
#   bash ~/.config/omarchy/plugins/io.github.kaibur02.omarchy-f10-mute/setup-keybind.sh
# or click "Add keybind" on the notification the plugin shows when the keybind
# is missing. Nothing is changed until you do one of those.
#
# What it changes, and nothing else:
#   ~/.config/hypr/f10mute.lua   this plugin's bind (copied from hypr/f10mute.lua;
#                                a KEY you changed there is kept on update)
#   ~/.config/hypr/hyprland.lua  one managed block: require("hypr.f10mute")
#                                (a timestamped backup is written first)
# Then it reloads Hyprland. If Hyprland reports config errors, both files are
# restored and the error is shown.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cfg_home="${XDG_CONFIG_HOME:-$HOME/.config}"
hypr_main="$cfg_home/hypr/hyprland.lua"
hypr_mod="$cfg_home/hypr/f10mute.lua"
begin='-- >>> f10mute >>>'
end='-- <<< f10mute <<<'
glyph=$'\U000f075f'

# Report to the terminal when there is one, otherwise as a notification
# (the "Add keybind" button runs this without a terminal).
report() {
  local urgency=$1 msg=$2
  if [[ -t 1 ]]; then
    printf '%s\n' "$msg"
  elif command -v omarchy-notification-send >/dev/null; then
    omarchy-notification-send -u "$urgency" -g "$glyph" "F10 Mute" "$msg" || true
  fi
}
fail() { report critical "$1"; exit 1; }

[[ -f $hypr_main ]] || fail "No $hypr_main. F10 Mute needs Omarchy's Lua Hyprland config (Omarchy 4 or newer)."
command -v hyprctl >/dev/null || fail "hyprctl not found; is Hyprland running?"

backup_main=""
backup_mod=""
had_mod=0

snapshot() {
  local stamp; stamp=$(date +%s)
  backup_main="$hypr_main.bak.f10mute-$stamp"
  cp -a "$hypr_main" "$backup_main"
  if [[ -f $hypr_mod ]]; then
    had_mod=1
    backup_mod="$hypr_mod.bak.f10mute-$stamp"
    cp -a "$hypr_mod" "$backup_mod"
  fi
}

rollback() {
  cp -a "$backup_main" "$hypr_main"
  if (( had_mod )); then cp -a "$backup_mod" "$hypr_mod"; else rm -f "$hypr_mod"; fi
  hyprctl reload >/dev/null 2>&1 || true
}

reload_or_rollback() {
  hyprctl reload >/dev/null
  sleep 0.5
  local errs; errs="$(hyprctl configerrors 2>&1 || true)"
  if [[ -n ${errs//[[:space:]]/} ]]; then
    rollback
    fail "Hyprland reported config errors, so the change was undone: ${errs:0:300}"
  fi
}

remove_block() {
  awk -v b="$begin" -v e="$end" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$hypr_main" >"$hypr_main.tmp"
  mv "$hypr_main.tmp" "$hypr_main"
}

if [[ ${1:-} == "--remove" ]]; then
  if ! grep -qF -- "$begin" "$hypr_main" && [[ ! -f $hypr_mod ]]; then
    report normal "The F10 Mute keybind is not installed; nothing to remove."
    exit 0
  fi
  snapshot
  grep -qF -- "$begin" "$hypr_main" && remove_block
  rm -f "$hypr_mod"
  reload_or_rollback
  report normal "Removed the F10 Mute keybind. F10 is free again. (Backup: $backup_main)"
  exit 0
fi

[[ -z ${1:-} ]] || fail "Unknown option: $1 (use no option to add, --remove to remove)"
[[ -f $here/hypr/f10mute.lua ]] || fail "Missing $here/hypr/f10mute.lua; reinstall the plugin."

snapshot

# Keep a KEY the user changed in an existing copy.
key=""
if (( had_mod )); then
  key="$(sed -n 's/^local KEY = "\([A-Za-z0-9_: +]*\)"[[:space:]]*$/\1/p' "$hypr_mod" | head -1)"
fi
if [[ -n $key ]]; then
  KEY="$key" awk '/^local KEY = "/{print "local KEY = \"" ENVIRON["KEY"] "\""; next} {print}' "$here/hypr/f10mute.lua" >"$hypr_mod.tmp"
else
  cp "$here/hypr/f10mute.lua" "$hypr_mod.tmp"
fi
chmod 0644 "$hypr_mod.tmp"
mv "$hypr_mod.tmp" "$hypr_mod"

if ! grep -qF -- "$begin" "$hypr_main"; then
  block="$begin
require(\"hypr.f10mute\") -- F10 Mute plugin keybind; remove with setup-keybind.sh --remove
$end"
  # After the last top-level require("hypr.…") line, so blocks that must load
  # last stay last; appended if there is none.
  if grep -qE '^require\("hypr\.' "$hypr_main"; then
    last="$(grep -nE '^require\("hypr\.' "$hypr_main" | tail -1 | cut -d: -f1)"
    BLK="$block" awk -v n="$last" '{print} NR==n{print ENVIRON["BLK"]}' "$hypr_main" >"$hypr_main.tmp"
    mv "$hypr_main.tmp" "$hypr_main"
  else
    printf '\n%s\n' "$block" >>"$hypr_main"
  fi
fi

reload_or_rollback
report normal "F10 Mute keybind added (${key:-F10}). Press it on any window to toggle that app's audio. (Backup: $backup_main)"
