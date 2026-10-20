# Stremio TV

TV-first Stremio client for Samsung Tizen, built on the Free TV TV shell.
The TV talks to Stremio addons directly — no addon server and no VM.

## What works now

- Home rows from installed addon catalogs (Cinemeta seeded).
- Detail page from addon `meta`.
- Subtitle tracks from OpenSubtitles v3 (seeded).
- Stream list from installed stream addons (add Comet/AIOStreams in Addons).
- HTML5 player, subtitle overlay, manual subtitle sync.
- D-pad navigation, Back/Escape, Tizen `hwkey-event`.

## Addons

First run seeds:

```
https://v3-cinemeta.strem.io/manifest.json
https://opensubtitles-v3.strem.io/manifest.json
```

Add Comet/AIOStreams in **Addons** by pasting its manifest URL. It is stored in
localStorage; no key is committed to this repo.

## Run

```bash
npm start          # http://127.0.0.1:7018
```

## Build Tizen WGT

```bash
bash scripts/build-tv-app.sh
# dist/StremioTV.wgt
```

Unsigned package; use TizenBrew Installer or Tizen Studio to sign/install.

## Next

- AVPlay/TizenVideo native playback.
- AVPlay sound-analysis waveform for on-device auto sync.
- TV left rail/back-stack polish and stream picker details.
