#!/usr/bin/env bash
set -euo pipefail
stomylos_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
stomylos_fail() {
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title=Stomylos --text="$1" || true
  else
    printf '%s\n' "$1" >&2
  fi
  exit 1
}
# A checkout always runs its current build, even if an old package remains.
# Use Electron directly so desktop launch does not depend on npm, NVM or cwd.
if [[ -f "$stomylos_dir/src/main/index.ts" ]]; then
  stomylos_electron="$stomylos_dir/node_modules/electron/dist/electron"
  [[ -x "$stomylos_electron" ]] || stomylos_fail 'Install source dependencies with npm ci, then run npm run build.'
  for stomylos_file in out/main/index.js out/main/db-worker.js out/main/asr-worker.js out/preload/index.js out/renderer/index.html native/advisory-lock.node; do
    [[ -f "$stomylos_dir/$stomylos_file" ]] || stomylos_fail 'The source build is incomplete. Run npm run build successfully before opening Stomylos.'
  done
  unset ELECTRON_RUN_AS_NODE
  exec "$stomylos_electron" "$stomylos_dir" --stomylos-personal "$@"
fi
stomylos_executable="$stomylos_dir/stomylos"
if [[ ! -x "$stomylos_executable" ]]; then
  stomylos_executable="$stomylos_dir/release/linux-unpacked/stomylos"
fi
if [[ ! -x "$stomylos_executable" ]]; then
  stomylos_error='The complete Stomylos Linux bundle is required. Extract the release archive or build it with npm run package.'
  stomylos_fail "$stomylos_error"
fi
# The application reads the external key file; never source it in a shell.
exec "$stomylos_executable" "$@"
