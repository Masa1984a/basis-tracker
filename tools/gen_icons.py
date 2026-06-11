"""gen_icons.py — basis-tracker の PWA アイコンを生成する(Pillow)。
テーマ色: bg #0b0e11 / amber #e2a33c / green #46d08a。上昇チャートのモチーフ。
4倍スーパーサンプリングしてLANCZOS縮小=エッジを綺麗に。
出力: public/icons/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

PROJECT = Path(__file__).resolve().parent.parent
OUT = PROJECT / "public" / "icons"
SS = 4  # supersample

BG = (11, 14, 17, 255)       # #0b0e11
PANEL = (20, 24, 29, 255)    # #14181d
AMBER = (226, 163, 60, 255)  # #e2a33c
GREEN = (70, 208, 138)       # #46d08a
LINE = (35, 42, 51, 255)     # #232a33

# 上昇チャートの頂点(0..1, y は上が0)
PTS = [(0.00, 0.70), (0.20, 0.78), (0.40, 0.52), (0.58, 0.60), (0.78, 0.30), (1.00, 0.16)]


def draw_icon(px: int, rounded: bool, pad_ratio: float) -> Image.Image:
    S = px * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 背景
    if rounded:
        r = int(S * 0.22)
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=BG)
    else:
        d.rectangle([0, 0, S, S], fill=BG)  # maskable はフルブリード(OSが角丸処理)

    # コンテンツ領域
    pad = int(S * pad_ratio)
    x0, y0, x1, y1 = pad, pad, S - pad, S - pad
    w, h = x1 - x0, y1 - y0
    base_y = y1  # チャートの基線

    pts = [(x0 + p[0] * w, y0 + p[1] * h) for p in PTS]

    # 基線グリッド(薄く)
    for gy in (0.34, 0.67):
        yy = int(y0 + gy * h)
        d.line([(x0, yy), (x1, yy)], fill=LINE, width=max(1, int(S * 0.004)))

    # エリア塗り(green 半透明)
    poly = pts + [(pts[-1][0], base_y), (pts[0][0], base_y)]
    d.polygon(poly, fill=GREEN + (70,))

    # チャート線(amber, 丸キャップ)
    lw = max(2, int(S * 0.05))
    d.line(pts, fill=AMBER, width=lw, joint="curve")
    rcap = lw // 2
    for (px_, py_) in (pts[0], pts[-1]):
        d.ellipse([px_ - rcap, py_ - rcap, px_ + rcap, py_ + rcap], fill=AMBER)
    # 頂点ドット
    dot = max(3, int(S * 0.022))
    for (px_, py_) in pts:
        d.ellipse([px_ - dot, py_ - dot, px_ + dot, py_ + dot], fill=AMBER)

    return img.resize((px, px), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("icon-192.png", 192, True, 0.18),
        ("icon-512.png", 512, True, 0.18),
        ("icon-maskable-512.png", 512, False, 0.26),  # 安全領域を広めに
        ("apple-touch-icon.png", 180, False, 0.20),    # iOS は自前で角丸
    ]
    for name, px, rounded, pad in jobs:
        img = draw_icon(px, rounded, pad)
        if name == "apple-touch-icon.png":
            img = img.convert("RGB")  # iOS は透過非対応
        img.save(OUT / name)
        print(f"  wrote {name} ({px}x{px})")
    print(f"done -> {OUT}")


if __name__ == "__main__":
    main()
