#!/usr/bin/env python3
"""Builds the bundled Libre Franklin woff2 files in public/fonts/ (spec #71).

Libre Franklin ships proportional figures only (no `tnum` feature), and the design wants
tabular numerals for every date, minute, quantity and week number. This script takes the
upstream variable font, cuts four static weights, subsets them to Latin, and gives the
digits 0-9 one shared advance width (outlines centred), so figures are tabular by default.

Usage (needs `pip install fonttools brotli`):
  curl -LO 'https://github.com/google/fonts/raw/main/ofl/librefranklin/LibreFranklin%5Bwght%5D.ttf'
  python3 scripts/build-font.py 'LibreFranklin[wght].ttf' public/fonts
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

WEIGHTS = [400, 600, 800, 900]
UNICODES = (
    list(range(0x20, 0x7F))  # Basic Latin
    + list(range(0xA0, 0x180))  # Latin-1 Supplement, Latin Extended-A
    + [0x2010, 0x2011, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2039, 0x203A, 0x20AC, 0x2212, 0x2192]
)


def tabular_digits(font: TTFont) -> None:
    cmap = font.getBestCmap()
    glyf = font["glyf"]
    hmtx = font["hmtx"]
    names = [cmap[ord(d)] for d in "0123456789"]
    width = max(hmtx[n][0] for n in names)
    for name in names:
        advance, lsb = hmtx[name]
        dx = round((width - advance) / 2)
        glyph = glyf[name]
        if glyph.isComposite():
            for component in glyph.components:
                component.x += dx
        elif glyph.numberOfContours > 0:
            glyph.coordinates.translate((dx, 0))
        glyph.recalcBounds(glyf)
        hmtx[name] = (width, lsb + dx)


def main(source: str, out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for weight in WEIGHTS:
        font = instancer.instantiateVariableFont(TTFont(source), {"wght": weight})
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=UNICODES)
        subsetter.subset(font)
        tabular_digits(font)
        font.flavor = "woff2"
        target = out / f"libre-franklin-{weight}.woff2"
        font.save(target)
        print(target, target.stat().st_size)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
