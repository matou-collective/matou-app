#!/usr/bin/env sh
# Fetch the brand fonts the asset scripts render text with (not committed; OFL/Apache).
set -eu
d="$(dirname "$0")/fonts"; mkdir -p "$d"
curl -sSL -o "$d/RobotoMono-Regular.ttf" https://github.com/googlefonts/RobotoMono/raw/main/fonts/ttf/RobotoMono-Regular.ttf
curl -sSL -o "$d/Merriweather-Bold.ttf" https://github.com/SorkinType/Merriweather/raw/master/fonts/ttf/Merriweather-Bold.ttf
ls -l "$d"
