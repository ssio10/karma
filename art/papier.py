# Macht den Papiergrund eines Figurenbilds weiß, damit die Figur im Spiel nahtlos auf dem Kartenpapier liegt
# (dort wird sie per "multiply" aufgelegt). Der Papierton wird am Bildrand gemessen.
# Aufruf: python3 papier.py ein.bmp aus.bmp [faktor]      (BMP unkomprimiert, 24 oder 32 Bit)
# faktor: Weißpunkt im Verhältnis zum gemessenen Papier; kleiner = auch Heftlinien und Flecken verschwinden
import struct, sys

def load(path):
    b = open(path, 'rb').read()
    off = struct.unpack_from('<I', b, 10)[0]
    w, h = struct.unpack_from('<ii', b, 18)
    n = struct.unpack_from('<H', b, 28)[0] // 8
    flip = h > 0; h = abs(h)
    stride = (w * n + 3) & ~3
    rows = []
    for y in range(h):
        yy = (h - 1 - y) if flip else y
        rows.append(b[off + yy * stride: off + yy * stride + w * n])
    return w, h, n, rows

def save(path, w, h, rows):            # rows: je Zeile w*3 Bytes (BGR), von oben nach unten
    pad = b'\0' * ((4 - (w * 3) % 4) % 4)
    data = b''.join(rows[y] + pad for y in range(h - 1, -1, -1))
    head = b'BM' + struct.pack('<IHHI', 54 + len(data), 0, 0, 54)
    head += struct.pack('<IiiHHIIiiII', 40, w, h, 1, 24, 0, len(data), 2835, 2835, 0, 0)
    open(path, 'wb').write(head + data)

def main(src, dst, f=0.955):
    w, h, n, rows = load(src)
    ring = []                            # Papierproben: ein 5 Pixel breiter Rand
    for y in range(h):
        xs = range(w) if (y < 5 or y >= h - 5) else list(range(5)) + list(range(w - 5, w))
        r = rows[y]
        for x in xs:
            b, g, rr = r[x * n], r[x * n + 1], r[x * n + 2]
            if (rr * 30 + g * 59 + b * 11) // 100 > 185: ring.append((b, g, rr))
    tables = []
    for c in range(3):
        v = sorted(p[c] for p in ring)
        white = max(60, v[len(v) // 10] * f)        # etwas unter dem dunkleren Papier: alles Papier wird weiß
        tables.append(bytes(min(255, int(i * 255 / white + .5)) for i in range(256)))
    out = []
    for r in rows:
        o = bytearray(w * 3)
        for c in range(3): o[c::3] = r[c::n].translate(tables[c])
        out.append(bytes(o))
    save(dst, w, h, out)

main(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 0.955)
