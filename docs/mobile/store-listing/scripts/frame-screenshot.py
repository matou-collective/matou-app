#!/usr/bin/env python3
"""Frame a raw phone capture as a 1080x1920 (9:16) Play Store screenshot.

  python3 frame-screenshot.py IN.png OUT.png "Caption line" [--fonts DIR]

Play accepts 16:9 / 9:16 PNG or JPEG, 320-3840 px per side. Raw captures from
modern phones are 9:20, so we place them on a brand canvas with a short caption
(Merriweather Bold, white on Teal Dark #253D39, per brand-identity.md).
"""
import argparse, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
TEAL_DARK = "#253D39"
PAD, CAP_H, RADIUS = 72, 300, 40


def font(fonts_dir: Path, size: int):
    p = fonts_dir / "Merriweather-Bold.ttf"
    if p.exists():
        return ImageFont.truetype(str(p), size)
    print("warning: Merriweather-Bold.ttf missing (run fetch-fonts.sh); using DejaVu", file=sys.stderr)
    return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf", size)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst"); ap.add_argument("caption")
    ap.add_argument("--fonts", type=Path, default=Path(__file__).parent / "fonts")
    a = ap.parse_args()

    canvas = Image.new("RGB", (W, H), TEAL_DARK)
    draw = ImageDraw.Draw(canvas)
    f = font(a.fonts, 60)
    # caption: up to two lines, centred
    words, lines, cur = a.caption.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=f) > W - 2 * PAD and cur:
            lines.append(cur); cur = w
        else:
            cur = t
    lines.append(cur)
    y = 96
    for ln in lines[:2]:
        draw.text(((W - draw.textlength(ln, font=f)) / 2, y), ln, font=f, fill="white")
        y += 78

    shot = Image.open(a.src).convert("RGB")
    avail_h = H - CAP_H - PAD
    scale = min((W - 2 * PAD) / shot.width, avail_h / shot.height)
    shot = shot.resize((int(shot.width * scale), int(shot.height * scale)), Image.LANCZOS)
    mask = Image.new("L", shot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, shot.width - 1, shot.height - 1), RADIUS, fill=255)
    x = (W - shot.width) // 2
    canvas.paste(shot, (x, CAP_H), mask)
    canvas.save(a.dst, optimize=True)
    print(a.dst, canvas.size)


if __name__ == "__main__":
    main()
