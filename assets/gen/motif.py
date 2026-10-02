#!/usr/bin/env python3
"""摩天楼 Skyscraper 的美术资产工厂 —— 一条命令重跑出一整套位图，字节可复现。

为什么在仓内自己画，而不是等组合级图标工厂派下来：这一套位图不只是商店图标，盘上
`css/game.css` 与 `index.html` 要真的引用它们（页面底纹、胜利卡的天际线、favicon /
apple-touch / PWA / og），母题必须和玩法同源 —— 所以母题的定义跟着玩法代码放在一起。

母题（从 js/theme.js 实测取色，不另开一张色表）：
  夜里望进去的一排楼，高度互不相同，最高那栋站在最后。四条边印出的数字写着"从这一边
  数进去看得见几栋"，所以图标上就贴着那个读数。塔身是 bg-bottom / surface-lift 的暗面，
  窗灯是 accent 的琥珀，读数用 info 的冷蓝 —— 这三色就是游戏里"没填的格 / 写下的楼高 /
  边上的可见数"的颜色，图标与盘面因此不可能长成两个游戏。

确定性：所有"随机"（窗灯亮灭、星星位置）都走本文件自带的 LCG，不碰 random.SystemRandom
也不碰 Math.random —— 重跑必须产出同样的字节，否则资产 diff 会淹掉真正的改动。

依赖：Pillow（与量具 sellability.py 同一依赖，读 PNG IHDR 也要它）。无网络、无外部字体
文件之外的输入；中文不进位图（本机没有 PingFang，字形会渲染成豆腐块），图内只出现拉丁
字母与数字。

用法：python3 assets/gen/motif.py [--only-icons]
"""
from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ASSETS = os.path.join(REPO, "assets")

# ---- palette: copied by reading js/theme.js at run time, so a token edit here cannot drift -----
def read_palette():
    src = open(os.path.join(REPO, "js", "theme.js"), encoding="utf-8").read()
    import re

    hexes = dict(re.findall(r"(\w+)\s*:\s*'#([0-9a-fA-F]{6})'", src))
    want = ("bgTop", "bgBottom", "surface", "surfaceLift", "line", "lineHeavy", "ink", "accent", "info", "success")
    missing = [k for k in want if k not in hexes]
    if missing:
        raise SystemExit(f"js/theme.js 里没读到色 token {missing} —— 母题不许凭空编色")
    return {k: tuple(int(hexes[k][i:i + 2], 16) for i in (0, 2, 4)) for k in want}


P = read_palette()


def rgba(c, a):
    return (c[0], c[1], c[2], a)


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(3))


class Lcg:
    """确定性伪随机（Numerical Recipes 的参数）。资产必须可复现，所以不用 random 模块。"""

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def next(self):
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return self.s

    def unit(self):
        return self.next() / 0xFFFFFFFF

    def range(self, lo, hi):
        return lo + self.unit() * (hi - lo)


def font(size, mono=True):
    for cand in (
        ("/System/Library/Fonts/SFNSMono.ttf" if mono else "/System/Library/Fonts/Helvetica.ttc"),
        ("/Library/Fonts/SFNSMono.ttf",),
        ("/System/Library/Fonts/Supplemental/Arial.ttf",),
    ):
        path = cand if isinstance(cand, str) else cand[0]
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def v_gradient(img, top, bottom):
    d = ImageDraw.Draw(img)
    h = img.height
    for y in range(h):
        d.line([(0, y), (img.width, y)], fill=mix(top, bottom, y / max(1, h - 1)))


# ---- the motif ---------------------------------------------------------------
# One tower: a shaft, a setback crown, window lights, and an antenna on the tall ones.
# Heights are a permutation; the *visible count* from the left is what the badge prints.
TOWERS = [3, 5, 1, 6, 4, 2]  # 6 栋楼的高度排列；从左望进去看得见 3、5、6 三栋 → 读数 3
READOUT = 3


def tower(d, x, w, base_y, top_y, body, edge, lit, rnd):
    r = max(2, int(w * 0.14))
    d.rounded_rectangle([x, top_y, x + w, base_y], radius=r, fill=body, outline=edge, width=max(1, int(w * 0.03)))
    # setback crown, so the silhouette is not a plain rectangle at thumbnail size
    cw = w * 0.44
    cx = x + (w - cw) / 2
    d.rectangle([cx, top_y - w * 0.16, cx + cw, top_y], fill=body, outline=edge)
    # window lattice: a grid of slots, a deterministic subset lit amber
    cols = max(2, int(w // max(3.0, w * 0.22)))
    rows = max(3, int((base_y - top_y) // max(4.0, w * 0.30)))
    pad = w * 0.14
    gw = (w - 2 * pad) / cols
    gh = (base_y - top_y - pad) / rows
    ww, wh = gw * 0.62, gh * 0.5
    for i in range(cols):
        for j in range(rows):
            wx = x + pad + i * gw + (gw - ww) / 2
            wy = top_y + pad * 0.6 + j * gh
            if wy + wh > base_y - pad * 0.4:
                continue
            r0 = rnd.unit()
            if r0 < lit:
                d.rectangle([wx, wy, wx + ww, wy + wh], fill=rgba(P["accent"], 235))
            elif r0 < lit + 0.18:
                d.rectangle([wx, wy, wx + ww, wy + wh], fill=rgba(P["ink"], 120))
            else:
                d.rectangle([wx, wy, wx + ww, wy + wh], fill=rgba(P["bgTop"], 210))
    if w > 26 and (top_y - w * 0.16) < 0.36 * base_y:
        ax = x + w / 2
        d.line([(ax, top_y - w * 0.16), (ax, top_y - w * 0.55)], fill=rgba(P["accent"], 200), width=max(1, int(w * 0.05)))


def scene(size, safe=1.0, stars=1.0):
    """The badge scene at `size` px. `safe` < 1 shrinks the art into a maskable safe zone."""
    S = size
    img = Image.new("RGBA", (S, S), P["bgTop"] + (255,))
    v_gradient(img, P["bgTop"], P["bgBottom"])
    d = ImageDraw.Draw(img)
    rnd = Lcg(20260926)

    # horizon glow: the city's own light bleeding up into the sky
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([S * 0.08, S * 0.74, S * 0.92, S * 1.16], fill=rgba(mix(P["accent"], P["bgBottom"], 0.55), 78))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(S * 0.06)))
    d = ImageDraw.Draw(img)

    n = len(TOWERS)
    pad = S * (0.10 + (1 - safe) * 0.42)
    gutter = S * 0.018
    ground = S * (0.86 if safe >= 1 else 0.80)
    span = S - 2 * pad
    tw = (span - gutter * (n - 1)) / n
    maxh = ground - S * (0.30 if safe >= 1 else 0.24)

    for k, h in enumerate(TOWERS):
        x = pad + k * (tw + gutter)
        top = ground - maxh * (h / n)
        body = mix(P["surfaceLift"], P["info"], 0.06 + 0.05 * (h / n))
        tower(d, x, tw, ground, top, body, P["lineHeavy"], 0.30 + 0.42 * (h / n), rnd)

    # ground line and its reflection strip: the row the counts are read along
    d.rectangle([pad * 0.5, ground, S - pad * 0.5, ground + max(2, S * 0.006)], fill=P["lineHeavy"])
    refl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    rd = ImageDraw.Draw(refl)
    rd.rectangle([pad * 0.5, ground, S - pad * 0.5, S], fill=rgba(P["accent"], 16))
    img = Image.alpha_composite(img, refl)
    d = ImageDraw.Draw(img)

    # the visible count, printed above the row exactly like an edge clue on the board
    if safe >= 1:
        f = font(int(S * 0.135))
        txt = str(READOUT)
        bb = d.textbbox((0, 0), txt, font=f)
        tx = pad + (tw - (bb[2] - bb[0])) / 2 - bb[0]
        ty = S * 0.055 - bb[1]
        d.text((tx, ty), txt, font=f, fill=rgba(P["info"], 255))

    if stars > 0:
        srnd = Lcg(777)
        sd = ImageDraw.Draw(img)
        count = int(64 * stars * (S / 512))
        for _ in range(count):
            sx, sy = srnd.unit() * S, srnd.unit() * S * 0.5
            r = max(0.6, S * 0.0016 * srnd.range(0.6, 1.8))
            a = int(srnd.range(50, 200))
            sd.ellipse([sx - r, sy - r, sx + r, sy + r], fill=(255, 255, 255, a))
    return img


def rounded(img, radius_ratio=0.2237):
    S = img.width
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S, S], radius=int(S * radius_ratio), fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def skyline(width, height):
    """Transparent horizontal strip for the win card: the same permutation, walked end to end."""
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rnd = Lcg(4242)
    n = len(TOWERS)
    gutter = width * 0.006
    pad = width * 0.02
    tw = (width - 2 * pad - gutter * (n - 1)) / n
    ground = height * 0.94
    maxh = height * 0.78
    for k, h in enumerate(TOWERS):
        x = pad + k * (tw + gutter)
        top = ground - maxh * (h / n)
        tower(d, x, tw, ground, top, mix(P["surfaceLift"], P["info"], 0.10), P["lineHeavy"], 0.34 + 0.4 * (h / n), rnd)
    d.line([(0, ground), (width, ground)], fill=rgba(P["lineHeavy"], 220), width=max(1, int(height * 0.012)))
    return img


def night_sky(size):
    """Tileable-enough page backdrop: gradient + stars + a far horizon glow, low contrast on purpose
    so the board and the text keep all the contrast budget."""
    img = Image.new("RGBA", (size, size), P["bgTop"] + (255,))
    v_gradient(img, P["bgTop"], mix(P["bgBottom"], P["bgTop"], 0.35))
    rnd = Lcg(90210)
    d = ImageDraw.Draw(img)
    for _ in range(int(size * 0.42)):
        x, y = rnd.unit() * size, rnd.unit() * size
        r = max(0.5, size * 0.0012 * rnd.range(0.5, 2.2))
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, int(rnd.range(18, 96))))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([size * -0.2, size * 0.86, size * 1.2, size * 1.3], fill=rgba(P["accent"], 26))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(size * 0.09)))
    return img


def og_card():
    W, H = 1200, 630
    img = Image.new("RGBA", (W, H), P["bgTop"] + (255,))
    v_gradient(img, P["bgTop"], P["bgBottom"])
    badge = rounded(scene(470), 0.16)
    img.paste(badge, (56, 80), badge)

    d = ImageDraw.Draw(img)
    left, right = 612, W - 44
    room = right - left

    def fit(text, size, mono=False):
        """Shrink until the run fits the column: a social card with a clipped headline is worse
        than one with a smaller headline, and the clip is invisible until it is on someone's feed."""
        while size > 10:
            f = font(size, mono=mono)
            if d.textlength(text, font=f) <= room:
                return f
            size -= 2
        return font(10, mono=mono)

    d.text((left, 96), "SKYSCRAPER", font=fit("SKYSCRAPER", 64, mono=False), fill=P["ink"])
    line1, line2 = "how many towers can you see", "from this edge?"
    d.text((left + 2, 196), line1, font=fit(line1, 34, mono=False), fill=rgba(P["ink"], 210))
    d.text((left + 2, 240), line2, font=fit(line2, 34, mono=False), fill=rgba(P["ink"], 210))
    line3, line4 = "one answer per board, and a", "pencil-only path to it"
    d.text((left + 2, 306), line3, font=fit(line3, 28, mono=False), fill=rgba(P["info"], 235))
    d.text((left + 2, 342), line4, font=fit(line4, 28, mono=False), fill=rgba(P["info"], 235))

    # the four edge counts, printed the way the board prints them
    box, gap = 84, 20
    f = font(40)
    for k, v in enumerate([3, 1, 4, 2]):
        x0 = left + 2 + k * (box + gap)
        d.rounded_rectangle([x0, 400, x0 + box, 400 + 62], radius=12, outline=P["lineHeavy"], width=2, fill=rgba(P["surface"], 255))
        bb = d.textbbox((0, 0), str(v), font=f)
        d.text((x0 + box / 2 - (bb[2] - bb[0]) / 2 - bb[0], 400 + 31 - (bb[3] - bb[1]) / 2 - bb[1]),
               str(v), font=f, fill=P["accent"])
    footer = "z-biz-game · zero-guess logic deduction"
    d.text((left + 2, 566), footer, font=fit(footer, 22, mono=False), fill=rgba(P["ink"], 130))
    return img


ICONS = [
    ("icon-1024.png", 1024, 1.0, True),
    ("icon-512.png", 512, 1.0, True),
    ("icon-192.png", 192, 1.0, True),
    ("icon-180.png", 180, 1.0, True),
    ("icon-96.png", 96, 1.0, True),
    ("icon-64.png", 64, 1.0, True),
    ("icon-48.png", 48, 1.0, True),
    ("icon-32.png", 32, 1.0, True),
    ("icon-16.png", 16, 1.0, True),
    ("icon-maskable-512.png", 512, 0.62, False),
    ("icon-maskable-192.png", 192, 0.62, False),
]


def main():
    only_icons = "--only-icons" in sys.argv
    os.makedirs(os.path.join(ASSETS, "icons"), exist_ok=True)
    os.makedirs(os.path.join(ASSETS, "texture"), exist_ok=True)
    os.makedirs(os.path.join(ASSETS, "sprite"), exist_ok=True)
    os.makedirs(os.path.join(ASSETS, "og"), exist_ok=True)

    master = scene(1024)
    written = []
    for name, size, safe, do_round in ICONS:
        art = scene(size, safe=safe) if size != 1024 else master
        out = rounded(art) if do_round else art
        path = os.path.join(ASSETS, "icons", name)
        out.save(path, optimize=True)
        written.append(path)

    # favicon.ico carries 16/32/48 so the browser's implicit /favicon.ico probe never 404s
    ico_src = rounded(scene(48))
    ico_path = os.path.join(ASSETS, "icons", "favicon.ico")
    ico_src.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    written.append(ico_path)

    # apple-touch-icon: iOS never applies a mask, and it dislikes transparency — opaque square
    ati = scene(180).convert("RGB")
    ati_path = os.path.join(ASSETS, "icons", "apple-touch-icon.png")
    ati.save(ati_path, optimize=True)
    written.append(ati_path)

    if not only_icons:
        night_sky(512).save(os.path.join(ASSETS, "texture", "night-sky-512.png"), optimize=True)
        skyline(960, 240).save(os.path.join(ASSETS, "sprite", "skyline-960x240.png"), optimize=True)
        og_card().save(os.path.join(ASSETS, "og", "skyscraper-1200x630.png"), optimize=True)
        written += [
            os.path.join(ASSETS, "texture", "night-sky-512.png"),
            os.path.join(ASSETS, "sprite", "skyline-960x240.png"),
            os.path.join(ASSETS, "og", "skyscraper-1200x630.png"),
        ]
    for p in written:
        print(f"{os.path.relpath(p, REPO)}  {Image.open(p).size}  {os.path.getsize(p)}B")


if __name__ == "__main__":
    main()
