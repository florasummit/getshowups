# Builds every icon SVG in brand/icon/ from one geometry: Calendar + Growth, concept A "Refined" (approved 2026-11-25).
# A compact orange calendar (17 x 16, radius 3, stroke 2.2) opens at its top-right corner for a white check (stroke 2.4)
# whose long stroke runs through that corner at 45 degrees and ends in a solid pointed arrowhead beyond the outline.
# The outline ends are opened until they clear the head and shaft by GAP; the whole composition is centred on (16, 16).
# Run from the repo root:  python3 brand/source/icon.py   (then the wordmark script and scripts/build-brand.mjs)
import math
R2 = math.sqrt(2); U = (1 / R2, -1 / R2); N = (1 / R2, 1 / R2)
X0, X1, Y0, Y1 = 6, 23, 11, 27        # calendar outline before centring
ELBOW = (13, 21)                      # the check's elbow; its long stroke passes the corner (X1, Y0)
D, L, H = 0.6, 5.2, 3.3               # head: base centre D past the corner, length L, half-width H
GAP = 1.5

def f(v): return ('%.2f' % v).rstrip('0').rstrip('.')
def seg(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
def poly(p, pts): return min(seg(p, pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts)))

C = (X1 + D * U[0], Y0 + D * U[1])
T = (C[0] + L * U[0], C[1] + L * U[1])
HEAD = [T, (C[0] - H * N[0], C[1] - H * N[1]), (C[0] + H * N[0], C[1] + H * N[1])]
need = GAP + 1.1
top = X1 - 3
while min(poly((top, Y0), HEAD), seg((top, Y0), ELBOW, C)) < need: top -= 0.05
right = Y0 + 3
while min(poly((X1, right), HEAD), seg((X1, right), ELBOW, C)) < need: right += 0.05
xs = [X0 - 1.1, X1 + 1.1] + [p[0] for p in HEAD]; ys = [Y0 - 3.6, Y1 + 1.1] + [p[1] for p in HEAD]
DX = 16 - (min(xs) + max(xs)) / 2; DY = 16 - (min(ys) + max(ys)) / 2
P = lambda p: f'{f(p[0] + DX)} {f(p[1] + DY)}'
shaft_end = (C[0] - 0.3 * U[0], C[1] - 0.3 * U[1])
CAL = f'M{P((top, Y0))}H{f(X0 + 3 + DX)}a3 3 0 0 0-3 3v{f(Y1 - Y0 - 6)}a3 3 0 0 0 3 3h{f(X1 - X0 - 6)}a3 3 0 0 0 3-3V{f(right + DY)}'
RINGS = f'M{P((X0 + 4, Y0 - 2.5))}v4M{P((X0 + 9, Y0 - 2.5))}v4'
CHECK = f'M{P((ELBOW[0] - 3.5, ELBOW[1] - 3.5))}L{P(ELBOW)}L{P(shaft_end)}'
ARROW = 'M' + 'L'.join(P(p) for p in HEAD) + 'Z'

def art(white):
    return (f'<path d="{CAL}" fill="none" stroke="#FF6A1A" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<path d="{RINGS}" fill="none" stroke="#FF6A1A" stroke-width="2.2" stroke-linecap="round"/>'
            f'<path d="{CHECK}" fill="none" stroke="{white}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<path d="{ARROW}" fill="{white}"/>')
def write(name, bg, white='#FFFFFF'):
    open(f'brand/icon/{name}', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">{bg}{art(white)}</svg>\n')
write('getshowups-icon.svg', '<rect width="32" height="32" rx="8" fill="#111113"/>')
write('getshowups-icon-raised.svg', '<rect width="32" height="32" rx="8" fill="#22242A"/>')
write('getshowups-icon-square.svg', '<rect width="32" height="32" fill="#111113"/>')
write('getshowups-mark-transparent-on-dark.svg', '')
write('getshowups-mark-transparent-on-light.svg', '', '#111216')
print('icon paths:', CAL, RINGS, CHECK, ARROW, sep='\n  ')
