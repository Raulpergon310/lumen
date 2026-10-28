#!/usr/bin/env bash
# Builds dist/Lumen-tv.apk with the Android SDK + Android Studio's JDK (no Gradle, no downloads).
# Usage: bash android/build.sh            (LUMEN_DEBUG=1 for a debuggable build with remote inspection)
# The signing key stays out of the repo, in ~/.lumen (lumen-tv.keystore + keystore.pass): keep a backup,
# installed TVs only accept updates signed with that same key. Without it a new key is created.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
JDK="${JAVA_HOME:-/c/Program Files/Android/Android Studio/jbr}"
export JAVA_HOME="$JDK" PATH="$JDK/bin:$PATH"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
PLATFORM="$SDK/platforms/android-35/android.jar"
OUT="$HERE/build"
APK="$ROOT/dist/Lumen-tv.apk"
KEYSTORE="${LUMEN_KEYSTORE:-$HOME/.lumen/lumen-tv.keystore}"
PASSFILE="$(dirname "$KEYSTORE")/keystore.pass"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
VERSION_CODE="$(node -p "'$VERSION'.split('.').reduce((n, p) => n * 100 + Number(p), 0)")"
REPO="$(cd "$ROOT" && node -p "require('./package.json').lumen?.githubRepo || ''")"

rm -rf "$OUT" && mkdir -p "$OUT/res" "$OUT/classes" "$OUT/assets/web/vendor" "$ROOT/dist"

# Web UI: same files as the desktop app.
cp -r "$ROOT/src/." "$OUT/assets/web/"
rm -f "$OUT/assets/web/overlay.html" "$OUT/assets/web/js/overlay.js"
mkdir -p "$OUT/assets/web/vendor/hls"
cp "$ROOT/node_modules/hls.js/dist/hls.min.js" "$OUT/assets/web/vendor/hls/"
cp -r "$ROOT/node_modules/jassub/dist" "$OUT/assets/web/vendor/jassub"
printf "export const BUILD = { version: '%s', repo: '%s' };\n" "$VERSION" "$REPO" > "$OUT/assets/web/js/build-info.js"

[ -f "$HERE/res/drawable/banner.png" ] || powershell -NoProfile -ExecutionPolicy Bypass -File "$HERE/make-images.ps1"

echo "· recursos"
"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLATFORM" --manifest "$HERE/AndroidManifest.xml" \
  --min-sdk-version 23 --target-sdk-version 35 --java "$OUT/gen" "$OUT/res.zip" \
  --version-name "$VERSION" --version-code "$VERSION_CODE" --replace-version ${LUMEN_DEBUG:+--debug-mode}

echo "· java"
"$JDK/bin/javac" -nowarn -source 11 -target 11 -encoding UTF-8 -classpath "$PLATFORM" -d "$OUT/classes" \
  $(find "$HERE/src" "$OUT/gen" -name '*.java') 2>&1 | grep -v "^warning\|^Note\|^1 warning" || true

echo "· dex"
"$BT/d8.bat" --release --min-api 23 --lib "$PLATFORM" --output "$OUT" $(find "$OUT/classes" -name '*.class')
(cd "$OUT" && cp base.apk unsigned.apk && "$JDK/bin/jar" uf unsigned.apk classes.dex assets)
# (assets added with jar, not aapt2 -A: on Windows aapt2 stores them with backslash paths)

echo "· firma"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  node -e "process.stdout.write(require('crypto').randomBytes(18).toString('base64url'))" > "$PASSFILE"
  "$JDK/bin/keytool" -genkeypair -keystore "$KEYSTORE" -storepass "$(cat "$PASSFILE")" -alias lumen \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Lumen TV" >/dev/null
fi
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
# "file:" hides the path from Git Bash's path conversion, so pass it already in Windows form.
"$BT/apksigner.bat" sign --ks "$KEYSTORE" --ks-pass "file:$(cygpath -w "$PASSFILE" 2>/dev/null || echo "$PASSFILE")" --out "$APK" "$OUT/aligned.apk"
echo "OK $VERSION ($VERSION_CODE) → $APK ($(du -h "$APK" | cut -f1))"
