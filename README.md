# Better Mix

**Have you ever felt that Spotify's mixes are lacking?** 

Better Mix rebuilds every mix Spotify makes for you around the same artists,
minus everything you already play — your library, your playlists, your recent
listening. What's left is the songs by those artists you haven't heard yet,
plus a few similar artists you don't play, with a handful of songs you know
spread through it.

![Your daily mixes and Your mixes, replacing Spotify's own rows on Home](preview.png)

## Install

Copy one folder, run two commands.

**1.** Download the
[latest release](https://github.com/noahtberger/spicetify-better-mix/releases/latest)
— the **Source code (zip)** link — and unzip it.

**2.** Open the unzipped folder. **Inside it is a folder called `better-mix`.
That's the one you want**, not the outer one.

Copy `better-mix` into Spicetify's `CustomApps` folder, keeping the name
exactly as it is — Spotify uses it as the page's address.

| | |
|---|---|
| macOS / Linux | `~/.config/spicetify/CustomApps/` |
| Windows | `%APPDATA%\spicetify\CustomApps\` |

Not sure where that is? Run `spicetify path userdata` and look for
`CustomApps` inside.

**3.** In a terminal, run:

```bash
spicetify config custom_apps better-mix
spicetify apply
```

Spotify will restart. **Open your Home page once** so Better Mix can see which
mixes Spotify makes for you — it builds them in the background over a few
minutes, and the rows show a counter while it works. After that it runs on its
own.

<details>
<summary>Prefer the command line?</summary>

```bash
git clone https://github.com/noahtberger/spicetify-better-mix.git
cp -r spicetify-better-mix/better-mix "$(spicetify path userdata)/CustomApps/better-mix"
spicetify config custom_apps better-mix
spicetify apply
```

</details>

**Updating later:** grab the
[latest release](https://github.com/noahtberger/spicetify-better-mix/releases/latest),
copy the folder over the old one, and run `spicetify apply`. What changed is in
the [changelog](CHANGELOG.md).

## Using it

- **Home rows** replace Spotify's mix shelves: your daily mixes, then your
  mixes. Hover a card to play; click for its page; **Show all** lists every
  mix built.
- **A mix page** looks like a playlist — play, shuffle, save as a real playlist
  (which then syncs to your phone), rebuild, search and sort.
- **Right-click any playlist** for a one-off better mix of it.
- **Profile menu**: turn the automatic builds off, or put Spotify's rows back.

Mixes live in Spotify on this computer, not in your Spotify account, so they
won't show up on your phone. Save one and it becomes a normal playlist that
does.

## How it decides

Each of Spotify's mixes is rebuilt around its own artists. Most of the new mix
is songs by those artists that you haven't played, up to three each, with the
artists that dominate Spotify's version filling first. A minority is similar
artists you don't play — only ones Spotify relates to several of the mix's
artists, who are in their league now, and who show up on the same editorial
playlists. Nobody outside that circle gets in, however good the song, and
nothing under a popularity floor, so no obscure album cuts. A few songs you
know are spread through so it doesn't open like a stranger's playlist, and no
artist plays twice in a row.

Some mixes are defined by things a Spotify client can't see. A mix named for a
decade holds to that decade. A mix named for a mood or an activity keeps 40%
of Spotify's own picks. Mixes named by BPM are left exactly as Spotify made
them.

Every track records which rule let it in, visible on hover in the tracklist.

---

Thanks for using Better Mix. If you like it, please star the repo ⭐
