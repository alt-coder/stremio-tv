#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="StremioTV"
BUILD="$ROOT/build/stremio-tv"
DIST="$ROOT/dist"
WGT="$DIST/$APP_NAME.wgt"

rm -rf "$BUILD"; mkdir -p "$BUILD" "$DIST"
rsync -a --exclude build --exclude dist --exclude .git --exclude node_modules --exclude "scripts/build-tv-app.sh" "$ROOT/" "$BUILD/"
cp "$ROOT/tizen/config.xml" "$BUILD/config.xml"
if [ ! -f "$BUILD/icon.png" ]; then
  FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
  ffmpeg -v error -y -f lavfi -i "color=c=0x0a0a0f:s=512x512" \
    -vf "drawbox=x=76:y=130:w=360:h=252:color=0x8b6bff@0.22:t=fill,drawtext=fontfile=${FONT}:text='STREMIO':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=180,drawtext=fontfile=${FONT}:text='TV':fontcolor=0x8b6bff:fontsize=90:x=(w-text_w)/2:y=250" \
    -frames:v 1 "$BUILD/icon.png"
fi
for f in index.html app.js addons.js player.js store.js style.css icon.png config.xml; do
  [ -f "$BUILD/$f" ] || { echo "missing $f" >&2; exit 1; }
done
grep -q '<tizen:profile name="tv"' "$BUILD/config.xml" || { echo "not a TV profile" >&2; exit 1; }
rm -f "$WGT"
python3 - "$BUILD" "$WGT" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            z.write(full, os.path.relpath(full, src))
print('wrote', out)
PY
ls -lh "$WGT"
python3 - "$WGT" <<'PY'
import sys, zipfile, hashlib
path = sys.argv[1]
with zipfile.ZipFile(path) as z:
    print('entries:', len(z.namelist()), 'corrupt:', z.testzip() or 'none')
print('sha256:', hashlib.sha256(open(path,'rb').read()).hexdigest())
PY
