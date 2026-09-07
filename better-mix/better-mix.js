// ============================================================================
// better-mix.js — Spotify's mixes, rebuilt without the songs you already play
// ----------------------------------------------------------------------------
// One file, two halves, injected by the app that contains it:
//   1. the builder   -- asks Spotify what fits each of its mixes for you, drops
//                       everything you already play, keeps the popular rest;
//                       runs itself daily.
//   2. the Home rows -- hides Spotify's mix shelves and shows yours in their
//                       place.
// index.js in the same folder adds the playlist-style page for each mix.
//
// Loaded twice would mean two sets of rows and double builds, so the whole
// file runs once per page load.
// ============================================================================
if (window.__betterMixExtensionLoaded) {
  console.warn("[better-mix] already loaded — skipping a duplicate copy");
} else {
window.__betterMixExtensionLoaded = true;

// ############################## 1. THE BUILDER ##############################
// ============================================================================
// better-mix.js — a mix that's actually mostly music you don't already play
// ----------------------------------------------------------------------------
// Spotify's own mixes optimise for "you'll definitely like this", which
// collapses into songs you already listen to. This inverts that: it takes a
// playlist you like, asks Spotify what fits it, then SUBTRACTS everything you
// already play -- your library, your recent listening, and the playlist's own
// artists -- and keeps the popular remainder.
//
// WHY NONE OF THIS USES api.spotify.com:
// The public Web API refuses calls from the desktop client (every request,
// including /v1/me, comes back 429 no matter how long you wait). Everything
// here uses Spicetify.Platform instead -- the internal APIs the Spotify UI
// itself runs on. Those can't be closed off without breaking the app.
//
// The recommender is PlaylistAPI.getRecommendedTracks(uri, offset, limit),
// which is what powers "Recommended songs" at the bottom of a playlist.
// Note the POSITIONAL arguments -- passing an options object returns 400.
// ============================================================================

(function betterMix() {
  // Printed on load so a bug report says which build it came from -- people
  // install by copying a folder, so there's no other way to tell.
  const VERSION = "1.0.0";

  // A stub from the very first tick, so anything calling BetterMix before
  // init finishes gets a clear answer. Replaced with the real object at the
  // bottom once everything's ready -- or left standing, with the error, if
  // init throws, so "still starting" can never be a permanent state.
  window.BetterMix ||= {
    ready: false,
    open: () => Spicetify?.showNotification?.(window.__betterMixError
      ? `Better Mix failed to start: ${window.__betterMixError}`
      : "Better Mix is still starting — try again in a moment"),
  };
  if (window.__betterMixError) return;

  const startedAt = (window.__betterMixStart ??= Date.now());
  const waited = Date.now() - startedAt;
  // Truly required: the recommender and a way to talk to you. Everything
  // else is nice-to-have -- wait up to 10s for it, then carry on without.
  const core = !!(Spicetify?.Platform?.PlaylistAPI && Spicetify?.showNotification);
  const nice = {
    PopupModal: !!Spicetify?.PopupModal,
    ContextMenu: !!Spicetify?.ContextMenu, PlayerAPI: !!Spicetify?.Platform?.PlayerAPI,
  };
  const missing = Object.keys(nice).filter((k) => !nice[k]);
  if (!core || (missing.length && waited < 10000)) {
    if (waited < 400) console.log("[better-mix] loaded, waiting for Spicetify…");
    else if (waited > 8000 && Date.now() - (window.__betterMixWarn || 0) > 8000) {
      window.__betterMixWarn = Date.now();
      console.warn(`[better-mix] still waiting after ${Math.round(waited / 1000)}s — ` +
        `${core ? "" : "no PlaylistAPI yet; "}missing: ${missing.join(", ") || "nothing"}`);
    }
    setTimeout(betterMix, 300);
    return;
  }
  if (missing.length) console.warn(`[better-mix] starting without: ${missing.join(", ")} (those features off)`);
  console.log(`[better-mix] v${VERSION} initialised after ${waited}ms`);
  try {

  const P = () => Spicetify.Platform;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Every Spotify call goes through this. None of them time out on their own,
  // and a build holds an exclusive lock, so one request that never returns
  // freezes not just its own mix but every rebuild after it until Spotify is
  // reloaded. Patching individual calls kept missing new ones; this wraps the
  // pattern instead.
  const timed = (promise, ms, label) => Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
  let logLine = () => {};

  const SET_KEY = "better-mix:settings";
  const DEFAULTS = { total: 50, familiarCount: 3, maxPerArtist: 2 };
  const settings = () => { try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SET_KEY)) || {}) }; } catch { return { ...DEFAULTS }; } };
  const saveSettings = (o) => { try { localStorage.setItem(SET_KEY, JSON.stringify(o)); } catch {} };

  // home-mixes.js records the Spotify mix shelves it hides. Reading them from
  // storage means this works anywhere, not just while Home is on screen.
  const isMix = (x) => /^37i9dQZF1E/.test(String(x?.uri).split(":").pop()) && /\bmix(\s+\d+)?\s*$/i.test(String(x?.name || "").trim());
  // Only mixes Spotify has actually shown in the last 30 days. Anything older
  // is one they've stopped offering -- no point rebuilding it weekly.
  const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
  const spotifyMixes = () => {
    try {
      const now = Date.now();
      return (JSON.parse(Spicetify.LocalStorage.get("home-mixes:sources")) || [])
        .filter(isMix).filter((x) => !x.seenAt || now - x.seenAt < RECENT_MS);
    } catch { return []; }
  };

  // --- Reading your listening ------------------------------------------------
  async function myPlaylists() {
    const rl = await P().RootlistAPI.getContents({ limit: 200 });
    return (rl?.items || []).filter((i) => String(i?.uri).includes(":playlist:"));
  }

  async function playlistTracks(uri) {
    const t0 = Date.now();
    const c = await timed(P().PlaylistAPI.getContents(uri), 15000, "reading a playlist");
    logLine(`  read playlist: ${(c?.items || []).length} tracks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return c?.items || [];
  }

  // The extender does NOT page -- any offset above 0 comes back 400. It may
  // hand back a different set on each call though, so ask repeatedly at
  // offset 0 and dedupe. Stop as soon as a call is mostly repeats: at that
  // point each extra call costs a second or two for a handful of tracks.
  let extenderMax = 100;   // drops to 50 for the whole session the first time 100 is refused
  async function recommend(uri, want) {
    const out = [];
    const seen = new Set();
    let limit = Math.min(extenderMax, Math.max(50, want));
    for (let call = 0; call < 3 && out.length < want; call++) {
      let batch;
      const t0 = Date.now();
      try {
        batch = await timed(P().PlaylistAPI.getRecommendedTracks(uri, 0, limit), 20000, "the recommender");
      } catch (e) {
        if (limit > 50) { extenderMax = limit = 50; call--; continue; }
        throw new Error(`recommender refused this playlist (HTTP ${e?.status ?? "?"})`);
      }
      let added = 0;
      for (const t of batch || []) {
        if (t?.uri && !seen.has(t.uri)) { seen.add(t.uri); out.push(t); added++; }
      }
      logLine(`  recommender ×${limit}: +${added} new (${out.length} total) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (added < Math.max(5, (batch?.length || 0) * 0.15)) break;
    }
    return out;
  }

  // Everything we're going to subtract. Tracks by URI, artists by URI/id.
  // Your recent listening and library don't change between one mix and the
  // next, so fetch them once and reuse for a few minutes. Building ten mixes
  // used to mean ten identical 300-track library reads.
  let base = null, baseAt = 0, basePromise = null;
  async function baseKnown() {
    if (base && Date.now() - baseAt < 10 * 60 * 1000) return base;
    if (basePromise) return basePromise;          // parallel builds share one fetch
    basePromise = fetchBase().finally(() => { basePromise = null; });
    return basePromise;
  }
  // 50 recent plays and 300 library tracks was far too small a definition of
  // "you already know this" -- songs someone plays constantly slipped through
  // as new. Your own playlists are the strongest signal there is: you put
  // those there on purpose.
  async function fetchBase() {
    const tracks = new Set(), artists = new Set();
    const note = (t) => {
      if (t?.uri) tracks.add(t.uri);
      (t?.artists || []).forEach((a) => a && artists.add(a.uri || a.id));
    };
    try {   // recently played comes back as bare URI strings -- no artist data
      const recent = await timed(P().AssistedCurationAPI.getRecentlyPlayedTracks({ limit: 50 }), 15000, "recently played");
      (recent || []).forEach((u) => typeof u === "string" && tracks.add(u));
    } catch (e) { logLine("recently-played unavailable: " + e.message); }

    try {   // the whole library, not the first page of it
      for (let off = 0; off < 5000; off += 500) {
        const lib = await timed(P().LibraryAPI.getTracks({ limit: 500, offset: off }), 20000, "your library");
        const items = lib?.items || [];
        items.forEach(note);
        if (items.length < 500) break;
      }
    } catch (e) { logLine("library unavailable: " + e.message); }

    try {   // every track in every playlist you made
      const rl = await timed(P().RootlistAPI.getContents({ limit: 200 }), 15000, "your playlists");
      const mine = (rl?.items || []).filter((x) => String(x?.uri).includes(":playlist:")).slice(0, 60);
      for (const pl of mine) {
        try { (await playlistTracks(pl.uri)).forEach(note); } catch {}
      }
      logLine(`known: read ${mine.length} of your playlists`);
    } catch (e) { logLine("playlists unavailable: " + e.message); }

    base = { tracks, artists }; baseAt = Date.now();
    logLine(`known: ${tracks.size} tracks / ${artists.size} artists you already listen to`);
    return base;
  }

  // Everything we subtract for ONE mix: the shared base plus the source
  // playlist's own tracks and artists -- you asked for songs by OTHER artists
  // that fit, not more of the same ones.
  async function knownStuff(sourceUri, sourceTracks) {
    const b = await baseKnown();
    const tracks = new Set(b.tracks), artists = new Set(b.artists);
    try {
      (sourceTracks || await playlistTracks(sourceUri)).forEach((t) => {
        if (t?.uri) tracks.add(t.uri);
        (t?.artists || []).forEach((a) => a && artists.add(a.uri || a.id));
      });
    } catch (e) { logLine("source playlist unreadable: " + e.message); }
    logLine(`known: ${tracks.size} tracks / ${artists.size} artists`);
    return { tracks, artists };
  }

  // --- The algorithm ---------------------------------------------------------
  const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((p) => p[1]);

  // --- Track metadata ------------------------------------------------------
  // The recommender gives a 0-100 popularity score, which for anything outside
  // your library mostly means "everyone has heard this". GraphQL's getTrack
  // gives two far better numbers: the album's release year, and the actual
  // play count. A release year never changes and a play count barely does, so
  // this is cached permanently -- the first full build pays for it once.
  const META_KEY = "better-mix:trackmeta";
  const meta = (() => {
    try { return new Map(Object.entries(JSON.parse(localStorage.getItem(META_KEY)) || {})); }
    catch { return new Map(); }
  })();
  const saveMeta = () => {
    try {
      // Cap it: 20k tracks is far more than a library's worth of candidates.
      const entries = [...meta.entries()].slice(-20000);
      localStorage.setItem(META_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) { console.warn("[better-mix] couldn't save track metadata", e); }
  };

  async function fetchMeta(uris) {
    const G = Spicetify.GraphQL;
    if (!G?.Definitions?.getTrack) return;
    const missing = [...new Set(uris)].filter((u) => u && !meta.has(u));
    if (!missing.length) return;
    logLine(`  looking up ${missing.length} release dates…`);

    // Every request gets a deadline. Without one, a single call that never
    // resolves hangs the whole build -- and because a build holds the lock,
    // that also blocks every later build until Spotify is reloaded.
    // A ceiling on the whole lookup too, so a slow network degrades the mix
    // rather than stopping it: whatever arrived in time gets used, the rest
    // are treated as unknown and looked up on a later build.
    const deadline = Date.now() + 90_000;
    let done = 0, timedOut = 0;

    // Eight at a time: enough to be quick, gentle enough not to be throttled.
    let i = 0;
    const worker = async () => {
      while (i < missing.length) {
        if (Date.now() > deadline) return;
        const uri = missing[i++];
        try {
          const r = await timed(G.Request(G.Definitions.getTrack, { uri }), 8000, "a release-date lookup");
          const t = r?.data?.trackUnion;
          meta.set(uri, [t?.albumOfTrack?.date?.year ?? null, Number(t?.playcount) || null]);
        } catch (e) {
          if (String(e?.message).includes("timed out")) timedOut++;
          meta.set(uri, [null, null]);   // remember the failure, don't retry every build
        }
        // Save as we go, so a stall or a restart doesn't throw away the work.
        if (++done % 200 === 0) saveMeta();
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    saveMeta();
    if (timedOut) logLine(`  ${timedOut} lookups timed out — those tracks are treated as unknown`);
    if (Date.now() > deadline) logLine("  lookup budget reached; remaining tracks will be filled in on a later build");
  }
  const yearOf = (t) => meta.get(t?.uri)?.[0] ?? null;
  const playsOf = (t) => meta.get(t?.uri)?.[1] ?? null;

  // --- Second source: the artists' own catalogues ---------------------------
  // The recommender hands back ~100 tracks per mix and they are, almost
  // without exception, hits: for a hip hop mix the median track had 641M
  // plays, 36 of 50 were 6-12 years old and none were from the last two
  // years. Ranking can only reorder what's in the pool, and with ~60 usable
  // tracks for 50 slots there was nothing to reorder -- which is also why a
  // rebuild changed three songs at the end and nothing else.
  //
  // So ask for what the recommender never offers: each mix artist's newest
  // releases (album tracks, not the singles you've heard a thousand times)
  // and the newest releases of the artists Spotify lists as related to them,
  // who you mostly won't know. Album pages carry a play count and a year for
  // every track, so these need none of the per-track lookups above.
  const ART_KEY = "better-mix:artists2";  // artist uri -> { at, name, listeners, era, releases:[{uri,year}], related:[uri], top:[track] }
  const ALB_KEY = "better-mix:albums";    // album uri  -> { year, tracks:[...] }
  const loadCache = (k) => { try { return new Map(Object.entries(JSON.parse(localStorage.getItem(k)) || {})); } catch { return new Map(); } };
  const artistCache = loadCache(ART_KEY), albumCache = loadCache(ALB_KEY);
  const saveCache = (k, m, cap) => {
    try { localStorage.setItem(k, JSON.stringify(Object.fromEntries([...m.entries()].slice(-cap)))); }
    catch (e) { console.warn("[better-mix] couldn't save", k, e); }
  };
  const ARTIST_TTL = 7 * 24 * 3600 * 1000;   // a week: new releases show up within days

  // Album tracks don't come with the 0-100 popularity score the recommender
  // gives, but they do come with play counts, which is the better number
  // anyway. Map plays onto the same scale so one ranking serves both sources:
  // 1M plays ~ 30, 10M ~ 45, 100M ~ 60, 1B ~ 75.
  const popFromPlays = (n) => n ? Math.max(0, Math.min(100, Math.round(15 * Math.log10(n) - 60))) : 0;

  const gql = async (name, vars, ms, label) => {
    const G = Spicetify.GraphQL;
    if (!G?.Definitions?.[name]) throw new Error(`Spotify has no ${name} query in this build`);
    return timed(G.Request(G.Definitions[name], vars), ms, label);
  };

  const diag = (patch) => {
    try { localStorage.setItem("better-mix:diag", JSON.stringify({ ...(JSON.parse(localStorage.getItem("better-mix:diag")) || {}), ...patch, at: new Date().toISOString() })); } catch {}
  };

  // Spotify's older artist endpoint, still answered by some clients: one
  // call gives listeners, related artists, releases and top tracks. Tried
  // when the GraphQL artist page fails or comes back without numbers.
  async function artistLegacy(uri) {
    const id = uri.split(":").pop();
    const r = await timed(Spicetify.CosmosAsync.get(`wg://artist/v1/${id}/desktop?format=json`), 10000, "an artist page (legacy)");
    if (!r || typeof r !== "object") throw new Error("legacy artist endpoint returned nothing");
    const rel = (x) => x?.uri ? { uri: x.uri, name: x.name, date: { year: x.year ?? x.release_date?.year ?? null } } : null;
    const releases = [...(r.releases?.albums?.releases || []), ...(r.releases?.singles?.releases || [])].map(rel).filter(Boolean);
    return {
      data: { artistUnion: {
        profile: { name: r.info?.name },
        stats: { monthlyListeners: r.monthly_listeners },
        discography: {
          latest: r.latest_release ? rel(r.latest_release) : null,
          popularReleasesAlbums: { items: releases.slice(0, 5) },
          albums: { items: releases.map((x) => ({ releases: { items: [x] } })) },
          topTracks: { items: (r.top_tracks?.tracks || []).map((t) => ({ track: {
            uri: t.uri, name: t.name, playcount: t.playcount, duration: { totalMilliseconds: t.duration },
            artists: { items: (t.artists || [{ uri, profile: { name: r.info?.name } }]).map((a) => ({ uri: a.uri, profile: { name: a.name } })) },
            albumOfTrack: { uri: t.release?.uri, name: t.release?.name, coverArt: { sources: [{ url: t.release?.cover?.uri }] } },
          } })) },
        },
        relatedContent: { relatedArtists: { items: (r.related_artists?.artists || []).map((a) => ({ uri: a.uri })) } },
      } },
    };
  }

  // What an artist has put out lately, plus who Spotify says is like them.
  async function artistInfo(uri) {
    const c = artistCache.get(uri);
    if (c && Date.now() - c.at < ARTIST_TTL) return c;
    let r, how = "graphql";
    try {
      r = await gql("queryArtistOverview", { uri, locale: "", includePrerelease: false, enableAssociatedVideos: false }, 10000, "an artist page");
      if (!r?.data?.artistUnion?.stats?.monthlyListeners) throw new Error("artist page without listener numbers: keys " + Object.keys(r?.data?.artistUnion || r?.data || r || {}).join(","));
    } catch (e1) {
      try { r = await artistLegacy(uri); how = "legacy"; }
      catch (e2) {
        diag({ artistSource: "failed", graphql: String(e1?.message || e1), legacy: String(e2?.message || e2),
               defs: Object.keys(Spicetify.GraphQL?.Definitions || {}).filter((k) => /artist/i.test(k)).slice(0, 20) });
        throw e1;
      }
    }
    diag({ artistSource: how });
    const a = r?.data?.artistUnion || {};
    // The playlists Spotify says this artist was "discovered on" -- as close
    // to a genre label as the client exposes. Two artists on the same sad-rap
    // playlists share a sound; two who are merely related share a scene.
    let on = [];
    try {
      const d2 = await gql("queryArtistDiscoveredOn", { uri, locale: "" }, 8000, "discovered-on playlists");
      const items = d2?.data?.artistUnion?.relatedContent?.discoveredOnV2?.items || d2?.data?.artistUnion?.relatedContent?.discoveredOn?.items || [];
      on = items.map((it) => it?.data?.uri || it?.uri).filter(Boolean).slice(0, 30);
    } catch (e) { diag({ discoveredOn: String(e?.message || e) }); }
    const d = a.discography || {};
    const rel = (x) => x && x.uri ? { uri: x.uri, year: x.date?.year ?? null, name: x.name } : null;
    const releases = new Map();
    const add = (x) => { const v = rel(x); if (v && !releases.has(v.uri)) releases.set(v.uri, v); };
    add(d.latest);
    (d.popularReleasesAlbums?.items || []).forEach(add);
    for (const g of [d.albums, d.singles, d.compilations]) (g?.items || []).forEach((it) => add(it?.releases?.items?.[0] || it));
    // The artist's own most-played songs: for an artist you don't know,
    // these ARE the semi-popular songs -- what a fan would play you first.
    const image = a.visuals?.avatarImage?.sources?.[0]?.url || null;
    const top = (d.topTracks?.items || []).map((it) => it?.track || it).filter((t) => t?.uri).map((t) => ({
      uri: t.uri, name: t.name,
      duration: t.duration?.totalMilliseconds ?? null,
      artists: (t.artists?.items || []).map((x) => ({ uri: x?.uri, name: x?.profile?.name || x?.name })),
      album: { uri: t.albumOfTrack?.uri, name: t.albumOfTrack?.name, imageUrl: t.albumOfTrack?.coverArt?.sources?.[0]?.url || image, largeImageUrl: t.albumOfTrack?.coverArt?.sources?.slice(-1)?.[0]?.url || image },
      plays: Number(t.playcount) || null,
    }));
    top.length = Math.min(top.length, 10);
    top.forEach((t) => { t.popularity = popFromPlays(t.plays); t.src = "catalogue"; });
    const sorted = [...releases.values()].sort((x, y) => (y.year || 0) - (x.year || 0));
    // When this artist's popular releases came out: their era, roughly.
    const eraYears = (d.popularReleasesAlbums?.items || []).map((x) => x?.date?.year).filter(Boolean).sort((x, y) => x - y);
    const info = {
      at: Date.now(),
      name: a.profile?.name || "",
      listeners: Number(a.stats?.monthlyListeners) || null,
      era: eraYears.length ? eraYears[Math.floor(eraYears.length / 2)] : (sorted[0]?.year ?? null),
      releases: sorted,
      related: (a.relatedContent?.relatedArtists?.items || []).map((x) => x?.uri).filter(Boolean).slice(0, 8),
      on,
      top,
    };
    artistCache.set(uri, info);
    return info;
  }

  async function albumTracks(album) {
    const c = albumCache.get(album.uri);
    if (c) return c.tracks;
    const r = await gql("getAlbum", { uri: album.uri, locale: "", offset: 0, limit: 50 }, 10000, "an album");
    const al = r?.data?.albumUnion || {};
    const items = al.tracksV2?.items || al.tracks?.items || [];
    const year = al.date?.year ?? album.year ?? null;
    const image = al.coverArt?.sources?.[0]?.url || null;
    const tracks = items.map((it) => it?.track || it).filter((t) => t?.uri).map((t) => {
      const plays = Number(t.playcount) || null;
      meta.set(t.uri, [year, plays]);
      return {
        uri: t.uri, name: t.name,
        duration: t.duration?.totalMilliseconds ?? null,
        artists: (t.artists?.items || []).map((x) => ({ uri: x?.uri, name: x?.profile?.name || x?.name })),
        album: { uri: album.uri, name: al.name || album.name, imageUrl: image, largeImageUrl: image },
        popularity: popFromPlays(plays), plays, year, src: "catalogue",
      };
    });
    albumCache.set(album.uri, { year, tracks });
    return tracks;
  }

  // For a handful of the mix's artists and their related artists, the
  // tracks from their few newest releases. Bounded in every direction --
  // artists, releases per artist, time -- because it runs for every mix.
  // Who counts as "similar" to a mix artist: Spotify's related artists, one
  // step out and no further -- walking related-of-related reached Ice Cube
  // and Bone Thugs-N-Harmony from a Travis Scott mix -- and only ones in the
  // same league and era. A Boogie next to Travis Scott, yes; an artist with a
  // hundredth of the listeners, or whose big records are fifteen years
  // older, no. Related artists you already play just get skipped.
  //
  // And only semi-popular songs from anyone: a new artist contributes their
  // most-played tracks, a mix artist their newer album tracks, both with a
  // floor on plays so nothing obscure gets in.
  const MIN_PLAYS = 30_000_000;
  const similar = (league, cand) => {
    if (!cand?.listeners || !league?.listeners) return false;
    if (cand.listeners < Math.max(3_000_000, league.listeners * 0.2)) return false;   // washed / never big
    if (league.era && cand.era && Math.abs(league.era - cand.era) > 6) return false;  // wrong generation
    return true;
  };
  const median = (xs) => { const a = xs.filter(Boolean).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

  // Who belongs in this mix. The mix's own artists, always. Anyone else has
  // to be (a) directly related, per Spotify, to one of them -- that's genre:
  // it keeps Peso Pluma and Taylor Swift out of a rap Daily Mix -- and (b) in
  // the same league and era as the mix's artists are NOW, measured by monthly
  // listeners and when their popular records came out. Warren G, Twista and
  // The Game fail (b) on era; a rapper who fell off fails it on listeners.
  // If Spotify's artist pages come back in a shape without those numbers,
  // the gate switches itself off and says so rather than emptying the mix.
  async function artistGate(candidates, seedInfos, mixArtists) {
    const league = { listeners: median(seedInfos.map((i) => i.listeners)), era: median(seedInfos.map((i) => i.era)) };
    // How many of the mix's artists each outside artist is related to.
    const relatedTo = new Map();
    for (const i of seedInfos) for (const r of i.related || []) relatedTo.set(r, (relatedTo.get(r) || 0) + 1);
    const needRelated = seedInfos.length >= 4 ? 2 : 1;
    // Playlists the mix's artists were discovered on, and how many of them share each.
    const seedOn = new Map();
    for (const i of seedInfos) for (const pl of i.on || []) seedOn.set(pl, (seedOn.get(pl) || 0) + 1);
    const vibeKnown = seedOn.size > 0;
    const sameVibe = (info) => {
      if (!vibeKnown || !(info.on || []).length) return true;   // no data either side: can't judge, don't cut
      const shared = info.on.filter((pl) => seedOn.has(pl)).length;
      return shared >= 2 || shared / info.on.length >= 0.25;
    };
    const on = !!league.listeners;
    const uris = [...new Set(candidates.map((t) => t.artists?.[0]?.uri).filter((u) => u && !mixArtists.has(u)))];
    const verdict = new Map();
    let unrelated = 0, outOfLeague = 0, unknown = 0, ok = 0, offVibe = 0;
    if (on) {
      const deadline = Date.now() + 30000;
      let i = 0;
      const worker = async () => {
        while (i < uris.length && Date.now() < deadline) {
          const u = uris[i++];
          if ((relatedTo.get(u) || 0) < needRelated) { verdict.set(u, false); unrelated++; continue; }
          try {
            const info = await artistInfo(u);
            if (!similar(league, info)) { verdict.set(u, false); outOfLeague++; continue; }
            if (!sameVibe(info)) { verdict.set(u, false); offVibe++; continue; }
            verdict.set(u, true); ok++;
          } catch { verdict.set(u, false); unknown++; }
        }
      };
      await Promise.all(Array.from({ length: 5 }, worker));
      saveCache(ART_KEY, artistCache, 500);
      logLine(`  fit: this mix's league is ~${Math.round(league.listeners / 1e6)}M monthly listeners, era ~${league.era}` +
        ` · ${ok} other artists fit, ${unrelated} related to fewer than ${needRelated} of its artists, ${outOfLeague} wrong league or era` +
        (vibeKnown ? `, ${offVibe} different vibe (no shared playlists)` : " · no discovered-on data, vibe check off") + (unknown ? `, ${unknown} unknown` : ""));
    } else {
      logLine("  fit: no listener numbers from Spotify's artist pages — fit filter off");
    }
    return {
      on,
      fits: (t) => { const u = t?.artists?.[0]?.uri; return !on || !u || mixArtists.has(u) || verdict.get(u) === true; },
    };
  }
  async function catalogueTracks(artistUris, known, { releasesPer = 3, budgetMs = 60000, maxArtists = 40 } = {}) {
    if (!Spicetify.GraphQL?.Definitions) return [];
    const deadline = Date.now() + budgetMs;
    const out = [], seen = new Set();
    let artists = 0, related = 0, albums = 0, cached = 0, failed = 0, skipped = 0, unlike = 0;
    const queue = artistUris.map((uri) => ({ uri, depth: 0 }));
    const visited = new Set(artistUris);
    const names = [], seedInfos = [];
    const take = (t) => { if (t.plays >= MIN_PLAYS && !seen.has(t.uri)) { seen.add(t.uri); out.push(t); } };
    let i = 0;
    const worker = async () => {
      while (i < queue.length && Date.now() < deadline) {
        const { uri, depth } = queue[i++];
        try {
          const info = await artistInfo(uri);
          if (depth === 0) {
            artists++; seedInfos.push(info);
            // a mix artist: their newest releases (albums, EPs and singles
            // alike) plus their most-played songs. What you've already
            // played is removed later, so this is "their songs you haven't".
            info.top.forEach(take);
            for (const rel of info.releases.slice(0, releasesPer)) {
              if (Date.now() > deadline) break;
              if (albumCache.has(rel.uri)) cached++; else albums++;
              (await albumTracks(rel)).forEach(take);
            }
            if (queue.length < maxArtists)
              for (const r of info.related.slice(0, 4)) if (!visited.has(r)) { visited.add(r); queue.push({ uri: r, depth: 1 }); }
          } else {
            if (known.artists.has(uri)) { skipped++; continue; }
            if (!similar({ listeners: median(seedInfos.map((i) => i.listeners)), era: median(seedInfos.map((i) => i.era)) }, info)) { unlike++; continue; }
            related++; names.push(info.name);
            info.top.forEach(take);   // a new artist: their most-played songs
          }
        } catch (e) { failed++; if (failed <= 2) logLine(`  catalogue: ${e?.message || e}`); }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    saveCache(ART_KEY, artistCache, 500); saveCache(ALB_KEY, albumCache, 250); saveMeta();
    logLine(`  catalogue: ${artists} mix artists (${albums + cached} releases, ${cached} cached) + ${related} similar artists` +
      ` (${skipped} related you already play, ${unlike} not similar enough) → ${out.length} tracks over ${MIN_PLAYS / 1e6}M plays` +
      (failed ? ` · ${failed} lookups failed` : "") + (Date.now() > deadline ? " · time budget reached" : ""));
    if (names.length) logLine(`  similar artists: ${names.slice(0, 12).join(", ")}${names.length > 12 ? "…" : ""}`);
    return { tracks: out, seedInfos };
  }

  // --- Ranking ---------------------------------------------------------------
  // Raw popularity was the wrong signal. It measures how much a track is
  // streamed right now, which for a song outside your library mostly means
  // "everyone has heard this" -- decade-old canonical hits and one-hit
  // wonders scored highest, so the mixes filled with songs you knew but
  // never chose. Three corrections:

  // 1. Aim at a popularity BAND, not the top. Big enough to be listenable,
  //    not so big it's unavoidable. Distance outside the band costs points.
  const POP_TARGET = 76;    // where Kendrick, Travis, 21 Savage and Uzi sit; Drake and Kanye are ~82
  const POP_BAND = 6;       // free inside +/- this (70-82), penalised beyond

  // 2. Exclude one-hit wonders outright rather than scoring around them: an
  //    artist with a single track in the pool, and that track a big hit, is a
  //    song everyone knows rather than an artist worth finding. (An earlier
  //    version gave a BONUS for catalogue depth, which backfired -- the
  //    artists with deep catalogues in Spotify's recommendations are exactly
  //    the mainstream ones.)
  const OHW_POP = 70;       // a lone track above this is a famous single
  const POP_FLOOR = 62;     // below this a song is obscure, whoever it's by (The Game, Twista and Cordae live here)
  const UNKNOWN_PENALTY = 18; // no play count on file: don't let it win by default

  // 3. Vary between rebuilds. Scoring was fully deterministic, so pressing
  //    rebuild returned the same songs in the same order every time.
  const JITTER = 7;

  // 4. Penalise by real play count, on a log scale -- the difference between
  //    2M and 20M plays matters, between 800M and 900M doesn't.
  const FAMOUS_FROM = 9.0;   // log10 plays (1B) -- only a song this big is 'unavoidable'; hits are fine
  const FAMOUS_WEIGHT = 12;

  // 5. Spread across eras instead of filtering by age. Nothing is excluded for
  //    being old; a bucket just gets harder to add to as it fills, so one era
  //    can't crowd out the rest. Same mechanism as the cross-mix spread.
  const ERA_PENALTY = 5;
  const eraOf = (t) => {
    const y = yearOf(t);
    if (!y) return "unknown";
    const age = new Date().getFullYear() - y;
    return age <= 2 ? "new" : age <= 5 ? "recent" : age <= 12 ? "older" : "classic";
  };

  // 3. A track already used in another mix costs points, so the same famous
  //    handful doesn't fill everything. Soft, not a ban: genuinely similar
  //    mixes should still share some songs.
  const SPREAD_PENALTY = 12;
  async function buildMix({ sourceUri, sourceName, total, familiarCount, maxPerArtist, used = new Map() }) {
    const source = (await playlistTracks(sourceUri).catch(() => [])).filter((t) => t?.uri).map(normalize);
    logLine("gathering what you already listen to…");
    const known = await knownStuff(sourceUri, source);
    logLine(`source: ${source.length} tracks — e.g. ${source.slice(0, 3).map((t) => `${t.name} — ${(t.artists || []).map((a) => a.name).join(", ")}`).join("  ·  ")}`);

    // Script-based theme guard. Some of Spotify's mixes are defined by language
    // as much as genre -- J-Pop, K-Pop, música mexicana. If most of the source
    // is written in one non-Latin script, a candidate with none of that script
    // anywhere in its title, artist or album is almost certainly an outlier
    // that leaked in from your history, and gets dropped.
    const SCRIPTS = {
      Japanese: /[\u3040-\u30ff\u4e00-\u9fff]/, Korean: /[\uac00-\ud7af\u1100-\u11ff]/,
      Cyrillic: /[\u0400-\u04ff]/, Arabic: /[\u0600-\u06ff]/, Thai: /[\u0e00-\u0e7f]/,
      Hebrew: /[\u0590-\u05ff]/, Greek: /[\u0370-\u03ff]/, Devanagari: /[\u0900-\u097f]/,
    };
    const textOf = (t) => [t?.name, t?.album?.name, ...(t?.artists || []).map((a) => a?.name)].filter(Boolean).join(" ");
    let theme = null, topShare = 0, topName = "";
    if (source.length >= 5) {
      for (const [name, re] of Object.entries(SCRIPTS)) {
        const share = source.filter((t) => re.test(textOf(t))).length / source.length;
        if (share > topShare) { topShare = share; topName = name; }
        if (share >= 0.5 && !theme) theme = { name, re, share };
      }
    }
    logLine(theme
      ? `theme: ${theme.name} script in ${Math.round(theme.share * 100)}% of the source — candidates without it are dropped`
      : `theme: none${topName ? ` (largest non-Latin script share: ${topName} ${Math.round(topShare * 100)}%)` : ""}`);
    const artistKeys = (t) => (t?.artists || []).flatMap((a) => [a?.uri, a?.id, a?.name]).filter(Boolean);
    const sourceArtists = new Set(source.flatMap(artistKeys));
    // The artists this mix is about: whoever is the lead artist on its
    // tracks. Features don't count -- Post Malone on a Taylor Swift song
    // doesn't make Taylor Swift a Daily Mix 1 artist.
    const sourcePrimary = new Set(source.map((t) => t?.artists?.[0]?.uri).filter(Boolean));

    logLine("asking Spotify what fits this playlist…");
    const recommended = await recommend(sourceUri, Math.max(120, total * 4));
    if (!recommended.length) throw new Error("The recommender returned nothing for this playlist.");

    // The artists that define this mix: the ones most present in Spotify's
    // version, plus a few the recommender surfaced that you don't play yet.
    const artistUri = (t) => (t?.artists || []).map((a) => a?.uri).find((u) => typeof u === "string" && u.startsWith("spotify:artist:"));
    const tally = new Map();
    for (const t of source) { const u = artistUri(t); if (u) tally.set(u, (tally.get(u) || 0) + 1); }
    const seeds = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, 12);
    logLine("reading those artists' newer releases and who's similar to them…");
    const cat = await catalogueTracks(seeds, known);
    const catalogue = cat.tracks;
    const seenUri = new Set(recommended.map((t) => t.uri));
    const candidates = recommended.concat(catalogue.filter((t) => !seenUri.has(t.uri) && seenUri.add(t.uri)));
    logLine(`pool: ${recommended.length} from the recommender + ${candidates.length - recommended.length} from catalogues`);
    await fetchMeta(candidates.map((t) => t.uri));
    const { fits, on: gateOn } = await artistGate(candidates, cat.seedInfos, sourcePrimary);

    // Artist-aware script guard. Plenty of Japanese artists release with
    // romanised titles ("Kabutomushi — aiko", "Teenager Forever — King Gnu"),
    // and a plain script test would throw them out with the rap. So an artist
    // counts as on-script if ANY of their tracks in the pool carries the
    // script; a romanised track survives when its artist does. Polo G never
    // has a Japanese-titled song in the pool, so Polo G never survives.
    const scriptArtists = new Set();
    if (theme) for (const t of [...source, ...candidates]) if (theme.re.test(textOf(t))) artistKeys(t).forEach((k) => scriptArtists.add(k));
    let rescued = 0;
    const offTheme = (t) => {
      if (!theme || theme.re.test(textOf(t))) return false;
      if (artistKeys(t).some((k) => scriptArtists.has(k))) { rescued++; return false; }
      return true;
    };

    // Selection, in this order, because a Daily Mix is defined by its
    // artists and should still read that way once rebuilt:
    //   A. the mix's own artists: songs of theirs you haven't played, up to
    //      three each, aimed at the popular end. This is most of the mix.
    //   B. similar artists: related to the mix's artists per Spotify and in
    //      their league now. Capped at a share of the mix, and only when
    //      Spotify's artist data is there to judge "similar" by; without it
    //      the mix stays with its own artists, which is closer to the
    //      original than a guess would be.
    // Anyone else -- an artist you play who isn't in this mix, an artist
    // unrelated to it -- is out, however good the song. That's how rap got
    // into J-Pop and Peso Pluma into an emo-rap mix.
    const SIMILAR_SHARE = 0.3;
    const perArtist = new Map();
    const eraCount = new Map();
    const fresh = [];
    let cutTrack = 0, cutLow = 0, cutTheme = 0, cutCap = 0, cutFit = 0, cutOHW = 0, cutArtist = 0;
    const depth = new Map();
    for (const t of candidates) for (const k of artistKeys(t)) depth.set(k, (depth.get(k) || 0) + 1);
    const depthOf = (t) => Math.max(0, ...artistKeys(t).map((k) => depth.get(k) || 0));
    const oneHitWonder = (t) => depthOf(t) <= 1 && (t.popularity || 0) >= OHW_POP;
    const lead = (t) => t?.artists?.[0]?.uri ?? "?";

    const score = (t) => {
      const pop = t.popularity || 0;
      const outside = Math.max(0, Math.abs(pop - POP_TARGET) - POP_BAND);
      const plays = playsOf(t);
      const famous = plays ? Math.max(0, Math.log10(plays) - FAMOUS_FROM) * FAMOUS_WEIGHT : UNKNOWN_PENALTY;
      return -outside * 2.2
        - famous
        - ERA_PENALTY * (eraCount.get(eraOf(t)) || 0)
        - SPREAD_PENALTY * (used.get(t.uri) || 0)
        + Math.random() * JITTER;
    };
    // Best remaining each pass rather than one sort: a track's score depends
    // on which eras are already in, and the jitter is what makes rebuilds vary.
    const pick = (pool, { cap, limit, why }) => {
      const remaining = pool.slice();
      let n = 0;
      while (remaining.length && fresh.length < total && n < limit) {
        let bi = 0, bs = -Infinity;
        for (let k = 0; k < remaining.length; k++) { const sc = score(remaining[k]); if (sc > bs) { bs = sc; bi = k; } }
        const t = remaining.splice(bi, 1)[0];
        const key = lead(t);
        if ((perArtist.get(key) || 0) >= cap) { cutCap++; continue; }
        perArtist.set(key, (perArtist.get(key) || 0) + 1);
        eraCount.set(eraOf(t), (eraCount.get(eraOf(t)) || 0) + 1);
        t.why = why; t.year = yearOf(t);
        fresh.push(t); n++;
      }
      return n;
    };

    const usable = candidates.filter((t) => {
      if (!t?.uri) return false;
      if (known.tracks.has(t.uri)) { cutTrack++; return false; }
      if (offTheme(t)) { cutTheme++; return false; }
      if ((t.popularity || 0) < POP_FLOOR) { cutLow++; return false; }
      return true;
    });
    const own = usable.filter((t) => sourcePrimary.has(lead(t)));
    const others = usable.filter((t) => !sourcePrimary.has(lead(t)));

    const a = pick(own, { cap: maxPerArtist + 1, limit: total, why: "mix artist" });
    let b = 0;
    if (gateOn) {
      const similarPool = others.filter((t) => {
        if ((t.artists || []).some((x) => known.artists.has(x.uri || x.id))) { cutArtist++; return false; }
        if (!fits(t)) { cutFit++; return false; }
        if (oneHitWonder(t)) { cutOHW++; return false; }
        return true;
      });
      b = pick(similarPool, { cap: maxPerArtist, limit: Math.round(total * SIMILAR_SHARE), why: "similar artist" });
    }

    logLine(`picked ${a} by this mix's artists (${own.length} usable) + ${b} by similar artists` +
      (gateOn ? "" : " (none: no artist data to judge similarity, so the mix keeps to its own artists)"));
    logLine(`  cut: -${cutTrack} already played, -${cutLow} obscure, -${cutCap} over the artist cap` +
      (cutArtist ? `, -${cutArtist} your artists from other mixes` : "") + (cutFit ? `, -${cutFit} unrelated to this mix` : "") +
      (cutOHW ? `, -${cutOHW} one-hit wonders` : "") + (theme ? `, -${cutTheme} off-script (${rescued} romanised tracks kept)` : ""));
    const eras = {};
    fresh.forEach((t) => { const e = eraOf(t); eras[e] = (eras[e] || 0) + 1; });
    logLine("  eras: " + (Object.entries(eras).map(([k, v]) => `${v} ${k}`).join(", ") || "unknown"));
    if (fresh.length < total) logLine(`  ${total - fresh.length} short — filled from Spotify's own mix below`);

    // A few tracks you know, spread through rather than front-loaded -- but
    // only ones whose artist the recommender ALSO returned for this playlist.
    // Spotify's mixes carry a few outliers from your history (a rap track in
    // the J-Pop Mix), and without genre data the recommender's artist set is
    // the best signal there is for what actually fits.
    const onTheme = new Set(candidates.flatMap(artistKeys));
    const familiarPool = source.filter((t) => !offTheme(t) && artistKeys(t).some((k) => onTheme.has(k)));
    const familiar = shuffle(familiarPool).slice(0, familiarCount);
    familiar.forEach((t) => { t.why = "familiar"; });
    logLine(familiar.length
      ? `familiar (${familiarPool.length} eligible): ${familiar.map((t) => `${t.name} — ${(t.artists || []).map((a) => a.name).join(", ")}`).join("  ·  ")}`
      : "familiar: none of this mix's tracks are on-theme by the recommender's artists — none added");
    let out = fresh.slice(0, Math.max(0, total - familiar.length));
    if (!out.length && !familiar.length && !source.length)
      throw new Error("no candidates and no source tracks — nothing to build from");

    // Last resort: the recommender is capped at ~100 candidates per playlist,
    // and for a mix whose artists you almost all know, very few survive. Rather
    // than hand back 38 songs, fill from Spotify's own version of the mix --
    // songs that belong there, just ones you've heard. Tagged so it's visible
    // on the page which part of a mix this is.
    const want = total - familiar.length;
    if (out.length < want) {
      const have = new Set([...out, ...familiar].map((t) => t.uri));
      // Same cap as every other stage; a mix that comes up short is logged,
      // and it beats one artist taking a quarter of the tracklist.
      const added = [];
      for (const t of shuffle(source.filter((t) => t?.uri && !have.has(t.uri) && !offTheme(t)))) {
        if (out.length + added.length >= want) break;
        const key = t.artists?.[0]?.uri ?? "?";
        if ((perArtist.get(key) || 0) >= maxPerArtist + 1) continue;
        perArtist.set(key, (perArtist.get(key) || 0) + 1);
        t.why = "from the original mix"; added.push(t);
      }
      if (out.length + added.length < want)
        logLine(`short by ${want - out.length - added.length}: nothing left under the ${maxPerArtist + 1}-per-artist cap`);
      out = out.concat(added);
      if (added.length) logLine(`filled the last ${added.length} from Spotify's own ${sourceName || "mix"}`);
    }
    // Mix up the running order. Built in stages, the list came out grouped:
    // the strict picks, then the same-artist top-ups with each artist's
    // songs side by side. Shuffle, then push apart any two neighbours by the
    // same artist so it plays like a mix rather than a discography.
    out = shuffle(out);
    const who = (t) => t?.artists?.[0]?.uri || t?.artists?.[0]?.name || "?";
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < out.length; i++) {
        if (who(out[i]) !== who(out[i - 1])) continue;
        const j = out.findIndex((t, k) => k > i && who(t) !== who(out[i - 1]) && (k + 1 >= out.length || who(out[k + 1]) !== who(out[i])));
        if (j > 0) [out[i], out[j]] = [out[j], out[i]];
      }
    }
    familiar.forEach((t, i) =>
      out.splice(Math.floor(((i + 1) * out.length) / (familiar.length + 1)), 0, t)
    );
    return out;
  }

  // --- Writing the playlist --------------------------------------------------
  // Reuse one playlist per source rather than creating a new one every run.
  // Otherwise ten runs leaves ten near-identical playlists in your library --
  // and anything linking to the mix (the Home row) points at a stale one.
  async function saveMix(name, tracks) {
    const existing = (await myPlaylists()).find((p) => p.name === name);
    let uri = existing?.uri;

    if (uri) {
      logLine("refreshing the existing playlist…");
      const old = await playlistTracks(uri);
      if (old.length) {
        // remove() wants positions, not URIs -- clear from the end so earlier
        // indices stay valid as we go.
        await P().PlaylistAPI.remove(uri, old.map((t, i) => ({ uri: t.uri, uid: t.uid, index: i })).reverse());
      }
    } else {
      logLine("creating the playlist…");
      const made = await P().RootlistAPI.createPlaylist(name, {});
      uri = typeof made === "string" ? made : made?.uri;
      if (!uri) throw new Error("createPlaylist returned nothing usable: " + JSON.stringify(made));
    }

    await P().PlaylistAPI.add(uri, tracks.map((t) => t.uri), {});
    return uri;
  }

  // --- The virtual store --------------------------------------------------------
  // Built mixes live here, in this client's storage, NOT as Spotify playlists.
  // home-mixes.js draws its row from this and plays straight from it. Nothing
  // reaches your library unless you save one. This file is the only writer.
  // One rebuild at a time, held by rebuildThese so it covers the manual button
  // as well as the automatic runs. Before, only the automatic path took it, so
  // pressing Rebuild while a scheduled build ran gave two runs sharing one
  // progress counter ("120 of 87") -- and two snapshots of the store written
  // back over each other, losing mixes.
  let building = false;
  const VIRT_KEY = "better-mix:virtual";
  const readVirtual = () => { try { return JSON.parse(localStorage.getItem(VIRT_KEY)) || []; } catch { return []; } };
  const writeVirtual = (list) => {
    const json = JSON.stringify(list);
    try { localStorage.setItem(VIRT_KEY, json); }
    catch (e) {
      // Spotify's storage is ~10MB per origin. The mixes matter more than
      // any cache: throw the caches away and try once more. Without this a
      // full store meant every build silently vanished and the next trigger
      // rebuilt everything, again and again.
      console.warn("[better-mix] store write failed — clearing caches and retrying", e?.name || e);
      for (const k of ["better-mix:albums", "better-mix:artists2", "better-mix:artists", "better-mix:trackmeta"]) { try { localStorage.removeItem(k); } catch {} }
      try { localStorage.setItem(VIRT_KEY, json); }
      catch (e2) { Spicetify.showNotification("Better Mix: Spotify's storage is full — mixes can't be saved", true); console.error("[better-mix] store write failed twice", e2); }
    }
    window.dispatchEvent(new Event("better-mix:updated"));
  };
  // PlaylistAPI.getContents items aren't shaped like recommender tracks:
  // duration is {milliseconds}, art is album.images[]. Flatten to one shape so
  // a familiar track gets a cover and a time like everything else -- without
  // this they showed as a grey square and "NaN:NaN".
  const normalize = (t) => ({
    ...t,
    duration: typeof t?.duration === "object" ? (t.duration?.milliseconds ?? null) : (t?.duration ?? null),
    album: {
      ...(t?.album || {}),
      imageUrl: t?.album?.imageUrl || t?.album?.images?.[0]?.url || t?.album?.image || null,
      largeImageUrl: t?.album?.largeImageUrl || t?.album?.images?.slice(-1)?.[0]?.url || null,
    },
  });

  // Keep only what a card needs. Full track objects x 30 mixes would bloat
  // localStorage for no benefit.
  const slim = (t) => ({
    uri: t.uri, name: t.name,
    duration: t.duration ?? null,                                   // for the page's clock column
    artists: (t.artists || []).map((a) => ({ name: a.name, uri: a.uri || null })),
    album: { name: t.album?.name || "", uri: t.album?.uri || null },
    image: t.album?.imageUrl || t.album?.largeImageUrl || null,
    popularity: t.popularity ?? null,
    year: t.year ?? null,
    why: t.why || null,       // which rule let it in -- so a bad pick is traceable
    src: t.src || "rec",      // recommender, or an artist's catalogue
    plays: t.plays ?? playsOf(t) ?? null,
  });

  // Play a virtual mix as its own CONTEXT -- the whole tracklist handed to the
  // player in one call, the way a playlist plays -- instead of queueing.
  // Queueing works, but Spotify toasts "Added to queue" from inside its own
  // queue code (nothing here can silence it), and prev/next don't treat the
  // mix as one thing. The context uri is a label; the tracks come from `pages`.
  //
  // Which shapes this client accepts isn't documented, so try the cleanest
  // first and VERIFY playback actually started on the expected track before
  // trusting any of them. The queue is the last resort.
  // Shuffle is a sticky preference, like Spotify's. Kept separate from the
  // build settings: this is about playback, not what goes in a mix.
  const SHUF_KEY = "better-mix:shuffle";
  const getShuffle = () => { try { return localStorage.getItem(SHUF_KEY) === "true"; } catch { return false; } };
  const setShuffle = (v) => { try { localStorage.setItem(SHUF_KEY, String(!!v)); } catch {} };

  // opts.order lets the page play what's on screen -- sorted or filtered --
  // rather than the mix's stored order.
  async function play(mix, startAt = 0, opts = {}) {
    let all = (opts.order || (mix?.tracks || []).map((t) => t.uri)).filter(Boolean);
    if (!all.length) return;
    // With shuffle on, the track you clicked still plays first and the rest
    // are randomised behind it -- what Spotify does when you pick a song in
    // a shuffled playlist.
    if (opts.shuffle ?? getShuffle()) {
      const first = all[startAt] ?? all[0];
      all = [first, ...shuffle(all.filter((_, i) => i !== startAt))];
      startAt = 0;
    }
    const PA = P().PlayerAPI;
    const pages = (uris) => ({ pages: [{ items: uris.map((uri) => ({ uri })) }] });
    const want = all[startAt] || all[0];
    const startedOn = async (uri) => {
      await new Promise((r) => setTimeout(r, 700));
      return Spicetify.Player.data?.item?.uri === uri;
    };

    const labels = ["spotify:app:better-mix", mix.savedUri, mix.sourceUri].filter(Boolean);
    for (const uri of labels) {
      const attempts = [
        ["skipTo", () => PA.play({ uri, ...pages(all) }, {}, { skipTo: { index: startAt } })],
        ["sliced", () => PA.play({ uri, ...pages(all.slice(startAt)) }, {}, {})],
      ];
      for (const [how, go] of attempts) {
        try {
          await go();
          if (await startedOn(want)) { Spicetify.showNotification(`Playing ${mix.name}`); return; }
          console.warn(`[better-mix] context play (${how}, ${uri}) didn't start the expected track`);
        } catch (e) {
          console.warn(`[better-mix] context play (${how}, ${uri}) refused:`, e?.message || e);
        }
      }
    }

    // Last resort: first track directly, the rest queued. Spotify will toast.
    console.warn("[better-mix] falling back to the queue");
    const uris = all.slice(startAt);
    try { await PA.clearQueue?.(); } catch {}
    await Spicetify.Player.playUri(uris[0]);
    const rest = uris.slice(1).map((uri) => ({ uri }));
    if (rest.length) { try { await PA.addToQueue(rest); } catch (e) { console.warn("[better-mix] couldn't queue the rest:", e); } }
    Spicetify.showNotification(`Playing ${mix.name}`);
  }

  // Spotify already sorts these by mood and activity -- Chill Happy, Driving,
  // Melancholy. Reusing their grouping is far better than trying to cluster
  // your library into moods, and the names come out meaningful for free.
  // Failures by source, so the Home row can show "couldn't build" with the
  // reason instead of a placeholder that looks like work in progress forever.
  // Written here (this file owns every better-mix:* key), read by the rows.
  const FAIL_KEY = "better-mix:failed";
  const readFailed = () => { try { return JSON.parse(localStorage.getItem(FAIL_KEY)) || {}; } catch { return {}; } };
  const noteFailure = (uri, name, reason) => {
    const f = readFailed(); f[uri] = { name, reason, at: new Date().toISOString() };
    try { localStorage.setItem(FAIL_KEY, JSON.stringify(f)); } catch {}
    window.dispatchEvent(new Event("better-mix:updated"));
  };
  const clearFailure = (uri) => {
    const f = readFailed(); if (!(uri in f)) return;
    delete f[uri];
    try { localStorage.setItem(FAIL_KEY, JSON.stringify(f)); } catch {}
  };

  let progress = { active: false, done: 0, total: 0, current: [] };
  const emitProgress = () => window.dispatchEvent(new CustomEvent("better-mix:progress", { detail: { ...progress } }));
  const fmtSecs = (ms) => { const x = Math.round(ms / 1000); return x >= 60 ? `${Math.floor(x / 60)}m ${x % 60}s` : `${x}s`; };

  async function rebuildThese(mixes, { total, familiarCount, maxPerArtist }, { concurrency = 1 } = {}) {
    if (building) throw new Error("A rebuild is already running — let it finish.");
    building = true;
    try {
    const store = readVirtual();
    // Seeded from the mixes that already exist, so rebuilding a few spreads
    // away from the rest rather than re-concentrating on the same songs.
    const rebuilding = new Set(mixes.map((m) => m.uri));
    const used = new Map();
    for (const e of store) {
      if (rebuilding.has(e.sourceUri)) continue;
      for (const t of e.tracks || []) used.set(t.uri, (used.get(t.uri) || 0) + 1);
    }
    const done = [];
    const t0 = Date.now();
    let next = 0;
    progress = { active: true, done: 0, total: mixes.length, current: [] }; emitProgress();

    // A small worker pool: the internal APIs handle two builds at once fine,
    // and it roughly halves a big morning run.
    const worker = async () => {
      while (next < mixes.length) {
        const m = mixes[next++];
        const t1 = Date.now();
        progress.current.push(m.name); emitProgress();
        logLine(`\n=== ${m.name} ===`);
        try {
          const tracks = await timed(
            buildMix({ sourceUri: m.uri, sourceName: m.name, total, familiarCount, maxPerArtist, used }),
            4 * 60 * 1000, `building ${m.name}`);
          tracks.forEach((t) => used.set(t.uri, (used.get(t.uri) || 0) + 1));
          const name = "Better " + m.name.replace(/^better\s+/i, "");
          const prev = store.find((x) => x.sourceUri === m.uri);
          const entry = {
            id: prev?.id || ("bm-" + String(m.uri).split(":").pop()),
            name, sourceUri: m.uri, sourceName: m.name,
            builtAt: new Date().toISOString(),
            rules: RULES_VERSION,
            savedUri: prev?.savedUri || null,        // a saved one stays saved
            tracks: tracks.map(slim),
          };
          if (prev) Object.assign(prev, entry); else store.push(entry);
          writeVirtual(store);                       // the row updates after each one
          const byWhy = {};
          tracks.forEach((t) => { byWhy[t.why || "?"] = (byWhy[t.why || "?"] || 0) + 1; });
          logLine(`built "${name}" (${tracks.length} tracks) in ${fmtSecs(Date.now() - t1)}: ` +
            Object.entries(byWhy).map(([k, v]) => `${v} ${k}`).join(", "));
          done.push(name);
          clearFailure(m.uri);
        } catch (e) {
          const where = e?.requestUrl ? ` at ${String(e.requestUrl).split("/").slice(-2).join("/")}` : "";
          const reason = `${e?.message || e?.name || e}${e?.status ? ` (HTTP ${e.status})` : ""}${where}`;
          logLine(`skipped — ${reason}`);
          noteFailure(m.uri, m.name, reason);
        } finally {
          progress.done++; progress.current = progress.current.filter((n) => n !== m.name); emitProgress();
        }
        if (next < mixes.length) await sleep(300);   // let the UI breathe between mixes
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, mixes.length)) }, worker));

    progress = { active: false, done: mixes.length, total: mixes.length, current: [] }; emitProgress();
    logLine(`\ndone: ${done.length}/${mixes.length} mixes in ${fmtSecs(Date.now() - t0)}`);
    return done;
    } finally {
      building = false;
      progress = { ...progress, active: false }; emitProgress();   // never leave the counter spinning
    }
  }

  // "Rebuild all": the mixes on your Home page first, then everything else
  // recorded. Previously this took the first N ever recorded, which usually
  // didn't include the one you were looking at.
  async function rebuildAll({ limit, ...opts }) {
    const cur = readCurrent();
    const pool = [...cur, ...spotifyMixes().filter((m) => !cur.some((c) => c.uri === m.uri))];
    const mixes = pool.slice(0, limit);
    if (!mixes.length) throw new Error("No Spotify mixes recorded yet — open Home once so home-mixes can see them.");
    return rebuildThese(mixes, opts);
  }

  // Rebuild exactly one mix, by its Spotify source. The mix page's button.
  async function rebuildOne(sourceUri) {
    const m = readCurrent().find((x) => x.uri === sourceUri)
      || spotifyMixes().find((x) => x.uri === sourceUri)
      || readVirtual().filter((x) => x.sourceUri === sourceUri).map((x) => ({ uri: x.sourceUri, name: x.sourceName }))[0];
    if (!m) throw new Error("That mix's Spotify source isn't recorded");
    const prevLog = logLine;
    logLine = (t) => console.log("[better-mix]", t);
    try { return await rebuildThese([m], settings()); }
    finally { logLine = prevLog; }
  }

  // --- Automatic ---------------------------------------------------------------
  // No button. home-mixes.js writes the mixes currently on your Home page to
  // "home-mixes:current" whenever it hides Spotify's row; anything in that
  // list that isn't built yet, or is older than a day, gets built here in the
  // background. Spotify refreshes its mixes daily, so a day is the right
  // staleness -- rebuilding more often just burns requests for the same input.
  const CUR_KEY = "home-mixes:current";

  // The off switch. Off means no automatic builds -- startup, daily, or when
  // Home changes. Manual rebuilds and the pages still work; existing mixes
  // stay. Separate from home-mixes' toggle, which controls the Home rows.
  const ENABLED_KEY = "better-mix:enabled";
  let enabled = (() => { try { return localStorage.getItem(ENABLED_KEY) !== "false"; } catch { return true; } })();
  // Bump when the selection rules change. Mixes built under older rules get
  // rebuilt automatically at the next startup instead of waiting a day.
  const RULES_VERSION = 16;  // 16: similar = related to 2+ of the mix's artists and sharing their playlists
  const readCurrent = () => { try { return JSON.parse(localStorage.getItem(CUR_KEY)) || []; } catch { return []; } };

  // Keep the store bounded. It was 1.5 MB at 78 mixes and grew with every
  // mix Spotify ever showed, rewritten on every build. A mix whose source
  // hasn't been on Home in 30 days is dropped unless it was saved; a hard cap
  // on unsaved entries, newest first, is the backstop.
  const STORE_CAP = 120;
  function pruneStore(reason) {
    const store = readVirtual();
    const live = new Set([...spotifyMixes().map((m) => m.uri), ...readCurrent().map((m) => m.uri)]);
    let kept = store.filter((e) => e.savedUri || live.has(e.sourceUri));
    const unsaved = kept.filter((e) => !e.savedUri).sort((a, b) => Date.parse(b.builtAt || 0) - Date.parse(a.builtAt || 0));
    if (unsaved.length > STORE_CAP) {
      const drop = new Set(unsaved.slice(STORE_CAP).map((e) => e.id));
      kept = kept.filter((e) => !drop.has(e.id));
    }
    if (kept.length !== store.length) {
      console.log(`[better-mix] pruned ${store.length - kept.length} stale mix(es) — ${reason}`);
      writeVirtual(kept);
    }
  }

  // Two tiers, no button anywhere:
  //   daily  -- the six Daily Mixes plus whatever Spotify is showing on Home
  //             right now (10-12 mixes): rebuilt at the first startup of each
  //             calendar day, matching Spotify's overnight refresh.
  //   weekly -- the rest of Spotify's catalogue (the "Made for you" hub has
  //             60+): rebuilt when a week old. You only meet these via Show
  //             all, so refreshing them daily was work nobody would see.
  // "Stale" is calendar-based for the daily tier: built on a different local
  // day than today. An hourly check catches the day rolling over while
  // Spotify stays open.
  const today = () => new Date().toDateString();
  const builtToday = (e) => !!e?.builtAt && new Date(e.builtAt).toDateString() === today();
  const dailyNum = (m) => parseInt(String(m.name).replace(/\D/g, ""), 10) || 0;
  const dailyMixes = () => spotifyMixes().filter((m) => /^daily mix/i.test(m.name)).sort((a, b) => dailyNum(a) - dailyNum(b));

  let lastPassAt = 0;
  async function autoBuild(reason) {
    if (!enabled || building) return;
    // The Home page re-renders after every build, and each re-render says
    // "Home changed". If the pass that just finished didn't stick, that
    // would start it over immediately, forever. Once per quarter hour.
    if (reason === "Home changed" && Date.now() - lastPassAt < 15 * 60 * 1000) return;
    const store = readVirtual();
    const entry = (m) => store.find((x) => x.sourceUri === m.uri);
    const seen = new Set();
    const take = (list) => list.filter((m) => !seen.has(m.uri) && seen.add(m.uri));
    const visible = take([...dailyMixes(), ...readCurrent()]);   // daily tier
    const rest = take(spotifyMixes());                           // weekly tier
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const dueDaily = visible.filter((m) => { const e = entry(m); return !e || e.rules !== RULES_VERSION || !builtToday(e); });
    const dueWeekly = rest.filter((m) => { const e = entry(m); return !e || e.rules !== RULES_VERSION || Date.now() - Date.parse(e.builtAt || 0) > WEEK; });
    const due = [...dueDaily, ...dueWeekly];
    if (!due.length) return;
    console.log(`[better-mix] auto-building ${due.length} mixes (${dueDaily.length} daily-tier, ${dueWeekly.length} weekly-tier) — ${reason}: ${due.map((m) => m.name).join(", ")}`);
    lastPassAt = Date.now();
    Spicetify.showNotification(`Building today's mixes (${due.length}) — a few minutes in the background`);
    const prevLog = logLine;
    logLine = (m) => console.log("[better-mix]", m);
    try { await rebuildThese(due, settings(), { concurrency: 2 }); Spicetify.showNotification("Today's mixes are ready"); }
    catch (e) { console.warn("[better-mix] auto-build failed:", e); }
    finally { logLine = prevLog; pruneStore("after build"); }
  }
  window.addEventListener("home-mixes:current", () => autoBuild("Home changed"));
  setInterval(() => autoBuild("daily refresh"), 60 * 60 * 1000);
  setTimeout(() => { pruneStore("startup"); autoBuild("startup"); }, 4000);

  // Undo a save: take the playlist out of your library and unlink it, so the
  // card goes back to offering "save". Without this, saving was one-way --
  // the button turned into "open" and there was no way back.
  async function unsaveVirtual(id) {
    const store = readVirtual();
    const entry = store.find((x) => x.id === id);
    if (!entry?.savedUri) return;
    // remove() maps over its argument as `x.uid ?? x.uri`, so it wants
    // objects, not URI strings. Passing strings yielded [undefined], the
    // modification failed, and Spotify reverted its own optimistic removal --
    // the playlist reappearing was their rollback, not ours.
    const uri = entry.savedUri;
    try {
      await P().RootlistAPI.remove([{ uri }]);
      // remove() swallows its own failures, so confirm rather than assume.
      const still = await P().RootlistAPI.contains(uri).catch(() => null);
      if (Array.isArray(still) ? still[0] : still) {
        throw new Error("Spotify kept the playlist in your library");
      }
    } catch (e) {
      console.warn("[better-mix] couldn't remove the playlist:", e);
      throw new Error("couldn't remove it from your library — unlinking it here instead");
    } finally {
      // Either way stop calling it saved: a link to a playlist that may no
      // longer exist is worse than no link.
      entry.savedUri = null;
      writeVirtual(store);
    }
  }

  // Promote a virtual mix to a real playlist. Called from the card's "save".
  async function saveVirtual(id) {
    const store = readVirtual();
    const entry = store.find((x) => x.id === id);
    if (!entry) throw new Error("mix not found");
    const uri = await saveMix(entry.name, entry.tracks);
    entry.savedUri = uri;
    writeVirtual(store);
    return uri;
  }

  // --- UI --------------------------------------------------------------------
  async function openMenu(preselect) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<pre class="bmx-log" id="bmx-log">loading your playlists…</pre>`;
    Spicetify.PopupModal.display({ title: "Better Mix", content: wrap, isLarge: true });

    let lists = [];
    try { lists = await myPlaylists(); }
    catch (e) { wrap.querySelector("#bmx-log").textContent = "Couldn't read your playlists: " + e.message; return; }

    const st = settings();
    wrap.innerHTML = `
      <div class="bmx-row">
        <label style="flex:1 1 260px">Base it on
          <select class="bmx-in" id="bmx-src">
            ${lists.map((p) => `<option value="${p.uri}"${p.uri === preselect ? " selected" : ""}>${(p.name || p.uri).replace(/</g, "&lt;")}</option>`).join("")}
          </select>
        </label>
        <label>Size <input class="bmx-in" id="bmx-total" type="number" min="5" max="100" value="${st.total}"></label>
        <label>Ones you know <input class="bmx-in" id="bmx-fam" type="number" min="0" max="20" value="${st.familiarCount}"></label>
        <label>Max per artist <input class="bmx-in" id="bmx-cap" type="number" min="1" max="5" value="${st.maxPerArtist}"></label>
        <label>How many mixes <input class="bmx-in" id="bmx-count" type="number" min="1" max="200" value="${spotifyMixes().length || 5}"></label>
      </div>
      <div class="bmx-actions">
        <button class="bmx-btn" id="bmx-preview">Preview</button>
        <button class="bmx-btn" id="bmx-create">Create from this playlist</button>
        <button class="bmx-btn bmx-primary" id="bmx-all">Rebuild all now (${spotifyMixes().length})</button>
      </div>
      <pre class="bmx-log" id="bmx-log"></pre>`;

    const logEl = wrap.querySelector("#bmx-log");
    logLine = (m) => { logEl.textContent += m + "\n"; logEl.scrollTop = logEl.scrollHeight; };
    const val = (id) => wrap.querySelector(id).value;

    const run = async (create) => {
      logEl.textContent = "";
      wrap.querySelectorAll("button").forEach((b) => (b.disabled = true));
      saveSettings({ total: +val("#bmx-total"), familiarCount: +val("#bmx-fam"), maxPerArtist: +val("#bmx-cap") });
      try {
        const tracks = await buildMix({
          sourceUri: val("#bmx-src"),
          sourceName: lists.find((p) => p.uri === val("#bmx-src"))?.name,
          total: +val("#bmx-total"),
          familiarCount: +val("#bmx-fam"),
          maxPerArtist: +val("#bmx-cap"),
        });
        logLine("");
        tracks.forEach((t, i) =>
          logLine(`${String(i + 1).padStart(2)}. ${t.name} — ${(t.artists || []).map((a) => a.name).join(", ")}${t.popularity ? `  (${t.popularity})` : ""}${t.why ? `  [${t.why}]` : ""}`)
        );
        if (create) {
          const name = "Better Mix — " + (lists.find((p) => p.uri === val("#bmx-src"))?.name || "mix");
          logLine("\ncreating playlist…");
          await saveMix(name, tracks);
          logLine("done — check your library");
          Spicetify.showNotification("Better Mix created");
        }
      } catch (e) {
        logLine("\n" + (e?.message || e));
      } finally {
        wrap.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };

    wrap.querySelector("#bmx-preview").onclick = () => run(false);
    wrap.querySelector("#bmx-create").onclick = () => run(true);
    wrap.querySelector("#bmx-all").onclick = async () => {
      logEl.textContent = "";
      wrap.querySelectorAll("button").forEach((b) => (b.disabled = true));
      saveSettings({ total: +val("#bmx-total"), familiarCount: +val("#bmx-fam"), maxPerArtist: +val("#bmx-cap") });
      try {
        const made = await rebuildAll({
          limit: +val("#bmx-count"),
          total: +val("#bmx-total"),
          familiarCount: +val("#bmx-fam"),
          maxPerArtist: +val("#bmx-cap"),
        });
        logLine(`\ndone — ${made.length} mixes built. They're on your Home page; nothing was saved to your library.`);
        Spicetify.showNotification(`Built ${made.length} mixes`);
      } catch (e) {
        logLine("\n" + (e?.message || e));
      } finally {
        wrap.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };
  }

  const M = '.GenericModal[aria-label="Better Mix"]';
  const css = document.createElement("style");
  css.textContent = `
    ${M} { width: min(700px, 94vw); }
    ${M} .main-trackCreditsModal-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:20px 24px 10px; }
    ${M} .main-trackCreditsModal-header h1 { margin:0; font-size:20px; font-weight:700; }
    ${M} .main-trackCreditsModal-closeBtn { flex:0 0 32px; width:32px; height:32px; display:inline-flex; align-items:center; justify-content:center; margin:0; padding:0; border:0; border-radius:50%; background:transparent; color:var(--spice-subtext,#b3b3b3); cursor:pointer; }
    ${M} .main-trackCreditsModal-closeBtn:hover { background:rgba(255,255,255,.1); color:var(--spice-text,#fff); }
    ${M} .main-trackCreditsModal-closeBtn svg { display:block; width:14px; height:14px; }
    ${M} .main-trackCreditsModal-originalCredits { padding:6px 24px 24px; }
    .bmx-row { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end; }
    .bmx-row label { display:flex; flex-direction:column; gap:6px; font-size:12px; color:var(--spice-subtext,#b3b3b3); }
    .bmx-in { padding:9px 10px; border-radius:8px; border:1px solid var(--spice-misc,#555); background:transparent; color:var(--spice-text,#fff); font-size:14px; max-width:100%; }
    .bmx-in:focus { outline:none; border-color:var(--spice-button,#1ed760); }
    .bmx-actions { display:flex; gap:10px; margin:4px 0 14px; }
    .bmx-btn { padding:10px 16px; border-radius:8px; border:1px solid var(--spice-misc,#555); background:transparent; color:var(--spice-text,#fff); font-size:14px; font-weight:600; cursor:pointer; }
    .bmx-btn:hover:not(:disabled) { border-color:var(--spice-button,#1ed760); background:rgba(255,255,255,.06); }
    .bmx-btn:disabled { opacity:.5; cursor:default; }
    .bmx-primary { border-color:var(--spice-button,#1ed760); color:var(--spice-button,#1ed760); }
    .bmx-log { max-height:340px; overflow:auto; margin:0; padding:12px; border-radius:8px; background:rgba(255,255,255,.04); color:var(--spice-text,#fff); font-size:12px; line-height:1.5; white-space:pre-wrap; }
    .bmx-playbar-btn { display:flex; align-items:center; justify-content:center; }
    .bmx-playbar-btn svg { display:block; }
  `;
  document.head.appendChild(css);

  // No play-bar button: everything is automatic. Settings live on the Better
  // Mix page (sidebar) and the right-click entry below stays for one-offs.
  // Profile-menu toggle for the automatic builds.
  if (Spicetify.Menu) {
    try {
      new Spicetify.Menu.Item("Build better mixes automatically", enabled, (self) => {
        enabled = !enabled;
        self.setState(enabled);
        try { localStorage.setItem(ENABLED_KEY, String(enabled)); } catch {}
        Spicetify.showNotification(enabled ? "Automatic mixes on" : "Automatic mixes off — existing mixes stay");
        if (enabled) autoBuild("switched on");
      }).register();
    } catch (e) { console.warn("[better-mix] profile-menu toggle unavailable:", e); }
  }

  // Right-click a playlist -> build from it directly. The playlist you clicked
  // IS the input, so this skips the picker entirely.
  if (Spicetify.ContextMenu) {
    new Spicetify.ContextMenu.Item(
      "Better Mix from this",
      (uris) => openMenu(uris?.[0]),
      (uris) => uris?.length === 1 && String(uris[0]).includes(":playlist:"),
      "enhance"
    ).register();
  }

  // Shared surface for home-mixes.js (and for poking at from the console).
  window.BetterMix = { ready: true, version: VERSION, rules: RULES_VERSION, open: () => openMenu(), rebuildAll, rebuildOne, saveVirtual, unsaveVirtual, play,
    getShuffle, setShuffle, virtual: readVirtual, get progress() { return { ...progress }; },
    get diag() { try { return JSON.parse(localStorage.getItem("better-mix:diag")); } catch { return null; } } };

  console.log(`[better-mix] loaded — ${readVirtual().length} mixes in store`);
  } catch (e) {
    window.__betterMixError = e?.message || String(e);
    console.error("[better-mix] init FAILED:", e);
  }
})();


// ############################## 2. THE HOME ROWS ##############################
// ============================================================================
// home-mixes.js — hide Spotify's mix shelves, show your own instead
// ----------------------------------------------------------------------------
// Spotify's mix rows are server-rendered and read-only: you cannot put your
// own tracks in them. So this hides them and draws a row of YOUR mixes in
// their place.
//
// Your mixes are VIRTUAL. They live in this client's storage, built by
// better-mix.js, and clicking one plays it straight from that list -- no
// playlist is ever saved unless you hit "save" on a card. That keeps your
// library clean; the trade is that a virtual mix can't be seen from your
// phone until you save it.
//
// HOW SPOTIFY'S MIXES ARE FOUND:
// By the playlists themselves, not the shelf heading -- Spotify-generated id
// prefix plus "Mix" in the name. Headings change with the day ("Soundtrack
// your Tuesday evening"), so anything keyed on them would break by Wednesday.
// ============================================================================

(function homeMixes() {
  const SRC_KEY  = "home-mixes:sources";   // Spotify mixes we've seen (written here)
  const VIRT_KEY = "better-mix:virtual";   // your built mixes (written by better-mix.js)

  // Defined BEFORE anything else, reading raw localStorage so it needs no
  // Spicetify at all. A diagnostic that only exists once the thing it
  // diagnoses is working isn't much of a diagnostic.
  window.homeSources ||= () => {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(SRC_KEY)) || []; } catch {}
    console.log(`[home-mixes] ${window.__homeMixesReady ? "ready" : "still initialising — give it a few seconds"} · ${rows.length} Spotify mixes recorded`);
    console.table(rows);
    return rows;
  };

  // Every console helper exists from the first tick and delegates to the real
  // implementation once init has run. Until then -- or if init threw -- they
  // say so, instead of being undefined and looking like the file never loaded.
  const notReady = (name) => () =>
    console.warn(`[home-mixes] ${name}: not initialised yet` + (window.__homeMixesError ? ` — init failed: ${window.__homeMixesError}` : ""));
  const api = () => window.__homeMixesApi;
  window.homeHide   ||= (...p) => (api() ? api().hide(...p)   : notReady("homeHide")());
  window.homeHide.reset ||= () => (api() ? api().reset()      : notReady("homeHide.reset")());
  window.homeShelves ||= ()  => (api() ? api().shelves()      : notReady("homeShelves")());
  window.homeRescan  ||= ()  => (api() ? api().rescan()       : notReady("homeRescan")());
  window.homeMixes   ||= ()  => (api() ? api().mixes()        : notReady("homeMixes")());
  window.homeSources.clear ||= () => (api() ? api().clearSources() : notReady("homeSources.clear")());
  if (window.__homeMixesError) return;

  // --- Wait for Spicetify ----------------------------------------------------
  const startedAt = (window.__homeMixesStart ??= Date.now());
  const gate = {
    RootlistAPI: !!Spicetify?.Platform?.RootlistAPI,
    PlayerAPI:   !!Spicetify?.Platform?.PlayerAPI,
    Menu:        !!Spicetify?.Menu,
    LocalStorage: !!Spicetify?.LocalStorage,
  };
  if (!Object.values(gate).every(Boolean)) {
    const waited = Date.now() - startedAt;
    if (waited < 400) console.log("[home-mixes] loaded, waiting for Spicetify…");
    else if (waited > 8000 && Date.now() - (window.__homeMixesWarn || 0) > 8000) {
      window.__homeMixesWarn = Date.now();
      console.warn(`[home-mixes] still waiting after ${Math.round(waited / 1000)}s — missing: ` +
        Object.keys(gate).filter((k) => !gate[k]).join(", "));
    }
    setTimeout(homeMixes, 300);
    return;
  }
  window.__homeMixesReady = true;
  console.log(`[home-mixes] initialised after ${Date.now() - startedAt}ms`);
  try {

  const HIDE_KEY = "home-mixes:patterns";
  const SHOW_KEY = "home-mixes:enabled";
  const ROW_ID   = "home-mixes-row";

  // Spotify's algorithmically generated playlists all share this id prefix.
  // With "Mix" in the name that's a precise test for Daily Mix, Driving Mix,
  // Chill Happy Mix -- without catching your own playlists that say "mix".
  const MIX_ID = /^37i9dQZF1E/;
  // Must END with "Mix" or "Mix <number>" ("Daily Mix 3"): song-radio
  // playlists share the id prefix and can carry "Mix" mid-name
  // ("… DJ Gius Mix, Radio Edit Radio").
  const isMix = (name, id) => MIX_ID.test(id) && /\bmix(\s+\d+)?\s*$/i.test(String(name).trim());

  // Shelves to hide by heading, beyond the auto-detected mix rows. These are
  // Spotify's promotional picks -- a single album pushed at you -- not mixes.
  // Add more from the console with homeHide("heading text").
  const DEFAULT_PATTERNS = ["picked for you"];
  const patterns = () => {
    try { return JSON.parse(Spicetify.LocalStorage.get(HIDE_KEY)) || DEFAULT_PATTERNS; }
    catch { return DEFAULT_PATTERNS; }
  };
  let enabled = Spicetify.LocalStorage.get(SHOW_KEY) !== "false";

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // --- Finding Spotify's shelves ------------------------------------------------
  // LEAF sections only. Home wraps every shelf in an outer <section>, and
  // since we detect by descendant links that container "contains" every mix
  // on the page. Hide it and the whole Home page goes blank.
  function shelves() {
    const root = document.querySelector(".main-view-container") || document;
    return [...root.querySelectorAll('section, [data-testid="component-shelf"]')]
      .filter((s) => !s.querySelector("section") && !s.classList.contains("hmx-row"));
  }
  const headingOf = (el) => el.querySelector("h1,h2,h3")?.textContent?.trim() || "";

  // Count CARDS, not links. A mood-mix card carries extra "Also try pop,
  // indie, …" playlist links inside it, so counting links made a shelf of
  // five mixes look like 5 of 20 -- a minority -- and it was never hidden.
  // Links are grouped by the card they sit in; a text-only link with no card
  // ancestor and no image (a stray "Also try" link) isn't a card at all.
  const CARD_SEL = '.main-card-card, [data-testid*="card"], article, li';
  function mixesIn(shelf) {
    const links = [];
    shelf.querySelectorAll('a[href*="/playlist/"]').forEach((a) => {
      const id = a.getAttribute("href")?.split("/playlist/")[1]?.split(/[?#]/)[0];
      if (!id) return;
      const name = (a.getAttribute("aria-label") || a.title || a.textContent || "").trim();
      links.push({ a, id, name, mix: !!name && isMix(name, id), card: a.closest(CARD_SEL), img: !!a.querySelector("img") });
    });
    const distinctMixIds = new Set(links.filter((l) => l.mix).map((l) => l.id));

    // Group links by the card they sit in, so a mix card's "Also try pop,
    // indie…" sub-links don't each count as a card of their own.
    let cards = new Set(), mixCards = new Set();
    for (const l of links) {
      if (!l.card && !l.mix && !l.img) continue;      // stray text link
      const key = l.card || l.a;
      cards.add(key);
      if (l.mix) mixCards.add(key);
    }
    // If several distinct mixes collapsed into one "card", the ancestor we
    // matched was the shelf itself, not a card. Fall back to per-link
    // counting, where only image links and mix links count as cards.
    if (mixCards.size < Math.min(2, distinctMixIds.size)) {
      cards = new Set(links.filter((l) => l.mix || l.img).map((l) => l.a));
      mixCards = new Set(links.filter((l) => l.mix).map((l) => l.id));
    }

    const out = [];
    const seenId = new Set();
    for (const l of links) if (l.mix && !seenId.has(l.id)) { seenId.add(l.id); out.push({ uri: "spotify:playlist:" + l.id, name: l.name }); }
    out.links = Math.max(cards.size, out.length);
    return out;
  }

  function scan() {
    if (!enabled) return;
    const pats = patterns().map((p) => p.toLowerCase());
    const found = [];
    for (const s of shelves()) {
      if (s.classList.contains("hmx-row") || s.dataset.homeMixesChecked === "1") continue;
      const h = headingOf(s);
      if (!h) continue;
      s.dataset.homeMixesChecked = "1";
      const mixes = mixesIn(s);
      found.push(...mixes);
      // A mix shelf is MOSTLY mixes. "Recently played" can hold a couple of
      // Daily Mixes among your own playlists -- that row should stay.
      const mixShelf = mixes.length >= 2 && mixes.length * 2 >= mixes.links;
      if (mixes.length >= 2 && !mixShelf)
        console.log(`[home-mixes] "${h}": ${mixes.length} mix cards of ${mixes.links} — left visible (not a mix shelf)`);
      if (mixShelf || pats.some((p) => h.toLowerCase().includes(p))) {
        s.style.display = "none";
        s.dataset.homeMixesHidden = "1";
        s.dataset.homeMixesShelf = h;                        // so each of our rows can take the right slot
        s.dataset.homeMixesKind = mixShelf ? "mix" : "pattern"; // pattern-hidden shelves aren't row slots
      }
    }
    if (found.length) record(found);

    // What's on Home RIGHT NOW, from every hidden shelf present -- not just
    // the ones this pass checked, or a shelf that renders late would replace
    // the list instead of joining it. better-mix builds from this.
    if (onHome()) {
      const current = [...document.querySelectorAll('[data-home-mixes-hidden="1"]')]
        .flatMap((s) => mixesIn(s).map((m) => ({ ...m, shelf: s.dataset.homeMixesShelf || headingOf(s) })));
      if (current.length) writeCurrent(current);
    }
  }

  const CUR_KEY = "home-mixes:current";
  const readCurrent = () => { try { return JSON.parse(localStorage.getItem(CUR_KEY)) || []; } catch { return []; } };
  function writeCurrent(list) {
    // Spotify shows the same mix in several shelves; record it once, or every
    // sighting gets its own card and its own slot in the "N of M" counter.
    const seenUri = new Set();
    list = list.filter((m) => !seenUri.has(m.uri) && seenUri.add(m.uri));
    const next = JSON.stringify(list.map((m) => ({ uri: m.uri, name: m.name, shelf: m.shelf || "" })));
    let prev = null; try { prev = localStorage.getItem(CUR_KEY); } catch {}
    if (prev === next) return;
    try { localStorage.setItem(CUR_KEY, next); } catch {}
    window.dispatchEvent(new Event("home-mixes:current"));   // better-mix listens
    document.querySelectorAll(".hmx-row").forEach((r) => r.remove());   // redraw with the new set
  }

  // Merge into the RAW list (never the name-filtered one -- that's how a bad
  // rule once deleted every Daily Mix), stamping when each was last seen so
  // mixes Spotify stops offering can age out.
  function record(found) {
    const now = Date.now();
    const byUri = new Map(readSourcesRaw().map((x) => [x.uri, x]));
    found.forEach((x) => byUri.set(x.uri, { ...(byUri.get(x.uri) || {}), ...x, seenAt: now }));
    try { Spicetify.LocalStorage.set(SRC_KEY, JSON.stringify([...byUri.values()])); } catch {}
  }
  function readSourcesRaw() {
    try { return JSON.parse(Spicetify.LocalStorage.get(SRC_KEY)) || []; } catch { return []; }
  }
  // Filtered through the current rule, so entries recorded by older versions
  // (genre links, your own playlists) can't leak back in.
  function readSources() {
    try {
      return (JSON.parse(Spicetify.LocalStorage.get(SRC_KEY)) || [])
        .filter((x) => isMix(x?.name || "", String(x?.uri).split(":").pop()));
    } catch { return []; }
  }
  function unhideAll() {
    document.querySelectorAll('[data-home-mixes-hidden="1"]').forEach((s) => {
      s.style.display = "";
      delete s.dataset.homeMixesHidden;
      delete s.dataset.homeMixesChecked;
    });
  }

  // --- Your mixes --------------------------------------------------------------
  // Read-only here. better-mix.js owns every write to this store and fires
  // "better-mix:updated" when it changes; we just redraw. One writer means
  // the two extensions can never disagree about what's in it.
  const readVirtual = () => { try { return JSON.parse(localStorage.getItem(VIRT_KEY)) || []; } catch { return []; } };

  // Playback and the page both live in better-mix; this row only points at them.
  const playMix = (mix, startAt = 0) =>
    window.BetterMix?.play ? window.BetterMix.play(mix, startAt)
                           : Spicetify.showNotification("Better Mix isn't loaded", true);
  // The pages ship in the same app folder as this file, so they're always
  // there. (Don't feature-detect via a flag set by index.js: a custom app's
  // index.js doesn't run until its route is visited, so the flag would be
  // missing on first load and the first card click would just play.)
  const openMix = (mix) =>
    Spicetify.Platform.History.push(`/better-mix?id=${encodeURIComponent(mix.id)}`, { id: mix.id });

  const openPlaylist = (uri) =>
    Spicetify.Platform.History.push(`/playlist/${String(uri).split(":").pop()}`);

  async function toggleSave(mix, cardEl) {
    const BM = window.BetterMix;
    if (!BM?.saveVirtual) return Spicetify.showNotification("Better Mix isn't loaded", true);
    const undo = !!mix.savedUri;
    cardEl.classList.add("hmx-busy");
    try {
      if (undo) {
        await BM.unsaveVirtual(mix.id);
        Spicetify.showNotification(`Removed "${mix.name}" from your library`);
      } else {
        await BM.saveVirtual(mix.id);     // writes savedUri + fires the update event
        Spicetify.showNotification(`Saved "${mix.name}" to your library`);
      }
    } catch (e) {
      Spicetify.showNotification((undo ? "Couldn't remove: " : "Couldn't save: ") + (e?.message || e), true);
    } finally {
      cardEl.classList.remove("hmx-busy");
    }
  }

  const icon = (name) =>
    `<svg viewBox="0 0 16 16" fill="currentColor">${Spicetify.SVGIcons[name] || ""}</svg>`;

  const readFailed = () => { try { return JSON.parse(localStorage.getItem("better-mix:failed")) || {}; } catch { return {}; } };

  // A build that failed looked identical to one in progress -- "building…"
  // forever. Say what happened and offer a retry.
  function failedCard(name, uri, reason) {
    const el = document.createElement("div");
    el.className = "hmx-card hmx-failed";
    el.innerHTML = `
      <div class="hmx-art"><div class="hmx-fallback hmx-fallback-failed">!</div></div>
      <div class="hmx-name" title="${esc(reason)}">${esc(name)}</div>
      <div class="hmx-meta"><span title="${esc(reason)}">couldn't build</span><button class="hmx-save">retry</button></div>`;
    el.querySelector(".hmx-save").onclick = async (e) => {
      e.stopPropagation();
      el.querySelector(".hmx-meta span").textContent = "rebuilding…";
      try { await window.BetterMix?.rebuildOne?.(uri); }
      catch (err) { Spicetify.showNotification(err?.message || String(err), true); }
    };
    return el;
  }

  // Shown while a mix is still being built, so the row never looks like
  // Spotify's simply vanished.
  function pendingCard(name) {
    const el = document.createElement("div");
    el.className = "hmx-card hmx-pending";
    el.innerHTML = `
      <div class="hmx-art"><div class="hmx-fallback hmx-shimmer"></div></div>
      <div class="hmx-name">${esc(name)}</div>
      <div class="hmx-meta"><span>building…</span></div>`;
    return el;
  }

  function card(mix) {
    const el = document.createElement("div");
    el.className = "hmx-card";
    // The recommender hands back album art with every track, so each card
    // gets a real mosaic like Spotify's own playlist covers.
    const imgs = [...new Set((mix.tracks || []).map((t) => t.image).filter(Boolean))].slice(0, 4);
    const art = imgs.length >= 4
      ? `<div class="hmx-mosaic">${imgs.map((u) => `<img src="${esc(u)}" alt="">`).join("")}</div>`
      : imgs.length
        ? `<img class="hmx-single" src="${esc(imgs[0])}" alt="">`
        : `<div class="hmx-fallback">${esc(mix.name.replace(/^better\s+/i, "").slice(0, 2).toUpperCase())}</div>`;

    const saved = !!mix.savedUri;
    el.innerHTML = `
      <div class="hmx-art">${art}<button class="hmx-play" title="Play">${icon("play")}</button></div>
      <div class="hmx-name" title="${esc(mix.name)}">${esc(mix.name)}</div>
      <div class="hmx-meta">
        <span>${(mix.tracks || []).length} songs${saved ? " · saved" : ""}</span>
        <button class="hmx-save" title="${saved ? "Remove the saved playlist from your library" : "Save as a real playlist"}">${saved ? "saved ✓" : "save"}</button>
      </div>`;

    el.querySelector(".hmx-art").onclick = () => openMix(mix);
    el.querySelector(".hmx-name").onclick = () => openMix(mix);
    el.querySelector(".hmx-play").onclick = (e) => { e.stopPropagation(); playMix(mix); };
    // A toggle, not a link. Clicking it used to navigate to the playlist,
    // which read as the button doing nothing except moving you somewhere.
    el.querySelector(".hmx-save").onclick = (e) => {
      e.stopPropagation();
      toggleSave(mix, el);
    };
    return el;
  }

  const onHome = () => {
    const path = Spicetify.Platform.History?.location?.pathname ?? location.pathname;
    return /^\/?(home)?\/?$/.test(path);
  };

  // Put a row where the shelf it replaces WAS. Daily Mixes and the mood mixes
  // live in different Spotify shelves, so each of our rows goes into its own
  // slot; if the exact shelf isn't found, any hidden shelf; failing that,
  // after the first shelf, and it moves into the real slot once that renders.
  function placeRow(row, shelfHeading) {
    const hidden = [...document.querySelectorAll('[data-home-mixes-hidden="1"]')];
    const slot = hidden.find((s) => s.dataset.homeMixesShelf === shelfHeading)
      || hidden.find((s) => s.dataset.homeMixesKind === "mix") || hidden[0];
    if (slot) { slot.parentNode.insertBefore(row, slot); row.dataset.placed = "slot"; return true; }
    const first = shelves().find((s) => headingOf(s));
    if (first) { first.after(row); row.dataset.placed = "fallback"; return true; }
    return false;
  }

  const OTHER_ROW_CAP = 10;   // same as Spotify's shelf; the rest are behind Show all
  const isDaily = (name) => /^daily mix/i.test(String(name).replace(/^better\s+/i, ""));

  function buildRow(id, title, items) {
    const row = document.createElement("section");
    row.id = id;
    row.className = "hmx-row";
    row.innerHTML = `
      <div class="hmx-head">
        <h2 class="hmx-heading">${esc(title)}</h2>
        <span><span class="hmx-progress"></span><button class="hmx-rebuild hmx-showall">Show all</button></span>
      </div>
      <div class="hmx-scroller">
        <button class="hmx-arrow hmx-arrow-l" aria-label="Scroll left">${icon("chevron-left")}</button>
        <div class="hmx-strip"></div>
        <button class="hmx-arrow hmx-arrow-r" aria-label="Scroll right">${icon("chevron-right")}</button>
      </div>`;
    row.querySelector(".hmx-showall").onclick = () => Spicetify.Platform.History.push("/better-mix");
    const strip = row.querySelector(".hmx-strip");
    items.forEach((m) => strip.appendChild(
      m.failed ? failedCard(m.name, m.uri, m.failed) : m.pending ? pendingCard(m.name) : card(m)));

    // Arrows like Spotify's shelves. A scrollbar assumes a trackpad; with a
    // mouse there's nothing to swipe, so the far end of the row was
    // unreachable. Each click moves just under one screenful, so a card is
    // never left half-shown at the edge.
    const [left, right] = [".hmx-arrow-l", ".hmx-arrow-r"].map((c) => row.querySelector(c));
    const update = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      left.hidden = strip.scrollLeft <= 1;
      right.hidden = strip.scrollLeft >= max - 1;
    };
    const page = (dir) => strip.scrollBy({ left: dir * strip.clientWidth * 0.85, behavior: "smooth" });
    left.onclick = () => page(-1);
    right.onclick = () => page(1);
    strip.addEventListener("scroll", update, { passive: true });
    // Cards arrive as mixes finish building, and the window can be resized, so
    // recheck rather than deciding once.
    new ResizeObserver(update).observe(strip);
    update();
    return row;
  }

  function injectRow() {
    if (!enabled) return;
    if (!onHome()) { document.querySelectorAll(".hmx-row").forEach((r) => r.remove()); return; }

    // Better versions of exactly the mixes we hid, in the same order. Ones
    // still building show as placeholders. Split into Daily Mixes and the rest.
    const store = readVirtual();
    const current = readCurrent();
    const failed = readFailed();
    const entryFor = (c) => {
      const built = store.find((m) => m.sourceUri === c.uri);
      const name = "Better " + String(c.name).replace(/^better\s+/i, "");
      if (built) return { shelf: c.shelf || "", ...built };
      if (failed[c.uri]) return { shelf: c.shelf || "", failed: failed[c.uri].reason, uri: c.uri, name };
      return { shelf: c.shelf || "", pending: true, name };
    };
    // Daily row: EVERY Daily Mix we know about, in number order, whether or
    // not Spotify's shelf happens to be showing it right now -- they're all
    // rebuilt daily regardless. Other row: the mood/artist mixes on Home today.
    const dailyNum = (m) => parseInt(String(m.name).replace(/\D/g, ""), 10) || 0;
    const dailySources = readSources().filter((m) => isDaily(m.name)).sort((a, b) => dailyNum(a) - dailyNum(b));
    const dailyShelf = current.find((c) => isDaily(c.name))?.shelf || "";
    const groups = [
      { id: ROW_ID + "-daily", title: "Your daily mixes", items: dailySources.map((c) => entryFor({ ...c, shelf: dailyShelf })) },
      // Featured first (what Spotify's shelf shows right now), then the rest of
      // what's built, newest first. Spotify features only 4-5 at a time and a
      // row that thin wastes the other ten good ones; Show all has everything.
      { id: ROW_ID + "-other", title: "Your mixes", items: (() => {
          const featured = current.filter((c) => !isDaily(c.name)).map(entryFor);
          const shown = new Set(current.map((c) => c.uri));
          const rest = store.filter((m) => !isDaily(m.name) && !shown.has(m.sourceUri))
            .sort((a, b) => Date.parse(b.builtAt || 0) - Date.parse(a.builtAt || 0))
            .map((m) => ({ shelf: "", ...m }));
          return [...featured, ...rest].slice(0, OTHER_ROW_CAP);
        })() },
    ];

    for (const g of groups) {
      const existing = document.getElementById(g.id);
      if (!g.items.length) { existing?.remove(); continue; }
      const shelf = g.items.find((m) => m.shelf)?.shelf || "";
      if (existing) {
        if (existing.dataset.placed === "fallback") {
          const slot = [...document.querySelectorAll('[data-home-mixes-hidden="1"]')]
            .find((s) => s.dataset.homeMixesShelf === shelf)
            || document.querySelector('[data-home-mixes-hidden="1"][data-home-mixes-kind="mix"]');
          if (slot && existing.nextElementSibling !== slot) {
            slot.parentNode.insertBefore(existing, slot);
            existing.dataset.placed = "slot";
          }
        }
        continue;
      }
      placeRow(buildRow(g.id, g.title, g.items), shelf);   // no anchor yet -> next pass
    }
  }

  const redraw = () => { document.querySelectorAll(".hmx-row").forEach((r) => r.remove()); schedule(); };
  window.addEventListener("better-mix:updated", redraw);
  window.addEventListener("better-mix:progress", (e) => {
    const p = e.detail || {};
    const txt = p.active ? `building ${p.done} of ${p.total}…` : "";
    document.querySelectorAll(".hmx-progress").forEach((el) => (el.textContent = txt));
  });

  // --- Keeping up with navigation -------------------------------------------
  let scheduled = false;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 250));
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    idle(() => { scheduled = false; scan(); injectRow(); });
  }

  // Never rewrite the recorded sources through the name rule -- when that rule
  // regressed it silently deleted every Daily Mix from storage. Filtering
  // happens on read (readSources), so a bad rule only hides entries until it's
  // fixed. Startup only drops entries whose id isn't Spotify-generated at all.
  // Startup housekeeping: drop non-Spotify ids, stamp entries recorded before
  // seenAt existed, and forget sources not seen on Home for 90 days.
  try {
    const now = Date.now(), OLD = 90 * 24 * 60 * 60 * 1000;
    const kept = readSourcesRaw()
      .filter((x) => MIX_ID.test(String(x?.uri).split(":").pop()))
      .map((x) => ({ ...x, seenAt: x.seenAt || now }))
      .filter((x) => now - x.seenAt < OLD);
    Spicetify.LocalStorage.set(SRC_KEY, JSON.stringify(kept));
  } catch {}

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();

  // --- Styles ------------------------------------------------------------------
  const css = document.createElement("style");
  css.textContent = `
    /* Contain the row to the page width, then let the strip scroll sideways
       like Spotify's shelves. Without min-width:0 / max-width:100% the strip
       grows to fit every card and sticks out past the edge of the page. */
    .hmx-row { padding: 8px 0 24px; min-width: 0; max-width: 100%; box-sizing: border-box; overflow: hidden; }
    .hmx-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px; }
    .hmx-heading { font-size: 24px; font-weight: 700; margin: 0; color: var(--spice-text, #fff); }
    .hmx-progress { font-size: 13px; color: var(--spice-subtext, #b3b3b3); }
    .hmx-rebuild { margin-left: 18px; background: transparent; border: 0; color: var(--spice-subtext, #b3b3b3); font-size: 14px; font-weight: 700; cursor: pointer; }
    .hmx-rebuild:hover { color: var(--spice-text, #fff); text-decoration: underline; }
    .hmx-scroller { position: relative; min-width: 0; }
    .hmx-strip { display: flex; gap: 18px; min-width: 0; width: 100%; overflow-x: auto; overflow-y: hidden;
                 padding-bottom: 8px; scroll-snap-type: x proximity; scrollbar-width: none; }
    .hmx-strip::-webkit-scrollbar { display: none; }
    /* Centred on the card artwork: 12px card padding + half of the 156px cover. */
    .hmx-arrow { position: absolute; top: 90px; transform: translateY(-50%); z-index: 2;
                 width: 32px; height: 32px; border: 0; border-radius: 50%; cursor: pointer;
                 display: flex; align-items: center; justify-content: center;
                 background: rgba(0, 0, 0, .7); color: var(--spice-text, #fff);
                 opacity: 0; transition: opacity 150ms ease, background-color 150ms ease; }
    .hmx-arrow svg { width: 16px; height: 16px; display: block; }
    .hmx-arrow-l { left: -8px; }
    .hmx-arrow-r { right: -8px; }
    .hmx-arrow:hover { background: rgba(0, 0, 0, .9); transform: translateY(-50%) scale(1.06); }
    .hmx-arrow[hidden] { display: none; }
    .hmx-row:hover .hmx-arrow { opacity: 1; }
    .hmx-card { scroll-snap-align: start; }
    .hmx-card { width: 180px; flex: 0 0 auto; border-radius: 8px; padding: 12px; background: var(--spice-card, #181818); transition: background-color 150ms ease; }
    .hmx-card:hover { background: var(--spice-highlight, #282828); }
    .hmx-card.hmx-busy { opacity: .6; pointer-events: none; }
    .hmx-art { position: relative; width: 100%; aspect-ratio: 1; border-radius: 6px; overflow: hidden; cursor: pointer; background: var(--spice-main, #121212); }
    .hmx-mosaic { display: grid; grid-template-columns: 1fr 1fr; width: 100%; height: 100%; }
    .hmx-mosaic img, .hmx-single { width: 100%; height: 100%; object-fit: cover; display: block; }
    .hmx-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 40px; font-weight: 700;
                    color: var(--spice-main, #121212); background: linear-gradient(135deg, var(--spice-button, #1ed760), var(--spice-button-active, #1db954)); }
    .hmx-play { position: absolute; right: 8px; bottom: 8px; width: 44px; height: 44px; border-radius: 50%; border: 0; cursor: pointer;
                background: var(--spice-button, #1ed760); color: var(--spice-main, #121212); display: flex; align-items: center; justify-content: center;
                opacity: 0; transform: translateY(6px); transition: opacity 150ms ease, transform 150ms ease; box-shadow: 0 8px 16px rgba(0,0,0,.4); }
    .hmx-play svg { width: 20px; height: 20px; margin-left: 2px; }
    .hmx-card:hover .hmx-play { opacity: 1; transform: none; }
    .hmx-name { margin-top: 12px; font-size: 14px; font-weight: 700; color: var(--spice-text, #fff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .hmx-name:hover { text-decoration: underline; }

    .hmx-meta { margin-top: 4px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--spice-subtext, #b3b3b3); }
    .hmx-save { background: transparent; border: 1px solid var(--spice-misc, #555); color: var(--spice-subtext, #b3b3b3); border-radius: 12px; padding: 2px 10px; font-size: 11px; font-weight: 700; cursor: pointer; }
    .hmx-save:hover { border-color: var(--spice-button, #1ed760); color: var(--spice-text, #fff); }
    .hmx-pending { opacity: .7; }
    .hmx-fallback-failed { background: var(--spice-card, #282828); color: var(--spice-notification-error, #cf4a3c); font-size: 48px; }
    .hmx-failed .hmx-meta span { color: var(--spice-notification-error, #cf4a3c); }
    .hmx-shimmer { background: linear-gradient(110deg, var(--spice-card, #222) 30%, var(--spice-highlight, #333) 50%, var(--spice-card, #222) 70%);
                   background-size: 200% 100%; animation: hmx-shimmer 1.4s linear infinite; }
    @keyframes hmx-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  `;
  document.head.appendChild(css);

  // --- Toggle ------------------------------------------------------------------
  try {
  new Spicetify.Menu.Item("Replace Spotify's mix rows", enabled, (self) => {
    enabled = !enabled;
    self.setState(enabled);
    Spicetify.LocalStorage.set(SHOW_KEY, String(enabled));
    if (enabled) schedule();
    else { unhideAll(); document.querySelectorAll(".hmx-row").forEach((r) => r.remove()); }
    Spicetify.showNotification(enabled ? "Showing your mixes" : "Spotify's rows restored");
  }).register();
  } catch (e) { console.warn("[home-mixes] profile-menu toggle unavailable:", e); }

  // --- Console helpers ---------------------------------------------------------
  window.__homeMixesApi = {
    shelves() {
      const rows = shelves()
        .filter((s) => !s.classList.contains("hmx-row") && headingOf(s))
        .map((s) => { const m = mixesIn(s); return { heading: headingOf(s), mixes: m.length, cards: m.links, hidden: s.dataset.homeMixesHidden === "1" }; });
      console.table(rows);
      return rows;
    },
    hide(...pats) {
      const next = [...new Set([...patterns(), ...pats.map(String)])];
      Spicetify.LocalStorage.set(HIDE_KEY, JSON.stringify(next));
      document.querySelectorAll("[data-home-mixes-checked]").forEach((s) => delete s.dataset.homeMixesChecked);
      schedule();
      console.log("hiding:", next);
    },
    reset() {
      Spicetify.LocalStorage.set(HIDE_KEY, JSON.stringify(DEFAULT_PATTERNS));
      unhideAll(); schedule();
      console.log("reset to:", DEFAULT_PATTERNS);
    },
    rescan() {
      document.querySelectorAll("[data-home-mixes-checked]").forEach((s) => delete s.dataset.homeMixesChecked);
      redraw();
      console.log("rescanning…");
    },
    mixes() {
      const v = readVirtual();
      console.table(v.map((m) => ({ name: m.name, songs: m.tracks?.length, saved: !!m.savedUri, built: m.builtAt })));
      return v;
    },
    clearSources() { Spicetify.LocalStorage.set(SRC_KEY, "[]"); console.log("captured mixes cleared"); },
  };
  window.homeSources = () => { console.table(readSources()); return readSources(); };
  window.homeSources.clear = () => window.__homeMixesApi.clearSources();

  console.log(`[home-mixes] ${readSources().length} Spotify mixes recorded, ${readVirtual().length} of yours built. ` +
    "homeShelves() · homeSources() · homeMixes() · homeHide(\"heading\")");
  } catch (e) {
    window.__homeMixesError = e?.message || String(e);
    console.error("[home-mixes] init FAILED:", e);
  }
})();

}
