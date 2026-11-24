'use strict';
/* Karma – Prüfung der Neuerungen vom 22.11.2026:
 *   - „Bereit“ zurücknehmen (unready) und verzögerter Rundenbeginn (holdStart / startPlay)
 *   - automatischer Zug bei abgelaufener Zeit (autoAction): niedrigste passende Karte, Sonderkarten zuletzt
 *   - Zeitlimits des Hosts (net.js): Zug, Tauschphase, Countdown wenn alle bereit sind; Uhr beim Gast
 *
 * Ausführen:  node --test test/timer.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const E = require(path.join(__dirname, '..', 'src', 'engine.js'));
const N = require(path.join(__dirname, '..', 'src', 'net.js'));
N.T.mix = false;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const two = (opts) => E.createGame([{ name: 'A' }, { name: 'B' }], Object.assign({ rng: mulberry32(7), startSeat: 0 }, opts || {}));
/* Laufende Zweier-Partie mit frei gesetzten Karten von Sitz 0 (Kartenerhaltung spielt für diese Einzelprüfungen keine Rolle). */
function playing(p0, pile, p1) {
  const g = two();
  E.applyAction(g, 0, { t: 'ready' }); E.applyAction(g, 1, { t: 'ready' });
  assert.equal(g.phase, 'play');
  Object.assign(g.players[0], { hand: [], up: [null, null, null], down: [null, null, null] }, p0);
  Object.assign(g.players[1], { hand: ['C12', 'C13'], up: [null, null, null], down: [null, null, null] }, p1 || {});
  g.pile = pile.slice(); g.stock = []; g.turn = 0;
  return g;
}

/* ---------- Regelkern ---------- */

test('unready: nimmt „Bereit“ zurück und macht den eigenen Tausch rückgängig; danach ist ein anderer Tausch möglich', () => {
  const g = two();
  const hand0 = g.players[0].hand.slice(), up0 = g.players[0].up.slice();
  assert.deepEqual(E.applyAction(g, 0, { t: 'unready' }), { ok: false, err: 'not-ready' });
  assert.ok(E.applyAction(g, 0, { t: 'ready', swap: { hand: hand0[1], up: 2 } }).ok);
  assert.equal(g.players[0].up[2], hand0[1]);
  assert.ok(g.players[0].hand.includes(up0[2]));
  assert.ok(E.applyAction(g, 0, { t: 'unready' }).ok);
  assert.deepEqual(g.ev.t, 'unready');
  assert.deepEqual(g.ev.swap, { slot: 2 });
  assert.deepEqual(g.players[0].up, up0, 'offene Karten wie vor dem Tausch');
  assert.deepEqual(g.players[0].hand.slice().sort(), hand0.slice().sort(), 'Hand wie vor dem Tausch');
  assert.equal(g.players[0].ready, false);
  assert.equal(E.viewFor(g, 1).players[0].ready, false);
  // ohne Tausch bereit und zurück: nichts ändert sich
  assert.ok(E.applyAction(g, 0, { t: 'ready' }).ok);
  assert.ok(E.applyAction(g, 0, { t: 'unready' }).ok);
  assert.equal(g.ev.swap, null);
  assert.deepEqual(g.players[0].up, up0);
  // anderer Tausch
  assert.ok(E.applyAction(g, 0, { t: 'ready', swap: { hand: hand0[0], up: 0 } }).ok);
  assert.equal(g.players[0].up[0], hand0[0]);
  // läuft die Runde, gibt es kein Zurück mehr
  assert.ok(E.applyAction(g, 1, { t: 'ready' }).ok);
  assert.equal(g.phase, 'play');
  assert.deepEqual(E.applyAction(g, 0, { t: 'unready' }), { ok: false, err: 'wrong-phase' });
});

test('holdStart: sind alle bereit, läuft die Runde erst nach startPlay(); bis dahin geht „Zurück“; startPlay(force) beginnt auch ohne alle', () => {
  let g = two({ holdStart: true });
  assert.equal(E.viewFor(g, 0).allReady, false);
  assert.ok(E.applyAction(g, 0, { t: 'ready' }).ok);
  assert.deepEqual(E.startPlay(g, false), { ok: false, err: 'not-ready' });
  assert.ok(E.applyAction(g, 1, { t: 'ready' }).ok);
  assert.equal(g.phase, 'swap', 'noch nicht gestartet');
  assert.equal(g.ev.t, 'ready'); assert.equal(g.ev.all, true);
  assert.equal(E.viewFor(g, 0).allReady, true);
  assert.equal(E.applyAction(g, 0, { t: 'pickup' }).ok, false, 'in der Tauschphase wird nicht gespielt');
  assert.ok(E.applyAction(g, 1, { t: 'unready' }).ok, 'Zurück geht noch');
  assert.equal(E.viewFor(g, 0).allReady, false);
  assert.deepEqual(E.startPlay(g, false), { ok: false, err: 'not-ready' });
  assert.ok(E.applyAction(g, 1, { t: 'ready' }).ok);
  const seq = g.seq;
  assert.ok(E.startPlay(g, false).ok);
  assert.equal(g.phase, 'play'); assert.equal(g.turn, 0);
  assert.equal(g.seq, seq + 1);
  assert.deepEqual({ t: g.ev.t, forced: g.ev.forced }, { t: 'start', forced: false });
  assert.deepEqual(E.startPlay(g, true), { ok: false, err: 'wrong-phase' });
  // erzwungen: niemand war bereit
  g = two({ holdStart: true });
  const before = JSON.stringify(g.players.map((p) => [p.hand, p.up, p.down]));
  assert.ok(E.startPlay(g, true).ok);
  assert.equal(g.phase, 'play');
  assert.equal(g.ev.forced, true);
  assert.ok(g.players.every((p) => p.ready));
  assert.equal(JSON.stringify(g.players.map((p) => [p.hand, p.up, p.down])), before, 'jeder spielt mit den Karten, die er hatte');
});

test('autoAction: niedrigste passende Karte einzeln; Sonderkarten 2, 7, 10, Joker erst zuletzt; sonst aufnehmen', () => {
  const cases = [
    [{ hand: ['H9', 'S2', 'D5', 'JB', 'C5'] }, ['S4'], { t: 'play', cards: ['D5'] }, 'niedrigste normale Karte, nur eine davon'],
    [{ hand: ['H14', 'S2', 'H12', 'H7'] }, ['S11'], { t: 'play', cards: ['H12'] }, 'Dame vor Ass, Sonderkarten bleiben'],
    [{ hand: ['S2', 'H7', 'H10', 'JB'] }, ['S13'], { t: 'play', cards: ['S2'] }, 'nur Sonderkarten: erst die 2'],
    [{ hand: ['H10', 'H7', 'JR'] }, ['S13'], { t: 'play', cards: ['H7'] }, 'dann die 7'],
    [{ hand: ['JR', 'H10', 'JB'] }, ['S13'], { t: 'play', cards: ['H10'] }, 'dann die 10'],
    [{ hand: ['JR', 'JB'] }, ['S13'], { t: 'play', cards: ['JB'] }, 'schwarzer Joker vor dem roten'],
    [{ hand: ['H3', 'H8'] }, ['S7'], { t: 'play', cards: ['H3'] }, 'nach einer 7: unter 7'],
    [{ hand: ['H8', 'H9'] }, ['S7'], { t: 'pickup' }, 'nach einer 7 passt nichts: aufnehmen'],
    [{ hand: ['H4', 'D6'] }, ['S9'], { t: 'pickup' }, 'nichts passt: aufnehmen'],
    [{ hand: ['H4', 'JR'] }, ['S9', 'JB'], { t: 'play', cards: ['JR'] }, 'auf den schwarzen Joker geht nur der rote'],
    [{ hand: ['H4', 'S2'] }, ['S9', 'JR'], { t: 'pickup' }, 'roter Joker: aufnehmen'],
    [{ hand: ['H9', 'D4'] }, [], { t: 'play', cards: ['D4'] }, 'leerer Stapel: niedrigste Karte'],
    [{ up: ['H8', 'D8', 'C4'] }, ['S6'], { t: 'play', cards: ['H8'] }, 'offene Karten: genau eine'],
    [{ up: ['H4', null, 'C5'] }, ['S9'], { t: 'pickup' }, 'offene Karten passen nicht: aufnehmen'],
    [{ down: ['H4', 'D9', 'C5'] }, ['S9', 'JR'], { t: 'pickup' }, 'verdeckt gegen den roten Joker: aufnehmen']
  ];
  for (const [p0, pile, exp, label] of cases) {
    const g = playing(p0, pile);
    const a = E.autoAction(g, 0);
    assert.deepEqual(a, exp, label);
    assert.ok(E.applyAction(g, 0, a).ok, label + ': der Zug ist erlaubt');
  }
  // verdeckte Karten: eine zufällige der vorhandenen
  const seen = new Set();
  for (const r of [0, 0.2, 0.49, 0.5, 0.99, 0.999999]) {
    const g = playing({ down: ['H4', null, 'C5'] }, ['S9']);
    const a = E.autoAction(g, 0, () => r);
    assert.equal(a.t, 'flip'); assert.ok(a.slot === 0 || a.slot === 2);
    seen.add(a.slot);
    assert.ok(E.applyAction(g, 0, a).ok);
  }
  assert.deepEqual([...seen].sort(), [0, 2], 'beide vorhandenen Plätze kommen vor');
  // nicht am Zug / Tauschphase: kein Zug
  assert.equal(E.autoAction(playing({ hand: ['H4'] }, []), 1), null);
  assert.equal(E.autoAction(two(), 0), null);
});

test('autoAction: 300 Partien (2–6 Spieler) nur mit Timer-Zügen – jeder Zug ist erlaubt, jede Partie endet', () => {
  let over = 0, moves = 0;
  for (let i = 0; i < 300; i++) {
    const n = 2 + (i % 5), rng = mulberry32(1000 + i);
    const g = E.createGame(Array.from({ length: n }, (_, k) => ({ name: 'P' + k })), { rng, holdStart: true });
    assert.ok(E.startPlay(g, true).ok);
    let guard = 0;
    while (g.phase === 'play' && guard++ < 5000) {
      const a = E.autoAction(g, g.turn, rng);
      assert.ok(a, 'Partie ' + i + ': der Spieler am Zug bekommt immer einen Zug');
      if (a.t === 'play') assert.equal(a.cards.length, 1);
      const r = E.applyAction(g, g.turn, a);
      assert.ok(r.ok, 'Partie ' + i + ': ' + JSON.stringify(a) + ' → ' + r.err);
      moves++;
    }
    assert.equal(g.phase, 'over', 'Partie ' + i + ' endet (regulär oder als festgefahren erkannt)');
    over++;
  }
  assert.equal(over, 300);
  assert.ok(moves > 10000);
});

test('Verdeckte Karte passt nicht: nur der Besitzer sieht sie – in jeder fremden Sicht fehlt sie', () => {
  const g = playing({ down: ['H4', 'D9', 'C5'] }, ['S12'], { hand: ['C13'] });
  assert.ok(E.applyAction(g, 0, { t: 'flip', slot: 2 }).ok);
  assert.equal(g.ev.t, 'flipfail');
  assert.equal(E.viewFor(g, 0).ev.card, 'C5');
  const other = E.viewFor(g, 1);
  assert.equal(other.ev.card, null);
  assert.equal(JSON.stringify(other).includes('C5'), false, 'die Karte steht nirgends in der Sicht des Gegners');
  assert.equal(other.players[0].n, 2, 'die Anzahl der Handkarten ist öffentlich');
  assert.equal(g.ev.card, 'C5', 'der Spielstand selbst bleibt vollständig');
});

/* ---------- Raum-Logik: Zeitlimits ---------- */

function world(t, T) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1750000000000 });
  const orig = Object.assign({}, N.T), realRandom = Math.random;
  Object.assign(N.T, { tick: 5, ping: 40, hostDead: 100000, playerDead: 100000, resend: 20, hello: 20, joinTimeout: 200, bot: 4, sweep: 1000, turn: 500, swap: 600, start: 30 }, T || {});
  Math.random = mulberry32(11);
  N.memBus.rooms = {}; N.memBus.drop = 0; N.memBus.delay = 0;
  const sessions = [];
  t.after(() => { sessions.forEach((s) => s.leave(true)); Object.assign(N.T, orig); Math.random = realRandom; });
  const w = {
    session() { const s = N.createSession({ engine: E, transport: 'mem', onUpdate() {} }); sessions.push(s); return s; },
    run(ms) { t.mock.timers.tick(ms); },
    until(cond, max, label) { let n = 0; while (!cond()) { if (n++ > max) assert.fail('nicht erreicht: ' + label); t.mock.timers.tick(1); } }
  };
  return w;
}

test('Zeitlimit Tauschphase: Uhr läuft ab Rundenbeginn; alle bereit → kurzer Countdown, „Zurück“ bricht ihn ab; danach beginnt die Runde', (t) => {
  const w = world(t), host = w.session();
  host.host('Anna');
  assert.equal(host.clock(), null, 'in der Lobby läuft keine Uhr');
  host.lobby({ op: 'addBot' });
  host.lobby({ op: 'start' });
  const t0 = Date.now();
  assert.equal(host.snap.view.phase, 'swap');
  assert.equal(host.snap.view.players[1].ready, true, 'der Bot ist sofort bereit');
  assert.deepEqual(host.clock(), { end: t0 + 600, total: 600, kind: 'swap' });
  w.run(100);
  assert.ok(host.act({ t: 'ready' }));
  assert.equal(host.snap.view.phase, 'swap', 'noch nicht gestartet');
  assert.equal(host.snap.view.allReady, true);
  assert.deepEqual(host.clock(), { end: t0 + 130, total: 30, kind: 'start' });
  w.run(20);
  assert.ok(host.act({ t: 'unready' }), 'Zurück während des Countdowns');
  assert.deepEqual(host.clock(), { end: t0 + 600, total: 600, kind: 'swap' }, 'die Minute läuft weiter, sie beginnt nicht neu');
  w.run(50);
  assert.equal(host.snap.view.phase, 'swap', 'der abgebrochene Countdown startet nichts');
  assert.ok(host.act({ t: 'ready' }));
  assert.equal(host.clock().end, Date.now() + 30);
  w.run(29);
  assert.equal(host.snap.view.phase, 'swap');
  w.run(1);
  assert.equal(host.snap.view.phase, 'play', 'nach dem Countdown läuft die Runde');
  assert.equal(host.clock().kind, 'turn');
});

test('Zeitlimit Tauschphase: nach Ablauf beginnt die Runde, auch wenn jemand nicht bereit ist', (t) => {
  const w = world(t), host = w.session();
  host.host('Anna'); host.lobby({ op: 'addBot' }); host.lobby({ op: 'start' });
  const mine = JSON.stringify([host.snap.view.players[0].hand.slice().sort(), host.snap.view.players[0].up]);
  w.run(599);
  assert.equal(host.snap.view.phase, 'swap');
  assert.equal(host.snap.view.players[0].ready, false);
  w.run(1);
  const v = host.snap.view;
  assert.equal(v.phase, 'play');
  assert.deepEqual({ t: v.ev.t, forced: v.ev.forced }, { t: 'start', forced: true });
  assert.equal(JSON.stringify([v.players[0].hand.slice().sort(), v.players[0].up]), mine, 'ohne Tausch, mit den eigenen Karten');
  assert.equal(host.act({ t: 'unready' }), false, 'jetzt gibt es kein Zurück mehr');
  // kurz vor Ablauf bereit: der Countdown reicht nicht über die Minute hinaus
  const h2 = w.session();
  h2.host('Cem'); h2.lobby({ op: 'addBot' }); h2.lobby({ op: 'start' });
  const t0 = Date.now();
  w.run(590);
  h2.act({ t: 'ready' });
  assert.deepEqual(h2.clock(), { end: t0 + 600, total: 30, kind: 'start' });
  w.run(10);
  assert.equal(h2.snap.view.phase, 'play');
});

test('Zeitlimit Zug: nach T.turn zieht der Host für den Spieler am Zug (ev.auto); die Uhr beginnt mit jedem neuen Stand neu – auch nach dem Aufnehmen', (t) => {
  const w = world(t), host = w.session();
  host.host('Anna'); host.lobby({ op: 'addBot' }); host.lobby({ op: 'start' });
  host.act({ t: 'ready' });
  w.run(30);
  let autos = 0, pickups = 0, rounds = 0;
  while (host.snap.view.phase === 'play' && rounds++ < 400) {
    w.until(() => host.snap.view.phase !== 'play' || host.snap.view.turn === 0, 200, 'Anna kommt dran');
    if (host.snap.view.phase !== 'play') break;
    const v0 = host.snap.view, c = host.clock();
    assert.deepEqual({ total: c.total, kind: c.kind }, { total: 500, kind: 'turn' });
    assert.ok(c.end > Date.now() && c.end <= Date.now() + 500);
    w.run(c.end - Date.now() - 1);
    assert.equal(host.snap.view.seq, v0.seq, 'bis zum Ablauf passiert nichts');
    w.run(1);
    const v1 = host.snap.view;
    assert.equal(v1.seq, v0.seq + 1, 'genau ein Zug');
    assert.equal(v1.ev.seat, 0); assert.equal(v1.ev.auto, true);
    autos++;
    if (v1.ev.t === 'pickup' || v1.ev.t === 'flipfail') {
      pickups++;
      if (v1.phase === 'play') {
        assert.equal(v1.turn, 0, 'nach dem Aufnehmen bleibt Anna am Zug');
        assert.equal(host.clock().end, Date.now() + 500, 'und hat wieder die volle Zeit');
      }
    }
  }
  assert.ok(autos >= 10, 'viele Timer-Züge: ' + autos);
  assert.ok(pickups >= 1, 'auch automatisches Aufnehmen kam vor');
});

test('Zeitlimit beim Gast: die Uhr kommt mit jedem Stand an; läuft sie ab, wird auch für den Gast gezogen; eigene Züge tragen kein auto', (t) => {
  const w = world(t), host = w.session(), guest = w.session();
  const code = host.host('Anna');
  assert.ok(guest.join(code, 'Ben'));
  w.until(() => guest.snap.stage === 'lobby', 300, 'Ben ist in der Lobby');
  assert.equal(guest.clock(), null);
  host.lobby({ op: 'start' });
  w.until(() => guest.snap.stage === 'game', 100, 'Ben sieht das Spiel');
  assert.equal(guest.clock().kind, 'swap');
  assert.ok(Math.abs(guest.clock().end - host.clock().end) <= 5, 'gleiche Restzeit wie beim Host');
  host.act({ t: 'ready' });
  guest.act({ t: 'ready' });
  w.until(() => guest.snap.view.allReady, 100, 'alle bereit');
  assert.equal(guest.clock().kind, 'start');
  guest.act({ t: 'unready' });
  w.until(() => !guest.snap.view.players[1].ready && guest.snap.pending === 0, 100, 'Ben ist wieder nicht bereit');
  assert.equal(host.snap.view.phase, 'swap');
  assert.equal(guest.clock().kind, 'swap');
  guest.act({ t: 'ready' });
  w.until(() => guest.snap.view.phase === 'play', 200, 'die Runde läuft');
  // Wer am Zug ist, lässt die Zeit ablaufen
  for (let i = 0; i < 6 && host.snap.view.phase === 'play'; i++) {
    const seat = host.snap.view.turn, seq = host.snap.view.seq;
    assert.equal(guest.clock().kind, 'turn');
    assert.ok(Math.abs(guest.clock().end - host.clock().end) <= 5);
    w.run(host.clock().end - Date.now());
    assert.equal(host.snap.view.seq, seq + 1);
    assert.deepEqual({ seat: host.snap.view.ev.seat, auto: host.snap.view.ev.auto }, { seat, auto: true });
    w.until(() => guest.snap.view.seq === seq + 1, 100, 'Ben sieht den Timer-Zug');
    assert.equal(guest.snap.view.ev.auto, true);
  }
  // Ein eigener Zug vor Ablauf: kein auto, und die Uhr beginnt neu
  w.until(() => host.snap.view.phase !== 'play' || host.snap.view.turn === 0, 5000, 'Anna am Zug');
  if (host.snap.view.phase === 'play') {
    w.run(200);
    const a = E.autoAction({ players: [], phase: 'x' }, 0) || null;
    assert.equal(a, null);
    const my = host.snap.view.my, me = host.snap.view.players[0];
    const act = my.zone === 'down' ? (my.canFlip ? { t: 'flip', slot: me.down.indexOf(true) } : { t: 'pickup' })
      : my.playable.length ? { t: 'play', cards: [my.playable[0]] } : { t: 'pickup' };
    assert.ok(host.act(act));
    assert.equal(host.snap.view.ev.auto, undefined);
    if (host.snap.view.phase === 'play') assert.equal(host.clock().end, Date.now() + 500);
  }
});

test('Ohne Zeitlimit (T.turn = 0, T.swap = 0, T.start = 0): keine Uhr, die Runde beginnt sofort, niemand wird gezogen', (t) => {
  const w = world(t, { turn: 0, swap: 0, start: 0 }), host = w.session();
  host.host('Anna'); host.lobby({ op: 'addBot' }); host.lobby({ op: 'start' });
  assert.equal(host.clock(), null);
  w.run(5000);
  assert.equal(host.snap.view.phase, 'swap');
  host.act({ t: 'ready' });
  assert.equal(host.snap.view.phase, 'play', 'sofort gestartet');
  w.until(() => host.snap.view.turn === 0, 200, 'Anna am Zug');
  const seq = host.snap.view.seq;
  assert.equal(host.clock(), null);
  w.run(60000);
  assert.equal(host.snap.view.seq, seq, 'ohne Zeitlimit wartet das Spiel');
});
