#!/usr/bin/env python3
"""Generate the Play Store listing graphics from the brand SVGs.

  python3 docs/mobile/store-listing/scripts/make-assets.py [--fonts DIR]

Outputs (docs/mobile/store-listing/):
  icon-512.png                 512x512 app icon (Play masks the corners itself)
  feature-graphic-1024x500.png 1024x500 feature graphic

Needs: rsvg-convert (librsvg), Pillow. Fonts: RobotoMono-Regular.ttf in --fonts
(default: ./fonts next to this script); falls back to DejaVu Sans if missing.
Background #1E5F74 = the launcher icon colour (res/values/ic_launcher_background.xml);
Teal Medium #619793, text-on-dark #FFFFFF. No gradients (visual-design-principles).
"""
import argparse, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[4]
IMG = ROOT / "frontend/src/assets/images"
OUT = Path(__file__).resolve().parents[1]
TEAL_DARK = "#1E5F74"  # matches res/values/ic_launcher_background.xml (launcher icon)
WHITE = (255, 255, 255, 255)


def svg_to_png(svg: Path, width: int) -> Image.Image:
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        subprocess.run(["rsvg-convert", "-w", str(width), str(svg), "-o", tmp.name], check=True)
        return Image.open(tmp.name).convert("RGBA")


def as_white(im: Image.Image) -> Image.Image:
    """White-on-dark mark from matou-logo-teal.svg: keep the white mountain fills and
    key out the teal (#1e5f74) outline/triangles so the background shows through them —
    the same composition as the launcher icon. Alpha = original alpha x distance from
    the keyed teal (anti-aliased edges become semi-transparent white)."""
    key = (0x1E, 0x5F, 0x74)
    px = im.load()
    out = Image.new("RGBA", im.size, (255, 255, 255, 0))
    op = out.load()
    span = sum((255 - k) for k in key)
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            d = abs(r - key[0]) + abs(g - key[1]) + abs(b - key[2])
            op[x, y] = (255, 255, 255, int(a * min(1.0, d / span)))
    return out.crop(out.getbbox())


def font(fonts_dir: Path, name: str, size: int):
    p = fonts_dir / name
    if p.exists():
        return ImageFont.truetype(str(p), size)
    for fb in ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if Path(fb).exists():
            print(f"warning: {name} not found, falling back to DejaVu Sans", file=sys.stderr)
            return ImageFont.truetype(fb, size)
    return ImageFont.load_default()


def make_icon():
    size = 512
    canvas = Image.new("RGBA", (size, size), TEAL_DARK)
    mark = as_white(svg_to_png(IMG / "matou-logo-teal.svg", int(size * 0.66)))
    canvas.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2 + 8))
    canvas.convert("RGB").save(OUT / "icon-512.png", optimize=True)


def make_feature(fonts_dir: Path):
    W, H = 1024, 500
    canvas = Image.new("RGBA", (W, H), TEAL_DARK)
    mark = as_white(svg_to_png(IMG / "matou-logo-teal.svg", 300))
    word = svg_to_png(IMG / "matou-text-logo-white.svg", 440)
    # clear space = height of the "M" in the wordmark (~ word.height)
    gap = 56
    block_w = mark.width + gap + word.width
    x0 = (W - block_w) // 2
    canvas.alpha_composite(mark, (x0, (H - mark.height) // 2 - 22))
    wy = (H - word.height) // 2 - 40
    canvas.alpha_composite(word, (x0 + mark.width + gap, wy))
    draw = ImageDraw.Draw(canvas)
    f = font(fonts_dir, "RobotoMono-Regular.ttf", 19)
    tag = "CONNECTION · COLLABORATION · INNOVATION"
    tw = draw.textlength(tag, font=f)
    draw.text((x0 + mark.width + gap + (word.width - tw) / 2, wy + word.height + 26), tag, font=f, fill=WHITE)
    canvas.convert("RGB").save(OUT / "feature-graphic-1024x500.png", optimize=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fonts", type=Path, default=Path(__file__).parent / "fonts")
    a = ap.parse_args()
    make_icon()
    make_feature(a.fonts)
    for p in ["icon-512.png", "feature-graphic-1024x500.png"]:
        im = Image.open(OUT / p); print(p, im.size, f"{(OUT/p).stat().st_size//1024} KB")
