# Better Mix

**Spotify's mixes are mostly songs you already play.** Better Mix takes every
mix Spotify makes for you, asks Spotify what fits it, then throws out
everything you already listen to — your library, your recent plays, the mix's
own artists. What's left is popular music by artists you *don't* play, ranked
by popularity, with a few songs you know spread through it.

![Your daily mixes and Your mixes, replacing Spotify's own rows on Home](preview.png)

It runs itself. The six Daily Mixes and whatever's on your Home page rebuild at
the first startup of each day; the rest of your catalogue refreshes weekly.
Your Home page shows the better versions where Spotify's rows used to be.
Nothing touches your library unless you press save.

## Install

Spotify has to be told about a new page, and only `spicetify apply` can do
that — which is why this can't be a one-click Marketplace install. It's a
one-time copy. **The folder must be named exactly `better-mix`**: that's also
the page's address inside Spotify.

```bash
git clone https://github.com/noahtberger/spicetify-better-mix.git
cp -r spicetify-better-mix/better-mix "$(spicetify path userdata)/CustomApps/better-mix"
spicetify config custom_apps better-mix
spicetify apply
```

No git? Download the repo as a zip from GitHub, then copy the `better-mix`
folder inside it to `~/.config/spicetify/CustomApps/` on macOS and Linux, or
`%APPDATA%\spicetify\CustomApps\` on Windows, and run the last two commands.

That one folder carries everything — the pages and the extension that builds
the mixes and replaces the Home rows.

Then **open Home once** so it can see which mixes Spotify makes for you. The
first run builds them in the background over a few minutes, with a counter on
the rows showing progress. After that it looks after itself.

To update: pull, copy the folder again, `spicetify apply`.

## Using it

- **Home rows** replace Spotify's mix shelves: your daily mixes, then your
  mixes. Hover a card to play; click for its page; **Show all** lists every
  mix built.
- **A mix page** looks like a playlist — play, shuffle, save as a real playlist
  (which then syncs to your phone), rebuild, search and sort.
- **Right-click any playlist** for a one-off better mix of it.
- **Profile menu**: turn the automatic builds off, or put Spotify's rows back.

## How it decides

For each of Spotify's mixes it asks their recommender what fits, then drops
every candidate you've played recently, everything in your library, and
anything by an artist already in that mix. Survivors are ranked by popularity,
capped at two per artist, and a track already used in another mix is penalised
so the same few songs don't fill everything. A handful of songs you know are
spliced through so it doesn't open like a stranger's playlist.

Every track records which rule let it in, visible on hover in the tracklist.

## Honest limits

It can only surface what Spotify's recommender offers, and that recommender
leans toward what you already like. Measured across 88 mixes: about 64% of
tracks are genuinely new artists, 26% are songs you haven't heard by artists
already in that mix, and the rest are the deliberate familiar ones. Mixes built
from clusters where you know nearly every artist — often your most-played genre
— lean hardest on that middle category.

Mixes live in this client's storage, not your Spotify account, so they don't
appear on your phone. Save one and it becomes a normal playlist that does.

## Development

```bash
./smoke-test.sh    # loads the extension against a stubbed Spotify
./sync-app.sh      # copies into Spicetify's folder (runs the smoke test first)
spicetify apply
```

The app is in `better-mix/` rather than at the repo root because both
ecosystems want a `manifest.json`: Marketplace reads the root one (the listing),
Spicetify reads the one inside the app folder.
