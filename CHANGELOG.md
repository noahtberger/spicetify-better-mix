# Changelog

## 1.0.0

First tagged release.

Better Mix rebuilds every mix Spotify makes for you around the same artists,
minus the songs you already play, and shows the results on your Home page in
place of Spotify's own rows. Each mix gets a playlist-style page with play,
shuffle, save, search and sort. Mixes refresh themselves daily and live in
Spotify on your computer until you save one.

How a mix is put together:

- Mostly the mix's own artists: songs of theirs you haven't played, up to
  three each, with the artists that dominate Spotify's version filling first.
- A minority of similar artists you don't play, and only ones Spotify relates
  to several of the mix's artists, who are in their league now, and who show
  up on the same editorial playlists. Nobody outside that circle.
- A few songs you know, spread through it, and nothing under a popularity
  floor, so no obscure album cuts.
- A mix named for a decade holds to that decade. A mix named for a mood or an
  activity keeps 40% of Spotify's own picks, since the client can't hear
  mood. Mixes named by BPM are left exactly as Spotify made them.

Known limits:

- Tempo, mood and genre aren't visible to a Spotify client, so they're
  approximated by artists and their editorial playlists rather than measured.
- Better Mix can't see how often you play something, only whether you have.
- Mixes aren't in your Spotify account until you press save, so they don't
  appear on your phone.
