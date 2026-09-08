#!/usr/bin/env bash
set -euo pipefail
stomylos_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
stomylos_launcher="$stomylos_dir/run.sh"
stomylos_icon="$stomylos_dir/icon.png"
[[ -f "$stomylos_icon" ]] || stomylos_icon="$stomylos_dir/assets/icon.png"
for stomylos_command in xdg-user-dir desktop-file-install; do
  command -v "$stomylos_command" >/dev/null || { printf 'Missing desktop utility: %s\n' "$stomylos_command" >&2; exit 1; }
done
stomylos_data="${XDG_DATA_HOME:-$HOME/.local/share}"
[[ "$stomylos_data" = /* ]] || stomylos_data="$HOME/.local/share"
stomylos_desktop="$(xdg-user-dir DESKTOP)"
[[ "$stomylos_desktop" = /* && "$stomylos_desktop" != "$HOME" ]] || { printf '%s\n' 'No separate desktop directory is configured.' >&2; exit 1; }
stomylos_exec=${stomylos_launcher//\\/\\\\}
stomylos_exec=${stomylos_exec//\"/\\\"}
stomylos_exec=${stomylos_exec//\$/\\$}
stomylos_exec=${stomylos_exec//\`/\\\`}
stomylos_exec=${stomylos_exec//%/%%}
for stomylos_target in "$stomylos_data/applications" "$stomylos_desktop"; do
  stomylos_entry="$stomylos_target/stomylos.desktop"
  if [[ -e "$stomylos_entry" ]] && ! grep -qx 'X-Stomylos-Managed=true' "$stomylos_entry"; then
    printf 'Refusing to replace an unrelated entry: %s\n' "$stomylos_entry" >&2; exit 1
  fi
done
for stomylos_target in "$stomylos_data/applications" "$stomylos_desktop"; do
  desktop-file-install --dir="$stomylos_target" --mode=0755 --set-key=Exec --set-value="\"$stomylos_exec\"" \
    --set-key=TryExec --set-value="$stomylos_launcher" --set-key=Icon --set-value="$stomylos_icon" "$stomylos_dir/stomylos.desktop"
done
if command -v gio >/dev/null 2>&1; then gio set "$stomylos_desktop/stomylos.desktop" metadata::trusted true 2>/dev/null || true; fi
printf '%s\n' 'Stomylos is available in the application menu and on the desktop.'
