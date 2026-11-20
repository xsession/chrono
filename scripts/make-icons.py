#!/usr/bin/env python3
"""Render Chrono's app icon (commit-graph mark) at installer resolutions.

Outputs build/icon.png (1024), build/icons/<size>x<size>.png for Linux,
build/icon.ico (Windows) and public/rsrc icons for the web UI.
Run: python3 scripts/make-icons.py   (needs Pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
S = 1024

def render(size: int = S) -> Image.Image:
    scale = 4  # supersample for smooth curves
    n = size * scale
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(n * 0.06)
    radius = int(n * 0.22)
    # background: deep slate rounded square with a subtle vertical gradient
    bg = Image.new("RGBA", (n, n))
    g = ImageDraw.Draw(bg)
    for y in range(n):
        t = y / n
        g.line([(0, y), (n, y)], fill=(int(30 + 8 * t), int(34 + 6 * t), int(43 + 10 * t), 255))
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, n - pad, n - pad], radius=radius, fill=255)
    img.paste(bg, (0, 0), mask)
    w = int(n * 0.055)
    teal, purple, orange = (43, 196, 180, 255), (176, 124, 242, 255), (242, 163, 58, 255)
    x1, x2, x3 = int(n * 0.36), int(n * 0.56), int(n * 0.72)
    top, bottom = int(n * 0.21), int(n * 0.82)
    # main lane
    d.line([(x1, top), (x1, bottom)], fill=teal, width=w)
    # branch lane leaving and merging back (smooth bezier-ish polyline)
    def curve(xa, ya, xb, yb, color):
        pts = []
        for i in range(41):
            t = i / 40
            ease = t * t * (3 - 2 * t)
            pts.append((xa + (xb - xa) * ease, ya + (yb - ya) * t))
        d.line(pts, fill=color, width=w, joint="curve")
    curve(x1, int(n * 0.30), x2, int(n * 0.44), purple)
    d.line([(x2, int(n * 0.44)), (x2, int(n * 0.56))], fill=purple, width=w)
    curve(x2, int(n * 0.56), x1, int(n * 0.66), purple)
    curve(x2, int(n * 0.47), x3, int(n * 0.58), orange)
    # commit nodes
    def node(x, y, color, r=0.062, hollow=False):
        rr = int(n * r)
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(30, 34, 43, 255), outline=color, width=int(w * 0.95))
        if not hollow:
            inner = int(rr * 0.42)
            d.ellipse([x - inner, y - inner, x + inner, y + inner], fill=color)
    node(x1, top + int(n * 0.02), teal, hollow=True)  # WIP
    node(x2, int(n * 0.50), purple)
    node(x3, int(n * 0.58), orange)
    node(x1, int(n * 0.66), teal, r=0.07)  # merge
    node(x1, bottom, teal)
    return img.resize((size, size), Image.LANCZOS)

def main() -> None:
    (ROOT / "build" / "icons").mkdir(parents=True, exist_ok=True)
    master = render(S)
    master.save(ROOT / "build" / "icon.png")
    for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        master.resize((size, size), Image.LANCZOS).save(ROOT / "build" / "icons" / f"{size}x{size}.png")
    master.save(ROOT / "build" / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    rsrc = ROOT / "public" / "rsrc"
    master.resize((32, 32), Image.LANCZOS).save(rsrc / "icon_32x32.png")
    master.resize((256, 256), Image.LANCZOS).save(rsrc / "icon_256x256.png")
    master.resize((180, 180), Image.LANCZOS).save(rsrc / "apple-touch-icon.png")
    print("icons written to build/ and public/rsrc/")

if __name__ == "__main__":
    main()
