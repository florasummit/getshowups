# Builds brand/logo/getshowups-logo-on-{light,dark}.svg: the icon plus the wordmark as outlines, laid out exactly as
# src/components/Logo.jsx renders in the nav (icon 28 px, gap 10 px, Inter 750 at 18.4 px, letter-spacing -0.02em,
# line-height 1.6, text centred on the icon). Kerning and contextual forms come from HarfBuzz, like the browser.
# Run from the repo root:  uv run --with fonttools --with brotli --with uharfbuzz python brand/source/outline-wordmark.py
import json, sys, re
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
FONT = sys.argv[1] if len(sys.argv) > 1 else 'public/site-fonts/inter.woff2'
SIZE, LS, WGHT = 18.4, -0.02 * 18.4, 750
f = TTFont(FONT)
upem = f['head'].unitsPerEm
data = open(FONT, 'rb').read()
# harfbuzz needs sfnt; decompress woff2 via fontTools
import io
buf = io.BytesIO(); f.flavor = None; f.save(buf); sfnt = buf.getvalue()
face = hb.Face(sfnt); font = hb.Font(face); font.set_variations({'wght': WGHT})
gs = TTFont(io.BytesIO(sfnt)).getGlyphSet(location={'wght': WGHT})
order = TTFont(io.BytesIO(sfnt)).getGlyphOrder()
s = SIZE / upem
asc, desc = 1984 * s, 494 * s
baseline = round(14 - (1.6 * SIZE) / 2 + (1.6 * SIZE - asc - desc) / 2 + asc)  # browsers snap the baseline to a whole CSS px (20.69 -> 21)
out = {}
x0 = 38.0
x = x0
for part in ['GetShow', 'Ups']:
    b = hb.Buffer(); b.add_str(part); b.guess_segment_properties()
    hb.shape(font, b, {'kern': True, 'liga': True, 'calt': True})
    d = []
    for info, pos in zip(b.glyph_infos, b.glyph_positions):
        pen = SVGPathPen(gs, ntos=lambda v: ('%.3f' % v).rstrip('0').rstrip('.'))
        gs[order[info.codepoint]].draw(TransformPen(pen, (s, 0, 0, -s, x + pos.x_offset * s, baseline - pos.y_offset * s)))
        d.append(pen.getCommands())
        x += pos.x_advance * s + LS
    out[part] = ' '.join(d)
out['width'] = x - x0
out['baseline'] = baseline
out['total'] = x
W = round(out['total'] + 0.6, 2)
icon = open('brand/icon/getshowups-icon.svg').read()
art = re.search(r'<path.*</svg>', icon, re.S).group(0)[:-6]  # calendar + check, without the background
def logo(bg, ink, accent, name):
    open(f'brand/logo/{name}', 'w').write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} 28" width="{W}" height="28"><title>GetShowUps</title>'
        f'<g transform="scale(0.875)"><rect width="32" height="32" rx="8" fill="{bg}"/>{art}</g>'
        f'<path fill="{ink}" d="{out['GetShow']}"/><path fill="{accent}" d="{out['Ups']}"/></svg>\n')
logo('#0B0B0C', '#111216', '#C2410C', 'getshowups-logo-on-light.svg')
logo('#22242A', '#FFFFFF', '#FF8A47', 'getshowups-logo-on-dark.svg')
# The wordmark alone (homepage navigation): same outlines, shifted to start at 0, same 28 px line box.
WW = round(out['width'] + 0.6, 2)
def wordmark(ink, accent, name):
    open(f'brand/logo/{name}', 'w').write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WW} 28" width="{WW}" height="28"><title>GetShowUps</title>'
        f'<g transform="translate(-38 0)"><path fill="{ink}" d="{out['GetShow']}"/><path fill="{accent}" d="{out['Ups']}"/></g></svg>\n')
wordmark('#111216', '#C2410C', 'getshowups-wordmark-on-light.svg')
wordmark('#FFFFFF', '#FF8A47', 'getshowups-wordmark-on-dark.svg')
print(f"wordmark width {out['width']:.2f} px, baseline {out['baseline']}, logo {W} x 28")
