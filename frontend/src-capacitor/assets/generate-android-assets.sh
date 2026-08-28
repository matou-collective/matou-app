#!/usr/bin/env bash
#
# Regenerate the Android launcher icon + native splash assets for nz.matou.app
# from the Matou brand mark. Run from the `frontend/` directory:
#
#     bash src-capacitor/assets/generate-android-assets.sh
#
# Requires ImageMagick (`convert`) on PATH.
#
# Source of truth for the brand mark is the Electron app icon
# (src-electron/icons/512x512.png): the teal (#1E5F74) rounded square with the
# white Matou "M" motif. The white "M" foreground is pre-extracted and committed
# alongside this script as matou-m-white.png (regenerable via the EXTRACT step
# below if the brand mark ever changes).
#
# Output: the full mipmap density set (mdpi..xxxhdpi) — legacy square + round
# launcher PNGs and the adaptive-icon foreground — plus the portrait/landscape
# splash density set. The adaptive background is a solid teal @color resource
# (res/values/ic_launcher_background.xml), referenced by
# res/mipmap-anydpi-v26/ic_launcher{,_round}.xml.
set -euo pipefail

cd "$(dirname "$0")/../.."   # -> frontend/

RES=src-capacitor/android/app/src/main/res
SRC=src-electron/icons/512x512.png       # brand mark (teal square + white M)
M=src-capacitor/assets/matou-m-white.png # extracted white M on transparent
TEAL='#1E5F74'

# --- (EXTRACT) Re-derive the white M from the brand mark, if needed ---
#   convert "$SRC" -background black -alpha remove -alpha off \
#     -threshold 55% -transparent black - | convert - -trim +repage "$M"

# Legacy launcher px sizes (mdpi hdpi xhdpi xxhdpi xxxhdpi)
declare -A LA=( [mdpi]=48  [hdpi]=72  [xhdpi]=96  [xxhdpi]=144 [xxxhdpi]=192 )
# Adaptive foreground canvas sizes (108dp per density)
declare -A FG=( [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432 )

# Adaptive foreground master: M at ~44% of the 108dp canvas (~66% of the visible 72dp
# safe zone) so it sits inside the icon with a margin instead of touching the edges.
convert -size 432x432 xc:none \
  \( "$M" -resize 190x \) -gravity center -composite /tmp/matou_fg_master.png
# Round legacy master: white M on a solid teal circle.
convert -size 192x192 xc:none -fill "$TEAL" -draw 'circle 96,96 96,0' \
  \( "$M" -resize 84x \) -gravity center -composite /tmp/matou_round_master.png

for d in "${!LA[@]}"; do
  convert "$SRC"                    -resize ${LA[$d]}x${LA[$d]} "$RES/mipmap-$d/ic_launcher.png"
  convert /tmp/matou_round_master.png -resize ${LA[$d]}x${LA[$d]} "$RES/mipmap-$d/ic_launcher_round.png"
  convert /tmp/matou_fg_master.png    -resize ${FG[$d]}x${FG[$d]} "$RES/mipmap-$d/ic_launcher_foreground.png"
done

# Splash: white background with the brand mark centered (logo width = 42% of the
# shorter edge). "$1 $2 $3" = out-path width height.
splash() {
  local out=$1 w=$2 h=$3 min lw
  min=$(( w < h ? w : h )); lw=$(( min * 42 / 100 ))
  convert -size ${w}x${h} xc:white \
    \( "$SRC" -resize ${lw}x${lw} \) -gravity center -composite "$out"
}
splash "$RES/drawable/splash.png"               480 320
splash "$RES/drawable-port-mdpi/splash.png"     320 480
splash "$RES/drawable-port-hdpi/splash.png"     480 800
splash "$RES/drawable-port-xhdpi/splash.png"    720 1280
splash "$RES/drawable-port-xxhdpi/splash.png"   960 1600
splash "$RES/drawable-port-xxxhdpi/splash.png" 1280 1920
splash "$RES/drawable-land-mdpi/splash.png"     480 320
splash "$RES/drawable-land-hdpi/splash.png"     800 480
splash "$RES/drawable-land-xhdpi/splash.png"   1280 720
splash "$RES/drawable-land-xxhdpi/splash.png"  1600 960
splash "$RES/drawable-land-xxxhdpi/splash.png" 1920 1280

echo "Regenerated Matou Android launcher icons + splash under $RES"
