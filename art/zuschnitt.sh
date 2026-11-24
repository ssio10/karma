#!/bin/sh
# Schneidet die Originalbilder aus art/ für das Spiel zu (macOS, braucht nur sips). Aufruf: sh art/zuschnitt.sh
cd "$(dirname "$0")/.." || exit 1
O=src/img; mkdir -p $O
TMP=$(mktemp -d)
# crop <quelle> <x> <y> <breite> <höhe> <ziel> <zielbreite> <zielhöhe> <qualität> [weißpunkt]
# Mit einem Weißpunkt als letztem Wert wird der Papiergrund weiß gerechnet (art/papier.py), für Bilder, die im Spiel aufs Kartenpapier gelegt werden.
crop() {
  sips -c "$5" "$4" --cropOffset "$3" "$2" "art/$1" --out "$TMP/c.png" -s format png >/dev/null 2>&1
  IN="$TMP/c.png"
  if [ -n "${10}" ]; then
    sips -s format bmp "$TMP/c.png" --out "$TMP/c.bmp" >/dev/null 2>&1
    python3 art/papier.py "$TMP/c.bmp" "$TMP/w.bmp" "${10}" || exit 1
    IN="$TMP/w.bmp"
  fi
  sips -z "$8" "$7" "$IN" -s format jpeg -s formatOptions "$9" --out "$O/$6" >/dev/null 2>&1
}
# Tische
for t in stahl hof nacht boss; do sips -z 1720 960 -s format jpeg -s formatOptions 62 "art/tisch-$t.jpg" --out "$O/t-$t.jpg" >/dev/null 2>&1; done
# Figuren: Boss = König, Queen = Dame, Runner = Bube, Dealer = schwarzer Joker, Wärter = roter Joker, Emblem = Ass
crop figuren-hood.jpg   13   9 644 728 c-hood-k.jpg 340 384 70
crop figuren-hood.jpg  678   9 644 728 c-hood-q.jpg 340 384 70
crop figuren-hood.jpg 1343   9 644 728 c-hood-j.jpg 340 384 70
crop figuren-hood.jpg   13 756 644 728 c-hood-jb.jpg 340 384 70
crop figuren-hood.jpg  678 756 644 728 c-hood-jr.jpg 340 384 70
crop figuren-hood.jpg 1343 756 644 728 c-hood-a.jpg 340 384 70
crop figuren-schwarz.jpg    5   4 652 734 c-schwarz-k.jpg 340 382 70
crop figuren-schwarz.jpg  674   4 652 734 c-schwarz-q.jpg 340 382 70
crop figuren-schwarz.jpg 1342   4 652 734 c-schwarz-j.jpg 340 382 70
crop figuren-schwarz.jpg    5 754 652 734 c-schwarz-jb.jpg 340 382 70
crop figuren-schwarz.jpg  674 754 652 734 c-schwarz-jr.jpg 340 382 70
crop figuren-schwarz.jpg 1342 754 652 734 c-schwarz-a.jpg 340 382 70
crop figuren-stift.jpg   44  30 610 660 c-stift-k.jpg 340 368 70 0.88
crop figuren-stift.jpg  682  30 610 660 c-stift-q.jpg 340 368 70 0.88
crop figuren-stift.jpg 1364  35 610 660 c-stift-j.jpg 340 368 70 0.88
crop figuren-stift.jpg   40 770 610 660 c-stift-jb.jpg 340 368 70 0.88
crop figuren-stift.jpg  715 770 610 660 c-stift-jr.jpg 340 368 70 0.88
crop figuren-stift.jpg 1354 790 610 660 c-stift-a.jpg 340 368 70 0.88
crop figuren-tattoo.jpg   30  18 448 494 c-tattoo-k.jpg  340 375 74 0.955
crop figuren-tattoo.jpg  523  18 448 494 c-tattoo-q.jpg  340 375 74 0.955
crop figuren-tattoo.jpg 1022  18 448 494 c-tattoo-j.jpg  340 375 74 0.955
crop figuren-tattoo.jpg   31 563 448 492 c-tattoo-jb.jpg 340 373 74 0.955
crop figuren-tattoo.jpg  526 563 448 492 c-tattoo-jr.jpg 340 373 74 0.955
crop figuren-tattoo.jpg 1024 584 448 494 c-tattoo-a.jpg  340 375 74 0.955
# Rückseiten, auf das Kartenformat 1 : 1,4
crop rueck-stift.jpg    40 35 1045 1435 c-stift-back.jpg 340 476 70
crop rueck-schwarz.jpg  45 20 1403 1964 c-schwarz-back.jpg 340 476 70
crop rueck-hood.jpg     45 30 1030 1440 c-hood-back.jpg 340 476 70
crop rueck-tattoo.jpg   75 60 1345 1883 c-tattoo-back.jpg 340 476 70
rm -rf "$TMP"
ls -la $O | awk '{s+=$5} END {print NR-3 " Dateien, " int(s/1024) " kB"}'
