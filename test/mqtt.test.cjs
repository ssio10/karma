/* Tests für src/mqtt.js – Aufruf: node --test test/mqtt.test.cjs
 *
 * Teil 1 (offline): Hash/Chiffre gegen veröffentlichte Testvektoren, Umschlag, MQTT-Protokoll gegen
 *                   einen nachgebauten Broker im selben Prozess (Paketgrenzen, Müll, Backoff, kick …).
 * Teil 2 (live):    echte öffentliche Broker (nur Raumcodes und Testnamen gehen über die Leitung).
 *                   Ein einzelner wackliger Broker lässt die Suite nicht scheitern (es zählt, was die
 *                   Vorab-Messung als erreichbar meldet). Ist KEIN Broker erreichbar (kein Internet),
 *                   werden alle live-Tests mit einer klaren Meldung übersprungen; ist nur einer
 *                   erreichbar, scheitert der Erreichbarkeitstest und der Rest wird übersprungen.
 * Teil 3 (live):    Raum und Partie über das Relay nach den aktuellen Regeln (KARMA.pdf + Klarstellungen:
 *                   2/7/10/Joker gehen immer, Joker verschwinden beim Aufnehmen, freiwilliges Aufnehmen,
 *                   Rangfolge bis zum Verlierer, Verlierer beginnt die nächste Runde, Aufgeben zu zweit):
 *                   eine komplette Runde mit Zuggrenze, danach neue Runde / Verlassen / Lobby, und ein
 *                   Hin-und-zurück für das Aufgeben.
 *
 * Andere Brokerliste zum Ausprobieren (z. B. mit einem toten Broker darin):
 *   KARMA_TEST_BROKERS='["wss://…","wss://…"]' node --test test/mqtt.test.cjs
 * Bestimmte Kartenverteilung der Partie wiederholen (die Zahl steht in der Ausgabe jedes Laufs):
 *   KARMA_TEST_SEED=123456 node --test test/mqtt.test.cjs
 */
'use strict';
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const Net = require('../src/net.js');
const M = require('../src/mqtt.js');
const Engine = require('../src/engine.js');

assert.strictEqual(globalThis.KarmaNet, Net);
assert.strictEqual(typeof Net.transports.mqtt, 'function');

assert.ok(Array.isArray(Net.MQTT_BROKERS) && Net.MQTT_BROKERS.length >= 3, 'Standardliste hat mehrere Broker');
const DEFAULT_BROKERS = Net.MQTT_BROKERS.slice();
if (process.env.KARMA_TEST_BROKERS) Net.MQTT_BROKERS = JSON.parse(process.env.KARMA_TEST_BROKERS);
const REAL_BROKERS = Net.MQTT_BROKERS.slice();
const REAL_T = Object.assign({}, Net.MQTT_T);
const REAL_NET_T = Object.assign({}, Net.T);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hexOf = b => Buffer.from(b).toString('hex');
const unhex = s => new Uint8Array(Buffer.from(s.replace(/\s+/g, ''), 'hex'));
const newCode = () => Net.randId(5, Net.CODE_ALPHA);
const urlOf = spec => (typeof spec === 'string' ? spec : spec.url);
const hostOf = spec => new URL(urlOf(spec)).hostname;
const hasLogin = spec => typeof spec === 'object' && spec !== null && spec.user != null;
/* Kleiner Zufallsgenerator mit Startwert, damit sich eine Partie (Kartenverteilung) wiederholen lässt. */
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let x = Math.imul(a ^ a >>> 15, 1 | a);
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}

/* Wartet auf eine Bedingung. Ist der Test, der wartet, inzwischen zu Ende (z. B. weil ein paralleler Zweig
 * gescheitert ist), bricht das Warten ab, statt den Prozess bis zur Frist am Leben zu halten. */
let testEpoch = 0;
async function until(cond, ms, label) {
  const end = Date.now() + ms, epoch = testEpoch;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (epoch !== testEpoch) throw new Error('abgebrochen (Test beendet): ' + label);
    if (Date.now() > end) assert.fail('Zeitüberschreitung (' + ms + ' ms): ' + label);
    await sleep(10);
  }
}

/* Ein Transport mit Mitschrift. opts: {brokers, WS} */
const openPeers = new Set();
function peer(code, chans, opts) {
  opts = opts || {};
  const savedB = Net.MQTT_BROKERS, savedW = Net.MQTT_WebSocket;
  Net.MQTT_BROKERS = opts.brokers || REAL_BROKERS;
  Net.MQTT_WebSocket = opts.WS || undefined;
  const t = Net.transports.mqtt(code);
  const p = { t, msgs: [], status: [], online: false, startedAt: Date.now(), onlineAt: 0 };
  t.onMessage = (ch, m) => p.msgs.push({ ch, m, at: Date.now() });
  t.onStatus = on => { p.online = on; p.status.push(on); if (on && !p.onlineAt) p.onlineAt = Date.now(); };
  p.count = pred => p.msgs.filter(x => pred(x.m, x.ch)).length;
  p.ready = () => t._brokers().filter(b => b.ready).length;
  (chans || []).forEach(c => t.subscribe(c));
  if (!opts.noStart) t.start();
  Net.MQTT_BROKERS = savedB; Net.MQTT_WebSocket = savedW;
  openPeers.add(p);
  return p;
}
afterEach(() => {
  testEpoch++;
  openPeers.forEach(p => { try { p.t.close(); } catch (e) {} });
  openPeers.clear();
  Object.assign(Net.MQTT_T, REAL_T);
  Object.assign(Net.T, REAL_NET_T);
  Net.MQTT_BROKERS = REAL_BROKERS.slice();
  Net.MQTT_WebSocket = undefined;
});

/* ====================================================================================
 * Teil 1a: Kryptografie
 * ==================================================================================== */

test('SHA-256: FIPS-180-Testvektoren und Abgleich mit node:crypto', () => {
  const vec = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0']
  ];
  vec.forEach(([msg, want]) => assert.strictEqual(hexOf(M.sha256(M.utf8(msg))), want));
  for (let n = 0; n <= 200; n++) {      // alle Polster-Grenzfälle (55/56/63/64/119/120 …)
    const b = nodeCrypto.randomBytes(n);
    assert.strictEqual(hexOf(M.sha256(b)), nodeCrypto.createHash('sha256').update(b).digest('hex'), 'Länge ' + n);
  }
});

test('HMAC-SHA-256: RFC-4231-Testvektoren und Abgleich mit node:crypto', () => {
  assert.strictEqual(hexOf(M.hmac(new Uint8Array(20).fill(0x0b), [M.utf8('Hi There')])),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.strictEqual(hexOf(M.hmac(M.utf8('Jefe'), [M.utf8('what do ya want '), M.utf8('for nothing?')])),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  // RFC 4231 Fall 6: Schlüssel länger als ein Block
  assert.strictEqual(hexOf(M.hmac(new Uint8Array(131).fill(0xaa), [M.utf8('Test Using Larger Than Block-Size Key - Hash Key First')])),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  for (const kl of [1, 32, 64, 65, 200]) {
    const k = nodeCrypto.randomBytes(kl), d = nodeCrypto.randomBytes(333);
    assert.strictEqual(hexOf(M.hmac(k, [d.subarray(0, 100), d.subarray(100)])), nodeCrypto.createHmac('sha256', k).update(d).digest('hex'));
  }
});

test('ChaCha20: RFC-8439-Testvektoren und Abgleich mit node:crypto', () => {
  const key = new Uint8Array(32).map((_, i) => i);
  // RFC 8439 §2.3.2: Schlüsselstrom-Block (Zähler 1)
  const block = M.chacha20(key, unhex('000000090000004a00000000'), 1, new Uint8Array(64));
  assert.strictEqual(hexOf(block),
    '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e' +
    'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e');
  // RFC 8439 §2.4.2: Verschlüsselung über zwei Blöcke
  const plain = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
  const ct = M.chacha20(key, unhex('000000000000004a00000000'), 1, M.utf8(plain));
  assert.strictEqual(hexOf(ct),
    '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b' +
    'f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8' +
    '07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736' +
    '5af90bbf74a35be6b40b8eedf2785e42874d');
  assert.strictEqual(Buffer.from(M.chacha20(key, unhex('000000000000004a00000000'), 1, ct)).toString(), plain);
  for (const n of [0, 1, 63, 64, 65, 127, 128, 129, 1000, 5000]) {
    const k = nodeCrypto.randomBytes(32), nonce = nodeCrypto.randomBytes(12), d = nodeCrypto.randomBytes(n);
    const iv = Buffer.concat([Buffer.from([1, 0, 0, 0]), nonce]);   // OpenSSL: Zähler (LE) + Nonce
    assert.strictEqual(hexOf(M.chacha20(k, nonce, 1, d)), nodeCrypto.createCipheriv('chacha20', k, iv).update(d).toString('hex'), 'Länge ' + n);
  }
});

test('Umschlag: falscher Raumcode, falscher Kanal und veränderte Bytes werden verworfen', () => {
  const k = M.roomKeys('ABCDE'), other = M.roomKeys('ABCDF');
  assert.match(k.tag, /^[0-9a-f]{20}$/);
  assert.notStrictEqual(k.tag, other.tag);
  assert.ok(k.tag.toUpperCase().indexOf('ABCDE') < 0);
  assert.strictEqual(M.roomKeys('ABCDE').tag, k.tag);

  const text = JSON.stringify({ s: 'x', n: 1, o: { name: 'Jürgen 🂡', big: 'k'.repeat(3000) } });
  const sealed = M.seal(k, 'p/abc', text);
  assert.strictEqual(sealed.length, 24 + Buffer.byteLength(text));
  assert.strictEqual(M.open(k, 'p/abc', sealed), text);
  assert.strictEqual(M.open(other, 'p/abc', sealed), null, 'anderer Raum');
  assert.strictEqual(M.open(k, 'p/abd', sealed), null, 'anderer Kanal');
  assert.strictEqual(M.open(k, 'h', sealed), null, 'anderer Kanal');
  for (let i = 0; i < sealed.length; i += (i < 40 ? 1 : 97)) {       // jedes Kopf-Byte, Stichproben im Rest
    const bad = sealed.slice(); bad[i] ^= 1 << (i % 8);
    assert.strictEqual(M.open(k, 'p/abc', bad), null, 'gekipptes Bit in Byte ' + i);
  }
  assert.strictEqual(M.open(k, 'p/abc', sealed.subarray(0, sealed.length - 1)), null, 'abgeschnitten');
  assert.strictEqual(M.open(k, 'p/abc', sealed.subarray(0, 24)), null);
  assert.strictEqual(M.open(k, 'p/abc', new Uint8Array(0)), null);
  assert.strictEqual(M.open(k, 'p/abc', nodeCrypto.randomBytes(500)), null, 'Müll');

  const again = M.seal(k, 'p/abc', text);                            // frische Nonce je Nachricht
  assert.notStrictEqual(hexOf(again.subarray(0, 12)), hexOf(sealed.subarray(0, 12)));
  assert.notStrictEqual(hexOf(again.subarray(24, 56)), hexOf(sealed.subarray(24, 56)));
  assert.ok(Buffer.from(sealed).indexOf('Jürgen') < 0 && Buffer.from(sealed).indexOf('kkkk') < 0, 'Klartext nicht sichtbar');
});

/* ====================================================================================
 * Teil 1b: MQTT-Protokoll gegen einen nachgebauten Broker
 * ==================================================================================== */

const hubs = new Map();
function hub(url) {
  const h = {
    url, socks: [], attempts: [], log: [],
    accept: true,        // false: Verbindungsaufbau scheitert
    connack: 0,          // Rückgabecode, null = Broker schweigt
    auth: null,          // {user, pass}: nur diese Anmeldung wird angenommen (sonst Rückgabecode 5)
    suback: true, subackDelay: 0, pong: true,
    framing: 'whole'     // 'whole' | 'bytes' | 'batch' | 'random'
  };
  h.live = () => h.socks.filter(s => s.readyState === 1);
  h.of = type => h.log.filter(e => e.type === type);
  hubs.set(url, h);
  return h;
}
function rlBytes(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return Buffer.from(o); }

class FakeWS {
  constructor(url, proto) {
    const h = hubs.get(url);
    if (!h) throw new Error('unbekannte Test-URL ' + url);
    Object.assign(this, { h, url, proto, readyState: 0, binaryType: 'blob', bufferedAmount: 0, frozen: false,
      topics: new Set(), inbuf: Buffer.alloc(0), outq: [], flushing: false,
      onopen: null, onmessage: null, onclose: null, onerror: null });
    h.attempts.push(Date.now());
    h.socks.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      if (!h.accept) { this.readyState = 3; this._emit('onerror', {}); this._emit('onclose', { code: 1006 }); return; }
      this.readyState = 1;
      this._emit('onopen', {});
    }, 1);
  }
  _emit(name, ev) { if (!this.frozen && typeof this[name] === 'function') this[name](ev); }
  send(data) {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    if (this.frozen) return;                                   // Zombie: schluckt alles
    const b = data.buffer ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
    this.inbuf = Buffer.concat([this.inbuf, b]);
    for (;;) {
      const buf = this.inbuf;
      if (buf.length < 2) return;
      let i = 1, mult = 1, len = 0, d;
      do { if (i >= buf.length) return; d = buf[i++]; len += (d & 127) * mult; mult *= 128; } while (d & 128);
      if (buf.length < i + len) return;
      const raw = buf.subarray(0, i + len), body = buf.subarray(i, i + len);
      this.inbuf = buf.subarray(i + len);
      this._server(raw[0], body, raw);
    }
  }
  _server(head, body, raw) {
    const h = this.h, type = head >> 4;
    h.log.push({ sock: this, type, head, body: Buffer.from(body), at: Date.now() });
    if (type === 1) {
      const e = h.log[h.log.length - 1], flags = body[7];
      let p = 10;
      const str = () => { const l = body.readUInt16BE(p), s = body.subarray(p + 2, p + 2 + l).toString(); p += 2 + l; return s; };
      e.flags = flags;
      e.clientId = str();
      e.user = flags & 0x80 ? str() : undefined;
      e.pass = flags & 0x40 ? str() : undefined;
      e.rest = body.length - p;                                  // 0, wenn das Paket genau aufgeht
      let code = h.connack;
      if (code === 0 && h.auth && (e.user !== h.auth.user || e.pass !== h.auth.pass)) code = 5;
      if (code !== null) this._push(Buffer.from([0x20, 2, 0, code]));
    } else if (type === 8) {
      const id = body.subarray(0, 2); let p = 2, n = 0;
      while (p < body.length) { const tl = body.readUInt16BE(p); this.topics.add(body.subarray(p + 2, p + 2 + tl).toString()); p += 2 + tl + 1; n++; }
      const ack = Buffer.concat([Buffer.from([0x90, 2 + n]), id, Buffer.alloc(n)]);
      if (h.suback) { if (h.subackDelay) setTimeout(() => this._push(ack), h.subackDelay); else this._push(ack); }
    } else if (type === 3) {
      const topic = body.subarray(2, 2 + body.readUInt16BE(0)).toString();
      h.socks.forEach(s => { if (s.topics.has(topic)) s._push(raw); });   // wie ein echter Broker: auch an den Absender
    } else if (type === 12) { if (h.pong) this._push(Buffer.from([0xD0, 0])); }
    else if (type === 14) this._kill();
  }
  /* Broker → Client, mit der eingestellten Stückelung */
  _push(buf) {
    if (this.readyState !== 1 || this.frozen) return;
    this.outq.push(Buffer.from(buf));
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      const all = Buffer.concat(this.outq), parts = this.outq;
      this.outq = [];
      let frames = parts;
      if (this.h.framing === 'batch') frames = [all];
      else if (this.h.framing === 'bytes') frames = Array.from(all, b => Buffer.from([b]));
      else if (this.h.framing === 'random') {
        frames = [];
        for (let p = 0; p < all.length;) { const n = 1 + Math.floor(Math.random() * 40); frames.push(all.subarray(p, p + n)); p += n; }
      }
      frames.forEach(f => this._frame(f));
    });
  }
  _frame(f) {
    if (this.readyState !== 1) return;
    if (typeof f === 'string') return this._emit('onmessage', { data: f });
    this._emit('onmessage', { data: f.buffer.slice(f.byteOffset, f.byteOffset + f.length) });
  }
  close() { if (this.readyState >= 2) return; this.readyState = 3; setTimeout(() => this._emit('onclose', { code: 1000 }), 1); }
  _kill() { if (this.readyState >= 2) return; this.readyState = 3; setTimeout(() => this._emit('onclose', { code: 1006 }), 1); }
}
const fastT = { ping: 60000, pong: 60000, kick: 60, connack: 150, backoffMin: 20, backoffMax: 160, stable: 60000 };
function fakePeer(code, chans, urls, opts) {
  return peer(code, chans, Object.assign({ brokers: urls, WS: FakeWS }, opts || {}));
}
function rawPublish(topic, payload, head) {
  return Buffer.from(M.packet(head === undefined ? 0x30 : head, [M.mqttStr(topic), payload]));
}

test('Protokoll: CONNECT/SUBSCRIBE sind korrekt, online erst nach SUBACK, Topic verrät den Code nicht', async () => {
  Object.assign(Net.MQTT_T, fastT);
  const h = hub('fake://handshake');
  h.subackDelay = 80;
  const code = 'QW3RT', p = fakePeer(code, ['h', 'p/abc'], [h.url]);
  await until(() => h.of(8).length === 1, 500, 'SUBSCRIBE');
  const sock = h.socks[0];
  assert.strictEqual(sock.proto, 'mqtt');
  assert.strictEqual(sock.binaryType, 'arraybuffer');

  const c = h.of(1)[0].body;
  assert.strictEqual(h.of(1)[0].head, 0x10);
  assert.strictEqual(c.subarray(0, 7).toString('hex'), '00044d51545404', 'Protokollname MQTT, Version 4 (3.1.1)');
  assert.strictEqual(c[7], 0x02, 'nur Clean Session');
  assert.strictEqual(c.readUInt16BE(8), Net.MQTT_T.keepalive);
  const idLen = c.readUInt16BE(10), clientId = c.subarray(12, 12 + idLen).toString();
  assert.match(clientId, /^[0-9a-zA-Z]{1,23}$/);
  assert.strictEqual(12 + idLen, c.length);

  const s = h.of(8)[0];
  assert.strictEqual(s.head, 0x82);
  const tag = M.roomKeys(code).tag;
  assert.deepStrictEqual([...sock.topics].sort(), ['karma1/' + tag + '/h', 'karma1/' + tag + '/p/abc']);
  assert.ok(![...sock.topics].some(tp => tp.toUpperCase().includes(code)));
  assert.strictEqual(s.body[s.body.length - 1], 0, 'QoS 0');

  await sleep(30);
  assert.deepStrictEqual(p.status, [], 'vor dem SUBACK noch nicht online');
  assert.strictEqual(p.t._brokers()[0].connected, true);
  await until(() => p.online, 500, 'online nach SUBACK');
  assert.deepStrictEqual(p.status, [true]);

  // zweiter Transport: andere Client-ID
  const q = fakePeer(code, ['h'], [h.url]);
  await until(() => q.online, 500, 'q online');
  const c2 = h.of(1)[1].body;
  assert.notStrictEqual(c2.subarray(12).toString(), clientId);
});

test('Brokerliste: mehrere Betreiber, alles wss, mindestens ein Relay auf Port 443, Anmeldedaten vollständig', () => {
  const hosts = DEFAULT_BROKERS.map(hostOf);
  assert.strictEqual(new Set(hosts).size, hosts.length, 'kein Broker doppelt: ' + hosts.join(', '));
  const site = h => h.split('.').slice(-2).join('.');
  assert.strictEqual(new Set(hosts.map(site)).size, hosts.length, 'jeder Broker bei einem anderen Betreiber');
  DEFAULT_BROKERS.forEach(spec => {
    const u = new URL(urlOf(spec));
    assert.strictEqual(u.protocol, 'wss:', 'nur verschlüsselte Verbindungen (die Seite läuft über https): ' + u.href);
    assert.ok(typeof spec === 'string' || (spec && typeof spec.url === 'string'), 'Eintrag ist URL oder {url, user, pass}');
    if (hasLogin(spec)) {
      assert.strictEqual(typeof spec.user, 'string');
      assert.ok(spec.pass == null || typeof spec.pass === 'string');
    } else if (typeof spec === 'object') assert.ok(spec.pass == null, 'Passwort ohne Benutzer wird nicht gesendet');
  });
  const on443 = DEFAULT_BROKERS.filter(spec => (new URL(urlOf(spec)).port || '443') === '443');
  assert.ok(on443.length >= 1, 'mindestens ein Broker auf Port 443 (Netze, die nur 80/443 durchlassen)');
});

test('Protokoll: Broker mit Anmeldung – CONNECT trägt Benutzer und Passwort, andere Einträge bleiben anonym', async () => {
  Object.assign(Net.MQTT_T, fastT);
  const hLogin = hub('fake://login'), hAnon = hub('fake://anon'), hUser = hub('fake://nur-benutzer'), hEmpty = hub('fake://leeres-passwort');
  hLogin.auth = { user: 'public', pass: 'pässwort €' };
  hAnon.auth = { user: undefined, pass: undefined };
  hUser.auth = { user: 'demo', pass: undefined };
  hEmpty.auth = { user: 'demo', pass: '' };
  const specs = [{ url: hLogin.url, user: 'public', pass: 'pässwort €' }, hAnon.url, { url: hUser.url, user: 'demo' }, { url: hEmpty.url, user: 'demo', pass: '' }];
  const code = newCode(), a = fakePeer(code, ['a'], specs), b = fakePeer(code, ['b'], specs);
  await until(() => a.ready() === 4 && b.ready() === 4, 1000, 'alle vier Broker nehmen die Anmeldung an');
  const con = h => h.of(1)[0];
  assert.strictEqual(con(hLogin).flags, 0xC2, 'Clean Session + Benutzer + Passwort');
  assert.strictEqual(con(hLogin).user, 'public');
  assert.strictEqual(con(hLogin).pass, 'pässwort €');
  assert.strictEqual(con(hAnon).flags, 0x02, 'ohne Zugangsdaten: nur Clean Session');
  assert.strictEqual(con(hUser).flags, 0x82, 'nur Benutzer');
  assert.strictEqual(con(hEmpty).flags, 0xC2, 'leeres Passwort wird als leeres Feld gesendet');
  assert.strictEqual(con(hEmpty).pass, '');
  [hLogin, hAnon, hUser, hEmpty].forEach(h => {
    h.of(1).forEach(e => {
      assert.strictEqual(e.rest, 0, 'CONNECT geht genau auf');
      assert.match(e.clientId, /^[0-9a-zA-Z]{1,23}$/);
    });
  });
  a.t.publish('b', { n: 1 });
  await until(() => b.count(m => m.n === 1) === 1, 500, 'Nachricht über die angemeldeten Verbindungen');
  await sleep(30);
  assert.strictEqual(b.msgs.length, 1, 'genau einmal trotz vier Brokern');

  // Falsche oder fehlende Anmeldung: dieser eine Broker lehnt ab (Rückgabecode 5) und wird weiter versucht,
  // die übrigen tragen den Raum – so verhält sich z. B. public.cloud.shiftr.io ohne „public/public“.
  const wrong = [{ url: hLogin.url, user: 'public', pass: 'falsch' }, hAnon.url];
  const n0 = hLogin.attempts.length;
  const c = fakePeer(code, ['c'], wrong);
  await until(() => c.online && hLogin.attempts.length >= n0 + 3, 2000, 'online über den anderen Broker, der abgelehnte wird neu versucht');
  assert.deepStrictEqual(c.t._brokers().map(x => x.ready), [false, true]);
  assert.deepStrictEqual(c.status, [true]);
  a.t.publish('c', { n: 2 });
  await until(() => c.count(m => m.n === 2) === 1, 500, 'Nachricht kommt trotzdem an');
  const d = fakePeer(code, ['d'], [hLogin.url]);                      // ganz ohne Anmeldung, einziger Broker
  await sleep(200);
  assert.deepStrictEqual(d.status, [], 'ohne Anmeldung nie online');
  assert.ok(hLogin.of(1).some(e => e.flags === 0x02), 'der anonyme Versuch kam an und wurde abgelehnt');
});

test('Protokoll: Nachrichten in beide Richtungen, genau einmal trotz drei Brokern, nie an sich selbst', async () => {
  Object.assign(Net.MQTT_T, fastT);
  const hs = [hub('fake://m1'), hub('fake://m2'), hub('fake://m3')], urls = hs.map(h => h.url);
  const code = newCode();
  const a = fakePeer(code, ['x', 'a'], urls), b = fakePeer(code, ['x', 'b'], urls);
  const stranger = fakePeer(newCode(), ['x', 'a', 'b'], urls);
  await until(() => a.ready() === 3 && b.ready() === 3 && stranger.ready() === 3, 1000, 'alle bereit');

  const sizes = [0, 60, 100, 130, 5000, 16300, 16400, 70000];      // über die Längenfeld-Grenzen 127 und 16383 hinweg
  sizes.forEach((n, i) => {
    a.t.publish('x', { i, from: 'a', pad: 'ä'.repeat(n >> 1) });
    b.t.publish('x', { i, from: 'b', pad: '€'.repeat(Math.floor(n / 3)) });
    a.t.publish('b', { i, direct: true });
    b.t.publish('a', { i, direct: true });
  });
  await until(() => a.msgs.length >= 16 && b.msgs.length >= 16, 2000, 'alles angekommen');
  await sleep(50);
  assert.strictEqual(a.msgs.length, 16);
  assert.strictEqual(b.msgs.length, 16);
  sizes.forEach((n, i) => {
    assert.strictEqual(b.count(m => m.i === i && m.from === 'a' && m.pad === 'ä'.repeat(n >> 1)), 1);
    assert.strictEqual(a.count(m => m.i === i && m.from === 'b' && m.pad === '€'.repeat(Math.floor(n / 3))), 1);
    assert.strictEqual(b.count((m, ch) => m.i === i && m.direct && ch === 'b'), 1);
    assert.strictEqual(a.count((m, ch) => m.i === i && m.direct && ch === 'a'), 1);
  });
  assert.strictEqual(a.count(m => m.from === 'a'), 0, 'eigene Nachrichten kommen nicht zurück');
  assert.strictEqual(stranger.msgs.length, 0, 'fremder Raum sieht nichts');
  hs.forEach(h => assert.ok(h.of(3).length >= 32, 'jeder Broker hat jede Nachricht bekommen'));
  // Reihenfolge je Kanal bleibt erhalten
  assert.deepStrictEqual(b.msgs.filter(x => x.ch === 'x').map(x => x.m.i), sizes.map((_, i) => i));
});

test('Protokoll: subscribe() nach start() wirkt, auch nach einem Neuverbinden', async () => {
  Object.assign(Net.MQTT_T, fastT);
  const h = hub('fake://latesub'), code = newCode();
  const a = fakePeer(code, [], [h.url]), b = fakePeer(code, ['b'], [h.url]);
  await until(() => a.online && b.online, 500, 'online (ohne Kanal gilt verbunden als bereit)');
  b.t.publish('late', { n: 1 });
  await sleep(30);
  assert.strictEqual(a.msgs.length, 0);
  a.t.subscribe('late');
  a.t.subscribe('late');
  await until(() => a.ready() === 1 && h.socks[0].topics.size === 1, 500, 'SUBACK für späten Kanal');
  b.t.publish('late', { n: 2 });
  await until(() => a.count(m => m.n === 2) === 1, 500, 'Nachricht auf spätem Kanal');
  h.socks.forEach(s => s._kill());
  await until(() => h.live().length === 2 && a.ready() === 1 && b.ready() === 1, 1000, 'neu verbunden');
  assert.ok(h.live().some(s => s.topics.has('karma1/' + M.roomKeys(code).tag + '/late')), 'nach Neuverbinden wieder abonniert');
  b.t.publish('late', { n: 3 });
  await until(() => a.count(m => m.n === 3) === 1, 500, 'Nachricht nach Neuverbinden');
});

for (const framing of ['bytes', 'batch', 'random']) {
  test('Protokoll: Paketgrenzen ≠ Frame-Grenzen (' + framing + ')', async () => {
    Object.assign(Net.MQTT_T, fastT);
    const h = hub('fake://framing-' + framing), code = newCode();
    h.framing = framing;
    const a = fakePeer(code, ['a'], [h.url]), b = fakePeer(code, ['b'], [h.url]);
    await until(() => a.online && b.online, 1000, 'online');
    const N = 40;
    for (let i = 0; i < N; i++) a.t.publish('b', { i, pad: 'p'.repeat(i % 7 === 0 ? 3000 : i * 9) });
    await until(() => b.msgs.length >= N, 3000, 'alle ' + N + ' Nachrichten');
    await sleep(30);
    assert.deepStrictEqual(b.msgs.map(x => x.m.i), Array.from({ length: N }, (_, i) => i));
    assert.strictEqual(h.attempts.length, 2, 'keine Verbindung ging dabei verloren');
  });
}

test('Protokoll: ein Frame mit mehreren Paketen, Paket mitten im Längenfeld geteilt', async () => {
  Object.assign(Net.MQTT_T, fastT);
  const h = hub('fake://frames'), code = newCode(), k = M.roomKeys(code), topic = 'karma1/' + k.tag + '/b';
  const b = fakePeer(code, ['b'], [h.url]);
  await until(() => b.online, 500, 'online');
  const sock = h.socks[0];
  const msg = (n, pad) => rawPublish(topic, M.seal(k, 'b', JSON.stringify({ s: 'other', n, o: { n, pad: pad || '' } })));
  const p1 = msg(1), p2 = msg(2, 'z'.repeat(400)), p3 = msg(3), p4 = msg(4, 'y'.repeat(20000));
  assert.ok(p2[1] & 128, 'p2 hat ein zweibytiges Längenfeld');
  assert.ok((p4[1] & 128) && (p4[2] & 128), 'p4 hat ein dreibytiges Längenfeld');
  const unknown = Buffer.from([0xB0, 2, 0, 9, 0x90, 3, 0xff, 0xff, 0]);   // UNSUBACK + SUBACK mit fremder ID
  const stream = Buffer.concat([Buffer.from([0xD0, 0]), p1, unknown, p2, p3, p4, Buffer.from([0xD0, 0])]);
  const cut1 = 2 + p1.length + unknown.length + 2;                         // mitten im Längenfeld von p2
  const cut2 = cut1 + 5, cut3 = stream.length - p4.length + 1, cut4 = stream.length - 300;
  [stream.subarray(0, 1), stream.subarray(1, cut1), stream.subarray(cut1, cut2), stream.subarray(cut2, cut3),
    stream.subarray(cut3, cut3 + 1), stream.subarray(cut3 + 1, cut4), stream.subarray(cut4)].forEach(f => sock._frame(f));
  assert.deepStrictEqual(b.msgs.map(x => x.m.n), [1, 2, 3, 4]);
  assert.strictEqual(b.msgs[3].m.pad.length, 20000);
  sock._frame(Buffer.concat([msg(5), msg(6), msg(7)]));                    // drei Pakete in einem Frame
  assert.deepStrictEqual(b.msgs.map(x => x.m.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.strictEqual(h.attempts.length, 1);
});

test('Protokoll: Müll, Fälschungen, retained und QoS-1-Pakete; keine Ausnahme dringt nach außen', async () => {
  Object.assign(Net.MQTT_T, fastT);
  const h = hub('fake://garbage'), code = newCode(), k = M.roomKeys(code), topic = 'karma1/' + k.tag + '/b';
  const b = fakePeer(code, ['b'], [h.url]);
  await until(() => b.online, 500, 'online');
  let sock = h.socks[0];
  const env = n => JSON.stringify({ s: 'other', n, o: { n } });
  const good = n => rawPublish(topic, M.seal(k, 'b', env(n)));

  // Dinge, die still ignoriert werden und die Verbindung NICHT kosten
  sock._frame('ein Text-Frame');
  sock._frame(Buffer.alloc(0));
  sock._frame(rawPublish(topic, nodeCrypto.randomBytes(300)));                                 // Müll
  sock._frame(rawPublish(topic, Buffer.alloc(0)));
  sock._frame(rawPublish(topic, M.seal(M.roomKeys('ZZZZZ'), 'b', env(50))));                   // falscher Raumschlüssel
  sock._frame(rawPublish(topic, M.seal(k, 'h', env(51))));                                     // für anderen Kanal versiegelt
  const tampered = M.seal(k, 'b', env(52)); tampered[30] ^= 4;
  sock._frame(rawPublish(topic, tampered));                                                    // verändert
  sock._frame(rawPublish(topic, M.seal(k, 'b', 'kein JSON {')));
  sock._frame(rawPublish(topic, M.seal(k, 'b', JSON.stringify({ n: 1, o: {} }))));             // ohne Absender
  sock._frame(rawPublish(topic, M.seal(k, 'b', 'null')));
  sock._frame(rawPublish(topic, M.seal(k, 'b', env(53)), 0x31));                               // retained
  sock._frame(rawPublish('karma1/' + k.tag + '/nichtabonniert', M.seal(k, 'nichtabonniert', env(54))));
  sock._frame(rawPublish('ganz/anderes/topic', Buffer.from('hallo')));
  sock._frame(Buffer.from([0x40, 2, 0, 1, 0x50, 2, 0, 1, 0xF0, 0]));                           // PUBACK, PUBREC, reserviert
  assert.strictEqual(b.msgs.length, 0);

  // QoS 1 (mit Paket-ID) wird trotzdem richtig gelesen
  const q1 = Buffer.from(M.packet(0x32, [M.mqttStr(topic), [0x12, 0x34], M.seal(k, 'b', env(1))]));
  sock._frame(q1);
  sock._frame(good(2));
  sock._frame(good(2));                                                                        // Wiederholung (Replay)
  assert.deepStrictEqual(b.msgs.map(x => x.m.n), [1, 2]);
  assert.strictEqual(h.attempts.length, 1, 'bis hierher dieselbe Verbindung');

  // Ein Handler, der wirft, reißt den Transport nicht mit
  const origErr = console.error; let logged = 0;
  console.error = () => { logged++; };
  try {
    const keep = b.t.onMessage;
    b.t.onMessage = () => { throw new Error('App-Fehler'); };
    sock._frame(good(3));
    b.t.onMessage = keep;
  } finally { console.error = origErr; }
  assert.strictEqual(logged, 1);
  sock._frame(good(4));
  assert.deepStrictEqual(b.msgs.map(x => x.m.n), [1, 2, 4]);

  // Kaputte Pakete: Verbindung wird verworfen und neu aufgebaut
  const broken = [
    Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01, 1, 2, 3]),       // Längenfeld mit 5 Bytes
    Buffer.from([0x30, 0x80, 0x80, 0x80, 0x7f]),                      // 266 MB angekündigt
    Buffer.from([0x30, 3, 0, 9, 65]),                                 // Topic länger als das Paket
    Buffer.from([0x30, 1, 0]),                                        // PUBLISH ohne Topic-Länge
    Buffer.from([0x20, 2, 0, 5]),                                     // zweites CONNACK mit Fehlercode
    Buffer.from([0x90, 3, 0, 1, 0x80])                                // (bei passender ID wäre das eine Absage)
  ];
  let expected = 1;
  for (let i = 0; i < broken.length; i++) {
    sock = h.live()[0];
    const before = h.attempts.length;
    sock._frame(broken[i]);
    if (i === 5) { assert.strictEqual(h.attempts.length, before); break; }   // fremde SUBACK-ID: ignoriert
    expected++;
    await until(() => h.attempts.length === expected && b.ready() === 1, 1000, 'Neuverbinden nach kaputtem Paket ' + i);
  }
  // Zufallsrauschen
  for (let i = 0; i < 300; i++) {
    const s = h.live()[0];
    if (s) s._frame(nodeCrypto.randomBytes(1 + Math.floor(Math.random() * 60)));
    if (i % 50 === 0) await sleep(5);
  }
  // Danach kann die Verbindung mitten in einem „Paket“ aus Rauschen hängen. Der Keepalive räumt das auf:
  // ein PINGRESP, das im Müll untergeht, zählt nicht als Lebenszeichen.
  Object.assign(Net.MQTT_T, { backoffMax: 40, ping: 50, pong: 40 });
  const noisy = h.attempts.length;
  h.live().forEach(s => s._kill());
  await until(() => h.attempts.length > noisy && b.ready() === 1 && h.live().length === 1, 3000, 'nach dem Rauschen wieder bereit');
  h.live()[0]._frame(Buffer.from([0x30, 0xff, 0x7f, 1, 2, 3]));     // kündigt 16 kB an, die nie kommen
  const stuck = h.attempts.length;
  await until(() => h.attempts.length > stuck && b.ready() === 1, 2000, 'hängende Verbindung wird ersetzt');
  const a = fakePeer(code, [], [h.url]);
  await until(() => a.online, 500, 'a online');
  a.t.publish('b', { n: 'ende' });
  await until(() => b.count(m => m.n === 'ende') === 1, 1000, 'nach all dem funktioniert es noch');
});

test('Verbindung: Backoff mit Deckel, CONNACK-Frist, Ablehnung, Erholung', async () => {
  Object.assign(Net.MQTT_T, fastT, { backoffMin: 20, backoffMax: 160, connack: 100 });
  const h = hub('fake://backoff');
  h.accept = false;
  const p = fakePeer(newCode(), ['h'], [h.url]);
  assert.doesNotThrow(() => p.t.publish('h', { offline: true }));
  await sleep(1150);
  const gaps = h.attempts.slice(1).map((at, i) => at - h.attempts[i]);
  assert.ok(gaps.length >= 7 && gaps.length <= 13, 'Anzahl Versuche in 1,15 s: ' + (gaps.length + 1) + ' ' + JSON.stringify(gaps));
  [20, 40, 80].forEach((base, i) => assert.ok(gaps[i] >= base * 0.75 - 2 && gaps[i] <= base * 1.25 + 45, 'Abstand ' + i + ': ' + gaps[i]));
  gaps.slice(3).forEach(g => assert.ok(g >= 118 && g <= 160 + 45, 'gedeckelter Abstand: ' + g));
  assert.deepStrictEqual(p.status, []);

  // Broker nimmt an, schweigt aber: CONNACK-Frist greift
  h.accept = true; h.connack = null;
  const n0 = h.attempts.length;
  await until(() => h.attempts.length >= n0 + 2, 2000, 'Neuversuche nach CONNACK-Frist');
  assert.ok(h.of(1).length >= 1, 'CONNECT wurde gesendet');
  assert.strictEqual(p.online, false);
  const silent = h.socks[h.socks.length - 2];
  assert.strictEqual(silent.readyState, 3, 'der stumme Socket wurde geschlossen');

  // Broker lehnt ab (Rückgabecode 5)
  h.connack = 5;
  const n1 = h.attempts.length;
  await until(() => h.attempts.length >= n1 + 2, 2000, 'Neuversuche nach Ablehnung');
  assert.strictEqual(p.online, false);

  // SUBACK bleibt aus
  h.connack = 0; h.suback = false;
  const n2 = h.attempts.length;
  await until(() => h.attempts.length >= n2 + 2, 2000, 'Neuversuche ohne SUBACK');
  assert.strictEqual(p.online, false);

  h.suback = true;
  await until(() => p.online, 2000, 'Erholung');
  assert.deepStrictEqual(p.status, [true]);
});

test('Verbindung: Status erst false, wenn kein Broker mehr da ist; nach close() ist Ruhe', async () => {
  Object.assign(Net.MQTT_T, fastT);
  const h1 = hub('fake://s1'), h2 = hub('fake://s2'), code = newCode();
  const a = fakePeer(code, ['a'], [h1.url, h2.url]), b = fakePeer(code, ['b'], [h1.url, h2.url]);
  await until(() => a.ready() === 2 && b.ready() === 2, 500, 'bereit');
  h1.accept = false;
  h1.live().forEach(s => s._kill());
  await sleep(60);
  assert.deepStrictEqual(a.status, [true], 'ein Broker reicht');
  a.t.publish('b', { n: 1 });
  await until(() => b.count(m => m.n === 1) === 1, 500, 'Nachricht über den verbliebenen Broker');
  h2.accept = false;
  h2.live().forEach(s => s._kill());
  await until(() => a.status.length === 2, 500, 'offline gemeldet');
  assert.deepStrictEqual(a.status, [true, false]);
  assert.doesNotThrow(() => a.t.publish('b', { n: 2 }));
  h1.accept = true;
  await until(() => a.online && b.online, 1000, 'wieder online');
  assert.deepStrictEqual(a.status, [true, false, true]);
  a.t.publish('b', { n: 3 });
  await until(() => b.count(m => m.n === 3) === 1, 500, 'Nachricht nach Rückkehr');
  assert.strictEqual(b.count(m => m.n === 2), 0, 'offline Gesendetes wird nicht nachgereicht');

  // close(): DISCONNECT, Sockets zu, keine weiteren Versuche, keine Rückrufe
  h2.accept = true;
  await until(() => a.ready() === 2 && b.ready() === 2, 1000, 'beide Broker zurück');
  const n1 = h1.attempts.length, n2 = h2.attempts.length, st = a.status.length, d0 = h1.of(14).length + h2.of(14).length;
  a.t.close();
  a.t.close();
  assert.strictEqual(h1.of(14).length + h2.of(14).length, d0 + 2, 'DISCONNECT an beide Broker');
  b.t.publish('a', { n: 4 });
  a.t.publish('b', { n: 5 });
  a.t.kick();
  a.t.subscribe('zzz');
  await sleep(250);
  assert.strictEqual(h1.attempts.length, n1);
  assert.strictEqual(h2.attempts.length, n2);
  assert.strictEqual(a.status.length, st);
  assert.strictEqual(a.msgs.length, 0);
  assert.strictEqual(b.count(m => m.n === 5), 0);
});

test('Keepalive: PINGREQ regelmäßig; ausbleibendes PINGRESP gilt als tote Verbindung', async () => {
  Object.assign(Net.MQTT_T, fastT, { ping: 50, pong: 40 });
  const h = hub('fake://ping');
  const p = fakePeer(newCode(), ['h'], [h.url]);
  await until(() => p.online, 500, 'online');
  await sleep(330);
  const pings = h.of(12).length;
  assert.ok(pings >= 4 && pings <= 7, 'PINGREQs in 330 ms bei 50 ms Abstand: ' + pings);
  assert.strictEqual(h.attempts.length, 1, 'mit PINGRESP bleibt die Verbindung');
  h.pong = false;
  await until(() => h.attempts.length === 2, 500, 'ohne PINGRESP wird neu verbunden');
  assert.strictEqual(h.socks[0].readyState, 3);
  await until(() => p.online === false || h.attempts.length > 2, 500, 'und wieder (Broker antwortet weiter nicht)');
  h.pong = true;
  await until(() => p.online, 1000, 'mit PINGRESP wieder stabil');
  const n = h.attempts.length;
  await sleep(200);
  assert.strictEqual(h.attempts.length, n);
});

test('kick(): Zombie-Socket wird nach der Frist ersetzt, gesunder bleibt, wartender verbindet sofort', async () => {
  Object.assign(Net.MQTT_T, fastT, { kick: 120, backoffMin: 30000, backoffMax: 30000 });
  const h = hub('fake://kick'), code = newCode();
  const a = fakePeer(code, ['a'], [h.url]), b = fakePeer(code, ['b'], [h.url]);
  await until(() => a.online && b.online, 500, 'online');
  const sockA = h.socks[0];

  // gesund: PINGREQ geht raus, Verbindung bleibt
  const pings = h.of(12).length;
  a.t.kick(); a.t.kick(); a.t.kick();
  assert.strictEqual(h.of(12).length, pings + 3);
  await sleep(250);
  assert.strictEqual(h.attempts.length, 2);
  assert.strictEqual(a.t._brokers()[0].ws, sockA);

  // Zombie: Socket sieht offen aus, es kommt aber nichts mehr (iOS nach dem Hintergrund)
  sockA.frozen = true;
  b.t.publish('a', { n: 1 });
  await sleep(100);
  assert.strictEqual(a.msgs.length, 0);
  assert.strictEqual(a.online, true, 'ohne kick() merkt es zunächst niemand');
  const t0 = Date.now();
  a.t.kick();
  await sleep(40); a.t.kick();                    // wiederholtes kick() verlängert die Frist nicht
  await until(() => h.attempts.length === 3, 1000, 'Ersatzverbindung');
  const took = Date.now() - t0;
  assert.ok(took >= 100 && took < 260, 'Ersatz nach der kick-Frist (120 ms), nicht früher/später: ' + took);
  await until(() => a.ready() === 1, 500, 'wieder bereit');
  assert.deepStrictEqual(a.status, [true, false, true]);
  b.t.publish('a', { n: 2 });
  await until(() => a.count(m => m.n === 2) === 1, 500, 'Nachricht nach kick');

  // Socket geschlossen, Backoff läuft (30 s): kick() verbindet sofort
  h.accept = false;
  h.live().filter(s => !s.frozen && s !== h.socks[1]).forEach(s => s._kill());
  await until(() => !a.online, 500, 'offline');
  await sleep(150);
  const n = h.attempts.length;
  await sleep(150);
  assert.strictEqual(h.attempts.length, n, 'ohne kick() passiert in der Backoff-Zeit nichts');
  h.accept = true;
  a.t.kick();
  await until(() => a.online, 500, 'sofort wieder online');
  b.t.publish('a', { n: 3 });
  await until(() => a.count(m => m.n === 3) === 1, 500, 'Nachricht nach kick aus dem Backoff');
});

/* ====================================================================================
 * Teil 2: echte Broker
 * ==================================================================================== */

const PROBE_MS = 9000;   // so lange darf ein Broker bei der Vorab-Messung für den Verbindungsaufbau brauchen
const NO_NET = 'Kein öffentlicher MQTT-Broker erreichbar (kein Internet in dieser Umgebung?) – live-Test übersprungen';
let up = [];          // erreichbare Broker, schnellster zuerst
let probe = [];       // Ergebnis der Vorab-Messung je Broker
const stats = arr => {
  const s = arr.slice().sort((x, y) => x - y);
  return { min: s[0], med: s[s.length >> 1], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
};

/* Zählt eingehende PUBLISH-Pakete je Broker (Broker bündeln oft mehrere Pakete in einem WebSocket-Frame,
 * deshalb wird der Datenstrom hier selbst zerlegt), kann einen Socket „einfrieren“ (Zombie) oder
 * schlagartig beenden (Netz weg). */
function newCounter() { return { publishes: 0, byUrl: {}, sockets: [] }; }
function wrapWS(counter) {
  return class WrappedWS {
    constructor(url, proto) {
      const ws = this.ws = new WebSocket(url, proto);
      this.url = url;
      this.frozen = false;
      this.rest = null;
      ['open', 'message', 'close', 'error'].forEach(n => {
        ws['on' + n] = ev => {
          if (this.frozen) return;
          if (n === 'message') this.countPublishes(ev.data);
          const f = this['on' + n];
          if (typeof f === 'function') f(ev);
        };
      });
      counter.sockets.push(this);
    }
    countPublishes(data) {
      if (!data || typeof data === 'string') return;
      let c = Buffer.from(data), pos = 0;
      if (this.rest) { c = Buffer.concat([this.rest, c]); this.rest = null; }
      while (c.length - pos >= 2) {
        let i = pos + 1, len = 0, mult = 1, d = 128;
        while (d & 128 && i < c.length && i - pos <= 4) { d = c[i++]; len += (d & 127) * mult; mult *= 128; }
        if (d & 128 || c.length - i < len) break;                  // Paket noch unvollständig
        if (c[pos] >> 4 === 3) { counter.publishes++; counter.byUrl[this.url] = (counter.byUrl[this.url] || 0) + 1; }
        pos = i + len;
      }
      if (pos < c.length) this.rest = Buffer.from(c.subarray(pos));
    }
    get readyState() { return this.dead ? 3 : this.frozen ? 1 : this.ws.readyState; }
    kill() {
      if (this.dead) return;
      this.dead = this.frozen = true;
      this.hangUp();
      if (typeof this.onclose === 'function') this.onclose({ code: 1006 });
    }
    get bufferedAmount() { return this.frozen ? 0 : this.ws.bufferedAmount; }
    get binaryType() { return this.ws.binaryType; }
    set binaryType(v) { this.ws.binaryType = v; }
    send(d) { if (this.dead) throw new Error('InvalidStateError'); if (!this.frozen) this.ws.send(d); }
    close() { this.hangUp(); }
    /* Aufräumen am echten Socket: mit DISCONNECT legt der Broker sofort auf (sonst erst nach dem Keepalive). */
    hangUp() {
      try { if (this.ws.readyState === 1) this.ws.send(new Uint8Array([0xE0, 0])); } catch (e) {}
      try { this.ws.close(); } catch (e) {}
    }
  };
}

before(async () => {
  // Vorab-Messung je Broker: Zeit bis bereit, Laufzeit Senden → Empfangen zwischen zwei Verbindungen
  const rows = await Promise.all(REAL_BROKERS.map(async spec => {
    const code = newCode(), a = peer(code, ['a'], { brokers: [spec] }), b = peer(code, ['b'], { brokers: [spec] });
    const row = { url: urlOf(spec), spec, ok: false };
    try {
      const end = Date.now() + PROBE_MS;
      while (!(a.online && b.online) && Date.now() < end) await sleep(10);
      if (!(a.online && b.online)) return row;
      row.ready = Math.max(a.onlineAt - a.startedAt, b.onlineAt - b.startedAt);
      // 12 Nachrichten: klein wie ein Spielzug (~250 Byte), jede sechste groß wie ein Spielstand (4 kB)
      const lat = [], PROBES = 12;
      for (let i = 0; i < PROBES; i++) {
        const t0 = Date.now();
        a.t.publish('b', { i, pad: 'x'.repeat(i % 6 === 5 ? 4000 : 200) });
        const lim = Date.now() + 3000;
        while (!b.msgs.some(x => x.m.i === i) && Date.now() < lim) await sleep(2);
        if (b.msgs.some(x => x.m.i === i)) lat.push(Date.now() - t0);
        await sleep(60);
      }
      row.lost = PROBES - lat.length;
      row.dup = b.msgs.length - lat.length;
      if (lat.length >= PROBES - 2) { row.ok = true; Object.assign(row, stats(lat)); }
      return row;
    } finally { a.t.close(); b.t.close(); openPeers.delete(a); openPeers.delete(b); }
  }));
  rows.forEach(r => console.log('  Broker ' + (r.url + (hasLogin(r.spec) ? ' (mit Anmeldung)' : '')).padEnd(56) + (r.ok
    ? ' bereit nach ' + String(r.ready).padStart(5) + ' ms, Laufzeit min/median/max ' + r.min + '/' + r.med + '/' + r.max + ' ms, verloren ' + r.lost + ', doppelt ' + r.dup
    : ' NICHT ERREICHBAR' + (r.ready ? ' (verbunden nach ' + r.ready + ' ms, aber ' + r.lost + ' von 12 Nachrichten verloren)' : ''))));
  probe = rows;
  up = rows.filter(r => r.ok).sort((x, y) => x.med - y.med).map(r => r.spec);
});

/* true (und der Test ist als übersprungen markiert), wenn die live-Tests hier nicht laufen können. */
function noLive(t) {
  if (up.length >= 2) return false;
  t.skip(up.length ? 'nur ein Broker erreichbar (' + hostOf(up[0]) + ') – live-Test übersprungen, siehe Erreichbarkeitstest' : NO_NET);
  return true;
}

test('live: mindestens zwei öffentliche Broker sind erreichbar', t => {
  probe.forEach(r => t.diagnostic(hostOf(r.spec) + (hasLogin(r.spec) ? ' (mit Anmeldung)' : '') + ': ' + (r.ok
    ? 'bereit nach ' + r.ready + ' ms, Laufzeit min/median/max ' + r.min + '/' + r.med + '/' + r.max + ' ms, verloren ' + r.lost
    : 'NICHT ERREICHBAR')));
  if (!up.length) return t.skip(NO_NET);
  assert.ok(up.length >= 2, 'erreichbare Broker: ' + up.length + ' von ' + REAL_BROKERS.length);
  probe.filter(r => r.ok).forEach(r => assert.strictEqual(r.dup, 0, hostOf(r.spec) + ' stellt nichts doppelt zu'));
});

/* Erreichbare Broker, der mit dem schnellsten Verbindungsaufbau zuerst. Für Tests, die auf eine bestimmte
 * Verbindung warten: einzelne öffentliche Broker lassen sich zeitweise bei jedem zweiten Aufbau über 10 s
 * Zeit mit dem CONNACK (gemessen bei broker.hivemq.com); der Transport bricht dann nach T.connack ab und
 * versucht es neu, das kann sich über viele Sekunden ziehen. */
const byConnect = () => probe.filter(r => r.ok).sort((x, y) => x.ready - y.ready).map(r => r.spec);

/* Wartet, bis alle (erreichbaren) Broker bereit sind – ein Nachzügler darf fehlen: sobald überall nur noch
 * ein Broker aussteht, wird höchstens 3 s weiter gewartet (das hält die Laufzeit im Rahmen, wenn sich ein
 * Broker gerade viel Zeit mit dem CONNACK lässt). */
async function settled(peers, want, ms) {
  const end = Date.now() + (ms || 12000);
  let grace = 0;
  while (Date.now() < end && !peers.every(p => p.ready() >= want)) {
    if (want > 1 && peers.every(p => p.ready() >= want - 1)) {
      if (!grace) grace = Date.now() + 3000;
      if (Date.now() > grace) break;
    } else grace = 0;
    await sleep(20);
  }
  peers.forEach(p => assert.ok(p.ready() >= 1, 'Transport ist online'));
  return Math.min.apply(null, peers.map(p => p.ready()));
}

test('live: zwei Transporte im selben Raum, beide Richtungen, jeweils genau einmal', { timeout: 60000 }, async t => {
  if (noLive(t)) return;
  const code = newCode(), ca = newCounter(), cb = newCounter();
  const a = peer(code, ['x', 'a'], { brokers: up, WS: wrapWS(ca) });
  const b = peer(code, ['x', 'b'], { brokers: up, WS: wrapWS(cb) });
  const stranger = peer(newCode(), ['x', 'a', 'b'], { brokers: up });
  const readyMin = await settled([a, b, stranger], up.length);
  const N = 20;
  for (let i = 0; i < N; i++) {
    a.t.publish('x', { i, from: 'a', pad: i % 5 === 0 ? 'ä€'.repeat(1500) : '' });
    b.t.publish('x', { i, from: 'b' });
    a.t.publish('b', { i, direct: 'a' });
    b.t.publish('a', { i, direct: 'b' });
    await sleep(25);
  }
  await until(() => a.msgs.length >= 2 * N && b.msgs.length >= 2 * N, 10000, 'alle Nachrichten angekommen');
  await sleep(1500);                                   // Nachzügler über langsamere Broker abwarten
  for (let i = 0; i < N; i++) {
    assert.strictEqual(b.count(m => m.i === i && m.from === 'a'), 1, 'a→b ' + i);
    assert.strictEqual(a.count(m => m.i === i && m.from === 'b'), 1, 'b→a ' + i);
    assert.strictEqual(b.count((m, ch) => m.i === i && m.direct === 'a' && ch === 'b'), 1);
    assert.strictEqual(a.count((m, ch) => m.i === i && m.direct === 'b' && ch === 'a'), 1);
  }
  assert.strictEqual(b.msgs.find(x => x.m.i === 0 && x.m.from === 'a').m.pad, 'ä€'.repeat(1500));
  assert.strictEqual(a.msgs.length, 2 * N, 'nichts doppelt, nichts Eigenes');
  assert.strictEqual(b.msgs.length, 2 * N);
  assert.strictEqual(stranger.msgs.length, 0, 'anderer Raumcode empfängt nichts');
  // Je Broker erwartet: N von der Gegenseite auf „x“, N eigene auf „x“ (Echo), N direkte = 3 N Pakete.
  const per = c => up.map(spec => hostOf(spec) + ' ' + (c.byUrl[urlOf(spec)] || 0)).join(', ');
  t.diagnostic('Broker bereit (Minimum über die Transporte): ' + readyMin + ' von ' + up.length +
    '; b erhielt ' + cb.publishes + ' PUBLISH-Pakete für ' + b.msgs.length + ' zugestellte Nachrichten');
  t.diagnostic('PUBLISH-Pakete je Broker (vollständig = ' + 3 * N + '): a: ' + per(ca) + ' | b: ' + per(cb));
  [ca, cb].forEach(c => up.forEach(spec => {
    assert.ok((c.byUrl[urlOf(spec)] || 0) <= 3 * N, hostOf(spec) + ' liefert nichts doppelt (QoS 0): ' + c.byUrl[urlOf(spec)]);
  }));
  if (readyMin >= 2) {
    // Jede Nachricht kam über mehrere Broker (plus Echo der eigenen auf „x“) und wurde doch nur einmal zugestellt
    assert.ok(cb.publishes >= 2 * b.msgs.length, 'Duplikate kamen tatsächlich an: ' + cb.publishes);
    assert.ok(ca.publishes >= 2 * a.msgs.length);
  }
  if (readyMin >= 3) {
    // Einzelne Broker dürfen bei so einer Salve Nachrichten verwerfen (emqx begrenzt die Rate), aber nicht die Mehrheit
    const complete = c => up.filter(spec => c.byUrl[urlOf(spec)] === 3 * N).length;
    assert.ok(complete(ca) >= 2 && complete(cb) >= 2, 'mindestens zwei Broker haben jede einzelne Nachricht geliefert');
  }
});

test('live: Müll und Fälschungen auf dem Raum-Topic werden verworfen', { timeout: 60000 }, async t => {
  if (noLive(t)) return;
  const code = newCode(), k = M.roomKeys(code), topic = 'karma1/' + k.tag + '/b';
  const a = peer(code, ['a'], { brokers: up }), b = peer(code, ['b'], { brokers: up });
  await settled([a, b], up.length, 8000);
  const env = n => JSON.stringify({ s: 'fremd', n, o: { n } });
  const tampered = M.seal(k, 'b', env(2)); tampered[tampered.length - 1] ^= 1;
  const raw = [
    rawPublish(topic, nodeCrypto.randomBytes(200)),
    rawPublish(topic, M.seal(M.roomKeys(newCode()), 'b', env(1))),
    rawPublish(topic, tampered),
    rawPublish(topic, M.seal(k, 'a', env(3))),
    rawPublish(topic, M.seal(k, 'b', env(4)))            // echt: gleicher Raum, gleicher Kanal
  ];
  a.t._brokers().filter(x => x.ready).forEach(x => raw.forEach(r => x.ws.send(r)));   // roh, an der Versiegelung vorbei
  await until(() => b.msgs.length >= 1, 8000, 'die echte Nachricht kommt an');
  await sleep(1200);
  assert.deepStrictEqual(b.msgs.map(x => x.m.n), [4], 'nur die echte, und nur einmal');
});

test('live: Broker A und Broker B sind getrennt; ein Dritter auf allen Brokern erreicht beide', { timeout: 120000 }, async t => {
  if (noLive(t)) return;
  const code = newCode(), pair = byConnect();
  const a = peer(code, ['x'], { brokers: [pair[0]] }), b = peer(code, ['x'], { brokers: [pair[1]] });
  const c = peer(code, ['x'], { brokers: up });
  await until(() => a.online && b.online, 30000, 'a und b online');
  await until(() => {
    const st = c.t._brokers();
    return st.find(x => x.url === urlOf(pair[0])).ready && st.find(x => x.url === urlOf(pair[1])).ready;
  }, 30000, 'c auf Broker A und B bereit');
  a.t.publish('x', { from: 'a' });
  b.t.publish('x', { from: 'b' });
  await until(() => c.count(m => m.from === 'a') === 1 && c.count(m => m.from === 'b') === 1, 8000, 'c hört a und b');
  c.t.publish('x', { from: 'c' });
  await until(() => a.count(m => m.from === 'c') === 1 && b.count(m => m.from === 'c') === 1, 8000, 'a und b hören c');
  await sleep(1500);
  assert.strictEqual(a.count(m => m.from === 'b'), 0, 'a hört b nicht (verschiedene Broker)');
  assert.strictEqual(b.count(m => m.from === 'a'), 0, 'b hört a nicht');
  assert.strictEqual(a.msgs.length, 1);
  assert.strictEqual(b.msgs.length, 1);
  assert.strictEqual(c.msgs.length, 2, 'c bekommt jede Nachricht genau einmal');
});

test('live: ein Socket stirbt → weiter online; alle sterben → automatisch zurück; kick() belebt sofort', { timeout: 120000 }, async t => {
  if (noLive(t)) return;
  const code = newCode(), ca = newCounter();
  const a = peer(code, ['a'], { brokers: up, WS: wrapWS(ca) }), b = peer(code, ['b'], { brokers: up });
  await settled([a, b], up.length);
  let n = 0;
  async function pingPong(label) {
    const id = ++n;
    a.t.publish('b', { id }); b.t.publish('a', { id });
    await until(() => a.count(m => m.id === id) === 1 && b.count(m => m.id === id) === 1, 10000, label);
  }
  await pingPong('vorher');

  // 1) ein Socket weg, mitten im Gespräch
  const order = byConnect().map(urlOf);
  const victim = a.t._brokers().filter(x => x.ready).sort((x, y) => order.indexOf(x.url) - order.indexOf(y.url))[0];
  victim.ws.kill();
  for (let i = 0; i < 6; i++) { await pingPong('während ein Socket fehlt #' + i); await sleep(150); }
  assert.deepStrictEqual(a.status, [true], 'a war durchgehend online');
  await until(() => a.t._brokers().find(x => x.url === victim.url).ready, 30000, 'der Broker kommt von selbst zurück');
  assert.notStrictEqual(a.t._brokers().find(x => x.url === victim.url).ws, victim.ws);

  // 2) alle Sockets weg → offline → von selbst wieder da
  await settled([a], up.length, 8000);
  const t0 = Date.now();
  a.t._brokers().forEach(x => { if (x.ws) x.ws.kill(); });
  assert.deepStrictEqual(a.status, [true, false], 'offline gemeldet');
  assert.doesNotThrow(() => a.t.publish('b', { id: 'offline' }));
  await until(() => a.online, 15000, 'automatisch wieder online');
  t.diagnostic('alle Sockets geschlossen → wieder online nach ' + (Date.now() - t0) + ' ms');
  await pingPong('nach automatischem Neuverbinden');

  // 3) alle Sockets weg, Backoff künstlich lang → nur kick() hilft
  await settled([a], up.length, 8000);
  // Ein Broker, der gerade auf seinen nächsten Versuch wartet (kein Socket), käme mit seiner alten, kurzen
  // Wartezeit von selbst zurück: erst zuschlagen, wenn jeder Broker einen Socket hat, den man beenden kann.
  await until(() => a.t._brokers().every(x => x.ws), 20000, 'jeder Broker hat gerade einen Socket');
  Object.assign(Net.MQTT_T, { backoffMin: 60000, backoffMax: 60000 });
  const s0 = a.status.length;
  a.t._brokers().forEach(x => { if (x.ws) x.ws.kill(); });
  assert.ok(a.status.length > s0 && !a.online, 'offline gemeldet');
  await sleep(1500);
  assert.strictEqual(a.online, false, 'ohne kick() bleibt es beim langen Backoff offline');
  assert.strictEqual(a.ready(), 0);
  const t1 = Date.now();
  a.t.kick();
  await until(() => a.online, 10000, 'kick() verbindet sofort neu');
  t.diagnostic('kick() nach geschlossenen Sockets → online nach ' + (Date.now() - t1) + ' ms');
  Object.assign(Net.MQTT_T, REAL_T);
  await pingPong('nach kick()');
  await sleep(1200);
  assert.strictEqual(a.msgs.length, n, 'a: jede Nachricht genau einmal');
  assert.strictEqual(b.msgs.length, n, 'b: jede Nachricht genau einmal (nichts von „offline“)');
});

test('live: eingefrorene Sockets (iOS-Zombies) – kick() ersetzt sie nach etwa 3 s', { timeout: 60000 }, async t => {
  if (noLive(t)) return;
  const code = newCode(), ca = newCounter();
  const a = peer(code, ['a'], { brokers: up, WS: wrapWS(ca) }), b = peer(code, ['b'], { brokers: up });
  await settled([a, b], up.length);
  b.t.publish('a', { n: 1 });
  await until(() => a.count(m => m.n === 1) === 1, 8000, 'vorher');
  Object.assign(Net.MQTT_T, { ping: 600000 });      // Keepalive soll hier nicht helfen
  await sleep(50);
  ca.sockets.forEach(s => { s.frozen = true; });
  b.t.publish('a', { n: 2 });
  await sleep(1000);
  assert.strictEqual(a.count(m => m.n === 2), 0, 'eingefroren: nichts kommt an');
  assert.strictEqual(a.online, true, 'und der Transport hält sich noch für online');
  // Nur die Broker betrachten, die bereit waren und deren Socket wirklich eingefroren ist (ein gerade wartender
  // verbindet bei kick() sofort; einer, der beim Einfrieren noch im Aufbau hing, hat inzwischen evtl. einen frischen)
  const frozen = a.t._brokers().filter(x => x.ready && x.ws && x.ws.frozen), t0 = Date.now(), total = a.t._brokers().length;
  assert.ok(frozen.length >= 1);
  const replaced = () => frozen.filter(f => a.t._brokers().find(x => x.url === f.url).ws !== f.ws).length;
  const revived = () => frozen.filter(f => { const x = a.t._brokers().find(y => y.url === f.url); return x.ready && x.ws !== f.ws; }).length;
  a.t.kick();
  await sleep(REAL_T.kick - 300);
  assert.strictEqual(replaced(), 0, 'vor Ablauf der Frist wird kein offener Socket ersetzt');
  await until(() => replaced() === frozen.length, 6000, 'Ersatz-Sockets für alle eingefrorenen');
  const took = Date.now() - t0;
  assert.ok(took >= REAL_T.kick - 200 && took <= REAL_T.kick + 1000, 'Ersatz nach der kick-Frist: ' + took + ' ms');
  await until(() => a.online && revived() >= 1, 15000, 'eine ersetzte Verbindung ist wieder bereit');
  t.diagnostic('Zombie → kick() → wieder online nach ' + (Date.now() - t0) + ' ms (' + frozen.length + ' von ' + total + ' Brokern waren eingefroren)');
  // Waren alle Leitungen eingefroren, war der Transport dazwischen genau einmal offline. Hing ein Broker beim
  // Einfrieren noch im Verbindungsaufbau, kann er mit einem frischen Socket die Lücke überbrückt haben.
  if (frozen.length === total) assert.deepStrictEqual(a.status, [true, false, true], 'einmal offline, dann wieder da');
  b.t.publish('a', { n: 3 });
  await until(() => a.count(m => m.n === 3) === 1, 8000, 'Nachricht nach dem Wiederbeleben');
});


/* ====================================================================================
 * Teil 3: Raum und Partie über die echten Broker (aktuelle Regeln: KARMA.pdf + Klarstellungen)
 * ==================================================================================== */

/* Zuggrenze je Runde (Ereignisse aus Sicht des Hosts, Tauschphase eingeschlossen). Mit der Spielweise unten dauert
 * eine Runde zu viert im Mittel rund 115 Ereignisse, 99 % bleiben unter 180 (3000 Partien ohne Netz ausgezählt). */
const MOVE_CAP = 400;

/* 0 = normale Karte. Sonderkarten gehen auf alles (außer auf einen Joker) und werden deshalb aufgespart –
 * in dieser Reihenfolge zuletzt hergegeben: 7, 2, 10 (räumt ab), schwarzer Joker, roter Joker. */
const special = c => { const r = Engine.rank(c); return r === 7 ? 1 : r === 2 ? 2 : r === 10 ? 3 : c === Engine.JB ? 4 : c === Engine.JR ? 5 : 0; };
const worth = c => (special(c) ? 19 + special(c) : Engine.rank(c));

/* Legeregel, hier noch einmal eigenständig aus dem Regeltext: Joker oben → nur Rot auf Schwarz; Joker, 2, 7 und 10
 * gehen sonst immer; nach einer 7 nur 3–6; sonst gleich hoch oder höher. */
function fits(card, top) {
  if (!top) return true;
  if (top === Engine.JR) return false;
  if (top === Engine.JB) return card === Engine.JR;
  if (Engine.isJoker(card)) return true;
  const r = Engine.rank(card), t = Engine.rank(top);
  if (r === 2 || r === 7 || r === 10) return true;
  return t === 7 ? r < 7 : r >= t;
}

/* Spielzug allein aus der eigenen Sicht wählen – so wie es ein Mensch an der Oberfläche täte, der seine Karten
 * loswerden will:
 *  - Tauschphase: die beste Handkarte gegen die schwächste offene Karte tauschen, wenn das etwas bringt.
 *  - Verdeckte Karten: blind aufdecken; liegt der rote Joker oben, bleibt nur Aufnehmen.
 *  - Sonst alle Karten des niedrigsten passenden normalen Werts legen; Sonderkarten (7, 2, 10, Joker) erst, wenn
 *    sonst nichts passt, die billigste zuerst und einzeln. Das gilt auch für den freien Zug nach dem Aufnehmen.
 *  - Freiwillig aufnehmen (erlaubt, solange etwas liegt): wenn nur noch ein Joker passen würde und der Stapel
 *    höchstens zwei Karten hat – dafür ist der Joker zu schade.
 *  - Passt nichts: aufnehmen (Pflicht).
 *  - Aufgenommen wird nur, wenn die Sicht es anbietet (my.canPickup). Im Extra-Zug nach der eigenen 3 zu zweit
 *    (view.again) bietet sie es nie an; dort passt aber auch immer etwas. Bietet die Sicht gar keinen Zug an,
 *    wird keiner gewählt (null) – simulate() und tablePlayer melden das dann als Fehler.
 *  - Meldet der Host, dass sich die Stellung wiederholt (ev.repeat), irgendeinen erlaubten Zug wählen –
 *    eine feste Spielweise liefe sonst im Kreis. */
function chooseAction(view, rnd) {
  const me = view.players[view.you];
  if (view.phase === 'swap') {
    if (me.ready) return null;
    const best = me.hand.slice().sort((x, y) => worth(y) - worth(x))[0];
    let slot = 0;
    me.up.forEach((c, i) => { if (worth(c) < worth(me.up[slot])) slot = i; });
    return worth(best) > worth(me.up[slot]) ? { t: 'ready', swap: { hand: best, up: slot } } : { t: 'ready' };
  }
  if (view.phase !== 'play' || view.turn !== view.you || !view.my) return null;
  const my = view.my;
  if (my.zone === 'down') {
    if (!my.canFlip) return my.canPickup ? { t: 'pickup' } : null;
    const slots = [0, 1, 2].filter(i => me.down[i]);
    return { t: 'flip', slot: slots[Math.floor(rnd() * slots.length)] };
  }
  if (!my.playable.length) return my.canPickup ? { t: 'pickup' } : null;
  const zone = my.zone === 'hand' ? me.hand : me.up.filter(Boolean);
  // mehrere gleiche gehen nur aus der Hand; von den offenen Karten immer nur eine pro Zug
  const sameRank = c => (my.zone === 'up' ? [c] : zone.filter(x => Engine.rank(x) === Engine.rank(c)));
  if (view.ev && view.ev.repeat >= 2) {
    const moves = [], done = {};
    my.playable.forEach(c => {
      if (done[Engine.rank(c)]) return;
      done[Engine.rank(c)] = true;
      const set = sameRank(c);
      for (let k = 1; k <= set.length; k++) moves.push({ t: 'play', cards: set.slice(0, k) });
    });
    if (my.canPickup) moves.push({ t: 'pickup' });
    return moves[Math.floor(rnd() * moves.length)];
  }
  const normal = my.playable.filter(c => !special(c)).sort((x, y) => Engine.rank(x) - Engine.rank(y));
  if (normal.length) return { t: 'play', cards: sameRank(normal[0]) };
  const cheapest = my.playable.slice().sort((x, y) => special(x) - special(y))[0];
  const top = view.pile[view.pile.length - 1];
  if (Engine.isJoker(cheapest) && my.zone === 'hand' && me.n > 1 && my.canPickup && view.pile.length <= 2 && !Engine.isJoker(top)) return { t: 'pickup' };
  return { t: 'play', cards: [cheapest] };
}

/* Was jede Sicht erfüllen muss, egal bei wem sie ankommt. Verstöße landen in p.faults. */
function checkView(p, v) {
  const bad = msg => { if (p.faults.length < 5) p.faults.push(msg + ' (seq ' + v.seq + ', ' + JSON.stringify(v.ev) + ')'); };
  let cards = v.pile.length + v.stock + v.burned;
  v.players.forEach((q, i) => {
    cards += q.n + q.up.filter(Boolean).length + q.down.filter(Boolean).length;
    if (i === v.you ? !(Array.isArray(q.hand) && q.hand.length === q.n) : q.hand !== null) bad('Handkarten von Sitz ' + i + ' falsch sichtbar');
    if (!q.down.every(d => typeof d === 'boolean')) bad('verdeckte Karte von Sitz ' + i + ' sichtbar');
    if (q.place !== v.finished.indexOf(i) + 1) bad('Platz von Sitz ' + i + ' passt nicht zur Rangfolge');
    if (q.place > 0 && q.zone !== null && v.gaveUp === null) bad('Sitz ' + i + ' hat einen Platz, aber noch Karten');
    if (q.place === 0 && q.zone === null) bad('Sitz ' + i + ' hat keine Karten mehr, aber keinen Platz');
  });
  if (cards !== 54) bad('Kartenzahl ' + cards + ' statt 54');
  if (typeof v.stock !== 'number' || typeof v.burned !== 'number') bad('Nachziehstapel/entfernte Karten nicht nur als Anzahl');
  if (v.finished.length ? v.winner !== v.finished[0] : v.winner !== null) bad('Sieger ist nicht der zuerst Fertige');
  if (['random', 'loser', 'set'].indexOf(v.startBy) < 0) bad('startBy = ' + v.startBy);
  const active = v.players.filter(q => q.zone !== null && q.place === 0).length;
  if (v.canGiveUp !== (v.phase === 'play' && active === 2 && v.players[v.you].zone !== null)) bad('canGiveUp = ' + v.canGiveUp + ' bei ' + active + ' Spielern mit Karten');
  if (v.phase === 'over') {
    if (v.turn !== -1 || v.my !== null) bad('nach dem Ende ist noch jemand am Zug');
    if (v.deadlock ? v.loser !== null : !(v.loser >= 0 && v.finished.indexOf(v.loser) < 0 && v.finished.length === v.players.length - 1)) bad('Verlierer/Rangfolge am Ende unstimmig');
    if (v.gaveUp !== null && v.gaveUp !== v.loser) bad('wer aufgibt, muss der Verlierer sein');
  } else if (v.loser !== null || v.gaveUp !== null || v.deadlock) bad('Verlierer steht vor dem Ende fest');
  if (v.phase !== 'play') return;
  if ((v.my !== null) !== (v.turn === v.you)) bad('view.my passt nicht zu view.turn');
  if (!v.players[v.turn] || v.players[v.turn].zone === null) bad('am Zug ist ein Spieler ohne Karten');
  const ev = v.ev || {}, top = v.pile[v.pile.length - 1];
  if (ev.t === 'pickup' || ev.t === 'flipfail') {
    if (!(v.turn === ev.seat && v.freePlay && v.pile.length === 0)) bad('nach dem Aufnehmen ist nicht derselbe Spieler frei am Zug');
    if (!Array.isArray(ev.gone) || !ev.gone.every(Engine.isJoker)) bad('beim Aufnehmen verschwinden nur Joker');
    if (ev.t === 'pickup' && ev.joker !== (ev.gone.length > 0)) bad('Joker oben, aber kein Joker entfernt (oder umgekehrt)');
  }
  v.pile.forEach((c, i) => { if (Engine.isJoker(c) && i < v.pile.length - 2) bad('Joker liegt mitten im Stapel'); });
  const my = v.my;
  if (!my) return;
  const me = v.players[v.you];
  if (my.zone !== me.zone) bad('Zone in view.my passt nicht');
  // Extra-Zug (view.again): genau nach einer eigenen 3, die 'again' ausgelöst hat – nur zu zweit, nie mit Richtungswechsel.
  const evAgain = ev.t === 'play' && (ev.fx || []).indexOf('again') >= 0;
  if (v.again !== evAgain) bad('view.again = ' + v.again + ' passt nicht zum letzten Ereignis');
  if (v.again && !(ev.seat === v.turn && Engine.rank(ev.cards[0]) === 3 && active === 2 && top && Engine.rank(top) === 3 && !v.freePlay)) bad('Extra-Zug ohne eigene 3 zu zweit');
  if (v.again && !(my.canPickup === false && my.forced === false && (my.playable.length > 0 || my.canFlip))) bad('im Extra-Zug nach der eigenen 3 darf nicht aufgenommen werden, und es gibt immer einen anderen Zug');
  if (my.canPickup !== (v.pile.length > 0 && !v.again)) bad('Aufnehmen muss genau dann erlaubt sein, wenn etwas liegt – außer im Extra-Zug nach der eigenen 3');
  if (my.forced !== (my.canPickup && !my.playable.length && !my.canFlip)) bad('forced passt nicht zu den Möglichkeiten');
  if (my.zone === 'down') {
    if (my.playable.length || my.canFlip !== (top !== Engine.JR)) bad('verdeckte Karten: aufdecken außer gegen den roten Joker');
  } else {
    const cards2 = my.zone === 'hand' ? me.hand : me.up.filter(Boolean);
    const want = cards2.filter(c => fits(c, top));
    if (my.canFlip || JSON.stringify(my.playable.slice().sort()) !== JSON.stringify(want.sort())) bad('spielbare Karten ' + JSON.stringify(my.playable) + ' statt ' + JSON.stringify(want) + ' auf ' + top);
  }
  if (v.freePlay && (my.canPickup || my.forced)) bad('freier Zug nach dem Aufnehmen: es liegt nichts, also kann nichts aufgenommen werden');
}

/* Dieselbe Partie ohne Netz: Sitze 0..humans-1 spielen mit chooseAction (je Sitz ein eigener Zufallsgenerator),
 * die übrigen sind Bots der Engine. Dient als Vorhersage für die Partie über das Relay und prüft nebenbei
 * Spielweise, Zuggrenze und checkView gegen den Regelkern. */
function simulate(seed, humans, bots, cap) {
  const n = humans + bots;
  const g = Engine.createGame(Array.from({ length: n }, (_, i) => ({ name: 'P' + i, bot: i >= humans })), { rng: seededRng(seed) });
  const rnds = Array.from({ length: n }, (_, i) => seededRng(seed + 1 + i));
  const watcher = { faults: [] }, kinds = {};
  const look = () => { for (let s = 0; s < humans; s++) checkView(watcher, Engine.viewFor(g, s)); };
  look();
  while (g.phase !== 'over' && g.seq < cap) {
    let moved = false;
    for (let s = 0; s < n && !moved; s++) {
      if (g.phase === 'swap' ? g.players[s].ready : g.turn !== s) continue;
      if (g.again) {                                 // Extra-Zug nach eigener 3: Aufnehmen wird abgelehnt und ändert nichts
        const frozen = JSON.stringify(g), rp = Engine.applyAction(g, s, { t: 'pickup' });
        if (rp.ok || rp.err !== 'cannot-pickup' || JSON.stringify(g) !== frozen) watcher.faults.push('Aufnehmen im Extra-Zug nicht sauber abgelehnt (seq ' + g.seq + '): ' + JSON.stringify(rp));
        if (Engine.legalActions(g, s).some(x => x.t === 'pickup')) watcher.faults.push('legalActions bietet im Extra-Zug Aufnehmen an (seq ' + g.seq + ')');
        kinds.extrazug = (kinds.extrazug || 0) + 1;
      }
      const a = s < humans ? chooseAction(Engine.viewFor(g, s), rnds[s]) : Engine.botAction(g, s);
      const r = a ? Engine.applyAction(g, s, a) : { ok: false, err: 'kein Zug gewählt' };
      if (!r.ok) throw new Error('Startwert ' + seed + ', Sitz ' + s + ': ' + JSON.stringify(a) + ' → ' + r.err);
      moved = true;
      const ev = g.ev;
      [ev.t].concat(ev.fx || [], ev.t === 'pickup' && ev.vol ? ['freiwillig'] : []).forEach(k => { kinds[k] = (kinds[k] || 0) + 1; });
      look();
    }
    assert.ok(moved, 'Startwert ' + seed + ': niemand kann ziehen');
  }
  return { seq: g.seq, over: g.phase === 'over', deadlock: g.deadlock, loser: g.loser, finished: g.finished.slice(), kinds, faults: watcher.faults };
}

test('Spielweise (ohne Netz): 150 Partien zu viert enden innerhalb der Zuggrenze mit Rangfolge und Verlierer; jede Sicht besteht die Prüfung', () => {
  const real = Math.random;
  Math.random = seededRng(4711);                     // der Bot würfelt nur, wenn sich eine Stellung wiederholt
  try {
    const lens = [], kinds = {};
    let dead = 0;
    for (let i = 1; i <= 150; i++) {
      const r = simulate(i * 7919, 3, 1, MOVE_CAP);
      assert.deepStrictEqual(r.faults, [], 'Startwert ' + i * 7919);
      assert.ok(r.over, 'Startwert ' + i * 7919 + ': nach ' + MOVE_CAP + ' Ereignissen nicht zu Ende');
      if (r.deadlock) { dead++; assert.strictEqual(r.loser, null); continue; }
      assert.strictEqual(r.finished.length, 3);
      assert.deepStrictEqual(r.finished.concat([r.loser]).sort(), [0, 1, 2, 3], 'jeder Sitz genau einmal in der Rangfolge');
      lens.push(r.seq);
      Object.keys(r.kinds).forEach(k => { kinds[k] = (kinds[k] || 0) + r.kinds[k]; });
    }
    const s = stats(lens);
    assert.ok(dead <= 3, 'Endlosschleifen sind die Ausnahme: ' + dead);
    assert.ok(s.med < 160, 'mittlere Länge ' + s.med);
    ['play', 'pickup', 'flipfail', 'burn', 'joker', 'reverse', 'win', 'out', 'over', 'freiwillig'].forEach(k => assert.ok(kinds[k] > 0, 'kam vor: ' + k));
    // Zu zweit kommt auch das Aufgeben in Reichweite (canGiveUp wird von checkView in jeder Sicht geprüft) – und der
    // Extra-Zug nach der eigenen 3: dort bietet die Sicht kein Aufnehmen an, und simulate() prüft bei jedem
    // Extra-Zug, dass der Regelkern {t:'pickup'} mit 'cannot-pickup' ablehnt, ohne den Stand anzufassen.
    let extra = 0;
    for (let i = 1; i <= 40; i++) {
      const r = simulate(i * 104729, 2, 0, MOVE_CAP);
      assert.deepStrictEqual(r.faults, [], 'zu zweit, Startwert ' + i * 104729);
      assert.ok(r.over, 'zu zweit, Startwert ' + i * 104729 + ': nicht zu Ende');
      assert.strictEqual(r.kinds.extrazug || 0, r.kinds.again || 0, 'jeder Extra-Zug wurde geprüft');
      extra += r.kinds.extrazug || 0;
    }
    assert.ok(extra >= 20, 'Extra-Züge nach eigener 3 kamen zu zweit vor: ' + extra);
  } finally { Math.random = real; }
});

/* Ein Teilnehmer (Host oder Gast), der seine Züge selbst aus seiner Sicht wählt.
 * ctx: {engine, lat: [] (Laufzeiten Aktion → neuer Stand der Gäste), rnd(sitz) → Zufallsgenerator (optional),
 *       onSeq(p, view, neueRunde)} */
function tablePlayer(name, ctx) {
  const p = { name, snap: null, acted: -1, lastSeq: Infinity, sent: null, moves: 0, errors: [], faults: [], autoplay: true };
  const rnd = () => (ctx.rnd ? ctx.rnd(p.snap.seat)() : Math.random());
  p.session = Net.createSession({
    engine: ctx.engine || Engine, transport: 'mqtt',
    onUpdate(snap) {
      p.snap = snap;
      if (snap.stage === 'error') p.errors.push(snap.error);
      const v = snap.view;
      if (!v) { p.lastSeq = Infinity; p.acted = -1; p.sent = null; return; }
      const fresh = v.seq < p.lastSeq;               // neue Runde: die Zählung beginnt von vorn
      if (fresh) { p.acted = -1; p.sent = null; }
      const isNew = fresh || v.seq !== p.lastSeq;
      p.lastSeq = v.seq;
      if (isNew) {
        checkView(p, v);
        if (ctx.onSeq) ctx.onSeq(p, v, fresh);
      }
      if (snap.pending) return;
      if (p.sent) {
        if (v.seq !== p.sent.seq) ctx.lat.push(Date.now() - p.sent.at);
        else p.faults.push('Host hat die Aktion abgelehnt: ' + JSON.stringify(p.sent.a) + ' bei seq ' + v.seq);
        p.sent = null;
      }
      if (!p.autoplay || v.seq === p.acted) return;
      const a = chooseAction(v, rnd);
      if (!a) return;
      p.acted = v.seq;
      setTimeout(() => {                             // wie ein Fingertipp: außerhalb des Rückrufs
        const cur = p.snap && p.snap.view;
        if (!p.autoplay || !cur || cur.seq !== v.seq || p.lastSeq !== v.seq) return;
        if (!p.snap.isHost) p.sent = { seq: v.seq, at: Date.now(), a };
        p.moves++;
        if (!p.session.act(a)) p.faults.push('Aktion nicht angenommen: ' + JSON.stringify(a) + ' bei seq ' + v.seq);
      }, 0);
    }
  });
  return p;
}
const faultsOf = players => players.reduce((all, p) => all.concat(p.faults.concat(p.errors).map(f => p.name + ': ' + f)), []);
async function leaveAll(players) {
  players.forEach(p => { p.autoplay = false; try { p.session.leave(true); } catch (e) {} });
  await sleep(400);                                  // leave() schließt den Transport erst nach 300 ms
}
const person = (name, o) => Object.assign({ name, bot: false, auto: false, left: false, online: true }, o || {});
/* Öffentlicher Teil einer Sicht – muss bei allen Teilnehmern gleich sein. */
const publicOf = v => JSON.stringify([v.phase, v.turn, v.dir, v.startSeat, v.startBy, v.pile, v.stock, v.burned, v.finished, v.winner, v.loser, v.gaveUp,
  v.deadlock, v.freePlay, v.req, v.seq, v.ev, v.players.map(q => [q.name, q.bot, q.n, q.up, q.down, q.zone, q.ready, q.place])]);

test('live: jeder Broker trägt allein einen Raum – Beitritt, Start, Tausch und die ersten Züge', { timeout: 240000 }, async t => {
  if (noLive(t)) return;
  const all = [];
  const rooms = up.map((spec, k) => {
    Net.MQTT_BROKERS = [spec];                       // wird beim Öffnen des Transports gelesen
    const r = { spec, label: hostOf(spec) + (hasLogin(spec) ? ' (mit Anmeldung)' : ''), ctx: { lat: [] }, t0: Date.now() };
    r.host = tablePlayer('Host ' + k, r.ctx);
    r.guest = tablePlayer('Gast ' + k, r.ctx);
    all.push(r.host, r.guest);
    r.code = r.host.session.host('Host ' + k);
    assert.ok(r.guest.session.join(r.code, 'Gast ' + k));
    return r;
  });
  Net.MQTT_BROKERS = up.slice();
  try {
    await Promise.all(rooms.map(async r => {
      const { host, guest, label } = r;
      // Verbindungsaufbau: ein Broker, der sich mit dem CONNACK Zeit lässt, braucht mehrere Anläufe. Kommt die
      // Verbindung in 45 s nicht zustande, wird dieser eine Raum nicht geprüft (unten zählt, wie viele es waren).
      const connected = () => [host, guest].every(p => { const d = p.session.debug(); return !!(d && d[0] && d[0].ready); });
      for (const end = Date.now() + 45000, epoch = testEpoch; !connected() && Date.now() < end && epoch === testEpoch;) await sleep(20);
      if (!connected()) { r.skipped = true; return; }
      r.connectMs = Date.now() - r.t0;
      await until(() => host.snap.lobby && host.snap.lobby.players.length === 2 && guest.snap.stage === 'lobby', 30000, label + ': Gast in der Lobby');
      r.joinMs = Date.now() - r.t0;
      const dbg = host.session.debug();
      assert.strictEqual(dbg.length, 1, label + ': der Raum hängt an genau einem Broker');
      assert.strictEqual(dbg[0].url, urlOf(r.spec));
      assert.strictEqual(dbg[0].ready, true);
      assert.deepStrictEqual(guest.snap.lobby, { starter: -1, players: [person('Host ' + rooms.indexOf(r)), person('Gast ' + rooms.indexOf(r))] }, label + ': Lobby beim Gast');
      assert.ok(host.session.lobby({ op: 'start' }));
      // Tausch (2 Ereignisse) und danach mindestens acht Züge, dann anhalten und vergleichen
      await until(() => faultsOf([host, guest]).length || (host.snap.view && host.snap.view.phase !== 'swap' && host.snap.view.seq >= 11), 45000, label + ': Tausch und erste Züge');
      host.autoplay = guest.autoplay = false;
      await until(() => faultsOf([host, guest]).length || (!guest.snap.pending && guest.snap.view && guest.snap.view.seq === host.snap.view.seq), 15000, label + ': Gast hat den Stand des Hosts');
      await sleep(300);
      assert.deepStrictEqual(faultsOf([host, guest]), [], label);
      const hv = host.snap.view, gv = guest.snap.view;
      assert.strictEqual(gv.seq, hv.seq, label + ': gleicher Stand');
      assert.strictEqual(publicOf(gv), publicOf(hv), label + ': gleicher öffentlicher Stand');
      assert.strictEqual(hv.startBy, 'random', label + ': erste Runde wird ausgelost');
      assert.deepStrictEqual([hv.you, gv.you], [0, 1]);
      assert.ok(guest.moves >= 1 && host.moves >= 1, label + ': beide haben gespielt');
      assert.ok(r.ctx.lat.length >= 1, label + ': mindestens eine Aktion des Gasts lief über den Broker hin und zurück');
    }));
    rooms.forEach(r => {
      if (r.skipped) return t.diagnostic(r.label + ': Verbindung kam in 45 s nicht zustande – NICHT GEPRÜFT');
      const s = stats(r.ctx.lat);
      t.diagnostic(r.label + ': beide verbunden nach ' + r.connectMs + ' ms, Gast in der Lobby nach ' + r.joinMs + ' ms, ' + r.host.snap.view.seq +
        ' Ereignisse, Gast-Aktion → neuer Stand (' + r.ctx.lat.length + '×) min/median/max ' + s.min + '/' + s.med + '/' + s.max + ' ms');
    });
    const checked = rooms.filter(r => !r.skipped).length;
    assert.ok(checked >= Math.max(2, rooms.length - 1), 'höchstens ein Broker darf beim Verbindungsaufbau hängen: geprüft ' + checked + ' von ' + rooms.length);
  } finally { await leaveAll(all); }
});

test('live: komplette Runde nach den aktuellen Regeln – Host, zwei Gäste und ein Bot bis zur Rangfolge mit Verlierer (Zuggrenze); ' +
  'der Verlierer beginnt die nächste Runde; dann Verlassen, Lobby, Schließen', { timeout: 300000 }, async t => {
  if (noLive(t)) return;
  Net.MQTT_BROKERS = up.slice();
  Net.T.bot = 120;
  // Startwert der Kartenverteilung: zufällig, aber so gewählt, dass die Vorhersage ohne Netz eine Runde üblicher
  // Länge mit echtem Verlierer ergibt (hält die Laufzeit im Rahmen). Mit KARMA_TEST_SEED lässt er sich festlegen.
  let seed = 0, forecast = null;
  if (process.env.KARMA_TEST_SEED) { seed = Number(process.env.KARMA_TEST_SEED) >>> 0; forecast = simulate(seed, 3, 1, MOVE_CAP); }
  else for (let i = 0; i < 60; i++) {
    seed = nodeCrypto.randomBytes(4).readUInt32LE(0);
    forecast = simulate(seed, 3, 1, MOVE_CAP);
    if (forecast.over && !forecast.deadlock && forecast.seq <= 150) break;
  }
  const dealRng = seededRng(seed), seatRng = [0, 1, 2, 3].map(i => seededRng(seed + 1 + i));
  const engine = Object.assign({}, Engine, {
    createGame: (players, opts) => Engine.createGame(players, Object.assign({ rng: dealRng }, opts))
  });
  // Mitschrift aus der Sicht des Hosts (er sieht jeden Stand genau einmal)
  const log = { kinds: {}, actedSeats: {}, startTurn: null, firstMover: null, rounds: 0 };
  const ctx = {
    engine, lat: [], rnd: seat => seatRng[seat],
    onSeq(p, v, fresh) {
      if (p !== host) return;
      if (fresh) { log.actedSeats = {}; log.startTurn = null; log.firstMover = null; log.rounds++; }
      const ev = v.ev || {};
      if (ev.t === 'start') log.startTurn = v.turn;
      if (log.firstMover === null && (ev.t === 'play' || ev.t === 'pickup' || ev.t === 'flipfail')) log.firstMover = ev.seat;
      if (typeof ev.seat === 'number') log.actedSeats[ev.seat] = (log.actedSeats[ev.seat] || 0) + 1;
      [ev.t].concat(ev.fx || [], ev.repeat ? ['wiederholung'] : [], ev.t === 'play' && ev.cards.length > 1 ? ['mehrere'] : [],
        ev.t === 'play' && ev.from !== 'hand' ? ['von-' + ev.from] : [], ev.upCard ? ['letzte-offene'] : [], ev.t === 'pickup' && ev.vol ? ['freiwillig'] : [],
        ev.gone && ev.gone.length ? ['joker-weg'] : [])
        .forEach(k => { log.kinds[k] = (log.kinds[k] || 0) + 1; });
    }
  };
  const host = tablePlayer('Anna', ctx);
  const g1 = tablePlayer('Björn', ctx), g2 = tablePlayer('Çem', ctx);
  const sessions = [host, g1, g2];
  const noFaults = () => assert.deepStrictEqual(faultsOf(sessions), [], 'Startwert ' + seed);
  try {
    const code = host.session.host('Anna');
    assert.match(code, /^[A-Z2-9]{5}$/);
    const tJoin = Date.now();
    assert.ok(g1.session.join(code.toLowerCase(), 'Björn'));
    assert.ok(g2.session.join(code, 'Çem'));
    await until(() => host.snap.lobby.players.length === 3 && g1.snap.stage === 'lobby' && g2.snap.stage === 'lobby', 30000, 'beide Gäste in der Lobby');
    t.diagnostic('Beitritt beider Gäste nach ' + (Date.now() - tJoin) + ' ms');
    assert.deepStrictEqual(host.snap.lobby.players.map(x => x.name).sort(), ['Anna', 'Björn', 'Çem']);
    assert.ok(host.session.lobby({ op: 'addBot' }));
    assert.strictEqual(host.session.lobby({ op: 'rematch' }), false, 'ohne Partie keine neue Runde');
    assert.strictEqual(host.snap.lobby.starter, -1, 'erste Runde: Startspieler wird ausgelost');
    assert.ok(host.session.lobby({ op: 'start' }));
    const names = host.snap.lobby.players.map(x => x.name), n = names.length;
    assert.strictEqual(n, 4);
    assert.strictEqual(host.snap.view.startBy, 'random');

    // --- Runde 1: bis zum echten Ende, höchstens MOVE_CAP Ereignisse ---
    const tStart = Date.now();
    for (;;) {
      noFaults();
      const v = host.snap.view;
      assert.ok(v, 'Host ist in der Partie');
      if (v.phase === 'over' && sessions.every(p => !p.snap.pending && p.snap.view && p.snap.view.phase === 'over' && p.snap.view.seq === v.seq)) break;
      assert.ok(v.seq <= MOVE_CAP, 'Zuggrenze erreicht: Runde nach ' + MOVE_CAP + ' Ereignissen nicht zu Ende (Startwert ' + seed + ')');
      assert.ok(Date.now() - tStart < 150000, 'Runde nach 150 s nicht zu Ende (Startwert ' + seed + ', Ereignis ' + v.seq + ')');
      await sleep(10);
    }
    await sleep(300);
    noFaults();
    const hv = host.snap.view;
    sessions.forEach(p => {
      const v = p.snap.view;
      assert.strictEqual(v.phase, 'over');
      assert.strictEqual(v.turn, -1);
      assert.strictEqual(publicOf(v), publicOf(hv), p.name + ' sieht dasselbe Ergebnis');
      assert.strictEqual(v.you, p.snap.seat);
      assert.strictEqual(p.snap.stage, 'game');
    });
    assert.deepStrictEqual(hv.players.map(q => q.name), names, 'Sitzreihenfolge = Lobby-Reihenfolge');
    assert.deepStrictEqual([g1.snap.seat, g2.snap.seat].sort(), [1, 2]);
    assert.strictEqual(new Set(hv.finished).size, hv.finished.length, 'niemand steht doppelt in der Rangfolge');
    assert.ok(hv.winner >= 0 && hv.winner < n && hv.winner === hv.finished[0], 'Sieger ist der zuerst Fertige');
    hv.finished.forEach((seat, i) => {
      assert.strictEqual(hv.players[seat].place, i + 1);
      assert.strictEqual(hv.players[seat].zone, null);
      assert.strictEqual(hv.players[seat].n, 0);
    });
    const still = hv.players.map((q, i) => i).filter(i => hv.players[i].zone !== null);
    assert.strictEqual(hv.gaveUp, null, 'niemand hat aufgegeben');
    if (hv.deadlock) {
      assert.strictEqual(hv.loser, null, 'Endlosschleife: kein Verlierer');
      assert.strictEqual(hv.ev.deadlock, true);
      assert.ok(still.length >= 2 && hv.finished.length === n - still.length);
    } else {
      assert.strictEqual(hv.finished.length, n - 1, 'alle bis auf einen sind fertig');
      assert.deepStrictEqual(still, [hv.loser], 'der Verlierer ist der Einzige mit Karten');
      assert.strictEqual(hv.players[hv.loser].place, 0);
      assert.ok(hv.ev.t === 'play' && hv.ev.fx.indexOf('over') >= 0 && hv.ev.place === n - 1, 'letztes Ereignis beendet die Runde');
    }
    assert.ok(g1.moves > 3 && g2.moves > 3 && host.moves > 3, 'Host und beide Gäste haben gespielt');
    assert.ok((log.actedSeats[3] || 0) > 3, 'der Bot hat gespielt');
    assert.ok(ctx.lat.length >= 8);
    const s = stats(ctx.lat);
    const rank = hv.finished.map((seat, i) => (i + 1) + '. ' + names[seat]).join(', ') +
      (hv.deadlock ? ' – Endlosschleife erkannt, ohne Verlierer' : ' – Verlierer: ' + names[hv.loser]);
    const line = 'Runde 1 (Startwert ' + seed + ', Vorhersage ohne Netz ' + forecast.seq + ' Ereignisse): ' + hv.seq + ' Ereignisse in ' +
      ((Date.now() - tStart) / 1000).toFixed(1) + ' s. Rangfolge: ' + rank + '. Laufzeit Aktion → neuer Stand (' + ctx.lat.length +
      ' Gast-Züge): min ' + s.min + ' ms, median ' + s.med + ' ms, p95 ' + s.p95 + ' ms, max ' + s.max + ' ms';
    console.log('  ' + line);
    t.diagnostic(line);
    t.diagnostic('Ereignisse aus Sicht des Hosts: ' + Object.keys(log.kinds).sort().map(k => k + ' ' + log.kinds[k]).join(', '));
    host.snap.lobby.players.forEach(q => assert.deepStrictEqual(Object.keys(q).sort(), ['auto', 'bot', 'left', 'name', 'online']));
    sessions.forEach(p => assert.deepStrictEqual(p.snap.lobby, { starter: -1, players: names.map((name, i) => person(name, { bot: i === 3 })) }, p.name + ': Lobby-Schnappschuss'));

    // --- Neue Runde: der Verlierer beginnt (nach einer Endlosschleife wird ausgelost) ---
    const loser1 = hv.loser;
    assert.ok(host.session.lobby({ op: 'rematch' }));
    assert.strictEqual(host.snap.view.phase === 'over', false, 'neu gegeben');
    await until(() => faultsOf(sessions).length || (log.firstMover !== null && sessions.every(p => p.snap.view && p.snap.view.phase === 'play' && !p.snap.view.finished.length)), 30000, 'neue Runde läuft bei allen');
    noFaults();
    sessions.forEach(p => {
      const v = p.snap.view;
      assert.strictEqual(v.startBy, loser1 === null ? 'random' : 'loser', p.name + ': startBy');
      if (loser1 !== null) assert.strictEqual(v.startSeat, loser1, p.name + ': der Verlierer der ersten Runde beginnt');
      assert.strictEqual(v.loser, null);
    });
    assert.strictEqual(log.startTurn, host.snap.view.startSeat, 'nach der Tauschphase ist der Startspieler am Zug');
    assert.strictEqual(log.firstMover, host.snap.view.startSeat, 'und er macht den ersten Zug');
    t.diagnostic('Runde 2: es beginnt ' + names[host.snap.view.startSeat] + (loser1 === null ? ' (ausgelost)' : ' (Verlierer der ersten Runde)'));
    assert.strictEqual(host.snap.view.winner, null);
    assert.strictEqual(host.session.lobby({ op: 'rematch' }), false, 'mitten in der Runde ohne Sieger keine neue Runde');

    // --- Ein Gast geht mitten in der Runde, ein Bot spielt für ihn ---
    const seat2 = g2.snap.seat;
    g2.autoplay = false;
    g2.session.leave();
    assert.strictEqual(g2.snap.stage, 'idle');
    const leftAt = log.actedSeats[seat2] || 0;
    await until(() => { const q = host.snap.lobby.players[seat2]; return q.left && q.auto && !q.online; }, 15000, 'Host markiert den gegangenen Gast (left + auto)');
    await until(() => { const q = g1.snap.lobby.players[seat2]; return q.left && q.auto && !q.online; }, 15000, 'der andere Gast sieht das auch');
    assert.strictEqual(host.snap.lobby.players[seat2].name, 'Çem');
    assert.strictEqual(host.snap.stage, 'game', 'die Runde läuft weiter');
    await until(() => faultsOf([host, g1]).length || (log.actedSeats[seat2] || 0) >= leftAt + 2 || host.snap.view.phase === 'over', 60000, 'ein Bot spielt für den gegangenen Gast');
    assert.deepStrictEqual(faultsOf([host, g1]), []);

    // --- Zurück in die Lobby: der gegangene Gast ist weg, die anderen bleiben ---
    host.autoplay = g1.autoplay = false;
    const v2 = host.snap.view, rest = names.filter(x => x !== 'Çem');
    const starter = v2.phase === 'over' && v2.loser !== null ? rest.indexOf(names[v2.loser]) : -1;   // nur eine beendete Runde hat einen Verlierer
    assert.ok(host.session.lobby({ op: 'toLobby' }));
    const lobby = { starter, players: rest.map(name => person(name, { bot: name === names[3] })) };
    assert.deepStrictEqual(host.snap.lobby, lobby);
    assert.strictEqual(host.snap.stage, 'lobby');
    await until(() => g1.snap.stage === 'lobby' && g1.snap.lobby.players.length === 3, 15000, 'Gast ist zurück in der Lobby');
    assert.deepStrictEqual(g1.snap.lobby, lobby);
    assert.strictEqual(g1.snap.view, null);
    assert.deepStrictEqual(faultsOf([host, g1]), []);

    // --- Host schließt den Raum ---
    host.session.leave(true);
    await until(() => g1.snap.stage === 'error', 15000, 'Gast erfährt, dass der Raum geschlossen wurde');
    assert.strictEqual(g1.snap.error, 'closed');
  } finally { await leaveAll(sessions); }
});

test('live: Aufgeben über das Relay – wer nicht am Zug ist, gibt auf; beide sehen dasselbe Ende, der Verlierer beginnt die nächste Runde (erst der eine, dann der andere)', { timeout: 120000 }, async t => {
  if (noLive(t)) return;
  Net.MQTT_BROKERS = up.slice();
  const applied = [];                                // jede Aufgabe, die der Host an den Regelkern gibt
  const engine = Object.assign({}, Engine, {
    applyAction(g, seat, a) {
      const r = Engine.applyAction(g, seat, a);
      if (a && a.t === 'giveup') applied.push({ seat, ok: r.ok, err: r.err });
      return r;
    }
  });
  const ctx = { engine, lat: [] };
  const host = tablePlayer('Hanna', ctx), guest = tablePlayer('Gustav', ctx), both = [host, guest];
  host.autoplay = guest.autoplay = false;            // hier wird von Hand gespielt
  const noFaults = () => assert.deepStrictEqual(faultsOf(both), []);
  try {
    const code = host.session.host('Hanna');
    assert.ok(guest.session.join(code, 'Gustav'));
    await until(() => host.snap.lobby.players.length === 2 && guest.snap.stage === 'lobby', 30000, 'Gast in der Lobby');
    assert.ok(host.session.lobby({ op: 'start' }));
    const lat = [], quitters = [];
    let mustStart = null;                            // Sitz, der beginnen muss (ab Runde 2: wer aufgegeben hat)
    for (let round = 1; round <= 3; round++) {
      await until(() => both.every(p => p.snap.view && p.snap.view.phase === 'swap' && !p.snap.view.players[p.snap.seat].ready && p.snap.view.seq === host.snap.view.seq), 15000, 'Runde ' + round + ': Tauschphase bei beiden');
      both.forEach(p => {
        const v = p.snap.view;
        assert.strictEqual(v.canGiveUp, false, 'in der Tauschphase kann niemand aufgeben');
        assert.strictEqual(v.startBy, mustStart === null ? 'random' : 'loser', p.name + ': startBy in Runde ' + round);
        if (mustStart !== null) assert.strictEqual(v.startSeat, mustStart, p.name + ': wer aufgegeben hat, beginnt');
        assert.strictEqual(v.loser, null);
        assert.strictEqual(v.gaveUp, null);
      });
      if (round === 3) break;                        // die dritte Runde wird nur noch angesehen
      assert.strictEqual(host.session.act({ t: 'giveup' }), false, 'Host: Aufgeben in der Tauschphase wird abgelehnt');
      assert.ok(host.session.act({ t: 'ready' }));
      assert.ok(guest.session.act({ t: 'ready' }));
      await until(() => both.every(p => p.snap.view.phase === 'play' && !p.snap.pending && p.snap.view.seq === host.snap.view.seq), 15000, 'Runde ' + round + ': beide bereit');
      const v = host.snap.view;
      assert.strictEqual(v.turn, v.startSeat);
      both.forEach(p => assert.strictEqual(p.snap.view.canGiveUp, true, p.name + ' darf zu zweit aufgeben'));
      const quitter = both.find(p => p.snap.seat !== v.turn), other = both.find(p => p !== quitter);
      assert.strictEqual(quitter.snap.view.my, null, quitter.name + ' ist nicht am Zug');
      const q = quitter.snap.seat, o = other.snap.seat, t0 = Date.now();
      assert.ok(quitter.session.act({ t: 'giveup' }));
      await until(() => both.every(p => p.snap.view.phase === 'over' && !p.snap.pending), 15000, 'Runde ' + round + ': Ende bei beiden');
      lat.push(Date.now() - t0);
      quitters.push(quitter.name);
      noFaults();
      both.forEach(p => {
        const w = p.snap.view;
        assert.strictEqual(w.loser, q, p.name + ': Verlierer ist, wer aufgegeben hat');
        assert.strictEqual(w.gaveUp, q);
        assert.strictEqual(w.winner, o);
        assert.deepStrictEqual(w.finished, [o]);
        assert.deepStrictEqual(w.players.map(x => x.place), q === 0 ? [0, 1] : [1, 0]);
        assert.deepStrictEqual(w.ev, { t: 'giveup', seat: q, other: o, place: 1, fx: ['win', 'over'], seq: v.seq + 1 });
        assert.strictEqual(w.turn, -1);
        assert.strictEqual(w.canGiveUp, false);
        assert.strictEqual(w.deadlock, false);
        assert.strictEqual(w.players[w.you].hand.length, 3, 'die eigene Hand bleibt sichtbar');
        assert.strictEqual(w.players[1 - w.you].hand, null, 'die fremde nicht');
      });
      assert.strictEqual(publicOf(guest.snap.view), publicOf(host.snap.view));
      mustStart = q;
      assert.ok(host.session.lobby({ op: 'rematch' }));
    }
    assert.deepStrictEqual(quitters.slice().sort(), ['Gustav', 'Hanna'], 'einmal hat der Gast aufgegeben, einmal der Host');
    await sleep(1500);                               // Wiederholungen des Gasts und Nachzügler über langsamere Broker abwarten
    noFaults();
    assert.deepStrictEqual(applied.filter(x => x.ok).map(x => x.seat).sort(), [0, 1], 'jede Aufgabe genau einmal angewandt');
    assert.deepStrictEqual(applied.filter(x => !x.ok).map(x => [x.seat, x.err]), [[0, 'wrong-phase'], [0, 'wrong-phase']], 'abgelehnt nur die beiden Versuche in der Tauschphase');
    both.forEach(p => assert.strictEqual(p.snap.view.phase, 'swap', 'die dritte Runde ist unberührt'));
    t.diagnostic('aufgegeben haben nacheinander ' + quitters.join(' und ') + '; Aufgabe → Ende bei beiden nach ' + lat.join(' / ') + ' ms');
  } finally { await leaveAll(both); }
});
