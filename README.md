# Stremio TV

TV-first Stremio addon client for Samsung Tizen, built on the Free TV TV shell.
The TV talks to Stremio addons directly — no addon server and no VM.

## Working

- Home rows from addon catalogs (Cinemeta + Public Domain Movies seeded).
- Detail from addon `meta`.
- Subtitle tracks from OpenSubtitles v3.
- Streams from installed stream addons (direct HTTP, external links and torrent
  detection). Add Comet/AIOStreams in **Addons**.
- Addon manager with full URL keyboard, remove, and a local private config.
- D-pad focus, OK, hardware **Back** (`tizenhwkey` → Escape stack).
- HTML5 player, subtitle overlay, manual subtitle sync.
- Tizen package with `tv.inputdevice` + `avplay` privileges.

## Addons

Seeded:

```
https://v3-cinemeta.strem.io/manifest.json
https://opensubtitles-v3.strem.io/manifest.json
https://watchhub.strem.io/manifest.json
https://caching.stremio.net/publicdomainmovies.now.sh/manifest.json
```

Add Comet/AIOStreams in **Addons** on the TV, or copy
`addons.local.example.js` to `addons.local.js` and put the private manifest URL
there before building. `addons.local.js` is gitignored.

## Run / build

```bash
npm start
bash scripts/build-tv-app.sh   # dist/StremioTV.wgt
```

Install via TizenBrew Installer → Install from GitHub:

```
alt-coder/stremio-tv
```

## Known next items

- AVPlay/TizenVideo native playback for HEVC/MKV.
- AVPlay sound-analysis waveform for on-device auto sync.
- Full stream picker polish and library parity.
