#!/usr/bin/env python3
"""N1 — measure the Context Fence logo alpha channel precisely.

Alpha-edge detection: for each pixel, compute alpha; find bounding box of
pixels with alpha > 8 (i.e. visibly opaque region). Also report:
- full canvas dims
- whether alpha is fully transparent in corners (16:9/3:2 frame claim)
- circle fit: center = bbox center, diameter = min(bbox w,h)
- fractional alpha pixels (antialiased edge ring) count
- max alpha coverage per row/col to confirm circular silhouette
"""
from PIL import Image
import sys

img = Image.open(sys.argv[1] if len(sys.argv) > 1 else 'frontend/public/logo.png').convert('RGBA')
w, h = img.size
px = img.load()

xs = []; ys = []
min_x = w; min_y = h; max_x = -1; max_y = -1
transparent_corner = 0
opaque = 0
partial = 0

for y in range(h):
    for x in range(w):
        a = px[x, y][3]
        if a > 8:
            xs.append(x); ys.append(y)
            if x < min_x: min_x = x
            if x > max_x: max_x = x
            if y < min_y: min_y = y
            if y > max_y: max_y = y
            if a == 255: opaque += 1
            else: partial += 1

n = len(xs)
cx = min_x + (max_x - min_x) / 2
cy = min_y + (max_y - min_y) / 2
diam = min(max_x - min_x + 1, max_y - min_y + 1)

print(f"canvas: {w}x{h}")
print(f"aspect: {w/h:.4f} (3:2 would be 1.5, 16:9 would be 1.7778)")
print(f"opaque (a>8) pixel count: {n}  (full-opaque {opaque}, antialiased partial {partial})")
print(f"bounding box x:[{min_x},{max_x}] y:[{min_y},{max_y}]  -> w:{max_x-min_x+1} h:{max_y-min_y+1}")
print(f"bbox center: ({cx:.1f}, {cy:.1f})  vs canvas center ({w/2:.1f}, {h/2:.1f})")
print(f"center offset: dx={cx-w/2:+.1f}px dy={cy-h/2:+.1f}px")
print(f"circle diameter (min bbox dim): {diam}px")
print(f"corners alpha: TL={px[0,0][3]} TR={px[w-1,0][3]} BL={px[0,h-1][3]} BR={px[w-1,h-1][3]} (all 0 => transparent frame)")

# silhouette check: is the opaque region actually a circle?
# sample alpha along horizontal line through bbox center
cx_i = int(cx); cy_i = int(cy)
row = [(px[x, cy_i][3], x) for x in range(min_x, max_x + 1) if px[x, cy_i][3] > 8]
col = [(px[cx_i, y][3], y) for y in range(min_y, max_y + 1) if px[cx_i, y][3] > 8]
if row and col:
    row_edge_l = row[0][1] - min_x
    row_edge_r = max_x - row[-1][1]
    col_edge_t = col[0][1] - min_y
    col_edge_b = max_y - col[-1][1]
    print(f"silhouette at center cross: row spans {min_x+row_edge_l}..{max_x-row_edge_r}, col spans {min_y+col_edge_t}..{max_y-col_edge_b}")
    print(f"edge margins (l,r,t,b): {row_edge_l},{row_edge_r},{col_edge_t},{col_edge_b}")
