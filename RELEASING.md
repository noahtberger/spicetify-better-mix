# Releasing

People install by copying a folder out of a zip, so they have no update
mechanism and no way to tell what they're running except the version. That
makes two things matter: `main` should not be what they download, and every
release should say what changed.

Push to `main` freely. A release is a deliberate act.

## Before tagging

1. `./smoke-test.sh` — loads the extension against a stubbed Spotify. Catches
   things a syntax check can't, like calling a function that no longer exists.
2. `./sync-app.sh && spicetify apply` — then actually use it. Open Home, let a
   mix build, open its page, play something, save one.
3. If anything about how a mix is built changed, bump `RULES_VERSION` in
   `better-mix/better-mix.js` so existing installs rebuild instead of showing
   stale mixes made under the old rules.
4. Bump `version` in `better-mix/manifest.json` and `VERSION` in
   `better-mix/better-mix.js`. Keep them equal.
5. Add a `CHANGELOG.md` entry written for someone deciding whether to bother
   re-copying a folder — what's different, not which functions changed.

## Tagging

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

The README links to `/releases/latest`, so that's live for new installs the
moment it exists.

## What counts as a breaking change

Only one thing really: the shape of what's kept in `localStorage`
(`better-mix:virtual`, `home-mixes:sources`). Someone updating has a store
full of mixes built by the old version. Read defensively, never assume a field
exists, and prefer adding fields over renaming them. Everything else — the
build rules, the layout, the API calls — is safe, because the worst case is a
rebuild.
