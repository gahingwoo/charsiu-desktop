#!/usr/bin/env python3
# Draw the app icon (a "c" arc on a rounded square) and write the PNG and ICO
# files Tauri bundles. Standard library only.
#
#   python3 tools/make-icons.py
#
# SPDX-License-Identifier: GPL-2.0-only
import math, os, struct, zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons')
BG = (21, 21, 21)        # PatternFly dark background
FG = (255, 255, 255)
ACCENT = (115, 188, 247)  # PatternFly blue 300


def draw(n):
    ss = 4
    N = n * ss
    px = []
    r_corner = 0.22 * N
    cx = cy = N / 2
    ro, ri = 0.33 * N, 0.21 * N
    for y in range(n):
        row = []
        for x in range(n):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    X = x * ss + sx + 0.5
                    Y = y * ss + sy + 0.5
                    # rounded square
                    dx = max(r_corner - X, X - (N - r_corner), 0)
                    dy = max(r_corner - Y, Y - (N - r_corner), 0)
                    if dx * dx + dy * dy > r_corner * r_corner:
                        continue
                    col = BG
                    d = math.hypot(X - cx, Y - cy)
                    a = math.degrees(math.atan2(Y - cy, X - cx))
                    if ri <= d <= ro and not (-38 <= a <= 38):
                        col = FG
                    # the dot: a token leaving the "c"
                    if math.hypot(X - (cx + 0.30 * N), Y - cy) <= 0.065 * N:
                        col = ACCENT
                    acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
            k = ss * ss
            a = acc[3] / k
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                w = acc[3] / 255
                row.append((round(acc[0] / w), round(acc[1] / w), round(acc[2] / w), round(a)))
        px.append(row)
    return px


def png(px):
    n = len(px)
    raw = b''.join(b'\0' + bytes(c for p in row for c in p) for row in px)
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def ico(pngs):
    head = struct.pack('<HHH', 0, 1, len(pngs))
    off = 6 + 16 * len(pngs)
    dirs, data = b'', b''
    for n, p in pngs:
        dirs += struct.pack('<BBBBHHII', n % 256, n % 256, 0, 0, 1, 32, len(p), off + len(data))
        data += p
    return head + dirs + data


os.makedirs(OUT, exist_ok=True)
cache = {}
def get(n):
    if n not in cache:
        cache[n] = png(draw(n))
    return cache[n]
for name, n in [('32x32.png', 32), ('128x128.png', 128), ('128x128@2x.png', 256), ('icon.png', 512)]:
    open(os.path.join(OUT, name), 'wb').write(get(n))
open(os.path.join(OUT, 'icon.ico'), 'wb').write(ico([(n, get(n)) for n in (16, 24, 32, 48, 64, 256)]))
print('icons written to', os.path.normpath(OUT))
