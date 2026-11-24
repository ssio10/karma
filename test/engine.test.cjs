'use strict';
/* Karma – unabhängige Prüfung des Regelkerns (src/engine.js) gegen die Hausregeln (KARMA.pdf)
 * plus die Klarstellungen des Besitzers, die der PDF vorgehen:
 *  K1 Joker: der Nächste nimmt den Stapel auf, der Joker ist danach AUS DEM SPIEL (wie eine 10) – er kommt auf
 *     keine Hand und kann nie wieder gespielt werden. Wer aufgenommen hat, legt danach selbst eine Karte.
 *     (Schwarz darf mit Rot gekontert werden; dann nimmt der Darauffolgende auf und BEIDE Joker sind weg.)
 *  K2 10: darf auf JEDE Karte gelegt werden (auch auf B/D/K/A; nur auf einen Joker nicht). Stapel und 10 sind aus dem
 *     Spiel, der Nächste beginnt frei mit seiner Karte.
 *  K2b Sonderkarten sind 2, 7, 10 und die Joker – sie dürfen IMMER gelegt werden (auf B, D, K, A und alles andere;
 *     einzige Ausnahme: liegt ein Joker oben, geht nur Rot auf Schwarz). Die 7 behält ihre Bedingung für den NÄCHSTEN:
 *     er muss unter 7 legen (3–6) oder eine Sonderkarte (2, noch eine 7, 10, Joker). Die 3 ist KEINE Sonderkarte im
 *     Sinne von "geht immer": sie hat ihren normalen Wert (niedrigste Karte – passt auf 2, 3, den leeren Stapel und
 *     nach einer 7), ihre Wirkung ist nur der Richtungswechsel, und auf eine 3 darf alles. Auf eine 2 darf alles.
 *  K2c FREIWILLIG AUFNEHMEN ist erlaubt, sobald etwas im Ablagestapel liegt: wer legen könnte, darf trotzdem den Stapel
 *     nehmen (taktischer Zug, um gute Karten zu behalten) – in jeder Phase der Partie, auch statt eine verdeckte Karte
 *     aufzudecken. EINZIGE AUSNAHME (K2d): im Zusatzzug direkt nach der eigenen 3 (zu zweit, Zustand `again`) darf NICHT
 *     aufgenommen werden – sonst ließe sich "3 legen, aufnehmen, 3 legen …" endlos wiederholen, ohne dass der Gegner je
 *     drankommt. Auf eine 3 passt alles, erzwungen ist Aufnehmen dort also nie. Gegen einen
 *     Joker gibt es ohnehin keine Wahl (außer Rot auf Schwarz). Ereignis: vol = true, wenn es einen anderen Zug gab;
 *     options().forced = true, wenn Aufnehmen der EINZIGE Zug ist. Die letzte offene Karte kommt nur dann mit auf die
 *     Hand, wenn sie nicht gepasst hätte.
 *  K3 Rangfolge: wer zuerst fertig ist, ist Erster, dann Zweiter … Der Letzte mit Karten ist der Verlierer
 *     (und beginnt die nächste Runde – startBy 'loser'; in der ersten Runde wird ausgelost).
 *  K4 Aufgeben: sind nur noch ZWEI Spieler in der Runde, darf jeder der beiden aufgeben (auch außerhalb seines
 *     Zugs). Er ist der Verlierer, der andere bekommt den nächsten freien Platz.
 *  K5 Mehrere 3er in einem Zug drehen die Richtung einmal; 3er in getrennten Zügen jedes Mal.
 *  K6 Mehrere Karten gleichen Werts dürfen zusammen oder einzeln gelegt werden.
 *
 * Festgelegte Auslegungen (wo PDF und Klarstellungen schweigen):
 *  - Auf einen Joker darf nichts außer Rot auf Schwarz (keine 2, keine 10); Kontern ist freiwillig.
 *  - Nach JEDEM Aufnehmen bleibt derselbe Spieler am Zug und legt selbst (freePlay).
 *  - Blind gegen den roten Joker: nur aufnehmen; gegen den schwarzen: aufnehmen oder aufdecken (ein roter kontert).
 *  - Joker auf leerem Stapel: der Nächste "nimmt auf" (n = 0), der Joker ist weg, er spielt frei weiter.
 *  - Dreifache Stellungswiederholung: 'deadlock' beendet die Runde ohne Verlierer – nur wenn nachweislich kein
 *    Fortschritt mehr erreichbar ist. Erst zählt der statische Beweis (staticLock unten – sofort, ohne Suche und ohne
 *    Wartezeit), sonst entscheidet die Suche. Nach einem deadlock sind freePlay und again zurückgesetzt.
 *
 * Die Erwartungen stammen aus dem Regeltext plus der Liste der festgelegten Auslegungen, NICHT aus dem Code:
 *  - ERLAUBT_AUF: von Hand geschriebene Tabelle "welcher Wert darf auf welche oberste Karte".
 *  - Referenzmodell (legal / refIsLegal / refApply): eigene Umsetzung von Legalität UND Zustandsübergang
 *    (Nachziehen, Aufnehmen + Pflichtzug, verbrauchte Joker, Zonen, Sonderkarten, Fertigwerden, Rangfolge, Aufgeben).
 *  - Jede angenommene Aktion – in den Einzeltests wie in den Zufallspartien – wird gegen das Referenzmodell
 *    verglichen (Zustand und Ereignis); jede abgelehnte darf den Zustand nicht verändern.
 *  - Das Endlosschleifen-Sicherheitsnetz wird mit einer eigenen vollständigen Suche geprüft (lockSearch).
 *
 * Von Hand gebaute Stellungen (mk) setzen auf das in engine.js dokumentierte Zustandsformat auf
 * (players[i].hand/up/down, pile, stock – gezogen wird vom Ende –, burned, turn, dir, finished, winner, loser, gaveUp,
 * freePlay, again, startSeat, startBy).
 *
 * Ausführen:  node --test test/engine.test.cjs      (rund eine halbe Minute; der Großteil sind die Zufallspartien)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const E = require(path.join(__dirname, '..', 'src', 'engine.js'));

/* ------------------------------------------------------------------ eigenes Kartenmodell */

const SUITS = ['S', 'H', 'D', 'C'];
const ALL = [];
for (const s of SUITS) for (let r = 2; r <= 14; r++) ALL.push(s + r);
ALL.push('JB', 'JR');
const ALL_SET = new Set(ALL);
const isJ = (c) => c === 'JB' || c === 'JR';
const rk = (c) => (isJ(c) ? c : Number(c.slice(1)));   // Joker haben je einen eigenen "Wert"
const PLAIN = [4, 5, 6, 8, 9, 11, 12, 13, 14];          // Werte ohne Sonderregel

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function withRandom(seed, fn) {            // der Bot würfelt mit Math.random – für Tests festnageln
  const real = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = real; }
}

/* Von Hand aus dem Regeltext: oberste Karte -> Werte, die darauf gelegt werden dürfen.
 * Abschnitt 1 (Rangfolge 3 < 4 < … < 10 < B < D < K < A), Abschnitt 2 (mindestens gleicher Wert), Abschnitt 4:
 *  2 jederzeit; 3 nur nach Wertregel; nach 7: 3–6, dazu 2, 7, 10, Joker; Joker jederzeit.
 * Klarstellungen K2/K2b: 7 und 10 dürfen wie die 2 auf jede Karte (auch auf B/D/K/A) – nur nicht auf einen Joker.
 * Auslegung: auf einen Joker darf nichts – außer der rote auf den schwarzen.
 * (Die Zeile "10" kommt im Spiel nie vor – eine gelegte 10 räumt den Stapel ab –, sie hält nur die Tabelle vollständig.) */
const ERLAUBT_AUF = {
  leer: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 'JB', 'JR'],
  2:    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 'JB', 'JR'],
  3:    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 'JB', 'JR'],
  4:    [2,    4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 'JB', 'JR'],
  5:    [2,       5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 'JB', 'JR'],
  6:    [2,          6, 7, 8, 9, 10, 11, 12, 13, 14, 'JB', 'JR'],
  7:    [2, 3, 4, 5, 6, 7,       10,                 'JB', 'JR'],
  8:    [2,             7, 8, 9, 10, 11, 12, 13, 14, 'JB', 'JR'],
  9:    [2,             7,    9, 10, 11, 12, 13, 14, 'JB', 'JR'],
  10:   [2,             7,       10, 11, 12, 13, 14, 'JB', 'JR'],
  11:   [2,             7,       10, 11, 12, 13, 14, 'JB', 'JR'],
  12:   [2,             7,       10,     12, 13, 14, 'JB', 'JR'],
  13:   [2,             7,       10,         13, 14, 'JB', 'JR'],
  14:   [2,             7,       10,             14, 'JB', 'JR'],
  JB:   ['JR'],
  JR:   []
};
const ALWAYS = [2, 7, 10];                               // K2b: Sonderkarten mit Zahlenwert, die immer gehen
const tableSays = (card, top) => ERLAUBT_AUF[top == null ? 'leer' : rk(top)].includes(rk(card));

/* ------------------------------------------------------------------ Referenzmodell (aus dem Regeltext) */

/* Darf `card` auf die oberste Karte `top` (null = leerer Stapel)? */
function legal(card, top) {
  if (top == null) return true;                       // leerer Stapel: frei wählbar
  if (top === 'JR') return false;                     // roter Joker: nicht konterbar
  if (top === 'JB') return card === 'JR';             // schwarzer Joker: nur der rote kontert
  if (isJ(card)) return true;                         // Joker jederzeit
  const r = rk(card), t = rk(top);
  if (r === 2 || r === 7 || r === 10) return true;    // K2/K2b: Sonderkarten gehen immer (Joker oben: schon abgelehnt)
  if (t === 7) return r < 7;                          // nach 7: darunter, also 3–6
  return r >= t;                                      // mindestens gleicher Wert (gilt auch für die 3)
}
function zoneOfP(p) {
  if (p.hand.length) return 'hand';
  if (p.up.some(Boolean)) return 'up';
  if (p.down.some(Boolean)) return 'down';
  return null;
}
const topOf = (s) => (s.pile.length ? s.pile[s.pile.length - 1] : null);
const zoneCards = (p) => { const z = zoneOfP(p); return z === 'hand' ? p.hand.slice() : z === 'up' ? p.up.filter(Boolean) : []; };
const activeOf = (s) => s.players.filter((p) => zoneOfP(p) !== null).length;
function refNext(M, seat) {
  const n = M.players.length;
  for (let i = 1; i <= n; i++) { const c = (((seat + M.dir * i) % n) + n) % n; if (zoneOfP(M.players[c]) !== null) return c; }
  return seat;
}
function refRefill(M, p) { let k = 0; while (p.hand.length < 3 && M.stock.length) { p.hand.push(M.stock.pop()); k++; } return k; }
/* K2c: aufnehmen darf man, solange etwas im Ablagestapel liegt – auch freiwillig, in jeder Zone.
 * K2d: nur nicht im Zusatzzug direkt nach der eigenen 3 (M.again). */
const refCanPickup = (M) => M.pile.length > 0 && !M.again;
/* Hat der Spieler einen anderen Zug als aufzunehmen? (eine passende Karte seiner Zone – oder blind aufdecken,
 * was nur gegen den roten Joker verboten ist) */
function refHasOther(M, seat) {
  const p = M.players[seat], z = zoneOfP(p), top = topOf(M);
  if (z === 'down') return top !== 'JR';
  return zoneCards(p).some((c) => legal(c, top));
}
/* Aufnehmen ist der EINZIGE Zug (options().forced). */
const refForced = (M, seat) => refCanPickup(M) && !refHasOther(M, seat);

/* K4: aufgeben darf, wer selbst noch Karten hat, sobald genau zwei Spieler noch Karten haben. */
function refCanGiveUp(M, seat) {
  return M.phase === 'play' && Number.isInteger(seat) && seat >= 0 && seat < M.players.length &&
    zoneOfP(M.players[seat]) !== null && activeOf(M) === 2;
}
/* K1: Der Stapel kommt auf die Hand – Joker darin sind verbraucht und verlassen das Spiel. */
function refTakePile(M, p) {
  const gone = M.pile.filter(isJ), taken = M.pile.filter((c) => !isJ(c));
  p.hand.push(...taken); M.burned.push(...gone); M.pile = []; M.freePlay = true;
  M.again = false;                                     // nach jedem Aufnehmen (auch blind gescheitert) ist der Zusatzzug vorbei
  return { n: taken.length, gone };
}

/* Ist Aktion `a` für Sitz `seat` regelkonform? Verträgt beliebigen Müll. */
function refIsLegal(M, seat, a) {
  if (a === null || typeof a !== 'object') return false;
  if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat >= M.players.length) return false;
  const p = M.players[seat];
  if (a.t === 'ready') {
    if (M.phase !== 'swap' || p.ready) return false;
    if (!a.swap) return true;
    return typeof a.swap === 'object' && typeof a.swap.hand === 'string' && p.hand.includes(a.swap.hand) &&
      (a.swap.up === 0 || a.swap.up === 1 || a.swap.up === 2) && !!p.up[a.swap.up];
  }
  if (M.phase !== 'play') return false;
  if (a.t === 'giveup') return refCanGiveUp(M, seat);        // K4: auch außerhalb des eigenen Zugs
  if (M.turn !== seat) return false;
  const z = zoneOfP(p), top = topOf(M);
  if (a.t === 'play') {
    if (!Array.isArray(a.cards) || a.cards.length === 0 || a.cards.length > 4) return false;
    if (z !== 'hand' && z !== 'up') return false;
    if (z === 'up' && a.cards.length > 1) return false;      // offene Karten: nur eine pro Zug
    const src = zoneCards(p);
    for (let i = 0; i < a.cards.length; i++) {
      const c = a.cards[i];
      if (typeof c !== 'string' || !src.includes(c) || a.cards.indexOf(c) !== i) return false;
      if (rk(c) !== rk(a.cards[0])) return false;
    }
    return legal(a.cards[0], top);
  }
  if (a.t === 'flip') return z === 'down' && (a.slot === 0 || a.slot === 1 || a.slot === 2) && !!p.down[a.slot] && top !== 'JR';
  if (a.t === 'pickup') return refCanPickup(M);
  return false;
}

/* Karten liegen schon nicht mehr beim Spieler. `active` = Spieler mit Karten VOR dem Zug. */
function refResolve(M, seat, cards, from, active, top, slot) {
  const p = M.players[seat], r = rk(cards[0]), fx = [];
  let again = false;
  M.pile.push(...cards);
  M.freePlay = false;
  if (r === 10) { M.burned.push(...M.pile); M.pile = []; fx.push('burn'); }            // mehrere 10er: einmal
  else if (r === 3) { if (active > 2) { M.dir = -M.dir; fx.push('reverse'); } else again = true; }   // mehrere 3er: einmal
  else if (isJ(cards[0])) fx.push(top === 'JB' && cards[0] === 'JR' ? 'counter' : 'joker');
  const ev = { t: 'play', seat, cards: cards.slice(), from, fx, drew: refRefill(M, p) };
  if (slot !== undefined) ev.slot = slot;
  if (zoneOfP(p) === null) {                           // Hand, offene, verdeckte Karten leer UND nichts nachzuziehen
    M.finished.push(seat);
    ev.place = M.finished.length;
    if (M.winner === null) { M.winner = seat; fx.push('win'); } else fx.push('out');
    again = false;
  }
  if (again) fx.push('again');
  M.again = again;                                     // K2d: gilt genau für den einen Zusatzzug; jeder weitere Legezug setzt neu
  if (activeOf(M) <= 1) {
    M.phase = 'over'; M.turn = -1; M.loser = null;
    M.players.forEach((q, i) => { if (zoneOfP(q) !== null) M.loser = i; });
    fx.push('over');
  } else M.turn = again ? seat : refNext(M, seat);
  return ev;
}

/* Wendet `a` auf das Referenzmodell an. Liefert das erwartete Ereignis oder null (unzulässig, M unverändert). */
function refApply(M, seat, a) {
  if (!refIsLegal(M, seat, a)) return null;
  const p = M.players[seat];
  if (a.t === 'ready') {
    let swap = null;
    if (a.swap) {
      const hi = p.hand.indexOf(a.swap.hand), old = p.up[a.swap.up];
      p.up[a.swap.up] = p.hand[hi]; p.hand[hi] = old;
      swap = { slot: a.swap.up };
    }
    p.ready = true;
    const all = M.players.every((q) => q.ready);
    if (all) { M.phase = 'play'; M.turn = M.startSeat; }
    return { t: all ? 'start' : 'ready', seat, swap };
  }
  if (a.t === 'giveup') {                              // K4: der andere bekommt den nächsten freien Platz
    const other = M.players.findIndex((q, i) => i !== seat && zoneOfP(q) !== null);
    M.finished.push(other);
    const fx = [];
    if (M.winner === null) { M.winner = other; fx.push('win'); } else fx.push('out');
    fx.push('over');
    M.loser = seat; M.gaveUp = seat; M.phase = 'over'; M.turn = -1; M.freePlay = false; M.again = false;
    return { t: 'giveup', seat, other, place: M.finished.length, fx };
  }
  const z = zoneOfP(p), top = topOf(M), active = activeOf(M);
  if (a.t === 'play') {
    const cards = a.cards.slice();
    if (z === 'hand') p.hand = p.hand.filter((c) => !cards.includes(c));
    else p.up = p.up.map((c) => (cards.includes(c) ? null : c));
    return refResolve(M, seat, cards, z, active, top);
  }
  if (a.t === 'flip') {
    const card = p.down[a.slot];
    p.down[a.slot] = null;
    if (legal(card, top)) return refResolve(M, seat, [card], 'down', active, top, a.slot);
    const tk = refTakePile(M, p);                      // Stapel (ohne Joker) UND aufgedeckte Karte auf die Hand
    p.hand.push(card);
    return { t: 'flipfail', seat, card, slot: a.slot, n: tk.n + 1, gone: tk.gone, drew: refRefill(M, p) };
  }
  // pickup: ganzer Stapel (Joker verschwinden); danach bleibt derselbe Spieler dran. vol: es hätte einen anderen Zug gegeben.
  // Die LETZTE offene Karte kommt nur mit, wenn sie nicht gepasst hätte (PDF Abschnitt 5; bei freiwilligem Aufnehmen bleibt sie liegen).
  const vol = refHasOther(M, seat);
  const left = z === 'up' ? p.up.filter(Boolean) : [];
  const lastUp = left.length === 1 && !legal(left[0], top) ? left[0] : null;
  const tk = refTakePile(M, p);
  const ev = { t: 'pickup', seat, n: tk.n, joker: isJ(top), vol, gone: tk.gone };
  if (lastUp) { ev.slot = p.up.indexOf(lastUp); ev.upCard = lastUp; p.hand.push(lastUp); p.up[ev.slot] = null; }
  ev.drew = refRefill(M, p);
  return ev;
}

/* Alle regelkonformen Züge des Spielers am Zug: Karten gleichen Werts als Gruppe. */
function enumMoves(M) {
  const p = M.players[M.turn], z = zoneOfP(p), top = topOf(M), out = [];
  if (z === 'hand' || z === 'up') {
    const groups = new Map();
    // offene Karten gehen nur einzeln: jede ist ihre eigene "Gruppe"
    for (const c of zoneCards(p)) { const k = z === 'up' ? c : rk(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
    for (const g of groups.values()) if (legal(g[0], top)) out.push({ t: 'play', group: g });
  } else if (z === 'down' && top !== 'JR') {
    p.down.forEach((c, i) => { if (c) out.push({ t: 'flip', slot: i }); });
  }
  if (refCanPickup(M)) out.push({ t: 'pickup' });
  return out;
}
function concretize(move, rng) {
  if (move.t !== 'play') return move;
  const g = move.group.slice();
  for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const x = g[i]; g[i] = g[j]; g[j] = x; }
  return { t: 'play', cards: g.slice(0, 1 + Math.floor(rng() * g.length)) };
}

/* Regelrelevante Kopie eines Engine-Zustands (ohne deren interne Zähler). */
function mirror(s) {
  return {
    players: s.players.map((p) => ({ hand: p.hand.slice(), up: p.up.slice(), down: p.down.slice(), ready: !!p.ready })),
    phase: s.phase, turn: s.turn, dir: s.dir, startSeat: s.startSeat, startBy: s.startBy,
    pile: s.pile.slice(), stock: s.stock.slice(), burned: s.burned.slice(),
    finished: s.finished.slice(), winner: s.winner, loser: s.loser, gaveUp: s.gaveUp, deadlock: !!s.deadlock, freePlay: !!s.freePlay, again: !!s.again
  };
}
/* Vergleichsform. Reihenfolge innerhalb der Hand und des vernichteten Stapels ist keine Regel -> sortiert.
 * Die Richtung ist mit nur noch zwei aktiven Spielern ohne Bedeutung (3 = "nochmal") und wird dann nicht verglichen. */
function canon(x) {
  return [x.phase, x.turn, activeOf(x) > 2 ? x.dir : 0, (x.freePlay ? 1 : 0) + (x.again ? 'again' : ''), 'P:' + x.pile.join(','), 'S:' + x.stock.join(','),
    'B:' + x.burned.slice().sort().join(','),
    x.players.map((p) => p.hand.slice().sort().join(',') + '/' + p.up.map((c) => c || '-').join(',') + '/' + p.down.map((c) => c || '-').join(',') + '/' + (p.ready ? 1 : 0)).join(' | '),
    'F:' + x.finished.join(','), 'W:' + x.winner, 'L:' + x.loser, 'G:' + x.gaveUp, x.deadlock ? 'DEADLOCK' : '', 'start ' + x.startSeat + ' ' + x.startBy].join(' # ');
}
function normEv(ev) {
  const o = { t: ev.t, seat: ev.seat };
  if (ev.t === 'play') Object.assign(o, { cards: ev.cards, from: ev.from, fx: ev.fx.slice().sort(), drew: ev.drew, place: ev.place === undefined ? 0 : ev.place, slot: ev.slot === undefined ? -1 : ev.slot });
  else if (ev.t === 'pickup') Object.assign(o, { n: ev.n, joker: ev.joker, vol: ev.vol, gone: ev.gone, drew: ev.drew, upCard: ev.upCard || null, slot: ev.upCard ? ev.slot : -1 });
  else if (ev.t === 'flipfail') Object.assign(o, { card: ev.card, slot: ev.slot, n: ev.n, gone: ev.gone, drew: ev.drew });
  else if (ev.t === 'giveup') Object.assign(o, { other: ev.other, place: ev.place, fx: ev.fx.slice().sort() });
  else if (ev.t === 'ready' || ev.t === 'start') o.swap = ev.swap ? { slot: ev.swap.slot } : null;
  return o;
}

/* ------------------------------------------------------------------ eigene Suche: ist noch Fortschritt erreichbar?
 * Fortschritt = nachgezogen, Stapel durch 10 entfernt, Joker verbraucht, Tischkarte gespielt oder aufgenommen, jemand fertig.
 * (Aufgeben zählt nicht: die Suche fragt, ob das SPIEL noch vorankommen kann.)
 * exact: Stellungen kartengenau unterscheiden; sonst nur nach Werten (Farben spielen in den Regeln keine Rolle). */
function cloneM(x) {
  return {
    players: x.players.map((p) => ({ hand: p.hand.slice(), up: p.up.slice(), down: p.down.slice(), ready: true })),
    phase: x.phase, turn: x.turn, dir: x.dir, startSeat: x.startSeat, startBy: x.startBy, pile: x.pile.slice(), stock: x.stock.slice(), burned: [],
    finished: x.finished.slice(), winner: x.winner, loser: x.loser, gaveUp: x.gaveUp, deadlock: false, freePlay: x.freePlay, again: !!x.again
  };
}
function progressOf(x) {
  let tableCards = 0;
  for (const p of x.players) for (let i = 0; i < 3; i++) { if (p.up[i]) tableCards++; if (p.down[i]) tableCards++; }
  return x.stock.length + ':' + x.burned.length + ':' + tableCards + ':' + x.finished.length;
}
const rkKey = (c) => (isJ(c) ? c : c.slice(1));
function posKey(x, exact) {
  const f = exact ? (a) => a.slice().sort().join(',') : (a) => a.map(rkKey).sort().join(',');
  const pile = exact ? x.pile.join(',') : (x.pile.length ? rkKey(x.pile[x.pile.length - 1]) : '-') + ';' + f(x.pile);
  return x.turn + '|' + x.dir + '|' + (x.freePlay ? 1 : 0) + (x.again ? 'a' : '') + '|' + pile + '|' + x.players.map((p) => f(p.hand) + '/' + p.up.join(',') + '/' + p.down.join(',')).join('|');
}
function expandMoves(x, exact) {
  const out = [];
  for (const m of enumMoves(x)) {
    if (m.t !== 'play') { out.push(m); continue; }
    if (exact) for (let mask = 1; mask < (1 << m.group.length); mask++) out.push({ t: 'play', cards: m.group.filter((_, i) => (mask >> i) & 1) });
    else for (let k = 1; k <= m.group.length; k++) out.push({ t: 'play', cards: m.group.slice(0, k) });
  }
  return out;
}
/* -> { k: 'progress' | 'locked' | 'unknown', size } */
function lockSearch(M0, limit, exact) {
  if (M0.phase !== 'play') return { k: 'progress', size: 0 };
  const root = cloneM(M0), sig = progressOf(root), seen = new Set([posKey(root, exact)]), stack = [root];
  while (stack.length) {
    const x = stack.pop();
    for (const a of expandMoves(x, exact)) {
      const y = cloneM(x);
      y.burned = [];
      if (!refApply(y, y.turn, a)) throw new Error('Referenzmodell lehnt eigenen Zug ab');
      if (y.phase !== 'play' || progressOf(y) !== sig) return { k: 'progress', size: seen.size };
      const k = posKey(y, exact);
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > (limit || 100000)) return { k: 'unknown', size: seen.size };
      stack.push(y);
    }
  }
  return { k: 'locked', size: seen.size };
}
/* Statischer Beweis einer Sackgasse für Stellungen, deren Suchraum zu groß ist ("nur hohe Karten kreisen"):
 *  - der Nachziehstapel ist leer und unter den kreisenden Karten (alle Hände + Ablagestapel) ist keine 10 und kein Joker;
 *  - jeder Spieler mit Karten hat mindestens ZWEI offene Karten, und keine davon passt auf irgendeine kreisende Karte;
 *  - der Spieler am Zug steht nicht mit leerer Hand vor einem leeren Stapel.
 * Dann liegt vor jedem Zug eines Spielers mit leerer Hand eine kreisende Karte oben (leer ist der Stapel nur direkt
 * nach dem Aufnehmen, und dann spielt derselbe Spieler aus der Hand): er kann keine offene Karte legen und nimmt nur
 * den Stapel auf – die offenen Karten bleiben liegen. Niemand zieht, entfernt, erreicht verdeckte Karten oder wird fertig. */
function staticLock(M) {
  if (M.phase !== 'play' || M.stock.length) return false;
  const circ = M.pile.slice();
  for (const p of M.players) circ.push(...p.hand);
  if (circ.some((c) => rk(c) === 10 || isJ(c))) return false;
  for (const p of M.players) {
    if (zoneOfP(p) === null) continue;
    const up = p.up.filter(Boolean);
    if (up.length < 2) return false;
    for (const u of up) for (const c of circ) if (legal(u, c)) return false;
  }
  return !(M.pile.length === 0 && M.players[M.turn].hand.length === 0);
}
/* Eigene Einschätzung: 'progress' | 'locked' (Suche vollständig oder statischer Beweis) | 'unknown'.
 * `stat`: der statische Beweis gilt – dann muss die Engine SOFORT bei der dritten Wiederholung abbrechen (ohne Suche,
 * ohne Wartezeit). Widerspricht die Suche dem statischen Beweis, ist der Beweis (oder das Modell) falsch. */
function classify(M, limit) {
  const stat = staticLock(M);
  const r = lockSearch(M, limit, false);
  if (stat && r.k === 'progress') assert.fail('statischer Sackgassen-Beweis widerlegt: die Suche findet Fortschritt in ' + brief(M));
  if (stat) return { k: 'locked', size: r.size, big: r.k === 'unknown', stat: true };
  return r;
}
/* Zählt wie oft dieselbe Stellung seit dem letzten Fortschritt nach einem Zug entstanden ist. */
function makeTracker() {
  let sig = null, map = new Map();
  return {
    note(M) {
      const p = progressOf(M) + '|' + M.burned.length;
      if (p !== sig) { sig = p; map = new Map(); }
      const k = posKey(M, true), c = (map.get(k) || 0) + 1;
      map.set(k, c);
      return c;
    }
  };
}

/* ------------------------------------------------------------------ Stellungen von Hand bauen */

const names = (n) => Array.from({ length: n }, (_, i) => ({ name: 'Spieler ' + (i + 1) }));
const newGame = (n, opts) => E.createGame(names(n), opts);

/* spec: { players:[{hand,up,down,ready}], pile, stock (oberste Karte zuletzt) | 'rest', burned, turn, dir, phase:'swap',
 *         startSeat, freePlay, again, finished }. Alle nicht genannten Karten sind "aus dem Spiel" (liegen bei burned). */
function mk(spec) {
  const used = new Set();
  const take = (c) => {
    if (!ALL_SET.has(c)) throw new Error('Testaufbau: unbekannte Karte ' + c);
    if (used.has(c)) throw new Error('Testaufbau: Karte doppelt ' + c);
    used.add(c); return c;
  };
  const pad = (arr) => { const a = (arr || []).map((c) => (c == null ? null : take(c))); if (a.length > 3) throw new Error('Testaufbau: mehr als 3 Tischkarten'); while (a.length < 3) a.push(null); return a; };
  const swap = spec.phase === 'swap';
  const s = E.createGame(names(spec.players.length), { rng: mulberry32(99), startSeat: spec.startSeat || 0 });
  s.players.forEach((p, i) => {
    const q = spec.players[i];
    p.hand = (q.hand || []).map(take); p.up = pad(q.up); p.down = pad(q.down);
    p.ready = swap ? !!q.ready : true; p.swapped = false;
  });
  s.pile = (spec.pile || []).map(take);
  s.burned = (spec.burned || []).map(take);
  s.stock = Array.isArray(spec.stock) ? spec.stock.map(take) : [];
  const rest = ALL.filter((c) => !used.has(c));
  if (spec.stock === 'rest') s.stock = rest; else s.burned.push(...rest);
  s.phase = swap ? 'swap' : 'play';
  s.turn = swap ? -1 : (spec.turn || 0);
  s.dir = spec.dir || 1;
  s.freePlay = !!spec.freePlay;
  s.again = !!spec.again;
  s.finished = spec.finished ? spec.finished.slice() : s.players.map((p, i) => (zoneOfP(p) === null ? i : -1)).filter((i) => i >= 0);
  s.winner = s.finished.length ? s.finished[0] : null;
  assertConserved(s, 'Testaufbau');
  return s;
}
/* n Spieler; nicht angegebene Sitze bekommen zwei "normale" Handkarten, damit niemand zufällig fertig wird. */
function table(n, spec) {
  spec = spec || {};
  const seats = spec.seats || {};
  const used = new Set([].concat(spec.pile || [], spec.burned || [], Array.isArray(spec.stock) ? spec.stock : []));
  for (const k of Object.keys(seats)) for (const z of ['hand', 'up', 'down']) for (const c of seats[k][z] || []) if (c) used.add(c);
  const pool = ALL.filter((c) => !used.has(c) && [5, 6, 8, 9, 11, 12, 13].includes(rk(c)));
  const players = [];
  for (let i = 0; i < n; i++) players.push(seats[i] || { hand: [pool.pop(), pool.pop()] });
  return mk(Object.assign({}, spec, { players }));
}

const snap = (s) => JSON.stringify(s);
const clone = (s) => JSON.parse(JSON.stringify(s));
function allCardsOf(s) {
  const out = [];
  for (const p of s.players) { out.push(...p.hand); for (const c of p.up) if (c) out.push(c); for (const c of p.down) if (c) out.push(c); }
  out.push(...s.pile, ...s.stock, ...s.burned);
  return out;
}
function assertConserved(s, msg) {
  const cards = allCardsOf(s);
  if (cards.length !== 54 || new Set(cards).size !== 54) assert.fail((msg || '') + ' Karten nicht erhalten: ' + cards.length + ' Karten, ' + new Set(cards).size + ' verschiedene');
  for (const c of cards) if (!ALL_SET.has(c)) assert.fail('fremde Karte ' + c);
}
function safe(a) { try { const j = JSON.stringify(a); return j && j.length > 200 ? j.slice(0, 200) + '…' : String(j); } catch (e) { return String(a); } }
const brief = (s) => JSON.stringify({ turn: s.turn, dir: s.dir, free: !!s.freePlay, again: !!s.again, pile: s.pile, stock: s.stock.length, players: s.players.map((p) => ({ hand: p.hand, up: p.up, down: p.down })) });

/* Aktion muss angenommen werden – und Zustand + Ereignis müssen dem Referenzmodell entsprechen. Liefert das Ereignis. */
function accept(s, seat, a, msg) {
  const M = mirror(s), seq = s.seq, b = brief(s);
  const label = (what) => what + ' – ' + (msg || 'sollte erlaubt sein') + ': Sitz ' + seat + ' ' + safe(a) + ' in ' + b;
  const exp = refApply(M, seat, a);
  if (!exp) assert.fail(label('Testannahme falsch, laut Referenzmodell unzulässig'));
  const r = E.applyAction(s, seat, a);
  if (!r || r.ok !== true) assert.fail(label('abgelehnt ' + JSON.stringify(r)));
  if (s.seq !== seq + 1 || s.ev.seq !== s.seq) assert.fail(label('seq steigt nicht um genau eins'));
  assertConserved(s, 'nach Aktion');
  if (s.deadlock) {
    // eigene Suche (auch wenn der statische Beweis gilt – sie darf ihm nie widersprechen); ist der Suchraum zu groß, zählt der Beweis
    const stat = staticLock(M), own = lockSearch(M, stat ? 30000 : 200000, true);
    if (own.k === 'progress' || (own.k === 'unknown' && !stat)) assert.fail(label('Engine meldet deadlock, obwohl noch Fortschritt erreichbar ist'));
    M.phase = 'over'; M.turn = -1; M.deadlock = true;
    M.freePlay = false; M.again = false;             // ein beendetes Spiel hat keinen Pflicht- und keinen Zusatzzug mehr
  }
  if (s.again !== (s.phase === 'play' && s.ev.t === 'play' && s.ev.fx.includes('again'))) assert.fail(label('again muss genau nach einem Legezug mit Effekt "again" gesetzt sein'));
  const cs = canon(s), cm = canon(M);
  if (cs !== cm) assert.fail(label('Zustand weicht vom Referenzmodell ab') + '\n  Engine:   ' + cs + '\n  Referenz: ' + cm);
  const es = JSON.stringify(normEv(s.ev)), em = JSON.stringify(normEv(exp));
  if (es !== em) assert.fail(label('Ereignis weicht vom Referenzmodell ab') + '\n  Engine:   ' + es + '\n  Referenz: ' + em);
  return s.ev;
}
function reject(s, seat, a, msg) {
  const before = snap(s);
  const label = (what) => what + ' – ' + (msg || 'sollte abgelehnt werden') + ': Sitz ' + String(seat) + ' ' + safe(a) + ' in ' + brief(s);
  let r;
  try { r = E.applyAction(s, seat, a); } catch (e) { assert.fail(label('applyAction wirft ' + e.message)); }
  if (!r || r.ok !== false) assert.fail(label('angenommen'));
  if (typeof r.err !== 'string') assert.fail(label('kein Fehlertext'));
  if (snap(s) !== before) assert.fail(label('Zustand nach abgelehnter Aktion verändert'));
  if (refIsLegal(mirror(s), seat, a)) assert.fail(label('Testannahme falsch, laut Referenzmodell zulässig'));
}
/* Wie reject, prüft zusätzlich den Fehlercode. */
function rejectAs(s, seat, a, err, msg) {
  reject(s, seat, a, msg);
  assert.equal(E.applyAction(s, seat, a).err, err, (msg || '') + ' – Fehlercode für ' + safe(a));
}
/* Der Spieler am Zug MUSS aufnehmen: es gibt keinen anderen Zug (options().forced, view.my.forced). */
function mustPickup(s, seat, msg) {
  const o = E.options(s, seat);
  assert.ok(o, 'am Zug');
  assert.deepEqual([o.canPickup, o.forced, o.playable.length, o.canFlip], [true, true, 0, false], (msg || 'Aufnehmen ist Pflicht') + ' in ' + brief(s));
  assert.equal(E.viewFor(s, seat).my.forced, true);
  assert.deepEqual(E.legalActions(s), [PICK], 'einziger Zug: aufnehmen');
}
/* Der Spieler am Zug hat einen anderen Zug; aufnehmen DÜRFTE er trotzdem (K2c), solange etwas im Stapel liegt –
 * außer im Zusatzzug nach der eigenen 3 (K2d). */
function notForced(s, seat, msg) {
  const o = E.options(s, seat);
  assert.ok(o, 'am Zug');
  assert.equal(o.forced, false, (msg || 'kein Zwang zum Aufnehmen') + ' in ' + brief(s));
  assert.equal(o.canPickup, s.pile.length > 0 && !s.again, 'aufnehmen genau dann, wenn etwas im Ablagestapel liegt – nur nicht im Zusatzzug nach der eigenen 3');
  assert.equal(E.legalActions(s).some((a) => a.t === 'pickup'), o.canPickup);
  assert.ok(o.playable.length > 0 || o.canFlip, 'es gibt einen anderen Zug');
  assert.equal(E.viewFor(s, seat).my.forced, false);
}
const play = (...cards) => ({ t: 'play', cards });
const GIVEUP = { t: 'giveup' };
const PICK = { t: 'pickup' };
const flip = (slot) => ({ t: 'flip', slot });
const READY = { t: 'ready' };
const sorted = (a) => a.slice().sort();

/* ================================================================== Referenzmodell gegen die Tabelle */

test('Legetabelle: von Hand geschriebene Tabelle == Referenzmodell == canPlayOn (55 oberste Karten x 54 Karten)', () => {
  let n = 0;
  for (const top of [null].concat(ALL)) for (const card of ALL) {
    if (card === top) continue;
    const exp = tableSays(card, top);
    assert.equal(legal(card, top), exp, 'Referenzmodell: ' + card + ' auf ' + top);
    assert.equal(E.canPlayOn(card, top), exp, 'canPlayOn: ' + card + ' auf ' + top);
    n++;
  }
  assert.equal(n, 54 + 54 * 53);
  assert.equal(E.canPlayOn('S5', undefined), true, 'leerer Stapel auch als undefined');
  // Kartenhilfen der Engine
  assert.deepEqual(sorted(E.fullDeck()), sorted(ALL), 'Kartensatz = 52 Karten + 2 Joker');
  for (const c of ALL) {
    assert.equal(E.isJoker(c), isJ(c));
    if (!isJ(c)) { assert.equal(E.rank(c), rk(c)); assert.equal(E.suit(c), c[0]); }
  }
  assert.notEqual(E.rank('JB'), E.rank('JR'), 'die Joker sind verschiedene Werte (nie gemeinsam ablegbar)');
  assert.equal(E.HAND_SIZE, 3);
});

/* ================================================================== Austeilen */

test('Austeilen: 54 verschiedene Karten, je 3 verdeckt / 3 offen / 3 Hand für 2–6 Spieler, Rest = Nachziehstapel (54 − 9n)', () => {
  assert.equal(ALL.length, 54);
  for (let n = 2; n <= 6; n++) {
    for (let seed = 1; seed <= 40; seed++) {
      const s = newGame(n, { rng: mulberry32(seed * 31 + n) });
      assert.equal(s.players.length, n);
      for (const p of s.players) {
        for (const z of ['hand', 'up', 'down']) {
          assert.equal(p[z].length, 3, n + ' Spieler: ' + z);
          for (const c of p[z]) assert.ok(ALL_SET.has(c), 'gültige Karte in ' + z);
        }
        assert.equal(p.ready, false);
      }
      assert.equal(s.stock.length, 54 - 9 * n, 'Nachziehstapel');
      if (n === 6) assert.equal(s.stock.length, 0, 'zu sechst bleibt nichts übrig');
      assert.deepEqual(s.pile, []);
      assert.deepEqual(s.burned, []);
      assertConserved(s, n + ' Spieler');
      assert.equal(s.phase, 'swap');
      assert.equal(s.turn, -1, 'in der Tauschphase ist niemand am Zug');
      assert.equal(s.dir, 1, 'zunächst im Uhrzeigersinn');
      assert.equal(s.winner, null);
      assert.equal(s.loser, null);
      assert.deepEqual(s.finished, []);
      assert.equal(s.freePlay, false);
      assert.equal(s.deadlock, false);
      const v = E.viewFor(s, 0);
      assert.equal(v.stock, 54 - 9 * n);
      assert.equal(v.ev.t, 'deal');
      assert.equal(v.seq, 1);
    }
  }
});

test('Austeilen: gleiche Zufallsfolge = gleiche Verteilung, andere Folge = andere Verteilung, wirklich gemischt', () => {
  const a = newGame(4, { rng: mulberry32(7) }), b = newGame(4, { rng: mulberry32(7) }), c = newGame(4, { rng: mulberry32(8) });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.players, c.players);
  const seen = {};
  for (let seed = 1; seed <= 300; seed++) {
    const s = newGame(3, { rng: mulberry32(seed) });
    s.players.forEach((p) => ['hand', 'up', 'down'].forEach((z) => p[z].forEach((card) => { (seen[card] = seen[card] || new Set()).add(z); })));
    s.stock.forEach((card) => { (seen[card] = seen[card] || new Set()).add('stock'); });
  }
  for (const card of ALL) assert.equal(seen[card] && seen[card].size, 4, card + ' kommt in Hand, offen, verdeckt und im Nachziehstapel vor');
  assertConserved(newGame(3), 'ohne opts.rng (Standard-Zufall)');
});

test('Austeilen: ungültige Spielerzahlen werden abgelehnt', () => {
  for (const n of [0, 1, 13, 14, 54]) assert.throws(() => newGame(n, { rng: mulberry32(1) }), 'n=' + n);
  assert.throws(() => E.createGame(undefined));
  assert.throws(() => E.createGame(null));
  for (let n = 2; n <= 12; n++) assert.doesNotThrow(() => newGame(n, { rng: mulberry32(1) }));
});

test('Austeilen: Startspieler wird ausgelost (jeder Sitz kommt vor, immer im gültigen Bereich); ein übergebener Sitz wird übernommen', () => {
  for (let n = 2; n <= 6; n++) {
    for (let st = 0; st < n; st++) assert.equal(newGame(n, { startSeat: st, rng: mulberry32(3) }).startSeat, st);
    const count = new Array(n).fill(0), N = 300 * n;
    for (let seed = 1; seed <= N; seed++) {
      const s = newGame(n, { rng: mulberry32(seed * 7 + n) });
      assert.ok(Number.isInteger(s.startSeat) && s.startSeat >= 0 && s.startSeat < n, 'Startsitz im Bereich');
      count[s.startSeat]++;
    }
    for (let i = 0; i < n; i++) assert.ok(count[i] > 300 * 0.7 && count[i] < 300 * 1.3, n + ' Spieler: Sitz ' + i + ' beginnt ' + count[i] + '-mal von ' + N + ' (erwartet ~300)');
    for (const bad of [-1, n, 99, 1.5, NaN, Infinity, '1', null, undefined, {}, [0], true]) {
      const s = newGame(n, { startSeat: bad, rng: mulberry32(3) });
      assert.ok(Number.isInteger(s.startSeat) && s.startSeat >= 0 && s.startSeat < n, 'startSeat ' + String(bad) + ' -> gültiger Sitz');
    }
    // Randwerte des Zufallsgenerators
    for (const x of [0, 0.5, 0.999999999]) {
      const s = newGame(n, { rng: () => x });
      assert.ok(Number.isInteger(s.startSeat) && s.startSeat >= 0 && s.startSeat < n, 'rng=' + x);
      assertConserved(s);
    }
  }
  // ohne opts.rng: trotzdem ausgelost und gültig
  const seats = new Set();
  for (let i = 0; i < 200; i++) seats.add(newGame(4).startSeat);
  assert.equal(seats.size, 4);
});

test('Startspieler: startBy – "random" (ausgelost), "set" (vorgegebener Sitz), "loser" (Verlierer der Vorrunde beginnt); ohne gültigen Sitz wird immer gelost', () => {
  for (let n = 2; n <= 6; n++) {
    const r = newGame(n, { rng: mulberry32(11) });
    assert.equal(r.startBy, 'random', 'erste Runde: ausgelost');
    assert.equal(E.viewFor(r, 0).startBy, 'random');
    for (let st = 0; st < n; st++) {
      const a = newGame(n, { rng: mulberry32(11), startSeat: st });
      assert.equal(a.startBy, 'set'); assert.equal(a.startSeat, st);
      const b = newGame(n, { rng: mulberry32(11), startSeat: st, startBy: 'loser' });
      assert.equal(b.startBy, 'loser'); assert.equal(b.startSeat, st);
      // der Startspieler ändert nichts an der Kartenverteilung
      for (const g of [a, b]) { assert.deepEqual(g.players, r.players); assert.deepEqual(g.stock, r.stock); }
      for (const v of [-1, 0, n - 1]) {
        assert.equal(E.viewFor(b, v).startBy, 'loser'); assert.equal(E.viewFor(b, v).startSeat, st);
        assert.equal(E.viewFor(a, v).startBy, 'set');
      }
      // nur genau 'loser' zählt; alles andere mit gültigem Sitz ist 'set'
      for (const junk of ['random', 'set', 'LOSER', 'loser ', '', 0, 1, true, null, undefined, {}, ['loser']]) {
        assert.equal(newGame(n, { rng: mulberry32(11), startSeat: st, startBy: junk }).startBy, 'set', 'startBy ' + safe(junk));
      }
      // in der Tauschphase ist niemand am Zug; danach beginnt genau dieser Sitz, und startBy bleibt die ganze Partie erhalten
      assert.equal(b.turn, -1);
      for (let i = 0; i < n; i++) accept(b, (i + 2) % n, READY);
      assert.equal(b.phase, 'play'); assert.equal(b.turn, st, n + ' Spieler: Sitz ' + st + ' beginnt');
      assert.equal(b.startBy, 'loser'); assert.equal(E.viewFor(b, 0).startBy, 'loser'); assert.equal(b.dir, 1, 'jede Runde beginnt im Uhrzeigersinn');
    }
    // 'loser' ohne gültigen Sitz (es gab keinen Verlierer – deadlock – oder der Sitz existiert nicht): es wird gelost
    const seen = new Set();
    const bads = [undefined, null, -1, n, 99, 1.5, NaN, '0', {}, [0], true];
    for (let k = 0; k < bads.length; k++) {
      const bad = bads[k];
      for (let seed = 1; seed <= 12; seed++) {
        const c = newGame(n, { rng: mulberry32(seed * 3 + k * 1000), startSeat: bad, startBy: 'loser' });
        assert.equal(c.startBy, 'random', 'startSeat ' + safe(bad) + ' -> ausgelost');
        assert.ok(Number.isInteger(c.startSeat) && c.startSeat >= 0 && c.startSeat < n);
        seen.add(c.startSeat);
      }
    }
    assert.equal(seen.size, n, 'beim Losen kommt jeder Sitz vor');
  }
  assert.equal(newGame(3).startBy, 'random', 'ganz ohne Optionen');
  assert.equal(E.createGame(names(2), {}).startBy, 'random');
  assert.equal(E.createGame(names(2)).startBy, 'random');
});

/* ================================================================== Tauschphase */

function swapTable(n, startSeat) {
  const players = [];
  for (let i = 0; i < n; i++) {           // jeder Spieler eine Farbe (bis 4 Spieler)
    const f = SUITS[i];
    players.push({ hand: [f + 4, f + 5, f + 6], up: [f + 8, f + 9, f + 11], down: [f + 12, f + 13, f + 14] });
  }
  return mk({ phase: 'swap', startSeat: startSeat || 0, players, stock: 'rest' });
}

test('Tauschphase: genau ein optionaler 1:1-Tausch Hand <-> offene Karte', () => {
  const s = swapTable(3, 0);
  let ev = accept(s, 1, READY);
  assert.equal(ev.t, 'ready'); assert.equal(ev.swap, null);
  assert.deepEqual(s.players[1].hand, ['H4', 'H5', 'H6']);
  assert.deepEqual(s.players[1].up, ['H8', 'H9', 'H11']);
  assert.equal(s.players[1].ready, true);
  assert.equal(s.phase, 'swap');
  ev = accept(s, 0, { t: 'ready', swap: { hand: 'S5', up: 2 } });       // S5 (Hand) gegen die offene S11
  assert.deepEqual(sorted(s.players[0].hand), ['S11', 'S4', 'S6']);
  assert.deepEqual(s.players[0].up, ['S8', 'S9', 'S5']);
  assert.deepEqual(s.players[0].down, ['S12', 'S13', 'S14'], 'verdeckte Karten bleiben unberührt');
  assert.deepEqual(ev.swap, { slot: 2 });
  assert.deepEqual(s.players[2].hand, ['D4', 'D5', 'D6'], 'die anderen bleiben unberührt');
  assert.equal(s.stock.length, 54 - 27);
});

test('Tauschphase: kein zweiter Tausch, kein zweites "bereit"', () => {
  const s = swapTable(3, 0);
  accept(s, 0, { t: 'ready', swap: { hand: 'S4', up: 0 } });
  reject(s, 0, { t: 'ready', swap: { hand: 'S8', up: 1 } }, 'zweiter Tausch');
  reject(s, 0, READY, 'zweites bereit');
  const s2 = swapTable(3, 0);
  accept(s2, 2, READY);
  reject(s2, 2, { t: 'ready', swap: { hand: 'D4', up: 0 } }, 'Tausch nach bereit');
});

test('Tauschphase: ungültige Tausche werden abgelehnt (fremde Karte, offene/verdeckte Karte als Handkarte, Nachziehstapel, falscher Platz, zwei Karten)', () => {
  const s = swapTable(3, 0);
  const bad = [
    { hand: 'H4', up: 0 },            // Handkarte eines anderen
    { hand: 'S8', up: 1 },            // eigene offene Karte ist keine Handkarte
    { hand: 'S12', up: 0 },           // eigene verdeckte Karte
    { hand: s.stock[0], up: 0 },      // Karte aus dem Nachziehstapel
    { hand: 'S4', up: 3 }, { hand: 'S4', up: -1 }, { hand: 'S4', up: '0' }, { hand: 'S4', up: 1.5 }, { hand: 'S4', up: [0] },
    { hand: 'S4' }, { up: 0 }, {}, { hand: ['S4'], up: 0 }, { hand: ['S4', 'S5'], up: [0, 1] }
  ];
  for (const sw of bad) reject(s, 0, { t: 'ready', swap: sw }, 'Tausch ' + JSON.stringify(sw));
  assert.equal(s.players[0].ready, false, 'nach abgelehntem Tausch noch nicht bereit');
});

test('Tauschphase: keine Spielzüge, bevor alle bereit sind; kein "bereit" nach Spielbeginn', () => {
  const s = swapTable(3, 1);
  const tryAll = () => {
    for (const seat of [0, 1, 2]) {
      reject(s, seat, play(SUITS[seat] + 4), 'legen in der Tauschphase');
      reject(s, seat, PICK, 'aufnehmen in der Tauschphase');
      reject(s, seat, flip(0), 'aufdecken in der Tauschphase');
      assert.equal(E.options(s, seat), null);
      assert.equal(E.viewFor(s, seat).my, null);
    }
    assert.deepEqual(E.legalActions(s), []);
    assert.equal(s.turn, -1);
  };
  tryAll();
  accept(s, 1, READY); tryAll();       // auch der Startspieler darf noch nicht
  accept(s, 0, READY); tryAll();
  const ev = accept(s, 2, READY);
  assert.equal(ev.t, 'start');
  assert.equal(s.phase, 'play');
  reject(s, 0, READY, 'bereit im laufenden Spiel');
  reject(s, 1, { t: 'ready', swap: { hand: 'H4', up: 0 } }, 'Tausch im laufenden Spiel');
});

test('Tauschphase: Spiel beginnt erst, wenn alle bereit sind – mit dem ausgelosten Startspieler (view.startSeat)', () => {
  for (let n = 2; n <= 4; n++) {
    for (let st = 0; st < n; st++) {
      const s = swapTable(n, st);
      const order = Array.from({ length: n }, (_, i) => (i * 3 + 1) % n).filter((v, i, a) => a.indexOf(v) === i);
      for (let i = 0; i < n; i++) if (!order.includes(i)) order.push(i);
      order.forEach((seat, k) => {
        assert.equal(s.phase, 'swap');
        assert.equal(s.turn, -1);
        assert.equal(E.viewFor(s, seat).startSeat, st);
        accept(s, seat, READY);
        if (k < n - 1) assert.equal(s.phase, 'swap', 'noch nicht alle bereit');
      });
      assert.equal(s.phase, 'play');
      assert.equal(s.turn, st, 'Startspieler beginnt');
      assert.equal(E.viewFor(s, 0).turn, st);
      assert.equal(s.dir, 1);
      assert.deepEqual(s.pile, []);
    }
  }
});

test('Spielrichtung: im Uhrzeigersinn = aufsteigende Sitze (mit Umlauf)', () => {
  const s = swapTable(4, 2);
  [0, 1, 2, 3].forEach((i) => accept(s, i, READY));
  const seen = [];
  for (const m of [['D4'], ['C5'], ['S6'], ['H6'], ['D6'], ['C6']]) { seen.push(s.turn); accept(s, s.turn, play(...m)); }
  assert.deepEqual(seen, [2, 3, 0, 1, 2, 3]);
  assert.equal(s.turn, 0);
});

/* ================================================================== Grundregeln */

test('Legen: Rangfolge 3 < 4 < … < 10 < B < D < K < A – gleich hoch oder höher ist erlaubt, niedriger nicht (alle Wertpaare; 7 und 10 gehen immer)', () => {
  let ok = 0, no = 0;
  for (let t = 3; t <= 14; t++) for (let r = 3; r <= 14; r++) {
    const top = 'S' + t, card = 'H' + r;
    const exp = ERLAUBT_AUF[t].includes(r);
    // die Tabelle selbst gegen den Regeltext, in Worten:
    if (r === 10) assert.equal(exp, true, 'K2: die 10 darf auf jede Karte, auch auf ' + t);
    else if (r === 7) assert.equal(exp, true, 'K2b: die 7 darf auf jede Karte, auch auf ' + t);
    else if (t === 7) assert.equal(exp, r < 7, 'nach einer 7 nur darunter (3–6): ' + r);
    else assert.equal(exp, r >= t, 'Rangfolge: ' + r + ' auf ' + t);
    const s = table(3, { pile: [top], turn: 1, seats: { 1: { hand: [card, 'C4'] } } });
    if (exp) {
      accept(s, 1, play(card), r + ' auf ' + t);
      if (r !== 10) assert.equal(topOf(s), card);
      assert.equal(s.turn, r === 3 ? 0 : 2, 'nächster Spieler ist dran');
      assert.deepEqual(s.players[1].hand, ['C4']);
      ok++;
    } else { reject(s, 1, play(card), r + ' auf ' + t); no++; }
  }
  // 12 x 12 Wertpaare: 7 und 10 immer (24), auf die 7 außerdem 3–6 (4), sonst "gleich oder höher" unter den 10 übrigen Werten ohne die Zeile 7
  assert.equal(ok + no, 144);
  assert.equal(ok, 24 + 4 + [3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14].reduce((sum, t) => sum + [3, 4, 5, 6, 8, 9, 11, 12, 13, 14].filter((r) => r >= t).length, 0));
  // die 3 ist die niedrigste Karte: sie passt auf keinen höheren Wert – auch nicht auf B, D, K, A
  for (const t of [4, 5, 6, 8, 9, 11, 12, 13, 14]) assert.equal(E.canPlayOn('H3', 'S' + t), false, '3 auf ' + t);
});

test('Legen: mehrere Karten gleichen Werts sind ein Zug (1 bis 4 Karten, freiwillig), gemischte Werte nicht', () => {
  const s = table(3, { pile: ['S8'], turn: 0, seats: { 0: { hand: ['H9', 'D9', 'C9', 'S9', 'H11', 'D11', 'C4'] } } });
  reject(s, 0, play('H9', 'H11'), 'gemischte Werte');
  reject(s, 0, play('H9', 'D9', 'D11'), 'gemischte Werte');
  reject(s, 0, play('H9', 'H9'), 'dieselbe Karte doppelt');
  reject(s, 0, play(), 'gar keine Karte');
  reject(s, 0, play('C4', 'H9'), 'gemischt, erste Karte zu niedrig');
  reject(s, 0, play('H9', 'D9', 'C9', 'S9', 'H9'), 'fünf Karten');
  for (let k = 1; k <= 4; k++) {
    const c = clone(s), cards = ['H9', 'D9', 'C9', 'S9'].slice(0, k);
    const ev = accept(c, 0, play(...cards), k + ' Neunen');
    assert.deepEqual(c.pile, ['S8'].concat(cards), 'alle gelegten Karten liegen auf dem Stapel');
    assert.equal(c.players[0].hand.length, 7 - k);
    assert.equal(c.turn, 1, 'ein einziger Zug');
    assert.deepEqual(ev.fx, [], 'kein Sondereffekt, auch nicht bei vier Gleichen');
  }
  // zwei Zweien, Dreien, Siebenen, Zehnen gehen ebenfalls gemeinsam
  for (const r of [2, 3, 7, 10]) {
    const m = table(3, { pile: ['S3'], turn: 0, seats: { 0: { hand: ['H' + r, 'D' + r, 'C4'] } } });
    accept(m, 0, play('H' + r, 'D' + r), 'zwei ' + r + 'er');
  }
  // die Reihenfolge der genannten Karten bestimmt, welche oben liegt
  const o = table(3, { pile: ['S8'], turn: 0, seats: { 0: { hand: ['H9', 'D9', 'C4'] } } });
  accept(o, 0, play('D9', 'H9'));
  assert.deepEqual(o.pile, ['S8', 'D9', 'H9']);
});

test('Legen: nur Karten der aktuellen Zone, nur wer am Zug ist – abgelehnte Aktionen ändern nichts', () => {
  const s = table(3, {
    pile: ['S5', 'S6'], burned: ['H10', 'D4'], stock: ['C3', 'C7'], turn: 1,
    seats: { 0: { hand: ['S13', 'S14', 'D7'], up: ['D13'], down: ['C13'] }, 1: { hand: ['H8', 'H9', 'D12'], up: ['D8', 'D9', 'C12'], down: ['C8', 'C9', 'S12'] }, 2: { hand: ['H11', 'D11', 'C11'] } }
  });
  reject(s, 1, play('D8'), 'offene Karte, obwohl noch Handkarten da sind');
  reject(s, 1, play('H8', 'D8'), 'Hand und offene Karte gemischt');
  reject(s, 1, play('C8'), 'verdeckte Karte per Kennung');
  reject(s, 1, play('S13'), 'Handkarte eines anderen');
  reject(s, 1, play('D13'), 'offene Karte eines anderen');
  reject(s, 1, play('S6'), 'Karte vom Ablagestapel');
  reject(s, 1, play('H10'), 'vernichtete Karte');
  reject(s, 1, play('C7'), 'Karte aus dem Nachziehstapel');
  reject(s, 1, play('X1'), 'unbekannte Karte');
  reject(s, 1, flip(0), 'aufdecken, obwohl Hand/offene Karten da sind');
  reject(s, 0, play('S13'), 'nicht am Zug');
  reject(s, 2, play('H11'), 'nicht am Zug');
  reject(s, 0, PICK, 'nicht am Zug: aufnehmen');
  reject(s, 2, flip(0), 'nicht am Zug: aufdecken');
  accept(s, 1, play('H8'));
  assert.deepEqual(s.pile, ['S5', 'S6', 'H8']);
});

/* ================================================================== Nachziehen */

test('Nachziehen: nach jedem eigenen Zug auf 3 Handkarten auffüllen, solange der Stapel reicht – exakte Anzahl, oberste Karten zuerst', () => {
  const s = mk({
    players: [
      { hand: ['H6', 'D6', 'C6'], up: ['S8', 'H8', 'D8'], down: ['S4', 'H4', 'D4'] },
      { hand: ['S9', 'H9', 'D9'], up: ['S11', 'H11', 'D11'], down: ['S12', 'H12', 'D12'] }],
    pile: ['S5'], stock: ['C14', 'C13', 'C12', 'C11', 'C8'], turn: 0      // C8 liegt oben
  });
  let ev = accept(s, 0, play('H6', 'D6', 'C6'));
  assert.equal(ev.drew, 3, 'drei gelegt -> drei gezogen');
  assert.deepEqual(sorted(s.players[0].hand), ['C11', 'C12', 'C8'], 'die drei obersten Karten');
  assert.deepEqual(s.stock, ['C14', 'C13'], 'der Rest bleibt in seiner Reihenfolge');
  assert.equal(E.zoneOf(s.players[0]), 'hand', 'Tischkarten sind noch nicht dran');
  assert.equal(s.turn, 1, 'erst danach beginnt der nächste Spieler');
  ev = accept(s, 1, play('S9'));
  assert.equal(ev.drew, 1);
  assert.deepEqual(sorted(s.players[1].hand), ['C13', 'D9', 'H9']);
  assert.deepEqual(s.stock, ['C14']);
  ev = accept(s, 0, play('C11'));
  assert.equal(ev.drew, 1);
  assert.deepEqual(sorted(s.players[0].hand), ['C12', 'C14', 'C8']);
  assert.deepEqual(s.stock, []);
  ev = accept(s, 1, play('C13'));
  assert.equal(ev.drew, 0, 'Nachziehstapel leer: es wird nicht mehr nachgezogen');
  assert.deepEqual(sorted(s.players[1].hand), ['D9', 'H9']);
  assert.equal(E.viewFor(s, 0).stock, 0);
});

test('Nachziehen: nie über 3, nie bei 3 oder mehr Handkarten, Teilmenge wenn der Stapel nicht reicht', () => {
  // fünf Handkarten, eine gelegt -> vier: nichts ziehen
  let s = table(2, { pile: ['S5'], stock: ['C13', 'C12'], turn: 0, seats: { 0: { hand: ['H6', 'D6', 'C6', 'S7', 'H7'] } } });
  assert.equal(accept(s, 0, play('H6')).drew, 0);
  assert.equal(s.players[0].hand.length, 4);
  assert.equal(s.stock.length, 2);
  // vier Handkarten, eine gelegt -> genau drei: nichts ziehen
  s = table(2, { pile: ['S5'], stock: ['C13', 'C12'], turn: 0, seats: { 0: { hand: ['H6', 'D6', 'C6', 'S7'] } } });
  assert.equal(accept(s, 0, play('H6')).drew, 0);
  assert.equal(s.players[0].hand.length, 3);
  // vier Handkarten, zwei gelegt -> zwei: eine ziehen
  s = table(2, { pile: ['S5'], stock: ['C13', 'C12'], turn: 0, seats: { 0: { hand: ['H6', 'D6', 'C6', 'S7'] } } });
  assert.equal(accept(s, 0, play('H6', 'D6')).drew, 1);
  assert.deepEqual(sorted(s.players[0].hand), ['C12', 'C6', 'S7']);
  // drei gelegt, nur zwei im Stapel -> zwei ziehen, Stapel leer, Hand hat zwei
  s = table(2, { pile: ['S5'], stock: ['C13', 'C12'], turn: 0, seats: { 0: { hand: ['H6', 'D6', 'C6'], up: ['S8'] } } });
  assert.equal(accept(s, 0, play('H6', 'D6', 'C6')).drew, 2);
  assert.deepEqual(sorted(s.players[0].hand), ['C12', 'C13']);
  assert.deepEqual(s.stock, []);
});

test('Nachziehen: Tischkarten sind unerreichbar, solange der Nachziehstapel die Hand wieder füllt; wer nachzieht, ist nicht fertig', () => {
  const s = mk({
    players: [{ hand: ['H6'], up: ['S14', 'H14', 'D14'], down: ['S4'] }, { hand: ['S9', 'H9', 'D9'] }],
    pile: ['S5'], stock: ['C4', 'C8'], turn: 0
  });
  reject(s, 0, play('S14'), 'offene Karte trotz Handkarte');
  const ev = accept(s, 0, play('H6'));
  assert.equal(ev.drew, 2);
  assert.equal(ev.place, undefined);
  assert.deepEqual(sorted(s.players[0].hand), ['C4', 'C8'], 'Hand war kurz leer, ist aber wieder gefüllt');
  assert.equal(E.viewFor(s, 0).players[0].zone, 'hand');
  accept(s, 1, play('S9'));
  reject(s, 0, play('S14'), 'offene Karten erst, wenn die Hand leer BLEIBT');
  reject(s, 0, flip(0));
  // Spieler ohne Tischkarten legt seine letzte Handkarte, zieht aber nach: nicht fertig
  const w = mk({ players: [{ hand: ['H6'] }, { hand: ['S9', 'H9', 'D9'] }], pile: ['S5'], stock: ['C8'], turn: 0 });
  const e2 = accept(w, 0, play('H6'));
  assert.equal(e2.drew, 1);
  assert.equal(w.winner, null, 'noch nicht gewonnen: es gab etwas nachzuziehen');
  assert.deepEqual(w.finished, []);
  assert.equal(w.phase, 'play');
});

/* ================================================================== Aufnehmen */

test('Aufnehmen: passt keine Karte der aktuellen Zone, MUSS aufgenommen werden (forced); passt eine, ist es kein Zwang; bei leerem Stapel gibt es nichts aufzunehmen', () => {
  let s = table(3, { pile: ['S8'], turn: 0, seats: { 0: { hand: ['H4', 'D5'], up: ['C13'] } } });
  assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: [], canPickup: true, canFlip: false, forced: true });
  mustPickup(s, 0, 'der offene König zählt nicht – Handkarten zuerst');
  let ev = accept(s, 0, PICK);
  assert.equal(ev.vol, false, 'erzwungen, nicht freiwillig');
  // leerer Stapel: nichts aufzunehmen
  s = table(3, { pile: [], turn: 0, seats: { 0: { hand: ['H4'] } } });
  assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: ['H4'], canPickup: false, canFlip: false, forced: false });
  rejectAs(s, 0, PICK, 'cannot-pickup', 'leerer Stapel');
  // sobald eine Karte passt, ist Aufnehmen kein Zwang mehr
  s = table(3, { pile: ['S8'], turn: 0, seats: { 0: { hand: ['H4', 'D9'], up: ['C13'] } } });
  notForced(s, 0, '9 passt auf 8');
  assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: ['D9'], canPickup: true, canFlip: false, forced: false });
  // K2b: Sonderkarten passen immer – wer eine 2, 7, 10 oder einen Joker hält, muss nie aufnehmen (außer gegen einen Joker)
  for (const c of ['H2', 'H7', 'H10', 'JB', 'JR']) for (const top of ['S8', 'S9', 'S11', 'S12', 'S13', 'S14']) {
    s = table(3, { pile: [top], turn: 0, seats: { 0: { hand: ['D4', c] } } });
    notForced(s, 0, c + ' passt auch auf ' + top);
    assert.deepEqual(E.options(s, 0).playable, [c]);
  }
  s = table(3, { pile: ['S7'], turn: 0, seats: { 0: { hand: ['D8', 'H14'] } } });
  mustPickup(s, 0, 'nach einer 7 passen 8 und Ass nicht');
  assert.equal(accept(s, 0, PICK).vol, false);
  // gegen einen Joker passt gar nichts (auch 2, 7 und 10 nicht): aufnehmen ist Pflicht
  for (const j of ['JB', 'JR']) {
    s = table(3, { pile: ['S8', j], turn: 0, seats: { 0: { hand: ['D2', 'H10', 'D14', 'H7'] } } });
    assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: [], canPickup: true, canFlip: false, forced: true });
    mustPickup(s, 0, 'gegen ' + j);
    ev = accept(s, 0, PICK, 'gegen ' + j);
    assert.equal(ev.vol, false); assert.equal(ev.joker, true);
  }
});

test('Aufnehmen: ganzer Stapel auf die Hand; DERSELBE Spieler muss sofort eine beliebige Handkarte auf den leeren Stapel legen; dann folgt der Nächste', () => {
  const s = mk({
    players: [{ hand: ['H4', 'D5'], up: ['C13', 'C12', 'C11'], down: ['S2'] }, { hand: ['H9', 'D9'] }, { hand: ['H6', 'D8'] }],
    pile: ['S6', 'S14', 'H14', 'S8', 'D14'], turn: 0
  });
  const ev = accept(s, 0, PICK);
  assert.deepEqual(normEv(ev), { t: 'pickup', seat: 0, n: 5, joker: false, vol: false, gone: [], drew: 0, upCard: null, slot: -1 });
  assert.deepEqual(ev.gone, [], 'ohne Joker im Stapel verschwindet nichts');
  assert.deepEqual(s.pile, []);
  assert.deepEqual(sorted(s.players[0].hand), sorted(['H4', 'D5', 'S6', 'S14', 'H14', 'S8', 'D14']));
  assert.deepEqual(s.players[0].up, ['C13', 'C12', 'C11']);
  assert.equal(s.turn, 0, 'derselbe Spieler bleibt am Zug');
  assert.equal(s.freePlay, true);
  for (let v = 0; v < 3; v++) {
    const view = E.viewFor(s, v);
    assert.equal(view.turn, view.ev.seat);
    assert.equal(view.freePlay, true);
    assert.deepEqual(view.pile, []);
    assert.deepEqual(view.req, { k: 'any' });
  }
  const my = E.viewFor(s, 0).my;
  assert.equal(my.zone, 'hand');
  assert.equal(my.canPickup, false, 'der Stapel ist leer');
  assert.equal(my.forced, false);
  assert.equal(my.canFlip, false);
  assert.deepEqual(sorted(my.playable), sorted(s.players[0].hand), 'jede Handkarte ist frei wählbar');
  rejectAs(s, 0, PICK, 'cannot-pickup', 'nochmal aufnehmen');
  reject(s, 0, flip(0));
  reject(s, 0, play('C13'), 'offene Karte statt Handkarte');
  reject(s, 1, play('H9'), 'der Nächste ist noch nicht dran');
  reject(s, 2, play('H6'));
  const s2 = clone(s);
  accept(s, 0, play('H4'), 'die niedrigste Karte geht auch');
  assert.equal(s.freePlay, false);
  assert.equal(s.turn, 1);
  assert.deepEqual(s.pile, ['H4']);
  notForced(s, 1, 'der Nächste richtet sich nach der gelegten Karte: 9 passt auf 4');
  accept(s, 1, play('H9'));
  // mehrere gleiche Karten sind auch im Pflichtzug ein Zug
  accept(s2, 0, play('S14', 'D14', 'H14'), 'drei Asse im Pflichtzug');
  assert.deepEqual(s2.pile, ['S14', 'D14', 'H14']);
  assert.equal(s2.turn, 1);
  reject(s2, 1, play('H9'), '9 passt nicht auf ein Ass');
  mustPickup(s2, 1);
  accept(s2, 1, PICK);
  assert.equal(s2.turn, 1);
});

test('Aufnehmen: Sonderkarten wirken auch im Pflichtzug nach dem Aufnehmen (10, 3 zu zweit, 7, Joker, 2)', () => {
  // 10 auf den leeren Stapel: nur die 10 ist weg, der Nächste beginnt frei. (Mit einer 10 auf der Hand muss man nur
  // gegen einen Joker aufnehmen – auf alles andere dürfte die 10.)
  let s = mk({ players: [{ hand: ['H10', 'D4'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: ['S13', 'JR'], turn: 0 });
  reject(s, 0, play('H10'), '10 hebt den Joker nicht auf');
  accept(s, 0, PICK);
  assert.deepEqual(sorted(s.players[0].hand), ['D4', 'H10', 'S13']);
  const b0 = s.burned.length;
  let ev = accept(s, 0, play('H10'));
  assert.deepEqual(ev.fx, ['burn']);
  assert.deepEqual(s.burned.slice(b0), ['H10']);
  assert.deepEqual(s.pile, []);
  assert.equal(s.turn, 1);
  accept(s, 1, play('H5'), 'beliebige Karte');
  // 3 zu zweit: nach dem Pflichtzug gleich noch einmal
  s = mk({ players: [{ hand: ['H3', 'D4'] }, { hand: ['H5', 'D9'] }], pile: ['S13'], turn: 0 });
  accept(s, 0, PICK);
  ev = accept(s, 0, play('H3'));
  assert.deepEqual(ev.fx, ['again']);
  assert.equal(s.turn, 0);
  assert.equal(s.freePlay, false);
  notForced(s, 0, 'auf die 3 passt alles – kein Zwang');
  accept(s, 0, play('D4'));
  assert.equal(s.turn, 1);
  // 7: der Nächste muss darunter bleiben. (Mit einer 7 auf der Hand muss man nur gegen einen Joker aufnehmen – K2b.)
  s = mk({ players: [{ hand: ['H7', 'D4'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: ['S13'], turn: 0 });
  notForced(s, 0, 'die 7 passt auf den König – kein Zwang');
  s = mk({ players: [{ hand: ['H7', 'D4'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: ['S13', 'JB'], turn: 0 });
  reject(s, 0, play('H7'), '7 hebt den Joker nicht auf');
  accept(s, 0, PICK);
  assert.deepEqual(sorted(s.players[0].hand), ['D4', 'H7', 'S13']);
  accept(s, 0, play('H7'));
  assert.deepEqual(E.requirement(s), { k: 'seven' });
  reject(s, 1, play('D9'));
  accept(s, 1, play('H5'));
  // Joker: der rote zwingt zum Aufnehmen und ist danach weg. Der eigene, noch nie gespielte schwarze Joker bleibt auf
  // der Hand und darf im Pflichtzug gelegt werden – der Nächste "nimmt" dann nur den Joker vom Tisch (nichts).
  s = mk({ players: [{ hand: ['JB', 'D4'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: ['S13', 'JR'], turn: 0 });
  reject(s, 0, play('JB'), 'schwarz kontert rot nicht');
  ev = accept(s, 0, PICK);
  assert.equal(ev.joker, true);
  assert.deepEqual(ev.gone, ['JR']);
  assert.deepEqual(sorted(s.players[0].hand), ['D4', 'JB', 'S13'], 'der eigene Joker wurde nie gespielt und bleibt; der rote ist weg');
  reject(s, 0, play('JR'), 'der verbrauchte Joker ist nicht auf der Hand');
  ev = accept(s, 0, play('JB'));
  assert.deepEqual(ev.fx, ['joker']);
  reject(s, 1, play('D9'));
  ev = accept(s, 1, PICK);
  assert.equal(ev.n, 0); assert.deepEqual(ev.gone, ['JB']);
  assert.deepEqual(sorted(s.players[1].hand), ['D9', 'H5'], 'kein Joker auf der Hand');
  assert.equal(s.turn, 1);
  // 2: danach passt alles
  s = mk({ players: [{ hand: ['H2', 'D4'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: ['S13', 'JR'], turn: 0 });
  reject(s, 0, play('H2'), '2 hebt den Joker nicht auf');
  accept(s, 0, PICK);
  accept(s, 0, play('H2'));
  accept(s, 1, play('H5'));
});

test('Aufnehmen: 7er-Regel und Joker-Zwang sind nach dem Aufnehmen vorbei', () => {
  let s = mk({ players: [{ hand: ['H9', 'D11'] }, { hand: ['H12', 'D4'] }, { hand: ['H6', 'D8'] }], pile: ['S5', 'S7'], turn: 0 });
  reject(s, 0, play('H9'), '9 nach 7');
  reject(s, 0, play('D11'), 'Bube nach 7');
  mustPickup(s, 0);
  accept(s, 0, PICK);
  accept(s, 0, play('D11'), 'Pflichtzug ist frei – auch über 7');
  reject(s, 1, play('D4'), 'normale Regel gegen den Buben');
  accept(s, 1, play('H12'), 'Dame auf Bube: die 7 gilt nicht mehr');
  // 7 -> der Nächste legt eine 5 -> der Übernächste darf wieder hoch (nur der direkt Nächste ist betroffen)
  s = mk({ players: [{ hand: ['H7', 'D11'] }, { hand: ['H5', 'D4'] }, { hand: ['H13', 'D8'] }], pile: ['S5'], turn: 0 });
  accept(s, 0, play('H7'));
  accept(s, 1, play('H5'));
  accept(s, 2, play('H13'));
  // Joker: der Nächste nimmt auf, legt frei; der Übernächste spielt normal
  s = mk({ players: [{ hand: ['H9'] , up: ['C4'] }, { hand: ['H11', 'D4'] }, { hand: ['H6', 'D8'] }], pile: ['S5', 'JR'], turn: 0 });
  reject(s, 0, play('H9'));
  const ev = accept(s, 0, PICK);
  assert.equal(ev.n, 1, 'nur die 5 – der Joker zählt nicht mit'); assert.equal(ev.joker, true); assert.deepEqual(ev.gone, ['JR']);
  assert.deepEqual(sorted(s.players[0].hand), ['H9', 'S5']);
  accept(s, 0, play('H9'));
  notForced(s, 1, 'kein Joker-Zwang mehr: der Bube passt');
  accept(s, 1, play('H11'));
});

test('Aufnehmen: danach auf 3 auffüllen, wenn weniger als 3 Handkarten und der Nachziehstapel noch Karten hat', () => {
  let s = mk({ players: [{ hand: ['H4'] }, { hand: ['H5', 'D9', 'C9'] }], pile: ['S13'], stock: ['C5', 'C6', 'C8'], turn: 0 });
  let ev = accept(s, 0, PICK);
  assert.equal(ev.drew, 1, 'König + 4 = zwei Karten -> eine nachziehen');
  assert.deepEqual(sorted(s.players[0].hand), ['C8', 'H4', 'S13']);
  assert.deepEqual(s.stock, ['C5', 'C6']);
  assert.equal(s.turn, 0);
  // der Pflichtzug füllt danach wieder auf
  ev = accept(s, 0, play('H4'));
  assert.equal(ev.drew, 1);
  assert.equal(s.players[0].hand.length, 3);
  // mit 3 oder mehr Karten nach dem Aufnehmen wird nicht gezogen
  s = mk({ players: [{ hand: ['H4', 'D4'] }, { hand: ['H5', 'D9', 'C9'] }], pile: ['S13'], stock: ['C5', 'C6', 'C8'], turn: 0 });
  assert.equal(accept(s, 0, PICK).drew, 0);
  assert.equal(s.stock.length, 3);
});

/* ================================================================== Freiwillig aufnehmen (K2c) */

test('Freiwillig aufnehmen (K2c): auch wer legen könnte, darf den Stapel nehmen – schon zu Beginn der Partie; danach legt er wie nach jedem Aufnehmen selbst', () => {
  const s = mk({
    players: [
      { hand: ['H9', 'D2', 'C10'], up: ['S11', 'S12', 'S13'], down: ['H4', 'H5', 'H6'] },
      { hand: ['D9', 'D11', 'D12'], up: ['C11', 'C12', 'C13'], down: ['D4', 'D5', 'D6'] },
      { hand: ['S4', 'S5', 'S6'], up: ['C4', 'C5', 'C6'], down: ['H11', 'H12', 'H13'] }],
    pile: ['S8'], stock: 'rest', turn: 0
  });
  assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: ['H9', 'D2', 'C10'], canPickup: true, canFlip: false, forced: false });
  const stock0 = s.stock.length;
  assert.ok(stock0 > 0, 'der Nachziehstapel ist noch da – es ist kein Endspiel');
  let ev = accept(s, 0, PICK, 'freiwillig, obwohl alle drei Handkarten passen');
  assert.deepEqual(normEv(ev), { t: 'pickup', seat: 0, n: 1, joker: false, vol: true, gone: [], drew: 0, upCard: null, slot: -1 });
  for (let v = 0; v < 3; v++) assert.equal(E.viewFor(s, v).ev.vol, true, 'alle sehen: es war freiwillig');
  assert.deepEqual(sorted(s.players[0].hand), sorted(['H9', 'D2', 'C10', 'S8']), 'die guten Karten bleiben, der Stapel kommt dazu');
  assert.deepEqual(s.players[0].up, ['S11', 'S12', 'S13']);
  assert.equal(s.stock.length, stock0, 'vier Handkarten: nichts nachzuziehen');
  assert.deepEqual(s.pile, []);
  assert.equal(s.turn, 0, 'derselbe Spieler legt');
  assert.equal(s.freePlay, true);
  assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: s.players[0].hand.slice(), canPickup: false, canFlip: false, forced: false });
  rejectAs(s, 0, PICK, 'cannot-pickup', 'zweimal hintereinander geht nicht – der Stapel ist leer');
  rejectAs(s, 1, PICK, 'not-your-turn', 'der Nächste ist noch nicht dran');
  ev = accept(s, 0, play('S8'), 'frei wählbar – auch die eben aufgenommene Karte');
  assert.equal(ev.drew, 0);
  assert.equal(s.turn, 1);
  // der Nächste darf genauso verfahren
  notForced(s, 1, 'alle drei Karten passen auf die 8');
  ev = accept(s, 1, PICK);
  assert.equal(ev.vol, true); assert.equal(ev.n, 1);
  assert.equal(s.turn, 1);
  accept(s, 1, play('D12'));
  // … und wer wirklich nicht kann, MUSS: vol = false
  mustPickup(s, 2, '4, 5, 6 gegen die Dame');
  ev = accept(s, 2, PICK);
  assert.equal(ev.vol, false);
  // nur wer am Zug ist; nie bei leerem Stapel
  const e = table(3, { pile: [], turn: 1 });
  for (let seat = 0; seat < 3; seat++) reject(e, seat, PICK, 'leerer Stapel');
  assert.equal(E.options(e, 1).canPickup, false);
});

test('Freiwillig aufnehmen (K2c): Sonderkarten zurückhalten, großer Stapel, Nachziehen, 7er-Regel, eigener Zusatzzug nach der 3', () => {
  // taktisch: die Sonderkarte passt, wird aber aufgespart
  for (const c of ['H2', 'H7', 'H10', 'JB', 'JR']) {
    const s = mk({ players: [{ hand: [c, 'D4'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: ['S6', 'S13'], turn: 0 });
    assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: [c], canPickup: true, canFlip: false, forced: false });
    const ev = accept(s, 0, PICK, c + ' wird zurückgehalten');
    assert.equal(ev.vol, true); assert.equal(ev.n, 2); assert.deepEqual(ev.gone, []); assert.equal(ev.joker, false);
    assert.deepEqual(sorted(s.players[0].hand), sorted([c, 'D4', 'S6', 'S13']));
    accept(s, 0, play('D4'));
    assert.ok(s.players[0].hand.includes(c), 'die Sonderkarte ist noch da');
    assert.equal(s.turn, 1);
  }
  // großer Stapel: alles kommt auf die Hand
  const big = ['S5', 'S6', 'H6', 'D6', 'S8', 'H8', 'S9', 'H9', 'S11', 'H11', 'S12', 'S13'];
  let s = mk({ players: [{ hand: ['H14', 'D4'] }, { hand: ['H5', 'D9'] }], pile: big, turn: 0 });
  let ev = accept(s, 0, PICK, 'das Ass hätte gepasst');
  assert.equal(ev.vol, true); assert.equal(ev.n, 12);
  assert.deepEqual(sorted(s.players[0].hand), sorted(big.concat(['H14', 'D4'])));
  // weniger als drei Handkarten nach dem Aufnehmen: auf drei nachziehen
  s = mk({ players: [{ hand: ['H9'] }, { hand: ['H5', 'D9', 'C9'] }], pile: ['S8'], stock: ['C4', 'C5'], turn: 0 });
  ev = accept(s, 0, PICK);
  assert.equal(ev.vol, true); assert.equal(ev.drew, 1);
  assert.deepEqual(sorted(s.players[0].hand), ['C5', 'H9', 'S8']);
  assert.deepEqual(s.stock, ['C4']);
  // 7er-Regel: statt die passende 5 zu legen aufnehmen – danach ist die 7 vorbei
  s = mk({ players: [{ hand: ['H5', 'H13'] }, { hand: ['D9', 'D14'] }, { hand: ['S4', 'S6'] }], pile: ['C4', 'S7'], turn: 0 });
  assert.deepEqual(E.options(s, 0).playable, ['H5']);
  reject(s, 0, play('H13'), 'König nach 7');
  ev = accept(s, 0, PICK, 'statt die 5 zu legen');
  assert.equal(ev.vol, true);
  accept(s, 0, play('H13'), 'der Pflichtzug ist frei – die 7 gilt nicht mehr');
  reject(s, 1, play('D9'));
  accept(s, 1, play('D14'));
  // zu zweit nach der eigenen 3 (K2d): der Zusatzzug darf NICHT zum Aufnehmen genutzt werden – die eigene 3 bleibt liegen
  s = mk({ players: [{ hand: ['H3', 'D9'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 });
  assert.equal(E.options(s, 0).canPickup, true, 'vor der 3 dürfte er aufnehmen');
  assert.deepEqual(accept(s, 0, play('H3')).fx, ['again']);
  assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: ['D9'], canPickup: false, canFlip: false, forced: false });
  rejectAs(s, 0, PICK, 'cannot-pickup', 'im Zusatzzug nach der eigenen 3');
  assert.deepEqual(s.pile, ['S2', 'H3']); assert.deepEqual(s.players[0].hand, ['D9']);
  assert.equal(s.turn, 0);
  // gespielte Karten und Aufdecken melden kein vol
  assert.equal(accept(s, 0, play('D9')).vol, undefined);
});

test('Freiwillig aufnehmen (K2c): aus den offenen Karten – sie bleiben liegen (auch die letzte, wenn sie gepasst hätte); danach erst die Hand, dann wieder die offenen', () => {
  for (const up of [['H9', 'D4', 'C12'], ['H9', null, 'C12'], [null, 'C12', null]]) {
    const s = mk({ players: [{ hand: [], up, down: ['S2', 'H2', 'D2'] }, { hand: ['H6', 'S9', 'D13'] }, { hand: ['C8', 'C4'] }], pile: ['S6', 'S8'], turn: 0 });
    notForced(s, 0, 'eine offene Karte passt auf die 8');
    const ev = accept(s, 0, PICK);
    assert.equal(ev.vol, true); assert.equal(ev.upCard, undefined); assert.equal(ev.slot, undefined); assert.equal(ev.n, 2);
    assert.deepEqual(s.players[0].up, up, 'alle offenen Karten bleiben liegen');
    assert.deepEqual(s.players[0].down, ['S2', 'H2', 'D2']);
    assert.deepEqual(sorted(s.players[0].hand), ['S6', 'S8']);
    assert.equal(s.turn, 0); assert.equal(s.freePlay, true);
    assert.equal(E.options(s, 0).zone, 'hand');
    rejectAs(s, 0, play(up.find(Boolean)), 'not-in-zone', 'erst die aufgenommenen Handkarten');
    accept(s, 0, play('S6'));
    accept(s, 1, play('H6'));
    accept(s, 2, play('C8'));
    rejectAs(s, 0, play('C12'), 'not-in-zone', 'noch eine Handkarte übrig');
    accept(s, 0, play('S8'));
    assert.equal(E.zoneOf(s.players[0]), 'up', 'Hand leer: jetzt sind wieder die offenen Karten dran');
    accept(s, 1, play('S9'));
    mustPickup(s, 2, 'die 4 passt nicht auf die 9');
    accept(s, 2, PICK);
    accept(s, 2, play('S9'));
    assert.equal(accept(s, 0, play('C12')).from, 'up');
    assert.deepEqual(s.players[0].up, up.map((c) => (c === 'C12' ? null : c)));
  }
});

/* ================================================================== Offene Karten */

test('Offene Karten: erst bei leerer Hand; nur EINE pro Zug, auch bei gleichen; nie mit Handkarten gemischt', () => {
  let s = mk({ players: [{ hand: [], up: ['H8', 'D8', 'C4'], down: ['S2', 'H2', 'D2'] }, { hand: ['H9', 'D9'] }, { hand: ['S9', 'C9'] }], pile: ['S6'], turn: 0 });
  assert.equal(E.options(s, 0).zone, 'up');
  reject(s, 0, play('C4'), '4 auf 6');
  reject(s, 0, play('H8', 'C4'), 'gemischte Werte');
  reject(s, 0, flip(0), 'verdeckte erst nach den offenen');
  notForced(s, 0, 'eine 8 passt');
  rejectAs(s, 0, play('H8', 'D8'), 'one-up', 'zwei gleiche offene Karten auf einmal');
  const ev = accept(s, 0, play('H8'));
  assert.equal(ev.from, 'up');
  assert.deepEqual(s.players[0].up, [null, 'D8', 'C4'], 'der Platz bleibt leer, die zweite 8 bleibt liegen');
  assert.deepEqual(s.pile, ['S6', 'H8']);
  assert.equal(s.turn, 1);
  // mit Handkarte: offene Karte tabu, auch gemischt
  s = mk({ players: [{ hand: ['S8'], up: ['H8', 'D8', 'C4'] }, { hand: ['C8', 'D9'] }], pile: ['S6'], turn: 0 });
  reject(s, 0, play('H8'));
  reject(s, 0, play('S8', 'H8'), 'Hand und offen gemischt');
  accept(s, 0, play('S8'));
  accept(s, 1, play('C8'));
  reject(s, 0, play('C4'));
  rejectAs(s, 0, play('H8', 'D8'), 'one-up', 'auch jetzt nur eine');
  accept(s, 0, play('H8'), 'jetzt ist die Hand leer: eine offene 8 ist dran');
});

test('Offene Karten: passt keine, wird bei 3 oder 2 offenen Karten nur der Stapel aufgenommen – die offenen bleiben liegen; dann Pflichtzug aus der Hand', () => {
  for (const up of [['H4', 'D5', 'C6'], ['H4', null, 'C6'], [null, 'D5', 'C6']]) {
    const s = mk({ players: [{ hand: [], up, down: ['S2', 'H2', 'D2'] }, { hand: ['H9', 'D9'] }, { hand: ['S9', 'C9'] }], pile: ['S8', 'S12'], turn: 0 });
    for (const c of up.filter(Boolean)) reject(s, 0, play(c), c + ' passt nicht auf die Dame');
    mustPickup(s, 0);
    const ev = accept(s, 0, PICK);
    assert.equal(ev.vol, false);
    assert.equal(ev.upCard, undefined);
    assert.equal(ev.n, 2);
    assert.deepEqual(s.players[0].up, up, 'offene Karten bleiben liegen');
    assert.deepEqual(sorted(s.players[0].hand), ['S12', 'S8']);
    assert.equal(s.turn, 0);
    assert.equal(s.freePlay, true);
    assert.equal(E.options(s, 0).zone, 'hand');
    reject(s, 0, play(up.filter(Boolean)[0]), 'Pflichtzug nur aus der Hand');
    reject(s, 0, play('S8', up.filter(Boolean)[0]), 'nicht mischen');
    accept(s, 0, play('S8'));
    assert.equal(s.turn, 1);
    assert.deepEqual(s.players[0].up, up);
  }
});

test('Offene Karten: passt die LETZTE offene Karte nicht, kommt sie zusammen mit dem Stapel auf die Hand; dann Pflichtzug aus der Hand', () => {
  for (let slot = 0; slot < 3; slot++) {
    const up = [null, null, null]; up[slot] = 'D5';
    const s = mk({ players: [{ hand: [], up, down: ['S2', 'H2', 'D2'] }, { hand: ['H9', 'D9'] }, { hand: ['S9', 'C9'] }], pile: ['S8', 'S12'], turn: 0 });
    reject(s, 0, play('D5'));
    reject(s, 0, flip(0));
    mustPickup(s, 0);
    const ev = accept(s, 0, PICK);
    assert.equal(ev.vol, false);
    assert.equal(ev.upCard, 'D5');
    assert.equal(ev.slot, slot);
    assert.equal(ev.n, 2, 'n zählt die Stapelkarten');
    assert.deepEqual(s.players[0].up, [null, null, null]);
    assert.deepEqual(sorted(s.players[0].hand), ['D5', 'S12', 'S8']);
    assert.deepEqual(s.players[0].down, ['S2', 'H2', 'D2'], 'verdeckte Karten unberührt');
    assert.equal(s.turn, 0);
    assert.equal(s.freePlay, true);
    reject(s, 0, flip(0), 'erst die Hand');
    accept(s, 0, play('D5'), 'beliebige Handkarte');
    assert.equal(s.turn, 1);
  }
  // Passt die letzte offene Karte, ist Aufnehmen kein Zwang. Wer trotzdem (freiwillig, K2c) aufnimmt, lässt sie liegen:
  // nur eine Karte, die NICHT gelegt werden kann, kommt mit auf die Hand.
  const s = mk({ players: [{ hand: [], up: [null, 'D13', null], down: ['S2'] }, { hand: ['H9', 'D9'] }], pile: ['S12'], turn: 0 });
  notForced(s, 0, 'der offene König passt auf die Dame');
  const v = clone(s);
  const ev = accept(v, 0, PICK, 'freiwillig aufnehmen');
  assert.equal(ev.vol, true);
  assert.equal(ev.upCard, undefined, 'die passende letzte offene Karte bleibt liegen');
  assert.equal(ev.slot, undefined);
  assert.deepEqual(v.players[0].up, [null, 'D13', null]);
  assert.deepEqual(v.players[0].hand, ['S12']);
  assert.equal(v.turn, 0); assert.equal(v.freePlay, true);
  reject(v, 0, play('D13'), 'Pflichtzug aus der Hand');
  accept(v, 0, play('S12'));
  assert.equal(E.zoneOf(v.players[0]), 'up', 'danach ist die offene Karte wieder dran');
  accept(s, 0, play('D13'));
  assert.equal(E.zoneOf(s.players[0]), 'down');
});

test('Offene Karten gegen Joker: erzwungenes Aufnehmen nimmt die LETZTE offene Karte mit, bei zwei oder drei bleiben sie liegen – der Joker selbst ist weg', () => {
  let s = mk({ players: [{ hand: [], up: ['H4', 'D5', null], down: ['S2'] }, { hand: ['H9', 'D9'] }, { hand: ['S9', 'C9'] }], pile: ['C8', 'JR'], turn: 0 });
  reject(s, 0, play('H4'), 'nichts auf den roten Joker');
  let b0 = s.burned.length;
  let ev = accept(s, 0, PICK);
  assert.equal(ev.joker, true); assert.equal(ev.upCard, undefined); assert.equal(ev.n, 1); assert.deepEqual(ev.gone, ['JR']);
  assert.deepEqual(s.players[0].up, ['H4', 'D5', null]);
  assert.deepEqual(s.players[0].hand, ['C8']);
  assert.deepEqual(s.burned.slice(b0), ['JR']);
  // letzte offene Karte: sie kommt mit dem Stapel auf die Hand, der Joker nicht
  s = mk({ players: [{ hand: [], up: [null, null, 'C6'], down: ['S2'] }, { hand: ['H9', 'D9'] }, { hand: ['S9', 'C9'] }], pile: ['C8', 'JB'], turn: 0 });
  ev = accept(s, 0, PICK);
  assert.equal(ev.joker, true); assert.equal(ev.upCard, 'C6'); assert.equal(ev.slot, 2); assert.equal(ev.n, 1); assert.deepEqual(ev.gone, ['JB']);
  assert.deepEqual(sorted(s.players[0].hand), ['C6', 'C8']);
  assert.deepEqual(s.players[0].up, [null, null, null]);
  assert.ok(s.burned.includes('JB'));
  // letzte offene Karte, Joker liegt ALLEIN auf dem Tisch: nichts aufzunehmen (n = 0), die offene Karte kommt trotzdem auf die Hand
  s = mk({ players: [{ hand: [], up: [null, 'C6', null], down: ['S2'] }, { hand: ['H9', 'D9'] }, { hand: ['S9', 'C9'] }], pile: ['JR'], turn: 0 });
  ev = accept(s, 0, PICK);
  assert.equal(ev.n, 0); assert.equal(ev.upCard, 'C6'); assert.equal(ev.slot, 1); assert.deepEqual(ev.gone, ['JR']);
  assert.deepEqual(s.players[0].hand, ['C6']);
  assert.deepEqual(s.players[0].up, [null, null, null]);
  assert.equal(s.turn, 0); assert.equal(s.freePlay, true);
  reject(s, 0, flip(0), 'erst die Hand');
  accept(s, 0, play('C6'));
  assert.equal(s.turn, 1);
  assert.equal(E.zoneOf(s.players[0]), 'down');
  // zwei offene Karten, Joker allein auf dem Tisch: nichts aufzunehmen, die Hand bleibt leer – er spielt frei aus den offenen Karten
  s = mk({ players: [{ hand: [], up: ['H4', null, 'C6'], down: ['S2'] }, { hand: ['H9', 'D9'] }, { hand: ['S9', 'C9'] }], pile: ['JB'], turn: 0 });
  for (const c of ['H4', 'C6']) reject(s, 0, play(c), c + ' auf den schwarzen Joker');
  ev = accept(s, 0, PICK);
  assert.equal(ev.n, 0); assert.equal(ev.upCard, undefined); assert.deepEqual(ev.gone, ['JB']); assert.equal(ev.drew, 0);
  assert.deepEqual(s.players[0].hand, []);
  assert.deepEqual(s.players[0].up, ['H4', null, 'C6']);
  assert.deepEqual(s.pile, []);
  assert.equal(s.turn, 0, 'er bleibt am Zug');
  const o2 = E.options(s, 0);
  assert.equal(o2.zone, 'up'); assert.deepEqual(sorted(o2.playable), ['C6', 'H4']); assert.equal(o2.canPickup, false); assert.equal(o2.canFlip, false);
  reject(s, 0, PICK, 'nochmal aufnehmen'); reject(s, 0, flip(0)); reject(s, 1, play('H9'), 'der Nächste ist noch nicht dran');
  ev = accept(s, 0, play('H4'), 'frei wählbar – auch die niedrigste');
  assert.equal(ev.from, 'up');
  assert.equal(s.turn, 1); assert.equal(s.freePlay, false);
  assert.deepEqual(s.pile, ['H4']);
});

test('Offene Karten gegen den schwarzen Joker: der rote Joker als letzte offene Karte kontert – wer lieber aufnimmt, lässt ihn (ungespielt) offen liegen', () => {
  const base = mk({ players: [{ hand: [], up: ['JR', null, null], down: ['S2'] }, { hand: ['H9', 'D9'] }, { hand: ['S4', 'C9'] }], pile: ['C8', 'JB'], turn: 0 });
  assert.deepEqual(E.options(base, 0), { zone: 'up', playable: ['JR'], canPickup: true, canFlip: false, forced: false });
  // (a) kontern: der Darauffolgende nimmt auf, beide Joker sind weg
  const a = clone(base);
  let ev = accept(a, 0, play('JR'));
  assert.deepEqual(ev.fx, ['counter']);
  assert.equal(a.turn, 1);
  reject(a, 1, play('H9'));
  mustPickup(a, 1);
  ev = accept(a, 1, PICK);
  assert.equal(ev.n, 1); assert.deepEqual(ev.gone, ['JB', 'JR']); assert.equal(ev.vol, false);
  assert.deepEqual(sorted(a.players[1].hand), ['C8', 'D9', 'H9']);
  assert.ok(a.burned.includes('JB') && a.burned.includes('JR'));
  // (b) nicht kontern: der schwarze Joker ist weg; der eigene rote hätte gepasst, wurde nicht gespielt und bleibt offen liegen
  const b = clone(base);
  ev = accept(b, 0, PICK, 'Kontern ist freiwillig');
  assert.equal(ev.vol, true, 'es gab einen anderen Zug (den Konter)');
  assert.equal(ev.upCard, undefined); assert.equal(ev.n, 1); assert.deepEqual(ev.gone, ['JB']);
  assert.deepEqual(b.players[0].hand, ['C8']);
  assert.deepEqual(b.players[0].up, ['JR', null, null]);
  assert.ok(b.burned.includes('JB') && !b.burned.includes('JR'));
  reject(b, 0, play('JR'), 'Pflichtzug aus der Hand');
  accept(b, 0, play('C8'));
  accept(b, 1, play('H9'));
  accept(b, 2, play('C9'));
  // … jetzt sind die offenen Karten dran: der rote Joker wirkt als gewöhnlicher Joker, genau einmal
  ev = accept(b, 0, play('JR'));
  assert.deepEqual(ev.fx, ['joker'], 'kein Konter – der schwarze liegt nicht mehr');
  assert.equal(ev.from, 'up');
  ev = accept(b, 1, PICK);
  assert.equal(ev.n, 3); assert.deepEqual(ev.gone, ['JR']);
  for (const p of b.players) assert.ok(!p.hand.some(isJ) && !p.up.some((c) => c && isJ(c)), 'kein Joker mehr im Spiel');
  // (c) schwarzer Joker ALLEIN auf dem Tisch: nichts aufzunehmen, der rote bleibt liegen, er spielt von den offenen Karten weiter
  const c = mk({ players: [{ hand: [], up: [null, 'JR', null], down: ['S2'] }, { hand: ['H9', 'D9'] }], pile: ['JB'], turn: 0 });
  ev = accept(c, 0, PICK);
  assert.deepEqual(normEv(ev), { t: 'pickup', seat: 0, n: 0, joker: true, vol: true, gone: ['JB'], drew: 0, upCard: null, slot: -1 });
  assert.deepEqual(c.players[0].hand, []);
  assert.deepEqual(c.players[0].up, [null, 'JR', null]);
  assert.equal(c.turn, 0); assert.equal(c.freePlay, true);
  assert.deepEqual(E.options(c, 0), { zone: 'up', playable: ['JR'], canPickup: false, canFlip: false, forced: false });
  assert.deepEqual(accept(c, 0, play('JR')).fx, ['joker']);
  assert.equal(c.turn, 1);
  mustPickup(c, 1);
});

/* ================================================================== Verdeckte Karten */

test('Blind: erst ohne Hand- und ohne offene Karten; eine Karte pro Zug; gültige Karte wird gelegt und der Zug endet', () => {
  const s = mk({ players: [{ hand: [], up: [], down: ['H9', 'D4', 'C12'] }, { hand: ['S9', 'D9'] }, { hand: ['S11', 'C9'] }], pile: ['S8'], turn: 0 });
  assert.deepEqual(E.options(s, 0), { zone: 'down', playable: [], canPickup: true, canFlip: true, forced: false });
  rejectAs(s, 0, play('H9'), 'must-flip', 'verdeckte Karte lässt sich nicht gezielt legen');
  reject(s, 0, play('H9', 'D4'));
  for (const bad of [3, -1, '0', undefined, 1.5, null]) rejectAs(s, 0, { t: 'flip', slot: bad }, 'bad-slot', 'Platz ' + String(bad));
  // statt aufzudecken darf man den Stapel auch freiwillig nehmen (K2c) – dann wird keine verdeckte Karte verbraucht oder gezeigt
  const v = clone(s);
  const pe = accept(v, 0, PICK, 'freiwillig statt aufzudecken');
  assert.deepEqual(normEv(pe), { t: 'pickup', seat: 0, n: 1, joker: false, vol: true, gone: [], drew: 0, upCard: null, slot: -1 });
  assert.equal(pe.card, undefined, 'keine Karte aufgedeckt');
  assert.deepEqual(v.players[0].hand, ['S8']);
  assert.deepEqual(v.players[0].down, ['H9', 'D4', 'C12']);
  assert.equal(v.turn, 0); assert.equal(v.freePlay, true);
  rejectAs(v, 0, flip(0), 'not-blind', 'erst die Hand');
  accept(v, 0, play('S8'));
  assert.equal(v.turn, 1);
  // aufdecken
  const ev = accept(s, 0, flip(0));
  assert.equal(ev.t, 'play'); assert.equal(ev.from, 'down'); assert.equal(ev.slot, 0); assert.deepEqual(ev.cards, ['H9']);
  assert.deepEqual(s.pile, ['S8', 'H9']);
  assert.deepEqual(s.players[0].down, [null, 'D4', 'C12']);
  assert.equal(s.turn, 1, 'eine Karte pro Zug');
  reject(s, 0, flip(1));
  accept(s, 1, play('S9'));
  accept(s, 2, play('S11'));
  rejectAs(s, 0, flip(0), 'bad-slot', 'Platz ist schon leer');
  // leerer Stapel: jede aufgedeckte Karte passt, aufnehmen geht nicht
  const e = mk({ players: [{ down: ['D4'] }, { hand: ['S9', 'D9'] }, { hand: ['S11', 'C9'] }], pile: [], turn: 0 });
  assert.deepEqual(E.options(e, 0), { zone: 'down', playable: [], canPickup: false, canFlip: true, forced: false });
  rejectAs(e, 0, PICK, 'cannot-pickup');
  accept(e, 0, flip(0));
});

test('Blind: gültige aufgedeckte Sonderkarte wirkt (10, 3, 7, Joker, 2)', () => {
  const mkB = (card, pile, n) => mk({
    players: [{ down: ['C4', card, 'C5'] }, { hand: ['S9', 'D9'] }, { hand: ['S11', 'H5'] }].slice(0, n || 3), pile, turn: 0
  });
  let s = mkB('H10', ['S6', 'S8']);
  const b0 = s.burned.length;
  let ev = accept(s, 0, flip(1));
  assert.deepEqual(ev.fx, ['burn']);
  assert.deepEqual(sorted(s.burned.slice(b0)), ['H10', 'S6', 'S8']);
  assert.deepEqual(s.pile, []);
  assert.equal(s.turn, 1);
  s = mkB('H3', ['S2']);
  ev = accept(s, 0, flip(1));
  assert.deepEqual(ev.fx, ['reverse']);
  assert.equal(s.dir, -1); assert.equal(s.turn, 2);
  s = mkB('H3', ['S2'], 2);
  ev = accept(s, 0, flip(1));
  assert.deepEqual(ev.fx, ['again']);
  assert.equal(s.turn, 0, 'zu zweit: nach der blinden 3 noch einmal');
  accept(s, 0, flip(0), 'und wieder blind');
  assert.equal(s.turn, 1);
  s = mkB('H7', ['S6']);
  accept(s, 0, flip(1));
  reject(s, 1, play('S9'), '9 nach blinder 7');
  mustPickup(s, 1, 'zwei Neunen nach der 7');
  accept(s, 1, PICK);
  s = mkB('JB', ['S13']);
  ev = accept(s, 0, flip(1));
  assert.deepEqual(ev.fx, ['joker']);
  reject(s, 1, play('S9'));
  accept(s, 1, PICK);
  s = mkB('H2', ['S14']);
  accept(s, 0, flip(1));
  accept(s, 1, play('S9'));
});

test('Blind: ungültige aufgedeckte Karte -> Karte UND Stapel auf die Hand, derselbe Spieler spielt sofort aus der Hand', () => {
  const s = mk({ players: [{ down: ['H9', 'D4', 'C12'] }, { hand: ['S9', 'D9'] }, { hand: ['S11', 'C9'] }], pile: ['S8', 'S13'], turn: 0 });
  const ev = accept(s, 0, flip(1));
  assert.deepEqual(normEv(ev), { t: 'flipfail', seat: 0, card: 'D4', slot: 1, n: 3, gone: [], drew: 0 });
  assert.deepEqual(sorted(s.players[0].hand), ['D4', 'S13', 'S8']);
  assert.deepEqual(s.players[0].down, ['H9', null, 'C12']);
  assert.deepEqual(s.pile, []);
  assert.equal(s.turn, 0); assert.equal(s.freePlay, true);
  assert.equal(E.viewFor(s, 1).turn, 0);
  assert.equal(E.viewFor(s, 0).ev.card, 'D4', 'der Besitzer sieht seine aufgedeckte Karte');
  assert.equal(E.viewFor(s, 1).ev.card, null, 'die anderen sehen sie nicht: sie passt nicht und geht auf die Hand');
  assert.equal(E.viewFor(s, 2).ev.card, null);
  assert.equal(E.viewFor(s, 1).ev.n, 3, 'die Anzahl bleibt öffentlich');
  reject(s, 0, flip(0), 'erst die Hand');
  rejectAs(s, 0, PICK, 'cannot-pickup', 'der Stapel ist schon leer');
  accept(s, 0, play('D4'));
  assert.equal(s.turn, 1);
  // danach sind wieder die Handkarten dran, nicht die verdeckten
  accept(s, 1, play('S9'));
  accept(s, 2, play('S11'));
  reject(s, 0, flip(0));
  accept(s, 0, play('S13'));
  // mit Nachziehstapel (laut Regeltext): nach dem Aufnehmen auf 3 auffüllen
  const w = mk({ players: [{ down: ['D4'] }, { hand: ['S9', 'D9', 'H9'] }], pile: ['S13'], stock: ['C5', 'C6'], turn: 0 });
  const e2 = accept(w, 0, flip(0));
  assert.equal(e2.drew, 1);
  assert.equal(w.players[0].hand.length, 3);
});

test('Blind gegen roten Joker: aufdecken verboten, nur aufnehmen – der Joker ist danach weg', () => {
  let s = mk({ players: [{ down: ['H9', 'D2', 'JB'] }, { hand: ['S9', 'D9'] }, { hand: ['S11', 'C9'] }], pile: ['S8', 'JR'], turn: 0 });
  let o = E.options(s, 0);
  assert.deepEqual(o, { zone: 'down', playable: [], canPickup: true, canFlip: false, forced: true });
  mustPickup(s, 0);
  for (let i = 0; i < 3; i++) rejectAs(s, 0, flip(i), 'must-pickup', 'aufdecken gegen den roten Joker');
  let ev = accept(s, 0, PICK);
  assert.equal(ev.vol, false);
  assert.equal(ev.joker, true); assert.equal(ev.n, 1); assert.deepEqual(ev.gone, ['JR']);
  assert.deepEqual(s.players[0].hand, ['S8']);
  assert.deepEqual(s.players[0].down, ['H9', 'D2', 'JB'], 'keine verdeckte Karte verbraucht');
  assert.ok(s.burned.includes('JR'));
  assert.equal(s.turn, 0);
  accept(s, 0, play('S8'));
  // roter Joker ALLEIN auf dem Tisch: nichts aufzunehmen; danach deckt er frei auf – auf den leeren Stapel passt jede Karte
  s = mk({ players: [{ down: ['H9', 'D4', null] }, { hand: ['S9', 'D9'] }, { hand: ['S11', 'C9'] }], pile: ['JR'], turn: 0 });
  reject(s, 0, flip(0), 'aufdecken gegen den roten Joker');
  ev = accept(s, 0, PICK);
  assert.equal(ev.n, 0); assert.deepEqual(ev.gone, ['JR']); assert.equal(ev.drew, 0);
  assert.deepEqual(s.players[0].hand, []);
  assert.deepEqual(s.pile, []);
  assert.equal(s.turn, 0, 'er bleibt am Zug');
  o = E.options(s, 0);
  assert.equal(o.zone, 'down'); assert.equal(o.canFlip, true); assert.equal(o.canPickup, false);
  reject(s, 0, PICK, 'nochmal aufnehmen'); reject(s, 1, play('S9'), 'der Nächste ist noch nicht dran');
  ev = accept(s, 0, flip(1));
  assert.equal(ev.t, 'play'); assert.deepEqual(ev.cards, ['D4']); assert.equal(ev.from, 'down');
  assert.equal(s.turn, 1); assert.equal(s.freePlay, false);
  assert.deepEqual(s.players[0].down, ['H9', null, null]);
});

test('Blind gegen schwarzen Joker: aufnehmen ODER aufdecken; aufgedeckter roter Joker kontert, alles andere scheitert – verbrauchte Joker sind weg', () => {
  const base = mk({ players: [{ down: ['JR', 'D2', 'H10'] }, { hand: ['S9', 'D9'] }, { hand: ['S11', 'C9'] }], pile: ['S8', 'JB'], turn: 0 });
  const o = E.options(base, 0);
  assert.deepEqual(o, { zone: 'down', playable: [], canPickup: true, canFlip: true, forced: false });
  let s = clone(base);
  let ev = accept(s, 0, PICK);
  assert.equal(ev.vol, true, 'er hätte auch aufdecken dürfen');
  assert.equal(ev.n, 1); assert.deepEqual(ev.gone, ['JB']);
  assert.deepEqual(s.players[0].hand, ['S8']);
  assert.deepEqual(s.players[0].down, ['JR', 'D2', 'H10']);
  s = clone(base);
  ev = accept(s, 0, flip(0));
  assert.deepEqual(ev.fx, ['counter']);
  assert.deepEqual(s.pile, ['S8', 'JB', 'JR']);
  assert.equal(s.turn, 1);
  reject(s, 1, play('S9'));
  ev = accept(s, 1, PICK);
  assert.equal(ev.n, 1); assert.deepEqual(ev.gone, ['JB', 'JR']);
  assert.deepEqual(sorted(s.players[1].hand), ['D9', 'S8', 'S9'], 'nur die 8 – beide Joker sind aus dem Spiel');
  assert.ok(s.burned.includes('JB') && s.burned.includes('JR'));
  for (const slot of [1, 2]) {                 // weder 2 noch 10 heben den Joker auf
    s = clone(base);
    const b0 = s.burned.length;
    ev = accept(s, 0, flip(slot));
    assert.equal(ev.t, 'flipfail');
    assert.equal(ev.n, 2, 'die 8 und die aufgedeckte Karte – der Joker zählt nicht');
    assert.deepEqual(ev.gone, ['JB']);
    assert.deepEqual(sorted(s.players[0].hand), sorted(['S8', base.players[0].down[slot]]));
    assert.deepEqual(s.burned.slice(b0), ['JB'], 'auch nach einem gescheiterten Aufdecken ist der Joker weg');
    assert.equal(s.turn, 0);
    assert.equal(s.freePlay, true);
    if (slot === 2) { ev = accept(s, 0, play('H10')); assert.deepEqual(ev.fx, ['burn'], 'die aufgedeckte 10 darf er jetzt frei legen'); }
  }
  // schwarzer Joker ALLEIN auf dem Tisch, aufgedeckte Karte scheitert: n = 1 (nur die aufgedeckte Karte)
  s = mk({ players: [{ down: [null, 'D2', null] }, { hand: ['S9', 'D9'] }, { hand: ['S11', 'C9'] }], pile: ['JB'], turn: 0 });
  ev = accept(s, 0, flip(1));
  assert.equal(ev.t, 'flipfail'); assert.equal(ev.n, 1); assert.deepEqual(ev.gone, ['JB']);
  assert.deepEqual(s.players[0].hand, ['D2']);
  assert.equal(s.winner, null, 'nicht fertig: die Karte ist jetzt auf der Hand');
  ev = accept(s, 0, play('D2'));
  assert.deepEqual(ev.fx, ['win']);
});

/* ================================================================== Sonderkarten: vollständig über alle obersten Karten */

function specialSweep(special, check) {
  let n = 0;
  for (const top of [null].concat(ALL)) {
    const card = isJ(special) ? special : SUITS.map((f) => f + special).find((c) => c !== top);
    if (card === top) continue;
    const s = table(3, { pile: top ? [top] : [], turn: 0, seats: { 0: { hand: [card, ALL.find((c) => rk(c) === 4 && c !== top)] } } });
    const exp = tableSays(card, top);
    if (exp) { const b0 = s.burned.length; const ev = accept(s, 0, play(card), card + ' auf ' + top); check(s, ev, top, card, b0); }
    else reject(s, 0, play(card), card + ' auf ' + top);
    n++;
  }
  return n;
}

test('2 – freie Karte: auf jede Karte außer auf einen Joker; danach darf der Nächste jede Karte legen', () => {
  const n = specialSweep(2, (s, ev, top, card) => {
    assert.ok(!isJ(top));
    assert.deepEqual(ev.fx, []);
    assert.equal(topOf(s), card);
    assert.equal(s.turn, 1);
    assert.deepEqual(E.requirement(s), { k: 'any' });
    for (const c of s.players[1].hand) accept(clone(s), 1, play(c), c + ' auf die 2');
  });
  assert.equal(n, 55);
  for (const j of ['JB', 'JR']) reject(table(3, { pile: ['S9', j], turn: 0, seats: { 0: { hand: ['H2', 'D2'] } } }), 0, play('H2'), '2 hebt den Joker nicht auf');
  // 3, 4 und 10 auf eine 2
  for (const c of ['H3', 'H4', 'H10', 'H14', 'JB']) accept(table(3, { pile: ['S14', 'S2'], turn: 0, seats: { 0: { hand: [c, 'D9'] } } }), 0, play(c));
});

test('3 – Richtungswechsel: muss die Wertregel erfüllen (nur auf 2, 3, 7 und den leeren Stapel)', () => {
  const okTops = [];
  specialSweep(3, (s, ev, top) => {
    okTops.push(top == null ? 'leer' : rk(top));
    assert.deepEqual(ev.fx, ['reverse']);
    assert.equal(s.dir, -1);
    assert.equal(s.turn, 2, 'bei drei Spielern ist jetzt der Vorgänger dran');
  });
  assert.deepEqual([...new Set(okTops)].map(String).sort(), ['2', '3', '7', 'leer'].sort());
});

test('3: kehrt bei 3–6 Spielern die Richtung um, danach geht es so weiter; eine zweite 3 dreht zurück; mehrere 3er drehen einmal', () => {
  for (let n = 3; n <= 6; n++) {
    const seats = {};
    for (let i = 0; i < n; i++) seats[i] = { hand: [SUITS[i % 4] + (4 + Math.floor(i / 4)), SUITS[i % 4] + (11 + Math.floor(i / 4))] };
    seats[1] = { hand: ['H3', 'D3', 'C3', 'S13'] };
    const s = table(n, { pile: [], turn: 1, seats });
    let ev = accept(s, 1, play('H3'));
    assert.deepEqual(ev.fx, ['reverse']);
    assert.equal(s.dir, -1);
    assert.equal(s.turn, 0, n + ' Spieler: zurück zum Vorgänger');
    accept(s, 0, play(s.players[0].hand[0]));
    assert.equal(s.turn, n - 1, 'weiter gegen den Uhrzeigersinn');
    accept(s, n - 1, play(s.players[n - 1].hand[1]));
    assert.equal(s.turn, n - 2);
    // zwei 3er auf einmal: die Richtung dreht genau einmal
    const m = table(n, { pile: ['S2'], turn: 1, dir: -1, seats });
    ev = accept(m, 1, play('H3', 'D3'));
    assert.deepEqual(ev.fx, ['reverse']);
    assert.equal(m.dir, 1, 'einmal gedreht');
    assert.equal(m.turn, 2);
    const m3 = table(n, { pile: ['S7'], turn: 1, seats });
    accept(m3, 1, play('H3', 'D3', 'C3'));
    assert.equal(m3.dir, -1, 'auch drei 3er drehen einmal');
    assert.equal(m3.turn, 0);
  }
});

test('3: bei genau 2 Spielern ist derselbe Spieler nach dem Nachziehen sofort noch einmal dran', () => {
  let s = mk({ players: [{ hand: ['H3', 'D9', 'C4'] }, { hand: ['S9', 'S11', 'S12'] }], pile: ['S2'], stock: ['C8', 'C14'], turn: 0 });
  let ev = accept(s, 0, play('H3'));
  assert.deepEqual(ev.fx, ['again']);
  assert.equal(ev.drew, 1, 'erst nachziehen');
  assert.deepEqual(sorted(s.players[0].hand), ['C14', 'C4', 'D9']);
  assert.equal(s.turn, 0);
  assert.equal(s.freePlay, false);
  reject(s, 1, play('S9'), 'der andere ist nicht dran');
  notForced(s, 0, 'auf die 3 passt jede Karte');
  accept(s, 0, play('C4'));
  assert.equal(s.turn, 1);
  // mehrere 3er: ein weiterer Zug (nicht zwei)
  s = mk({ players: [{ hand: ['H3', 'D3', 'C4', 'C5'] }, { hand: ['S9', 'S11', 'S12'] }], pile: [], turn: 0 });
  ev = accept(s, 0, play('H3', 'D3'));
  assert.deepEqual(ev.fx, ['again']);
  assert.equal(s.turn, 0);
  accept(s, 0, play('C4'));
  assert.equal(s.turn, 1, 'nach dem einen Zusatzzug ist der andere dran');
  // 3 auf 3: wieder nochmal
  s = mk({ players: [{ hand: ['H3', 'D3', 'C4', 'C5'] }, { hand: ['S9', 'S11', 'S12'] }], pile: [], turn: 0 });
  accept(s, 0, play('H3')); assert.equal(s.turn, 0);
  accept(s, 0, play('D3')); assert.equal(s.turn, 0);
  accept(s, 0, play('C4')); assert.equal(s.turn, 1);
  // aus den offenen Karten
  s = mk({ players: [{ up: ['H3', 'D9', null], down: ['C4'] }, { hand: ['S9', 'S11', 'S12'] }], pile: ['S7'], turn: 0 });
  ev = accept(s, 0, play('H3'));
  assert.deepEqual(ev.fx, ['again']);
  assert.equal(s.turn, 0);
});

test('3: "genau 2 Spieler" zählt die Spieler, die noch Karten haben – auch wenn die Partie mit mehr begonnen hat', () => {
  // 4 Spieler, Sitz 1 und 2 sind schon fertig: Sitz 0 legt eine 3 -> nochmal
  let s = mk({ players: [{ hand: ['H3', 'D9'] }, {}, {}, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0, finished: [2, 1] });
  let ev = accept(s, 0, play('H3'));
  assert.deepEqual(ev.fx, ['again']);
  assert.equal(s.turn, 0);
  accept(s, 0, play('D9'));
  assert.equal(s.phase, 'over');
  // 4 Spieler, nur Sitz 2 ist fertig (3 aktiv): Richtungswechsel, kein Zusatzzug
  s = mk({ players: [{ hand: ['H3', 'D9'] }, { hand: ['S4', 'S5'] }, {}, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0, finished: [2] });
  ev = accept(s, 0, play('H3'));
  assert.deepEqual(ev.fx, ['reverse']);
  assert.equal(s.turn, 3);
  // drei aktiv, die 3 ist die letzte Karte des Legers: zum Zeitpunkt des Legens waren es drei -> Richtungswechsel
  s = mk({ players: [{ hand: ['H3'] }, { hand: ['S4', 'S5'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 });
  ev = accept(s, 0, play('H3'));
  assert.deepEqual(sorted(ev.fx), ['reverse', 'win']);
  assert.equal(s.turn, 2, 'nach dem Richtungswechsel ist der Vorgänger dran');
  // zwei aktiv, die 3 ist die letzte Karte: kein Zusatzzug, die Runde ist vorbei
  s = mk({ players: [{ hand: ['H3'] }, { hand: ['S4', 'S5'] }], pile: ['S2'], turn: 0 });
  ev = accept(s, 0, play('H3'));
  assert.deepEqual(sorted(ev.fx), ['over', 'win']);
  assert.equal(s.phase, 'over');
});

test('7 – Sonderkarte: darf auf JEDE Karte (auch 8, 9, B, D, K, A) und den leeren Stapel, nur nicht auf einen Joker; der Nächste muss 3–6 legen oder 2, 7, 10, Joker (alle 54 Karten)', () => {
  const okTops = [];
  const n7 = specialSweep(7, (s, ev, top, card) => {
    okTops.push(top == null ? 'leer' : rk(top));
    assert.ok(!isJ(top));
    assert.deepEqual(ev.fx, [], 'die 7 hat keinen Sofort-Effekt');
    assert.equal(topOf(s), card, 'die 7 bleibt liegen');
    assert.equal(s.turn, 1);
    assert.deepEqual(E.requirement(s), { k: 'seven' });
  });
  assert.equal(n7, 55);
  assert.deepEqual([...new Set(okTops)].map(String).sort(), ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', 'leer'].sort());
  // ausdrücklich: 7 auf 8, 9, Bube, Dame, König, Ass – aus der Hand, aus den offenen Karten und blind; kein Zwang zum Aufnehmen, solange eine 7 da ist
  for (const top of ['S8', 'S9', 'S11', 'S12', 'S13', 'S14']) {
    let t = mk({ players: [{ hand: ['H7', 'D4'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: ['C5', top], turn: 0 });
    assert.deepEqual(E.options(t, 0), { zone: 'hand', playable: ['H7'], canPickup: true, canFlip: false, forced: false });
    reject(t, 0, play('D4'), '4 auf ' + top);
    notForced(t, 0, 'die 7 passt auf ' + top);
    accept(t, 0, play('H7'), '7 auf ' + top);
    assert.deepEqual(t.pile, ['C5', top, 'H7']);
    reject(t, 1, play('D9'), 'nach der 7 muss der Nächste darunter bleiben');
    accept(t, 1, play('H5'));
    t = mk({ players: [{ up: ['D4', 'H7', null], down: ['C2'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: [top], turn: 0 });
    notForced(t, 0, 'die offene 7 passt auf ' + top);
    assert.equal(accept(t, 0, play('H7')).from, 'up');
    t = mk({ players: [{ down: [null, 'H7', 'C4'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: [top], turn: 0 });
    const ev = accept(t, 0, flip(1), 'blinde 7 auf ' + top);
    assert.equal(ev.t, 'play'); assert.deepEqual(ev.cards, ['H7']);
    assert.deepEqual(E.requirement(t), { k: 'seven' });
  }
  // die Anzeige-Anforderung über einer hohen Karte: 'min' – 2, 7, 10 und Joker gehen trotzdem (K2b)
  assert.deepEqual(E.requirement(mk({ players: [{ hand: ['H7'] }, { hand: ['H5'] }], pile: ['S12'] })), { k: 'min', rank: 12 });
  const allowed = [];
  for (const c of ALL) {
    if (c === 'S7') continue;
    const s = table(3, { pile: ['S7'], turn: 1, seats: { 1: { hand: [c, c === 'C13' ? 'D13' : 'C13'] } } });
    const exp = isJ(c) || [3, 4, 5, 6].includes(rk(c)) || [2, 7, 10].includes(rk(c));    // unter 7 – oder Sonderkarte
    if (exp) { accept(s, 1, play(c), c + ' nach 7'); allowed.push(c); } else reject(s, 1, play(c), c + ' nach 7');
  }
  assert.equal(allowed.length, 4 * 4 + 4 + 3 + 4 + 2, '3–6 (16), 2 (4), die drei anderen 7er, 10 (4), beide Joker');
  // nach einer 7 hilft nur darunter oder eine Sonderkarte: mit 8, 9, B, D, K, A allein muss man aufnehmen – die 7-Regel ist danach vorbei
  let u = table(3, { pile: ['C12', 'S7'], turn: 1, seats: { 1: { hand: ['H8', 'H9', 'H11', 'H12', 'H13', 'H14'] } } });
  assert.deepEqual(E.options(u, 1), { zone: 'hand', playable: [], canPickup: true, canFlip: false, forced: true });
  assert.equal(accept(u, 1, PICK).vol, false);
  accept(u, 1, play('H14'), 'der Pflichtzug ist frei');
  // mehrere gleiche Karten, wenn sie die Regel erfüllen
  let s = table(3, { pile: ['S7'], turn: 1, seats: { 1: { hand: ['H6', 'D6', 'H9', 'D9'] } } });
  reject(s, 1, play('H9', 'D9'));
  accept(s, 1, play('H6', 'D6'));
  // 7 auf 7: die Beschränkung gilt erneut
  s = table(3, { pile: ['S7'], turn: 0, seats: { 0: { hand: ['H7', 'D13'] }, 1: { hand: ['S9', 'S4'] } } });
  accept(s, 0, play('H7'));
  reject(s, 1, play('S9'));
  accept(s, 1, play('S4'));
});

test('7: die Beschränkung betrifft nur den direkt nächsten Zug', () => {
  const s = mk({ players: [{ hand: ['H7', 'D11'] }, { hand: ['S5', 'S13'] }, { hand: ['H9', 'D4'] }, { hand: ['H14', 'D5'] }], pile: ['S4'], turn: 0 });
  accept(s, 0, play('H7'));
  reject(s, 1, play('S13'));
  accept(s, 1, play('S5'));
  reject(s, 2, play('D4'), 'jetzt gilt wieder die normale Regel gegen die 5');
  accept(s, 2, play('H9'), '9 auf 5 – die 7 liegt weiter unten und zählt nicht mehr');
  accept(s, 3, play('H14'));
  // 2 nach 7: danach ist alles frei
  const t2 = mk({ players: [{ hand: ['H7', 'D11'] }, { hand: ['S2', 'S13'] }, { hand: ['H14', 'D4'] }], pile: ['S4'], turn: 0 });
  accept(t2, 0, play('H7'));
  accept(t2, 1, play('S2'));
  accept(t2, 2, play('H14'));
});

test('10 – Ablagestapel entfernen: auf JEDE Karte (auch 7, B, D, K, A) und den leeren Stapel, nur nicht auf einen Joker; Stapel samt 10 ist dauerhaft weg; der NÄCHSTE beginnt frei', () => {
  const okTops = [];
  specialSweep(10, (s, ev, top, card, b0) => {
    okTops.push(top == null ? 'leer' : rk(top));
    assert.deepEqual(ev.fx, ['burn']);
    assert.deepEqual(s.pile, []);
    assert.deepEqual(sorted(s.burned.slice(b0)), sorted([card].concat(top ? [top] : [])), 'Stapel und 10 sind aus dem Spiel');
    assert.equal(s.turn, 1, 'der nächste Spieler beginnt (nicht derselbe noch einmal)');
    assert.deepEqual(E.requirement(s), { k: 'any' });
    for (const c of s.players[1].hand) accept(clone(s), 1, play(c), 'beliebige Karte nach der 10');
    assert.equal(E.options(s, 1).canPickup, false, 'nach der 10 liegt nichts mehr zum Aufnehmen');
    assert.equal(E.options(s, 1).forced, false);
  });
  assert.deepEqual([...new Set(okTops)].map(String).sort(), ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', 'leer'].sort());
  // ausdrücklich: 10 auf Bube, Dame, König, Ass – aus der Hand, aus den offenen Karten und blind
  for (const top of ['S11', 'S12', 'S13', 'S14']) {
    let s = mk({ players: [{ hand: ['H10', 'D4'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: ['C5', top], turn: 0 });
    assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: ['H10'], canPickup: true, canFlip: false, forced: false });
    reject(s, 0, play('D4'), '4 auf ' + top);
    let b0 = s.burned.length;
    assert.deepEqual(accept(s, 0, play('H10'), '10 auf ' + top).fx, ['burn']);
    assert.deepEqual(sorted(s.burned.slice(b0)), sorted(['C5', top, 'H10']));
    assert.deepEqual(s.pile, []);
    s = mk({ players: [{ up: ['D4', 'H10', null], down: ['C2'] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: [top], turn: 0 });
    notForced(s, 0, 'die offene 10 passt auf ' + top);
    assert.deepEqual(accept(s, 0, play('H10')).fx, ['burn']);
    s = mk({ players: [{ down: [null, 'H10', null] }, { hand: ['H5', 'D9'] }, { hand: ['H6', 'D8'] }], pile: [top], turn: 0 });
    b0 = s.burned.length;
    const ev = accept(s, 0, flip(1), 'blinde 10 auf ' + top);
    assert.deepEqual(sorted(ev.fx), ['burn', 'win']);
    assert.deepEqual(sorted(s.burned.slice(b0)), sorted([top, 'H10']));
  }
  assert.equal(E.requirement(mk({ players: [{ hand: ['H10'] }, { hand: ['H5'] }], pile: ['S13'] })).k, 'min');
});

test('10: mehrere 10er entfernen den Stapel einmal; vernichtete Karten kommen nie zurück', () => {
  const s = mk({
    players: [{ hand: ['H10', 'D10', 'C10', 'S4'] }, { hand: ['H5', 'D13'] }, { hand: ['H6', 'D8'] }],
    pile: ['S5', 'S6', 'S7', 'H7', 'S9'], turn: 0
  });
  const b0 = s.burned.length;
  const ev = accept(s, 0, play('H10', 'D10', 'C10'));
  assert.deepEqual(ev.fx, ['burn'], 'genau ein Entfernen');
  assert.deepEqual(sorted(s.burned.slice(b0)), sorted(['S5', 'S6', 'S7', 'H7', 'S9', 'H10', 'D10', 'C10']));
  assert.equal(E.viewFor(s, 1).burned, b0 + 8);
  assert.deepEqual(s.pile, []);
  assert.equal(s.turn, 1);
  accept(s, 1, play('D13'));
  reject(s, 2, play('H6'));
  mustPickup(s, 2);
  accept(s, 2, PICK);
  assert.deepEqual(sorted(s.players[2].hand), ['D13', 'D8', 'H6'], 'nur der neue Stapel wird aufgenommen');
  for (const c of ['S5', 'S9', 'H10']) for (const p of s.players) assert.ok(!p.hand.includes(c));
  // 10 hebt einen Joker nicht auf
  for (const j of ['JB', 'JR']) reject(table(3, { pile: ['S9', j], turn: 0, seats: { 0: { hand: ['H10', 'D4'] } } }), 0, play('H10'), '10 auf ' + j);
});

test('Joker: dürfen auf jede Nicht-Joker-Karte und auf den leeren Stapel; der Nächste muss den Stapel aufnehmen – der Joker ist danach aus dem Spiel', () => {
  for (const j of ['JB', 'JR']) {
    const n = specialSweep(j, (s, ev, top, card) => {
      if (top === 'JB') { assert.equal(card, 'JR'); assert.deepEqual(ev.fx, ['counter']); } else assert.deepEqual(ev.fx, ['joker']);
      assert.equal(topOf(s), card);
      assert.equal(s.turn, 1);
      assert.deepEqual(E.requirement(s), { k: card === 'JR' ? 'jokerR' : 'jokerB' });
      for (const c of s.players[1].hand) reject(s, 1, play(c), c + ' auf ' + card);
      const before = s.pile.slice(), hand0 = s.players[1].hand.slice(), b1 = s.burned.length;
      const taken = before.filter((c) => !isJ(c)), gone = before.filter(isJ);
      mustPickup(s, 1, 'gegen ' + card);
      const pe = accept(s, 1, PICK);
      assert.equal(pe.joker, true);
      assert.equal(pe.vol, false);
      assert.equal(pe.n, taken.length, 'n zählt nur die Karten, die wirklich auf die Hand kommen');
      assert.deepEqual(pe.gone, gone);
      assert.deepEqual(sorted(s.players[1].hand), sorted(hand0.concat(taken)));
      assert.deepEqual(s.burned.slice(b1), gone, 'der Joker liegt bei den entfernten Karten');
      assert.deepEqual(s.pile, []);
      for (const p of s.players) assert.ok(!p.hand.some((c) => gone.includes(c)), 'auf keiner Hand');
      assert.equal(s.turn, 1, 'wer aufgenommen hat, legt selbst');
      assert.equal(s.freePlay, true);
    });
    assert.equal(n, 54);
  }
});

test('Joker: weder 2 noch 10 noch der schwarze Joker heben einen Joker auf; beide Joker zusammen geht nie', () => {
  let s = table(3, { pile: ['S9', 'JR'], turn: 0, seats: { 0: { hand: ['H2', 'H10', 'JB', 'H14', 'H3', 'H7'] } } });
  for (const c of s.players[0].hand.slice()) reject(s, 0, play(c), c + ' auf den roten Joker');
  mustPickup(s, 0);
  accept(s, 0, PICK);
  s = table(3, { pile: ['S9', 'JB'], turn: 0, seats: { 0: { hand: ['H2', 'H10', 'H14', 'H3', 'H7'] } } });
  for (const c of s.players[0].hand.slice()) rejectAs(s, 0, play(c), 'not-playable', c + ' auf den schwarzen Joker');
  mustPickup(s, 0);
  accept(s, 0, PICK);
  for (const pile of [[], ['S9'], ['S2'], ['S7']]) {
    s = table(3, { pile, turn: 0, seats: { 0: { hand: ['JB', 'JR', 'H4'] } } });
    reject(s, 0, play('JB', 'JR'), 'beide Joker');
    reject(s, 0, play('JR', 'JB'), 'beide Joker');
  }
});

test('Schwarzer Joker: der rote kontert (freiwillig) – dann muss der Darauffolgende den Stapel aufnehmen und BEIDE Joker sind aus dem Spiel', () => {
  const base = mk({ players: [{ hand: ['JB', 'S4'] }, { hand: ['JR', 'H9', 'H2'] }, { hand: ['D9', 'D10', 'D2'] }, { hand: ['C9', 'C11'] }], pile: ['S8'], turn: 0 });
  accept(base, 0, play('JB'));
  assert.equal(base.turn, 1);
  const o = E.options(base, 1);
  assert.deepEqual(o, { zone: 'hand', playable: ['JR'], canPickup: true, canFlip: false, forced: false }, 'Kontern ist freiwillig');
  reject(base, 1, play('H9')); reject(base, 1, play('H2'));
  // (a) kontern
  let s = clone(base);
  const ev = accept(s, 1, play('JR'));
  assert.deepEqual(ev.fx, ['counter']);
  assert.equal(s.turn, 2);
  for (const c of ['D9', 'D10', 'D2']) reject(s, 2, play(c), 'der Darauffolgende kann nichts legen');
  const b0 = s.burned.length;
  mustPickup(s, 2);
  const pe = accept(s, 2, PICK);
  assert.equal(pe.vol, false);
  assert.equal(pe.n, 1, 'nur die 8');
  assert.equal(pe.joker, true);
  assert.deepEqual(pe.gone, ['JB', 'JR']);
  assert.deepEqual(sorted(s.players[2].hand), sorted(['D9', 'D10', 'D2', 'S8']));
  assert.deepEqual(s.burned.slice(b0), ['JB', 'JR']);
  assert.equal(E.viewFor(s, 0).burned, b0 + 2);
  assert.equal(s.turn, 2);
  accept(s, 2, play('D2'), 'danach legt er selbst frei');
  assert.equal(s.turn, 3);
  // (b) nicht kontern: der schwarze ist weg; der eigene rote Joker bleibt (nie gespielt) und wirkt später als normaler Joker
  s = clone(base);
  const pb = accept(s, 1, PICK);
  assert.equal(pb.vol, true, 'er hätte kontern können');
  assert.deepEqual(pb.gone, ['JB']);
  assert.deepEqual(sorted(s.players[1].hand), sorted(['JR', 'H9', 'H2', 'S8']));
  assert.equal(s.turn, 1);
  assert.deepEqual(accept(s, 1, play('JR')).fx, ['joker']);
  assert.equal(s.turn, 2);
  assert.deepEqual(accept(s, 2, PICK).gone, ['JR']);
  // der schwarze kontert den roten nicht
  s = mk({ players: [{ hand: ['JR', 'S4'] }, { hand: ['JB', 'H9'] }, { hand: ['D9', 'D10'] }], pile: ['S8'], turn: 0 });
  accept(s, 0, play('JR'));
  reject(s, 1, play('JB'));
  mustPickup(s, 1, 'schwarz kontert rot nicht');
});

test('Joker: "der Nächste" folgt der aktuellen Spielrichtung; Joker auf den LEEREN Stapel: der Nächste nimmt nichts auf (n = 0), der Joker ist weg, er spielt frei', () => {
  let s = mk({ players: [{ hand: ['JR', 'S4'] }, { hand: ['H9', 'H5'] }, { hand: ['D9', 'D5'] }, { hand: ['C9', 'C11'] }], pile: ['S8'], turn: 0, dir: -1 });
  accept(s, 0, play('JR'));
  assert.equal(s.turn, 3);
  rejectAs(s, 1, PICK, 'not-your-turn', 'nicht der Nächste in Spielrichtung');
  accept(s, 3, PICK);
  assert.equal(s.turn, 3);
  assert.deepEqual(sorted(s.players[3].hand), ['C11', 'C9', 'S8']);
  for (const j of ['JB', 'JR']) {
    s = mk({ players: [{ hand: [j, 'S4'] }, { hand: ['H9', 'H5'] }, { hand: ['D9', 'D5'] }], pile: [], turn: 0 });
    const b0 = s.burned.length;
    assert.deepEqual(accept(s, 0, play(j)).fx, ['joker']);
    assert.deepEqual(s.pile, [j]);
    for (const c of ['H9', 'H5']) reject(s, 1, play(c), 'auch auf den einzelnen Joker darf nichts');
    assert.deepEqual(E.options(s, 1), { zone: 'hand', playable: [], canPickup: true, canFlip: false, forced: true });
    const ev = accept(s, 1, PICK);
    assert.deepEqual(normEv(ev), { t: 'pickup', seat: 1, n: 0, joker: true, vol: false, gone: [j], drew: 0, upCard: null, slot: -1 });
    assert.deepEqual(sorted(s.players[1].hand), ['H5', 'H9'], 'die Hand ist unverändert');
    assert.deepEqual(s.pile, []);
    assert.deepEqual(s.burned.slice(b0), [j]);
    assert.equal(s.turn, 1); assert.equal(s.freePlay, true);
    assert.deepEqual(sorted(E.options(s, 1).playable), ['H5', 'H9']);
    rejectAs(s, 1, PICK, 'cannot-pickup', 'nochmal aufnehmen');
    accept(s, 1, play('H5'), 'frei wählbar');
    assert.equal(s.turn, 2);
    assertConserved(s);
  }
});

/* ================================================================== Fertig werden, Rangfolge, Spielende */

test('Spielende: wer seine letzte Karte ablegt, ist fertig; der Erste gewinnt; die anderen spielen weiter, bis nur noch einer Karten hat (2–6 Spieler, beide Richtungen)', () => {
  for (let n = 2; n <= 6; n++) for (const dir of [1, -1]) for (let start = 0; start < n; start++) {
    const order = [];
    for (let i = 0; i < n; i++) order.push((((start + dir * i) % n) + n) % n);
    const players = new Array(n);
    order.forEach((seat, k) => { players[seat] = { hand: [SUITS[k % 4] + [4, 5, 6, 8, 9, 11][k]] }; });       // aufsteigend: jeder kann legen
    const s = mk({ players, pile: [], turn: start, dir });
    for (let k = 0; k < n - 1; k++) {
      const seat = order[k];
      assert.equal(s.turn, seat, n + ' Spieler, Richtung ' + dir + ': Reihenfolge');
      assert.equal(s.phase, 'play');
      const ev = accept(s, seat, play(players[seat].hand[0]));
      assert.equal(ev.place, k + 1);
      const last = k === n - 2;
      assert.deepEqual(sorted(ev.fx), sorted([k === 0 ? 'win' : 'out'].concat(last ? ['over'] : [])));
      assert.equal(s.winner, start, 'der Erste bleibt Sieger');
      assert.deepEqual(s.finished, order.slice(0, k + 1));
      const v = E.viewFor(s, seat);
      assert.equal(v.players[seat].place, k + 1);
      assert.equal(v.players[seat].zone, null);
      assert.equal(v.winner, start);
      reject(s, seat, PICK, 'Fertige ziehen nicht mehr');
    }
    assert.equal(s.phase, 'over');
    assert.equal(s.turn, -1);
    assert.equal(s.loser, order[n - 1], 'der Letzte mit Karten verliert');
    assert.equal(s.deadlock, false);
    const v = E.viewFor(s, 0);
    assert.deepEqual(v.finished, order.slice(0, n - 1), 'Reihenfolge des Fertigwerdens = Rangfolge');
    assert.equal(v.loser, order[n - 1]);
    assert.equal(v.players[order[n - 1]].place, 0, 'der Verlierer hat keinen Platz');
    assert.deepEqual(order.slice(0, n - 1).map((x) => v.players[x].place), order.slice(0, n - 1).map((_, k) => k + 1));
    assert.equal(v.my, null);
    for (let seat = 0; seat < n; seat++) { reject(s, seat, PICK); reject(s, seat, READY); }
  }
});

test('Spielende: fertige Spieler werden in beiden Richtungen übersprungen', () => {
  for (const dir of [1, -1]) {
    const s = mk({
      players: [{ hand: ['S4', 'S5', 'S6'] }, {}, { hand: ['D4', 'D5', 'D6'] }, {}, { hand: ['C4', 'C5', 'C6'] }],
      pile: [], turn: 0, dir, finished: [3, 1]
    });
    const seen = [];
    for (const r of [4, 5, 6]) for (let k = 0; k < 3 && s.phase === 'play'; k++) { seen.push(s.turn); accept(s, s.turn, play(SUITS[[0, -1, 2, -1, 3][s.turn]] + r)); }
    assert.deepEqual(seen.slice(0, 6), dir === 1 ? [0, 2, 4, 0, 2, 4] : [0, 4, 2, 0, 4, 2]);
    assert.equal(E.nextSeat(mk({ players: [{ hand: ['S4'] }, {}, { hand: ['D4'] }, {}, { hand: ['C4'] }], turn: 0, dir, finished: [3, 1] }), 0), dir === 1 ? 2 : 4);
    assert.deepEqual(s.finished.slice(0, 2), [3, 1], 'frühere Plätze bleiben');
  }
});

test('Spielende: fertig ist nur, wer Hand, offene UND verdeckte Karten los ist und nichts mehr nachziehen kann', () => {
  // letzte Handkarte, aber noch offene Karten
  let s = mk({ players: [{ hand: ['H9'], up: ['S4'] }, { hand: ['D9', 'D11'] }], pile: ['S5'], turn: 0 });
  assert.equal(accept(s, 0, play('H9')).place, undefined);
  assert.equal(s.phase, 'play'); assert.equal(s.winner, null);
  // letzte offene Karte, aber noch verdeckte
  s = mk({ players: [{ up: ['H9'], down: ['S4'] }, { hand: ['D9', 'D11'] }], pile: ['S5'], turn: 0 });
  accept(s, 0, play('H9'));
  assert.equal(s.winner, null);
  // letzte verdeckte Karte passt: gewonnen
  s = mk({ players: [{ down: [null, 'H9', null] }, { hand: ['D9', 'D11'] }], pile: ['S5'], turn: 0 });
  let ev = accept(s, 0, flip(1));
  assert.deepEqual(sorted(ev.fx), ['over', 'win']);
  assert.equal(s.winner, 0); assert.equal(s.loser, 1);
  // letzte verdeckte Karte passt nicht: nicht fertig, Karte + Stapel auf der Hand
  s = mk({ players: [{ down: [null, 'H4', null] }, { hand: ['D9', 'D11'] }], pile: ['S5'], turn: 0 });
  ev = accept(s, 0, flip(1));
  assert.equal(ev.t, 'flipfail');
  assert.equal(s.winner, null); assert.equal(s.phase, 'play');
  assert.deepEqual(sorted(s.players[0].hand), ['H4', 'S5']);
  // letzte Handkarte, aber der Nachziehstapel füllt auf
  s = mk({ players: [{ hand: ['H9'] }, { hand: ['D9', 'D11', 'D12'] }], pile: ['S5'], stock: ['C4'], turn: 0 });
  accept(s, 0, play('H9'));
  assert.equal(s.winner, null);
  // mehrere Karten als letzter Zug
  s = mk({ players: [{ hand: ['H9', 'D9', 'C9'] }, { hand: ['D4', 'D11'] }, { hand: ['S4', 'S11'] }], pile: ['S5'], turn: 0 });
  ev = accept(s, 0, play('H9', 'C9', 'D9'));
  assert.deepEqual(ev.fx, ['win']);
  assert.equal(ev.place, 1);
  assert.equal(s.turn, 1, 'die anderen spielen weiter');
  assert.equal(s.phase, 'play');
});

test('Spielende: Sondereffekte der letzten Karte gelten weiter für den Nächsten (10, 3, 7, Joker, blind)', () => {
  const rest = () => [{ hand: ['D4', 'D11'] }, { hand: ['S4', 'S13'] }, { hand: ['C5', 'C12'] }];
  // 10 als letzte Karte: Stapel weg, der Nächste beginnt frei
  let s = mk({ players: [{ hand: ['H10'] }].concat(rest()), pile: ['S5', 'S9'], turn: 0 });
  let ev = accept(s, 0, play('H10'));
  assert.deepEqual(sorted(ev.fx), ['burn', 'win']);
  assert.deepEqual(s.pile, []); assert.equal(s.turn, 1);
  accept(s, 1, play('D4'));
  // 3 als letzte Karte: Richtung dreht, der Vorgänger ist dran
  s = mk({ players: [{ hand: ['H3'] }].concat(rest()), pile: ['S2'], turn: 0 });
  ev = accept(s, 0, play('H3'));
  assert.deepEqual(sorted(ev.fx), ['reverse', 'win']);
  assert.equal(s.turn, 3); assert.equal(s.dir, -1);
  accept(s, 3, play('C5'));
  assert.equal(s.turn, 2, 'weiter rückwärts, der Fertige wird übersprungen');
  accept(s, 2, play('S13'));
  assert.equal(s.turn, 1);
  // 7 als letzte Karte
  s = mk({ players: [{ hand: ['H7'] }].concat(rest()), pile: ['S5'], turn: 0 });
  accept(s, 0, play('H7'));
  reject(s, 1, play('D11'));
  accept(s, 1, play('D4'));
  // Joker als letzte Karte: der Leger ist fertig (er kann den Joker nie zurückbekommen); der Nächste muss aufnehmen
  // und dann selbst legen – der Joker ist weg
  s = mk({ players: [{ hand: ['JR'] }].concat(rest()), pile: ['S5'], turn: 0 });
  ev = accept(s, 0, play('JR'));
  assert.deepEqual(sorted(ev.fx), ['joker', 'win']);
  assert.equal(ev.place, 1);
  reject(s, 1, play('D11'));
  ev = accept(s, 1, PICK);
  assert.equal(ev.n, 1); assert.deepEqual(ev.gone, ['JR']);
  assert.equal(s.turn, 1);
  assert.deepEqual(sorted(s.players[1].hand), ['D11', 'D4', 'S5']);
  assert.deepEqual(s.players[0].hand, [], 'der Fertige bekommt nichts zurück');
  accept(s, 1, play('S5'));
  assert.equal(s.turn, 2);
  notForced(s, 2, 'kein Joker-Zwang mehr: der König passt');
  accept(s, 2, play('S13'));
  mustPickup(s, 3);
  accept(s, 3, PICK);
  accept(s, 3, play('C5'));
  assert.equal(s.turn, 1, 'der Fertige wird übersprungen');
  assert.deepEqual(s.finished, [0]);
  // Joker als letzte Karte bei zwei Spielern: Runde vorbei, der andere hat verloren (niemand nimmt mehr auf)
  for (const j of ['JB', 'JR']) {
    s = mk({ players: [{ hand: [j] }, { hand: ['D4', 'D11'] }], pile: ['S5'], turn: 0 });
    ev = accept(s, 0, play(j));
    assert.deepEqual(sorted(ev.fx), ['joker', 'over', 'win']);
    assert.equal(s.loser, 1); assert.equal(s.winner, 0); assert.equal(s.phase, 'over');
    assert.deepEqual(s.players[1].hand, ['D4', 'D11']);
    reject(s, 1, PICK, 'nach dem Ende wird nicht mehr aufgenommen');
  }
  // Joker als letzte OFFENE bzw. letzte VERDECKTE Karte
  s = mk({ players: [{ up: [null, 'JB', null] }].concat(rest()), pile: ['S14'], turn: 0 });
  ev = accept(s, 0, play('JB'));
  assert.deepEqual(sorted(ev.fx), ['joker', 'win']);
  assert.deepEqual(accept(s, 1, PICK).gone, ['JB']);
  s = mk({ players: [{ down: [null, null, 'JR'] }].concat(rest()), pile: ['S14'], turn: 0 });
  ev = accept(s, 0, flip(2));
  assert.deepEqual(sorted(ev.fx), ['joker', 'win']);
  assert.deepEqual(accept(s, 1, PICK).gone, ['JR']);
  // Konter als letzte Karte: fertig; der Darauffolgende nimmt auf, beide Joker sind weg
  s = mk({ players: [{ hand: ['JR'] }].concat(rest()), pile: ['S5', 'JB'], turn: 0 });
  ev = accept(s, 0, play('JR'));
  assert.deepEqual(sorted(ev.fx), ['counter', 'win']);
  ev = accept(s, 1, PICK);
  assert.deepEqual(ev.gone, ['JB', 'JR']); assert.equal(ev.n, 1);
  // blind als letzte Karte: 10
  s = mk({ players: [{ down: ['H10'] }].concat(rest()), pile: ['S5', 'S9'], turn: 0 });
  ev = accept(s, 0, flip(0));
  assert.deepEqual(sorted(ev.fx), ['burn', 'win']);
  assert.equal(s.turn, 1);
  // ein später Fertiger bekommt 'out' und den nächsten Platz
  s = mk({ players: [{ hand: ['H9'] }, {}, { hand: ['S4', 'S13'] }, { hand: ['C5', 'C12'] }], pile: ['S5'], turn: 0, finished: [1] });
  ev = accept(s, 0, play('H9'));
  assert.deepEqual(ev.fx, ['out']);
  assert.equal(ev.place, 2);
  assert.equal(s.winner, 1);
  assert.equal(s.turn, 2);
});

/* ================================================================== Aufgeben (K4) */

/* Nach einer beendeten Runde geht nichts mehr – für keinen Sitz. */
function assertNothingGoes(s) {
  for (let seat = 0; seat < s.players.length; seat++) {
    for (const a of [GIVEUP, PICK, READY, flip(0), play('H14')]) rejectAs(s, seat, a, 'wrong-phase', 'nach dem Ende');
    assert.equal(E.canGiveUp(s, seat), false);
    const v = E.viewFor(s, seat);
    assert.equal(v.canGiveUp, false); assert.equal(v.my, null);
    assert.equal(E.options(s, seat), null);
    assert.equal(E.botAction(s, seat), null);
  }
  assert.deepEqual(E.legalActions(s), []);
}

test('Aufgeben (K4): sind nur noch zwei Spieler in der Runde, darf jeder der beiden aufgeben – am Zug oder nicht; er ist der Verlierer, der andere gewinnt (wenn noch niemand fertig war)', () => {
  const base = mk({ players: [{ hand: ['H4', 'D5', 'C6', 'S8', 'S9', 'S11'], up: ['S12'], down: ['S13'] }, { hand: ['H14'] }], pile: ['D14'], stock: ['C2', 'C3'], turn: 0 });
  for (let seat = 0; seat < 2; seat++) {
    assert.equal(E.canGiveUp(base, seat), true);
    assert.equal(E.viewFor(base, seat).canGiveUp, true, 'die Sicht bietet "Aufgeben" an');
  }
  assert.equal(E.viewFor(base, -1).canGiveUp, false, 'Zuschauer nicht');
  assert.equal(E.viewFor(base, 0).gaveUp, null);
  assert.ok(!E.legalActions(base).some((a) => a.t === 'giveup'), 'Aufgeben ist kein Spielzug (legalActions nennt es nicht)');
  for (const seat of [0, 1]) {               // Sitz 0 ist am Zug, Sitz 1 nicht – beide dürfen
    const s = clone(base), other = 1 - seat, seq = s.seq;
    const cards = JSON.stringify([s.players, s.pile, s.stock, s.burned]);
    const ev = accept(s, seat, GIVEUP, 'Sitz ' + seat + ' gibt auf');
    assert.deepEqual(ev, { t: 'giveup', seat, other, place: 1, fx: ['win', 'over'], seq: seq + 1 });
    assert.equal(s.phase, 'over'); assert.equal(s.turn, -1);
    assert.equal(s.loser, seat, 'wer aufgibt, ist der Verlierer');
    assert.equal(s.gaveUp, seat);
    assert.equal(s.winner, other);
    assert.deepEqual(s.finished, [other], 'der andere bekommt den nächsten freien Platz: Platz 1');
    assert.equal(s.deadlock, false); assert.equal(s.freePlay, false);
    assert.equal(JSON.stringify([s.players, s.pile, s.stock, s.burned]), cards, 'keine Karte bewegt sich');
    for (const v of [-1, 0, 1]) {
      const view = E.viewFor(s, v);
      assert.equal(view.phase, 'over'); assert.equal(view.loser, seat); assert.equal(view.gaveUp, seat); assert.equal(view.winner, other);
      assert.deepEqual(view.finished, [other]);
      assert.equal(view.players[other].place, 1); assert.equal(view.players[seat].place, 0, 'der Verlierer hat keinen Platz');
      assert.equal(view.ev.t, 'giveup'); assert.equal(view.ev.seat, seat); assert.equal(view.ev.other, other);
      assert.equal(view.deadlock, false);
    }
    assertNothingGoes(s);
    // K3: der Verlierer beginnt die nächste Runde
    const next = E.createGame(names(2), { rng: mulberry32(3), startSeat: s.loser, startBy: 'loser' });
    assert.equal(next.startBy, 'loser'); assert.equal(next.startSeat, seat);
    accept(next, 0, READY); accept(next, 1, READY);
    assert.equal(next.turn, seat);
    assert.equal(next.gaveUp, null, 'neue Runde, neues Glück'); assert.equal(next.loser, null);
  }
});

test('Aufgeben (K4): nach bereits Fertigen bekommt der andere den nächsten freien Platz; der zuerst Fertige bleibt Sieger; Fertige können nicht aufgeben', () => {
  // 4 Spieler; Sitz 2 und dann Sitz 0 sind schon fertig. Am Zug ist Sitz 3 (Richtung gegen den Uhrzeigersinn).
  const base = mk({ players: [{}, { hand: ['H4', 'D5'] }, {}, { hand: ['H14'], up: ['S12'] }], pile: ['D13'], turn: 3, dir: -1, finished: [2, 0] });
  assert.deepEqual([0, 1, 2, 3].map((i) => E.canGiveUp(base, i)), [false, true, false, true]);
  assert.deepEqual([0, 1, 2, 3].map((i) => E.viewFor(base, i).canGiveUp), [false, true, false, true]);
  for (const seat of [0, 2]) rejectAs(base, seat, GIVEUP, 'cannot-giveup', 'wer fertig ist, kann nicht mehr aufgeben');
  for (const seat of [1, 3]) {
    const s = clone(base), other = 4 - seat;
    const ev = accept(s, seat, GIVEUP);
    assert.deepEqual(ev, { t: 'giveup', seat, other, place: 3, fx: ['out', 'over'], seq: s.seq });
    assert.deepEqual(s.finished, [2, 0, other]);
    assert.equal(s.winner, 2, 'Sieger bleibt, wer zuerst fertig war');
    assert.equal(s.loser, seat); assert.equal(s.gaveUp, seat);
    const places = E.viewFor(s, 0).players.map((p) => p.place);
    assert.deepEqual(places, seat === 1 ? [2, 0, 1, 3] : [2, 3, 1, 0], 'Plätze: Rangfolge des Fertigwerdens, der andere Dritter, der Verlierer ohne Platz');
    assertNothingGoes(s);
  }
  // 3 Spieler, einer fertig: Platz 2 für den anderen
  const t3 = mk({ players: [{ hand: ['H4'] }, {}, { hand: ['H14'] }], pile: ['D13'], turn: 0, finished: [1] });
  const ev = accept(t3, 2, GIVEUP, 'der Führende darf auch aufgeben');
  assert.equal(ev.place, 2); assert.deepEqual(ev.fx, ['out', 'over']);
  assert.deepEqual(t3.finished, [1, 0]); assert.equal(t3.loser, 2); assert.equal(t3.winner, 1);
});

test('Aufgeben (K4): nur bei GENAU zwei Spielern mit Karten – nicht zu dritt oder mehr, nicht in der Tauschphase, nicht nach dem Ende, nicht für unbekannte Sitze', () => {
  for (let n = 3; n <= 6; n++) {
    const s = table(n, { pile: ['S9'], turn: 0 });
    for (let seat = 0; seat < n; seat++) {
      assert.equal(E.canGiveUp(s, seat), false, n + ' Spieler');
      assert.equal(E.viewFor(s, seat).canGiveUp, false);
      rejectAs(s, seat, GIVEUP, 'cannot-giveup', n + ' aktive Spieler, Sitz ' + seat);
    }
    // n Spieler am Tisch, aber einer bzw. alle bis auf drei sind fertig: immer noch mehr als zwei mit Karten
    const seats = {}, fin = [];
    for (let i = 3; i < n; i++) { seats[i] = {}; fin.push(i); }
    const s3 = table(n, { pile: ['S9'], turn: 0, seats, finished: fin });
    assert.equal(E.activeCount(s3), 3);
    for (let seat = 0; seat < n; seat++) rejectAs(s3, seat, GIVEUP, 'cannot-giveup', 'drei aktive von ' + n);
    // … und sobald nur noch zwei Karten haben, geht es – für genau diese beiden
    seats[2] = {}; fin.push(2);
    const s2 = table(n, { pile: ['S9'], turn: 0, seats, finished: fin });
    assert.deepEqual(Array.from({ length: n }, (_, i) => E.canGiveUp(s2, i)), Array.from({ length: n }, (_, i) => i < 2));
    for (let seat = 2; seat < n; seat++) rejectAs(s2, seat, GIVEUP, 'cannot-giveup');
    const c = clone(s2);
    assert.equal(accept(c, 1, GIVEUP).place, n - 1);
    assert.equal(c.loser, 1);
    assert.deepEqual(c.finished, fin.concat([0]));
  }
  // Tauschphase – auch zu zweit, auch wenn einer schon bereit ist
  const sw = swapTable(2, 0);
  for (const seat of [0, 1]) { rejectAs(sw, seat, GIVEUP, 'wrong-phase', 'Tauschphase'); assert.equal(E.canGiveUp(sw, seat), false); assert.equal(E.viewFor(sw, seat).canGiveUp, false); }
  accept(sw, 0, READY);
  for (const seat of [0, 1]) rejectAs(sw, seat, GIVEUP, 'wrong-phase', 'Tauschphase');
  accept(sw, 1, READY);
  for (const seat of [0, 1]) assert.equal(E.canGiveUp(sw, seat), true, 'ab dem ersten Zug');
  // nach dem regulären Ende, nach deadlock, nach dem Aufgeben
  const st = fixedStates();
  for (const name of ['over', 'dead', 'gaveUp']) {
    assert.equal(st[name].phase, 'over');
    for (let seat = 0; seat < st[name].players.length; seat++) { rejectAs(st[name], seat, GIVEUP, 'wrong-phase', name); assert.equal(E.canGiveUp(st[name], seat), false); }
  }
  assert.equal(st.over.gaveUp, null); assert.equal(st.dead.gaveUp, null);
  assert.equal(E.viewFor(st.over, 0).gaveUp, null);
  // unbekannte Sitze; Zusatzfelder ändern nicht, WER aufgibt
  const two = table(2, { pile: ['S9'], turn: 0 });
  for (const bad of [-1, 2, 99, 0.5, NaN, '0', null, undefined, {}, [1]]) rejectAs(two, bad, GIVEUP, 'bad-seat', 'Sitz ' + safe(bad));
  const x = clone(two);
  assert.equal(E.applyAction(x, 0, { t: 'giveup', seat: 1, other: 0, loser: 1 }).ok, true);
  assert.equal(x.loser, 0, 'es gibt der Sitz auf, der die Aktion schickt');
  assert.equal(E.viewFor(x, 1).ev.seat, 0);
});

test('Aufgeben (K4): jederzeit – nach dem Aufnehmen eines riesigen Stapels, statt gegen einen Joker aufzunehmen, während der andere dran ist; sobald aus drei Spielern zwei werden', () => {
  // das Beispiel des Besitzers: riesigen Stapel aufgenommen, der Gegner hat noch eine Karte
  const big = ['S5', 'S6', 'H6', 'D6', 'S8', 'H8', 'S9', 'H9', 'S11', 'H11', 'S12', 'S13'];
  let s = mk({ players: [{ hand: ['H4'] }, { hand: ['H14'] }], pile: big, turn: 0 });
  mustPickup(s, 0);
  assert.equal(accept(s, 0, PICK).n, 12);
  assert.equal(s.freePlay, true); assert.equal(s.turn, 0);
  assert.equal(E.canGiveUp(s, 0), true); assert.equal(E.canGiveUp(s, 1), true);
  let a = clone(s);
  let ev = accept(a, 0, GIVEUP, 'mitten im Pflichtzug');
  assert.equal(a.loser, 0); assert.equal(a.winner, 1); assert.equal(a.freePlay, false);
  assert.equal(a.players[0].hand.length, 13, 'die Karten bleiben, wo sie sind');
  assert.deepEqual(ev.fx, ['win', 'over']);
  a = clone(s);
  accept(a, 1, GIVEUP, 'auch der Führende darf – außerhalb seines Zugs, während der andere im Pflichtzug ist');
  assert.equal(a.loser, 1); assert.equal(a.winner, 0); assert.equal(a.freePlay, false);
  // statt gegen einen Joker aufzunehmen: der Joker bleibt einfach liegen (er wurde nicht aufgenommen, also auch nicht entfernt)
  s = mk({ players: [{ hand: ['JR', 'S4'] }, { hand: ['H5', 'H9'] }], pile: ['S8'], turn: 0 });
  accept(s, 0, play('JR'));
  mustPickup(s, 1);
  const b0 = s.burned.length;
  accept(s, 1, GIVEUP);
  assert.deepEqual(s.pile, ['S8', 'JR']); assert.equal(s.burned.length, b0);
  assert.deepEqual(s.players[1].hand, ['H5', 'H9']);
  assert.equal(s.loser, 1); assert.deepEqual(s.finished, [0]);
  // aus drei werden zwei: vorher verboten, danach für die beiden Verbliebenen erlaubt
  s = mk({ players: [{ hand: ['H9'] }, { hand: ['S4', 'S5'] }, { hand: ['D4', 'D5'] }], pile: ['S8'], turn: 0 });
  for (let seat = 0; seat < 3; seat++) rejectAs(s, seat, GIVEUP, 'cannot-giveup', 'noch drei im Spiel');
  assert.deepEqual(accept(s, 0, play('H9')).fx, ['win']);
  assert.deepEqual([0, 1, 2].map((i) => E.canGiveUp(s, i)), [false, true, true]);
  rejectAs(s, 0, GIVEUP, 'cannot-giveup', 'der Sieger ist fertig');
  assert.equal(s.turn, 1);
  ev = accept(s, 2, GIVEUP, 'Sitz 2 ist nicht am Zug');
  assert.deepEqual(normEv(ev), { t: 'giveup', seat: 2, other: 1, place: 2, fx: ['out', 'over'] });
  assert.deepEqual(s.finished, [0, 1]); assert.equal(s.loser, 2); assert.equal(s.winner, 0);
  // endet die Runde regulär, hat niemand aufgegeben
  s = mk({ players: [{ hand: ['H9'] }, { hand: ['S4', 'S5'] }], pile: ['S8'], turn: 0 });
  accept(s, 0, play('H9'));
  assert.equal(s.phase, 'over'); assert.equal(s.gaveUp, null); assert.equal(s.loser, 1);
  assert.equal(E.viewFor(s, 1).gaveUp, null);
  assertNothingGoes(s);
  // Bots geben nie auf – auch nicht in aussichtsloser Lage
  s = mk({ players: [{ hand: big.concat(['H4']) }, { hand: ['H14'] }], pile: [], turn: 0 });
  for (let i = 0; i < 6 && s.phase === 'play'; i++) {
    const act = E.botAction(s, s.turn);
    assert.ok(act && act.t !== 'giveup', 'Bot-Aktion ' + safe(act));
    assert.equal(E.botAction(s, 1 - s.turn), null, 'nur wer am Zug ist');
    accept(s, s.turn, act);
  }
});

/* ================================================================== Sicherheitsnetz gegen Endlosschleifen */

/* Spielt `choose(s)`-Züge, bis die Engine deadlock meldet oder `max` Züge vorbei sind. Prüft den Wiederholungszähler. */
function loopUntilDeadlock(s, choose, max) {
  const tr = makeTracker(), counts = [];
  for (let i = 0; i < max && s.phase === 'play'; i++) {
    const M = mirror(s), a = choose(s, i);
    refApply(M, s.turn, a);
    const ev = accept(s, s.turn, a);
    const c = M.phase === 'play' ? tr.note(M) : 0;
    counts.push(c);
    assert.equal(ev.repeat, c >= 2 ? c : undefined, 'ev.repeat nach Zug ' + (i + 1) + ' (eigene Zählung ' + c + ')');
    if (s.deadlock) assert.ok(c >= 3, 'deadlock erst beim dritten Auftreten derselben Stellung (war ' + c + ')');
    else {
      assert.equal(ev.deadlock, undefined);
      if (c >= 3) assert.equal(staticLock(M), false, 'statisch bewiesene Sackgasse muss bei der dritten Wiederholung SOFORT enden: ' + brief(s));
    }
  }
  return counts;
}
const firstMove = (s) => { const m = enumMoves(mirror(s))[0]; return m.t === 'play' ? { t: 'play', cards: [m.group[0]] } : m; };

test('Sicherheitsnetz: Joker-Pingpong gibt es nicht mehr – ein Joker wirkt einmal und ist dann weg (kein deadlock, die Partie endet regulär)', () => {
  // Früher ausweglos: einzelner Joker, sonst nur Tischkarten. Jetzt ist der Joker nach dem ersten Aufnehmen verbraucht.
  for (const j of ['JR', 'JB']) {
    let s = mk({ players: [{ hand: [j], down: ['S4'] }, { hand: [], down: ['H5', 'D6'] }], pile: [], turn: 0 });
    assert.equal(lockSearch(mirror(s), 100000, true).k, 'progress', 'eigene Suche: Fortschritt ist erreichbar');
    assert.deepEqual(accept(s, 0, play(j)).fx, ['joker']);
    assert.equal(s.turn, 1);
    const ev = accept(s, 1, PICK);
    assert.equal(ev.n, 0); assert.deepEqual(ev.gone, [j]); assert.equal(ev.repeat, undefined);
    assert.ok(s.burned.includes(j));
    assert.equal(s.turn, 1, 'wer "aufgenommen" hat, spielt selbst – hier blind auf den leeren Stapel');
    accept(s, 1, flip(0));
    assert.deepEqual(s.pile, ['H5']);
    assert.equal(accept(s, 0, flip(0)).t, 'flipfail', 'die 4 passt nicht auf die 5');
    accept(s, 0, play('S4'));
    assert.deepEqual(sorted(accept(s, 1, flip(1)).fx), ['over', 'win']);
    assert.equal(s.deadlock, false); assert.equal(s.winner, 1); assert.equal(s.loser, 0);
    for (const p of s.players) assert.ok(!p.hand.includes(j));
    // mit offenen Karten (je zwei bleiben liegen): auch hier kein Kreislauf
    s = mk({ players: [{ hand: [j], up: ['S4', 'S5'] }, { hand: [], up: ['H5', 'D6'] }], pile: [], turn: 0 });
    assert.equal(lockSearch(mirror(s), 100000, true).k, 'progress');
    const counts = loopUntilDeadlock(s, firstMove, 200);
    assert.equal(s.phase, 'over', 'endet regulär');
    assert.equal(s.deadlock, false);
    assert.ok(counts.every((c) => c <= 1), 'keine Stellung wiederholt sich');
    assert.ok(s.burned.includes(j));
    assert.notEqual(s.loser, null);
  }
  // beide Joker, sonst nur je zwei unpassende offene Karten: schwarz -> Konter -> aufnehmen -> beide weg
  const s = mk({ players: [{ hand: ['JB'], up: ['S4', 'S5'] }, { hand: ['JR'], up: ['H5', 'D6'] }], pile: [], turn: 0 });
  accept(s, 0, play('JB'));
  assert.deepEqual(accept(s, 1, play('JR')).fx, ['counter']);
  const pe = accept(s, 0, PICK);
  assert.equal(pe.n, 0); assert.deepEqual(pe.gone, ['JB', 'JR']);
  assert.equal(s.turn, 0); assert.equal(E.options(s, 0).zone, 'up');
  assert.deepEqual(sorted(s.burned.filter(isJ)), ['JB', 'JR']);
});

test('Sicherheitsnetz: nur hohe Karten kreisen, die Tischkarten sind nie spielbar – deadlock; ev.repeat zählt mit', () => {
  // König wandert hin und her; die offenen Karten (je zwei, alle niedriger) kommen nie dran
  let s = mk({ players: [{ hand: ['S13'], up: ['S5', 'S6'] }, { hand: [], up: ['H4', 'H5'] }], pile: [], turn: 0 });
  assert.equal(lockSearch(mirror(s), 100000, true).k, 'locked');
  let counts = loopUntilDeadlock(s, firstMove, 100);
  assert.equal(s.deadlock, true);
  assert.equal(counts[counts.length - 1], 3);
  assert.ok(counts.includes(2), 'beim zweiten Auftreten gab es ev.repeat = 2');
  // mit Wahlmöglichkeiten (Dame/König), aber ohne Ausweg: verschiedene Zugfolgen enden alle im deadlock
  for (let seed = 1; seed <= 25; seed++) {
    const rng = mulberry32(seed);
    s = mk({ players: [{ hand: ['S12', 'S13'], up: ['S4', 'S6'], down: ['C2'] }, { hand: [], up: ['H4', 'H5'], down: ['C3'] }, { hand: ['D14'], up: ['D4', 'D5'] }], pile: [], turn: 0 });
    assert.equal(lockSearch(mirror(s), 200000, true).k, 'locked');
    counts = loopUntilDeadlock(s, (x) => { const m = enumMoves(mirror(x)); return concretize(m[Math.floor(rng() * m.length)], rng); }, 3000);
    assert.equal(s.deadlock, true, 'seed ' + seed + ': nach ' + counts.length + ' Zügen');
    assert.equal(s.loser, null);
    assert.deepEqual(s.finished, []);
  }
});

test('Sicherheitsnetz: eine sich wiederholende Stellung MIT Ausweg beendet die Partie nicht (ev.repeat steigt, kein deadlock)', () => {
  const kingOnly = (x) => {            // stur: immer den König legen, wenn es geht
    const m = enumMoves(mirror(x));
    const k = m.find((y) => y.t === 'play' && rk(y.group[0]) === 13);
    return k ? { t: 'play', cards: [k.group[0]] } : firstMove(x);
  };
  // (a) Sitz 0 könnte die Dame statt des Königs legen – dann müsste Sitz 1 seine offene Dame spielen (= Fortschritt)
  let s = mk({ players: [{ hand: ['S13', 'S12'], up: ['S5', 'S6'] }, { hand: [], up: ['H4', 'H12'] }], pile: [], turn: 0 });
  assert.equal(lockSearch(mirror(s), 100000, true).k, 'progress');
  let counts = loopUntilDeadlock(s, kingOnly, 150);
  assert.equal(s.phase, 'play', 'läuft weiter');
  assert.equal(s.deadlock, false);
  assert.ok(Math.max(...counts) >= 25, 'die Stellung hat sich oft wiederholt (' + Math.max(...counts) + '-mal)');
  assert.ok(E.viewFor(s, 0).ev.repeat >= 2, 'die Sicht zeigt die Wiederholung an');
  // der Ausweg funktioniert danach noch
  while (!(s.turn === 0 && s.pile.length === 0 && s.players[0].hand.includes('S12'))) accept(s, s.turn, kingOnly(s));
  accept(s, 0, play('S12'));
  notForced(s, 1, 'die offene Dame passt');
  const ev = accept(s, 1, play('H12'));
  assert.equal(ev.from, 'up');
  assert.equal(ev.repeat, undefined, 'nach einem Fortschritt beginnt die Zählung neu');
  // (b) drei Spieler: Sitz 1 könnte die 9 statt des Königs legen, dann müsste Sitz 2 seinen offenen Buben spielen
  s = mk({ players: [{ hand: [], up: ['S4', 'S5'] }, { hand: ['H9', 'H13'], up: ['D4', 'D6'] }, { hand: [], up: ['C11', 'C5'] }], pile: [], turn: 1 });
  assert.equal(lockSearch(mirror(s), 100000, true).k, 'progress');
  counts = loopUntilDeadlock(s, kingOnly, 200);
  assert.equal(s.phase, 'play');
  assert.equal(s.deadlock, false);
  assert.ok(Math.max(...counts) >= 15, 'oft wiederholt (' + Math.max(...counts) + '-mal)');
  // jetzt der Ausweg: 9 legen -> Sitz 2 muss den Buben legen
  while (!(s.turn === 1 && s.players[1].hand.includes('H9') && legal('H9', topOf(s)))) accept(s, s.turn, kingOnly(s));
  accept(s, 1, play('H9'));
  notForced(s, 2, 'der offene Bube passt');
  const e2 = accept(s, 2, play('C11'));
  assert.equal(e2.from, 'up'); assert.equal(e2.repeat, undefined);
  // (c) eine 7 oder 10 neben dem König ist immer ein Ausweg (K2/K2b): sobald der König beim anderen liegt, ist die
  //     Sonderkarte die einzige Handkarte – sie passt immer, Aufnehmen ist also kein Zwang. Die 10 räumt ab; nach der 7
  //     passen dem anderen seine niedrigen offenen Karten.
  for (const special of ['C10', 'C7']) {
    s = mk({ players: [{ hand: ['S13', special], up: ['S5', 'S6'] }, { hand: [], up: ['H4', 'H5'] }], pile: [], turn: 0 });
    assert.equal(lockSearch(mirror(s), 100000, true).k, 'progress', special + ' ist ein Ausweg');
    accept(s, 0, play('S13')); accept(s, 1, PICK); accept(s, 1, play('S13'));
    assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: [special], canPickup: true, canFlip: false, forced: false }, special + ' passt auf den König');
    const ev = accept(s, 0, play(special));
    assert.equal(ev.repeat, undefined);
    if (special === 'C10') { assert.deepEqual(ev.fx, ['burn']); assert.ok(s.burned.includes('S13') && s.burned.includes('C10')); }
    else { notForced(s, 1, 'nach der 7 passen die offenen 4 und 5'); assert.equal(accept(s, 1, play('H4')).from, 'up'); }
    assert.equal(s.deadlock, false);
  }
});

test('Sicherheitsnetz: eigene vollständige Suche auf kleinen Stellungen – deadlock nur ohne erreichbaren Fortschritt, und jede Sackgasse wird gefunden', (t) => {
  // Zwei Arten von Stellungen:
  //  (A) bunt gemischt, mit allen Sonderkarten (Joker, 2, 3, 7, 10) – sie öffnen fast immer einen Ausweg;
  //  (B) auf Sackgassen angelegt: ein bis drei hohe Karten (8 bis Ass) kreisen, jeder Spieler hat zwei oder drei niedrige
  //      offene Karten (3 bis 6), die auf keine kreisende Karte passen. Freiwilliges Aufnehmen (K2c) ändert daran nichts:
  //      der Stapel ist nur direkt nach einem Aufnehmen leer, und dann legt der Aufnehmende aus der Hand.
  //      In etwa jeder dritten dieser Stellungen ist ein Ausweg versteckt (hohe offene Karte, nur EINE offene Karte,
  //      eine 2/7/10 oder ein Joker im Umlauf).
  const MIXED = ['JR', 'JB', 'S13', 'H13', 'S14', 'S12', 'S4', 'H4', 'S5', 'H5', 'S6', 'H6', 'S9', 'S10', 'S2', 'S3', 'S7', 'H9', 'S11'];
  const HIGH = ['S13', 'H13', 'S14', 'H14', 'S12', 'H12', 'S11', 'S9', 'H9', 'S8'];
  const LOW = ['S4', 'H4', 'D4', 'C4', 'S5', 'H5', 'D5', 'C5', 'S6', 'H6', 'D6', 'C6', 'S3', 'H3', 'D3'];
  const ESCAPE = ['S10', 'S7', 'S2', 'JR', 'JB'];
  const shuffled = (a, rng) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const x = a[i]; a[i] = a[j]; a[j] = x; } return a; };
  function mixedPosition(rng, n) {
    const deck = shuffled(MIXED, rng), players = [];
    for (let i = 0; i < n; i++) {
      const p = { hand: [], up: [], down: [] };
      const h = Math.floor(rng() * 3), u = rng() < 0.75 ? 2 + Math.floor(rng() * 2) : Math.floor(rng() * 2), d = Math.floor(rng() * 2);
      for (let k = 0; k < h; k++) p.hand.push(deck.pop());
      for (let k = 0; k < u; k++) p.up.push(deck.pop());
      for (let k = 0; k < d; k++) p.down.push(deck.pop());
      if (!p.hand.length && !p.up.length && !p.down.length) p.hand.push(deck.pop());
      players.push(p);
    }
    return { players, pile: rng() < 0.3 ? [deck.pop()] : [], turn: Math.floor(rng() * n) };
  }
  function lockPosition(rng, n) {
    const high = shuffled(HIGH, rng), low = shuffled(LOW, rng), players = [];
    for (let i = 0; i < n; i++) players.push({ hand: [], up: [low.pop(), low.pop()].concat(rng() < 0.3 ? [low.pop()] : []), down: rng() < 0.3 ? [low.pop()] : [] });
    const circ = 1 + Math.floor(rng() * (n === 2 ? 3 : 2));
    for (let k = 0; k < circ; k++) players[Math.floor(rng() * n)].hand.push(high.pop());
    const who = Math.floor(rng() * n), twist = rng();
    if (twist < 0.10) players[who].up[0] = high.pop();                        // eine hohe offene Karte: passt vielleicht irgendwann
    else if (twist < 0.20) players[who].up = players[who].up.slice(0, 1);     // nur eine offene Karte: die Sonderregel für die letzte bringt Bewegung
    else if (twist < 0.32) players[who].hand.push(ESCAPE[Math.floor(rng() * ESCAPE.length)]);
    const holders = players.map((p, i) => (p.hand.length ? i : -1)).filter((i) => i >= 0);
    return { players, pile: [], turn: rng() < 0.8 ? holders[Math.floor(rng() * holders.length)] : Math.floor(rng() * n) };
  }
  const st = { staticHits: 0, deadFree: 0, lockedFound: 0, positions: 0, actions: 0, deadlocks: 0, late: 0, maxLate: 0, repeatsWithEscape: 0, regular: 0, lockedAtStart: 0, maxRegion: 0 };
  for (let seed = 1; seed <= 700; seed++) {
    const rng = mulberry32(seed * 13 + 5);
    const n = rng() < 0.7 ? 2 : 3;
    const s = mk(seed % 2 ? lockPosition(rng, n) : mixedPosition(rng, n));
    st.positions++;
    const atStart = lockSearch(mirror(s), 50000, true).k;
    assert.notEqual(atStart, 'unknown', 'Suchraum zu groß (seed ' + seed + ')');
    if (atStart === 'locked') st.lockedAtStart++;
    const tr = makeTracker();
    let lockedSince = -1, region = 0, steps = 0;
    while (s.phase === 'play' && steps < 400) {
      const M = mirror(s);
      const moves = enumMoves(M);
      assert.ok(moves.length > 0, 'kein legaler Zug in ' + brief(s));
      const a = concretize(moves[Math.floor(rng() * moves.length)], rng);
      refApply(M, s.turn, a);
      const ev = accept(s, s.turn, a);           // prüft bei deadlock bereits: eigene Suche sagt "locked"
      steps++; st.actions++;
      if (M.phase !== 'play') break;
      const c = tr.note(M);
      assert.equal(ev.repeat, c >= 2 ? c : undefined, 'ev.repeat (seed ' + seed + ')');
      if (c >= 3 && staticLock(M)) {       // statischer Beweis: sofort, ohne Suche und ohne die 12 Züge Wartezeit
        assert.equal(s.deadlock, true, 'statisch bewiesene Sackgasse nicht sofort erkannt (seed ' + seed + ') ' + brief(s));
        assert.equal(c, 3, 'genau beim dritten Auftreten (seed ' + seed + ')');
        st.staticHits++;
      }
      if (s.deadlock) {
        assert.ok(c >= 3, 'deadlock vor dem dritten Auftreten (seed ' + seed + ')');
        assert.equal(s.freePlay, false, 'deadlock setzt freePlay zurück'); assert.equal(s.again, false, 'deadlock setzt again zurück');
        if (M.freePlay) st.deadFree++;
        st.deadlocks++;
        if (lockedSince >= 0) { st.late++; st.maxLate = Math.max(st.maxLate, steps - lockedSince); }
        break;
      }
      if (c >= 3) {
        const r = lockSearch(M, 50000, true);
        assert.notEqual(r.k, 'unknown', 'Suchraum zu groß (seed ' + seed + ')');
        if (r.k === 'locked') {
          // Dritte Wiederholung in einer Sackgasse und kein deadlock: nur zulässig, wenn die Engine ihre Suche
          // kurz zuvor (höchstens 12 Züge) mit "es geht noch weiter" beendet hat. Spätestens 12 Züge + einmal
          // durch die ganze Sackgasse (Schubfachprinzip: 2·Größe + 1) muss sie es merken.
          if (lockedSince < 0) { lockedSince = steps; region = r.size; st.maxRegion = Math.max(st.maxRegion, r.size); }
          assert.ok(steps - lockedSince <= 12 + 2 * region + 1, 'Sackgasse wird nicht erkannt: seit ' + (steps - lockedSince) + ' Zügen (Größe ' + region + ', seed ' + seed + ') ' + brief(s));
        } else st.repeatsWithEscape++;
      }
    }
    if (s.phase === 'over' && !s.deadlock) st.regular++;
    assert.ok(s.phase === 'over' || steps >= 400);
    // Fortschritt ist unumkehrbar: aus einer Sackgasse führt kein Zug heraus – wer ausweglos begann, endet nie regulär
    if (atStart === 'locked') { assert.ok(s.deadlock || steps >= 400, 'ausweglose Stellung endete ohne deadlock (seed ' + seed + ')'); if (s.deadlock) st.lockedFound++; }
    if (s.deadlock) { assert.equal(s.loser, null); assert.equal(s.gaveUp, null); assert.equal(s.turn, -1); assert.equal(E.viewFor(s, 0).deadlock, true); }
  }
  t.diagnostic('kleine Stellungen: ' + st.positions + ' (davon von Beginn an ausweglos: ' + st.lockedAtStart + '), Züge: ' + st.actions + ', regulär beendet: ' + st.regular +
    ', deadlock gemeldet und per eigener Suche bestätigt: ' + st.deadlocks + ', davon verzögert erkannt: ' + st.late + ' (max. ' + st.maxLate + ' Züge nach der 3. Wiederholung)' +
    ', 3. Wiederholung MIT Ausweg (zu Recht kein deadlock): ' + st.repeatsWithEscape + ', größte Sackgasse: ' + st.maxRegion + ' Stellungen' +
    '; davon statisch bewiesen (sofort): ' + st.staticHits + ', deadlock im Pflichtzug nach dem Aufnehmen (freePlay zurückgesetzt): ' + st.deadFree);
  t.diagnostic('von Beginn an ausweglos und innerhalb von 400 Zufallszügen als deadlock beendet: ' + st.lockedFound + ' von ' + st.lockedAtStart);
  assert.ok(st.deadlocks >= 40, 'die Stichprobe enthält genug Sackgassen (' + st.deadlocks + ')');
  assert.ok(st.lockedAtStart >= 100 && st.lockedFound >= st.lockedAtStart * 0.9, 'fast jede von Beginn an ausweglose Stellung wird auch im Zufallsspiel erkannt');
  assert.ok(st.repeatsWithEscape >= 5, 'und Wiederholungen mit Ausweg (' + st.repeatsWithEscape + ')');
});

/* Große Sackgassen. Seit freiwilliges Aufnehmen erlaubt ist (K2c), ist der Suchraum riesig – jeder Spieler kann in jeder
 * Stellung den Stapel nehmen. Schon bei drei Spielern mit je drei hohen Handkarten gibt jede Suche mit Stellungsgrenze auf.
 * Dafür gibt es den statischen Beweis (staticLock oben): Er gilt bei der dritten Wiederholung SOFORT, ohne Suche.
 * Hände [8,8,9] / [9,B,B] / [D,D,K], offen je [4,5], Stapel leer; stur "niedrigste passende Karte, sonst aufnehmen". */
const stubborn = (x) => { const M = mirror(x); return pickMove(M, enumMoves(M), { policy: 'smart', eps: 0 }, () => 1); };

test('Sicherheitsnetz: auch eine GROSSE Sackgasse wird erkannt (3 Spieler, neun hohe Karten kreisen über je zwei unspielbaren offenen Karten) – statischer Beweis, sofort bei der dritten Wiederholung', () => {
  const s = mk({
    players: [{ hand: ['S8', 'H8', 'S9'], up: ['S4', 'S5'] }, { hand: ['H9', 'S11', 'H11'], up: ['H4', 'H5'] }, { hand: ['S12', 'H12', 'S13'], up: ['D4', 'D5'] }],
    pile: [], turn: 0
  });
  assert.equal(staticLock(mirror(s)), true, 'eigener Beweis: von hier aus ist kein Fortschritt mehr erreichbar');
  assert.equal(lockSearch(mirror(s), 20000, false).k, 'unknown', 'eine Suche mit 20000 Stellungen (die Grenze der Engine) kann es nicht entscheiden – es ist wirklich der statische Beweis');
  for (let seat = 0; seat < 3; seat++) assert.equal(E.canGiveUp(s, seat), false, 'zu dritt kann auch niemand aufgeben');
  const tr = makeTracker();
  let steps = 0, c = 0;
  while (s.phase === 'play' && steps < 400) {          // stur: niedrigste passende Karte, sonst aufnehmen
    const M = mirror(s), a = stubborn(s);
    refApply(M, s.turn, a);
    const ev = accept(s, s.turn, a);
    steps++;
    c = tr.note(M);
    assert.equal(ev.repeat, c >= 2 ? c : undefined);
    assert.equal(staticLock(M), true, 'die Stellung bleibt ausweglos');
    assert.equal(s.deadlock, c >= 3, 'deadlock genau beim ersten dritten Auftreten einer Stellung (Zug ' + steps + ', Zählung ' + c + ')');
  }
  assert.equal(c, 3, 'nach ' + steps + ' Zügen');
  assert.equal(s.deadlock, true); assert.equal(s.ev.deadlock, true);
  assert.equal(s.phase, 'over'); assert.equal(s.loser, null); assert.equal(s.turn, -1);
  assert.equal(s.freePlay, false); assert.equal(s.again, false);
  assertNothingGoes(s);
});

/* Grundform für den statischen Beweis zu zweit: Sitz 0 hält K + drei Asse, Sitz 1 drei 8er; jeder hat zwei niedrige offene
 * Karten. Der König wandert im Kreis: 0 legt K – 1 nimmt auf – 1 legt K – 0 nimmt (freiwillig) auf – … (4 Züge je Runde,
 * die erste Stellung entsteht mit Zug 9 zum dritten Mal). */
function kingLoopBase(change) {
  const spec = { players: [{ hand: ['S13', 'S14', 'H14', 'D14'], up: ['S5', 'S6'] }, { hand: ['S8', 'H8', 'D8'], up: ['H4', 'H5'] }], pile: [], turn: 0 };
  if (change) change(spec);
  return mk(spec);
}
const kingLoop = (x) => { const k = x.players[x.turn].hand.find((c) => rk(c) === 13); return k && legal(k, topOf(x)) ? play(k) : PICK; };

test('Sicherheitsnetz, statischer Beweis: gilt er, endet die Runde genau beim dritten Auftreten (Zug 9) – freePlay ist danach zurückgesetzt', () => {
  let s = kingLoopBase();
  assert.equal(staticLock(mirror(s)), true);
  let counts = loopUntilDeadlock(s, kingLoop, 50);
  assert.deepEqual(counts, [1, 1, 1, 1, 2, 2, 2, 2, 3], 'vier Stellungen je Runde, deadlock mit Zug 9');
  assert.equal(s.deadlock, true); assert.equal(s.phase, 'over'); assert.equal(s.turn, -1); assert.equal(s.loser, null);
  assert.equal(s.ev.t, 'play'); assert.equal(s.ev.deadlock, true); assert.equal(s.ev.repeat, 3);
  assert.equal(s.freePlay, false); assert.equal(s.again, false);
  assertNothingGoes(s);
  // Die Stellung, die sich zuerst wiederholt, ist eine direkt nach dem Aufnehmen (Pflichtzug offen): freePlay wird zurückgesetzt
  s = mk({ players: [{ hand: [], up: ['S5', 'S6'] }, { hand: [], up: ['H4', 'H5'] }], pile: ['S13'], turn: 1 });
  counts = loopUntilDeadlock(s, kingLoop, 50);
  assert.equal(counts.length, 9); assert.equal(s.deadlock, true);
  assert.equal(s.ev.t, 'pickup', 'der letzte Zug war ein Aufnehmen');
  assert.equal(s.freePlay, false, 'deadlock setzt freePlay zurück'); assert.equal(s.again, false);
  for (let v = -1; v < 2; v++) { const view = E.viewFor(s, v); assert.equal(view.freePlay, false); assert.equal(view.again, false); assert.equal(view.deadlock, true); assert.equal(view.my, null); }
  assert.deepEqual(sorted(s.players[1].hand), ['S13'], 'die aufgenommene Karte bleibt auf der Hand');
});

test('Sicherheitsnetz, statischer Beweis: jede einzelne Bedingung zählt – fehlt eine, gibt es bei der dritten (und jeder weiteren) Wiederholung KEIN deadlock', () => {
  // Jede Abwandlung der Grundform öffnet wirklich einen Ausweg (eigene vollständige Suche); der König kreist trotzdem stur weiter.
  // (Die sechste Bedingung – "Spieler am Zug steht nicht mit leerer Hand vor leerem Stapel" – kann nach einem Zug ohne Joker im
  //  Umlauf nicht verletzt sein: leer ist der Stapel dann nur nach einem Aufnehmen, und das bringt Handkarten.)
  const variants = {
    'Nachziehstapel nicht leer': (sp) => { sp.stock = ['C6']; },
    'eine 10 im Umlauf (Hand)': (sp) => { sp.players[0].hand[3] = 'C10'; },
    'roter Joker im Umlauf (Hand)': (sp) => { sp.players[0].hand[3] = 'JR'; },
    'schwarzer Joker im Umlauf (Hand)': (sp) => { sp.players[1].hand[2] = 'JB'; },
    'ein Spieler hat nur EINE offene Karte': (sp) => { sp.players[1].up = ['H4']; },
    'der Spieler am Zug hat nur eine offene Karte': (sp) => { sp.players[0].up = [null, 'S6']; },
    'eine offene Karte passt auf eine kreisende Karte (Ass auf König)': (sp) => { sp.players[1].up = ['H4', 'C14']; },
    'eine offene Karte passt auf eine kreisende Karte (5 auf die kreisende 2)': (sp) => { sp.players[0].hand[3] = 'C2'; },
    'eine offene Sonderkarte (7) passt immer': (sp) => { sp.players[0].up = ['S5', 'C7']; }
  };
  for (const name of Object.keys(variants)) {
    const s = kingLoopBase(variants[name]);
    assert.equal(staticLock(mirror(s)), false, name + ': eigener statischer Beweis gilt nicht');
    assert.equal(lockSearch(mirror(s), 300000, true).k, 'progress', name + ': es gibt wirklich einen Ausweg');
    const counts = loopUntilDeadlock(s, kingLoop, 60);
    assert.equal(counts.length, 60, name);
    assert.equal(s.phase, 'play', name + ': läuft weiter'); assert.equal(s.deadlock, false, name);
    assert.ok(Math.max(...counts) >= 14, name + ': die Stellung hat sich oft wiederholt (' + Math.max(...counts) + '-mal)');
    assert.equal(staticLock(mirror(s)), false);
  }
});

test('Sicherheitsnetz, statischer Beweis: gilt VOR der Wartezeit der Suche – auch wenn die Suche eben erst "es geht noch weiter" gesagt hat (12 Züge Pause), endet die Runde sofort', () => {
  // Sitz 1 beginnt mit dem König; Sitz 0 hält zwei Asse und eine 10 (Ausweg). Die Stellung "Sitz 0 am Zug, König oben" entsteht
  // mit Zug 9 zum dritten Mal: kein statischer Beweis (10 im Umlauf), die Suche findet den Ausweg -> kein deadlock, die Suche
  // pausiert jetzt 12 Züge. Zug 10: Sitz 0 legt die 10 – König und 10 sind weg, es kreisen nur noch Asse und 8er (statisch
  // ausweglos). Danach wandert die Pik-8 im Kreis; ihre erste Stellung entsteht mit Zug 19 zum dritten Mal – mitten in der Pause.
  const s = mk({ players: [{ hand: ['S14', 'H14', 'C10'], up: ['S5', 'S6'] }, { hand: ['S13', 'S8', 'H8', 'D8'], up: ['H4', 'H5'] }], pile: [], turn: 1 });
  assert.equal(lockSearch(mirror(s), 300000, true).k, 'progress');
  let counts = loopUntilDeadlock(s, kingLoop, 9);
  assert.deepEqual(counts, [1, 1, 1, 1, 2, 2, 2, 2, 3]);
  assert.equal(s.deadlock, false, 'dritte Wiederholung MIT Ausweg: kein deadlock'); assert.equal(s.ev.repeat, 3);
  assert.equal(s.turn, 0); assert.deepEqual(s.pile, ['S13']);
  const ev = accept(s, 0, play('C10'));
  assert.deepEqual(ev.fx, ['burn']); assert.equal(ev.repeat, undefined, 'Fortschritt: die Zählung beginnt neu');
  assert.equal(staticLock(mirror(s)), true, 'jetzt gilt der statische Beweis');
  const eightLoop = (x) => (x.pile.length ? PICK : play('S8'));
  counts = loopUntilDeadlock(s, eightLoop, 50);
  assert.deepEqual(counts, [1, 1, 1, 1, 2, 2, 2, 2, 3], 'deadlock neun Züge nach der 10 – also zehn Züge nach der letzten Suche, innerhalb ihrer Pause von 12 Zügen');
  assert.equal(s.deadlock, true); assert.equal(s.phase, 'over'); assert.equal(s.loser, null);
  assert.equal(s.freePlay, false); assert.equal(s.again, false);
});

test('Sicherheitsnetz: Sackgasse OHNE statischen Beweis (eine 3 kreist) – die Suche entscheidet; endet die Runde im Zusatzzug nach der 3, ist again zurückgesetzt', () => {
  // 3 und König wandern hin und her: 3 legen (nochmal) – König legen – der andere nimmt beides auf – … Auf die 3 würden die
  // offenen Karten passen (deshalb kein statischer Beweis), aber wer die 3 legt, hält noch den König und spielt aus der Hand.
  const s = mk({ players: [{ hand: [], up: ['S5', 'S6'] }, { hand: ['H3', 'H13'], up: ['H4', 'H5'] }], pile: [], turn: 1, freePlay: true });
  assert.equal(staticLock(mirror(s)), false, 'kein statischer Beweis: auf die 3 passt jede offene Karte');
  assert.equal(lockSearch(mirror(s), 100000, true).k, 'locked', 'eigene vollständige Suche: ausweglos');
  const counts = loopUntilDeadlock(s, firstMove, 100);
  assert.equal(counts.length, 13, 'sechs Züge je Runde; die erste Stellung (Zusatzzug nach der 3) entsteht mit Zug 13 zum dritten Mal');
  assert.equal(s.deadlock, true);
  assert.equal(s.ev.t, 'play'); assert.equal(rk(s.ev.cards[0]), 3);
  assert.deepEqual(sorted(s.ev.fx), ['again'], 'der letzte Zug war eine 3 mit Zusatzzug');
  assert.equal(s.ev.deadlock, true);
  assert.equal(s.again, false, 'deadlock setzt again zurück'); assert.equal(s.freePlay, false);
  assert.equal(s.turn, -1); assert.equal(s.loser, null);
  for (let v = -1; v < 2; v++) { const view = E.viewFor(s, v); assert.equal(view.again, false); assert.equal(view.freePlay, false); assert.equal(view.my, null); assert.equal(view.canGiveUp, false); }
  assertNothingGoes(s);
});

/* ================================================================== Zufallspartien gegen das Referenzmodell */

const SPECIAL_VALUE = (c) => { const r = rk(c); return r === 2 ? 20 : r === 10 ? 21 : r === 'JB' ? 22 : r === 'JR' ? 23 : r; };
/* Strategien für die Zufallspartien:
 *  'uniform' – jeder legale Zug gleich wahrscheinlich (auch freiwilliges Aufnehmen): erreicht exotische Stellungen mit riesigen
 *              Händen, wird aber praktisch nie fertig -> kleine Zuggrenze;
 *  'shed'    – zufälliger legaler Zug, der Karten loswird; aufgenommen wird nur, wenn es sein muss, oder freiwillig mit
 *              Wahrscheinlichkeit cfg.volP -> endet zuverlässig;
 *  'smart'   – niedrigste passende Karte (wie ein vernünftiger Spieler), mit Wahrscheinlichkeit cfg.eps ein beliebiger Zug. */
function pickMove(M, moves, cfg, rng) {
  if (cfg.policy === 'shed') {
    const other = moves.filter((m) => m.t !== 'pickup');
    if (!other.length || (other.length < moves.length && rng() < cfg.volP)) return { t: 'pickup' };
    return concretize(other[Math.floor(rng() * other.length)], rng);
  }
  if (cfg.policy === 'uniform' || rng() < cfg.eps) return concretize(moves[Math.floor(rng() * moves.length)], rng);
  // "vernünftig": niedrigste passende Karte, normale Werte komplett, Sonderkarten einzeln; sonst aufdecken; sonst aufnehmen
  const plays = moves.filter((m) => m.t === 'play');
  if (plays.length) {
    let best = plays[0];
    for (const m of plays) if (SPECIAL_VALUE(m.group[0]) < SPECIAL_VALUE(best.group[0])) best = m;
    return { t: 'play', cards: SPECIAL_VALUE(best.group[0]) < 20 ? best.group.slice() : [best.group[0]] };
  }
  const flips = moves.filter((m) => m.t === 'flip');
  if (flips.length) return flips[Math.floor(rng() * flips.length)];
  return moves[0];
}
const GARBAGE_SMALL = [null, undefined, 7, 'pickup', [], {}, { t: 'x' }, { t: 'play' }, { t: 'play', cards: [null] }, { t: 'flip', slot: '0' },
  { t: 'flip', slot: 9 }, { t: 'play', cards: ['__proto__'] }, { t: '__proto__' }, { t: 'play', cards: {} }, { t: 'ready', swap: { hand: 'XX', up: 0 } }];
function badAttempt(M, rng) {
  const seat = M.turn, p = M.players[seat], n = M.players.length;
  const pickFrom = (arr) => arr[Math.floor(rng() * arr.length)];
  const others = [];
  M.players.forEach((q, i) => { if (i !== seat) others.push(...q.hand, ...q.up.filter(Boolean), ...q.down.filter(Boolean)); });
  switch (Math.floor(rng() * 12)) {
    case 0: return [(seat + 1 + Math.floor(rng() * (n - 1))) % n, concretize(pickFrom(enumMoves(M)), rng)];              // fremder Sitz
    case 1: return [seat, play(pickFrom(others.concat(M.stock, M.burned, M.pile, ['XX'])))];                              // fremde Karte
    case 2: { const z = zoneCards(p); return [seat, play(...z.slice(0, 1 + Math.floor(rng() * Math.min(z.length, 4))))]; } // evtl. gemischt
    case 3: return [seat, play(pickFrom(p.hand.concat(p.up.filter(Boolean), p.down.filter(Boolean))))];                   // evtl. falsche Zone
    case 4: return [seat, flip(Math.floor(rng() * 5) - 1)];
    case 5: return [seat, PICK];
    case 6: return [seat, READY];
    case 7: { const c = pickFrom(zoneCards(p).concat(['XX'])); return [seat, play(c, c)]; }
    case 8: return [Math.floor(rng() * (n + 2)) - 1, PICK];
    case 9: return [seat, play(...p.hand.slice(0, 2), ...p.up.filter(Boolean).slice(0, 2))];
    case 10: return [seat, { t: 'play', cards: pickFrom(zoneCards(p).concat(['XX'])) }];                                  // String statt Array
    default: return [seat, pickFrom(GARBAGE_SMALL)];
  }
}
const moveSig = (m) => (m.t === 'play' ? 'p' + rkKey(m.cards ? m.cards[0] : m.group[0]) : m.t === 'flip' ? 'f' + m.slot : 'pickup');

/* Unabhängige Prüfung eines BEENDETEN Spielstands (nur am Engine-Zustand und an viewFor, ohne Referenzmodell):
 * Rangfolge = Reihenfolge des Fertigwerdens; genau ein Verlierer – außer bei deadlock; Aufgeben: der andere steht am Ende. */
function checkOver(S, where) {
  const n = S.players.length, withCards = [];
  S.players.forEach((q, i) => { if (zoneOfP(q) !== null) withCards.push(i); });
  if (S.phase !== 'over' || S.turn !== -1) assert.fail('Ende: phase/turn ' + where);
  if (S.freePlay || S.again) assert.fail('Ende: freePlay/again noch gesetzt (auch nach deadlock und Aufgeben nicht) ' + where);
  if (E.viewFor(S, 0).freePlay !== false || E.viewFor(S, 0).again !== false) assert.fail('Ende: Sicht zeigt freePlay/again ' + where);
  if (new Set(S.finished).size !== S.finished.length) assert.fail('Ende: Sitz doppelt in finished ' + where);
  for (const f of S.finished) if (!(Number.isInteger(f) && f >= 0 && f < n)) assert.fail('Ende: ungültiger Sitz in finished ' + where);
  if (S.winner !== (S.finished.length ? S.finished[0] : null)) assert.fail('Ende: winner ist nicht der zuerst Fertige ' + where);
  if (S.deadlock) {
    if (S.loser !== null || S.gaveUp !== null || withCards.length < 2) assert.fail('deadlock: kein Verlierer, mindestens zwei haben noch Karten ' + where);
    for (const f of S.finished) if (withCards.includes(f)) assert.fail('deadlock: Fertiger mit Karten ' + where);
  } else if (S.gaveUp !== null) {
    if (S.loser !== S.gaveUp || withCards.length !== 2 || !withCards.includes(S.gaveUp)) assert.fail('Aufgeben: Verlierer = wer aufgab, genau zwei hatten noch Karten ' + where);
    const other = withCards.find((i) => i !== S.gaveUp);
    if (S.finished.length !== n - 1 || S.finished[n - 2] !== other || S.finished.includes(S.gaveUp)) assert.fail('Aufgeben: der andere bekommt den nächsten freien Platz ' + where);
  } else {
    if (withCards.length !== 1 || S.loser !== withCards[0] || S.finished.length !== n - 1 || S.finished.includes(S.loser)) assert.fail('reguläres Ende: genau einer hat noch Karten und ist der Verlierer ' + where);
  }
  const v = E.viewFor(S, 0);
  v.players.forEach((vp, i) => { if (vp.place !== S.finished.indexOf(i) + 1) assert.fail('Ende: Platz in der Sicht ' + where); });
  if (S.loser !== null && v.players[S.loser].place !== 0) assert.fail('Ende: der Verlierer hat einen Platz ' + where);
  for (let i = 0; i < n; i++) if (E.canGiveUp(S, i) || E.viewFor(S, i).canGiveUp || E.options(S, i) !== null) assert.fail('Ende: noch Aktionen möglich ' + where);
}

/* Spielt eine ganze Partie Zug für Zug gegen das Referenzmodell und prüft nach JEDER Aktion unabhängige Invarianten.
 * cfg: {n, seed, policy:'uniform'|'shed'|'smart'|'bot', eps, volP, bound, hostile, giveUpEnd (Wahrscheinlichkeit je Zug, dass einer der
 * letzten zwei wirklich aufgibt), startSeat, startBy, onState} */
function playGame(cfg, st) {
  const rng = mulberry32(cfg.seed), n = cfg.n;
  const S = newGame(n, cfg.startSeat === undefined ? { rng } : { rng, startSeat: cfg.startSeat, startBy: cfg.startBy });
  const M = mirror(S);
  if (S.startBy !== (cfg.startSeat === undefined ? 'random' : cfg.startBy === 'loser' ? 'loser' : 'set')) assert.fail('startBy ' + S.startBy);
  if (cfg.startSeat !== undefined && S.startSeat !== cfg.startSeat) assert.fail('startSeat');
  const where = () => 'n=' + n + ' ' + cfg.policy + ' seed=' + cfg.seed + ' seq=' + S.seq;
  assertConserved(S, where());
  if (cfg.onState) cfg.onState(S);

  // ---- Tauschphase in zufälliger Reihenfolge, mit Störversuchen
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const x = order[i]; order[i] = order[j]; order[j] = x; }
  for (const seat of order) {
    const p = M.players[seat];
    if (cfg.hostile && rng() < 0.3) {
      const bad = [PICK, flip(0), play(p.hand[0]), { t: 'ready', swap: { hand: M.players[(seat + 1) % n].hand[0], up: 0 } }, { t: 'ready', swap: { hand: M.stock[0] || 'XX', up: 1 } }][Math.floor(rng() * 5)];
      const before = snap(S);
      assert.equal(E.applyAction(S, seat, bad).ok, false, where());
      assert.equal(snap(S), before);
    }
    const bot = E.botAction(S, seat);
    assert.ok(refIsLegal(M, seat, bot), 'Bot-Tauschaktion legal ' + where());
    const a = cfg.policy === 'bot' ? bot : rng() < 0.4 ? READY : { t: 'ready', swap: { hand: p.hand[Math.floor(rng() * 3)], up: Math.floor(rng() * 3) } };
    const exp = refApply(M, seat, a);
    assert.equal(E.applyAction(S, seat, a).ok, true, where());
    assert.equal(canon(S), canon(M), 'Tauschphase ' + where());
    assert.deepEqual(normEv(S.ev), normEv(exp));
    if (S.phase === 'swap') assert.equal(E.botAction(S, seat), null, 'Bot ist schon bereit');
    if (cfg.onState) cfg.onState(S);
  }
  assert.equal(S.phase, 'play', where());
  assert.equal(S.turn, S.startSeat);

  // ---- Spielphase
  const tr = makeTracker();
  const burnedSeen = [], finishedSeen = [], playedJokers = new Set();
  let steps = 0, lockedSince = -1, lockSize = 0, lastOwnSearch = -100, stop = null;
  const res = { end: 'bound', steps: 0 };
  while (S.phase === 'play' && steps < cfg.bound && !stop) {
    const seat = M.turn, p = M.players[seat];
    const moves = enumMoves(M);
    // ---- Aufgeben (K4): canGiveUp für JEDEN Sitz; stichprobenweise wirklich versuchen (Annahme auf einer Kopie, Ablehnung am Original)
    const act2 = activeOf(M) === 2;
    for (let q = 0; q < n; q++) if (E.canGiveUp(S, q) !== (act2 && zoneOfP(M.players[q]) !== null)) assert.fail('canGiveUp Sitz ' + q + ' in ' + brief(S) + ' ' + where());
    if (rng() < (act2 ? 0.1 : 0.03)) {
      const q = Math.floor(rng() * n), can = refCanGiveUp(M, q);
      if (E.viewFor(S, q).canGiveUp !== can) assert.fail('view.canGiveUp Sitz ' + q + ' ' + where());
      if (can) {
        const C = clone(S), MC = mirror(C), expG = refApply(MC, q, GIVEUP), rG = E.applyAction(C, q, GIVEUP);
        if (!rG.ok) assert.fail('Aufgeben abgelehnt (Sitz ' + q + ', am Zug ' + seat + ') in ' + brief(S) + ' ' + where());
        if (canon(C) !== canon(MC) || JSON.stringify(normEv(C.ev)) !== JSON.stringify(normEv(expG))) assert.fail('Aufgeben weicht vom Referenzmodell ab ' + where());
        if (C.seq !== S.seq + 1) assert.fail('Aufgeben: seq ' + where());
        assertConserved(C, 'nach dem Aufgeben');
        checkOver(C, where());
        st.giveUpOk++;
      } else {
        const before = snap(S), rG = E.applyAction(S, q, GIVEUP);
        if (rG.ok !== false || rG.err !== 'cannot-giveup') assert.fail('Aufgeben trotz ' + activeOf(M) + ' aktiver Spieler angenommen (Sitz ' + q + ') ' + JSON.stringify(rG) + ' ' + where());
        if (snap(S) !== before) assert.fail('abgelehntes Aufgeben verändert den Zustand ' + where());
        st.giveUpNo++;
      }
    }
    if (act2 && cfg.giveUpEnd && rng() < cfg.giveUpEnd) {            // einer der beiden gibt wirklich auf – auch der, der nicht am Zug ist
      const q = rng() < 0.5 ? seat : refNext(M, seat);
      const expG = refApply(M, q, GIVEUP);
      if (!expG || !E.applyAction(S, q, GIVEUP).ok) assert.fail('Aufgeben abgelehnt ' + where());
      if (canon(S) !== canon(M) || JSON.stringify(normEv(S.ev)) !== JSON.stringify(normEv(expG))) assert.fail('Aufgeben weicht vom Referenzmodell ab ' + where());
      assertConserved(S, 'nach dem Aufgeben');
      steps++;
      if (cfg.onState) cfg.onState(S);
      break;
    }
    if (!moves.length) assert.fail('Spieler am Zug hat keinen legalen Zug: ' + brief(S) + ' ' + where());
    // options()/legalActions() der Engine gegen die eigene Aufzählung
    const o = E.options(S, seat);
    if (o.zone !== zoneOfP(p)) assert.fail('options.zone ' + where());
    const mine = []; for (const m of moves) if (m.t === 'play') mine.push(...m.group);
    if (sorted(o.playable).join() !== mine.sort().join()) assert.fail('options.playable ' + o.playable + ' statt ' + mine + ' in ' + brief(S) + ' ' + where());
    if (o.canPickup !== moves.some((m) => m.t === 'pickup')) assert.fail('options.canPickup in ' + brief(S) + ' ' + where());
    if (o.canFlip !== moves.some((m) => m.t === 'flip')) assert.fail('options.canFlip in ' + brief(S) + ' ' + where());
    // K2c/K2d: aufnehmen geht genau dann, wenn etwas im Stapel liegt und es nicht der Zusatzzug nach der eigenen 3 ist;
    // forced = es ist der einzige Zug
    const hadOther = moves.some((m) => m.t !== 'pickup');
    if (o.canPickup !== (S.pile.length > 0 && !S.again)) assert.fail('canPickup bei ' + S.pile.length + ' Stapelkarten, again ' + S.again + ' ' + where());
    if (S.again) {
      // Zusatzzug: es liegt die eigene 3 oben, darauf passt alles – es gibt immer einen Legezug bzw. eine Karte zum Aufdecken, nie Zwang
      if (rk(topOf(S)) !== 3 || !hadOther || o.forced || S.freePlay || activeOf(M) !== 2) assert.fail('Zusatzzug nach der 3: ' + brief(S) + ' ' + where());
      const before = snap(S), rP = E.applyAction(S, seat, PICK);
      if (rP.ok !== false || rP.err !== 'cannot-pickup' || snap(S) !== before) assert.fail('Aufnehmen im Zusatzzug nicht sauber abgelehnt ' + JSON.stringify(rP) + ' ' + where());
      st.againTurns++;
    }
    if (o.forced !== (o.canPickup && !hadOther)) assert.fail('options.forced in ' + brief(S) + ' ' + where());
    if (o.forced) st.forcedTurns++;
    const la = E.legalActions(S), expSig = [];
    for (const m of moves) { if (m.t === 'play') for (let k = 1; k <= m.group.length; k++) expSig.push(moveSig(m) + 'x' + k); else expSig.push(moveSig(m)); }
    const gotSig = la.map((a) => (a.t === 'play' ? moveSig(a) + 'x' + a.cards.length : moveSig(a)));
    { const uniq = Array.from(new Set(expSig)); expSig.length = 0; expSig.push(...uniq); }   // gleiche offene Karten: ein Eintrag je Wert
    if (expSig.sort().join() !== gotSig.sort().join()) assert.fail('legalActions ' + gotSig + ' statt ' + expSig + ' in ' + brief(S) + ' ' + where());
    for (const a of la) if (!refIsLegal(M, seat, a)) assert.fail('legalActions enthält unzulässigen Zug ' + JSON.stringify(a) + ' ' + where());
    // Bot liefert in jedem erreichbaren Zustand eine legale Aktion – und nur für den Spieler am Zug
    const bot = E.botAction(S, seat);
    if (!refIsLegal(M, seat, bot)) assert.fail('Bot-Aktion unzulässig: ' + JSON.stringify(bot) + ' in ' + brief(S) + ' ' + where());
    if (bot.t === 'giveup') assert.fail('Bots geben nie auf ' + where());
    if (E.botAction(S, (seat + 1) % n) !== null) assert.fail('Bot handelt für einen Sitz, der nicht dran ist ' + where());
    if (M.freePlay) {
      // Pflichtzug nach dem Aufnehmen (erzwungen oder freiwillig): leerer Stapel, kein zweites Aufnehmen; gespielt wird aus der
      // Hand. Nur wer gegen einen ALLEIN liegenden Joker "aufgenommen" hat (nichts bekommen) und keine Handkarten hat, spielt
      // von seinen Tischkarten weiter.
      if (M.pile.length !== 0 || moves.some((m) => m.t === 'pickup')) assert.fail('Pflichtzug: Stapel nicht leer oder Aufnehmen möglich ' + where());
      if (p.hand.length > 0) { if (!moves.every((m) => m.t === 'play') || zoneOfP(p) !== 'hand') assert.fail('Pflichtzug: nur Handkarten ' + where()); }
      else if (!(S.ev.t === 'pickup' && S.ev.n === 0 && !S.ev.upCard && S.ev.joker === true && S.ev.gone.length > 0)) assert.fail('Pflichtzug mit leerer Hand ohne Joker-Aufnahme ' + where());
      else st.emptyFree++;
    }

    // Störversuch: unzulässig oder kaputt
    let a = null;
    if (cfg.hostile && rng() < cfg.hostile) {
      const [bs, ba] = badAttempt(M, rng);
      if (refIsLegal(M, bs, ba)) a = ba;                 // zufällig doch legal: als normalen Zug ausführen
      else {
        const before = snap(S);
        let r;
        try { r = E.applyAction(S, bs, ba); } catch (e) { assert.fail('applyAction wirft bei ' + safe(ba) + ' (Sitz ' + bs + '): ' + e.message + ' ' + where()); }
        if (r.ok !== false) assert.fail('unzulässige Aktion angenommen: ' + safe(ba) + ' (Sitz ' + bs + ') in ' + brief(M) + ' ' + where());
        if (snap(S) !== before) assert.fail('Zustand nach abgelehnter Aktion verändert ' + where());
        st.bad++;
      }
    }
    if (!a) a = cfg.policy === 'bot' ? bot : pickMove(M, moves, cfg, rng);
    const stockBefore = M.stock.length, handBefore = p.hand.length, seqBefore = S.seq;
    const pileBefore = M.pile.slice(), topBefore = topOf(M), handJokersBefore = p.hand.filter(isJ).length;
    const zoneBefore = zoneOfP(p), upBefore = p.up.filter(Boolean);
    const exp = refApply(M, seat, a);
    if (!exp) assert.fail('eigener Zug laut Referenzmodell unzulässig: ' + JSON.stringify(a));
    const r = E.applyAction(S, seat, a);
    if (!r.ok) assert.fail('legale Aktion abgelehnt: ' + JSON.stringify(a) + ' ' + JSON.stringify(r) + ' in ' + brief(S) + ' ' + where());
    if (S.seq !== seqBefore + 1 || S.ev.seq !== S.seq) assert.fail('seq ' + where());
    steps++;
    st.ev[exp.t] = (st.ev[exp.t] || 0) + 1;
    if (exp.fx) for (const f of exp.fx) st.fx[f] = (st.fx[f] || 0) + 1;
    if (exp.upCard) st.upCard++;
    if (exp.t === 'play') st.from[exp.from] = (st.from[exp.from] || 0) + 1;
    if (exp.t === 'play' && exp.cards.length > 1) st.multi++;
    if (exp.t === 'play' && topBefore && !isJ(topBefore)) {
      if (rk(exp.cards[0]) === 7 && rk(topBefore) > 7) st.sevenHigh++;           // K2b: 7 auf eine höhere Karte
      if (rk(exp.cards[0]) === 10 && rk(topBefore) > 10) st.tenHigh++;           // K2: 10 auf B/D/K/A
    }

    // Wiederholungen / Sicherheitsnetz
    let c = 0;
    if (M.phase === 'play') {
      c = tr.note(M);
      if (S.ev.repeat !== (c >= 2 ? c : undefined)) assert.fail('ev.repeat ' + S.ev.repeat + ', eigene Zählung ' + c + ' ' + where());
      if (c >= 2) st.repeats++;
    } else if (S.ev.repeat !== undefined) assert.fail('ev.repeat nach Spielende ' + where());
    if (S.deadlock) {
      if (M.phase !== 'play') assert.fail('deadlock in einer regulär beendeten Partie ' + where());
      if (c < 3) assert.fail('deadlock vor dem dritten Auftreten derselben Stellung (' + c + ') ' + where());
      const own = classify(M, staticLock(M) ? 20000 : 150000);
      if (own.k !== 'locked') assert.fail('Engine meldet deadlock, aber die eigene Suche sagt "' + own.k + '": ' + brief(M) + ' ' + where());
      const kind = own.stat ? (own.big ? 'statisch (Suchraum zu groß)' : 'statisch + Suche') : 'nur Suche';
      st.deadlock[kind] = (st.deadlock[kind] || 0) + 1;
      if (own.stat && c !== 3) assert.fail('statisch bewiesene Sackgasse erst beim ' + c + '. Auftreten erkannt ' + where());
      if (lockedSince >= 0) st.lateBy.push(steps - lockedSince);
      M.phase = 'over'; M.turn = -1; M.deadlock = true; M.freePlay = false; M.again = false;
      if (S.ev.deadlock !== true) assert.fail('ev.deadlock fehlt ' + where());
    } else {
      if (S.ev.deadlock !== undefined) assert.fail('ev.deadlock ohne deadlock ' + where());
      // Statischer Beweis (auch für Sackgassen, deren Suchraum zu groß ist): bei der dritten Wiederholung SOFORT – ohne Suche, ohne Wartezeit.
      if (c >= 3 && staticLock(M)) assert.fail('statisch bewiesene Sackgasse bei der ' + c + '. Wiederholung nicht erkannt: ' + brief(S) + ' ' + where());
      if (c >= 3 && lockedSince < 0 && steps - lastOwnSearch >= 25) {     // hätte die Engine hier schon abbrechen müssen?
        lastOwnSearch = steps;
        const own = classify(M, 4000);
        if (own.k === 'locked') { lockedSince = steps; lockSize = own.size; }
      }
      if (lockedSince >= 0) {
        // Sackgasse ohne statischen Beweis (eigene Suche vollständig): die Engine darf nach einem "es geht noch weiter" ihrer
        // Suche höchstens 12 Züge aussetzen und muss es dann bei der nächsten dritten Wiederholung merken (Schubfachprinzip).
        if (steps - lockedSince > 12 + 2 * lockSize + 1) assert.fail('Sackgasse (' + lockSize + ' Stellungen) wird nicht erkannt: ' + brief(S) + ' ' + where());
      } else if (c >= (cfg.loopStop || 8)) stop = 'loop';             // dieselbe Stellung zum 8. Mal: Strategie dreht sich im Kreis
    }

    // Zustand und Ereignis gegen das Referenzmodell
    const cs = canon(S), cm = canon(M);
    if (cs !== cm) assert.fail('Zustand weicht vom Referenzmodell ab nach ' + JSON.stringify(a) + ' ' + where() + '\n  Engine:   ' + cs + '\n  Referenz: ' + cm);
    if (JSON.stringify(normEv(S.ev)) !== JSON.stringify(normEv(exp))) assert.fail('Ereignis weicht ab ' + where() + '\n  Engine:   ' + JSON.stringify(S.ev) + '\n  Referenz: ' + JSON.stringify(exp));

    // ---- Invarianten direkt am Engine-Zustand (unabhängig vom Referenzmodell)
    const cards = allCardsOf(S);
    if (cards.length !== 54 || new Set(cards).size !== 54) assert.fail('Karten nicht erhalten (' + cards.length + ') ' + where());
    for (let i = 0; i < burnedSeen.length; i++) if (S.burned[i] !== burnedSeen[i]) assert.fail('vernichtete Karte kam zurück ' + where());
    for (let i = burnedSeen.length; i < S.burned.length; i++) burnedSeen.push(S.burned[i]);
    // K1: ein GESPIELTER Joker liegt auf dem Stapel oder ist aus dem Spiel – nie wieder auf einer Hand, auf dem Tisch oder im Nachziehstapel
    const ev = S.ev;
    if (ev.t === 'play' && isJ(ev.cards[0])) playedJokers.add(ev.cards[0]);
    for (const j of playedJokers) {
      if (!S.pile.includes(j) && !S.burned.includes(j)) assert.fail('gespielter Joker ' + j + ' ist wieder im Umlauf ' + where());
      const ix = S.pile.indexOf(j), last = S.pile.length - 1;                    // auf einem Joker liegt höchstens der rote Konter
      if (ix >= 0 && !(ix === last || (j === 'JB' && ix === last - 1 && S.pile[last] === 'JR'))) assert.fail('auf einem Joker liegt eine andere Karte ' + where());
    }
    if (ev.t === 'pickup' || ev.t === 'flipfail') {
      const goneExp = pileBefore.filter(isJ), q = S.players[ev.seat];
      if (JSON.stringify(ev.gone) !== JSON.stringify(goneExp)) assert.fail('gone ' + JSON.stringify(ev.gone) + ' statt ' + JSON.stringify(goneExp) + ' ' + where());
      for (const j of goneExp) if (!S.burned.includes(j) || q.hand.includes(j)) assert.fail('Joker ' + j + ' nach dem Aufnehmen nicht aus dem Spiel ' + where());
      if (ev.n !== pileBefore.length - goneExp.length + (ev.t === 'flipfail' ? 1 : 0)) assert.fail('n zählt die aufgenommenen Karten ohne Joker ' + where());
      if (ev.t === 'pickup' && ev.joker !== isJ(topBefore)) assert.fail('pickup.joker ' + where());
      if (ev.t === 'pickup') {
        // K2c: vol = es hätte einen anderen Zug gegeben. Die letzte offene Karte kommt genau dann mit, wenn sie nicht gepasst hätte
        // (Tabelle ERLAUBT_AUF, nicht das Referenzmodell).
        if (ev.vol !== hadOther) assert.fail('pickup.vol ' + ev.vol + ' in ' + brief(M) + ' ' + where());
        const lastUp = zoneBefore === 'up' && upBefore.length === 1 ? upBefore[0] : null;
        const expUp = lastUp && !tableSays(lastUp, topBefore) ? lastUp : undefined;
        if (ev.upCard !== expUp) assert.fail('letzte offene Karte: upCard ' + ev.upCard + ' statt ' + expUp + ' ' + where());
        if (expUp ? q.up.some(Boolean) || !q.hand.includes(expUp) : JSON.stringify(q.up.filter(Boolean)) !== JSON.stringify(zoneBefore === 'up' ? upBefore : q.up.filter(Boolean))) assert.fail('offene Karten nach dem Aufnehmen ' + where());
        if (ev.vol) { st.vol++; st.volZone[zoneBefore]++; if (lastUp) st.volLastUp++; if (isJ(topBefore)) st.volJoker++; } else st.forcedPickups++;
      } else if (ev.vol !== undefined) assert.fail('vol nur bei pickup ' + where());
      if (ev.t === 'flipfail' && isJ(ev.card)) assert.fail('ein aufgedeckter Joker scheitert nie ' + where());
      // Joker auf der Hand des Aufnehmenden: höchstens seine eigenen, nie gespielten (plus ein Joker als mitgenommene letzte offene Karte)
      const own = handJokersBefore + (ev.upCard && isJ(ev.upCard) ? 1 : 0);
      if (q.hand.filter(isJ).length !== own) assert.fail('Joker durch Aufnehmen auf die Hand gekommen ' + where());
      if (S.pile.length !== 0) assert.fail('Stapel nach dem Aufnehmen nicht leer ' + where());
      st.jokerGone += goneExp.length;
      if (ev.t === 'pickup' && ev.n === 0) { st.zeroPickup++; if (!(goneExp.length && pileBefore.length === goneExp.length)) assert.fail('n = 0 nur gegen allein liegende Joker ' + where()); }
    }
    // Rangfolge: finished wächst nur am Ende; ein Platz im Ereignis ist genau der neue letzte Eintrag
    for (let i = 0; i < finishedSeen.length; i++) if (S.finished[i] !== finishedSeen[i]) assert.fail('Rangfolge nachträglich geändert ' + where());
    if (S.finished.length > finishedSeen.length + 1) assert.fail('zwei Spieler in einem Zug fertig ' + where());
    if (S.finished.length > finishedSeen.length) {
      if (ev.place !== S.finished.length || S.finished[ev.place - 1] !== ev.seat) assert.fail('ev.place passt nicht zur Rangfolge ' + where());
      if (!ev.fx.includes(ev.place === 1 ? 'win' : 'out')) assert.fail('win/out ' + where());
      finishedSeen.push(ev.seat);
    } else if (ev.place !== undefined) assert.fail('ev.place ohne Fertigwerden ' + where());
    if (S.winner !== (S.finished.length ? S.finished[0] : null)) assert.fail('winner ' + where());
    if (S.dir !== 1 && S.dir !== -1) assert.fail('Richtung ' + S.dir);
    // Nachziehen: genau auf 3, nie darüber, nie bei >= 3; solange der Stapel Karten hat, hält jeder mindestens 3
    if (exp.t === 'play') {
      const after = handBefore - (exp.from === 'hand' ? exp.cards.length : 0);
      if (exp.drew !== Math.max(0, Math.min(3 - after, stockBefore))) assert.fail('nachgezogen ' + exp.drew + ' ' + where());
    }
    if (S.stock.length) for (const q of S.players) if (q.hand.length < 3) assert.fail('Nachziehstapel nicht leer, aber Hand < 3 ' + where());
    if (S.stock.length > stockBefore) assert.fail('Nachziehstapel gewachsen');
    for (const f of S.finished) {
      const q = S.players[f];
      if (q.hand.length || q.up.some(Boolean) || q.down.some(Boolean)) assert.fail('fertiger Spieler hat wieder Karten ' + where());
      if (S.turn === f) assert.fail('fertiger Spieler ist am Zug ' + where());
    }
    if (S.phase === 'play') {
      if (!(S.turn >= 0 && S.turn < n) || E.zoneOf(S.players[S.turn]) === null) assert.fail('Spieler am Zug hat keine Karten ' + where());
      if (S.ev.t === 'pickup' || S.ev.t === 'flipfail') { if (!(S.turn === S.ev.seat && S.freePlay && S.pile.length === 0)) assert.fail('nach dem Aufnehmen: derselbe Spieler, leerer Stapel, Pflichtzug ' + where()); }
      else if (S.freePlay) assert.fail('freePlay ohne Aufnehmen ' + where());
      // K2d: again genau nach einem Legezug mit Effekt 'again' (3 bei genau zwei aktiven Spielern, Leger nicht fertig) – derselbe ist dran
      const ag = S.ev.t === 'play' && S.ev.fx.includes('again');
      if (!!S.again !== ag || typeof S.again !== 'boolean') assert.fail('again ' + S.again + ' nach ' + JSON.stringify(S.ev) + ' ' + where());
      if (ag && !(rk(S.ev.cards[0]) === 3 && S.turn === S.ev.seat && E.activeCount(S) === 2 && !S.ev.fx.includes('reverse'))) assert.fail('Effekt again ohne 3 zu zweit ' + where());
      if (S.ev.t === 'play' && rk(S.ev.cards[0]) === 3 && !ag && !S.ev.fx.includes('reverse') && S.ev.place === undefined) assert.fail('3 ohne Wirkung ' + where());
      if (E.viewFor(S, S.turn).again !== ag || E.viewFor(S, -1).again !== ag) assert.fail('view.again ' + where());
      if (E.activeCount(S) < 2) assert.fail('Partie läuft mit weniger als zwei Spielern weiter');
      if (S.loser !== null || S.gaveUp !== null || S.deadlock) assert.fail('Verlierer/Aufgeben/deadlock im laufenden Spiel ' + where());
    } else if (S.gaveUp !== null) assert.fail('gaveUp ohne Aufgeben ' + where());
    if (cfg.onState) cfg.onState(S);
  }
  if (S.phase === 'over') checkOver(S, where());
  res.steps = steps;
  res.end = S.phase !== 'over' ? (stop || 'bound') : S.deadlock ? 'deadlock' : S.gaveUp !== null ? 'giveup' : 'regular';
  if (S.phase !== 'over') {
    // Partie endete nicht: steckt sie in einer unerkannten Sackgasse, oder gäbe es einen Ausweg?
    res.lock = classify(M, 20000).k;
    res.state = brief(S);
    if (lockedSince >= 0) assert.fail('Sackgasse bis zum Abbruch nicht erkannt: ' + res.state + ' ' + where());
  } else if (lockedSince >= 0 && res.end !== 'deadlock') assert.fail('eigene Suche hielt die Stellung für ausweglos, die Partie endete aber regulär ' + where());
  res.S = S;
  return res;
}
const newStats = () => ({ againTurns: 0, vol: 0, volZone: { hand: 0, up: 0, down: 0 }, volLastUp: 0, volJoker: 0, forcedPickups: 0, forcedTurns: 0, bad: 0, ev: {}, fx: {}, from: {}, upCard: 0, multi: 0, repeats: 0, deadlock: {}, lateBy: [], emptyFree: 0, jokerGone: 0, zeroPickup: 0, giveUpOk: 0, giveUpNo: 0, sevenHigh: 0, tenHigh: 0 });
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };

test('Zufallspartien: 2400 Partien (2–6 Spieler) mit zufälligen legalen und unzulässigen Aktionen – jeder Zug gegen das Referenzmodell, Invarianten nach jeder Aktion', (t) => {
  const st = newStats(), GAMES = 480;
  const per = {}, ends = {};
  let games = 0, actions = 0;
  const undetected = [];
  withRandom(4711, () => {
    for (let n = 2; n <= 6; n++) {
      // je Spielerzahl: jede vierte Partie endet evtl. durch Aufgeben (K4); jede zweite hat einen vorgegebenen Startsitz
      per[n] = { smart: [], smartEnd: {}, shed: [], shedEnd: {}, uniform: [], uniformEnd: {}, lock: {} };
      for (let g = 0; g < GAMES; g++) {
        const kind = g % 8;                 // 5/8 "vernünftig" mit unterschiedlich viel Zufall, 1/8 zufällig-abwerfend, 2/8 rein zufällig
        // jede vierte Partie: einer der letzten beiden gibt irgendwann auf (K4); jede zweite mit vorgegebenem Startsitz,
        // davon die Hälfte als "Verlierer der Vorrunde beginnt" (K3)
        const giveUpEnd = g % 4 === 3 ? 0.04 : 0;
        const cfg = kind < 5
          ? { n, seed: n * 100000 + g, policy: 'smart', eps: [0.05, 0.15, 0.3, 0.5, 0.7][kind], bound: kind === 4 ? 700 : 2500, hostile: 0.1, giveUpEnd, startSeat: g % 2 ? g % n : undefined, startBy: g % 4 === 1 ? 'loser' : undefined }
          : kind === 5 ? { n, seed: n * 100000 + g, policy: 'shed', volP: 0.1, bound: 2500, hostile: 0.1, giveUpEnd: g % 16 === 13 ? 0.04 : 0, startSeat: g % n, startBy: 'loser' }
            : { n, seed: n * 100000 + g, policy: 'uniform', eps: 1, bound: kind === 6 ? 250 : 100, hostile: 0.1, giveUpEnd };
        const r = playGame(cfg, st);
        games++; actions += r.steps;
        const key = cfg.policy;
        per[n][key].push(r.steps);
        per[n][key + 'End'][r.end] = (per[n][key + 'End'][r.end] || 0) + 1;
        ends[r.end] = (ends[r.end] || 0) + 1;
        if (r.end === 'giveup' && !cfg.giveUpEnd) assert.fail('Partie endet durch Aufgeben, obwohl niemand aufgegeben hat');
        if (r.end === 'bound') {
          per[n].lock[r.lock] = (per[n].lock[r.lock] || 0) + 1;
          if (r.lock === 'locked') undetected.push('n=' + n + ' ' + cfg.policy + ' seed=' + cfg.seed + ' ' + r.state);
          if ((cfg.policy === 'shed' || (cfg.policy === 'smart' && cfg.eps <= 0.3)) && r.lock !== 'locked') assert.fail('Partie mit abwerfender Strategie (' + cfg.policy + ') endet nicht nach ' + cfg.bound + ' Zügen: n=' + n + ' seed=' + cfg.seed + ' ' + r.state);
        }
      }
    }
  });
  t.diagnostic('Partien: ' + games + ', Aktionen: ' + actions + ', abgelehnte Störversuche: ' + st.bad);
  for (let n = 2; n <= 6; n++) {
    const p = per[n];
    t.diagnostic(n + ' Spieler – vernünftig+Zufall: ' + p.smart.length + ' Partien, Median ' + median(p.smart) + ' Züge, max ' + Math.max(...p.smart) + ', Ende ' + JSON.stringify(p.smartEnd) +
      ' | zufällig-abwerfend: ' + p.shed.length + ' Partien, Median ' + median(p.shed) + ' Züge, max ' + Math.max(...p.shed) + ', Ende ' + JSON.stringify(p.shedEnd) +
      ' | rein zufällig (auf 100/250 Züge begrenzt): ' + p.uniform.length + ' Partien, Ende ' + JSON.stringify(p.uniformEnd) + ', an der Grenze laut eigener Suche: ' + JSON.stringify(p.lock));
  }
  t.diagnostic('Ereignisse: ' + JSON.stringify(st.ev) + ', Effekte: ' + JSON.stringify(st.fx) + ', Züge aus: ' + JSON.stringify(st.from) + ', Mehrfach-Züge: ' + st.multi + ', letzte offene Karte mit aufgenommen: ' + st.upCard);
  t.diagnostic('Wiederholte Stellungen: ' + st.repeats + '; deadlock gemeldet: ' + JSON.stringify(st.deadlock) + ' (Ergebnis der eigenen Suche); verzögert erkannt: ' + st.lateBy.length +
    (st.lateBy.length ? ' (max. ' + Math.max(...st.lateBy) + ' Züge nach der eigenen Feststellung)' : '') + '; an der Zuggrenze unerkannte Sackgassen: ' + undetected.length);
  if (undetected.length) t.diagnostic('Beispiel unerkannte Sackgasse: ' + undetected[0]);
  assert.equal(games, 5 * GAMES);
  assert.ok(st.bad > 10000, 'viele Störversuche');
  // die Stichprobe hat alle Regelteile wirklich berührt
  for (const k of ['play', 'pickup', 'flipfail']) assert.ok(st.ev[k] > 500, 'Ereignis ' + k + ': ' + st.ev[k]);
  for (const k of ['burn', 'reverse', 'again', 'joker', 'win', 'out', 'over']) assert.ok(st.fx[k] > 500, 'Effekt ' + k + ': ' + st.fx[k]);
  assert.ok(st.fx.counter > 20, 'Konter (rot auf schwarz): ' + st.fx.counter);
  for (const k of ['hand', 'up', 'down']) assert.ok(st.from[k] > 500, 'Züge aus ' + k + ': ' + st.from[k]);
  assert.ok(st.upCard > 50 && st.multi > 500);
  t.diagnostic('Ende aller Partien: ' + JSON.stringify(ends) + '; verbrauchte Joker: ' + st.jokerGone + ', "Aufnehmen" gegen allein liegenden Joker (n = 0): ' + st.zeroPickup + ', davon ohne Handkarte weitergespielt: ' + st.emptyFree +
    '; 7 auf höhere Karte: ' + st.sevenHigh + ', 10 auf B/D/K/A: ' + st.tenHigh + '; Aufgeben geprüft: ' + st.giveUpOk + ' angenommen (auf Kopie), ' + st.giveUpNo + ' zu Recht abgelehnt');
  t.diagnostic('Aufnehmen: ' + st.forcedPickups + ' erzwungen, ' + st.vol + ' freiwillig (K2c) – aus der Hand ' + st.volZone.hand + ', von den offenen Karten ' + st.volZone.up + ' (davon mit nur noch einer offenen Karte, die liegen blieb: ' + st.volLastUp +
    '), statt blind aufzudecken ' + st.volZone.down + ', statt den schwarzen Joker zu kontern bzw. dagegen aufzudecken ' + st.volJoker + '; Züge mit forced: ' + st.forcedTurns);
  assert.ok(st.forcedPickups > 5000 && st.volZone.hand > 5000 && st.volZone.up > 200 && st.volZone.down > 200 && st.volLastUp > 50 && st.volJoker > 3, 'K2c: freiwilliges Aufnehmen kommt in jeder Zone vor');
  t.diagnostic('Zusatzzüge nach der eigenen 3 (K2d, Aufnehmen jedes Mal versucht und abgelehnt): ' + st.againTurns);
  assert.ok(st.againTurns > 500, 'K2d: Zusatzzüge nach der 3 kommen vor: ' + st.againTurns);
  assert.ok(st.jokerGone > 1000 && st.zeroPickup > 50 && st.emptyFree > 5, 'Joker-Fälle kommen vor');
  assert.ok(st.sevenHigh > 1000 && st.tenHigh > 500, 'K2/K2b: 7 und 10 werden wirklich auf höhere Karten gelegt');
  assert.ok(st.giveUpOk > 1000 && st.giveUpNo > 1000 && ends.giveup > 100, 'K4: Aufgeben wird in beiden Richtungen geprüft');
  assert.ok(ends.regular > games * 0.45, 'rund die Hälfte aller Partien endet regulär (der Rest: Aufgeben, Zuggrenze der Zufallsstrategien): ' + ends.regular);
  assert.equal(undetected.length, 0, 'Partien, die an der Zuggrenze in einer unerkannten Sackgasse steckten');
});

/* ================================================================== Bot */

test('Bot: botAction ist immer legal; reine Bot-Partien (2–6 Spieler) enden alle – regulär oder durch erkannten deadlock', (t) => {
  const st = newStats();
  const lines = [], open = [];
  let games = 0;
  withRandom(99, () => {
    for (let n = 2; n <= 6; n++) {
      const lens = [], ends = {};
      for (let g = 0; g < 300; g++) {
        const r = playGame({ n, seed: 900000 + n * 1000 + g, policy: 'bot', eps: 0, bound: 6000, hostile: 0 }, st);
        games++;
        lens.push(r.steps);
        ends[r.end] = (ends[r.end] || 0) + 1;
        if (r.end === 'bound') open.push('n=' + n + ' seed=' + (900000 + n * 1000 + g) + ' eigene Suche: ' + r.lock + ' ' + r.state);
        if (r.end === 'regular') {
          assert.equal(r.S.finished.length, n - 1);
          assert.equal(r.S.players.filter((p) => zoneOfP(p) !== null).length, 1);
        }
      }
      lines.push(n + ' Spieler: Median ' + median(lens) + ' Züge, max ' + Math.max(...lens) + ', Ende ' + JSON.stringify(ends));
    }
  });
  t.diagnostic(games + ' Bot-Partien. ' + lines.join(' | '));
  t.diagnostic('deadlock in Bot-Partien (Ergebnis der eigenen Suche): ' + JSON.stringify(st.deadlock) + '; nicht beendete Partien: ' + open.length);
  for (const o of open.slice(0, 3)) t.diagnostic('nicht beendet: ' + o);
  assert.deepEqual(open, [], 'jede Bot-Partie endet innerhalb von 6000 Zügen');
  // Bot außerhalb seines Zuges / unbekannter Sitz
  const s = swapTable(2, 0);
  assert.equal(E.botAction(s, 0).t, 'ready');
  assert.equal(E.botAction(s, 5), null, 'unbekannter Sitz');
  assert.equal(E.botAction(s, -1), null);
  // Tausch: der Bot legt keine schwächere Karte offen aus und tauscht höchstens eine
  for (let seed = 1; seed <= 200; seed++) {
    const g = newGame(3, { rng: mulberry32(seed) });
    const before = clone(g.players[0]);
    const a = E.botAction(g, 0);
    assert.ok(refIsLegal(mirror(g), 0, a));
    E.applyAction(g, 0, a);
    const diff = g.players[0].up.filter((c, i) => c !== before.up[i]).length;
    assert.ok(diff <= 1, 'höchstens eine Karte getauscht');
    assert.deepEqual(sorted(g.players[0].hand.concat(g.players[0].up)), sorted(before.hand.concat(before.up)));
    assert.deepEqual(g.players[0].down, before.down);
  }
});

test('Startspieler: der Verlierer einer Runde beginnt die nächste (K3) – nach regulärem Ende und nach dem Aufgeben; ohne Verlierer (deadlock) wird wieder gelost', () => {
  const st = newStats();
  let regular = 0, gaveUp = 0;
  withRandom(77, () => {
    for (let n = 2; n <= 6; n++) for (let g = 0; g < 12; g++) {
      // Runde 1: Startspieler ausgelost; jede dritte Partie endet dadurch, dass einer der letzten beiden aufgibt
      const r1 = playGame({ n, seed: 5000 + n * 100 + g, policy: 'shed', volP: 0.05, bound: 5000, hostile: 0, giveUpEnd: g % 3 === 0 ? 0.25 : 0 }, st);
      const S1 = r1.S, label = 'n=' + n + ' g=' + g;
      assert.equal(S1.startBy, 'random', label);
      assert.ok(r1.end === 'regular' || r1.end === 'giveup', label + ': Runde 1 endet (' + r1.end + ')');
      const loser = S1.loser;
      assert.ok(Number.isInteger(loser) && !S1.finished.includes(loser) && zoneOfP(S1.players[loser]) !== null, label + ': der Verlierer hat noch Karten und keinen Platz');
      assert.deepEqual(sorted(S1.finished.concat([loser])), Array.from({ length: n }, (_, i) => i), label + ': alle anderen haben einen Platz');
      if (r1.end === 'giveup') { gaveUp++; assert.equal(S1.gaveUp, loser); } else { regular++; assert.equal(S1.gaveUp, null); assert.equal(E.activeCount(S1), 1, 'nur der Verlierer hält noch Karten'); }
      // Runde 2: der Verlierer beginnt. (playGame prüft startBy/startSeat und dass nach der Tauschphase genau dieser Sitz am Zug ist.)
      const r2 = playGame({ n, seed: 6000 + n * 100 + g, policy: 'shed', volP: 0.05, bound: 5000, hostile: 0, startSeat: loser, startBy: 'loser' }, st);
      assert.equal(r2.S.startBy, 'loser'); assert.equal(r2.S.startSeat, loser);
      assert.equal(E.viewFor(r2.S, 0).startBy, 'loser');
      assert.equal(r2.end, 'regular', label + ': Runde 2 endet regulär');
    }
  });
  assert.ok(regular >= 30 && gaveUp >= 10, 'beide Arten des Rundenendes kommen vor: ' + regular + ' regulär, ' + gaveUp + ' durch Aufgeben');
  // deadlock: es gibt keinen Verlierer -> die nächste Runde wird wieder ausgelost
  const dead = fixedStates().dead;
  assert.equal(dead.deadlock, true); assert.equal(dead.loser, null);
  const next = E.createGame(names(2), { rng: mulberry32(1), startSeat: dead.loser, startBy: 'loser' });
  assert.equal(next.startBy, 'random');
  assert.ok(next.startSeat === 0 || next.startSeat === 1);
});

/* ================================================================== viewFor: Geheimhaltung */

function sampleStates(count, seedBase) {
  const out = [], st = newStats();
  withRandom(seedBase, () => {
    for (let g = 0; out.length < count; g++) {
      const n = 2 + (g % 5);
      let k = 0;
      playGame({
        n, seed: seedBase + g * 17, policy: g % 3 === 0 ? 'uniform' : 'smart', eps: 0.3, bound: 500, hostile: 0, giveUpEnd: g % 4 === 1 ? 0.05 : 0,
        startSeat: g % 5 === 2 ? g % n : undefined, startBy: g % 10 === 2 ? 'loser' : undefined,
        onState: (S) => { k++; if (S.phase !== 'play' || k % 7 === 0 || S.ev.t === 'flipfail' || S.ev.upCard || S.ev.place || (S.ev.gone && S.ev.gone.length)) out.push(clone(S)); }
      }, st);
    }
  });
  return out;
}
const idsIn = (text) => text.match(/"(JB|JR|[SHDC]\d{1,2})"/g) || [];

test('viewFor: verrät nie fremde Handkarten, nie verdeckte Karten, nie Karten des Nachziehstapels – öffentlich sind nur Ablagestapel, offene Karten und offen gezeigte Ereigniskarten', () => {
  const states = sampleStates(2500, 4242);
  const seen = { flipfail: 0, upCard: 0, gone: 0, over: 0, swap: 0, checked: 0, stock: 0 };
  for (const s of states) {
    const n = s.players.length;
    if (s.phase === 'over') seen.over++;
    if (s.phase === 'swap') seen.swap++;
    if (s.stock.length) seen.stock++;
    for (let v = -1; v < n; v++) {
      const view = clone(E.viewFor(s, v));
      const ev = view.ev;
      // offen gezeigt: gelegte Karten (liegen danach auf dem Stapel oder sind durch die 10 weg), eine blind
      // aufgedeckte unpassende Karte, die mit aufgenommene letzte offene Karte
      const shown = new Set();
      if (ev.t === 'play') ev.cards.forEach((c) => shown.add(c));
      // eine blind aufgedeckte unpassende Karte sieht nur ihr Besitzer
      if (ev.t === 'flipfail') {
        if (v === ev.seat) { assert.equal(ev.card, s.ev.card); shown.add(ev.card); } else assert.equal(ev.card, null, 'fremde Blindkarte bleibt geheim');
        if (v === 0) seen.flipfail++;
      }
      if (ev.t === 'pickup' && ev.upCard) { shown.add(ev.upCard); if (v === 0) seen.upCard++; }
      if (ev.t === 'pickup' || ev.t === 'flipfail') {
        // verbrauchte Joker lagen offen auf dem Stapel und sind jetzt aus dem Spiel – sonst nennt das Ereignis keine Stapelkarte
        for (const c of ev.gone) { assert.ok(isJ(c) && s.burned.includes(c), 'gone nennt nur verbrauchte Joker'); shown.add(c); if (v === 0) seen.gone++; }
        const named = idsIn(JSON.stringify(ev)).map((q) => q.slice(1, -1));
        assert.deepEqual(sorted(named), sorted(ev.gone.concat(ev.t === 'flipfail' ? [ev.card].filter(Boolean) : ev.upCard ? [ev.upCard] : [])), 'das Aufnahme-Ereignis verrät nicht, WELCHE Karten auf die Hand kamen');
      }
      if (ev.t === 'giveup') assert.deepEqual(idsIn(JSON.stringify(ev)), [], 'Aufgeben nennt keine Karte');
      if (ev.t === 'deal' || ev.t === 'ready' || ev.t === 'start') assert.deepEqual(idsIn(JSON.stringify(ev)), [], 'Tausch-/Start-Ereignis nennt keine Karte');
      if (ev.t === 'play') for (const c of ev.cards) assert.ok(s.pile.includes(c) || s.burned.includes(c), 'gelegte Karte ist öffentlich');
      const pub = new Set(s.pile);
      s.players.forEach((p) => p.up.forEach((c) => { if (c) pub.add(c); }));
      if (v >= 0) s.players[v].hand.forEach((c) => pub.add(c));
      // (1) jede Kartenkennung in der Sicht ist öffentlich, die eigene Hand oder im Ereignis offen gezeigt
      const text = JSON.stringify(view);
      for (const q of idsIn(text)) { const id = q.slice(1, -1); if (!pub.has(id) && !shown.has(id)) assert.fail('Sicht von Sitz ' + v + ' enthält ' + id + ' (weder öffentlich noch eigene Hand): ' + text.slice(0, 500)); }
      // (2) außerhalb des Ereignisses steht keine einzige geheime Karte
      delete view.ev;
      const rest = JSON.stringify(view);
      const secret = [];
      s.players.forEach((p, i) => { if (i !== v) secret.push(...p.hand); secret.push(...p.down.filter(Boolean)); });
      secret.push(...s.stock);
      for (const id of secret) if (rest.includes('"' + id + '"')) assert.fail('Sicht von Sitz ' + v + ' enthält geheime Karte ' + id + ': ' + rest.slice(0, 500));
      // (3) verdeckte Karten und Nachziehstapel tauchen auch im Ereignis nie auf
      const evText = JSON.stringify(ev);
      for (const p of s.players) for (const id of p.down) if (id && evText.includes('"' + id + '"')) assert.fail('Ereignis nennt verdeckte Karte ' + id);
      for (const id of s.stock) if (evText.includes('"' + id + '"')) assert.fail('Ereignis nennt Karte aus dem Nachziehstapel ' + id);
      seen.checked++;
    }
  }
  assert.ok(seen.checked > 8000);
  assert.ok(seen.flipfail > 20 && seen.upCard > 20 && seen.gone > 20 && seen.over > 20 && seen.swap > 20 && seen.stock > 200, 'Stichprobe deckt alles ab: ' + JSON.stringify(seen));
});

test('viewFor: eigene Hand sichtbar, Zählwerte, Plätze, freePlay, again; "my" nur für den Spieler am Zug; öffentliche Angaben für alle gleich; alles Kopien', () => {
  const states = sampleStates(900, 99);
  let places = 0, free = 0, gaveUps = 0, forcedSeen = 0, agains = 0, startBys = new Set();
  for (const s of states) {
    const n = s.players.length, views = [];
    for (let v = 0; v < n; v++) {
      const view = E.viewFor(s, v);
      views.push(view);
      assert.equal(view.you, v);
      assert.equal(view.phase, s.phase);
      assert.equal(view.turn, s.turn);
      assert.equal(view.dir, s.dir);
      assert.equal(view.startSeat, s.startSeat);
      assert.equal(view.startBy, s.startBy);
      startBys.add(view.startBy);
      assert.equal(view.gaveUp, s.gaveUp, 'wer aufgegeben hat (sonst null)');
      assert.equal(view.canGiveUp, refCanGiveUp(mirror(s), v), 'canGiveUp für den Betrachter');
      assert.equal(view.canGiveUp, E.canGiveUp(s, v));
      assert.deepEqual(view.pile, s.pile);
      assert.equal(view.stock, s.stock.length, 'Nachziehstapel nur als Anzahl');
      assert.equal(view.burned, s.burned.length, 'entfernte Karten nur als Anzahl');
      assert.deepEqual(view.finished, s.finished);
      assert.equal(view.winner, s.finished.length ? s.finished[0] : null);
      assert.equal(view.loser, s.loser);
      assert.equal(view.deadlock, !!s.deadlock);
      assert.equal(view.freePlay, !!s.freePlay);
      if (view.freePlay) free++;
      assert.equal(view.again, !!s.again, 'again (Zusatzzug nach der eigenen 3) ist öffentlich');
      assert.equal(typeof view.again, 'boolean');
      if (view.again) { agains++; assert.equal(view.turn, view.ev.seat); assert.ok(view.ev.fx.includes('again')); }
      assert.equal(view.seq, s.seq);
      assert.equal(view.ev.seq, s.seq);
      assert.deepEqual(view.ev, s.ev.t === 'flipfail' && s.ev.seat !== v ? Object.assign({}, s.ev, { card: null }) : s.ev);
      assert.notEqual(view.ev, s.ev, 'ev ist eine Kopie');
      assert.equal(view.players.length, n);
      view.players.forEach((vp, i) => {
        const p = s.players[i];
        assert.equal(vp.name, p.name);
        assert.equal(vp.n, p.hand.length, 'Anzahl Handkarten');
        if (i === v) assert.deepEqual(vp.hand, p.hand, 'eigene Hand'); else assert.equal(vp.hand, null, 'fremde Hand verborgen');
        assert.deepEqual(vp.up, p.up, 'offene Karten sichtbar');
        assert.deepEqual(vp.down, p.down.map(Boolean), 'verdeckte Karten nur als ja/nein');
        assert.equal(vp.ready, p.ready);
        assert.equal(vp.zone, zoneOfP(p));
        assert.equal(vp.place, s.finished.indexOf(i) + 1);
        // wer einen Platz hat, hat keine Karten mehr – außer dem, der durch das Aufgeben des Gegners den letzten Platz bekam (K4)
        const byGiveUp = s.gaveUp !== null && i === s.finished[s.finished.length - 1];
        if (vp.place) { places++; if (byGiveUp) gaveUps++; else { assert.equal(vp.zone, null); assert.equal(vp.n, 0); } }
        else if (s.phase !== 'swap') assert.notEqual(vp.zone, null, 'ohne Platz hat man noch Karten');
      });
      if (s.phase === 'play' && s.turn === v) {
        assert.ok(view.my, 'my vorhanden, wenn am Zug');
        assert.deepEqual(view.my, E.options(s, v));
        const moves = enumMoves(mirror(s)), mine = [];
        for (const m of moves) if (m.t === 'play') mine.push(...m.group);
        assert.deepEqual(sorted(view.my.playable), sorted(mine));
        assert.equal(view.my.canPickup, s.pile.length > 0 && !s.again);
        assert.equal(view.my.forced, refForced(mirror(s), v), 'my.forced: Aufnehmen ist der einzige Zug');
        if (view.my.forced) forcedSeen++;
      } else assert.equal(view.my, null, 'my nur am Zug');
      const before = snap(s);
      view.pile.push('XX'); view.players[v].hand.push('XX'); view.players[0].up[0] = 'XX'; view.players[0].down[0] = 'XX';
      view.finished.push(9); view.ev.t = 'XX'; view.ev.seat = 99; if (view.ev.cards) view.ev.cards.push('XX'); if (view.ev.fx) view.ev.fx.push('XX');
      view.req.k = 'XX';
      if (view.my) view.my.playable.push('XX');
      assert.equal(snap(s), before, 'Sicht ist vom Spielstand entkoppelt');
    }
    for (const seat of [-1, n, 99]) {            // Zuschauer / unbekannter Sitz: gar keine Hand, keine Optionen
      const spec = E.viewFor(s, seat);
      spec.players.forEach((vp) => assert.equal(vp.hand, null));
      assert.equal(spec.my, null);
      assert.equal(spec.canGiveUp, false, 'Zuschauer können nicht aufgeben');
    }
    const fresh = [];
    for (let v = 0; v < n; v++) fresh.push(E.viewFor(s, v));
    const pub = (view) => JSON.stringify([view.phase, view.turn, view.dir, view.pile, view.stock, view.burned, view.finished, view.winner, view.loser, view.deadlock, view.freePlay, view.again, view.req, view.seq, Object.assign({}, view.ev, view.ev.t === 'flipfail' ? { card: null } : null), view.startSeat, view.startBy, view.gaveUp,
      view.players.map((p) => [p.name, p.bot, p.n, p.up, p.down, p.ready, p.zone, p.place])]);
    for (let v = 1; v < n; v++) assert.equal(pub(fresh[v]), pub(fresh[0]));
  }
  assert.ok(places > 50 && free > 50 && gaveUps > 5 && forcedSeen > 20 && agains > 5, 'Stichprobe enthält fertige Spieler, Pflichtzüge, Aufgeben, erzwungenes Aufnehmen und Zusatzzüge: ' + JSON.stringify({ places, free, gaveUps, forcedSeen, agains }));
  assert.deepEqual([...startBys].sort(), ['loser', 'random', 'set'], 'alle Arten der Startspieler-Bestimmung kommen vor');
});

test('viewFor: seq steigt pro angenommener Aktion um genau eins, bei abgelehnten gar nicht', () => {
  const rng = mulberry32(5);
  const s = newGame(4, { rng });
  assert.equal(E.viewFor(s, 0).seq, 1);
  let seq = 1;
  const step = (seat, a, expectOk) => {
    const r = E.applyAction(s, seat, a);
    assert.equal(r.ok, expectOk, JSON.stringify(a));
    if (expectOk) seq++;
    for (let v = 0; v < 4; v++) { const view = E.viewFor(s, v); assert.equal(view.seq, seq); assert.equal(view.ev.seq, seq); }
  };
  step(0, READY, true);
  step(0, READY, false);
  step(1, { t: 'ready', swap: { hand: 'nope', up: 0 } }, false);
  step(1, READY, true);
  step(2, READY, true);
  step(2, PICK, false);
  step(3, READY, true);
  let guard = 0;
  while (s.phase === 'play' && guard++ < 600) {
    const seat = s.turn, M = mirror(s);
    step((seat + 1) % 4, PICK, false);
    step(seat, { t: 'play', cards: ['XX'] }, false);
    step(seat, pickMove(M, enumMoves(M), { policy: 'smart', eps: 0.2 }, rng), true);
  }
  assert.ok(seq > 100);
});

/* ================================================================== options()/legalActions()/requirement() == applyAction */

function reqAllows(req, card) {
  switch (req.k) {
    case 'any': return true;
    case 'jokerR': return false;
    case 'jokerB': return card === 'JR';
    case 'seven': return isJ(card) || [2, 3, 4, 5, 6, 7, 10].includes(rk(card));
    case 'min': return isJ(card) || ALWAYS.includes(rk(card)) || rk(card) >= req.rank;           // K2b: 2, 7 und 10 gehen immer
    default: throw new Error('unbekannte Anforderung ' + JSON.stringify(req));
  }
}
const actSet = (list) => list.map((a) => (a.t === 'play' ? 'play:' + rkKey(a.cards[0]) + 'x' + a.cards.length : a.t === 'flip' ? 'flip:' + a.slot : 'pickup')).sort();
/* alle Legezüge aus `cards` auf `top`: je Wert 1..k Karten */
function expPlays(cards, top, single) {
  const by = new Map(), out = [];
  for (const c of cards) { if (!by.has(rk(c))) by.set(rk(c), []); by.get(rk(c)).push(c); }
  for (const g of by.values()) if (tableSays(g[0], top)) for (let k = 1; k <= (single ? 1 : g.length); k++) out.push(play(...g.slice(0, k)));
  return out;
}

test('options()/legalActions()/requirement()/canPlayOn stimmen mit applyAction überein – jede oberste Karte x jede Karte x jede Zone (inkl. canPickup, forced, vol)', () => {
  let combos = 0;
  for (const top of [null].concat(ALL)) {
    for (const cand of ALL) {
      if (cand === top) continue;
      const exp = tableSays(cand, top);
      const fill = ALL.find((c) => c !== cand && c !== top && rk(c) === 4);     // eine 4 als zweite Karte
      const fillOk = tableSays(fill, top);
      const other = ALL.find((c) => c !== cand && c !== top && c !== fill && rk(c) === 9);
      const pile = top ? [top] : [];
      const label = cand + ' auf ' + top;
      assert.equal(E.canPlayOn(cand, top), exp, 'canPlayOn ' + label);
      const pickExp = !!top;                               // K2c: aufnehmen geht immer, wenn etwas liegt
      const laExp = (zoneActs) => actSet(zoneActs.concat(pickExp ? [PICK] : []));
      /* nimmt (auf einer Kopie) auf und prüft vol sowie den Verbleib der Karten */
      const pickOn = (s, forced, what) => {
        if (!pickExp) { rejectAs(s, 0, PICK, 'cannot-pickup', what + ' aufnehmen bei leerem Stapel ' + label); return null; }
        const c2 = clone(s), ev = accept(c2, 0, PICK, what + ' aufnehmen ' + label);
        assert.equal(ev.vol, !forced, what + ': vol ' + label);
        assert.deepEqual(ev.gone, pile.filter(isJ));
        assert.equal(ev.n, pile.filter((c) => !isJ(c)).length);
        assert.equal(c2.turn, 0); assert.equal(c2.freePlay, true); assert.deepEqual(c2.pile, []);
        return { s: c2, ev };
      };

      // ---- Handzone
      let s = mk({ pile, players: [{ hand: [cand, fill], up: [], down: ['D13'].filter((c) => c !== cand && c !== top) }, { hand: [other] }] });
      let o = E.options(s, 0);
      let forced = pickExp && !(exp || fillOk);
      assert.deepEqual(o, { zone: 'hand', playable: [cand, fill].filter((c) => tableSays(c, top)), canPickup: pickExp, canFlip: false, forced }, 'options ' + label);
      assert.deepEqual(E.viewFor(s, 0).my, o);
      assert.equal(reqAllows(E.requirement(s), cand), exp, 'requirement ' + JSON.stringify(E.requirement(s)) + ' ' + label);
      assert.deepEqual(E.viewFor(s, 0).req, E.requirement(s));
      assert.deepEqual(actSet(E.legalActions(s)), laExp(expPlays([cand, fill], top)), 'legalActions ' + label);
      if (exp) accept(clone(s), 0, play(cand), label); else rejectAs(s, 0, play(cand), 'not-playable', label);
      let r = pickOn(s, forced, 'Hand:');
      if (r) assert.deepEqual(sorted(r.s.players[0].hand), sorted([cand, fill].concat(pile.filter((c) => !isJ(c)))), 'eigene Karten bleiben, der Stapel (ohne Joker) kommt dazu');
      rejectAs(s, 0, flip(0), 'not-blind', 'aufdecken in der Handzone');
      assert.equal(E.options(s, 1), null);

      // ---- offene Karten (zwei liegen)
      s = mk({ pile, players: [{ up: [cand, null, fill], down: ['D13'].filter((c) => c !== cand && c !== top) }, { hand: [other] }] });
      o = E.options(s, 0);
      assert.deepEqual(o, { zone: 'up', playable: [cand, fill].filter((c) => tableSays(c, top)), canPickup: pickExp, canFlip: false, forced }, 'offen: options ' + label);
      assert.deepEqual(actSet(E.legalActions(s)), laExp(expPlays([cand, fill], top, true)), 'offen: legalActions ' + label);
      if (exp) { const c2 = clone(s); accept(c2, 0, play(cand), 'offen: ' + label); assert.deepEqual(c2.players[0].up, [null, null, fill]); }
      else reject(s, 0, play(cand), 'offen: ' + label);
      r = pickOn(s, forced, 'offen:');
      if (r) { assert.deepEqual(r.s.players[0].up, [cand, null, fill], 'zwei offene Karten bleiben liegen'); assert.equal(r.ev.upCard, undefined); }

      // ---- letzte offene Karte: sie kommt genau dann mit auf die Hand, wenn sie NICHT gepasst hätte
      s = mk({ pile, players: [{ up: [null, cand, null], down: ['D13'].filter((c) => c !== cand && c !== top) }, { hand: [other] }] });
      o = E.options(s, 0);
      forced = pickExp && !exp;
      assert.deepEqual(o, { zone: 'up', playable: exp ? [cand] : [], canPickup: pickExp, canFlip: false, forced }, 'letzte offene: options ' + label);
      r = pickOn(s, forced, 'letzte offene:');
      if (r) {
        assert.equal(r.ev.upCard, exp ? undefined : cand, 'letzte offene: upCard ' + label);
        assert.equal(r.ev.slot, exp ? undefined : 1);
        assert.deepEqual(r.s.players[0].up, exp ? [null, cand, null] : [null, null, null]);
        assert.deepEqual(sorted(r.s.players[0].hand), sorted(pile.filter((c) => !isJ(c)).concat(exp ? [] : [cand])), 'letzte offene Karte kommt nur mit, wenn sie nicht passt (ein Joker vom Stapel nie)');
      }
      if (exp) accept(clone(s), 0, play(cand)); else reject(s, 0, play(cand));

      // ---- verdeckte Karten (blind): aufdecken außer gegen den roten Joker; aufnehmen, sobald etwas liegt
      s = mk({ pile, players: [{ down: [fill, cand] }, { hand: [other] }] });
      o = E.options(s, 0);
      forced = top === 'JR';
      assert.deepEqual(o, { zone: 'down', playable: [], canPickup: pickExp, canFlip: top !== 'JR', forced }, 'blind: options ' + label);
      assert.deepEqual(actSet(E.legalActions(s)), actSet((top !== 'JR' ? [flip(0), flip(1)] : []).concat(pickExp ? [PICK] : [])), 'blind: legalActions ' + label);
      if (top === 'JR') rejectAs(s, 0, flip(1), 'must-pickup', 'blind gegen roten Joker');
      else {
        const c2 = clone(s);
        const ev = accept(c2, 0, flip(1), 'blind: ' + label);
        if (exp) {
          assert.equal(ev.t, 'play');
          assert.deepEqual(c2.players[0].hand, [], 'blind passend: nichts auf der Hand');
          assert.ok(rk(cand) === 10 ? c2.burned.includes(cand) && c2.pile.length === 0 : topOf(c2) === cand);
        } else {
          assert.equal(ev.t, 'flipfail');
          assert.deepEqual(sorted(c2.players[0].hand), sorted(pile.filter((c) => !isJ(c)).concat([cand])), 'blind unpassend: Stapel (ohne Joker) + Karte auf der Hand');
          assert.deepEqual(ev.gone, pile.filter(isJ));
          assert.deepEqual(c2.pile, []);
          assert.equal(c2.turn, 0, 'derselbe Spieler bleibt dran');
        }
      }
      r = pickOn(s, forced, 'blind:');
      if (r) { assert.deepEqual(r.s.players[0].down, [fill, cand, null], 'keine verdeckte Karte verbraucht'); assert.deepEqual(r.s.players[0].hand, pile.filter((c) => !isJ(c))); }
      rejectAs(s, 0, play(cand), 'must-flip', 'verdeckte Karte gezielt legen');
      combos++;
    }
  }
  assert.equal(combos, 54 + 54 * 53);
});

test('options(): Mehrfach-Legen ist genau dann erlaubt, wenn die einzelne Karte erlaubt ist (alle Werte x alle obersten Karten, Hand und offen)', () => {
  const tops = [null, 'JB', 'JR'].concat([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((r) => 'S' + r));
  for (const top of tops) for (let r = 2; r <= 14; r++) {
    const group = ['H' + r, 'D' + r, 'C' + r];
    const exp = tableSays(group[0], top);
    for (let k = 2; k <= 3; k++) {
      const extra = [r === 9 ? 'S8' : 'S9'].filter((c) => c !== top), down = [r === 4 ? 'S5' : 'S4'].filter((c) => c !== top), opp = ['S12', 'S13'].filter((c) => c !== top);
      const a = play(...group.slice(0, k));
      let s = mk({ pile: top ? [top] : [], players: [{ hand: group.concat(extra), down }, { hand: opp }, { hand: ['C12', 'D12'].filter((c) => !group.includes(c)) }] });
      if (exp) accept(s, 0, a, k + 'x ' + r + ' auf ' + top); else reject(s, 0, a, k + 'x ' + r + ' auf ' + top);
      s = mk({ pile: top ? [top] : [], players: [{ up: group, down }, { hand: opp }, { hand: ['C12', 'D12'].filter((c) => !group.includes(c)) }] });
      rejectAs(s, 0, a, 'one-up', 'offen ' + k + 'x ' + r + ' auf ' + top);   // offene Karten gehen nie zu mehreren
    }
  }
  const s = table(3, { turn: 1 });
  assert.equal(E.options(s, 0), null, 'keine Optionen, wenn man nicht am Zug ist');
  assert.equal(E.options(s, 2), null);
  assert.ok(E.options(s, 1));
  assert.equal(E.options(s, 7), null);
});

/* ================================================================== Fehlerhafte / feindliche Eingaben */

function garbageActions(s) {
  const anyHand = (s.players[s.turn >= 0 ? s.turn : 0].hand[0]) || (s.players[0].up.find(Boolean)) || 'S5';
  const big = new Array(200000).fill(anyHand);
  const bigDistinct = []; for (let i = 0; i < 50000; i++) bigDistinct.push('K' + i);
  const sparse = new Array(1000000);
  const inherit = Object.create({ t: 'play', cards: ['XX'] });
  const nullProto = Object.create(null); nullProto.t = 'flip'; nullProto.slot = 7;
  return [
    null, undefined, 0, 1, -1, NaN, '', 'play', 'pickup', true, false, [], [[]], ['play'], {}, function () {}, Symbol('x'), 12n,
    { t: null }, { t: undefined }, { t: 0 }, { t: ['play'] }, { t: {} }, { t: 'PLAY' }, { t: 'play ' }, { t: '__proto__' },
    { t: 'constructor' }, { t: 'toString' }, { t: 'hasOwnProperty' }, { t: 'valueOf' }, { t: 'deal' }, { t: 'start' }, { t: 'setRule' }, { t: 'setStart' },
    { t: 'play' }, { t: 'play', cards: null }, { t: 'play', cards: undefined }, { t: 'play', cards: 0 }, { t: 'play', cards: '' },
    { t: 'play', cards: anyHand }, { t: 'play', cards: {} }, { t: 'play', cards: { 0: anyHand, length: 1 } }, { t: 'play', cards: [] },
    { t: 'play', cards: [null] }, { t: 'play', cards: [undefined] }, { t: 'play', cards: [0] }, { t: 'play', cards: [{}] },
    { t: 'play', cards: [[anyHand]] }, { t: 'play', cards: [anyHand, anyHand] }, { t: 'play', cards: [anyHand, null] },
    { t: 'play', cards: ['__proto__'] }, { t: 'play', cards: ['constructor'] }, { t: 'play', cards: ['length'] }, { t: 'play', cards: [''] },
    { t: 'play', cards: ['XX'] }, { t: 'play', cards: ['S99'] }, { t: 'play', cards: ['s5'] }, { t: 'play', cards: ['S05'] }, { t: 'play', cards: ['J'] },
    { t: 'play', cards: big }, { t: 'play', cards: bigDistinct }, { t: 'play', cards: sparse },
    { t: 'flip' }, { t: 'flip', slot: null }, { t: 'flip', slot: -1 }, { t: 'flip', slot: 3 }, { t: 'flip', slot: 0.5 },
    { t: 'flip', slot: '0' }, { t: 'flip', slot: '__proto__' }, { t: 'flip', slot: 'length' }, { t: 'flip', slot: [0] },
    { t: 'flip', slot: true }, { t: 'flip', slot: 1e9 }, { t: 'flip', slot: NaN }, { t: 'flip', slot: {} },
    { t: 'ready', swap: 5 }, { t: 'ready', swap: 'x' }, { t: 'ready', swap: true }, { t: 'ready', swap: [] }, { t: 'ready', swap: {} },
    { t: 'ready', swap: { hand: anyHand } }, { t: 'ready', swap: { up: 0 } }, { t: 'ready', swap: { hand: anyHand, up: 3 } },
    { t: 'ready', swap: { hand: anyHand, up: '0' } }, { t: 'ready', swap: { hand: anyHand, up: -1 } },
    { t: 'ready', swap: { hand: anyHand, up: '__proto__' } }, { t: 'ready', swap: { hand: anyHand, up: 'length' } },
    { t: 'ready', swap: { hand: '__proto__', up: 0 } }, { t: 'ready', swap: { hand: null, up: 0 } }, { t: 'ready', swap: { hand: [anyHand], up: 0 } },
    { t: 'ready', swap: { hand: 'XX', up: 0 } },
    { t: 'pickup', seat: 0 }, { t: 'pickup', cards: [anyHand] },
    JSON.parse('{"__proto__":{"t":"pickup"}}'), JSON.parse('{"t":"play","cards":["__proto__"],"__proto__":{"x":1}}'),
    JSON.parse('{"t":"flip","slot":0,"constructor":{"prototype":{"x":1}}}'),
    inherit, nullProto, new Date(), /x/, new Map([['t', 'pickup']])
  ];
}
function fixedStates() {
  const swap = swapTable(3, 1);
  const hand = table(3, { pile: ['S9'], turn: 1, seats: { 1: { hand: ['H11', 'H4'], up: ['D4', 'D5', 'D6'], down: ['C4', 'C5', 'C6'] } } });
  const handStuck = table(3, { pile: ['S9'], turn: 1, seats: { 1: { hand: ['H5', 'H4'], up: ['D4', 'D5', 'D6'], down: ['C4', 'C5', 'C6'] } } });
  const free = clone(handStuck); E.applyAction(free, 1, PICK);
  const up = table(3, { pile: ['S9'], turn: 1, seats: { 1: { up: ['D4', 'D11', 'D6'], down: ['C4', 'C5', 'C6'] } } });
  const upLast = table(3, { pile: ['S9'], turn: 1, seats: { 1: { up: [null, 'D4', null], down: ['C4', 'C5', 'C6'] } } });
  const down = table(3, { pile: ['S9'], turn: 1, seats: { 1: { down: ['C4', 'C5', 'C6'] } } });
  const downJR = table(3, { pile: ['S9', 'JR'], turn: 1, seats: { 1: { down: ['C4', 'C5', 'C6'] } } });
  const downJB = table(3, { pile: ['S9', 'JB'], turn: 1, seats: { 1: { down: ['C4', 'C5', 'C6'] } } });
  const empty = table(2, { pile: [], turn: 0, stock: ['C3', 'C7', 'C10'] });
  const over = table(2, { pile: ['S5'], turn: 0, seats: { 0: { hand: ['H9'] } } });
  E.applyAction(over, 0, play('H9'));
  assert.equal(over.phase, 'over');
  const dead = mk({ players: [{ hand: ['S13'], up: ['S5', 'S6'] }, { hand: [], up: ['H4', 'H5'] }], pile: [], turn: 0 });   // ein König kreist, die offenen Karten passen nie
  for (let i = 0; i < 40 && dead.phase === 'play'; i++) E.applyAction(dead, dead.turn, E.legalActions(dead)[0]);
  assert.equal(dead.deadlock, true); assert.equal(dead.freePlay, false); assert.equal(dead.again, false);
  const two = table(4, { pile: ['S9'], turn: 0, seats: { 1: {}, 2: {} }, finished: [2, 1] });          // nur noch zwei im Spiel: Aufgeben wäre möglich
  const gaveUp = clone(two); E.applyAction(gaveUp, 3, { t: 'giveup' });
  assert.equal(gaveUp.phase, 'over');
  const again = mk({ players: [{ hand: ['H3', 'D9', 'C12'], up: ['D4', 'D5', 'D6'] }, { hand: ['S9', 'S11'], up: ['C4', 'C5', 'C6'] }], pile: ['S2'], turn: 0 });
  E.applyAction(again, 0, play('H3'));                                                                 // Zusatzzug nach der eigenen 3: kein Aufnehmen
  assert.equal(again.again, true); assert.equal(again.turn, 0);
  return { swap, hand, handStuck, free, up, upLast, down, downJR, downJB, empty, over, dead, two, gaveUp, again };
}

test('Fehlercodes: jede Ablehnung nennt ihren Grund (err) und ändert nichts', () => {
  const sw = swapTable(3, 0);
  for (const a of [play('S4'), PICK, flip(0), GIVEUP, { t: 'x' }]) rejectAs(sw, 0, a, 'wrong-phase', 'Tauschphase');
  rejectAs(sw, 0, { t: 'ready', swap: { hand: 'XX', up: 0 } }, 'bad-swap');
  rejectAs(sw, 0, { t: 'ready', swap: { hand: 'S4', up: 3 } }, 'bad-swap');
  accept(sw, 0, READY);
  rejectAs(sw, 0, READY, 'already-ready');
  for (const bad of [3, -1, 1.5, '1', null]) rejectAs(sw, bad, READY, 'bad-seat', 'Sitz ' + safe(bad));
  for (const bad of [null, undefined, 'ready', 7, true]) rejectAs(sw, 1, bad, 'bad-action', 'Aktion ' + safe(bad));
  const s = mk({ players: [{ hand: ['H9', 'D9', 'H11', 'C4'], up: ['S12'], down: ['S13'] }, { hand: ['S4'] }, { down: ['D4'] }], pile: ['S8'], turn: 0 });
  rejectAs(s, 0, READY, 'wrong-phase', 'bereit im laufenden Spiel');
  rejectAs(s, 1, play('S4'), 'not-your-turn'); rejectAs(s, 1, PICK, 'not-your-turn'); rejectAs(s, 2, flip(0), 'not-your-turn');
  rejectAs(s, 0, { t: 'x' }, 'bad-action'); rejectAs(s, 0, {}, 'bad-action'); rejectAs(s, 0, [], 'bad-action');
  for (const a of [play(), { t: 'play' }, { t: 'play', cards: 'H9' }, play('H9', 'D9', 'H11', 'C4', 'S12', 'S2', 'S3', 'S4', 'S5')]) rejectAs(s, 0, a, 'no-cards');
  for (const a of [play('S12'), play('S13'), play('S4'), play('S8'), play('XX'), play('H9', 'H9'), play(null)]) rejectAs(s, 0, a, 'not-in-zone');
  rejectAs(s, 0, play('H9', 'H11'), 'mixed-ranks');
  rejectAs(s, 0, play('C4'), 'not-playable');
  rejectAs(s, 0, flip(0), 'not-blind');
  rejectAs(s, 0, GIVEUP, 'cannot-giveup');
  rejectAs(s, 9, PICK, 'bad-seat');
  const d = mk({ players: [{ down: ['D4', null, 'D5'] }, { hand: ['S4'] }], pile: ['S8', 'JR'], turn: 0 });
  rejectAs(d, 0, flip(0), 'must-pickup', 'blind gegen den roten Joker');
  rejectAs(d, 0, play('D4'), 'must-flip');
  const d2 = mk({ players: [{ down: ['D4', null, 'D5'] }, { hand: ['S4'] }], pile: ['S8'], turn: 0 });
  rejectAs(d2, 0, flip(1), 'bad-slot'); rejectAs(d2, 0, flip(3), 'bad-slot');
  const e = mk({ players: [{ hand: ['H9'] }, { hand: ['S4', 'S5'] }], pile: [], turn: 0 });
  rejectAs(e, 0, PICK, 'cannot-pickup', 'leerer Stapel');
  const ag = mk({ players: [{ hand: ['H3', 'D9', 'C12'] }, { hand: ['S4', 'S5'] }], pile: ['S2'], turn: 0 });
  accept(ag, 0, play('H3'));
  rejectAs(ag, 0, PICK, 'cannot-pickup', 'der zweite Fall: Zusatzzug nach der eigenen 3 (K2d)');
  accept(e, 0, play('H9'));
  for (const a of [PICK, GIVEUP, READY, play('S4'), flip(0)]) rejectAs(e, 1, a, 'wrong-phase', 'nach dem Ende');
});

test('Feindliche Eingaben: fehlerhafte Aktionen (falsche Typen, null, Riesen-Arrays, Prototyp-Schlüssel) werfen nie und ändern nichts', () => {
  const states = fixedStates();
  let n = 0;
  for (const name of Object.keys(states)) {
    const base = states[name];
    const list = garbageActions(base);
    const M = mirror(base);
    for (let seat = 0; seat < base.players.length; seat++) {
      for (const a of list) {
        const exp = refIsLegal(M, seat, a);
        const s = exp ? clone(base) : base;
        const before = snap(s);
        let r;
        assert.doesNotThrow(() => { r = E.applyAction(s, seat, a); }, name + ' Sitz ' + seat + ' ' + safe(a));
        assert.equal(typeof r, 'object');
        assert.equal(r.ok, exp, name + ' Sitz ' + seat + ' ' + safe(a) + ' -> ' + JSON.stringify(r));
        if (!exp) { assert.equal(typeof r.err, 'string'); assert.equal(snap(s), before, name + ': Zustand verändert durch ' + safe(a)); }
        else assertConserved(s);
        n++;
      }
    }
  }
  assert.ok(n > 2500);
  assert.equal(Object.prototype.t, undefined, 'keine Prototyp-Verschmutzung');
  assert.equal({}.x, undefined, 'keine Prototyp-Verschmutzung');
  assert.equal({}.ready, undefined);
  assert.equal([].ready, undefined);
});

test('Feindliche Eingaben: ungültige Sitznummern werden sauber abgelehnt (kein Wurf, keine Änderung, keine Prototyp-Verschmutzung)', () => {
  const seats = [-1, 3, 99, 0.5, 1.0000001, NaN, Infinity, -Infinity, null, undefined, '0', '1', '', 'length', '__proto__', 'constructor', 'push', {}, [], [0], [1], true, false, 1n, Symbol('s'), () => 1];
  const states = fixedStates();
  const ownKeys = (o) => Object.getOwnPropertyNames(o).join(',');
  const protoBefore = [ownKeys(Object.prototype), ownKeys(Array.prototype), ownKeys(Function.prototype), ownKeys(Array)];
  let n = 0;
  for (const name of Object.keys(states)) {
    const s = states[name], before = snap(s), M = mirror(s);
    for (const seat of seats) {
      const acts = [READY, PICK, flip(0), play('H11'), play('H4'), null].concat(s.phase === 'play' ? E.legalActions(s) : []);
      for (const a of acts) {
        let r, threw = null;
        try { r = E.applyAction(s, seat, a); } catch (e) { threw = e; }
        const label = name + ' Sitz ' + String(typeof seat === 'symbol' ? 'Symbol' : Array.isArray(seat) ? '[' + seat + ']' : typeof seat === 'string' ? JSON.stringify(seat) : seat) + ' ' + safe(a);
        assert.equal(threw, null, label + ' wirft: ' + (threw && threw.message));
        assert.equal(r && r.ok, false, label + ' wird angenommen');
        assert.equal(snap(s), before, label + ' verändert den Zustand');
        assert.equal(refIsLegal(M, seat, a), false);
        n++;
      }
      assert.doesNotThrow(() => E.options(s, seat));
      assert.equal(E.options(s, seat), null);
      if (typeof seat === 'number') assert.equal(E.botAction(s, seat), null, name + ': Bot für Sitz ' + seat);
      if (typeof seat === 'number' && !(seat >= 0 && seat < s.players.length) && (Number.isInteger(seat) || !Number.isFinite(seat))) {     // Zuschauer-Sicht: -1, 99, NaN, ±Infinity
        const view = E.viewFor(s, seat);
        assert.equal(view.my, null); assert.equal(view.canGiveUp, false);
        view.players.forEach((vp) => assert.equal(vp.hand, null));
        assert.equal(E.canGiveUp(s, seat), false);
      }
    }
  }
  assert.ok(n > 1500);
  assert.deepEqual([ownKeys(Object.prototype), ownKeys(Array.prototype), ownKeys(Function.prototype), ownKeys(Array)], protoBefore, 'keine Prototyp-Verschmutzung');
});

/* canGiveUp(s, seat) und viewFor(s, seat) prüfen den Sitz wie applyAction (ganze Zahl im Bereich). Alles andere ist ein
 * Zuschauer: canGiveUp false, view.my null, keine Hand – kein Wurf. Insbesondere gelten '0' und [0] NICHT als Sitz 0. */
test('Feindliche Eingaben: viewFor() und canGiveUp() mit unsinnigem Sitz (null, true, 0.5, "0", [0] …) werfen nicht und behandeln ihn wie einen Zuschauer', () => {
  const seats = [0.5, 1.0000001, -0.5, null, true, false, '0', '1', '', 'length', '__proto__', 'constructor', {}, [], [0], [1], 1n, 0n, () => 1, undefined, NaN, Infinity, -Infinity, -1, 2, 99, new Number(0), Symbol('s')];
  const states = fixedStates();
  const problems = [];
  let n = 0;
  for (const name of Object.keys(states)) {
    const s = states[name], before = snap(s);
    for (const seat of seats) {
      if (typeof seat === 'number' && Number.isInteger(seat) && seat >= 0 && seat < s.players.length) continue;      // 2 ist bei 3+ Spielern ein echter Sitz
      const label = name + ' Sitz ' + (typeof seat === 'string' ? JSON.stringify(seat) : Array.isArray(seat) ? '[' + seat + ']' : String(seat));
      try { if (E.canGiveUp(s, seat) !== false) problems.push(label + ': canGiveUp ist nicht false'); } catch (e) { problems.push(label + ': canGiveUp wirft'); }
      try {
        const view = E.viewFor(s, seat);
        if (view.canGiveUp !== false || view.my !== null || view.players.some((vp) => vp.hand !== null)) problems.push(label + ': viewFor behandelt ihn nicht als Zuschauer');
        // die öffentlichen Angaben sind dieselben wie für jeden echten Zuschauer
        const pub = E.viewFor(s, -1);
        for (const k of ['phase', 'turn', 'dir', 'pile', 'stock', 'burned', 'finished', 'winner', 'loser', 'gaveUp', 'deadlock', 'freePlay', 'again', 'req', 'seq', 'ev', 'startSeat', 'startBy']) assert.deepEqual(view[k], pub[k], label + ': ' + k);
      } catch (e) { if (e instanceof assert.AssertionError) throw e; problems.push(label + ': viewFor wirft'); }
      // gleiche Sitzprüfung wie applyAction: Aufgeben wird für denselben Sitz abgelehnt
      let r; try { r = E.applyAction(s, seat, GIVEUP); } catch (e) { problems.push(label + ': applyAction wirft'); }
      if (r && r.ok !== false) problems.push(label + ': Aufgeben angenommen');
      assert.equal(snap(s), before, label + ': Zustand verändert');
      n++;
    }
    // Gegenprobe mit echten Sitzen: canGiveUp == view.canGiveUp == "applyAction nimmt Aufgeben an"; my genau für den Spieler am Zug
    for (let seat = 0; seat < s.players.length; seat++) {
      const can = E.canGiveUp(s, seat), view = E.viewFor(s, seat);
      assert.equal(can, refCanGiveUp(mirror(s), seat), name + ' Sitz ' + seat);
      assert.equal(view.canGiveUp, can);
      assert.equal(E.applyAction(clone(s), seat, GIVEUP).ok, can);
      assert.equal(view.my !== null, s.phase === 'play' && s.turn === seat);
      assert.deepEqual(view.players[seat].hand, s.players[seat].hand);
    }
  }
  assert.ok(n > 350, 'Fälle: ' + n);
  assert.equal(problems.length, 0, problems.length + ' Fälle, z. B. ' + problems.filter((p, i) => i % 7 === 0).slice(0, 6).join(' | '));
  // der Fall, um den es ging: zu zweit im laufenden Spiel dürfte Sitz 0 aufgeben – '0', [0] und 0.5 sind trotzdem kein Sitz
  const two = states.two;
  assert.equal(E.canGiveUp(two, 0), true); assert.equal(E.viewFor(two, 0).canGiveUp, true); assert.ok(E.viewFor(two, 0).my);
  for (const seat of ['0', [0], 0.5, null, true, new Number(0)]) {
    assert.equal(E.canGiveUp(two, seat), false);
    const view = E.viewFor(two, seat);
    assert.equal(view.canGiveUp, false); assert.equal(view.my, null);
    assert.equal(view.players[0].hand, null, 'auch die Hand von Sitz 0 bleibt verborgen');
    rejectAs(two, seat, GIVEUP, 'bad-seat');
  }
});

/* ================================================================== K2d: kein Aufnehmen im Zusatzzug nach der eigenen 3 */

const AGAIN_OPTS = (playable) => ({ zone: 'hand', playable, canPickup: false, canFlip: false, forced: false });
function assertAgainTurn(s, seat, msg) {
  assert.equal(s.again, true, (msg || '') + ' again gesetzt');
  assert.equal(s.turn, seat); assert.equal(s.freePlay, false);
  assert.ok(s.pile.length > 0 && rk(topOf(s)) === 3, 'die eigene 3 liegt oben');
  for (let v = -1; v < s.players.length; v++) assert.equal(E.viewFor(s, v).again, true, 'alle sehen den Zusatzzug');
  const o = E.options(s, seat);
  assert.equal(o.canPickup, false, (msg || '') + ' kein Aufnehmen im Zusatzzug'); assert.equal(o.forced, false);
  assert.ok(o.playable.length > 0 || o.canFlip, 'es gibt immer einen Zug: auf die 3 passt alles');
  assert.deepEqual(E.viewFor(s, seat).my, o);
  assert.equal(E.legalActions(s).some((a) => a.t === 'pickup'), false, 'legalActions ohne Aufnehmen');
  assert.ok(E.legalActions(s).length > 0);
  rejectAs(s, seat, PICK, 'cannot-pickup', (msg || '') + ' Aufnehmen im Zusatzzug');
  const bot = E.botAction(s, seat);
  assert.ok(bot && bot.t !== 'pickup' && refIsLegal(mirror(s), seat, bot), 'der Bot nimmt im Zusatzzug nicht auf');
}

test('K2d: im Zusatzzug nach der eigenen 3 (zu zweit) ist Aufnehmen verboten – options, legalActions, Sicht, Fehlercode; im Zug danach ist es wieder erlaubt', () => {
  const s = mk({ players: [{ hand: ['H3', 'D3', 'D9', 'C12'], up: ['S5', 'S6'] }, { hand: ['S9', 'S11'] }], pile: ['S8', 'S2'], turn: 0 });
  assert.equal(s.again, false); assert.equal(E.viewFor(s, 0).again, false);
  assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: ['H3', 'D3', 'D9', 'C12'], canPickup: true, canFlip: false, forced: false }, 'vor der 3: Aufnehmen wäre erlaubt');
  assert.ok(E.legalActions(s).some((a) => a.t === 'pickup'));
  assert.deepEqual(accept(s, 0, play('H3')).fx, ['again']);
  assertAgainTurn(s, 0);
  assert.deepEqual(E.options(s, 0), AGAIN_OPTS(['D3', 'D9', 'C12']));
  assert.equal(E.options(s, 1), null); assert.equal(E.viewFor(s, 1).my, null);
  rejectAs(s, 1, PICK, 'not-your-turn');
  assert.deepEqual(s.pile, ['S8', 'S2', 'H3'], 'abgelehntes Aufnehmen ändert nichts');
  // 3 auf 3: wieder ein Zusatzzug, wieder ohne Aufnehmen
  assert.deepEqual(accept(s, 0, play('D3')).fx, ['again']);
  assertAgainTurn(s, 0, '3 auf 3:');
  assert.deepEqual(E.options(s, 0), AGAIN_OPTS(['D9', 'C12']));
  // der Zusatzzug selbst: eine normale Karte – danach ist again vorbei und der Gegner darf wie immer aufnehmen
  let ev = accept(s, 0, play('D9'));
  assert.deepEqual(ev.fx, []);
  assert.equal(s.again, false); assert.equal(s.turn, 1);
  for (let v = -1; v < 2; v++) assert.equal(E.viewFor(s, v).again, false);
  assert.deepEqual(E.options(s, 1), { zone: 'hand', playable: ['S9', 'S11'], canPickup: true, canFlip: false, forced: false });
  ev = accept(s, 1, PICK, 'der Gegner nimmt freiwillig auf');
  assert.equal(ev.vol, true); assert.equal(ev.n, 5);
  accept(s, 1, play('S9'));
  // … und der 3er-Leger darf in seinem NÄCHSTEN Zug wieder aufnehmen
  assert.equal(s.turn, 0); assert.equal(s.again, false);
  assert.deepEqual(E.options(s, 0), { zone: 'hand', playable: ['C12'], canPickup: true, canFlip: false, forced: false });
  ev = accept(s, 0, PICK, 'im Zug danach wieder erlaubt');
  assert.equal(ev.vol, true);
  assert.equal(s.again, false);
  // aus den offenen Karten: 3 offen gelegt -> Zusatzzug aus den offenen Karten, ohne Aufnehmen (auch nicht mit nur noch einer)
  const u = mk({ players: [{ up: ['H3', 'D9', null], down: ['C4'] }, { hand: ['S9', 'S11', 'S12'] }], pile: ['S7'], turn: 0 });
  assert.equal(E.options(u, 0).canPickup, true);
  assert.deepEqual(accept(u, 0, play('H3')).fx, ['again']);
  assertAgainTurn(u, 0, 'offen:');
  assert.deepEqual(E.options(u, 0), { zone: 'up', playable: ['D9'], canPickup: false, canFlip: false, forced: false });
  assert.deepEqual(u.players[0].up, [null, 'D9', null], 'die letzte offene Karte bleibt liegen');
  accept(u, 0, play('D9'));
  assert.equal(u.again, false); assert.equal(u.turn, 1);
  // mehrere 3er auf einmal: ein Zusatzzug, ohne Aufnehmen
  const m = mk({ players: [{ hand: ['H3', 'D3', 'C4', 'C5'] }, { hand: ['S9', 'S11', 'S12'] }], pile: [], turn: 0 });
  accept(m, 0, play('H3', 'D3'));
  assertAgainTurn(m, 0, 'zwei 3er:');
  // Zusatzzug mit einer Sonderkarte: 10 räumt ab (again vorbei, der Gegner beginnt frei); 7 und Joker wirken normal
  for (const [c, fx] of [['C10', ['burn']], ['C7', []], ['JB', ['joker']], ['C2', []]]) {
    const x = mk({ players: [{ hand: ['H3', c, 'D9'] }, { hand: ['S4', 'S11', 'S12'] }], pile: ['S2'], turn: 0 });
    accept(x, 0, play('H3')); assertAgainTurn(x, 0, c + ':');
    assert.deepEqual(accept(x, 0, play(c)).fx, fx);
    assert.equal(x.again, false); assert.equal(x.turn, 1);
    assert.equal(E.options(x, 1).canPickup, x.pile.length > 0);
  }
});

test('K2d: die Solo-Schleife "3 legen, aufnehmen, 3 legen, aufnehmen …" gibt es nicht – nach spätestens (Anzahl 3er + 2) eigenen Zügen ist der Gegner dran', () => {
  // genau die gemeldete Schleife
  let s = mk({ players: [{ hand: ['H3', 'D9'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 });
  accept(s, 0, play('H3'));
  rejectAs(s, 0, PICK, 'cannot-pickup', '3, aufnehmen');
  assert.deepEqual(E.legalActions(s), [play('D9')], 'einziger Zug: die andere Karte legen');
  // Variante: erst aufnehmen, dann die 3, dann wieder aufnehmen
  s = mk({ players: [{ hand: ['H3', 'D9'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 });
  assert.equal(accept(s, 0, PICK).vol, true);
  assert.deepEqual(accept(s, 0, play('H3')).fx, ['again']);
  assert.deepEqual(s.pile, ['H3']);
  rejectAs(s, 0, PICK, 'cannot-pickup', 'aufnehmen, 3, aufnehmen');
  assert.equal(s.turn, 0);
  // vollständig: ALLE Zugfolgen eines Spielers, solange er am Zug bleibt (Engine-Züge, jeder gegen das Referenzmodell geprüft)
  const chain = (st, seat, depth, seen) => {
    if (st.phase !== 'play' || st.turn !== seat) return depth;
    const key = posKey(mirror(st), true);
    assert.ok(!seen.has(key), 'Stellung wiederholt sich innerhalb der eigenen Zugfolge: ' + brief(st));
    const seen2 = new Set(seen); seen2.add(key);
    let max = depth;
    const acts = E.legalActions(st);
    assert.ok(acts.length > 0);
    for (const a of acts) { const c = clone(st); accept(c, seat, a); max = Math.max(max, chain(c, seat, depth + 1, seen2)); }
    return max;
  };
  const cases = [
    { spec: { players: [{ hand: ['H3', 'D9'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 }, threes: 1 },
    { spec: { players: [{ hand: ['H3', 'D3', 'C3', 'D9'], up: ['S5', 'S6'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 }, threes: 3 },
    { spec: { players: [{ hand: ['H3', 'D9', 'C12'] }, { hand: ['S9', 'S11'] }], pile: ['S2', 'S3', 'C3'], turn: 0 }, threes: 3 },     // 3er im Stapel: aufnehmen und alle legen
    { spec: { players: [{ hand: ['H13'], up: ['H3', 'D3', 'C9'] }, { hand: ['S9', 'S11'] }], pile: ['S2', 'S3'], turn: 0 }, threes: 1 },
    { spec: { players: [{ hand: ['S9', 'S11'] }, { hand: ['H3', 'D3', 'D4'], down: ['C3'] }], pile: ['D2', 'S3'], turn: 1 }, threes: 3 }
  ];
  for (const c of cases) {
    const st = mk(c.spec), seat = st.turn;
    const max = chain(st, seat, 0, new Set());
    // höchstens: einmal aufnehmen + jede erreichbare 3 einzeln + der eine Zusatzzug
    assert.ok(max <= c.threes + 2, 'längste eigene Zugfolge ' + max + ' in ' + brief(st));
    assert.ok(max >= 3, 'die 3 bringt wirklich Zusatzzüge (' + max + ')');
  }
});

test('K2d: blind aufgedeckte 3 (zu zweit) gibt einen Zusatzzug ohne Aufnehmen; scheitert das Aufdecken, gibt es keinen', () => {
  let s = mk({ players: [{ down: ['H3', 'C9', 'D3'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 });
  assert.deepEqual(E.options(s, 0), { zone: 'down', playable: [], canPickup: true, canFlip: true, forced: false }, 'vorher: aufnehmen statt aufdecken wäre erlaubt');
  let ev = accept(s, 0, flip(0));
  assert.equal(ev.t, 'play'); assert.equal(ev.from, 'down'); assert.deepEqual(ev.fx, ['again']);
  assertAgainTurn(s, 0, 'blinde 3:');
  assert.deepEqual(E.options(s, 0), { zone: 'down', playable: [], canPickup: false, canFlip: true, forced: false });
  assert.deepEqual(E.legalActions(s), [flip(1), flip(2)], 'nur aufdecken');
  ev = accept(s, 0, flip(2), 'wieder eine 3');
  assert.deepEqual(ev.fx, ['again']);
  assertAgainTurn(s, 0, 'zweite blinde 3:');
  assert.deepEqual(E.legalActions(s), [flip(1)]);
  ev = accept(s, 0, flip(1), 'letzte Karte');
  assert.deepEqual(sorted(ev.fx), ['over', 'win']);
  assert.equal(s.again, false); assert.equal(s.phase, 'over');
  // Zusatzzug blind, die aufgedeckte Karte passt immer (auf die 3 passt alles) – danach ist der Gegner dran und darf aufnehmen
  s = mk({ players: [{ down: ['H3', 'C9', 'D4'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 });
  accept(s, 0, flip(0)); assertAgainTurn(s, 0);
  ev = accept(s, 0, flip(2), 'die 4 passt auf die 3');
  assert.equal(ev.t, 'play'); assert.equal(s.again, false); assert.equal(s.turn, 1);
  assert.equal(E.options(s, 1).canPickup, true);
  // gescheitertes Aufdecken einer 3 (passt nicht auf die 8): Stapel + 3 auf die Hand, Pflichtzug, KEIN again;
  // legt er die 3 dann im Pflichtzug, beginnt der Zusatzzug – ohne Aufnehmen, obwohl jetzt wieder etwas liegt
  s = mk({ players: [{ down: ['H3', 'C9'] }, { hand: ['S9', 'S11'] }], pile: ['S8'], turn: 0 });
  ev = accept(s, 0, flip(0));
  assert.equal(ev.t, 'flipfail'); assert.equal(s.again, false); assert.equal(s.freePlay, true); assert.equal(s.turn, 0);
  assert.equal(E.options(s, 0).canPickup, false, 'leerer Stapel');
  assert.deepEqual(accept(s, 0, play('H3')).fx, ['again']);
  assertAgainTurn(s, 0, 'nach dem Pflichtzug:');
  assert.deepEqual(E.options(s, 0), AGAIN_OPTS(['S8']));
  accept(s, 0, play('S8'));
  assert.equal(s.turn, 1); assert.equal(s.again, false);
  // blinde 3 gegen den schwarzen Joker scheitert (nur Rot kontert): kein Zusatzzug
  s = mk({ players: [{ down: ['H3', 'C9'] }, { hand: ['S9', 'S11'] }], pile: ['S8', 'JB'], turn: 0 });
  ev = accept(s, 0, flip(0));
  assert.equal(ev.t, 'flipfail'); assert.equal(s.again, false); assert.equal(s.freePlay, true);
});

test('K2d: again gibt es nur bei genau zwei aktiven Spielern – zu dritt und mehr dreht die 3 nur die Richtung, und der Nächste darf aufnehmen', () => {
  for (let n = 3; n <= 6; n++) {
    const s = table(n, { pile: ['S2'], turn: 0, seats: { 0: { hand: ['H3', 'D9'] } } });
    const ev = accept(s, 0, play('H3'));
    assert.deepEqual(ev.fx, ['reverse'], n + ' Spieler');
    assert.equal(s.again, false, n + ' Spieler: kein Zusatzzug');
    for (let v = -1; v < n; v++) assert.equal(E.viewFor(s, v).again, false);
    assert.equal(s.turn, n - 1);
    const o = E.options(s, n - 1);
    assert.equal(o.canPickup, true, 'der Nächste darf die 3 samt Stapel aufnehmen'); assert.equal(o.forced, false);
    const e2 = accept(s, n - 1, PICK);
    assert.equal(e2.vol, true); assert.equal(e2.n, 2);
    assert.equal(s.again, false);
  }
  // blind zu dritt: Richtungswechsel, kein again
  let s = mk({ players: [{ down: ['H3', 'C9'] }, { hand: ['S9', 'S11'] }, { hand: ['D9', 'D11'] }], pile: ['S2'], turn: 0 });
  assert.deepEqual(accept(s, 0, flip(0)).fx, ['reverse']);
  assert.equal(s.again, false); assert.equal(s.turn, 2); assert.equal(E.options(s, 2).canPickup, true);
  // 4 Sitze, zwei schon fertig: es zählen die AKTIVEN Spieler -> Zusatzzug ohne Aufnehmen
  s = mk({ players: [{ hand: ['H3', 'D9', 'C9'] }, {}, {}, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0, finished: [2, 1] });
  assert.deepEqual(accept(s, 0, play('H3')).fx, ['again']);
  assertAgainTurn(s, 0, '4 Sitze, 2 aktiv:');
  // drei aktiv, die 3 ist die letzte Karte des Legers (danach nur noch zwei): Richtungswechsel, kein again
  s = mk({ players: [{ hand: ['H3'] }, { hand: ['S4', 'S5'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 });
  assert.deepEqual(sorted(accept(s, 0, play('H3')).fx), ['reverse', 'win']);
  assert.equal(s.again, false); assert.equal(s.turn, 2); assert.equal(E.options(s, 2).canPickup, true);
  // … die beiden Verbliebenen spielen ab jetzt mit Zusatzzug
  accept(s, 2, PICK); accept(s, 2, play('H3'));
  assertAgainTurn(s, 2, 'aus drei wurden zwei:');
  // zwei aktiv, die 3 ist die letzte Karte: Runde vorbei, kein again
  s = mk({ players: [{ hand: ['H3'] }, { hand: ['S4', 'S5'] }], pile: ['S2'], turn: 0 });
  assert.deepEqual(sorted(accept(s, 0, play('H3')).fx), ['over', 'win']);
  assert.equal(s.again, false); assert.equal(E.viewFor(s, 1).again, false);
});

test('K2d: again endet mit dem nächsten Legezug, mit dem Aufgeben (beider Seiten) und ist Teil der Stellung', () => {
  const base = mk({ players: [{ hand: ['H3', 'D9', 'C12'] }, { hand: ['S9', 'S11'] }], pile: ['S2'], turn: 0 });
  accept(base, 0, play('H3'));
  assertAgainTurn(base, 0);
  for (const seat of [0, 1]) {
    const g = clone(base);
    assert.equal(E.canGiveUp(g, seat), true);
    accept(g, seat, GIVEUP, 'Aufgeben im Zusatzzug');
    assert.equal(g.again, false, 'Aufgeben beendet den Zusatzzug'); assert.equal(g.freePlay, false);
    assert.equal(E.viewFor(g, 0).again, false); assert.equal(g.phase, 'over'); assert.equal(g.loser, seat);
  }
  const p = clone(base);
  accept(p, 0, play('D9'));
  assert.equal(p.again, false);
  // dieselben Karten, derselbe Spieler am Zug, die 3 oben – einmal als Zusatzzug, einmal von Hand gebaut ohne: verschiedene Stellungen
  const plain = mk({ players: [{ hand: ['D9', 'C12'] }, { hand: ['S9', 'S11'] }], pile: ['S2', 'H3'], turn: 0 });
  assert.equal(plain.again, false);
  assert.equal(E.options(plain, 0).canPickup, true, 'ohne again (z. B. zu dritt gelegt und einer wurde fertig) darf aufgenommen werden');
  assert.notEqual(posKey(mirror(plain), true), posKey(mirror(base), true));
  assert.notEqual(canon(mirror(plain)), canon(mirror(base)));
  const built = mk({ players: [{ hand: ['D9', 'C12'] }, { hand: ['S9', 'S11'] }], pile: ['S2', 'H3'], turn: 0, again: true });
  assert.deepEqual(E.options(built, 0), E.options(base, 0));
  rejectAs(built, 0, PICK, 'cannot-pickup');
});

/* ================================================================== Bot: Zufall erst bei wiederholter Stellung */

test('Bot: fest bei neuer Stellung (auch bei sehr hohem seq); ab dem zweiten Auftreten würfelt er unter den Legezügen, Aufnehmen kommt erst ab dem dritten dazu', () => {
  // Sitz 0: König + 10 + 2 (Auswege, die stur NICHT genutzt werden); der König kreist: 0 legt K – 1 nimmt auf – 1 legt K –
  // jetzt Stellung P: Sitz 0 am Zug, König oben, Hand [10, 2] (zwei Legezüge + Aufnehmen) – 0 nimmt auf – …
  const s = mk({ players: [{ hand: ['S13', 'C10', 'C2'], up: ['S5', 'S6'] }, { hand: [], up: ['H4', 'H5'] }], pile: [], turn: 0 });
  const sig = (a) => (a.t === 'play' ? a.cards.join('+') : a.t);
  const sample = (st, n) => {
    const hist = {};
    for (let i = 0; i < n; i++) {
      const before = snap(st), a = E.botAction(st, st.turn);
      assert.equal(snap(st), before, 'botAction verändert den Zustand nicht');
      assert.ok(refIsLegal(mirror(st), st.turn, a), 'Bot-Aktion legal: ' + safe(a));
      hist[sig(a)] = (hist[sig(a)] || 0) + 1;
    }
    return hist;
  };
  const atP = () => s.phase === 'play' && s.turn === 0 && s.pile.length === 1 && s.players[0].hand.length === 2;
  const seen = { p1: 0, p2: 0, p3: 0, forced: 0, single: 0 };
  withRandom(2024, () => {
    for (let i = 0; i < 24; i++) {
      accept(s, s.turn, kingLoop(s));
      assert.equal(s.deadlock, false, 'die 10 ist ein Ausweg');
      const rpt = s.ev.repeat || 1;
      if (atP()) {
        assert.deepEqual(sorted(E.legalActions(s).map(sig)), ['C10', 'C2', 'pickup']);
        if (rpt === 1) {
          assert.deepEqual(sample(s, 200), { C2: 200 }, 'neue Stellung: immer die schwächste passende Karte');
          const late = clone(s); late.seq = 100000;       // die alte Regel "ab seq > 400 zu 20 % zufällig" gibt es nicht mehr
          assert.deepEqual(sample(late, 300), { C2: 300 }, 'auch in einer sehr langen Partie: kein Zufall ohne Wiederholung');
          seen.p1++;
        } else if (rpt === 2) {
          const h = sample(s, 400);
          assert.deepEqual(Object.keys(h).sort(), ['C10', 'C2'], 'zweites Auftreten: gewürfelt wird nur unter den Legezügen – ' + JSON.stringify(h));
          assert.ok(h.C10 > 140 && h.C2 > 140, 'beide Legezüge etwa gleich oft: ' + JSON.stringify(h));
          seen.p2++;
        } else {
          const h = sample(s, 600);
          assert.deepEqual(Object.keys(h).sort(), ['C10', 'C2', 'pickup'], 'ab dem dritten Auftreten ist auch Aufnehmen dabei – ' + JSON.stringify(h));
          assert.ok(h.C10 > 140 && h.C2 > 140 && h.pickup > 140, 'alle drei etwa gleich oft: ' + JSON.stringify(h));
          seen.p3++;
        }
      } else if (rpt >= 2) {
        // wiederholte Stellungen ohne Wahl: erzwungenes Aufnehmen bleibt Aufnehmen, eine einzige Handkarte bleibt diese Karte
        const la = E.legalActions(s), h = sample(s, 60);
        if (E.options(s, s.turn).forced) { assert.deepEqual(h, { pickup: 60 }); seen.forced++; }
        else if (la.length === 1) { assert.deepEqual(h, { [sig(la[0])]: 60 }); seen.single++; }
        else if (rpt === 2) assert.ok(!h.pickup, 'zweites Auftreten: kein freiwilliges Aufnehmen – ' + JSON.stringify(h));
      }
    }
  });
  assert.ok(seen.p1 === 1 && seen.p2 === 1 && seen.p3 >= 2 && seen.forced >= 2 && seen.single >= 2, JSON.stringify(seen));
  // frische Stellung ohne jede Vorgeschichte, seq künstlich hoch: fest
  const f = mk({ players: [{ hand: ['C10', 'C2', 'D9', 'H9'], up: ['S5', 'S6'] }, { hand: ['S4'], up: ['H4', 'H5'] }], pile: ['S8'], turn: 0 });
  f.seq = 5000; f.ev.seq = 5000;
  withRandom(7, () => {
    const hist = {};
    for (let i = 0; i < 300; i++) { const a = E.botAction(f, 0); hist[a.t + ':' + a.cards.slice().sort().join('+')] = 1; }
    assert.deepEqual(Object.keys(hist), ['play:D9+H9'], 'schwächste passende Karte, normale Werte komplett');
  });
});
