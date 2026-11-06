#!/usr/bin/env python3
"""Decode a PNG with the stdlib and print a coarse colour grid, so a frame can be judged
without a vision model. usage: python3 tools/png-grid.py shot.png [cols] [rows]"""
import sys
import zlib
import struct

path = sys.argv[1]
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 24
rows = int(sys.argv[3]) if len(sys.argv) > 3 else 14

raw = open(path, 'rb').read()
assert raw[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
pos = 8
chunks = {}
idat = b''
while pos < len(raw):
    ln = struct.unpack('>I', raw[pos:pos + 4])[0]
    typ = raw[pos + 4:pos + 8]
    data = raw[pos + 8:pos + 8 + ln]
    if typ == b'IHDR':
        w, h, depth, colour, comp, filt, inter = struct.unpack('>IIBBBBB', data)
        chunks['IHDR'] = (w, h, depth, colour)
    elif typ == b'IDAT':
        idat += data
    elif typ == b'IEND':
        break
    pos += 12 + ln

w, h, depth, colour = chunks['IHDR']
assert depth == 8 and colour in (2, 6), f'unsupported png: depth {depth} colour {colour}'
channels = 3 if colour == 2 else 4
stride = w * channels
buf = zlib.decompress(idat)
out = bytearray(h * stride)
prev = bytearray(stride)
p = 0
for y in range(h):
    f = buf[p]
    p += 1
    line = bytearray(buf[p:p + stride])
    p += stride
    if f == 1:
        for i in range(channels, stride):
            line[i] = (line[i] + line[i - channels]) & 0xFF
    elif f == 2:
        for i in range(stride):
            line[i] = (line[i] + prev[i]) & 0xFF
    elif f == 3:
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
    elif f == 4:
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            pp = a + b - c
            pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
            pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[i] = (line[i] + pr) & 0xFF
    out[y * stride:(y + 1) * stride] = line
    prev = line

view = memoryview(out)


def px(x, y):
    o = y * stride + x * channels
    return view[o], view[o + 1], view[o + 2]


print(f'{path} {w}x{h}')
red = 0
for gy in range(rows):
    cells = []
    for gx in range(cols):
        x0, x1 = gx * w // cols, (gx + 1) * w // cols
        y0, y1 = gy * h // rows, (gy + 1) * h // rows
        r = g = b = n = 0
        for y in range(y0, y1, 2):
            for x in range(x0, x1, 2):
                pr, pg, pb = px(x, y)
                r += pr; g += pg; b += pb; n += 1
        cells.append((r // n, g // n, b // n))
    print(' '.join(f'{c[0]:02x}{c[1]:02x}{c[2]:02x}' for c in cells))

for y in range(0, h, 2):
    for x in range(0, w, 2):
        r, g, b = px(x, y)
        if r > 95 and r - g > 55 and r - b > 45:
            red += 1
total = (h // 2) * (w // 2)
print(f'livery red {red} / {total} = {100.0 * red / total:.2f}%')
