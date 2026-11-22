'use strict';
/* Karma – Prüfung der Raum-Logik (src/net.js) über den In-Process-Transport 'mem'.
 *
 * Alles läuft mit künstlicher Zeit (node:test mock timers) und festem Zufall (Math.random, Kartenmischung),
 * dadurch sind auch die Tests mit Nachrichtenverlust, Verzögerung und Umsortierung reproduzierbar.
 * "Neu laden" eines Geräts wird simuliert, indem der alte Transport hart geschlossen und der Speicher-Zugriff
 * der alten Sitzung abgeklemmt wird (kein leave(), kein Abschiedsgruß) – danach neue Sitzung + resume().
 *
 * Stand der Schnittstelle (siehe Kommentar über session.lobby in net.js):
 *   Host-Befehle addBot, kick, start, rematch, toLobby, auto. Es gibt keine Regel-Schalter und keinen von Hand
 *   gesetzten Startspieler mehr: die erste Runde wird ausgelost, danach beginnt der Verlierer der Vorrunde
 *   (lobby.starter in der Lobby, view.startBy/startSeat im Spiel). Aufgeben läuft als normale Spielaktion {t:'giveup'}.
 *
 * Stellungen werden auf zwei Wegen gezielt hergestellt, beide erhalten die 54 Karten:
 *   w.rig(g)   beim Geben (vor der Tauschphase) – z. B. rigQuick(): Nachziehstapel leer, bestimmte Sitze halten nur eine 2
 *   setZone()  am laufenden Spiel des Hosts (nur wo danach ohnehin der Host den nächsten Stand verschickt)
 *
 * Rundennummer (net.js): jeder Stand trägt round, der Gast schickt sie als r mit jeder Aktion; der Host bestätigt
 *   eine Aktion mit fremder Rundennummer, wendet sie aber nicht an (Aktionen ohne r zählen weiter).
 *   Kennungen 'local' und 'bot-…' sind reserviert: ein hello damit wird mit 'unknown' abgelehnt.
 * Extra-Zug (engine.js): nach der eigenen 3 zu zweit (view.again) ist Aufnehmen nicht erlaubt – humanStep() spielt
 *   nur, was view.my anbietet, und prüft das bei jedem Extra-Zug.
 *
 * Ausführen:  node --test test/session.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const E = require(path.join(__dirname, '..', 'src', 'engine.js'));
const N = require(path.join(__dirname, '..', 'src', 'net.js'));

const T_ORIG = Object.assign({}, N.T);
const FAST = { tick: 5, ping: 40, hostDead: 250, playerDead: 250, resend: 20, hello: 20, joinTimeout: 200, bot: 4, sweep: 25, turn: 0, swap: 0, start: 0 };   // Zeitlimits aus; die Tests dazu schalten sie gezielt ein
const ALL_IDS = E.fullDeck();
const IDLE = { stage: 'idle', error: null, code: null, isHost: false, seat: -1, conn: 'offline', hostOnline: false, pending: 0, lobby: null, view: null, room: null };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const person = (name, o) => Object.assign({ name, bot: false, auto: false, left: false, online: true }, o || {});

/* localStorage-Ersatz. Jede Sitzung bekommt einen eigenen Zugriff, der sich abklemmen lässt (= Seite wurde neu geladen). */
function makeStore() {
  const data = {};
  return {
    data,
    handle() {
      let live = true;
      return {
        getItem: (k) => (live && Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
        setItem: (k, v) => { if (live) data[k] = String(v); },
        removeItem: (k) => { if (live) delete data[k]; },
        detach() { live = false; }
      };
    },
    saved() { return data[N.STORE_KEY] ? JSON.parse(data[N.STORE_KEY]) : null; }
  };
}

function world(t, opts) {
  opts = opts || {};
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1750000000000 });
  Object.assign(N.T, FAST);
  const realRandom = Math.random;
  Math.random = mulberry32(opts.seed || 1);
  N.memBus.rooms = {}; N.memBus.drop = 0; N.memBus.delay = 0;
  const kinds = [];
  const w = { jitter: 0, published: [], applied: [], games: [], game: null, rig: null, onPublish: null, sessions: [], dealRng: mulberry32((opts.seed || 1) * 7919 + 3) };

  /* Engine mit festem Mischen; merkt sich das laufende Spiel und jede angewandte Aktion
   * (mit Zeitpunkt, Phase und dem Ereignis, das unmittelbar davor galt). */
  w.engine = Object.assign({}, E, {
    createGame(players, o) {
      const g = E.createGame(players, Object.assign({}, o, { rng: w.dealRng }));
      if (w.rig) w.rig(g);
      w.games.push(g); w.game = g;
      return g;
    },
    applyAction(g, seat, a) {
      const before = clone(g.ev), phase = g.phase;
      const r = E.applyAction(g, seat, a);
      w.applied.push({ seat, a: a === undefined ? null : clone(a), ok: r.ok, err: r.err, at: Date.now(), phase, before, game: w.games.indexOf(g) });
      return r;
    }
  });

  w.session = (label, storeHandle) => {
    const kind = 'test-' + (kinds.length + 1) + '-' + label;
    kinds.push(kind);
    const port = { label, muted: false, tr: null };
    N.transports[kind] = (code) => {
      const tr = N.transports.mem(code);
      const pub = tr.publish, del = tr._deliver;
      tr.publish = (ch, obj) => {
        if (port.muted) return;
        const rec = { from: label, ch, msg: obj };
        if (w.onPublish) w.onPublish(rec);
        w.published.push({ from: label, ch, t: obj && obj.t, n: obj && obj.n, ver: obj && obj.ver, epoch: obj && obj.epoch, why: obj && obj.why });
        pub(ch, obj);
      };
      tr._deliver = (ch, data) => {
        if (port.muted) return;
        if (w.jitter > 0) setTimeout(() => { if (!port.muted) del(ch, data); }, Math.floor(Math.random() * w.jitter));
        else del(ch, data);
      };
      port.tr = tr;
      return tr;
    };
    const sess = N.createSession({ engine: w.engine, transport: kind, storage: storeHandle || null, onUpdate: () => { sess.updates++; } });
    sess.updates = 0;
    sess.label = label;
    sess.port = port;
    sess.store = storeHandle || null;
    sess.sent = [];           // was der "Mensch" über act() abgeschickt hat
    sess.kill = () => { port.muted = true; if (port.tr) port.tr.close(); if (storeHandle) storeHandle.detach(); };
    w.sessions.push(sess);
    return sess;
  };
  /* Roher Transport, um Nachrichten direkt auf den Bus zu legen (Duplikate, Umsortierung, Angriffe). */
  w.raw = (code) => { const tr = N.transports.mem(code); tr.onMessage = () => {}; tr.start(); return tr; };
  w.run = (ms) => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
  w.until = (pred, maxMs, what) => {
    for (let i = 0; i <= (maxMs || 3000); i++) { if (pred()) return i; t.mock.timers.tick(1); }
    assert.fail('Zeitüberschreitung (' + (maxMs || 3000) + ' ms virtuell): ' + (what || pred.toString()));
  };
  /* Menschen "spielen": jede ms prüfen alle angegebenen Sitzungen, ob sie dran sind. */
  w.play = (sessions, pred, maxMs, what, rnd) => {
    rnd = rnd || w.humanRng || (w.humanRng = mulberry32((opts.seed || 1) * 31 + 5));
    for (let i = 0; i <= (maxMs || 60000); i++) {
      if (pred()) return i;
      for (const s of sessions) humanStep(s, rnd);
      t.mock.timers.tick(1);
    }
    assert.fail('Zeitüberschreitung beim Spielen (' + (maxMs || 60000) + ' ms virtuell): ' + (what || pred.toString()));
  };
  /* Alle Gäste haben den aktuellen Stand des laufenden Spiels und nichts mehr offen. */
  w.synced = (guests) => guests.every((g) => g.snap.stage === 'game' && g.snap.view && g.snap.view.seq === w.game.seq && g.snap.view.phase === w.game.phase && g.snap.pending === 0);

  t.after(() => {
    Math.random = realRandom;
    Object.assign(N.T, T_ORIG);
    N.memBus.rooms = {}; N.memBus.drop = 0; N.memBus.delay = 0;
    kinds.forEach((k) => { delete N.transports[k]; });
  });
  return w;
}

/* Ein Mensch am Gerät: handelt nur anhand seiner eigenen Sicht (snap.view) und nur, wenn nichts mehr unbestätigt ist.
 * Legt irgendeine passende Karte, deckt sonst blind auf, nimmt sonst auf – und nimmt gelegentlich freiwillig auf,
 * obwohl er legen könnte (erlaubter taktischer Zug). */
function humanStep(sess, rnd) {
  const sn = sess.snap;
  if (sn.stage !== 'game' || !sn.view || sn.pending) return false;
  const v = sn.view, me = v.players[sn.seat];
  let a = null;
  if (v.phase === 'swap') {
    if (me.ready) return false;
    a = rnd() < 0.5 ? { t: 'ready' } : { t: 'ready', swap: { hand: me.hand[Math.floor(rnd() * me.hand.length)], up: Math.floor(rnd() * 3) } };
  } else if (v.phase === 'play' && v.turn === sn.seat && v.my) {
    const my = v.my;
    // Nur was die Sicht anbietet: im Extra-Zug nach der eigenen 3 zu zweit (view.again) ist canPickup false.
    if (v.again) assert.deepEqual([my.canPickup, my.forced, my.playable.length > 0 || my.canFlip], [false, false, true], 'Extra-Zug nach eigener 3: kein Aufnehmen, aber immer ein anderer Zug');
    if (my.canPickup && !my.forced && rnd() < 0.03) a = { t: 'pickup' };
    else if (my.playable.length) a = { t: 'play', cards: [my.playable[Math.floor(rnd() * my.playable.length)]] };
    else if (my.canFlip) { const slots = [0, 1, 2].filter((i) => me.down[i]); a = { t: 'flip', slot: slots[Math.floor(rnd() * slots.length)] }; }
    else if (my.canPickup) a = { t: 'pickup' };
    else assert.fail('die Sicht bietet ' + sess.label + ' keinen Zug an: ' + JSON.stringify(my));
  }
  if (!a) return false;
  const ok = sess.act(a);
  if (ok || !sn.isHost) sess.sent.push(clone(a));
  return true;
}

/* Karten gezielt verteilen (für deterministische Stellungen); die 54 Karten bleiben erhalten:
 * getauscht wird immer nur der Platz zweier Karten, Überzähliges wandert zu den entfernten Karten (burned). */
function locate(g, id) {
  for (const p of g.players) for (const z of ['hand', 'up', 'down']) { const i = p[z].indexOf(id); if (i >= 0) return { arr: p[z], i }; }
  for (const z of ['stock', 'pile', 'burned']) { const i = g[z].indexOf(id); if (i >= 0) return { arr: g[z], i }; }
  throw new Error('Karte nicht gefunden: ' + id);
}
function setZone(g, seat, zone, cards) {
  const tgt = g.players[seat][zone];
  cards.forEach((id, k) => {
    assert.ok(k < tgt.length && tgt[k], 'setZone: Platz ' + k + ' in ' + zone + ' von Sitz ' + seat + ' ist leer');
    const loc = locate(g, id); const tmp = tgt[k]; tgt[k] = id; loc.arr[loc.i] = tmp;
  });
}
function trimHand(g, seat, keep) { const h = g.players[seat].hand; while (h.length > keep) g.burned.push(h.pop()); }
function clearTable(g, seat) {
  const p = g.players[seat];
  for (const z of ['up', 'down']) for (let i = 0; i < 3; i++) if (p[z][i]) { g.burned.push(p[z][i]); p[z][i] = null; }
}
function burnStock(g) { g.burned.push(...g.stock.splice(0)); }
function cardCount(g) {
  const all = [];
  for (const p of g.players) { all.push(...p.hand, ...p.up.filter(Boolean), ...p.down.filter(Boolean)); }
  all.push(...g.pile, ...g.burned, ...g.stock);
  return { n: all.length, uniq: new Set(all).size };
}
/* Eine Runde, die sich mit wenigen Zügen entscheiden lässt: der Nachziehstapel ist leer und die genannten Sitze
 * (höchstens vier) halten nur noch eine einzige 2 – die darf auf alles außer auf einen Joker und macht sie fertig.
 * extra(g) kann vorher weitere Hände festlegen. */
function rigQuick(finishers, extra) {
  const twos = ['S2', 'H2', 'D2', 'C2'];
  return (g) => {
    finishers.forEach((seat, k) => setZone(g, seat, 'hand', [twos[k]]));
    if (extra) extra(g);
    finishers.forEach((seat) => { trimHand(g, seat, 1); clearTable(g, seat); });
    burnStock(g);
    assert.deepEqual(cardCount(g), { n: 54, uniq: 54 });
  };
}

/* Öffentlicher Teil einer Sicht – muss bei allen Teilnehmern gleich sein. */
function publicPart(view) {
  return {
    phase: view.phase, turn: view.turn, dir: view.dir, startSeat: view.startSeat, startBy: view.startBy,
    pile: view.pile, stock: view.stock, burned: view.burned, finished: view.finished, winner: view.winner, loser: view.loser,
    gaveUp: view.gaveUp, deadlock: view.deadlock, freePlay: view.freePlay, again: view.again, req: view.req, seq: view.seq, ev: view.ev,
    players: view.players.map((p) => ({ name: p.name, bot: p.bot, n: p.n, up: p.up, down: p.down, zone: p.zone, ready: p.ready, place: p.place }))
  };
}
/* Alle Gäste sehen denselben öffentlichen Stand wie der Host, die eigene Hand und sonst keine. */
function sameForAll(host, guests, g) {
  const hv = host.snap.view;
  assert.ok(hv, 'Host ist im Spiel');
  if (g) {
    assert.equal(hv.seq, g.seq);
    assert.deepEqual(hv.pile, g.pile);
    assert.deepEqual(cardCount(g), { n: 54, uniq: 54 });
  }
  for (const gs of guests) {
    const v = gs.snap.view, seat = gs.snap.seat;
    assert.equal(gs.snap.stage, 'game', gs.label + ' ist im Spiel');
    assert.equal(gs.snap.pending, 0, gs.label + ' hat nichts mehr offen');
    assert.deepEqual(publicPart(v), publicPart(hv), gs.label + ' sieht denselben öffentlichen Stand');
    assert.equal(v.you, seat);
    v.players.forEach((p, i) => {
      if (i === seat) { assert.ok(Array.isArray(p.hand) && p.hand.length === p.n, gs.label + ' sieht die eigene Hand'); if (g) assert.deepEqual(p.hand, g.players[i].hand); }
      else assert.equal(p.hand, null, gs.label + ' sieht keine fremde Hand');
      assert.ok(p.down.every((d) => typeof d === 'boolean'), gs.label + ' sieht keine verdeckte Karte');
    });
    assert.deepEqual(gs.snap.lobby, host.snap.lobby, gs.label + ' hat dieselbe Spielerliste');
  }
}

/* Prüft jede vom Host veröffentlichte Nachricht im Moment des Sendens auf geheime Karten und fremde Kennungen.
 * Wahrheit ist der Stand, den der Host gerade gespeichert hat (er speichert vor jedem Versand). */
function leakWatch(w, hostStore) {
  const st = { states: 0, views: 0, lobbies: 0, others: 0, leaks: [], missing: [], misrouted: [], flipfails: 0, phases: {}, events: {}, rounds: {} };
  const leak = (msg) => { if (st.leaks.length < 20) st.leaks.push(msg); };
  w.onPublish = (rec) => {
    if (rec.ch.indexOf('p/') !== 0) return;
    const pid = rec.ch.slice(2), m = rec.msg;
    if (m.t !== 'state') {
      st.others++;
      const text = JSON.stringify(m);
      for (const id of ALL_IDS) if (text.includes('"' + id + '"')) leak(m.t + ' an ' + pid + ' enthält ' + id);
      return;
    }
    st.states++;
    const H = hostStore.saved().H, text0 = JSON.stringify(m);
    const seat = H.players.findIndex((p) => p.pid === pid);
    if (seat !== m.seat) st.misrouted.push('Sicht von Sitz ' + m.seat + ' ging an den Spieler auf Sitz ' + seat);
    H.players.forEach((p) => { if (p.pid !== pid && p.pid.length >= 8 && text0.includes(p.pid)) leak('Nachricht an Sitz ' + seat + ' enthält die Kennung eines anderen Spielers'); });
    assert.deepEqual(Object.keys(m).sort(), ['ack', 'clock', 'epoch', 'lobby', 'room', 'round', 'seat', 't', 'ver', 'view']);
    assert.equal(m.clock, null, 'ohne Zeitlimit (T.turn/T.swap/T.start = 0) wird keine Uhr verschickt');
    assert.equal(m.round, H.round || 0, 'round ist die Rundennummer des Hosts');
    assert.ok(Number.isInteger(m.round) && m.round >= 0);
    if (m.view) assert.ok(m.round >= 1, 'eine Sicht gibt es erst ab Runde 1');
    st.rounds[m.round] = (st.rounds[m.round] || 0) + 1;
    for (const p of m.lobby.players) assert.deepEqual(Object.keys(p).sort(), ['auto', 'bot', 'left', 'name', 'online']);
    if (!m.view) {
      st.lobbies++;
      for (const id of ALL_IDS) if (text0.includes('"' + id + '"')) leak('Lobby-Nachricht enthält Karte ' + id);
      return;
    }
    st.views++;
    const g = H.game, v = m.view;
    st.phases[v.phase] = (st.phases[v.phase] || 0) + 1;
    st.events[v.ev.t] = (st.events[v.ev.t] || 0) + 1;
    const copy = clone(m);
    // Ausnahmen laut Regel: eine blind aufgedeckte, unpassende Karte und die letzte offene Karte lagen für alle
    // sichtbar auf dem Tisch, bevor sie mit dem Stapel auf die Hand gingen – sie stehen im Ereignis.
    if (copy.view.ev.t === 'flipfail') { st.flipfails++; delete copy.view.ev.card; }
    if (copy.view.ev.t === 'pickup') delete copy.view.ev.upCard;
    const text = JSON.stringify(copy);
    const where = ' (Phase ' + g.phase + ', seq ' + g.seq + ', Ereignis ' + g.ev.t + ')';
    g.players.forEach((p, i) => {
      if (i !== m.seat) {
        for (const id of p.hand) if (text.includes('"' + id + '"')) leak('Sicht für Sitz ' + m.seat + ' enthält Handkarte ' + id + ' von Sitz ' + i + where);
        if (v.players[i].hand !== null) leak('Sicht für Sitz ' + m.seat + ' hat ein Hand-Feld für Sitz ' + i + where);
      }
      for (const id of p.down) if (id && text.includes('"' + id + '"')) leak('Sicht für Sitz ' + m.seat + ' enthält verdeckte Karte ' + id + ' von Sitz ' + i + where);
      if (!v.players[i].down.every((d) => typeof d === 'boolean')) leak('Sicht für Sitz ' + m.seat + ': verdeckte Karten von Sitz ' + i + ' sind keine Ja/Nein-Werte' + where);
    });
    for (const id of g.stock) if (text.includes('"' + id + '"')) leak('Sicht für Sitz ' + m.seat + ' enthält Karte ' + id + ' aus dem Nachziehstapel' + where);
    if (typeof v.stock !== 'number' || typeof v.burned !== 'number') leak('Nachziehstapel/entfernte Karten nicht nur als Anzahl' + where);
    if (JSON.stringify(v.players[m.seat].hand) !== JSON.stringify(g.players[m.seat].hand)) st.missing.push('eigene Hand von Sitz ' + m.seat + ' stimmt nicht' + where);
    if (v.you !== m.seat) st.misrouted.push('view.you ' + v.you + ' passt nicht zum Sitz ' + m.seat);
  };
  return st;
}
function noLeaks(leak) {
  assert.deepEqual(leak.leaks.slice(0, 5), [], leak.leaks.length + ' Lecks');
  assert.deepEqual(leak.missing.slice(0, 5), []);
  assert.deepEqual(leak.misrouted.slice(0, 5), []);
}

/* Raum mit Host + benannten Gästen aufbauen (ohne Verlust), alle in der Lobby. */
function lobby(w, guestNames, o) {
  o = o || {};
  const hostStore = makeStore();
  const host = w.session('host', hostStore.handle());
  const code = host.host(o.hostName || 'Hanna');
  const guests = [], stores = [];
  guestNames.forEach((name, i) => {
    const st = makeStore();
    const g = w.session(name, st.handle());
    assert.equal(g.join(code, name), true);
    w.until(() => g.snap.stage === 'lobby' && host.snap.lobby.players.length === i + 2, 1000, name + ' tritt bei');
    guests.push(g); stores.push(st);
  });
  return { host, code, guests, stores, hostStore, pids: stores.map((s) => s.saved().pid) };
}

/* Partie starten (op 'start' oder 'rematch'), optional mit gezielter Verteilung und festem Startspieler,
 * und – wenn nicht abbestellt – alle ohne Tausch bereit melden. guests = die Gäste, die noch dabei sind. */
function begin(w, host, guests, o) {
  o = o || {};
  w.rig = (g) => { if (o.rig) o.rig(g); if (typeof o.startSeat === 'number') g.startSeat = o.startSeat; };
  assert.equal(host.lobby({ op: o.op || 'start' }), true);
  w.rig = null;
  w.until(() => guests.every((g) => g.snap.stage === 'game' && g.snap.view && g.snap.view.phase === 'swap' && g.snap.view.seq === w.game.seq), 2000, 'Spielstart bei allen');
  if (o.ready === false) return;
  assert.equal(host.act({ t: 'ready' }), true);
  guests.forEach((g) => assert.equal(g.act({ t: 'ready' }), true));
  w.until(() => w.game.phase === 'play' && w.synced(guests), 2000, 'alle bereit');
}

/* ================================================================== Kleinkram */

test('normalizeCode / cleanName', () => {
  assert.equal(N.normalizeCode('abcde'), 'ABCDE');
  assert.equal(N.normalizeCode(' ab-cd e '), 'ABCDE');
  assert.equal(N.normalizeCode('a1b0cOdIe'), 'ABCDE', 'Zeichen außerhalb des Alphabets (0, 1, I, O) fallen weg');
  assert.equal(N.normalizeCode('abcdefgh'), 'ABCDE', 'auf 5 Zeichen gekürzt');
  assert.equal(N.normalizeCode(null), '');
  assert.equal(N.normalizeCode(undefined), '');
  assert.equal(N.normalizeCode(12345), '2345');
  assert.equal(N.cleanName('  Anna   Lena  '), 'Anna Lena');
  assert.equal(N.cleanName(''), 'Spieler');
  assert.equal(N.cleanName(null), 'Spieler');
  assert.equal(N.cleanName({ toString: 1 }), 'Spieler');
  assert.equal(N.cleanName(42), '42');
  assert.equal(N.cleanName('x'.repeat(100)).length, 14);
  for (let i = 0; i < 50; i++) assert.match(N.randId(5, N.CODE_ALPHA), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
});

/* ================================================================== Beitreten */

test('Beitreten: Host eröffnet, Gäste treten per Code bei (Groß-/Kleinschreibung, Leerzeichen und Bindestrich egal)', (t) => {
  const w = world(t);
  const host = w.session('host');
  assert.deepEqual(host.snap, IDLE);
  const code = host.host('  Hanna   M.  ');
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  assert.equal(host.snap.stage, 'lobby');
  assert.equal(host.snap.isHost, true);
  assert.equal(host.snap.seat, 0);
  assert.equal(host.snap.code, code);
  assert.equal(host.snap.hostOnline, true);
  assert.equal(host.snap.view, null);
  assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna M.')] }, 'erste Runde: Startspieler wird ausgelost (starter -1)');
  w.run(2);
  assert.equal(host.snap.conn, 'online');

  const g1 = w.session('g1'), g2 = w.session('g2');
  assert.equal(g1.join(code.toLowerCase(), 'Anna'), true);
  assert.equal(g1.snap.stage, 'connecting');
  assert.equal(g1.snap.code, code);
  assert.equal(g2.join(' ' + code.slice(0, 2).toLowerCase() + '-' + code.slice(2) + ' ', 'Ben'), true);
  w.until(() => g1.snap.stage === 'lobby' && g2.snap.stage === 'lobby' && host.snap.lobby.players.length === 3 && g1.snap.lobby.players.length === 3, 1000);
  assert.equal(g1.snap.seat, 1);
  assert.equal(g2.snap.seat, 2);
  for (const g of [g1, g2]) {
    assert.equal(g.snap.isHost, false);
    assert.equal(g.snap.hostOnline, true);
    assert.equal(g.snap.conn, 'online');
    assert.equal(g.snap.error, null);
    assert.equal(g.snap.view, null);
    assert.deepEqual(g.snap.lobby, host.snap.lobby);
  }
  assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna M.'), person('Anna'), person('Ben')] });
  // zu kurzer / leerer Code wird sofort abgelehnt, die Sitzung bleibt unberührt
  const x = w.session('x');
  assert.equal(x.join('abc', 'X'), false);
  assert.equal(x.join('', 'X'), false);
  assert.equal(x.join('0O1I!', 'X'), false);
  assert.equal(x.snap.stage, 'idle');
  // Gäste dürfen keine Host-Befehle ausführen
  for (const op of [{ op: 'addBot' }, { op: 'kick', seat: 2 }, { op: 'start' }, { op: 'rematch' }, { op: 'toLobby' }, { op: 'auto', seat: 2, on: true }]) {
    assert.equal(g1.lobby(op), false, 'Gast: ' + op.op);
    assert.equal(x.lobby(op), false, 'ohne Raum: ' + op.op);
  }
  // Die abgeschafften Befehle (fester Startspieler, Regel-Schalter) nimmt auch der Host nicht mehr an
  const before = clone(host.snap.lobby);
  for (const op of [{ op: 'setStart', seat: 1 }, { op: 'setRule', key: 'tenAlways', value: true }, { op: 'setRule', key: 'freePickup', value: true }]) {
    assert.equal(host.lobby(op), false, 'abgeschafft: ' + op.op);
  }
  w.run(100);
  assert.deepEqual(host.snap.lobby, before);
  assert.equal(host.snap.stage, 'lobby');
  assert.equal(g1.act({ t: 'ready' }), true, 'Gast-Aktion in der Lobby wird angenommen, bewirkt aber nichts');
  assert.equal(g1.act({ t: 'giveup' }), true);
  w.until(() => g1.snap.pending === 0, 500);
  assert.equal(host.snap.stage, 'lobby');
  assert.equal(host.act({ t: 'giveup' }), false, 'Host: ohne Partie keine Spielaktion');
});

test('Beitreten: der 7. Spieler wird mit "full" abgelehnt (Bots zählen mit)', (t) => {
  const w = world(t);
  const { host, code } = lobby(w, ['A', 'B', 'C']);
  assert.equal(host.lobby({ op: 'addBot' }), true);
  assert.equal(host.lobby({ op: 'addBot' }), true);
  assert.equal(host.snap.lobby.players.length, 6);
  assert.equal(host.lobby({ op: 'addBot' }), false, 'kein 7. Platz für einen Bot');
  const late = w.session('late');
  late.join(code, 'Zu spät');
  w.until(() => late.snap.stage === 'error', 1000);
  assert.equal(late.snap.error, 'full');
  assert.equal(late.snap.view, null);
  assert.equal(late.act({ t: 'ready' }), false);
  w.run(200);
  assert.equal(host.snap.lobby.players.length, 6);
  assert.equal(late.snap.error, 'full', 'bleibt abgelehnt');
});

test('Beitreten: in ein laufendes Spiel kommt niemand mehr ("running")', (t) => {
  const w = world(t);
  const { host, code } = lobby(w, ['A']);
  assert.equal(host.lobby({ op: 'start' }), true);
  const late = w.session('late');
  late.join(code, 'Neu');
  w.until(() => late.snap.stage === 'error', 1000);
  assert.equal(late.snap.error, 'running');
  assert.equal(host.snap.lobby.players.length, 2);
  assert.equal(w.game.players.length, 2);
});

test('Beitreten: unbekannter Raum bleibt "connecting" mit Fehler "not-found" und klappt, sobald der Host erreichbar ist', (t) => {
  const w = world(t);
  const nobody = w.session('nobody');
  assert.equal(nobody.join('ZZZZZ', 'Niemand'), true);
  w.run(FAST.joinTimeout - 30);
  assert.equal(nobody.snap.stage, 'connecting');
  assert.equal(nobody.snap.error, null);
  w.run(60);
  assert.equal(nobody.snap.stage, 'connecting', 'kein Fehler-Bildschirm: es wird weiter versucht');
  assert.equal(nobody.snap.error, 'not-found');
  w.run(1000);
  assert.equal(nobody.snap.stage, 'connecting');
  assert.equal(nobody.snap.error, 'not-found');
  // Host existiert, ist aber (noch) nicht erreichbar
  const host = w.session('host');
  const code = host.host('Hanna');
  host.port.muted = true;
  const g = w.session('g');
  g.join(code, 'Gast');
  w.run(FAST.joinTimeout + 50);
  assert.equal(g.snap.stage, 'connecting');
  assert.equal(g.snap.error, 'not-found');
  host.port.muted = false;
  w.until(() => g.snap.stage === 'lobby', 500);
  assert.equal(g.snap.error, null);
  assert.equal(g.snap.seat, 1);
});

/* ================================================================== Rauswurf / Verlassen */

test('Rauswurf: der Gast sieht "kicked", die Sitze rücken auf, und er kommt mit seiner Kennung nicht wieder hinein', (t) => {
  const w = world(t);
  const { host, code, guests, stores, pids } = lobby(w, ['Anna', 'Ben', 'Cleo', 'Dora']);
  const [anna, ben, cleo, dora] = guests;
  assert.equal(host.lobby({ op: 'kick', seat: 0 }), false, 'der Host kann sich nicht selbst werfen');
  assert.equal(host.lobby({ op: 'kick' }), false, 'ohne Sitz');
  assert.equal(host.lobby({ op: 'kick', seat: 9 }), false);
  assert.equal(host.lobby({ op: 'kick', seat: -1 }), false);
  assert.equal(host.lobby({ op: 'kick', seat: 1 }), true);                // Anna fliegt
  w.until(() => anna.snap.stage === 'error', 500);
  assert.equal(anna.snap.error, 'kicked');
  assert.equal(anna.snap.lobby, null);
  assert.equal(anna.act({ t: 'ready' }), false);
  w.until(() => ben.snap.seat === 1 && cleo.snap.seat === 2 && dora.snap.seat === 3, 500);
  assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna'), person('Ben'), person('Cleo'), person('Dora')] });
  assert.deepEqual(cleo.snap.lobby, host.snap.lobby);
  assert.equal(host.lobby({ op: 'kick', seat: 3 }), true);                // Dora
  w.until(() => dora.snap.error === 'kicked' && ben.snap.lobby.players.length === 3, 500);
  assert.equal(ben.snap.seat, 1);
  assert.equal(cleo.snap.seat, 2);
  // Bots lassen sich ebenfalls entfernen
  host.lobby({ op: 'addBot' });
  assert.equal(host.snap.lobby.players[3].bot, true);
  assert.equal(host.lobby({ op: 'kick', seat: 3 }), true);
  assert.deepEqual(host.snap.lobby.players.map((p) => p.name), ['Hanna', 'Ben', 'Cleo']);
  // Der Rausgeworfene bleibt draußen: Fehler bleibt stehen, die gespeicherte Sitzung ist gelöscht …
  w.run(500);
  assert.equal(anna.snap.stage, 'error');
  assert.equal(anna.snap.error, 'kicked');
  assert.equal(stores[0].saved(), null, 'gespeicherte Sitzung des Rausgeworfenen ist gelöscht (kein Wiedereinstieg per resume)');
  assert.equal(w.session('Anna-neu', stores[0].handle()).resume(), false);
  // … und selbst mit der alten Kennung (z. B. aus einem zweiten Tab) lehnt der Host jede Nachricht mit "kicked" ab
  const raw = w.raw(code);
  const denied = () => w.published.filter((p) => p.ch === 'p/' + pids[0] && p.t === 'deny' && p.why === 'kicked').length;
  const d0 = denied();
  raw.publish('h', { pid: pids[0], t: 'hello', name: 'Anna' });
  raw.publish('h', { pid: pids[0], t: 'ping', ver: 1, epoch: 'x' });
  raw.publish('h', { pid: pids[0], t: 'act', n: 1, a: { t: 'ready' } });
  w.run(20);
  assert.equal(denied(), d0 + 3);
  assert.deepEqual(host.snap.lobby.players.map((p) => p.name), ['Hanna', 'Ben', 'Cleo']);
  // Auch im laufenden Spiel und nach einem Neuladen des Hosts bleibt die Sperre bestehen
  begin(w, host, [ben, cleo]);
  raw.publish('h', { pid: pids[0], t: 'hello', name: 'Anna' });
  raw.publish('h', { pid: pids[0], t: 'act', n: 1, a: { t: 'giveup' } });
  w.run(20);
  assert.equal(denied(), d0 + 5, 'im Spiel: "kicked", nicht "running"');
  assert.equal(w.game.phase, 'play');
  assert.equal(w.applied.filter((x) => x.a && x.a.t === 'giveup').length, 0);
  raw.close();
});

test('Rauswurf bei verlorener "kicked"-Nachricht: der Gast landet trotzdem im Fehlerzustand und kommt nicht wieder in den Raum', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  anna.port.muted = true;                       // die deny-Nachricht geht verloren
  assert.equal(host.lobby({ op: 'kick', seat: 1 }), true);
  w.run(30);
  anna.port.muted = false;
  w.until(() => anna.snap.stage === 'error', 1000, 'Anna erfährt beim nächsten Ping, dass sie draußen ist');
  assert.equal(anna.snap.error, 'kicked');
  w.run(500);
  assert.deepEqual(host.snap.lobby.players.map((p) => p.name), ['Hanna', 'Ben'], 'sie ist nicht wieder beigetreten');
  assert.equal(ben.snap.seat, 1);
});

test('Verlassen: Gast geht in der Lobby -> Platz wird frei; im Spiel -> bleibt als "left" sitzen und ein Bot spielt für ihn; Host geht -> "closed"', (t) => {
  const w = world(t);
  const { host, code, guests, stores, pids } = lobby(w, ['Anna', 'Ben', 'Cleo']);
  const [anna, ben, cleo] = guests;
  anna.leave();
  assert.deepEqual(anna.snap, IDLE);
  assert.equal(stores[0].saved(), null, 'leave löscht die gespeicherte Sitzung');
  w.until(() => host.snap.lobby.players.length === 3 && ben.snap.seat === 1 && cleo.snap.seat === 2, 500);
  assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna'), person('Ben'), person('Cleo')] });
  // im Spiel: Ben ist am Zug und geht
  begin(w, host, [ben, cleo], { startSeat: 1 });
  assert.equal(w.game.turn, 1);
  const seq0 = w.game.seq;
  ben.leave();
  w.until(() => host.snap.lobby.players[1].left, 500, 'Host bemerkt den Abschied');
  assert.deepEqual(host.snap.lobby.players[1], person('Ben', { auto: true, left: true, online: false }));
  assert.equal(host.snap.lobby.players.length, 3, 'im laufenden Spiel bleibt der Platz besetzt');
  assert.equal(host.snap.stage, 'game');
  assert.equal(w.game.players.length, 3);
  w.until(() => w.game.seq > seq0, FAST.bot + 5, 'ein Bot zieht sofort für den Gegangenen');
  const last = w.applied[w.applied.length - 1];
  assert.equal(last.seat, 1);
  assert.equal(last.ok, true);
  w.until(() => cleo.snap.lobby.players[1].left === true && cleo.snap.view.seq === w.game.seq, 500, 'auch Cleo sieht es');
  assert.deepEqual(cleo.snap.lobby, host.snap.lobby);
  // Für einen Gegangenen lässt sich der Bot nicht abschalten, und seine alte Kennung gilt nicht mehr
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: false }), false);
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: true }), false);
  const raw = w.raw(code), applied0 = w.applied.length;
  raw.publish('h', { pid: pids[1], t: 'hello', name: 'Ben' });
  raw.publish('h', { pid: pids[1], t: 'act', n: 2, a: { t: 'giveup' } });
  raw.publish('h', { pid: pids[1], t: 'ping', ver: 1, epoch: 'x' });
  w.run(3);
  assert.equal(w.published.filter((p) => p.ch === 'p/' + pids[1] && p.t === 'deny' && p.why === 'unknown').length, 3);
  assert.equal(host.snap.lobby.players[1].left, true, 'er bleibt gegangen');
  assert.equal(host.snap.lobby.players[1].online, false);
  assert.ok(w.applied.slice(applied0).every((x) => !(x.a && x.a.t === 'giveup')), 'seine Nachrichten werden nicht mehr als Aktion gewertet');
  raw.close();
  // Die Partie läuft mit Bot weiter: Host und Cleo spielen ein paar Züge, der Bot zieht jedes Mal für Ben
  const benActs = () => w.applied.filter((x) => x.seat === 1 && x.ok && x.phase === 'play').length;
  w.play([host, cleo], () => benActs() >= 3 || w.game.phase === 'over', 20000, 'Bot spielt für Ben');
  // Host schließt den Raum
  host.leave();
  assert.deepEqual(host.snap, IDLE);
  w.until(() => cleo.snap.stage === 'error', 500);
  assert.equal(cleo.snap.error, 'closed');
  assert.equal(cleo.act({ t: 'ready' }), false);
  w.run(500);   // nichts hängt nach
  assert.equal(cleo.snap.error, 'closed');
});

/* ================================================================== Lobby-Befehle */

test('Lobby: addBot, start (mind. 2 Spieler, Startspieler ausgelost), rematch (erst mit Sieger), toLobby', (t) => {
  const w = world(t);
  const host = w.session('host');
  host.host('Hanna');
  assert.equal(host.lobby({ op: 'start' }), false, 'allein kann man nicht starten');
  assert.equal(host.lobby({ op: 'rematch' }), false);
  assert.equal(host.lobby({ op: 'toLobby' }), false, 'ist schon in der Lobby');
  assert.equal(host.lobby({ op: 'gibtsnicht' }), false);
  assert.equal(host.lobby(null), false);
  assert.equal(host.lobby({}), false);
  assert.equal(host.act({ t: 'ready' }), false, 'keine Spielaktion ohne Spiel');

  assert.equal(host.lobby({ op: 'addBot' }), true);
  assert.equal(host.lobby({ op: 'addBot' }), true);
  const names = host.snap.lobby.players.map((p) => p.name);
  assert.equal(new Set(names).size, 3, 'Bots haben unterschiedliche Namen');
  assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna'), person(names[1], { bot: true }), person(names[2], { bot: true })] });

  // Start: Bots sind sofort "bereit", der Startspieler ist ausgelost
  w.rig = rigQuick([0]);                                           // Host hält nur eine 2 und kann sofort fertig werden
  assert.equal(host.lobby({ op: 'start' }), true);
  w.rig = null;
  assert.equal(host.snap.stage, 'game');
  const v = host.snap.view;
  assert.equal(v.phase, 'swap');
  assert.equal(v.startBy, 'random');
  assert.ok(v.startSeat >= 0 && v.startSeat < 3);
  assert.equal(v.canGiveUp, false);
  assert.equal(v.players.length, 3);
  assert.deepEqual(v.players.map((p) => p.name), names);
  assert.deepEqual(v.players.map((p) => p.ready), [false, true, true]);
  assert.deepEqual(v.players.map((p) => p.bot), [false, true, true]);
  assert.equal(host.snap.lobby.starter, -1);
  assert.deepEqual(cardCount(w.game), { n: 54, uniq: 54 });
  // im laufenden Spiel sind Lobby-Befehle gesperrt
  for (const op of [{ op: 'start' }, { op: 'addBot' }, { op: 'kick', seat: 1 }, { op: 'rematch' }]) {
    assert.equal(host.lobby(op), false, 'im Spiel gesperrt: ' + op.op);
  }
  assert.equal(host.act({ t: 'ready' }), true);
  assert.equal(host.snap.view.phase, 'play');
  assert.equal(host.snap.view.turn, v.startSeat, 'der ausgeloste Startspieler beginnt');
  assert.equal(host.lobby({ op: 'rematch' }), false, 'neue Runde erst, wenn es einen Sieger gibt');
  // Bots spielen, bis der Host dran ist; der legt seine 2 (notfalls nimmt er gegen einen Joker auf)
  w.until(() => {
    const vv = host.snap.view;
    if (vv.winner !== null) return true;
    if (vv.turn === 0) { if (vv.my.playable.length) host.act({ t: 'play', cards: [vv.my.playable[0]] }); else host.act({ t: 'pickup' }); }
    return false;
  }, 20000, 'der Host wird fertig');
  assert.equal(host.snap.view.winner, 0);
  assert.equal(host.snap.view.players[0].place, 1);
  assert.equal(host.snap.view.phase, 'play', 'die beiden Bots spielen den Verlierer noch aus');
  assert.equal(host.snap.view.canGiveUp, false, 'wer fertig ist, kann nicht aufgeben');
  assert.equal(host.act({ t: 'giveup' }), false);
  w.until(() => host.snap.view.phase === 'over', 60000, 'die Bots spielen zu Ende');
  const loser = host.snap.view.loser;
  assert.ok(loser === 1 || loser === 2, 'einer der Bots ist Verlierer');
  assert.deepEqual(host.snap.view.finished, [0, 3 - loser]);
  assert.equal(host.act({ t: 'pickup' }), false, 'nach Spielende keine Züge mehr');
  const firstGame = w.game;

  // Neue Runde: gleiche Besetzung, der Verlierer (hier ein Bot) beginnt und zieht von selbst
  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.notEqual(w.game, firstGame);
  assert.equal(host.snap.stage, 'game');
  assert.equal(host.snap.view.phase, 'swap');
  assert.equal(host.snap.view.winner, null);
  assert.equal(host.snap.view.loser, null);
  assert.equal(host.snap.view.startSeat, loser);
  assert.equal(host.snap.view.startBy, 'loser');
  assert.deepEqual(host.snap.view.pile, []);
  assert.equal(host.snap.view.players[0].n, 3);
  const n0 = w.applied.length;
  assert.equal(host.act({ t: 'ready' }), true);
  assert.equal(host.snap.view.turn, loser);
  w.until(() => w.applied.length > n0 + 1, FAST.bot + 5, 'der Bot macht den ersten Zug');
  assert.equal(w.applied[n0 + 1].seat, loser);
  assert.equal(w.applied[n0 + 1].ok, true);
  // zurück in die Lobby (auch mitten im Spiel möglich) – ohne beendete Runde gibt es keinen gemerkten Verlierer
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  assert.equal(host.snap.stage, 'lobby');
  assert.equal(host.snap.view, null);
  assert.equal(host.snap.lobby.players.length, 3);
  assert.equal(host.snap.lobby.starter, -1);
  assert.equal(host.lobby({ op: 'kick', seat: 1 }), true, 'in der Lobby wieder erlaubt');
  assert.equal(host.lobby({ op: 'kick', seat: 1 }), true);
  assert.equal(host.lobby({ op: 'start' }), false, 'wieder allein');
  w.run(200);   // kein verwaister Bot-Timer wirft
});

test('Lobby: Gäste sehen Änderungen (Bots), Spielstart, Rangfolge, neue Runde und Rückkehr in die Lobby', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna', 'Ben']);
  host.lobby({ op: 'addBot' });
  w.until(() => guests.every((g) => JSON.stringify(g.snap.lobby) === JSON.stringify(host.snap.lobby)), 500);
  assert.equal(guests[0].snap.lobby.players.length, 4);
  assert.equal(guests[0].snap.lobby.players[3].bot, true);
  // Anna (Sitz 1) beginnt und kann sofort fertig werden
  begin(w, host, guests, { startSeat: 1, rig: rigQuick([1]), ready: false });
  assert.equal(guests[0].snap.view.you, 1);
  assert.equal(guests[1].snap.view.you, 2);
  assert.deepEqual(guests[0].snap.view.players[1].hand, ['S2']);
  assert.equal(guests[0].snap.view.players[2].hand, null);
  assert.equal(guests[0].snap.lobby.starter, -1);
  w.play([host].concat(guests), () => host.snap.view.phase === 'play', 2000, 'alle bereit');
  assert.equal(host.snap.view.turn, 1);
  w.play([guests[0]], () => host.snap.view.winner !== null, 2000, 'Anna legt ihre letzte Karte');
  assert.equal(host.snap.view.winner, 1);
  assert.equal(host.snap.view.phase, 'play', 'gespielt wird, bis nur noch einer Karten hat');
  w.until(() => w.synced(guests), 500);
  assert.equal(guests[1].snap.view.players[1].place, 1);
  w.play([host].concat(guests), () => host.snap.view.phase === 'over', 200000, 'Runde zu Ende');
  w.until(() => w.synced(guests), 500);
  sameForAll(host, guests, w.game);
  const loser = w.game.loser;
  assert.equal(w.game.deadlock, false);
  assert.deepEqual(w.game.finished.concat([loser]).sort(), [0, 1, 2, 3], 'jeder Sitz steht genau einmal in der Rangfolge');
  assert.equal(guests[0].snap.view.loser, loser);
  assert.equal(host.lobby({ op: 'rematch' }), true);
  w.until(() => guests.every((g) => g.snap.view.phase === 'swap' && g.snap.view.seq === host.snap.view.seq), 500);
  assert.equal(guests[0].snap.view.winner, null);
  assert.equal(guests[0].snap.view.startSeat, loser);
  assert.equal(guests[1].snap.view.startBy, 'loser');
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  w.until(() => guests.every((g) => g.snap.stage === 'lobby' && g.snap.view === null), 500);
  assert.deepEqual(guests[0].snap.lobby, host.snap.lobby);
});

/* ================================================================== Aufgeben */

test('Aufgeben: Host (Sitz 0) gibt zu zweit auf, obwohl er nicht am Zug ist – nicht in Lobby/Tauschphase, nicht doppelt', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  begin(w, host, guests, { startSeat: 1, ready: false });
  // Tauschphase: niemand kann aufgeben
  assert.equal(host.snap.view.canGiveUp, false);
  assert.equal(anna.snap.view.canGiveUp, false);
  assert.equal(host.act({ t: 'giveup' }), false);
  assert.equal(anna.act({ t: 'giveup' }), true, 'beim Gast geht die Aktion erst einmal raus …');
  w.until(() => anna.snap.pending === 0, 500);
  assert.deepEqual(w.applied.map((x) => [x.seat, x.a.t, x.ok, x.err]), [[0, 'giveup', false, 'wrong-phase'], [1, 'giveup', false, 'wrong-phase']], '… und wird vom Host abgelehnt');
  assert.equal(w.game.phase, 'swap');
  assert.equal(host.act({ t: 'ready' }), true);
  assert.equal(anna.act({ t: 'ready' }), true);
  w.until(() => w.game.phase === 'play' && w.synced(guests), 500);
  // Spielphase zu zweit: beide dürfen, egal wer dran ist
  assert.equal(w.game.turn, 1);
  assert.equal(host.snap.view.my, null, 'der Host ist nicht am Zug');
  assert.equal(host.snap.view.canGiveUp, true);
  assert.equal(anna.snap.view.canGiveUp, true);
  const seq0 = w.game.seq;
  assert.equal(host.act({ t: 'giveup' }), true);
  const v = host.snap.view;
  assert.equal(v.phase, 'over');
  assert.equal(v.turn, -1);
  assert.equal(v.loser, 0);
  assert.equal(v.gaveUp, 0);
  assert.equal(v.winner, 1);
  assert.deepEqual(v.finished, [1]);
  assert.equal(v.deadlock, false);
  assert.equal(v.canGiveUp, false);
  assert.equal(v.my, null);
  assert.deepEqual(v.players.map((p) => p.place), [0, 1]);
  assert.deepEqual(v.ev, { t: 'giveup', seat: 0, other: 1, place: 1, fx: ['win', 'over'], seq: seq0 + 1 });
  w.until(() => w.synced(guests), 500, 'Anna sieht das Ende');
  sameForAll(host, guests, w.game);
  assert.equal(anna.snap.view.canGiveUp, false);
  assert.equal(anna.snap.view.my, null);
  assert.equal(anna.snap.view.players[1].n, 3, 'die Siegerin behält ihre Karten – sie hat nur den freien Platz bekommen');
  // danach geht nichts mehr
  assert.equal(host.act({ t: 'giveup' }), false);
  assert.equal(host.act({ t: 'pickup' }), false);
  anna.act({ t: 'giveup' });
  w.until(() => anna.snap.pending === 0, 500);
  assert.equal(w.applied[w.applied.length - 1].err, 'wrong-phase');
  assert.equal(w.game.seq, seq0 + 1);
  assert.equal(w.applied.filter((x) => x.a.t === 'giveup' && x.ok).length, 1);
});

test('Aufgeben: Gast am Zug – nach einem Joker musste er den Stapel aufnehmen und gibt auf (Joker ist aus dem Spiel, nicht auf der Hand)', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  begin(w, host, guests, {
    startSeat: 0,
    rig: (g) => { setZone(g, 0, 'hand', ['S9', 'JB', 'JR']); setZone(g, 1, 'hand', ['D12', 'C13', 'C5']); }
  });
  assert.equal(host.act({ t: 'play', cards: ['S9'] }), true);
  w.until(() => w.synced(guests), 300);
  assert.deepEqual(anna.snap.view.req, { k: 'min', rank: 9 });
  assert.equal(anna.act({ t: 'play', cards: ['D12'] }), true);
  w.until(() => w.game.turn === 0 && w.synced(guests), 300);
  assert.equal(host.act({ t: 'play', cards: ['JB'] }), true, 'der Joker darf auf die Dame');
  w.until(() => w.synced(guests), 300);
  // Anna hat keinen roten Joker: es bleibt nur Aufnehmen
  let my = anna.snap.view.my;
  assert.deepEqual(my, { zone: 'hand', playable: [], canPickup: true, canFlip: false, forced: true });
  assert.deepEqual(anna.snap.view.req, { k: 'jokerB' });
  assert.equal(anna.act({ t: 'play', cards: ['C13'] }), true);
  w.until(() => anna.snap.pending === 0, 300);
  assert.equal(w.applied[w.applied.length - 1].err, 'not-playable', 'auf einen Joker darf nichts (außer Rot auf Schwarz)');
  const handBefore = anna.snap.view.players[1].hand.slice();
  assert.equal(anna.act({ t: 'pickup' }), true);
  w.until(() => w.synced(guests), 300);
  const v = anna.snap.view;
  assert.deepEqual(v.ev, { t: 'pickup', seat: 1, n: 2, joker: true, vol: false, gone: ['JB'], drew: 0, seq: w.game.seq });
  assert.deepEqual(v.players[1].hand.slice().sort(), handBefore.concat(['S9', 'D12']).sort(), 'aufgenommen wird nur der Stapel unter dem Joker');
  assert.ok(!v.players[1].hand.includes('JB'));
  assert.ok(w.game.burned.includes('JB'), 'der Joker ist dauerhaft aus dem Spiel');
  assert.equal(v.burned, host.snap.view.burned);
  assert.deepEqual(v.pile, []);
  assert.equal(v.turn, 1, 'wer aufgenommen hat, spielt selbst aus');
  assert.equal(v.freePlay, true);
  my = v.my;
  assert.equal(my.playable.length, v.players[1].n);
  assert.equal(my.canPickup, false);
  assert.equal(my.forced, false);
  // … und statt auszuspielen gibt sie auf
  assert.equal(v.canGiveUp, true);
  assert.equal(host.snap.view.canGiveUp, true);
  assert.equal(anna.act({ t: 'giveup' }), true);
  w.until(() => w.synced(guests) && w.game.phase === 'over', 300);
  sameForAll(host, guests, w.game);
  assert.equal(host.snap.view.loser, 1);
  assert.equal(host.snap.view.gaveUp, 1);
  assert.equal(host.snap.view.winner, 0);
  assert.deepEqual(host.snap.view.finished, [0]);
  assert.equal(host.snap.view.freePlay, false);
  assert.deepEqual(host.snap.view.ev, { t: 'giveup', seat: 1, other: 0, place: 1, fx: ['win', 'over'], seq: w.game.seq });
  assert.equal(w.applied.filter((x) => x.seat === 1 && x.a.t === 'giveup').length, 1);
});

test('Aufgeben: erst wenn nur noch zwei Spieler Karten haben – dann auch für den Gast, der nicht am Zug ist; gefälschte Absender zählen nicht', (t) => {
  const w = world(t);
  const { host, code, guests } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  host.lobby({ op: 'addBot' });
  host.lobby({ op: 'kick', seat: 3 });
  begin(w, host, guests, { startSeat: 0, rig: rigQuick([0]) });
  // zu dritt: niemand darf aufgeben
  for (const s of [host, anna, ben]) assert.equal(s.snap.view.canGiveUp, false, s.label);
  const frozen = JSON.stringify(w.game);
  assert.equal(host.act({ t: 'giveup' }), false);
  ben.act({ t: 'giveup' });
  w.until(() => ben.snap.pending === 0, 300);
  assert.equal(w.applied[w.applied.length - 1].err, 'cannot-giveup');
  assert.equal(JSON.stringify(w.game), frozen, 'abgelehntes Aufgeben ändert nichts');
  // der Host legt seine letzte Karte: Platz 1, die Runde läuft für Anna und Ben weiter
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.synced(guests), 300);
  assert.equal(w.game.phase, 'play');
  assert.equal(w.game.winner, 0);
  assert.equal(w.game.turn, 1, 'Anna ist am Zug');
  assert.equal(host.snap.view.canGiveUp, false, 'der Fertige nicht');
  assert.equal(anna.snap.view.canGiveUp, true);
  assert.equal(ben.snap.view.canGiveUp, true);
  assert.equal(ben.snap.view.my, null, 'Ben ist nicht am Zug');
  assert.equal(host.act({ t: 'giveup' }), false);
  // Aufgeben im Namen anderer: weder mit der Pseudo-Kennung des Hosts noch mit einer fremden
  const raw = w.raw(code), seq0 = w.game.seq;
  for (const pid of ['local', 'bot-aaaaaa', 'fremd', '']) raw.publish('h', { pid, t: 'act', n: 1, a: { t: 'giveup' } });
  raw.publish('h', { t: 'act', n: 1, a: { t: 'giveup' }, seat: 2 });
  w.run(20);
  assert.equal(w.game.phase, 'play');
  assert.equal(w.game.seq, seq0);
  raw.close();
  // Ben gibt auf, obwohl Anna dran ist
  assert.equal(ben.act({ t: 'giveup' }), true);
  w.until(() => w.game.phase === 'over' && w.synced(guests), 300);
  sameForAll(host, guests, w.game);
  const v = anna.snap.view;
  assert.equal(v.loser, 2);
  assert.equal(v.gaveUp, 2);
  assert.equal(v.winner, 0, 'Sieger bleibt, wer zuerst fertig war');
  assert.deepEqual(v.finished, [0, 1], 'Anna bekommt den nächsten freien Platz');
  assert.deepEqual(v.players.map((p) => p.place), [1, 2, 0]);
  assert.deepEqual(v.ev, { t: 'giveup', seat: 2, other: 1, place: 2, fx: ['out', 'over'], seq: seq0 + 1 });
  assert.ok(v.players[1].n > 0, 'Anna hat noch Karten und ist trotzdem Zweite');
  assert.equal(v.players[1].zone, 'hand');
});

test('Aufgeben unter 50 % Nachrichtenverlust, Verzögerung und mit Duplikaten: genau einmal – auch alte Kopien in der nächsten Runde bewirken nichts', (t) => {
  const w = world(t, { seed: 81 });
  const { host, code, guests } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  begin(w, host, guests, { startSeat: 0, rig: rigQuick([0]) });
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.synced(guests), 300);
  const copies = [];
  w.onPublish = (rec) => { if (rec.ch === 'h' && rec.msg.t === 'act' && rec.msg.a && rec.msg.a.t === 'giveup') copies.push(clone(rec.msg)); };
  const raw = w.raw(code);
  const flood = (k) => { for (let i = 0; i < k; i++) raw.publish('h', clone(copies[0])); };
  const giveups = () => w.applied.filter((x) => x.a && x.a.t === 'giveup');

  N.memBus.drop = 0.5; N.memBus.delay = 9; w.jitter = 30;
  assert.equal(ben.act({ t: 'giveup' }), true);
  assert.equal(ben.snap.pending, 1);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].n, 2, 'Bens zweite Aktion (nach "bereit")');
  for (let i = 0; i < 40; i++) { flood(3); w.run(7); }             // Kopien vor, während und nach der Bestätigung
  w.until(() => w.game.phase === 'over' && w.synced(guests), 20000, 'Ende kommt trotz Verlust bei allen an');
  assert.ok(copies.length > 1, 'der Gast hat die Aktion wiederholt (' + copies.length + ' Sendungen)');
  assert.ok(copies.every((m) => m.n === 2), 'immer mit derselben Nummer');
  assert.deepEqual(giveups().map((x) => [x.seat, x.ok]), [[2, true]], 'vom Host genau einmal angewandt');
  assert.equal(w.game.loser, 2);
  assert.deepEqual(w.game.finished, [0, 1]);
  sameForAll(host, guests, w.game);
  // Anna tippt im selben Moment noch auf "Aufgeben": abgelehnt, es bleibt bei Ben als Verlierer
  anna.act({ t: 'giveup' });
  w.until(() => anna.snap.pending === 0, 20000);
  assert.deepEqual(giveups().map((x) => [x.seat, x.ok, x.err]), [[2, true, undefined], [1, false, 'wrong-phase']]);
  assert.equal(w.game.loser, 2);
  const firstGame = w.game, seqEnd = w.game.seq;

  // Neue Runde (Ben beginnt). Verspätete Kopien der alten Aufgabe treffen ein – in der Tauschphase und im Spiel.
  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.equal(w.game.startSeat, 2);
  assert.equal(w.game.startBy, 'loser');
  flood(10);
  w.until(() => guests.every((g) => g.snap.view && g.snap.view.phase === 'swap' && g.snap.view.seq === w.game.seq), 20000, 'neue Runde bei allen');
  flood(10);
  assert.equal(host.act({ t: 'ready' }), true);
  anna.act({ t: 'ready' }); ben.act({ t: 'ready' });
  w.until(() => w.game.phase === 'play' && w.synced(guests), 20000, 'alle bereit (unter Verlust)');
  for (let i = 0; i < 20; i++) { flood(3); w.run(5); }
  N.memBus.drop = 0; N.memBus.delay = 0; w.jitter = 0;
  flood(10);
  w.run(100);
  assert.equal(giveups().length, 2, 'keine weitere Aufgabe angewandt');
  assert.equal(w.game.phase, 'play');
  assert.equal(w.game.turn, 2);
  assert.equal(w.game.gaveUp, null);
  assert.equal(firstGame.seq, seqEnd, 'auch die alte Runde wurde nicht mehr angefasst');
  w.until(() => w.synced(guests), 500);
  sameForAll(host, guests, w.game);
  raw.close();
});

test('Aufgeben: tippen beide gleichzeitig, verliert genau einer – wessen Aufgabe zuerst beim Host ist', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  begin(w, host, guests, { startSeat: 0 });
  N.memBus.delay = 10;
  assert.equal(anna.act({ t: 'giveup' }), true);          // unterwegs …
  w.run(5);
  assert.equal(host.act({ t: 'giveup' }), true);          // … da gibt der Host selbst auf
  w.until(() => anna.snap.pending === 0 && w.synced(guests), 500);
  assert.deepEqual(w.applied.filter((x) => x.a.t === 'giveup').map((x) => [x.seat, x.ok, x.err]), [[0, true, undefined], [1, false, 'wrong-phase']]);
  assert.equal(anna.snap.view.loser, 0);
  assert.equal(anna.snap.view.winner, 1);
  assert.equal(anna.snap.view.gaveUp, 0);
  sameForAll(host, guests, w.game);
  // umgekehrt in der nächsten Runde: Annas Aufgabe ist schneller
  begin(w, host, guests, { op: 'rematch' });
  assert.equal(w.game.startSeat, 0, 'der Host hat verloren und beginnt');
  assert.equal(anna.act({ t: 'giveup' }), true);
  w.run(12);
  assert.equal(host.snap.view.phase, 'over');
  assert.equal(host.act({ t: 'giveup' }), false, 'zu spät');
  w.until(() => w.synced(guests), 500);
  assert.equal(host.snap.view.loser, 1);
  assert.equal(host.snap.view.winner, 0);
});

/* ================================================================== Rundennummer: Nachzügler aus einer alten Runde */

/* Mitschrift der Leitung: jede act-Nachricht der Gäste und die Rundennummer jedes verschickten Stands. */
function wire(w) {
  const log = { acts: [], rounds: [] };
  w.onPublish = (rec) => {
    if (rec.ch === 'h' && rec.msg && rec.msg.t === 'act') log.acts.push(clone(rec.msg));
    if (rec.ch.indexOf('p/') === 0 && rec.msg.t === 'state') log.rounds.push(rec.msg.round);
  };
  return log;
}

test('Veraltete Aktion aus einer früheren Runde darf die neue Runde nicht entscheiden (Gast war weg, sein "Aufgeben" hing noch in der Leitung): ' +
  'bestätigt, aber nicht angewandt – die Warteschlange des Gasts leert sich, die neue Runde bleibt unberührt', (t) => {
  const w = world(t);
  const { host, guests, hostStore } = lobby(w, ['Anna']);
  const anna = guests[0];
  const log = wire(w);
  const giveups = () => w.applied.filter((x) => x.a && x.a.t === 'giveup').map((x) => [x.game, x.seat, x.ok]);
  begin(w, host, guests, { startSeat: 0 });
  assert.equal(hostStore.saved().H.round, 1);
  anna.port.muted = true;                                 // Funkloch – genau jetzt tippt Anna auf "Aufgeben"
  assert.equal(anna.act({ t: 'giveup' }), true);
  assert.equal(anna.snap.pending, 1);
  w.run(FAST.playerDead + FAST.sweep * 2 + 10);
  assert.equal(host.snap.lobby.players[1].online, false);
  assert.equal(host.act({ t: 'giveup' }), true, 'der Host beendet die Runde selbst (er verliert sie)');
  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.equal(hostStore.saved().H.round, 2);
  assert.equal(host.act({ t: 'ready' }), true);
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: true }), true, 'für die abwesende Anna meldet der Bot "bereit"');
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: false }), true);
  assert.equal(w.game.phase, 'play');
  assert.equal(w.games.length, 2);
  assert.equal(E.canGiveUp(w.game, 1), true, 'in der neuen Runde wäre ein Aufgeben von Sitz 1 gültig – wenn es denn zählte');
  const frozen = JSON.stringify(w.game), ackBefore = hostStore.saved().H.players[1].ack;
  assert.equal(ackBefore, 1, 'bestätigt ist bisher nur Annas "bereit" aus Runde 1');
  assert.equal(anna.snap.pending, 1, 'die alte Aktion wartet noch');
  anna.port.muted = false;                                // Anna ist zurück; ihre alte Aktion wird erneut gesendet
  w.until(() => anna.snap.pending === 0 && anna.snap.hostOnline && anna.snap.view.seq === w.game.seq, 1000, 'die Warteschlange leert sich');
  w.run(100);
  const old = log.acts.filter((m) => m.a.t === 'giveup');
  assert.ok(old.length >= 1, 'die alte Aktion ging nach der Rückkehr wirklich über die Leitung');
  assert.ok(old.every((m) => m.n === 2 && m.r === 1), 'mit ihrer alten Nummer und der Runde, in der sie getippt wurde: ' + JSON.stringify(old[0]));
  assert.equal(hostStore.saved().H.players[1].ack, 2, 'der Host hat sie bestätigt …');
  assert.deepEqual(giveups(), [[0, 0, true]], '… aber nicht an den Regelkern gegeben (angewandt ist nur die Aufgabe des Hosts in Runde 1)');
  assert.equal(JSON.stringify(w.game), frozen, 'die neue Runde ist Byte für Byte unberührt');
  assert.equal(w.game.phase, 'play', 'die neue Runde läuft weiter');
  assert.equal(w.game.gaveUp, null);
  assert.equal(anna.snap.view.phase, 'play');
  assert.equal(anna.snap.view.canGiveUp, true);
  sameForAll(host, guests, w.game);
  // Gegenprobe: dieselbe Aktion, jetzt in Runde 2 getippt, zählt – genau einmal
  assert.equal(anna.act({ t: 'giveup' }), true);
  w.until(() => w.game.phase === 'over' && w.synced(guests), 500);
  const last = log.acts[log.acts.length - 1];
  assert.deepEqual([last.n, last.r, last.a], [3, 2, { t: 'giveup' }]);
  assert.deepEqual(giveups(), [[0, 0, true], [1, 1, true]]);
  assert.equal(w.game.loser, 1);
});

test('Veraltetes Aufnehmen aus Runde N wird in Runde N+1 bestätigt, aber nicht angewandt – obwohl der Gast gerade am Zug ist und aufnehmen dürfte', (t) => {
  const w = world(t);
  const { host, guests, hostStore } = lobby(w, ['Anna']);
  const anna = guests[0];
  const log = wire(w);
  const pickups = () => w.applied.filter((x) => x.a && x.a.t === 'pickup').map((x) => [x.game, x.seat, x.ok]);
  // Runde 1: der Host legt, Anna ist am Zug und dürfte aufnehmen – ihr Tipp geht im Funkloch unter
  begin(w, host, guests, { startSeat: 0, rig: (g) => setZone(g, 0, 'hand', ['S9']) });
  assert.equal(host.act({ t: 'play', cards: ['S9'] }), true);
  w.until(() => w.synced(guests), 300);
  assert.equal(anna.snap.view.my.canPickup, true);
  anna.port.muted = true;
  assert.equal(anna.act({ t: 'pickup' }), true);
  w.run(FAST.playerDead + FAST.sweep * 2 + 10);
  assert.equal(host.snap.lobby.players[1].online, false);
  assert.deepEqual(pickups(), [], 'in Runde 1 kam das Aufnehmen nie an');
  // Der Host gibt auf, neue Runde (er beginnt als Verlierer); für Anna meldet der Bot nur "bereit"
  assert.equal(host.act({ t: 'giveup' }), true);
  w.rig = (g) => setZone(g, 0, 'hand', ['S9']);
  assert.equal(host.lobby({ op: 'rematch' }), true);
  w.rig = null;
  assert.equal(host.act({ t: 'ready' }), true);
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: true }), true);
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: false }), true);
  assert.deepEqual([w.game.phase, w.game.turn, w.game.startBy], ['play', 0, 'loser']);
  assert.equal(host.act({ t: 'play', cards: ['S9'] }), true);
  // Jetzt ist Sitz 1 am Zug und ein Aufnehmen wäre erlaubt
  assert.deepEqual(E.viewFor(w.game, 1).my.canPickup, true);
  assert.equal(w.game.turn, 1);
  const frozen = JSON.stringify(w.game);
  anna.port.muted = false;
  w.until(() => anna.snap.pending === 0 && anna.snap.hostOnline && anna.snap.view.seq === w.game.seq, 1000, 'die Warteschlange leert sich');
  w.run(100);
  const old = log.acts.filter((m) => m.a.t === 'pickup');
  assert.ok(old.length >= 1 && old.every((m) => m.n === 2 && m.r === 1), 'die alte Aktion trägt Runde 1');
  assert.equal(hostStore.saved().H.players[1].ack, 2, 'bestätigt');
  assert.deepEqual(pickups(), [], 'nicht angewandt');
  assert.equal(JSON.stringify(w.game), frozen, 'die neue Runde ist unberührt');
  assert.deepEqual(w.game.pile, ['S9']);
  assert.equal(anna.snap.view.turn, 1);
  assert.equal(anna.snap.view.my.canPickup, true);
  sameForAll(host, guests, w.game);
  // Gegenprobe: in Runde 2 getippt, zählt das Aufnehmen
  assert.equal(anna.act({ t: 'pickup' }), true);
  w.until(() => w.synced(guests) && w.game.ev.t === 'pickup', 500);
  assert.deepEqual(pickups(), [[1, 1, true]]);
  assert.deepEqual(w.game.pile, []);
  assert.ok(w.game.players[1].hand.includes('S9'));
  const last = log.acts[log.acts.length - 1];
  assert.deepEqual([last.n, last.r], [3, 2]);
});

test('Rundennummer: jeder Stand trägt round (0 vor dem ersten Spiel, +1 je neuer Partie – auch nach toLobby und Neuladen des Hosts); ' +
  'der Gast schickt sie mit jeder Aktion; passt sie, wird die Aktion trotz 50 % Verlust und Duplikaten genau einmal angewandt', (t) => {
  const w = world(t, { seed: 83 });
  const { host, code, guests, pids, hostStore } = lobby(w, ['Anna']);
  const anna = guests[0], pid = pids[0];
  const log = wire(w);
  const ackOf = () => hostStore.saved().H.players[1].ack;
  const plays = () => w.applied.filter((x) => x.seat === 1 && x.a && x.a.t === 'play').map((x) => [x.game, x.a.cards[0], x.ok]);
  assert.equal(hostStore.saved().H.round, undefined, 'vor dem ersten Spiel gibt es keine Runde');
  assert.equal(host.lobby({ op: 'addBot' }), true);
  assert.equal(host.lobby({ op: 'kick', seat: 2 }), true);
  w.run(20);
  assert.ok(log.rounds.length >= 2 && log.rounds.every((r) => r === 0), 'Lobby-Stände vor dem ersten Spiel tragen round 0');
  begin(w, host, guests, { startSeat: 0 });
  assert.equal(log.rounds[log.rounds.length - 1], 1);
  assert.deepEqual(log.acts.map((m) => [m.n, m.r, m.a.t]), [[1, 1, 'ready']], 'schon das "bereit" trägt die Runde');
  assert.equal(host.act({ t: 'giveup' }), true);
  w.until(() => w.synced(guests), 300);
  // zurück in die Lobby (round bleibt 1) und neu starten (round 2) – der Host beginnt als Verlierer
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  w.until(() => anna.snap.stage === 'lobby', 300);
  assert.equal(log.rounds[log.rounds.length - 1], 1, 'in der Lobby zwischen zwei Partien bleibt die Nummer stehen');
  begin(w, host, guests, { rig: (g) => { setZone(g, 0, 'hand', ['S9', 'S13', 'S14']); setZone(g, 1, 'hand', ['H12', 'D13', 'C5']); } });
  assert.equal(hostStore.saved().H.round, 2);
  assert.deepEqual([w.game.startSeat, w.game.startBy], [0, 'loser']);
  assert.equal(host.act({ t: 'play', cards: ['S9'] }), true);
  w.until(() => w.synced(guests), 300);

  // Annas Zug unter Verlust, Verzögerung, Umsortierung – dazu Kopien derselben Nachricht von außen
  const raw = w.raw(code);
  const n0 = log.acts.length;
  N.memBus.drop = 0.5; N.memBus.delay = 9; w.jitter = 30;
  assert.equal(anna.act({ t: 'play', cards: ['H12'] }), true);
  const first = clone(log.acts[n0]);
  assert.deepEqual(first, { t: 'act', n: 3, r: 2, a: { t: 'play', cards: ['H12'] }, pid }, 'Nachricht des Gasts: Zähler, Runde, Aktion, Kennung');
  for (let i = 0; i < 40; i++) { for (let k = 0; k < 3; k++) raw.publish('h', clone(first)); w.run(7); }
  w.until(() => w.synced(guests), 20000, 'Annas Zug kommt trotz Verlust an');
  for (let i = 0; i < 10; i++) { raw.publish('h', clone(first)); w.run(5); }
  N.memBus.drop = 0; N.memBus.delay = 0; w.jitter = 0;
  for (let k = 0; k < 10; k++) raw.publish('h', clone(first));
  w.run(100);
  const sent = log.acts.slice(n0);
  assert.ok(sent.length > 1, 'der Gast hat wiederholt (' + sent.length + ' Sendungen)');
  assert.ok(sent.every((m) => m.n === 3 && m.r === 2), 'jede Wiederholung mit derselben Nummer und Runde');
  assert.deepEqual(plays(), [[1, 'H12', true]], 'vom Host genau einmal angewandt');
  assert.deepEqual(w.game.pile, ['S9', 'H12']);
  assert.equal(ackOf(), 3, 'Annas dritte Aktion (zweimal "bereit", dann dieser Zug)');
  assert.equal(w.game.turn, 0);

  // Von Hand gebaute Nachrichten mit lückenlosem Zähler: falsche Runde -> bestätigt und ignoriert; ohne r -> angewandt
  assert.equal(host.act({ t: 'play', cards: ['S13'] }), true);
  w.until(() => w.synced(guests), 300);
  assert.equal(w.game.turn, 1);
  const frozen = JSON.stringify(w.game), D13 = { t: 'play', cards: ['D13'] };
  let n = ackOf();
  for (const r of [1, 3, 0, -1, 99, 2.5]) {
    raw.publish('h', { t: 'act', pid, n: ++n, r, a: D13 });
    w.run(5);
    assert.equal(ackOf(), n, 'r=' + r + ': bestätigt');
    assert.equal(JSON.stringify(w.game), frozen, 'r=' + r + ': nicht angewandt');
  }
  assert.deepEqual(plays(), [[1, 'H12', true]]);
  w.until(() => anna.snap.pending === 0 && anna.snap.view.seq === w.game.seq, 300);
  raw.publish('h', { t: 'act', pid, n: ++n, a: D13 });      // ältere App-Version ohne r: zählt weiterhin
  w.run(5);
  assert.deepEqual(plays(), [[1, 'H12', true], [1, 'D13', true]]);
  assert.deepEqual(w.game.pile, ['S9', 'H12', 'S13', 'D13']);
  // Die echte Sitzung zählt hinter der höchsten Bestätigung weiter – mit der richtigen Runde
  w.until(() => w.synced(guests), 300);
  // Host lädt neu: die Rundennummer bleibt, Aktionen der laufenden Runde zählen weiter
  host.kill();
  const host2 = w.session('host2', hostStore.handle());
  assert.equal(host2.resume(), true);
  w.until(() => anna.snap.hostOnline && anna.snap.view.seq === w.game.seq, 1000);
  assert.equal(hostStore.saved().H.round, 2);
  assert.equal(host2.act({ t: 'play', cards: ['S14'] }), true);
  const g2 = () => hostStore.saved().H.game;
  w.until(() => anna.snap.view.seq === g2().seq && anna.snap.view.turn === 1, 500);
  assert.equal(anna.snap.view.my.forced || anna.snap.view.my.canPickup, true);
  assert.equal(anna.act({ t: 'pickup' }), true);
  w.until(() => anna.snap.pending === 0 && g2().ev.t === 'pickup', 500, 'Aufnehmen nach dem Neuladen des Hosts');
  const last = log.acts[log.acts.length - 1];
  assert.deepEqual([last.n, last.r, last.a.t], [n + 1, 2, 'pickup']);
  assert.equal(g2().ev.seat, 1);
  assert.ok(log.rounds.every((r) => r === 0 || r === 1 || r === 2));
  assert.equal(host2.act({ t: 'giveup' }), true);
  assert.equal(host2.lobby({ op: 'rematch' }), true);
  w.until(() => anna.snap.view.phase === 'swap', 500);
  assert.equal(log.rounds[log.rounds.length - 1], 3, 'nach dem Neuladen zählt der Host weiter');
  raw.close();
});

/* ================================================================== Reservierte Kennungen */

test('Reservierte Kennungen: ein hello mit pid "local" oder "bot-…" wird mit "unknown" abgelehnt – in der Lobby, im Spiel, bei vollem Raum; ähnliche Kennungen dürfen hinein', (t) => {
  const w = world(t);
  const { host, code, guests, hostStore } = lobby(w, ['Anna']);
  assert.equal(host.lobby({ op: 'addBot' }), true);
  const botPid = hostStore.saved().H.players[2].pid;
  assert.match(botPid, /^bot-[a-z0-9]{6}$/);
  const raw = w.raw(code);
  const reserved = ['local', 'bot-', 'bot-aaaaaa', 'bot-' + 'x'.repeat(40), botPid];
  const denies = (pid) => w.published.filter((p) => p.ch === 'p/' + pid && p.t === 'deny').map((p) => p.why);
  const lobbyBefore = clone(host.snap.lobby), saved0 = JSON.stringify(hostStore.saved().H.players);
  // --- Lobby mit freien Plätzen: vorher wäre hier ein zweiter Spieler mit der Kennung des Hosts entstanden
  for (const pid of reserved) raw.publish('h', { pid, t: 'hello', name: 'Eindringling' });
  w.run(30);
  for (const pid of reserved) assert.deepEqual(denies(pid), ['unknown'], 'hello mit pid ' + pid.slice(0, 12));
  assert.deepEqual(host.snap.lobby, lobbyBefore, 'niemand ist dazugekommen');
  assert.equal(JSON.stringify(hostStore.saved().H.players.map((p) => p.pid)), JSON.stringify(JSON.parse(saved0).map((p) => p.pid)));
  assert.equal(hostStore.saved().H.players.filter((p) => p.pid === 'local').length, 1, 'die Kennung "local" gehört genau einem: dem Host');
  assert.deepEqual(guests[0].snap.lobby, lobbyBefore);
  // andere Nachrichten unter diesen Kennungen: ebenfalls "unknown", ein "bye" bleibt ohne Antwort und wirft niemanden hinaus
  for (const pid of ['local', botPid]) {
    raw.publish('h', { pid, t: 'ping', ver: 1 });
    raw.publish('h', { pid, t: 'act', n: 1, r: 0, a: { t: 'ready' } });
    raw.publish('h', { pid, t: 'bye' });
  }
  w.run(30);
  assert.deepEqual(denies('local'), ['unknown', 'unknown', 'unknown']);
  assert.deepEqual(denies(botPid), ['unknown', 'unknown', 'unknown']);
  assert.deepEqual(host.snap.lobby, lobbyBefore);
  // Kennungen, die nur ähnlich aussehen, sind gewöhnliche Gäste
  const fine = ['localx', 'Local', 'LOCAL', 'robot-1', 'Bot-abc', 'bot_abc'];
  for (const pid of fine.slice(0, 3)) raw.publish('h', { pid, t: 'hello', name: pid });
  w.run(30);
  assert.deepEqual(host.snap.lobby.players.map((p) => p.name), ['Hanna', 'Anna', 'Bot Ada', 'localx', 'Local', 'LOCAL']);
  // --- voller Raum: reservierte Kennungen hören "unknown", nicht "full"
  raw.publish('h', { pid: 'local', t: 'hello' });
  raw.publish('h', { pid: 'bot-zzzzzz', t: 'hello' });
  raw.publish('h', { pid: 'robot-1', t: 'hello' });
  w.run(30);
  assert.deepEqual(denies('local').slice(3), ['unknown']);
  assert.deepEqual(denies('bot-zzzzzz'), ['unknown']);
  assert.deepEqual(denies('robot-1'), ['full']);
  for (const seat of [5, 4, 3]) assert.equal(host.lobby({ op: 'kick', seat }), true);
  for (const pid of fine.slice(3)) raw.publish('h', { pid, t: 'hello', name: pid });
  w.run(30);
  assert.deepEqual(host.snap.lobby.players.map((p) => p.name), ['Hanna', 'Anna', 'Bot Ada', 'robot-1', 'Bot-abc', 'bot_abc']);
  for (const seat of [5, 4, 3]) assert.equal(host.lobby({ op: 'kick', seat }), true);
  // --- im Spiel: "unknown" statt "running" (der Bot ist wieder draußen, seine Kennung bleibt trotzdem gesperrt)
  assert.equal(host.lobby({ op: 'kick', seat: 2 }), true);
  begin(w, host, guests);
  const frozen = JSON.stringify(w.game);
  raw.publish('h', { pid: 'local', t: 'hello', name: 'falscher Host' });
  raw.publish('h', { pid: botPid, t: 'hello', name: 'falscher Bot' });
  raw.publish('h', { pid: 'fremd', t: 'hello', name: 'Fremder' });
  w.run(30);
  assert.deepEqual(denies('local').slice(4), ['unknown']);
  assert.deepEqual(denies(botPid).slice(3), ['unknown']);
  assert.deepEqual(denies('fremd'), ['running']);
  assert.equal(JSON.stringify(w.game), frozen);
  assert.deepEqual(host.snap.lobby.players.map((p) => p.name), ['Hanna', 'Anna']);
  raw.close();
});

test('Reservierte Kennungen: eine gespeicherte Gast-Sitzung mit pid "local" bzw. "bot-…" kommt per resume nicht in den Raum (bleibt "connecting", dann "not-found")', (t) => {
  const w = world(t);
  const { host, code } = lobby(w, []);
  for (const pid of ['local', 'bot-abc123']) {
    const st = makeStore();
    st.data[N.STORE_KEY] = JSON.stringify({ role: 'client', at: Date.now(), code, pid, name: 'Falsch' });
    const g = w.session('falsch-' + pid, st.handle());
    assert.equal(g.resume(), true);
    w.run(FAST.joinTimeout + 100);
    assert.equal(g.snap.stage, 'connecting');
    assert.equal(g.snap.error, 'not-found');
    assert.equal(g.snap.seat, -1);
    assert.equal(g.snap.lobby, null);
    assert.ok(w.published.some((p) => p.ch === 'p/' + pid && p.t === 'deny' && p.why === 'unknown'));
    assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna')] });
    g.kill();
  }
});

/* ================================================================== Verlierer beginnt die nächste Runde */

test('Host als Verlierer: die nächste Runde beginnt auf dem Sitz des Hosts – per rematch und per Lobby + start, mit Gästen und Bots, auch wenn jemand "local" vortäuscht', (t) => {
  for (const how of ['rematch', 'toLobby']) {
    const w = world(t, { seed: how === 'rematch' ? 7 : 8 });
    const { host, code, guests } = lobby(w, ['Anna', 'Ben']);
    const [anna, ben] = guests;
    const raw = w.raw(code);
    // Anna (1) und Ben (2) halten nur noch eine 2 und werden sofort fertig; der Host (0) bleibt als Letzter übrig.
    begin(w, host, guests, { startSeat: 1, rig: rigQuick([1, 2]) });
    assert.equal(anna.act({ t: 'play', cards: ['S2'] }), true);
    w.until(() => w.game.turn === 2 && w.synced(guests), 300);
    assert.equal(ben.act({ t: 'play', cards: ['H2'] }), true);
    w.until(() => w.game.phase === 'over' && w.synced(guests), 300);
    assert.equal(w.game.loser, 0, 'der Host hat verloren');
    assert.deepEqual(w.game.finished, [1, 2]);
    raw.publish('h', { pid: 'local', t: 'hello', name: 'Zweiter Host' });   // wird abgelehnt, es bleibt bei einem "local"
    w.run(10);
    if (how === 'toLobby') {
      assert.equal(host.lobby({ op: 'toLobby' }), true);
      assert.equal(host.snap.lobby.starter, 0, 'lobby.starter zeigt auf den Host');
      raw.publish('h', { pid: 'local', t: 'hello', name: 'Zweiter Host' });
      w.run(10);
      assert.equal(host.lobby({ op: 'addBot' }), true);
      assert.deepEqual(host.snap.lobby, { starter: 0, players: [person('Hanna'), person('Anna'), person('Ben'), person('Bot Ada', { bot: true })] });
      w.until(() => guests.every((g) => g.snap.stage === 'lobby' && g.snap.lobby.players.length === 4), 300);
      for (const g of guests) assert.equal(g.snap.lobby.starter, 0);
      assert.equal(host.lobby({ op: 'start' }), true);
    } else {
      assert.equal(host.lobby({ op: 'rematch' }), true);
    }
    assert.equal(w.game.startSeat, 0, 'der Host beginnt');
    assert.equal(w.game.startBy, 'loser');
    assert.equal(w.game.players[0].name, 'Hanna');
    w.until(() => guests.every((g) => g.snap.stage === 'game' && g.snap.view.phase === 'swap' && g.snap.view.seq === w.game.seq), 500);
    for (const s of [host, anna, ben]) assert.deepEqual([s.snap.view.startSeat, s.snap.view.startBy, s.snap.lobby.starter], [0, 'loser', -1], s.label);
    const n0 = w.applied.length;
    w.play([host, anna, ben], () => w.applied.slice(n0).some((x) => x.phase === 'play' && x.ok), 3000, 'erster Zug');
    assert.equal(w.applied.slice(n0).find((x) => x.phase === 'play' && x.ok).seat, 0, 'den ersten Zug macht der Host');
    raw.close();
    t.mock.timers.reset();
  }
});

test('Host als Verlierer, alter Speicherstand mit einem zweiten Eintrag "local" (konnte vor der Sperre entstehen): rematch nimmt den ERSTEN Treffer – den Sitz des Hosts', (t) => {
  const w = world(t);
  const { host, guests, hostStore } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  begin(w, host, guests, { startSeat: 1, rig: rigQuick([1, 2]) });
  assert.equal(anna.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.game.turn === 2 && w.synced(guests), 300);
  assert.equal(ben.act({ t: 'play', cards: ['H2'] }), true);
  w.until(() => w.game.phase === 'over' && w.synced(guests), 300);
  assert.equal(w.game.loser, 0);
  // Speicherstand wie von einer älteren Version: auf Sitz 2 sitzt ein Gast, der sich als "local" angemeldet hatte
  host.kill();
  const saved = hostStore.saved();
  saved.H.players[2].pid = 'local';
  hostStore.data[N.STORE_KEY] = JSON.stringify(saved);
  const host2 = w.session('host2', hostStore.handle());
  assert.equal(host2.resume(), true);
  assert.equal(host2.snap.view.loser, 0);
  assert.equal(host2.lobby({ op: 'rematch' }), true);
  assert.equal(w.game.startBy, 'loser');
  assert.equal(w.game.startSeat, 0, 'der Host (erster Eintrag "local"), nicht der Nachahmer auf Sitz 2');
  assert.equal(host2.snap.view.startSeat, 0);
});

/* Befund (Quelle, nicht Test): lobbyInfo() in net.js sucht den Verlierer ohne Abbruch und zeigt deshalb den LETZTEN
 * Eintrag mit passender Kennung, newGame() nimmt den ERSTEN. Bei doppelter Kennung "local" (nur aus einem
 * Speicherstand von vor der Sperre reservierter Kennungen, höchstens 12 h alt) kündigt die Lobby Sitz 2 an,
 * es beginnt aber Sitz 0. Kleinstes Beispiel: gespeicherter Host-Stand mit
 *   players [{pid:'local',local:true}, {pid:'anna…'}, {pid:'local'}], loserPid 'local', game null
 * -> resume(): snap.lobby.starter === 2; lobby({op:'start'}): view.startSeat === 0, startBy 'loser'. */
test('Alter Speicherstand mit zweitem Eintrag "local": lobby.starter und der tatsächliche Startspieler stimmen überein',
  (t) => {
    const w = world(t);
    const st = makeStore();
    st.data[N.STORE_KEY] = JSON.stringify({
      role: 'host', at: Date.now(),
      H: { code: 'ABCDE', epoch: 'epoche01', ver: 5, round: 1, kicked: [], game: null, loserPid: 'local',
        players: [{ pid: 'local', local: true, name: 'Hanna' }, { pid: 'anna12345678', name: 'Anna' }, { pid: 'local', name: 'Nachahmer' }] }
    });
    const host = w.session('host', st.handle());
    assert.equal(host.resume(), true);
    const announced = host.snap.lobby.starter;
    assert.equal(host.lobby({ op: 'start' }), true);
    assert.equal(w.game.startBy, 'loser');
    assert.equal(w.game.startSeat, 0);
    assert.equal(announced, w.game.startSeat, 'die Lobby kündigt denselben Sitz an, der dann beginnt');
  });

test('Neue Runde: der Verlierer beginnt – über mehrere Runden, mit Gästen, und er macht wirklich den ersten Zug', (t) => {
  const w = world(t, { seed: 61 });
  const { host, guests } = lobby(w, ['Anna', 'Ben']);
  const all = [host].concat(guests);
  assert.equal(host.snap.lobby.starter, -1);
  assert.equal(host.lobby({ op: 'start' }), true);
  w.until(() => guests.every((g) => g.snap.stage === 'game'), 500);
  for (const s of all) {
    assert.equal(s.snap.view.startBy, 'random', 'erste Runde: ausgelost');
    assert.equal(s.snap.view.startSeat, w.game.startSeat);
  }
  const losers = [];
  for (let round = 0; round < 3; round++) {
    w.play(all, () => w.game.phase === 'over', 400000, 'Runde ' + round + ' endet');
    w.until(() => w.synced(guests), 1000);
    sameForAll(host, guests, w.game);
    const g = w.game, loser = g.loser;
    assert.equal(g.deadlock, false);
    assert.equal(g.finished.length, 2, 'zwei sind fertig geworden');
    assert.equal(g.winner, g.finished[0]);
    assert.ok(!g.finished.includes(loser) && E.zoneOf(g.players[loser]) !== null, 'der Verlierer ist der Letzte mit Karten');
    assert.deepEqual(host.snap.view.players.map((p) => p.place), [0, 1, 2].map((i) => g.finished.indexOf(i) + 1));
    losers.push(loser);
    // nächste Runde
    assert.equal(host.lobby({ op: 'rematch' }), true);
    assert.notEqual(w.game, g);
    assert.equal(w.game.startSeat, loser);
    assert.equal(w.game.startBy, 'loser');
    w.until(() => guests.every((s) => s.snap.view.phase === 'swap' && s.snap.view.seq === w.game.seq), 1000);
    for (const s of all) {
      assert.equal(s.snap.view.startSeat, loser, s.label + ' sieht den Startspieler');
      assert.equal(s.snap.view.startBy, 'loser', s.label + ' sieht, warum er beginnt');
      assert.equal(s.snap.view.loser, null);
      assert.equal(s.snap.view.gaveUp, null);
      assert.equal(s.snap.lobby.starter, -1, 'im Spiel ist lobby.starter leer');
    }
    const n0 = w.applied.length;
    w.play(all, () => w.game.phase === 'play', 2000, 'alle bereit');
    assert.equal(w.game.turn, loser);
    w.play(all, () => w.applied.slice(n0).some((x) => x.phase === 'play' && x.ok), 2000, 'erster Zug');
    assert.equal(w.applied.slice(n0).find((x) => x.phase === 'play').seat, loser, 'den ersten Zug macht der Verlierer der Vorrunde');
  }
  t.diagnostic('Verlierer der drei Runden (Sitze): ' + losers.join(', '));
});

test('Neue Runde nach Aufgeben: wer aufgegeben hat, beginnt – Host wie Gast', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  begin(w, host, guests, { startSeat: 0 });
  anna.act({ t: 'giveup' });
  w.until(() => w.game.phase === 'over' && w.synced(guests), 300);
  begin(w, host, guests, { op: 'rematch' });
  assert.equal(w.game.startSeat, 1);
  assert.equal(anna.snap.view.startBy, 'loser');
  assert.equal(anna.snap.view.turn, 1);
  assert.notEqual(anna.snap.view.my, null, 'Anna ist am Zug');
  assert.equal(host.act({ t: 'giveup' }), true);
  w.until(() => w.synced(guests), 300);
  begin(w, host, guests, { op: 'rematch' });
  assert.equal(w.game.startSeat, 0);
  assert.equal(anna.snap.view.startSeat, 0);
  assert.equal(anna.snap.view.startBy, 'loser');
  assert.equal(host.snap.view.turn, 0);
  assert.equal(anna.snap.view.my, null);
});

test('Neue Runde, nachdem jemand mitten in der Partie gegangen ist: die Sitze rücken auf, und der Verlierer beginnt auf seinem NEUEN Sitz', (t) => {
  const w = world(t);
  const { host, code, guests, pids } = lobby(w, ['Anna', 'Ben', 'Cleo']);
  const [anna, ben, cleo] = guests;
  // Hanna (0), Anna (1) und Ben (2) halten nur noch eine 2; Cleo (3) wird Verliererin.
  begin(w, host, guests, { startSeat: 0, rig: rigQuick([0, 1, 2]) });
  anna.leave();
  w.until(() => host.snap.lobby.players[1].left && [ben, cleo].every((g) => g.snap.lobby.players[1].left), 500);
  assert.deepEqual(host.snap.lobby.players.map((p) => [p.name, p.left, p.auto, p.online]),
    [['Hanna', false, false, true], ['Anna', true, true, false], ['Ben', false, false, true], ['Cleo', false, false, true]]);
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.game.finished.length === 2, FAST.bot + 5, 'der Bot legt Annas letzte Karte');
  assert.deepEqual(w.game.finished, [0, 1]);
  w.until(() => w.synced([ben, cleo]), 300);
  assert.equal(ben.act({ t: 'play', cards: ['D2'] }), true);
  w.until(() => w.game.phase === 'over' && w.synced([ben, cleo]), 300);
  assert.equal(w.game.loser, 3);
  assert.deepEqual(w.game.finished, [0, 1, 2]);
  assert.equal(cleo.snap.seat, 3);
  assert.equal(cleo.snap.view.loser, 3);
  sameForAll(host, [ben, cleo], w.game);

  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna'), person('Ben'), person('Cleo')] }, 'die Gegangene ist nicht mehr dabei');
  assert.equal(w.game.players.length, 3);
  assert.deepEqual(w.game.players.map((p) => p.name), ['Hanna', 'Ben', 'Cleo']);
  assert.equal(w.game.startSeat, 2, 'Cleo saß auf 3 und sitzt jetzt auf 2');
  assert.equal(w.game.startBy, 'loser');
  w.until(() => [ben, cleo].every((g) => g.snap.view.phase === 'swap' && g.snap.view.seq === w.game.seq), 500);
  assert.equal(ben.snap.seat, 1);
  assert.equal(cleo.snap.seat, 2);
  assert.equal(ben.snap.view.you, 1);
  assert.equal(cleo.snap.view.you, 2);
  for (const s of [host, ben, cleo]) {
    assert.equal(s.snap.view.startSeat, 2);
    assert.equal(s.snap.view.startBy, 'loser');
    assert.equal(s.snap.view.players[2].name, 'Cleo');
  }
  assert.deepEqual(cleo.snap.view.players[2].hand, w.game.players[2].hand, 'Cleo bekommt die Hand ihres neuen Sitzes');
  assert.equal(ben.snap.view.players[2].hand, null);
  host.act({ t: 'ready' }); ben.act({ t: 'ready' }); cleo.act({ t: 'ready' });
  w.until(() => w.game.phase === 'play' && w.synced([ben, cleo]), 500);
  assert.equal(w.game.turn, 2);
  assert.notEqual(cleo.snap.view.my, null, 'Cleo ist am Zug');
  assert.equal(ben.snap.view.my, null);
  // Annas alte Kennung gehört zu niemandem mehr
  const raw = w.raw(code);
  raw.publish('h', { pid: pids[0], t: 'act', n: 2, a: { t: 'pickup' } });
  raw.publish('h', { pid: pids[0], t: 'hello', name: 'Anna' });
  w.run(5);
  const denies = w.published.filter((p) => p.ch === 'p/' + pids[0] && p.t === 'deny').map((p) => p.why);
  assert.deepEqual(denies, ['unknown', 'running']);
  assert.equal(host.snap.lobby.players.length, 3);
  raw.close();
});

test('Neue Runde, wenn der Verlierer selbst gegangen ist: er fällt weg, der Startspieler wird ausgelost (rematch wie toLobby + start)', (t) => {
  for (const how of ['rematch', 'toLobby']) {
    const w = world(t, { seed: how === 'rematch' ? 3 : 4 });
    const { host, guests } = lobby(w, ['Anna', 'Ben', 'Cleo']);
    const [anna, ben, cleo] = guests;
    // Hanna (0), Ben (2) und Cleo (3) werden sofort fertig; Anna (1) geht und ihr Bot bleibt als Letzter übrig.
    begin(w, host, guests, { startSeat: 0, rig: rigQuick([0, 2, 3], (g) => setZone(g, 1, 'hand', ['C4', 'C5', 'C6'])) });
    anna.leave();
    w.until(() => host.snap.lobby.players[1].left, 500);
    assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
    w.until(() => w.game.turn === 2 && w.synced([ben, cleo]), 300, 'der Bot hat für Anna gelegt');
    assert.deepEqual(w.game.pile, ['S2', 'C4']);
    assert.equal(ben.act({ t: 'play', cards: ['H2'] }), true);
    w.until(() => w.game.turn === 3 && w.synced([ben, cleo]), 300);
    assert.equal(cleo.act({ t: 'play', cards: ['D2'] }), true);
    w.until(() => w.game.phase === 'over' && w.synced([ben, cleo]), 300);
    assert.equal(w.game.loser, 1, 'die Gegangene ist Verliererin');
    assert.deepEqual(w.game.finished, [0, 2, 3]);
    assert.equal(host.lobby({ op: how }), true);
    assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna'), person('Ben'), person('Cleo')] });
    if (how === 'toLobby') {
      assert.equal(host.snap.stage, 'lobby');
      w.until(() => [ben, cleo].every((g) => g.snap.stage === 'lobby' && g.snap.lobby.players.length === 3), 500);
      assert.deepEqual(ben.snap.lobby, host.snap.lobby);
      assert.equal(host.lobby({ op: 'start' }), true);
    }
    assert.equal(w.game.players.length, 3);
    assert.equal(w.game.startBy, 'random');
    assert.ok(w.game.startSeat >= 0 && w.game.startSeat < 3);
    w.until(() => [ben, cleo].every((g) => g.snap.stage === 'game' && g.snap.view.phase === 'swap'), 500);
    assert.equal(cleo.snap.view.startBy, 'random');
    assert.deepEqual([ben.snap.seat, cleo.snap.seat], [1, 2]);
    t.mock.timers.reset();
  }
});

test('Zu wenige übrig: geht der einzige Gast mitten in der Partie, führt "rematch" zurück in die Lobby (Verlierer bleibt gemerkt)', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  begin(w, host, guests, { startSeat: 0 });
  anna.leave();
  w.until(() => host.snap.lobby.players[1].left, 500);
  assert.equal(host.lobby({ op: 'rematch' }), false, 'ohne Sieger keine neue Runde');
  assert.equal(host.snap.view.canGiveUp, true, 'gegen den Bot der Gegangenen darf der Host aufgeben');
  assert.equal(host.act({ t: 'giveup' }), true);
  assert.equal(host.snap.view.loser, 0);
  assert.equal(host.snap.view.winner, 1);
  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.equal(host.snap.stage, 'lobby');
  assert.equal(host.snap.view, null);
  assert.deepEqual(host.snap.lobby, { starter: 0, players: [person('Hanna')] });
  assert.equal(host.lobby({ op: 'start' }), false, 'allein geht es nicht weiter');
  assert.equal(host.lobby({ op: 'rematch' }), false);
  // Mit einem neuen Mitspieler beginnt der Host als Verlierer der letzten Runde
  assert.equal(host.lobby({ op: 'addBot' }), true);
  assert.equal(host.snap.lobby.starter, 0);
  assert.equal(host.lobby({ op: 'start' }), true);
  assert.equal(w.game.startSeat, 0);
  assert.equal(w.game.startBy, 'loser');
  w.run(100);
});

test('Lobby nach beendeter Runde: lobby.starter zeigt den Verlierer (auch nach Rauswurf davor, Bots dazu), start übernimmt ihn; ohne Verlierer -1', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna', 'Ben', 'Cleo']);
  const [anna, ben, cleo] = guests;
  // Runde 1: Hanna, Anna und Cleo werden fertig, Ben (Sitz 2) verliert
  begin(w, host, guests, { startSeat: 0, rig: rigQuick([0, 1, 3], (g) => setZone(g, 2, 'hand', ['C4', 'C5', 'C6'])) });
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.synced(guests), 300);
  assert.equal(anna.act({ t: 'play', cards: ['H2'] }), true);
  w.until(() => w.game.turn === 2 && w.synced(guests), 300);
  assert.equal(ben.act({ t: 'play', cards: ['C4'] }), true);
  w.until(() => w.game.turn === 3 && w.synced(guests), 300);
  assert.equal(cleo.act({ t: 'play', cards: ['D2'] }), true);
  w.until(() => w.game.phase === 'over' && w.synced(guests), 300);
  assert.equal(w.game.loser, 2);
  assert.equal(host.snap.lobby.starter, -1, 'solange die Partie auf dem Tisch liegt, ist starter leer');
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  assert.equal(host.snap.stage, 'lobby');
  assert.equal(host.snap.lobby.starter, 2);
  w.until(() => guests.every((g) => g.snap.stage === 'lobby' && g.snap.view === null), 500);
  for (const g of guests) assert.deepEqual(g.snap.lobby, { starter: 2, players: [person('Hanna'), person('Anna'), person('Ben'), person('Cleo')] });
  // Bot dazu / wieder weg: starter bleibt
  assert.equal(host.lobby({ op: 'addBot' }), true);
  assert.equal(host.snap.lobby.starter, 2);
  assert.equal(host.lobby({ op: 'kick', seat: 4 }), true);
  assert.equal(host.snap.lobby.starter, 2);
  // Anna (vor Ben) fliegt: Ben rückt auf Sitz 1, starter folgt ihm
  assert.equal(host.lobby({ op: 'kick', seat: 1 }), true);
  assert.equal(host.snap.lobby.starter, 1);
  assert.equal(host.snap.lobby.players[1].name, 'Ben');
  w.until(() => ben.snap.seat === 1 && ben.snap.lobby.starter === 1 && cleo.snap.lobby.starter === 1, 500);
  // start: Ben beginnt als Verlierer
  begin(w, host, [ben, cleo], { ready: false });
  assert.equal(w.game.startSeat, 1);
  assert.equal(w.game.startBy, 'loser');
  assert.equal(ben.snap.view.startBy, 'loser');
  assert.equal(ben.snap.view.you, 1);
  assert.equal(host.snap.lobby.starter, -1);
  // mitten in der Runde zurück in die Lobby: kein Verlierer -> wird ausgelost
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  assert.equal(host.snap.lobby.starter, -1);
  w.until(() => [ben, cleo].every((g) => g.snap.stage === 'lobby' && g.snap.lobby.starter === -1), 500);

  // Runde 2 (Hanna 0, Ben 1, Cleo 2): Cleo verliert; in der Lobby verlässt sie den Raum -> starter -1
  begin(w, host, [ben, cleo], { startSeat: 0, rig: rigQuick([0, 1]) });
  assert.equal(w.game.startBy, 'random');
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.synced([ben, cleo]), 300);
  assert.equal(ben.act({ t: 'play', cards: ['H2'] }), true);
  w.until(() => w.game.phase === 'over' && w.synced([ben, cleo]), 300);
  assert.equal(w.game.loser, 2);
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  assert.equal(host.snap.lobby.starter, 2);
  cleo.leave();
  w.until(() => host.snap.lobby.players.length === 2, 500);
  assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna'), person('Ben')] });
  w.until(() => ben.snap.lobby.players.length === 2 && ben.snap.lobby.starter === -1, 500);

  // Runde 3 (Hanna 0, Ben 1): Ben verliert und wird in der Lobby hinausgeworfen -> starter -1
  begin(w, host, [ben], { startSeat: 0, rig: rigQuick([0]) });
  assert.equal(w.game.startBy, 'random', 'der gemerkte Verlierer war weg');
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  assert.equal(w.game.phase, 'over', 'zu zweit endet die Runde, sobald einer fertig ist');
  assert.equal(w.game.loser, 1);
  assert.equal(w.game.gaveUp, null);
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  assert.equal(host.snap.lobby.starter, 1);
  assert.equal(host.lobby({ op: 'kick', seat: 1 }), true);
  assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna')] });
});

test('Neue Runde mitten in der Partie (es gibt erst einen Sieger): kein Verlierer -> Startspieler wird ausgelost', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna', 'Ben']);
  begin(w, host, guests, { startSeat: 0, rig: rigQuick([0]) });
  assert.equal(host.lobby({ op: 'rematch' }), false, 'noch kein Sieger');
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  assert.equal(w.game.winner, 0);
  assert.equal(w.game.phase, 'play');
  assert.equal(w.game.loser, null);
  const first = w.game;
  assert.equal(host.lobby({ op: 'rematch' }), true, 'sobald es einen Sieger gibt, darf der Host neu geben');
  assert.notEqual(w.game, first);
  assert.equal(w.game.startBy, 'random');
  w.until(() => guests.every((g) => g.snap.view.phase === 'swap' && g.snap.view.seq === w.game.seq), 500);
  for (const g of guests) { assert.equal(g.snap.view.startBy, 'random'); assert.equal(g.snap.view.winner, null); }
});

test('Endlosschleife (deadlock): die Runde endet ohne Verlierer – neue Runde und Lobby losen den Startspieler aus', (t) => {
  for (const how of ['rematch', 'toLobby']) {
    const w = world(t, { seed: how === 'rematch' ? 5 : 6 });
    const { host, guests } = lobby(w, ['Anna']);
    const anna = guests[0];
    // Ein einzelnes Ass wandert hin und her: beide haben sonst nur offene Karten, die nie auf das Ass passen.
    // Wer dran ist, muss aufnehmen und das Ass wieder legen – ohne Ausweg.
    begin(w, host, guests, {
      startSeat: 0,
      rig: (g) => {
        setZone(g, 0, 'hand', ['S14']); setZone(g, 0, 'up', ['S8', 'S5', 'S6']); setZone(g, 1, 'up', ['H8', 'H5', 'H6']);
        trimHand(g, 0, 1); trimHand(g, 1, 0); burnStock(g);
      }
    });
    assert.equal(host.act({ t: 'play', cards: ['S14'] }), true);
    let moves = 1;
    for (let round = 0; round < 6 && w.game.phase === 'play'; round++) {
      for (const s of [anna, host]) {
        if (w.game.phase !== 'play') break;
        w.until(() => w.synced(guests), 300);
        assert.deepEqual(s.snap.view.my, { zone: 'up', playable: [], canPickup: true, canFlip: false, forced: true }, s.label + ' kann nur aufnehmen');
        assert.equal(s.act({ t: 'pickup' }), true);
        w.until(() => w.synced(guests), 300);
        assert.deepEqual(s.snap.view.my.playable, ['S14']);
        assert.equal(s.act({ t: 'play', cards: ['S14'] }), true);
        w.until(() => s.snap.pending === 0 && s.snap.view.seq === w.game.seq, 300);
        moves += 2;
      }
    }
    w.until(() => w.synced(guests), 300);
    assert.equal(w.game.phase, 'over', 'der Host erkennt die Schleife');
    assert.equal(moves, 9, 'beim dritten Auftreten derselben Stellung');
    for (const s of [host, anna]) {
      const v = s.snap.view;
      assert.equal(v.deadlock, true);
      assert.equal(v.loser, null, 'kein Verlierer');
      assert.equal(v.winner, null);
      assert.equal(v.gaveUp, null);
      assert.deepEqual(v.finished, []);
      assert.equal(v.ev.deadlock, true);
      assert.equal(v.canGiveUp, false);
      assert.equal(v.turn, -1);
    }
    sameForAll(host, guests, w.game);
    assert.equal(host.lobby({ op: how }), true);
    if (how === 'toLobby') {
      assert.deepEqual(host.snap.lobby, { starter: -1, players: [person('Hanna'), person('Anna')] });
      w.until(() => anna.snap.stage === 'lobby', 300);
      assert.equal(anna.snap.lobby.starter, -1);
      assert.equal(host.lobby({ op: 'start' }), true);
    }
    assert.equal(w.game.startBy, 'random');
    assert.equal(w.game.deadlock, false);
    w.until(() => anna.snap.stage === 'game' && anna.snap.view.phase === 'swap', 300);
    assert.equal(anna.snap.view.startBy, 'random');
    assert.equal(anna.snap.view.deadlock, false);
    t.mock.timers.reset();
  }
});

/* ================================================================== Ganzes Spiel unter schlechten Bedingungen */

function finalChecks(w, host, guests, hostGame) {
  const g = hostGame || w.game;
  assert.equal(g.phase, 'over');
  assert.deepEqual(cardCount(g), { n: 54, uniq: 54 });
  const hv = host.snap.view;
  assert.equal(hv.phase, 'over');
  assert.equal(hv.winner, g.winner);
  assert.equal(hv.loser, g.loser);
  if (!g.deadlock) {
    assert.equal(g.finished.length, g.players.length - 1, 'alle bis auf einen sind fertig (oder einer hat aufgegeben)');
    assert.ok(g.loser >= 0 && !g.finished.includes(g.loser));
  }
  for (const gs of guests) {
    const v = gs.snap.view, seat = gs.snap.seat;
    assert.equal(gs.snap.stage, 'game');
    assert.equal(gs.snap.pending, 0);
    assert.deepEqual(publicPart(v), publicPart(hv), gs.label + ' sieht denselben öffentlichen Stand');
    assert.deepEqual(v.pile, g.pile);
    assert.equal(v.winner, g.winner);
    assert.equal(v.you, seat);
    v.players.forEach((p, i) => {
      assert.equal(p.n, g.players[i].hand.length);
      if (i === seat) assert.deepEqual(p.hand, g.players[i].hand, gs.label + ' sieht genau die eigene Hand');
      else assert.equal(p.hand, null, gs.label + ' sieht keine fremde Hand');
    });
    assert.deepEqual(gs.snap.lobby, host.snap.lobby);
  }
}

test('Ganzes Spiel: 2 Gäste + Host + Bot bei 30 % Nachrichtenverlust, Verzögerung und Umsortierung – alle sehen am Ende dasselbe, jede Aktion genau einmal', (t) => {
  for (const seed of [11, 12, 13]) {
    const w = world(t, { seed });
    const { host, guests, hostStore } = lobby(w, ['Anna', 'Ben']);
    host.lobby({ op: 'addBot' });
    const leak = leakWatch(w, hostStore);
    N.memBus.drop = 0.3; N.memBus.delay = 7; w.jitter = 25;
    assert.equal(host.lobby({ op: 'start' }), true);
    const all = [host].concat(guests);
    const ms = w.play(all, () => w.game.phase === 'over', 600000, 'Spiel endet trotz Verlust (seed ' + seed + ')');
    // bis alle den Endstand haben (weiterhin mit Verlust!)
    w.until(() => guests.every((g) => g.snap.view && g.snap.view.phase === 'over' && g.snap.view.seq === w.game.seq && g.snap.pending === 0), 20000, 'Endstand kommt bei allen an');
    finalChecks(w, host, guests);
    // Jede vom Gast abgeschickte Aktion wurde vom Host genau einmal und in der richtigen Reihenfolge angewandt
    guests.forEach((g) => {
      const applied = w.applied.filter((x) => x.seat === g.snap.seat).map((x) => x.a);
      assert.deepEqual(applied, g.sent, g.label + ': angewandte Aktionen == abgeschickte Aktionen (keine doppelt, keine verloren)');
      assert.ok(g.sent.length >= 2, g.label + ' hat mitgespielt');
    });
    const resent = w.published.filter((p) => p.ch === 'h' && p.t === 'act').length;
    const distinct = guests.reduce((n, g) => n + g.sent.length, 0);
    assert.ok(resent > distinct, 'es gab tatsächlich Wiederholungen (' + resent + ' Sendungen für ' + distinct + ' Aktionen)');
    noLeaks(leak);
    assert.ok(leak.views > 50);
    const vol = w.applied.filter((x) => x.ok && x.a.t === 'pickup').length;
    t.diagnostic('seed ' + seed + ': Spiel nach ' + ms + ' ms (virtuell), ' + (w.game.seq - 1) + ' Aktionen (' + vol + '× aufgenommen), ' + w.published.length + ' Nachrichten, ' + leak.views +
      ' Sichten geprüft, Rangfolge ' + w.game.finished.join(' > ') + ', Verlierer Sitz ' + w.game.loser + (w.game.deadlock ? ' (deadlock)' : ''));
    w.onPublish = null;
    N.memBus.drop = 0; N.memBus.delay = 0;
    t.mock.timers.reset();
  }
});

test('Geheimhaltung: keine Nachricht an einen Gast enthält fremde Handkarten, verdeckte Karten, Karten aus dem Nachziehstapel oder fremde Kennungen – ' +
  'in Lobby, Tausch, Spiel, nach Aufgeben, mit gegangenem Spieler, nach neuer Runde mit verschobenen Sitzen und nach Neuladen des Hosts', (t) => {
  const w = world(t, { seed: 5 });
  const { host, guests, hostStore } = lobby(w, ['Anna', 'Ben', 'Cleo']);
  const [anna, ben, cleo] = guests;
  const leak = leakWatch(w, hostStore);
  host.lobby({ op: 'addBot' });
  w.run(50);                                             // Lobby-Nachrichten (auch Pings/Pongs) laufen durch die Prüfung
  let all = [host].concat(guests);
  // Runde 1: bis zum regulären Ende
  assert.equal(host.lobby({ op: 'start' }), true);
  w.play(all, () => w.game.phase === 'over', 400000, 'Runde 1');
  w.until(() => w.synced(guests), 2000);
  finalChecks(w, host, guests);
  // Runde 2: sobald nur noch zwei Karten haben, gibt einer der beiden auf (ein Mensch, falls einer dabei ist)
  assert.equal(host.lobby({ op: 'rematch' }), true);
  w.play(all, () => w.game.phase === 'over' || (w.game.phase === 'play' && E.activeCount(w.game) === 2), 400000, 'Runde 2 bis zu zweit');
  let gaveUp = null;
  if (w.game.phase === 'play') {
    w.until(() => guests.every((g) => g.snap.view.seq === w.game.seq), 2000);
    const quitter = all.find((s) => s.snap.view.canGiveUp);
    assert.ok(quitter, 'mindestens ein Mensch ist noch im Spiel');
    gaveUp = quitter.snap.seat;
    quitter.act({ t: 'giveup' });
    w.until(() => w.game.phase === 'over', 2000, 'Aufgabe kommt an');
    assert.equal(w.game.gaveUp, gaveUp);
  }
  w.until(() => w.synced(guests), 2000);
  finalChecks(w, host, guests);
  // Runde 3: Cleo geht nach ein paar Zügen, ein Bot spielt für sie zu Ende
  assert.equal(host.lobby({ op: 'rematch' }), true);
  w.play(all, () => w.game.phase === 'play' && w.game.seq >= 15, 20000, 'Runde 3 läuft');
  cleo.leave();
  all = [host, anna, ben];
  w.play(all, () => w.game.phase === 'over', 400000, 'Runde 3 mit Bot für Cleo');
  w.until(() => w.synced([anna, ben]), 2000);
  finalChecks(w, host, [anna, ben]);
  assert.equal(host.snap.lobby.players[3].left, true);
  // Runde 4: Cleo ist weg, der Bot rückt von Sitz 4 auf Sitz 3; mittendrin lädt der Host neu
  assert.equal(host.lobby({ op: 'rematch' }), true);
  assert.equal(w.game.players.length, 4);
  w.play(all, () => w.game.phase === 'play' && w.game.seq >= 20 && w.synced([anna, ben]), 20000, 'Runde 4 läuft');
  host.kill();
  const host2 = w.session('host2', hostStore.handle());
  assert.equal(host2.resume(), true);
  all = [host2, anna, ben];
  w.play(all, () => host2.snap.view.phase === 'over', 400000, 'Runde 4 mit neu geladenem Host');
  w.until(() => [anna, ben].every((g) => g.snap.view.phase === 'over' && g.snap.view.seq === host2.snap.view.seq && g.snap.pending === 0), 2000);
  finalChecks(w, host2, [anna, ben], hostStore.saved().H.game);
  // zurück in die Lobby, noch einmal starten (Tauschphase), fertig
  assert.equal(host2.lobby({ op: 'toLobby' }), true);
  w.until(() => [anna, ben].every((g) => g.snap.stage === 'lobby'), 500);
  assert.equal(host2.lobby({ op: 'start' }), true);
  w.until(() => [anna, ben].every((g) => g.snap.stage === 'game'), 500);
  w.run(100);

  noLeaks(leak);
  assert.ok(leak.views > 400, 'viele Sichten geprüft: ' + leak.views);
  assert.ok(leak.lobbies >= 5, 'auch Lobby-Nachrichten: ' + leak.lobbies);
  for (const ph of ['swap', 'play', 'over']) assert.ok(leak.phases[ph] > 0, 'Sichten in Phase ' + ph);
  for (const ev of ['deal', 'play', 'pickup', 'flipfail']) assert.ok(leak.events[ev] > 0, 'Sichten nach Ereignis ' + ev);
  assert.deepEqual(Object.keys(leak.rounds), ['0', '1', '2', '3', '4', '5'], 'Rundennummern: Lobby vor dem ersten Spiel 0, dann je neuer Partie eine mehr (auch über das Neuladen des Hosts hinweg)');
  if (gaveUp !== null) assert.ok(leak.events.giveup > 0, 'Sichten nach dem Aufgeben');
  // Auf dem Host-Kanal 'h' reist nie eine Sicht; Gäste senden nur hello/ping/act/bye
  const kinds = new Set(w.published.filter((p) => p.ch === 'h').map((p) => p.t));
  for (const k of kinds) assert.ok(['hello', 'ping', 'act', 'bye'].includes(k), 'unerwartete Nachricht auf h: ' + k);
  assert.ok(w.published.filter((p) => p.ch === 'h').every((p) => p.from.indexOf('host') !== 0), 'der Host sendet nie auf h');
  assert.ok(w.published.filter((p) => p.from.indexOf('host') === 0).every((p) => p.ch.indexOf('p/') === 0));
  t.diagnostic(leak.states + ' state-Nachrichten (' + leak.views + ' mit Sicht, ' + leak.lobbies + ' Lobby), ' + leak.others + ' sonstige (pong/deny); Phasen ' +
    JSON.stringify(leak.phases) + '; Ereignisse ' + JSON.stringify(leak.events) + '; aufgegeben hat Sitz ' + gaveUp);
});

/* ================================================================== Duplikate / Umsortierung */

test('Doppelte und umsortierte act-Nachrichten werden genau einmal und in der richtigen Reihenfolge angewandt', (t) => {
  const w = world(t);
  const { host, code, guests, pids } = lobby(w, ['Anna']);
  const anna = guests[0], pid = pids[0];
  begin(w, host, guests, { startSeat: 1, rig: (g) => setZone(g, 1, 'hand', ['S3', 'H3', 'D9']) });   // Annas 'ready' ist ihre Aktion n=1
  assert.equal(w.game.turn, 1);
  assert.deepEqual(w.game.players[1].hand, ['S3', 'H3', 'D9']);
  const raw = w.raw(code);
  const A1 = { t: 'play', cards: ['S3'] }, A2 = { t: 'play', cards: ['H3'] }, A3 = { t: 'play', cards: ['D9'] };
  const mine = () => w.applied.filter((x) => x.seat === 1).slice(1).map((x) => [x.a, x.ok]);   // ohne das 'ready'
  const seq0 = w.game.seq;

  // dieselbe Aktion dreimal
  for (let i = 0; i < 3; i++) raw.publish('h', { t: 'act', pid, n: 2, a: A1 });
  w.run(30);
  assert.deepEqual(mine(), [[A1, true]], 'n=2 genau einmal angewandt');
  assert.deepEqual(w.game.pile, ['S3']);
  assert.equal(w.game.seq, seq0 + 1);
  assert.equal(w.game.turn, 1, 'zu zweit ist Anna nach der 3 nochmal dran');

  // umsortiert: n=4 kommt vor n=3 an -> n=4 darf NICHT vorgezogen werden
  raw.publish('h', { t: 'act', pid, n: 4, a: A3 });
  raw.publish('h', { t: 'act', pid, n: 4, a: A3 });
  w.run(10);
  assert.deepEqual(mine(), [[A1, true]], 'Lücke: n=4 wartet');
  assert.deepEqual(w.game.pile, ['S3']);
  raw.publish('h', { t: 'act', pid, n: 3, a: A2 });
  raw.publish('h', { t: 'act', pid, n: 2, a: A1 });           // uralte Wiederholung
  w.run(10);
  assert.deepEqual(mine(), [[A1, true], [A2, true]]);
  assert.deepEqual(w.game.pile, ['S3', 'H3']);
  raw.publish('h', { t: 'act', pid, n: 4, a: A3 });           // der Gast wiederholt n=4 (wie es clientTick täte)
  raw.publish('h', { t: 'act', pid, n: 3, a: A2 });
  raw.publish('h', { t: 'act', pid, n: 4, a: A3 });
  w.run(30);
  assert.deepEqual(mine(), [[A1, true], [A2, true], [A3, true]], 'jede Aktion genau einmal, in Reihenfolge');
  assert.deepEqual(w.game.pile, ['S3', 'H3', 'D9']);
  assert.equal(w.game.seq, seq0 + 3);
  assert.equal(w.game.turn, 0);
  assert.deepEqual(cardCount(w.game), { n: 54, uniq: 54 });
  // Unsinnige Zähler ändern nichts
  for (const n of [0, -1, 99, 'x', null, 4.7, undefined]) raw.publish('h', { t: 'act', pid, n, a: { t: 'pickup' } });
  w.run(30);
  assert.equal(mine().length, 3);
  // Die echte Sitzung des Gasts hat den Stand übernommen und zählt hinter der höchsten Bestätigung weiter
  w.until(() => anna.snap.view.seq === w.game.seq, 500);
  w.play([host], () => w.game.turn === 1 || w.game.phase === 'over', 5000, 'Host zieht');
  if (w.game.phase === 'play') {
    const before = mine().length;
    w.play([anna], () => mine().length > before && anna.snap.pending === 0, 2000, 'Annas nächste Aktion über die normale Sitzung');
    assert.equal(mine().length, before + 1);
    assert.equal(mine()[before][1], true, 'und sie wird angenommen');
  }
  raw.close();
});

test('Extra-Zug nach der eigenen 3 zu zweit: die Sicht bietet kein Aufnehmen an, und ein trotzdem geschicktes {t:"pickup"} lehnt der Host ab (cannot-pickup) – für Gast wie Host', (t) => {
  const w = world(t);
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  begin(w, host, guests, { startSeat: 1, rig: (g) => { setZone(g, 1, 'hand', ['S3', 'D9', 'C5']); setZone(g, 0, 'hand', ['H3', 'S12', 'S13']); } });
  const refused = () => w.applied.filter((x) => x.a && x.a.t === 'pickup').map((x) => [x.seat, x.ok, x.err]);
  // Gast: legt die 3, ist nochmal dran
  assert.equal(anna.act({ t: 'play', cards: ['S3'] }), true);
  w.until(() => w.synced(guests), 300);
  for (const s of [host, anna]) {
    assert.equal(s.snap.view.again, true, s.label + ' sieht den Extra-Zug');
    assert.equal(s.snap.view.turn, 1);
    assert.deepEqual(s.snap.view.ev.fx, ['again']);
  }
  let my = anna.snap.view.my;
  assert.deepEqual([my.canPickup, my.forced, my.canFlip], [false, false, false], 'obwohl etwas liegt');
  assert.deepEqual(anna.snap.view.pile, ['S3']);
  assert.ok(my.playable.length === anna.snap.view.players[1].n, 'auf die 3 passt alles');
  let frozen = JSON.stringify(w.game);
  assert.equal(anna.act({ t: 'pickup' }), true, 'beim Gast geht die Aktion erst einmal raus …');
  w.until(() => anna.snap.pending === 0, 300);
  assert.deepEqual(refused(), [[1, false, 'cannot-pickup']], '… und wird vom Host abgelehnt');
  assert.equal(JSON.stringify(w.game), frozen, 'nichts hat sich geändert');
  assert.equal(anna.snap.view.again, true);
  // ein normaler Zug beendet den Extra-Zug; danach darf der Nächste wieder aufnehmen
  assert.equal(anna.act({ t: 'play', cards: ['D9'] }), true);
  w.until(() => w.synced(guests), 300);
  assert.equal(host.snap.view.again, false);
  assert.equal(host.snap.view.my.canPickup, true);
  // Host: dasselbe auf Sitz 0 (H3 passt nicht auf die 9 – also erst aufnehmen, dann frei die 3 legen)
  assert.equal(host.act({ t: 'pickup' }), true);
  assert.equal(host.snap.view.my.canPickup, false, 'freier Zug: es liegt nichts');
  assert.equal(host.act({ t: 'play', cards: ['H3'] }), true);
  assert.equal(host.snap.view.again, true);
  my = host.snap.view.my;
  assert.deepEqual([my.canPickup, my.forced], [false, false]);
  assert.ok(my.playable.length > 0);
  frozen = JSON.stringify(w.game);
  assert.equal(host.act({ t: 'pickup' }), false);
  assert.deepEqual(refused().slice(-1), [[0, false, 'cannot-pickup']]);
  assert.equal(JSON.stringify(w.game), frozen);
  w.until(() => w.synced(guests), 300);
  assert.equal(anna.snap.view.again, true, 'auch der Gast sieht den Extra-Zug des Hosts');
  assert.equal(anna.snap.view.my, null);
  sameForAll(host, guests, w.game);
});

/* ================================================================== Neu laden */

test('Gast lädt neu: bekommt mitten im Spiel Sitz und Hand zurück und spielt weiter (auch unter Verlust)', (t) => {
  const w = world(t, { seed: 21 });
  const { host, guests, stores } = lobby(w, ['Anna', 'Ben']);
  host.lobby({ op: 'addBot' });
  const [anna, ben] = guests;
  host.lobby({ op: 'start' });
  const all = [host, anna, ben];
  w.play(all, () => w.game.phase === 'play' && w.game.seq >= 12, 20000, 'ein paar Züge');
  assert.equal(w.game.phase, 'play');
  const seat = anna.snap.seat, pid = stores[0].saved().pid;
  assert.deepEqual(Object.keys(stores[0].saved()).sort(), ['at', 'code', 'name', 'pid', 'role'], 'der Gast speichert nur, was er zum Wiederfinden braucht');
  assert.equal(stores[0].saved().role, 'client');
  // Seite neu laden: alte Sitzung ist weg (kein Abschied!)
  anna.kill();
  N.memBus.drop = 0.3; N.memBus.delay = 5;
  const anna2 = w.session('Anna2', stores[0].handle());
  assert.equal(anna2.snap.stage, 'idle');
  assert.equal(anna2.resume(), true);
  assert.equal(anna2.resume(), false, 'zweites resume tut nichts');
  assert.equal(anna2.snap.stage, 'connecting');
  w.until(() => anna2.snap.stage === 'game', 3000, 'Anna ist wieder drin');
  assert.equal(anna2.snap.seat, seat, 'gleicher Sitz');
  assert.equal(stores[0].saved().pid, pid, 'gleiche Kennung');
  w.until(() => anna2.snap.view.seq === w.game.seq, 3000);
  assert.deepEqual(anna2.snap.view.players[seat].hand, w.game.players[seat].hand, 'eigene Hand ist wieder da');
  assert.equal(anna2.snap.view.players[ben.snap.seat].hand, null);
  assert.equal(host.snap.lobby.players.length, 4, 'kein zusätzlicher Spieler entstanden');
  assert.equal(host.snap.lobby.players[seat].online, true);
  assert.equal(host.snap.lobby.players[seat].left, false);
  // weiter bis zum Ende, Anna spielt über die neue Sitzung
  const all2 = [host, anna2, ben];
  const before = w.applied.filter((x) => x.seat === seat).length;
  w.play(all2, () => w.game.phase === 'over', 600000, 'Spiel endet');
  w.until(() => [anna2, ben].every((g) => g.snap.view.phase === 'over' && g.snap.view.seq === w.game.seq && g.snap.pending === 0), 20000);
  finalChecks(w, host, [anna2, ben]);
  const after = w.applied.filter((x) => x.seat === seat).slice(before);
  assert.deepEqual(after.map((x) => x.a), anna2.sent, 'Aktionen der neuen Sitzung genau einmal angewandt (Zähler setzt hinter der Bestätigung fort)');
  assert.ok(anna2.sent.length > 0);
  t.diagnostic('neu geladen bei seq 12+, Spielende bei seq ' + w.game.seq + '; Aktionen vor/nach dem Neuladen: ' + anna.sent.length + '/' + anna2.sent.length + '; Nachrichten: ' + w.published.length);
});

test('Gast lädt neu, während nur noch zwei Spieler übrig sind: er darf weiterhin aufgeben, und die Aufgabe zählt genau einmal', (t) => {
  const w = world(t);
  const { host, guests, stores } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  begin(w, host, guests, { startSeat: 0, rig: rigQuick([0]) });
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.synced(guests), 300);
  ben.kill();
  const ben2 = w.session('Ben2', stores[1].handle());
  assert.equal(ben2.resume(), true);
  assert.equal(ben2.act({ t: 'giveup' }), false, 'vor dem ersten Stand geht noch nichts raus');
  w.until(() => ben2.snap.stage === 'game' && ben2.snap.view.seq === w.game.seq, 1000);
  assert.equal(ben2.snap.seat, 2);
  assert.equal(ben2.snap.view.canGiveUp, true);
  assert.equal(ben2.snap.view.my, null, 'Anna ist am Zug');
  assert.equal(ben2.act({ t: 'giveup' }), true);
  w.until(() => w.game.phase === 'over' && w.synced([anna, ben2]), 500);
  assert.deepEqual(w.applied.filter((x) => x.a.t === 'giveup').map((x) => [x.seat, x.ok]), [[2, true]]);
  assert.equal(anna.snap.view.loser, 2);
  assert.deepEqual(anna.snap.view.finished, [0, 1]);
  sameForAll(host, [anna, ben2], w.game);
  // … und in der nächsten Runde beginnt er
  begin(w, host, [anna, ben2], { op: 'rematch', ready: false });
  assert.equal(ben2.snap.view.startSeat, 2);
  assert.equal(ben2.snap.view.startBy, 'loser');
});

test('Host lädt neu: setzt dasselbe Spiel aus dem Speicher fort, Gäste gleichen sich wieder ab, offene Aktionen gehen nicht verloren', (t) => {
  const w = world(t, { seed: 33 });
  const { host, code, guests, hostStore } = lobby(w, ['Anna', 'Ben']);
  host.lobby({ op: 'addBot' });
  const [anna, ben] = guests;
  host.lobby({ op: 'start' });
  const all = [host, anna, ben];
  // spielen, bis ein Gast am Zug ist (mitten im Spiel)
  w.play(all, () => w.game.phase === 'play' && w.game.seq >= 14 && (w.game.turn === 1 || w.game.turn === 2) && guests.every((g) => g.snap.view.seq === w.game.seq && g.snap.pending === 0), 30000, 'Gast am Zug');
  const savedBefore = hostStore.saved();
  assert.equal(savedBefore.role, 'host');
  assert.deepEqual(savedBefore.H.game, clone(w.game), 'der Speicher enthält exakt den aktuellen Spielstand');
  const gameBefore = clone(w.game), verBefore = savedBefore.H.ver, epochBefore = savedBefore.H.epoch;
  const turnGuest = guests[w.game.turn - 1];
  const viewBefore = clone(host.snap.view);

  host.kill();                                           // Tab zu, kein "closed" an die Gäste
  assert.ok(!w.published.some((p) => p.t === 'deny'), 'kein deny beim harten Schließen');
  // der Gast zieht, während der Host weg ist -> Aktion bleibt offen
  humanStep(turnGuest, mulberry32(1));
  assert.equal(turnGuest.snap.pending, 1);
  w.run(120);
  assert.equal(turnGuest.snap.pending, 1);
  assert.equal(turnGuest.snap.stage, 'game', 'Gast bleibt im Spiel');

  const host2 = w.session('host2', hostStore.handle());
  assert.equal(host2.resume(), true);
  assert.equal(host2.snap.stage, 'game');
  assert.equal(host2.snap.isHost, true);
  assert.equal(host2.snap.code, code);
  assert.equal(host2.snap.seat, 0);
  assert.deepEqual(clone(host2.snap.view), viewBefore, 'Host sieht nach dem Neuladen exakt denselben Stand');
  assert.deepEqual(host2.snap.lobby.players.map((p) => p.name), savedBefore.H.players.map((p) => p.name));

  w.until(() => host2.snap.lobby.players.every((p) => p.online) && turnGuest.snap.pending === 0, 2000, 'Gäste melden sich, offene Aktion wird bestätigt');
  const now = hostStore.saved();
  assert.equal(now.H.epoch, epochBefore, 'gleiche Epoche');
  assert.ok(now.H.ver > verBefore, 'Version läuft weiter');
  assert.ok(now.H.game.seq >= gameBefore.seq + 1, 'Spiel läuft weiter');
  const actsOfGuest = w.applied.filter((x) => x.seat === turnGuest.snap.seat);
  assert.deepEqual(actsOfGuest.map((x) => x.a), turnGuest.sent, 'die während der Host-Pause abgeschickte Aktion wurde genau einmal angewandt');
  assert.equal(actsOfGuest[actsOfGuest.length - 1].ok, true, 'und angenommen');
  w.until(() => guests.every((g) => g.snap.hostOnline && g.snap.view.seq === host2.snap.view.seq), 2000, 'Gäste haben den aktuellen Stand');
  // Versionen, die die Gäste nach dem Neuladen bekommen, gehen nie rückwärts
  const vers = w.published.filter((p) => p.from === 'host2' && p.t === 'state').map((p) => p.ver);
  assert.ok(vers.length > 0 && vers.every((v) => v >= verBefore), 'neue Stände tragen keine ältere Version');
  assert.ok(vers.some((v) => v > verBefore));
  assert.ok(w.published.filter((p) => p.from === 'host2' && p.t === 'state').every((p) => p.epoch === epochBefore));

  // weiter bis zum Ende mit dem neuen Host
  const all2 = [host2, anna, ben];
  w.play(all2, () => host2.snap.view.phase === 'over', 600000, 'Spiel endet mit neu geladenem Host');
  w.until(() => guests.every((g) => g.snap.view.phase === 'over' && g.snap.view.seq === host2.snap.view.seq && g.snap.pending === 0), 5000);
  const finalGame = hostStore.saved().H.game;
  finalChecks(w, host2, guests, finalGame);
  guests.forEach((g) => {
    assert.deepEqual(w.applied.filter((x) => x.seat === g.snap.seat).map((x) => x.a), g.sent, g.label + ': jede Aktion genau einmal – über das Neuladen hinweg');
  });
  t.diagnostic('Host neu geladen bei seq ' + gameBefore.seq + ' (ver ' + verBefore + '), Spielende bei seq ' + finalGame.seq + ' (ver ' + hostStore.saved().H.ver + '); Aktionen der Gäste: ' + guests.map((g) => g.label + ' ' + g.sent.length).join(', '));
  // Neue Runde funktioniert auch nach dem Neuladen – und der Verlierer beginnt
  assert.equal(finalGame.deadlock, false);
  assert.equal(host2.lobby({ op: 'rematch' }), true);
  w.until(() => guests.every((g) => g.snap.view && g.snap.view.phase === 'swap'), 1000);
  assert.equal(host2.snap.view.startSeat, finalGame.loser);
  for (const g of guests) { assert.equal(g.snap.view.startSeat, finalGame.loser); assert.equal(g.snap.view.startBy, 'loser'); }
});

test('Host lädt neu – nach beendeter Runde und in der Lobby: der Verlierer bleibt gemerkt (rematch bzw. lobby.starter -> start)', (t) => {
  const w = world(t);
  const { host, guests, hostStore } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  begin(w, host, guests, { startSeat: 0, rig: rigQuick([0]) });
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.synced(guests), 300);
  anna.act({ t: 'giveup' });
  w.until(() => w.game.phase === 'over' && w.synced(guests), 300);
  assert.equal(w.game.loser, 1);
  // 1) Neuladen bei beendeter Runde, dann neue Runde
  host.kill();
  const host2 = w.session('host2', hostStore.handle());
  assert.equal(host2.resume(), true);
  assert.equal(host2.snap.stage, 'game');
  assert.equal(host2.snap.view.phase, 'over');
  assert.equal(host2.snap.view.loser, 1);
  assert.equal(host2.snap.view.gaveUp, 1);
  assert.deepEqual(host2.snap.view.finished, [0, 2]);
  w.until(() => host2.snap.lobby.players.every((p) => p.online), 1000);
  assert.equal(host2.lobby({ op: 'rematch' }), true);
  assert.equal(w.game.startSeat, 1);
  assert.equal(w.game.startBy, 'loser');
  w.until(() => guests.every((g) => g.snap.view.phase === 'swap' && g.snap.view.startBy === 'loser'), 500);
  // 2) noch eine Runde, zurück in die Lobby, dort neu laden
  host2.act({ t: 'ready' }); anna.act({ t: 'ready' }); ben.act({ t: 'ready' });
  w.until(() => w.game.phase === 'play' && w.synced(guests), 500);
  assert.equal(host2.lobby({ op: 'toLobby' }), true);
  assert.equal(host2.snap.lobby.starter, -1, 'abgebrochene Runde: kein Verlierer');
  begin(w, host2, guests, { startSeat: 0, rig: rigQuick([0, 1]) });
  assert.equal(host2.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.synced(guests), 300);
  assert.equal(anna.act({ t: 'play', cards: ['H2'] }), true);
  w.until(() => w.game.phase === 'over' && w.synced(guests), 300);
  assert.equal(w.game.loser, 2);
  assert.equal(host2.lobby({ op: 'toLobby' }), true);
  assert.equal(host2.snap.lobby.starter, 2);
  host2.kill();
  const host3 = w.session('host3', hostStore.handle());
  assert.equal(host3.resume(), true);
  assert.equal(host3.snap.stage, 'lobby');
  assert.equal(host3.snap.lobby.starter, 2, 'der gemerkte Verlierer übersteht das Neuladen');
  w.until(() => host3.snap.lobby.players.every((p) => p.online) && guests.every((g) => g.snap.hostOnline && g.snap.stage === 'lobby'), 1000);
  assert.equal(ben.snap.lobby.starter, 2);
  assert.equal(host3.lobby({ op: 'start' }), true);
  assert.equal(w.game.startSeat, 2);
  assert.equal(w.game.startBy, 'loser');
  w.until(() => guests.every((g) => g.snap.stage === 'game' && g.snap.view.startSeat === 2 && g.snap.view.startBy === 'loser'), 500);
});

test('Speicher: resume ohne/mit leerem/abgelaufenem/kaputtem Speicher; leave räumt auf', (t) => {
  const w = world(t);
  assert.equal(w.session('a').resume(), false, 'ohne Speicher');
  const st = makeStore();
  assert.equal(w.session('b', st.handle()).resume(), false, 'leerer Speicher');
  st.data[N.STORE_KEY] = '{kaputt';
  assert.equal(w.session('c', st.handle()).resume(), false, 'kaputtes JSON');
  st.data[N.STORE_KEY] = JSON.stringify({ role: 'client', at: Date.now() - 13 * 3600 * 1000, code: 'ABCDE', pid: 'abc', name: 'Alt' });
  assert.equal(w.session('d', st.handle()).resume(), false, 'älter als 12 Stunden');
  assert.equal(st.saved(), null, 'abgelaufener Eintrag wird gelöscht');
  st.data[N.STORE_KEY] = JSON.stringify({ role: 'quatsch', at: Date.now() });
  assert.equal(w.session('e', st.handle()).resume(), false);
  st.data[N.STORE_KEY] = JSON.stringify({ role: 'host', at: Date.now(), H: { code: 'ABCDE' } });
  assert.equal(w.session('f', st.handle()).resume(), false, 'unvollständiger Host-Stand');
  // Host speichert, leave löscht
  const hs = makeStore();
  const host = w.session('host', hs.handle());
  const code = host.host('Hanna');
  assert.equal(hs.saved().role, 'host');
  assert.equal(hs.saved().H.code, code);
  const gs = makeStore();
  const g = w.session('g', gs.handle());
  g.join(code, 'Gast');
  assert.equal(gs.saved().role, 'client');
  assert.equal(gs.saved().code, code);
  w.until(() => g.snap.stage === 'lobby', 500);
  // Lobby-Stand überlebt ein Neuladen des Hosts
  host.lobby({ op: 'addBot' });
  host.kill();
  const host2 = w.session('host2', hs.handle());
  assert.equal(host2.resume(), true);
  assert.equal(host2.snap.stage, 'lobby');
  assert.equal(host2.snap.code, code);
  assert.deepEqual(host2.snap.lobby.players.map((p) => p.bot), [false, false, true]);
  assert.equal(host2.snap.lobby.starter, -1);
  w.until(() => host2.snap.lobby.players[1].online && g.snap.hostOnline, 1000);
  assert.equal(host2.lobby({ op: 'start' }), true, 'und es kann normal weitergehen');
  w.until(() => g.snap.stage === 'game', 500);
  g.leave();
  assert.equal(gs.saved(), null, 'Gast: leave löscht die gespeicherte Sitzung');
  host2.leave();
  assert.equal(hs.saved(), null, 'Host: leave löscht den gespeicherten Raum');
});

/* ================================================================== Bots */

test('Bot-Tempo: nach Joker, Konter, Aufnehmen und gescheitertem Blindzug wartet der Bot 1,7 × T.bot, sonst genau T.bot', (t) => {
  const w = world(t, { seed: 71 });
  N.T.bot = 100;
  const NORMAL = 100, SLOW = 170;
  const host = w.session('host');
  host.host('Hanna');
  host.lobby({ op: 'addBot' });
  host.lobby({ op: 'addBot' });
  w.rig = (g) => { g.startSeat = 0; };
  assert.equal(host.lobby({ op: 'start' }), true);
  w.rig = null;
  assert.equal(host.act({ t: 'ready' }), true);
  const g = w.game;
  assert.equal(g.phase, 'play');
  assert.equal(g.turn, 0);
  // Stellung am laufenden Spiel herstellen (der nächste Stand geht ohnehin erst mit dem Zug des Hosts raus)
  setZone(g, 0, 'hand', ['JB', 'S9', 'H9']);
  setZone(g, 1, 'hand', ['JR', 'C4', 'D4']);
  setZone(g, 2, 'hand', ['C6', 'D8', 'H13']);
  const bots = () => w.applied.filter((x) => x.seat !== 0 && x.phase === 'play');
  const lastBot = () => bots()[bots().length - 1];
  const waitBot = (ms, what) => {
    const n = bots().length;
    w.run(ms - 1);
    assert.equal(bots().length, n, what + ': nicht vor Ablauf von ' + ms + ' ms');
    w.run(1);
    assert.equal(bots().length, n + 1, what + ': genau nach ' + ms + ' ms');
    assert.equal(lastBot().ok, true);
    return lastBot();
  };
  // Host legt den schwarzen Joker -> Bot 1 kontert mit Rot, nach der langen Pause
  assert.equal(host.act({ t: 'play', cards: ['JB'] }), true);
  assert.deepEqual(g.ev.fx, ['joker']);
  let a = waitBot(SLOW, 'nach Joker');
  assert.deepEqual([a.seat, a.a], [1, { t: 'play', cards: ['JR'] }]);
  assert.deepEqual(g.ev.fx, ['counter']);
  // Bot 2 muss aufnehmen (beide Joker verschwinden) – wieder lange Pause
  a = waitBot(SLOW, 'nach Konter');
  assert.deepEqual([a.seat, a.a], [2, { t: 'pickup' }]);
  assert.deepEqual([g.ev.t, g.ev.n, g.ev.joker, g.ev.vol, g.ev.gone], ['pickup', 0, true, false, ['JB', 'JR']]);
  assert.equal(g.turn, 2, 'wer aufgenommen hat, bleibt am Zug');
  // … und spielt danach selbst aus: lange Pause nach dem Aufnehmen
  a = waitBot(SLOW, 'nach Aufnehmen');
  assert.deepEqual([a.seat, a.a], [2, { t: 'play', cards: ['C6'] }]);
  assert.equal(g.turn, 0);
  w.run(1000);
  assert.equal(bots().length, 3, 'solange der Mensch dran ist, zieht kein Bot');
  // normaler Zug des Hosts -> normaler Takt
  assert.equal(host.act({ t: 'play', cards: ['S9'] }), true);
  a = waitBot(NORMAL, 'nach einem normalen Zug');
  assert.equal(a.seat, 1);

  // Rest der Partie: der Host zieht jeweils sofort; jeder Bot-Zug muss genau im erwarteten Abstand zum vorigen
  // angenommenen Zug liegen. Erwartung unabhängig aus dem Ereignis davor berechnet.
  const isSlow = (ev) => ev.t === 'pickup' || ev.t === 'flipfail' || (ev.fx || []).some((f) => f === 'joker' || f === 'counter');
  const from = w.applied.length;
  w.until(() => {
    const v = host.snap.view;
    if (v.phase === 'over') return true;
    if (v.turn === 0) {
      const my = v.my;
      if (my.playable.length) host.act({ t: 'play', cards: [my.playable[0]] });
      else if (my.canFlip) host.act({ t: 'flip', slot: [0, 1, 2].find((i) => v.players[0].down[i]) });
      else host.act({ t: 'pickup' });
    }
    return w.applied.length - from > 400;
  }, 200000, 'Partie gegen zwei Bots');
  const ok = w.applied.filter((x) => x.ok && x.phase === 'play');
  const seen = { slow: 0, normal: 0, kinds: {} };
  for (let i = 1; i < ok.length; i++) {
    if (ok[i].seat === 0) continue;
    const slow = isSlow(ok[i].before), want = slow ? SLOW : NORMAL;
    assert.equal(ok[i].at - ok[i - 1].at, want, 'Bot-Zug ' + i + ' nach ' + JSON.stringify(ok[i].before));
    if (slow) { seen.slow++; const k = ok[i].before.t === 'play' ? ok[i].before.fx.join('+') : ok[i].before.t; seen.kinds[k] = (seen.kinds[k] || 0) + 1; } else seen.normal++;
  }
  assert.ok(seen.slow >= 5 && seen.normal >= 10, JSON.stringify(seen));
  assert.ok(seen.kinds.pickup >= 1, 'lange Pause nach Aufnehmen kam vor');
  assert.equal(SLOW, Math.round(N.T.bot * 1.7));
  t.diagnostic('Bot-Züge im normalen Takt: ' + seen.normal + ', nach langer Pause: ' + seen.slow + ' ' + JSON.stringify(seen.kinds));
});

test('Bots geben nie auf – auch nicht für einen abwesenden oder gegangenen Spieler; ein Bot als Verlierer beginnt die nächste Runde', (t) => {
  const w = world(t, { seed: 72 });
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  host.lobby({ op: 'addBot' });
  // Der Host wird sofort fertig; übrig bleiben Anna (geht gleich) und der Bot.
  begin(w, host, guests, { startSeat: 0, rig: rigQuick([0]) });
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  anna.leave();
  w.until(() => host.snap.lobby.players[1].left, 300);
  w.until(() => host.snap.view.phase === 'over', 300000, 'zwei Bots spielen die Runde aus');
  assert.equal(w.applied.filter((x) => x.a && x.a.t === 'giveup').length, 0, 'kein Bot hat aufgegeben');
  assert.equal(w.game.gaveUp, null);
  assert.equal(w.game.deadlock, false);
  const loser = w.game.loser;
  assert.ok(loser === 1 || loser === 2);
  assert.equal(host.lobby({ op: 'rematch' }), true);
  if (loser === 2) {
    assert.deepEqual(host.snap.lobby.players.map((p) => p.bot), [false, true]);
    assert.equal(w.game.startSeat, 1, 'der Bot ist aufgerückt und beginnt als Verlierer');
    assert.equal(w.game.startBy, 'loser');
  } else {
    assert.equal(w.game.startBy, 'random', 'die Verliererin ist gegangen');
  }
  t.diagnostic('Verlierer war Sitz ' + loser + (loser === 2 ? ' (Bot)' : ' (Bot für die gegangene Anna)'));
});

/* ================================================================== Anwesenheit */

test('Anwesenheit: stummer Gast wird nach playerDead offline; Host lässt per "auto" einen Bot für ihn spielen; meldet er sich wieder, hat er die Kontrolle zurück', (t) => {
  const w = world(t, { seed: 44 });
  const { host, guests } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: true }), false, 'auto gibt es nur im Spiel');
  w.rig = (g) => { g.startSeat = 1; };
  host.lobby({ op: 'start' });
  w.rig = null;
  w.play([host, anna, ben], () => w.game.phase === 'play' && guests.every((g) => g.snap.view.phase === 'play'), 3000, 'alle bereit');
  assert.equal(w.game.turn, 1, 'Anna ist dran');
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: true }), false, 'für anwesende Spieler nicht erlaubt');
  assert.equal(host.lobby({ op: 'auto', seat: 0, on: true }), false, 'nicht für den Host selbst');
  assert.equal(host.lobby({ op: 'auto', seat: 7, on: true }), false);

  anna.port.muted = true;                                 // Handy im Standby
  const seqStill = w.game.seq;
  w.run(FAST.playerDead - 60);
  assert.equal(host.snap.lobby.players[1].online, true, 'noch innerhalb der Frist');
  w.run(60 + FAST.sweep * 2 + 10);
  assert.equal(host.snap.lobby.players[1].online, false, 'Host zeigt Anna als offline');
  assert.equal(host.snap.lobby.players[1].left, false, 'aber nicht als gegangen');
  assert.equal(host.snap.lobby.players[2].online, true);
  w.until(() => ben.snap.lobby.players[1].online === false, 300, 'auch Ben sieht Anna offline');
  assert.equal(w.game.seq, seqStill, 'ohne auto wartet das Spiel auf Anna');
  assert.equal(w.game.turn, 1);

  assert.equal(host.lobby({ op: 'auto', seat: 1, on: true }), true);
  assert.equal(host.snap.lobby.players[1].auto, true);
  const annaActs = () => w.applied.filter((x) => x.seat === 1 && x.ok).length;
  const a0 = annaActs();
  w.until(() => annaActs() === a0 + 1, FAST.bot + 20, 'Bot zieht für Anna');
  w.until(() => ben.snap.lobby.players[1].auto === true, 300);
  // eine Weile weiterspielen: der Bot übernimmt jeden Zug von Anna
  w.play([host, ben], () => annaActs() >= a0 + 3 || w.game.phase === 'over', 20000, 'Bot spielt weiter für Anna');
  assert.equal(w.game.phase, 'play', 'Spiel läuft noch (Testannahme)');
  assert.equal(anna.snap.hostOnline, false, 'Anna selbst merkt, dass sie den Host nicht mehr hört');

  anna.port.muted = false;                                // Handy wieder an
  w.until(() => host.snap.lobby.players[1].online === true && host.snap.lobby.players[1].auto === false, 500, 'Anna ist zurück und steuert wieder selbst');
  w.until(() => anna.snap.view.seq === w.game.seq && anna.snap.hostOnline === true && ben.snap.lobby.players[1].auto === false, 500);
  assert.deepEqual(anna.snap.view.players[1].hand, w.game.players[1].hand);
  // jetzt zieht KEIN Bot mehr für sie
  w.play([host, ben], () => w.game.turn === 1 || w.game.phase === 'over', 20000, 'bis Anna dran ist');
  if (w.game.phase === 'play') {
    const a1 = annaActs(), s1 = w.game.seq;
    w.run(200);
    assert.equal(w.game.seq, s1, 'niemand zieht für Anna');
    assert.equal(annaActs(), a1);
    w.until(() => anna.snap.view.seq === w.game.seq, 300);
    w.play([anna], () => annaActs() === a1 + 1, 1000, 'Anna zieht selbst');
  }
  // auto wieder abschalten geht jederzeit, einschalten nur für Abwesende
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: false }), true);
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: true }), false);
  t.diagnostic('Bot-Züge für die abwesende Anna: ' + (annaActs() - a0 - (w.game.phase === 'play' ? 1 : 0)) + ', Spielstand seq ' + w.game.seq + ', Phase ' + w.game.phase);
});

test('Anwesenheit: abwesender Gast in der Tauschphase – mit "auto" meldet der Bot ihn bereit und das Spiel beginnt', (t) => {
  const w = world(t, { seed: 46 });
  const { host, guests } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  host.lobby({ op: 'start' });
  w.until(() => guests.every((g) => g.snap.stage === 'game'), 500);
  anna.port.muted = true;
  host.act({ t: 'ready' });
  ben.act({ t: 'ready' });
  w.run(FAST.playerDead + FAST.sweep * 2 + 20);
  assert.equal(w.game.phase, 'swap', 'ohne Anna geht es nicht los');
  assert.equal(host.snap.lobby.players[1].online, false);
  assert.equal(host.lobby({ op: 'auto', seat: 1, on: true }), true);
  assert.equal(w.game.phase, 'play', 'der Bot hat für Anna "bereit" gemeldet');
  assert.equal(w.game.players[1].ready, true);
  w.until(() => ben.snap.view.phase === 'play', 300);
});

test('wake(): prüft die Verbindung und gleicht sofort ab (Gast pingt ohne Wartezeit), wirft in keiner Rolle', (t) => {
  const w = world(t);
  const idle = w.session('idle');
  assert.doesNotThrow(() => idle.wake());
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  w.run(5);
  const pings = () => w.published.filter((p) => p.from === 'Anna' && p.t === 'ping').length;
  const before = pings();
  assert.doesNotThrow(() => host.wake());
  anna.wake();
  assert.equal(pings(), before + 1, 'sofortiger Ping nach wake()');
  w.run(3);
  assert.equal(anna.snap.hostOnline, true);
});

test('Anwesenheit: hostOnline wird für Gäste false, wenn der Host verstummt, und wieder true, wenn er zurück ist – offene Aktionen kommen dann genau einmal an', (t) => {
  const w = world(t, { seed: 45 });
  const { host, guests } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  w.rig = (g) => { g.startSeat = 1; };
  host.lobby({ op: 'start' });
  w.rig = null;
  w.play([host, anna, ben], () => w.game.phase === 'play' && guests.every((g) => g.snap.view.phase === 'play' && g.snap.pending === 0), 3000);
  assert.equal(anna.snap.hostOnline, true);
  host.port.muted = true;
  w.run(FAST.hostDead - 60);
  assert.equal(anna.snap.hostOnline, true, 'noch innerhalb der Frist');
  w.run(60 + FAST.tick * 2 + 45);
  for (const g of guests) {
    assert.equal(g.snap.hostOnline, false, g.label + ' sieht den Host als weg');
    assert.equal(g.snap.stage, 'game', 'aber bleibt im Spiel');
    assert.equal(g.snap.error, null);
    assert.equal(g.snap.conn, 'online');
  }
  assert.equal(host.snap.hostOnline, true, 'für den Host selbst immer true');
  // Anna zieht ins Leere
  const seq0 = w.game.seq;
  assert.equal(humanStep(anna, mulberry32(3)), true);
  w.run(300);
  assert.equal(anna.snap.pending, 1);
  assert.equal(w.game.seq, seq0);
  host.port.muted = false;
  w.until(() => guests.every((g) => g.snap.hostOnline === true) && anna.snap.pending === 0, 500, 'Host wieder da');
  assert.equal(w.applied.filter((x) => x.seat === 1 && x.a.t !== 'ready').length, 1, 'Annas Zug genau einmal angewandt');
  assert.equal(w.game.seq, seq0 + 1);
  w.until(() => host.snap.lobby.players.every((p) => p.online), 500);
  w.until(() => guests.every((g) => g.snap.view.seq === w.game.seq), 500);
});

/* ================================================================== Feindliche Nachrichten */

test('Feindliche/kaputte Nachrichten auf "h" bringen den Host nie zum Absturz und ändern das Spiel nicht', (t) => {
  const w = world(t, { seed: 50 });
  const { host, code, guests, pids, hostStore } = lobby(w, ['Anna', 'Ben']);
  const [anna, ben] = guests;
  const pidA = pids[0], pidB = pids[1];
  const raw = w.raw(code);
  const ackOf = (seat) => hostStore.saved().H.players[seat].ack;

  // --- in der Lobby
  const lobbyBefore = clone(host.snap.lobby);
  const junk = [null, 0, 5, 'hallo', true, [], [1, 2], {}, { pid: 5 }, { pid: null }, { pid: '' }, { pid: {} }, { pid: ['x'] },
    { t: 'hello' }, { t: 'act', n: 1, a: { t: 'ready' } }, { pid: 'fremd' }, { pid: 'fremd', t: 'ping' }, { pid: 'fremd', t: 'act', n: 1, a: { t: 'ready' } },
    { pid: 'fremd', t: 'bye' }, { pid: 'fremd', t: 'quatsch' }, { pid: 'local', t: 'ping' }, { pid: 'local', t: 'act', n: 1, a: { t: 'ready' } }, { pid: 'local', t: 'bye' },
    { pid: '__proto__', t: 'ping' }, { pid: 'constructor', t: 'act', n: 1, a: null }, { pid: pidA }, { pid: pidA, t: null }, { pid: pidA, t: 'quatsch' },
    { pid: pidA, t: 'act' }, { pid: pidA, t: 'act', n: 1 }, { pid: pidA, t: 'act', n: 2, a: null }, { pid: pidA, t: 'act', n: 3, a: 'x' },
    { pid: pidA, t: 'ping', ver: 'x', epoch: {} }, { pid: pidA, t: 'ping' }, { pid: 'x'.repeat(100000), t: 'ping' }];
  for (const m of junk) raw.publish('h', m);
  w.run(60);
  assert.deepEqual(host.snap.lobby, lobbyBefore, 'Lobby unverändert');
  assert.equal(host.snap.stage, 'lobby');
  // Namen werden gesäubert, nie länger als 14 Zeichen – auch bei absurden Eingaben
  raw.publish('h', { pid: 'gast-x', t: 'hello', name: { length: 9999, a: [1, 2, 3] } });
  raw.publish('h', { pid: 'gast-y', t: 'hello', name: 'Y'.repeat(50000) + '\n\n<script>' });
  raw.publish('h', { pid: 'gast-z', t: 'hello' });
  w.run(30);
  assert.equal(host.snap.lobby.players.length, 6);
  for (const p of host.snap.lobby.players) { assert.equal(typeof p.name, 'string'); assert.ok(p.name.length >= 1 && p.name.length <= 14); assert.ok(!/\s{2,}|\n/.test(p.name)); }
  raw.publish('h', { pid: 'gast-7', t: 'hello', name: 'zu viel' });
  w.run(30);
  assert.equal(host.snap.lobby.players.length, 6, 'nie mehr als 6');
  assert.ok(w.published.some((p) => p.ch === 'p/gast-7' && p.t === 'deny' && p.why === 'full'));
  for (const seat of [5, 4, 3]) assert.equal(host.lobby({ op: 'kick', seat }), true);
  assert.deepEqual(host.snap.lobby.players.map((p) => p.name), ['Hanna', 'Anna', 'Ben']);

  // --- im Spiel
  w.rig = (g) => { g.startSeat = 1; };
  host.lobby({ op: 'start' });
  w.rig = null;
  w.play([host, anna, ben], () => w.game.phase === 'play' && guests.every((g) => g.snap.view.phase === 'play' && g.snap.pending === 0), 3000);
  assert.equal(w.game.turn, 1);
  const frozen = JSON.stringify(w.game);
  const hostCard = w.game.players[0].hand[0], benCard = w.game.players[2].hand[0], annaCard = w.game.players[1].hand[0];
  const appliedBefore = w.applied.length;
  const hostile = junk.concat([
    // Ben (nicht am Zug) versucht für Anna bzw. den Host zu handeln – der Sitz kommt nur aus der pid, nie aus der Nachricht
    { pid: pidB, t: 'act', n: 2, seat: 1, a: { t: 'play', cards: [annaCard] } },
    { pid: pidB, t: 'act', n: 3, seat: 0, a: { t: 'play', cards: [hostCard], seat: 0 } },
    { pid: pidB, t: 'act', n: 4, a: { t: 'pickup' } },
    { pid: pidB, t: 'act', n: 5, a: { t: 'flip', slot: 0 } },
    { pid: pidB, t: 'act', n: 6, a: { t: 'ready' } },
    { pid: pidB, t: 'act', n: 7, a: { t: 'giveup' } },                       // zu dritt nicht erlaubt
    { pid: pidB, t: 'act', n: 8, seat: 1, a: { t: 'giveup', seat: 1 } },
    // Unbekannte und Pseudo-Kennungen
    { pid: 'fremd', t: 'hello', name: 'Eindringling' },
    { pid: 'fremd', t: 'act', n: 1, a: { t: 'play', cards: [annaCard] } },
    { pid: 'local', t: 'hello', name: 'falscher Host' },
    { pid: 'local', t: 'act', n: 1, a: { t: 'play', cards: [hostCard] } },
    { pid: 'local', t: 'act', n: 1, a: { t: 'giveup' } },
    { pid: 'bot-aaaaaa', t: 'act', n: 1, a: { t: 'pickup' } },
    // Müll-Aktionen der Spielerin am Zug mit falschem Zähler (werden gar nicht erst angewandt)
    { pid: pidA, t: 'act', n: 99, a: { t: 'play', cards: [annaCard] } },
    { pid: pidA, t: 'act', n: 0, a: { t: 'play', cards: [annaCard] } },
    { pid: pidA, t: 'act', n: '2', a: { t: 'play', cards: [benCard] } }
  ]);
  for (const m of hostile) raw.publish('h', m);
  for (let i = 0; i < 40; i++) raw.publish('h', { pid: 'flut-' + i, t: 'hello', name: 'Flut' });
  w.run(80);
  // Müll-Aktionen mit passendem Zähler: werden angewandt, von der Engine abgelehnt, ändern nichts
  const garbageActs = [null, 5, 'x', [], {}, { t: 'play' }, { t: 'play', cards: 'S5' }, { t: 'play', cards: [null] }, { t: 'play', cards: [hostCard] },
    { t: 'play', cards: [benCard, benCard] }, { t: 'flip', slot: 0 }, { t: 'flip', slot: '__proto__' }, { t: 'ready' }, { t: '__proto__' },
    { t: 'play', cards: new Array(5000).fill('S5') }, { t: 'ready', swap: { hand: annaCard, up: 0 } }, { t: 'giveup' }, { t: 'pickup' }];
  let n = ackOf(1) + 1;   // lückenlos hinter Annas letzter bestätigter Aktion (der Müll oben hat schon Nummern verbraucht)
  assert.equal(ackOf(2), 8, 'Bens sieben Versuche wurden gezählt (und abgelehnt)');
  for (const a of garbageActs) raw.publish('h', { pid: pidA, t: 'act', n: n++, a });
  w.run(80);
  assert.equal(JSON.stringify(w.game), frozen, 'Spielstand ist Byte für Byte unverändert');
  assert.equal(host.snap.stage, 'game');
  assert.equal(host.snap.lobby.players.length, 3, 'niemand ist dazugekommen');
  const mine = w.applied.slice(appliedBefore);
  assert.equal(mine.length, 7 + garbageActs.length, 'angewandt wird nur, was von einer bekannten Kennung mit passendem Zähler kommt');
  assert.ok(mine.every((x) => x.ok === false), 'keine der feindlichen Aktionen wurde angenommen');
  assert.ok(mine.every((x) => x.seat === 1 || x.seat === 2), 'Aktionen landen nur auf dem Sitz der sendenden Kennung');
  assert.deepEqual(mine.filter((x) => x.a && x.a.t === 'giveup').map((x) => [x.seat, x.err]), [[2, 'cannot-giveup'], [2, 'cannot-giveup'], [1, 'cannot-giveup']]);
  assert.ok(w.published.some((p) => p.ch === 'p/fremd' && p.t === 'deny' && p.why === 'running'));
  assert.ok(w.published.some((p) => p.ch === 'p/flut-39' && p.t === 'deny' && p.why === 'running'));
  // Der Host lebt und das Spiel geht normal weiter; Annas echte Sitzung holt den Zählerstand auf
  w.until(() => anna.snap.view.seq === w.game.seq && anna.snap.pending === 0, 500);
  const before = w.applied.filter((x) => x.ok).length;
  w.play([anna], () => w.applied.filter((x) => x.ok).length === before + 1, 2000, 'Anna zieht nach dem Angriff normal');
  w.play([host, anna, ben], () => w.game.seq >= JSON.parse(frozen).seq + 6 || w.game.phase === 'over', 20000, 'Spiel läuft weiter');
  assert.deepEqual(cardCount(w.game), { n: 54, uniq: 54 });
  raw.close();
});

test('JSON-Werte, die sich nicht in Text/Zahl umwandeln lassen ({"toString":1}), lassen den Host nicht werfen (hello.name, act.n, ping.ver)', (t) => {
  const evil = { toString: 1, valueOf: 1 };
  const cases = [
    ['hello eines Unbekannten mit name={"toString":1}', () => ({ pid: 'neu-1', t: 'hello', name: { toString: 1 } })],
    ['hello eines bekannten Gasts mit name={"toString":1}', (pid) => ({ pid, t: 'hello', name: { toString: 1 } })],
    ['act mit n={"toString":1,"valueOf":1}', (pid) => ({ pid, t: 'act', n: evil, a: { t: 'ready' } })],
    ['ping mit ver/epoch als Objekt', (pid) => ({ pid, t: 'ping', ver: evil, epoch: evil })],
    ['act mit a={"toString":1}', (pid) => ({ pid, t: 'act', n: 1, a: evil })],
    ['bye/unbekannter Typ mit Objekt-Feldern', (pid) => ({ pid, t: evil, name: evil, n: evil })]
  ];
  const thrown = [];
  for (const [name, make] of cases) {
    // je Fall eine frische Welt: eine Ausnahme im Zeitgeber soll die übrigen Fälle nicht verfälschen
    const w = world(t, { seed: 52 });
    const { host, code, pids } = lobby(w, ['Anna']);
    const raw = w.raw(code);
    const realError = console.error; let logged = 0;
    console.error = () => { logged++; };                   // net.js meldet verworfene Nachrichten über console.error
    try { raw.publish('h', make(pids[0])); w.run(20); } catch (e) { thrown.push(name + ' -> ' + e.message); } finally { console.error = realError; }
    if (logged) thrown.push(name + ' -> Ausnahme im Nachrichten-Handler (' + logged + '×)');
    assert.equal(host.snap.stage, 'lobby');
    for (const p of host.snap.lobby.players) assert.equal(typeof p.name, 'string');
    t.mock.timers.reset();
  }
  assert.deepEqual(thrown, [], 'der Nachrichten-Handler des Hosts wirft');
});

test('Gäste überstehen fremde und kaputte Nachrichten auf ihrem Kanal ohne Absturz; veraltete Stände werden verworfen', (t) => {
  const w = world(t, { seed: 51 });
  const { host, code, guests, pids } = lobby(w, ['Anna']);
  const anna = guests[0], pid = pids[0];
  const raw = w.raw(code);
  const before = clone(anna.snap);
  for (const m of [null, 0, 'x', [], {}, { t: 'quatsch' }, { t: 'pong' }, { t: 'pong', ver: 'x' }]) raw.publish('p/' + pid, m);
  w.run(50);
  assert.deepEqual(clone(anna.snap), before);
  assert.equal(host.snap.lobby.players.length, 2);
  // veralteter Stand (kleinere Version, gleiche Epoche) wird verworfen
  const epoch = w.published.filter((p) => p.t === 'state').pop().epoch;
  raw.publish('p/' + pid, { t: 'state', epoch, ver: 0, ack: 0, seat: 5, lobby: { starter: 3, players: [] }, view: null });
  w.run(20);
  assert.equal(anna.snap.seat, 1, 'alter Stand überschreibt nichts');
  assert.deepEqual(anna.snap.lobby, host.snap.lobby);
  raw.close();
});

/* ================================================================== Design und Strichliste (gehören zum Raum) */

test('Design: nur der Host stellt es ein, es kommt bei allen an, unbekannte Werte werden abgelehnt, und es übersteht neue Runden', (t) => {
  const w = world(t, { seed: 61 });
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  assert.deepEqual(host.snap.room, { table: 'normal', cards: 'normal', wins: [0, 0] });
  w.until(() => anna.snap.room !== null, 300);
  assert.deepEqual(anna.snap.room, host.snap.room);
  assert.equal(host.lobby({ op: 'design', table: 'stahl' }), true);
  assert.equal(host.lobby({ op: 'design', cards: 'filz' }), true);
  w.until(() => anna.snap.room.cards === 'filz', 300, 'Design beim Gast');
  assert.deepEqual(anna.snap.room, { table: 'stahl', cards: 'filz', wins: [0, 0] });
  assert.equal(host.lobby({ op: 'design', table: 'quatsch' }), false);
  assert.equal(host.lobby({ op: 'design', cards: {} }), false);
  assert.equal(anna.lobby({ op: 'design', table: 'nacht' }), false, 'Gäste dürfen das nicht');
  assert.equal(host.snap.room.table, 'stahl');
  begin(w, host, guests, { startSeat: 0 });
  assert.equal(host.lobby({ op: 'design', table: 'nacht', cards: 'druck' }), true, 'auch während der Partie');
  w.until(() => anna.snap.room.table === 'nacht', 300);
  assert.equal(host.lobby({ op: 'toLobby' }), true);
  w.until(() => anna.snap.stage === 'lobby', 300);
  assert.deepEqual(anna.snap.room, { table: 'nacht', cards: 'druck', wins: [0, 0] });
});

test('Strichliste: ein Strich für den Sieger, genau einmal pro Runde, über mehrere Runden und für alle sichtbar', (t) => {
  const w = world(t, { seed: 62 });
  const { host, guests } = lobby(w, ['Anna']);
  const anna = guests[0];
  begin(w, host, guests, { startSeat: 0, rig: rigQuick([0]) });
  assert.equal(host.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.game.winner === 0 && w.synced(guests), 300);
  assert.deepEqual(host.snap.room.wins, [1, 0]);
  assert.deepEqual(anna.snap.room.wins, [1, 0]);
  host.lobby({ op: 'design', table: 'patio' });                    // weitere Stände derselben Runde zählen nicht noch einmal
  w.until(() => anna.snap.room.table === 'patio', 300);
  assert.deepEqual(anna.snap.room.wins, [1, 0]);
  begin(w, host, guests, { op: 'rematch', startSeat: 1, rig: rigQuick([1]) });
  assert.deepEqual(host.snap.room.wins, [1, 0], 'neue Runde: noch kein neuer Strich');
  assert.equal(anna.act({ t: 'play', cards: ['S2'] }), true);
  w.until(() => w.game.winner === 1 && w.synced(guests), 300);
  assert.deepEqual(host.snap.room.wins, [1, 1]);
  assert.deepEqual(anna.snap.room.wins, [1, 1]);
});
