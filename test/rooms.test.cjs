'use strict';
/* Karma – Prüfung der Neuerungen vom 24.11.2026:
 *   - Decks: 1 (54 Karten), 1,5 (81 Karten, 2 schwarze + 1 roter Joker), 2 (108 Karten, 2 + 2 Joker); bis 12 Spieler
 *   - doppelte Karten (zweites Exemplar in Kleinbuchstaben) verhalten sich in den Regeln wie das erste
 *   - Plätze mischen nach jeder Runde (mixOrder), Deck-Wahl und Zugzeit des Hosts (op 'opts')
 *
 * Ausführen:  node --test test/rooms.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const E = require(path.join(__dirname, '..', 'src', 'engine.js'));
const N = require(path.join(__dirname, '..', 'src', 'net.js'));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const people = (n) => Array.from({ length: n }, (_, i) => ({ name: 'P' + i }));
function allCards(g) {
  const all = [];
  for (const p of g.players) all.push(...p.hand, ...p.up.filter(Boolean), ...p.down.filter(Boolean));
  all.push(...g.pile, ...g.burned, ...g.stock);
  return all;
}
const SIZE = { 1: 54, 1.5: 81, 2: 108 };

/* ================================================================== Decks */

test('Decks: 54 / 81 / 108 Karten, jede ID einmal, jeder Wert gleich häufig, Joker 1+1 / 2+1 / 2+2', () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const d of [1, 1.5, 2]) {
      const deck = E.buildDeck(d, mulberry32(seed));
      assert.equal(deck.length, SIZE[d]);
      assert.equal(new Set(deck).size, deck.length, 'keine ID doppelt');
      const black = deck.filter(E.isBlackJoker).length, red = deck.filter(E.isRedJoker).length;
      assert.deepEqual([black, red], d === 1 ? [1, 1] : d === 1.5 ? [2, 1] : [2, 2]);
      for (let r = 2; r <= 14; r++) {
        const of = deck.filter((c) => !E.isJoker(c) && E.rank(c) === r);
        assert.equal(of.length, d * 4, 'Wert ' + r + ' bei Deck ' + d);
        const reds = of.filter((c) => 'HD'.includes(E.suit(c))).length;
        assert.equal(reds, d * 2, 'Wert ' + r + ': gleich viele rote und schwarze Karten');
      }
    }
  }
  assert.deepEqual([E.maxPlayers(1), E.maxPlayers(1.5), E.maxPlayers(2)], [6, 9, 12]);
  assert.deepEqual([2, 6, 7, 9, 10, 12].map(E.decksFor), [1, 1, 1.5, 1.5, 2, 2]);
});

test('Doppelte Karten: Wert, Farbe und Joker-Art wie beim ersten Exemplar', () => {
  assert.equal(E.rank('h7'), 7); assert.equal(E.rank('s14'), 14); assert.equal(E.suit('h7'), 'H'); assert.equal(E.suit('c10'), 'C');
  assert.equal(E.rank('jb'), E.rank('JB')); assert.equal(E.rank('jr'), E.rank('JR')); assert.notEqual(E.rank('jb'), E.rank('jr'));
  for (const j of ['JB', 'jb', 'JR', 'jr']) { assert.equal(E.isJoker(j), true); assert.equal(E.suit(j), 'J'); }
  assert.equal(E.isJoker('h7'), false);
  // Rot kontert Schwarz – egal welches Exemplar; Schwarz auf Schwarz und alles auf Rot geht nicht
  for (const b of ['JB', 'jb']) {
    for (const r of ['JR', 'jr']) { assert.equal(E.canPlayOn(r, b), true); assert.equal(E.canPlayOn(b, r), false); }
    for (const x of ['JB', 'jb', 'S2', 's2', 'H10', 'h10', 'D7', 'C14']) assert.equal(E.canPlayOn(x, b), false, x + ' auf ' + b);
  }
  for (const r of ['JR', 'jr']) for (const x of ['JR', 'jr', 'JB', 'jb', 'S2', 'h10']) assert.equal(E.canPlayOn(x, r), false, x + ' auf ' + r);
  assert.equal(E.canPlayOn('h9', 'H9'), true); assert.equal(E.canPlayOn('h8', 'H9'), false); assert.equal(E.canPlayOn('s2', 'C14'), true);
  assert.equal(E.canPlayOn('h6', 's7'), true); assert.equal(E.canPlayOn('h8', 's7'), false);
});

test('Austeilen: 2–12 Spieler, je 9 Karten, das Deck richtet sich nach der Spielerzahl oder der Wahl (wenn sie reicht)', () => {
  for (let n = 2; n <= 12; n++) {
    for (const want of [undefined, 1, 1.5, 2, 3, 'x']) {
      const g = E.createGame(people(n), { rng: mulberry32(n * 13 + 1), decks: want });
      const need = E.decksFor(n);
      const exp = (want === 1 || want === 1.5 || want === 2) && want >= need ? want : need;
      assert.equal(g.decks, exp, n + ' Spieler, Wahl ' + want);
      assert.equal(E.viewFor(g, 0).decks, exp);
      const all = allCards(g);
      assert.equal(all.length, SIZE[exp]);
      assert.equal(new Set(all).size, all.length);
      assert.equal(g.stock.length, SIZE[exp] - 9 * n);
      for (const p of g.players) assert.deepEqual([p.hand.length, p.up.length, p.down.length], [3, 3, 3]);
    }
  }
});

function playing(n, decks, seed) {
  const g = E.createGame(people(n), { rng: mulberry32(seed || 5), decks, startSeat: 0 });
  for (let i = 0; i < n; i++) assert.ok(E.applyAction(g, i, { t: 'ready' }).ok);
  assert.equal(g.phase, 'play');
  return g;
}

test('Legen mit zwei Decks: beide Exemplare zusammen, bis zu 8 gleiche; zwei schwarze Joker zusammen, Schwarz + Rot nie', () => {
  const g = playing(3, 2);
  g.players[0].hand = ['H9', 'h9', 'S9', 's9', 'D9', 'd9', 'C9', 'c9', 'JB', 'jb', 'JR'];
  g.pile = []; g.stock = [];
  assert.deepEqual(E.applyAction(g, 0, { t: 'play', cards: ['JB', 'JR'] }), { ok: false, err: 'mixed-ranks' });
  assert.deepEqual(E.applyAction(g, 0, { t: 'play', cards: ['H9', 'H9'] }), { ok: false, err: 'not-in-zone' });
  assert.ok(E.applyAction(g, 0, { t: 'play', cards: ['H9', 'h9', 'S9', 's9', 'D9', 'd9', 'C9', 'c9'] }).ok);
  assert.equal(g.pile.length, 8);
  assert.equal(g.turn, 1);
  g.turn = 0;
  assert.ok(E.applyAction(g, 0, { t: 'play', cards: ['JB', 'jb'] }).ok, 'zwei schwarze Joker in einem Zug');
  assert.deepEqual(g.ev.fx, ['joker']);
  assert.deepEqual(E.viewFor(g, 1).req, { k: 'jokerB' });
  // der Nächste kontert mit dem zweiten roten Joker
  g.players[1].hand = ['jr', 'C4'];
  assert.deepEqual(E.options(g, 1).playable, ['jr']);
  assert.ok(E.applyAction(g, 1, { t: 'play', cards: ['jr'] }).ok);
  assert.deepEqual(g.ev.fx, ['counter']);
  assert.deepEqual(E.viewFor(g, 2).req, { k: 'jokerR' });
  // der Übernächste muss aufnehmen: alle drei Joker verschwinden, die acht 9er kommen auf die Hand
  const before = g.players[2].hand.length;
  assert.equal(E.options(g, 2).forced, true);
  assert.ok(E.applyAction(g, 2, { t: 'pickup' }).ok);
  assert.deepEqual(g.ev.gone.slice().sort(), ['JB', 'jb', 'jr'].sort());
  assert.equal(g.players[2].hand.length, before + 8);
  assert.ok(!g.players[2].hand.some(E.isJoker));
});

test('Ganze Partien mit 7–12 Spielern (Bots, Timer-Züge, Zufall): jeder Zug erlaubt, Karten bleiben erhalten, jede Partie endet', () => {
  let games = 0;
  for (let n = 7; n <= 12; n++) {
    for (const mode of ['bot', 'auto', 'rand']) {
      for (let seed = 1; seed <= 6; seed++) {
        const rnd = mulberry32(n * 1000 + seed * 7 + mode.length);
        const realRandom = Math.random;
        Math.random = rnd;
        try {
          const g = E.createGame(people(n), { rng: rnd, decks: seed % 2 && n <= 9 ? 2 : undefined });
          const size = SIZE[g.decks];
          for (let i = 0; i < n; i++) assert.ok(E.applyAction(g, i, E.botAction(g, i)).ok);
          let moves = 0;
          while (g.phase === 'play') {
            const seat = g.turn;
            let a;
            if (mode === 'bot') a = E.botAction(g, seat);
            else if (mode === 'auto') a = E.autoAction(g, seat, rnd);
            else { const acts = E.legalActions(g); a = acts[Math.floor(rnd() * acts.length)]; }
            const r = E.applyAction(g, seat, a);
            assert.ok(r.ok, n + ' Spieler, ' + mode + ', seed ' + seed + ': ' + JSON.stringify(a) + ' -> ' + r.err);
            if (++moves % 50 === 0) { const all = allCards(g); assert.equal(all.length, size); assert.equal(new Set(all).size, size); }
            assert.ok(moves < 60000, 'Partie endet nicht: ' + n + ' Spieler, ' + mode + ', seed ' + seed);
          }
          assert.equal(g.phase, 'over');
          if (!g.deadlock) { assert.equal(g.finished.length, n - 1); assert.equal(typeof g.loser, 'number'); }
          const v = E.viewFor(g, 0);
          assert.equal(v.players.length, n);
          games++;
        } finally { Math.random = realRandom; }
      }
    }
  }
  assert.equal(games, 6 * 3 * 6);
});

/* ================================================================== Plätze mischen */

function ring(a) { const n = a.length, s = new Set(); a.forEach((x, i) => s.add(x + '>' + a[(i + 1) % n])); return s; }

test('mixOrder: zu zweit bleibt alles, zu dritt dreht sich die Richtung, zu viert behält höchstens einer seinen Hintermann, ab fünf sitzt niemand mehr neben einem alten Nachbarn', () => {
  assert.deepEqual(N.mixOrder([]), []);
  assert.deepEqual(N.mixOrder(['a']), ['a']);
  assert.deepEqual(N.mixOrder(['a', 'b']), ['a', 'b']);
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = mulberry32(seed);
    assert.deepEqual(N.mixOrder(['a', 'b', 'c'], rnd), ['a', 'c', 'b']);
    for (let n = 4; n <= 12; n++) {
      const ids = Array.from({ length: n }, (_, i) => 'p' + i);
      const out = N.mixOrder(ids, rnd);
      assert.equal(out[0], ids[0], 'Sitz 0 bleibt');
      assert.deepEqual(out.slice().sort(), ids.slice().sort(), 'dieselben Spieler');
      const was = ring(ids), now = ring(out);
      let sameNext = 0, sameSide = 0;
      now.forEach((e) => { const [x, y] = e.split('>'); if (was.has(e)) sameNext++; else if (was.has(y + '>' + x)) sameSide++; });
      if (n === 4) assert.ok(sameNext <= 1 && sameNext + sameSide <= 2, 'n=4: ' + out);
      else assert.equal(sameNext + sameSide, 0, 'n=' + n + ' seed ' + seed + ': ' + out);
    }
  }
  // ohne eigenen Zufall (Math.random) und mit kaputtem Zufall: immer eine gültige Reihenfolge
  for (const rnd of [undefined, () => 0, () => 0.999999, () => 1, () => NaN]) {
    const out = N.mixOrder([0, 1, 2, 3, 4, 5], rnd);
    assert.deepEqual(out.slice().sort(), [0, 1, 2, 3, 4, 5]);
  }
});

/* ---------- Raum ---------- */

const T_ORIG = Object.assign({}, N.T);
const FAST = { tick: 5, ping: 40, hostDead: 250, playerDead: 250, resend: 20, hello: 20, joinTimeout: 200, bot: 2, sweep: 25, turn: 0, swap: 0, start: 0, mix: true };
function world(t, seed) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1750000000000 });
  Object.assign(N.T, FAST);
  const realRandom = Math.random, netRandom = N.random;
  Math.random = mulberry32(seed || 1);
  N.random = mulberry32((seed || 1) + 99);
  N.memBus.rooms = {}; N.memBus.drop = 0; N.memBus.delay = 0;
  const w = { game: null, games: [] };
  w.engine = Object.assign({}, E, { createGame(players, o) { const g = E.createGame(players, o); w.games.push(g); w.game = g; return g; } });
  w.session = () => N.createSession({ engine: w.engine, transport: 'mem' });
  w.run = (ms) => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
  w.until = (pred, maxMs, what) => {
    for (let i = 0; i <= (maxMs || 3000); i++) { if (pred()) return i; t.mock.timers.tick(1); }
    assert.fail('Zeitüberschreitung: ' + (what || pred.toString()));
  };
  t.after(() => { Math.random = realRandom; N.random = netRandom; Object.assign(N.T, T_ORIG); N.memBus.rooms = {}; });
  return w;
}
function room(w, guestNames, bots) {
  const host = w.session();
  const code = host.host('Host');
  const guests = guestNames.map((name, i) => {
    const g = w.session();
    assert.equal(g.join(code, name), true);
    w.until(() => g.snap.stage === 'lobby' && host.snap.lobby.players.length === i + 2, 1000, name + ' tritt bei');
    return g;
  });
  for (let i = 0; i < (bots || 0); i++) assert.equal(host.lobby({ op: 'addBot' }), true);
  return { host, guests, code };
}
const names = (s) => s.snap.lobby.players.map((p) => p.name);
/* Runde sofort beenden: Sitz `loser` hat verloren. */
function finish(w, host, loser) {
  const g = w.game;
  g.phase = 'over'; g.turn = -1; g.loser = loser; g.winner = (loser + 1) % g.players.length;
  g.finished = g.players.map((_, i) => i).filter((i) => i !== loser);
  assert.equal(host.lobby({ op: 'opts', turn: 50 }), true);   // neuer Stand: der Host zählt den Sieg
}

test('Plätze mischen: nach jeder Runde neue Nachbarn, Host bleibt Sitz 0, Gäste kennen ihren neuen Sitz, der Verlierer beginnt, Striche wandern mit', (t) => {
  const w = world(t, 3);
  const { host, guests } = room(w, ['Anna', 'Ben', 'Cem'], 2);
  let order = names(host);
  assert.deepEqual(order, ['Host', 'Anna', 'Ben', 'Cem', 'Bot Ada', 'Bot Ben']);
  assert.equal(host.snap.room.mix, true);
  assert.equal(host.lobby({ op: 'start' }), true);
  assert.deepEqual(names(host), order, 'erste Runde: Reihenfolge wie beigetreten');
  assert.equal(w.game.mixed, false);
  for (let round = 0; round < 12; round++) {
    const loser = round % order.length, loserName = order[loser], winnerName = order[(loser + 1) % order.length];
    const winsBefore = {};
    order.forEach((nm, i) => { winsBefore[nm] = host.snap.room.wins[i]; });
    finish(w, host, loser);
    assert.equal(host.lobby(round % 3 === 2 ? { op: 'toLobby' } : { op: 'rematch' }), true);
    if (round % 3 === 2) assert.equal(host.lobby({ op: 'start' }), true);
    const now = names(host);
    assert.equal(now[0], 'Host');
    assert.deepEqual(now.slice().sort(), order.slice().sort());
    const was = ring(order);
    ring(now).forEach((e) => { const [x, y] = e.split('>'); assert.ok(!was.has(e) && !was.has(y + '>' + x), 'Runde ' + round + ': ' + e + ' saßen schon nebeneinander'); });
    assert.equal(w.game.mixed, true);
    assert.equal(w.game.startSeat, now.indexOf(loserName), 'der Verlierer beginnt auf seinem neuen Sitz');
    assert.equal(w.game.startBy, 'loser');
    assert.deepEqual(w.game.players.map((p) => p.name), now, 'Sitze der Partie = Reihenfolge im Raum');
    w.until(() => guests.every((g) => g.snap.stage === 'game' && g.snap.view && g.snap.view.seq === w.game.seq && names(g).join() === now.join()), 1000, 'Gäste haben die neue Runde');
    ['Anna', 'Ben', 'Cem'].forEach((nm, k) => {
      assert.equal(guests[k].snap.seat, now.indexOf(nm));
      assert.equal(guests[k].snap.view.you, now.indexOf(nm));
      assert.equal(guests[k].snap.view.mixed, true);
    });
    now.forEach((nm, i) => assert.equal(host.snap.room.wins[i], winsBefore[nm] + (nm === winnerName ? 1 : 0), 'Striche von ' + nm));
    order = now;
  }
});

test('Plätze mischen: zu zweit ändert sich nichts, zu dritt wechselt die Richtung; abgeschaltet bleibt alles; wer geht, fällt vorher weg', (t) => {
  const w = world(t, 4);
  const { host, guests } = room(w, ['Anna'], 0);
  assert.equal(host.lobby({ op: 'start' }), true);
  for (let i = 0; i < 4; i++) {
    finish(w, host, i % 2);
    assert.equal(host.lobby({ op: 'rematch' }), true);
    assert.deepEqual(names(host), ['Host', 'Anna']);
    assert.equal(w.game.mixed, false, 'zu zweit wird nichts gemischt');
    assert.equal(w.game.startSeat, i % 2);
  }
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  assert.equal(host.lobby({ op: 'addBot' }), true);
  assert.equal(host.lobby({ op: 'start' }), true);
  assert.deepEqual(names(host), ['Host', 'Bot Ada', 'Anna'], 'zu dritt: umgekehrte Reihenfolge');
  finish(w, host, 2);
  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.deepEqual(names(host), ['Host', 'Anna', 'Bot Ada']);
  assert.equal(w.game.startSeat, 1);
  // abschalten
  assert.equal(guests[0].lobby({ op: 'opts', mix: false }), false, 'Gäste dürfen das nicht');
  assert.equal(host.lobby({ op: 'opts', mix: false }), true);
  assert.equal(host.snap.room.mix, false);
  for (let i = 0; i < 3; i++) {
    finish(w, host, 1);
    assert.equal(host.lobby({ op: 'rematch' }), true);
    assert.deepEqual(names(host), ['Host', 'Anna', 'Bot Ada']);
    assert.equal(w.game.mixed, false);
  }
  assert.equal(host.lobby({ op: 'opts', mix: true }), true);
  // Anna geht mitten in der Partie: übrig sind zwei, es wird nicht gemischt und niemand fehlt
  guests[0].leave();
  w.until(() => host.snap.lobby.players[1].left, 500);
  finish(w, host, 0);
  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.deepEqual(names(host), ['Host', 'Bot Ada']);
  assert.equal(w.game.players.length, 2);
  assert.equal(w.game.startSeat, 0);
});

/* ================================================================== Deck-Wahl, Zugzeit */

test('Deck-Wahl: automatisch nach Spielerzahl, von Hand größer möglich, zu klein gewählt gilt das nötige; kommt bei Gästen an', (t) => {
  const w = world(t, 5);
  const { host, guests } = room(w, ['Anna'], 0);
  const anna = guests[0];
  assert.deepEqual([host.snap.room.decks, host.snap.room.decksNow], ['auto', 1]);
  for (const bad of [0, 3, '2', 'x', {}, 1.25]) assert.equal(host.lobby({ op: 'opts', decks: bad }), false, 'ungültig: ' + JSON.stringify(bad));
  assert.equal(anna.lobby({ op: 'opts', decks: 2 }), false);
  // zu zweit mit zwei Decks
  assert.equal(host.lobby({ op: 'opts', decks: 2 }), true);
  assert.deepEqual([host.snap.room.decks, host.snap.room.decksNow], [2, 2]);
  w.until(() => anna.snap.room && anna.snap.room.decks === 2 && anna.snap.room.decksNow === 2, 500, 'Deck-Wahl beim Gast');
  assert.equal(host.lobby({ op: 'start' }), true);
  assert.equal(w.game.decks, 2);
  assert.equal(w.game.stock.length, 108 - 18);
  w.until(() => anna.snap.view && anna.snap.view.decks === 2, 500);
  assert.equal(anna.snap.view.stock, 90);
  // Wahl während der Partie gilt erst für die nächste Runde
  assert.equal(host.lobby({ op: 'opts', decks: 1.5 }), true);
  assert.equal(host.snap.room.decksNow, 2, 'laufende Partie: es gilt, womit ausgeteilt wurde');
  finish(w, host, 0);
  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.equal(w.game.decks, 1.5);
  assert.equal(allCards(w.game).length, 81);
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  // automatisch: 6 → 1 Deck, 7 → 1,5, 10 → 2
  assert.equal(host.lobby({ op: 'opts', decks: 'auto' }), true);
  for (let n = 3; n <= 12; n++) {
    assert.equal(host.lobby({ op: 'addBot' }), true);
    assert.equal(host.snap.room.decksNow, n <= 6 ? 1 : n <= 9 ? 1.5 : 2, n + ' Spieler');
  }
  // ein Deck gewählt, aber 12 Spieler: es wird mit zwei gespielt
  assert.equal(host.lobby({ op: 'opts', decks: 1 }), true);
  assert.equal(host.snap.room.decksNow, 2);
  assert.equal(host.lobby({ op: 'start' }), true);
  assert.equal(w.game.decks, 2);
  assert.equal(w.game.players.length, 12);
  assert.equal(w.game.stock.length, 0);
});

test('Zugzeit: der Host wählt 20, 30 oder 50 Sekunden; gilt ab dem nächsten Zug und kommt bei Gästen an; ohne Zeitlimit bleibt es aus', (t) => {
  const w = world(t, 6);
  N.T.turn = 50000;
  const { host, guests } = room(w, ['Anna'], 0);
  const anna = guests[0];
  assert.equal(host.snap.room.turn, 50);
  for (const bad of [0, 25, '20', -20, 500]) assert.equal(host.lobby({ op: 'opts', turn: bad }), false);
  assert.equal(anna.lobby({ op: 'opts', turn: 20 }), false);
  assert.equal(host.lobby({ op: 'opts', turn: 20 }), true);
  assert.equal(host.snap.room.turn, 20);
  w.until(() => anna.snap.room && anna.snap.room.turn === 20, 500);
  assert.equal(host.lobby({ op: 'start' }), true);
  const g = w.game;
  g.startSeat = 1;
  w.until(() => anna.snap.view && anna.snap.view.phase === 'swap', 500, 'Gast hat die Runde');
  assert.equal(host.act({ t: 'ready' }), true);
  assert.equal(anna.act({ t: 'ready' }), true);
  w.until(() => g.phase === 'play', 500);
  assert.equal(host.clock().kind, 'turn');
  assert.equal(host.clock().total, 20000);
  w.until(() => anna.clock() && anna.clock().kind === 'turn', 500);
  assert.equal(anna.clock().total, 20000);
  const seq = g.seq;
  w.run(19000);
  assert.equal(g.seq, seq, 'vor Ablauf passiert nichts');
  w.run(1200);
  assert.ok(g.seq > seq && g.ev.auto, 'nach 20 s wurde für den Spieler am Zug gespielt');
  assert.equal(host.lobby({ op: 'opts', turn: 30 }), true);
  assert.equal(host.clock().total, 20000, 'der laufende Zug behält seine Zeit');
  const seq2 = g.seq;
  w.until(() => g.seq > seq2, 25000);
  assert.equal(host.clock().total, 30000);
  // T.turn = 0 schaltet das Zeitlimit ganz ab – die Wahl ändert daran nichts
  N.T.turn = 0;
  const seq3 = g.seq;
  w.until(() => g.seq > seq3 || !host.clock(), 31000);
  assert.equal(host.snap.room.turn, 0);
});

test('Zwölf am Tisch: Host und 11 Bots spielen eine ganze Runde zu Ende; danach wird gemischt und der Verlierer beginnt', (t) => {
  const w = world(t, 7);
  const { host } = room(w, [], 11);
  assert.equal(host.snap.lobby.players.length, 12);
  assert.equal(host.lobby({ op: 'start' }), true);
  const g = w.game;
  assert.equal(g.decks, 2);
  assert.equal(host.act(E.botAction(g, 0)), true);
  let steps = 0;
  while (g.phase !== 'over') {
    if (g.phase === 'play' && g.turn === 0) assert.equal(host.act(E.botAction(g, 0)), true);
    else w.run(3);
    assert.ok(++steps < 400000, 'Runde endet nicht');
  }
  assert.equal(host.snap.view.phase, 'over');
  assert.equal(host.snap.view.players.length, 12);
  const before = names(host), loserName = g.deadlock ? null : before[g.loser];
  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.notDeepEqual(names(host), before);
  if (loserName) assert.equal(w.game.startSeat, names(host).indexOf(loserName));
});
