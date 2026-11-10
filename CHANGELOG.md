# Changelog

## 1.0.0

First public release.

- F10 toggles audio for the focused app only (its process tree; Flatpak apps by app ID).
- Click-through speaker badge on the toggled window; corner, size, opacity and timing in
  `~/.config/f10mute/config.json`.
- Mutes follow the app's new audio streams; state saved to `~/.local/state/f10mute/state.json`
  and reconciled on every start.
- Guard against WirePlumber re-applying a mute to other apps that share an application name.
- Static Hyprland keybind added with consent by `setup-keybind.sh`; the plugin only toggles a flag.
