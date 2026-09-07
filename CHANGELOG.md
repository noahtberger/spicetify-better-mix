# Changelog

## 1.0.0

First tagged release.

Better Mix rebuilds every mix Spotify makes for you without the songs you
already play, and shows the results on your Home page in place of Spotify's
own rows. Each mix gets a playlist-style page with play, shuffle, save, search
and sort. Mixes refresh themselves daily and live in Spotify on your computer
until you save one.

Known limits in this release:

- The recommender returns about 100 candidates per mix, so for clusters where
  you already know nearly every artist, part of the mix is filled with songs
  from Spotify's own version. Hover a track number to see which rule admitted
  it.
- Mixes aren't in your Spotify account until you press save, so they don't
  appear on your phone.
