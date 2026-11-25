'use strict';
/* Karma – Aushang der offenen Räume (KarmaNet.watchRooms und die Meldungen des Hosts).
 * Läuft über den In-Process-Bus ('mem'), braucht kein Internet.
 *
 * Ausführen:  node --test test/aushang.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const E = require(path.join(__dirname, '..', 'src', 'engine.js'));
const N = require(path.join(__dirname, '..', 'src', 'net.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + (ms || 1500);
  while (Date.now() < end) { if (fn()) return; await sleep(15); }
  assert.fail('Zeit abgelaufen: ' + (what || fn.toString()));
}
const host = (announce) => N.createSession({ engine: E, transport: 'mem', announce: announce !== false });
function watch() {
  const w = { last: { searching: true, rooms: [] }, calls: 0 };
  w.h = N.watchRooms({ transport: 'mem', onChange: (o) => { w.last = o; w.calls++; } });
  w.codes = () => w.last.rooms.map((r) => r.code);
  return w;
}
const saved = Object.assign({}, N.T);
test.beforeEach(() => { Object.assign(N.T, saved, { dirBeat: 5000, dirGone: 11000, dirWait: 200, start: 0, swap: 0, turn: 0 }); N.memBus.drop = 0; N.memBus.delay = 0; });
test.after(() => { Object.assign(N.T, saved); });

test('Aushang: Raum erscheint mit Host-Name, Spielerzahl und Zustand; Änderungen kommen sofort; nach dem Schließen ist er weg', async () => {
  const w = watch(), s = host();
  const code = s.host('  Sio  ');
  await until(() => w.last.rooms.length === 1, 1000, 'Raum erscheint');
  assert.deepEqual(w.last.rooms[0], { code, host: 'Sio', n: 1, max: N.MAX_PLAYERS, state: 'lobby' });
  assert.equal(w.last.searching, false);
  s.lobby({ op: 'addBot' }); s.lobby({ op: 'addBot' });
  await until(() => w.last.rooms[0] && w.last.rooms[0].n === 3, 1000, 'Spielerzahl 3');   // weit vor dem nächsten Takt (5 s)
  s.lobby({ op: 'start' });
  await until(() => w.last.rooms[0] && w.last.rooms[0].state === 'game', 1000, 'Zustand: läuft');
  s.lobby({ op: 'toLobby' });
  await until(() => w.last.rooms[0] && w.last.rooms[0].state === 'lobby', 1000, 'Zustand: Lobby');
  s.leave();
  await until(() => w.last.rooms.length === 0, 1000, 'Raum verschwindet');
  w.h.close();
  await sleep(350);   // der Abschied schließt die Verbindung verzögert
});

test('Aushang: Wer die Startseite später öffnet, bekommt die Liste auf Nachfrage sofort – nicht erst zum nächsten Takt', async () => {
  const a = host(), b = host();
  const ca = a.host('Ada'), cb = b.host('Ben');
  b.lobby({ op: 'addBot' }); b.lobby({ op: 'start' });
  await sleep(400);   // die eigenen Sofort-Meldungen sind vorbei, der nächste Takt wäre in 5 s
  const w = watch();
  await until(() => w.last.rooms.length === 2, 800, 'beide Räume auf Nachfrage');
  assert.deepEqual(w.codes(), [ca, cb], 'Lobbys zuerst, laufende Runden danach');
  assert.equal(w.last.rooms[1].state, 'game');
  a.leave(); b.leave(); w.h.close();
  await sleep(350);
});

test('Aushang: Verschwindet ein Host ohne Abschied, fällt sein Raum nach T.dirGone aus der Liste', async () => {
  Object.assign(N.T, { dirBeat: 100, dirGone: 500 });
  const w = watch(), s = host();
  s.host('Sio');
  await until(() => w.last.rooms.length === 1, 1000, 'Raum erscheint');
  await sleep(700);
  assert.equal(w.last.rooms.length, 1, 'solange der Host meldet, bleibt der Raum stehen');
  N.memBus.drop = 1;   // Funkstille
  await until(() => w.last.rooms.length === 0, 2500, 'Raum fällt heraus');
  N.memBus.drop = 0;
  await until(() => w.last.rooms.length === 1, 1000, 'und kommt mit der nächsten Meldung wieder');
  s.leave(); w.h.close();
  await sleep(350);
});

test('Aushang: Ohne „announce“ meldet der Host nichts; „searching“ endet nach T.dirWait', async () => {
  const w = watch(), s = host(false);
  s.host('Still');
  await sleep(120);
  assert.equal(w.last.searching, true);
  await until(() => w.last.searching === false, 2500, 'Suche endet');
  assert.deepEqual(w.last.rooms, []);
  s.leave(); w.h.close();
  await sleep(350);
});

test('Aushang: Unsinn und fremde Formen werden verworfen, Namen gekürzt, Zahlen begrenzt', async () => {
  const w = watch(), raw = N.transports.mem('#karma-aushang-1');
  raw.start();
  const bad = [null, 'x', {}, { code: 'abcde', host: 'klein', n: 2 }, { code: 'ABCD', host: 'kurz', n: 2 }, { code: 'ABCDE!', host: 'lang', n: 2 },
    { code: 'ABCDE', host: 'null', n: 0 }, { code: 'ABCDE', host: 'viele', n: 99 }, { code: 'AB0DE', host: 'Null im Code', n: 2 }];
  bad.forEach((m) => raw.publish('r', m));
  raw.publish('x', { code: 'ZZZZZ', host: 'falscher Kanal', n: 2 });
  await sleep(120);
  assert.deepEqual(w.last.rooms, []);
  raw.publish('r', { code: 'QRSTU', host: '  Ein   sehr langer Name hier ', n: 12, st: 'irgendwas', extra: { a: 1 } });
  await until(() => w.last.rooms.length === 1, 800, 'gültiger Eintrag');
  assert.deepEqual(w.last.rooms[0], { code: 'QRSTU', host: 'Ein sehr lange', n: 12, max: N.MAX_PLAYERS, state: 'lobby' });
  raw.publish('r', { code: 'QRSTU', gone: true });
  await until(() => w.last.rooms.length === 0, 800, 'Abschied');
  raw.close(); w.h.close();
});

test('Aushang: Nach close() kommt nichts mehr an, und ein beigetretener Gast ändert die Spielerzahl', async () => {
  const w = watch(), s = host(), g = N.createSession({ engine: E, transport: 'mem' });
  const code = s.host('Sio');
  await until(() => w.last.rooms.length === 1, 1000);
  assert.equal(g.join(code, 'Gast'), true);
  await until(() => w.last.rooms[0] && w.last.rooms[0].n === 2, 1500, 'Gast zählt mit');
  w.h.close();
  const calls = w.calls;
  s.lobby({ op: 'addBot' });
  await sleep(300);
  assert.equal(w.calls, calls, 'nach close() keine Meldung mehr');
  g.leave(); s.leave();
  await sleep(350);
});
