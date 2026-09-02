#!/bin/sh
# Copy the app into Spicetify's folder, then `spicetify apply`.
#
# The app lives in ./better-mix/ rather than at the repo root because the two
# ecosystems both want a file called manifest.json: Marketplace reads the one
# at the root (the listing), Spicetify reads the one inside the app folder
# (name, icon, which files to inject).
#
# Spicetify also skips symlinked files when installing an app -- verified, it
# silently never installs -- so these must be real copies, which means editing
# here does nothing until you run this again.
set -e
cd "$(dirname "$0")"
./smoke-test.sh || { echo "smoke test failed - not syncing"; exit 1; }
DEST="${SPICETIFY_CONFIG:-$HOME/.config/spicetify}/CustomApps/better-mix"
mkdir -p "$DEST"
cp better-mix/manifest.json better-mix/index.js better-mix/style.css better-mix/better-mix.js "$DEST/"
echo "synced -> $DEST"
echo "now run: spicetify apply"
