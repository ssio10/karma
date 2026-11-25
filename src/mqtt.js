/* Karma – Online-Transport: MQTT 3.1.1 über WebSocket, gleichzeitig an mehrere öffentliche Broker.
 *
 * Warum so: Handys hängen oft im Mobilfunk hinter Carrier-NAT, direkte Verbindungen (WebRTC) scheitern
 * dort. Öffentliche MQTT-Broker sind überall erreichbar und brauchen weder Konto noch eigenen Server.
 * Jede Nachricht geht an alle verbundenen Broker; der Empfänger nimmt die erste Kopie und verwirft
 * die übrigen. Fällt ein Broker aus, merkt das Spiel davon nichts.
 *
 * Registriert KarmaNet.transports.mqtt (Schnittstelle siehe net.js). Muss nach net.js geladen werden.
 *
 * Stellschrauben (auch für Tests):
 *   KarmaNet.MQTT_BROKERS    veränderbare Liste; wird bei start() gelesen. Einträge: 'wss://…' oder
 *                            {url, user, pass}
 *   KarmaNet.MQTT_T          Zeiten in ms (keepalive in s); werden bei jeder Verwendung frisch gelesen
 *   KarmaNet.MQTT_WebSocket  optionaler Ersatz für den WebSocket-Konstruktor (nur Tests); bei start() gelesen
 *   transport._brokers()     Momentaufnahme je Broker: {url, ws, connected, ready} (nur Tests/Diagnose)
 *
 * Schutz auf den öffentlichen Brokern – ehrlich eingeordnet:
 *   Topic   = "karma1/<roomTag>/<Kanal>", roomTag ist ein Hash des Raumcodes (nie der Code selbst).
 *   Inhalt  = ChaCha20-verschlüsselt (Schlüssel aus dem Raumcode per SHA-256 + festem Salz), frische
 *             Zufalls-Nonce je Nachricht, dazu ein HMAC-SHA-256-Prüfwert (96 Bit) über Kanal, Nonce
 *             und Chiffrat. Müll, fremde Räume und veränderte Nachrichten fallen dadurch still weg.
 *   Grenzen = Ein 5-stelliger Code hat nur rund 33 Millionen Möglichkeiten. Wer Topic und Nachrichten
 *             mitschneidet, kann den Code in Sekunden bis Minuten durchprobieren. Das hält zufällige
 *             Mitleser und fremde Geräte auf dem Broker fern, ist aber keine starke Verschlüsselung.
 *             Außerdem kennen alle Mitspieler denselben Raumschlüssel: Wer technisch nachhilft, könnte
 *             die Nachrichten an andere Mitspieler mitlesen. Für eine Runde unter Freunden gedacht.
 *   (crypto.subtle scheidet aus: das gibt es auf http-Seiten im WLAN-Test nicht, daher reines JS.)
 */
(function (root) {
  'use strict';

  var Net = root.KarmaNet;
  if (!Net || !Net.transports) throw new Error('mqtt.js: net.js muss vorher geladen sein');

  /* Öffentliche Broker ohne Anmeldung, alle am 21.11.2026 Ende-zu-Ende geprüft (5 Minuten Dauerlauf mit
   * 2 Nachrichten/s zu je 2 kB: bei allen kein Verlust, kein Abbruch). Reihenfolge nach Messung:
   *   coreflux   bereit nach ~0,33 s, Laufzeit ~50 ms, Port 443 (kommt auch durch Netze, die nur 80/443 erlauben)
   *   mosquitto  bereit nach ~0,44 s, Laufzeit ~58 ms
   *   hivemq     bereit nach ~0,5 s,  Laufzeit ~55 ms; etwa jeder vierte Verbindungsaufbau braucht 5–7 s
   *   emqx       bereit nach 0,8–1,8 s, Laufzeit 65–200 ms; verwirft Nachrichten bei Salven (Ratenbegrenzung)
   * Jeder Broker gehört einem anderen Betreiber. Die Reihenfolge ist für den Betrieb egal (alle parallel).
   * Ebenfalls erreichbar, aber nicht eingeschaltet, weil sie einen (öffentlich dokumentierten) Demo-Zugang
   * im CONNECT brauchen – beide auf Port 443:
   *   { url: 'wss://public.cloud.shiftr.io:443/', user: 'public', pass: 'public' }   (Dauerlauf wie oben: sauber)
   *   { url: 'wss://demo.tbmq.io:443/mqtt', user: 'demo', pass: '' }                 (nur Kurztest)
   * Nicht erreichbar waren: mqtt.eclipseprojects.io (443), public.mqtthq.com (8084). */
  var BROKERS = [
    'wss://iot.coreflux.cloud:443/mqtt',
    'wss://test.mosquitto.org:8081/',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    { url: 'wss://public.cloud.shiftr.io:443/', user: 'public', pass: 'public' }
  ];
  var T = {
    keepalive: 30,      // s, dem Broker im CONNECT genannt
    ping: 10000,        // PINGREQ-Abstand
    pong: 5000,         // so lange darf nach einem PINGREQ nichts ankommen
    kick: 3000,         // dasselbe nach kick()
    connack: 6000,      // Frist für Verbindungsaufbau + CONNACK, ebenso für SUBACK
    backoffMin: 500,    // Wartezeit vor dem ersten neuen Versuch (verdoppelt sich, ±25 % Streuung)
    backoffMax: 8000,
    stable: 10000       // so lange muss eine Verbindung gehalten haben, damit der Backoff neu beginnt
  };
  var SALT = 'karma1/kartenspiel/raum/';
  var STRETCH = 2000;           // Hash-Runden bei der Schlüsselableitung (bremst Durchprobieren ein wenig)
  var MAX_PACKET = 1 << 20;     // größere MQTT-Pakete gelten als Unsinn
  var MAX_BUFFERED = 1 << 18;   // staut sich so viel im Socket, ist die Leitung tot (iOS-Zombie)
  var PINGREQ = new Uint8Array([0xC0, 0]);
  var DISCONNECT = new Uint8Array([0xE0, 0]);

  var encoder = new TextEncoder(), decoder = new TextDecoder();
  function utf8(s) { return encoder.encode(s); }

  /* ---------- SHA-256, HMAC, ChaCha20 (RFC 6234, RFC 2104, RFC 8439) ---------- */

  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  var W = new Int32Array(64);

  /* Uint8Array → Uint8Array(32) */
  function sha256(msg) {
    var len = msg.length, total = (len + 72) >> 6 << 6;
    var m = new Uint8Array(total);
    m.set(msg);
    m[len] = 0x80;
    var hi = Math.floor(len / 0x20000000), lo = len << 3;
    m[total - 5] = hi; m[total - 4] = lo >>> 24; m[total - 3] = lo >>> 16; m[total - 2] = lo >>> 8; m[total - 1] = lo;
    var h0 = 0x6a09e667, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372, h3 = 0xa54ff53a | 0;
    var h4 = 0x510e527f, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    for (var off = 0; off < total; off += 64) {
      var i, x, y;
      for (i = 0; i < 16; i++) {
        x = off + (i << 2);
        W[i] = m[x] << 24 | m[x + 1] << 16 | m[x + 2] << 8 | m[x + 3];
      }
      for (i = 16; i < 64; i++) {
        x = W[i - 15]; y = W[i - 2];
        W[i] = W[i - 16] + W[i - 7] +
          ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3) +
          ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7, t1, t2;
      for (i = 0; i < 64; i++) {
        t1 = h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + (e & f ^ ~e & g) + K256[i] + W[i] | 0;
        t2 = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + (a & b ^ a & c ^ b & c) | 0;
        h = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
      }
      h0 = h0 + a | 0; h1 = h1 + b | 0; h2 = h2 + c | 0; h3 = h3 + d | 0;
      h4 = h4 + e | 0; h5 = h5 + f | 0; h6 = h6 + g | 0; h7 = h7 + h | 0;
    }
    var out = new Uint8Array(32), hs = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (var k = 0; k < 8; k++) {
      out[k << 2] = hs[k] >>> 24; out[(k << 2) + 1] = hs[k] >>> 16; out[(k << 2) + 2] = hs[k] >>> 8; out[(k << 2) + 3] = hs[k];
    }
    return out;
  }

  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), pos = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], pos); pos += parts[i].length; }
    return out;
  }

  /* HMAC-SHA-256; parts = Liste von Uint8Arrays, die hintereinander als Nachricht gelten. */
  function hmac(key, parts) {
    if (key.length > 64) key = sha256(key);
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      var kb = i < key.length ? key[i] : 0;
      ipad[i] = kb ^ 0x36; opad[i] = kb ^ 0x5c;
    }
    return sha256(concat([opad, sha256(concat([ipad].concat(parts)))]));
  }

  function leWords(bytes) {
    var out = new Uint32Array(bytes.length >> 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = bytes[i << 2] | bytes[(i << 2) + 1] << 8 | bytes[(i << 2) + 2] << 16 | bytes[(i << 2) + 3] << 24;
    }
    return out;
  }
  function quarter(x, a, b, c, d) {
    var v;
    x[a] += x[b]; v = x[d] ^ x[a]; x[d] = v << 16 | v >>> 16;
    x[c] += x[d]; v = x[b] ^ x[c]; x[b] = v << 12 | v >>> 20;
    x[a] += x[b]; v = x[d] ^ x[a]; x[d] = v << 8 | v >>> 24;
    x[c] += x[d]; v = x[b] ^ x[c]; x[b] = v << 7 | v >>> 25;
  }
  /* key: 32 Bytes (oder schon als 8 Wörter), nonce: 12 Bytes, counter: Startblock. Ver- = Entschlüsseln. */
  function chacha20(key, nonce, counter, data) {
    var kw = key instanceof Uint32Array ? key : leWords(key), nw = leWords(nonce);
    var st = new Uint32Array(16), x = new Uint32Array(16), n = data.length, out = new Uint8Array(n);
    st[0] = 0x61707865; st[1] = 0x3320646e; st[2] = 0x79622d32; st[3] = 0x6b206574;
    for (var i = 0; i < 8; i++) st[4 + i] = kw[i];
    st[12] = counter; st[13] = nw[0]; st[14] = nw[1]; st[15] = nw[2];
    for (var off = 0; off < n; off += 64) {
      x.set(st);
      for (var r = 0; r < 10; r++) {
        quarter(x, 0, 4, 8, 12); quarter(x, 1, 5, 9, 13); quarter(x, 2, 6, 10, 14); quarter(x, 3, 7, 11, 15);
        quarter(x, 0, 5, 10, 15); quarter(x, 1, 6, 11, 12); quarter(x, 2, 7, 8, 13); quarter(x, 3, 4, 9, 14);
      }
      for (var w = 0; w < 16; w++) {
        var v = x[w] + st[w] | 0, p = off + (w << 2);
        if (p >= n) break;
        out[p] = data[p] ^ v;
        if (p + 1 < n) out[p + 1] = data[p + 1] ^ v >>> 8;
        if (p + 2 < n) out[p + 2] = data[p + 2] ^ v >>> 16;
        if (p + 3 < n) out[p + 3] = data[p + 3] ^ v >>> 24;
      }
      st[12]++;
    }
    return out;
  }

  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  function randomBytes(n) {
    var b = new Uint8Array(n);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
    return b;
  }

  /* Raumcode → {tag (für das Topic), key (ChaCha20), mac (HMAC-Schlüssel)} */
  var keyCache = {}, keyCount = 0;
  function roomKeys(code) {
    code = String(code);
    if (keyCache[code]) return keyCache[code];
    var seed = sha256(utf8(SALT + code));
    for (var i = 0; i < STRETCH; i++) seed = sha256(seed);
    function part(label) { return sha256(concat([utf8(label), seed])); }
    var k = { tag: hex(part('tag')).slice(0, 20), key: leWords(part('enc')), mac: part('mac') };
    if (++keyCount > 16) { keyCache = {}; keyCount = 1; }
    keyCache[code] = k;
    return k;
  }
  function macTag(k, chan, nonce, ct) { return hmac(k.mac, [utf8(chan), [0], nonce, ct]); }

  /* Klartext → Nonce(12) | Prüfwert(12) | Chiffrat */
  function seal(k, chan, text) {
    var nonce = randomBytes(12), ct = chacha20(k.key, nonce, 1, utf8(text));
    var out = new Uint8Array(24 + ct.length);
    out.set(nonce, 0);
    out.set(macTag(k, chan, nonce, ct).subarray(0, 12), 12);
    out.set(ct, 24);
    return out;
  }
  /* Gegenstück; null bei allem, was nicht aus diesem Raum und für diesen Kanal stammt. */
  function open(k, chan, bytes) {
    if (!bytes || bytes.length < 25) return null;
    var nonce = bytes.subarray(0, 12), ct = bytes.subarray(24);
    var want = macTag(k, chan, nonce, ct), diff = 0;
    for (var i = 0; i < 12; i++) diff |= want[i] ^ bytes[12 + i];
    if (diff) return null;
    return decoder.decode(chacha20(k.key, nonce, 1, ct));
  }

  /* ---------- MQTT-Pakete ---------- */

  function mqttStr(s) {
    var b = utf8(s), out = new Uint8Array(b.length + 2);
    out[0] = b.length >> 8; out[1] = b.length & 255;
    out.set(b, 2);
    return out;
  }
  /* Fester Kopf + "remaining length" (1–4 Bytes, je 7 Bit) + Inhalt */
  function packet(head, parts) {
    var len = 0, i;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var hdr = [head], x = len;
    do { var d = x % 128; x = (x - d) / 128; hdr.push(x ? d | 128 : d); } while (x);
    var out = new Uint8Array(hdr.length + len), pos = hdr.length;
    out.set(hdr, 0);
    for (i = 0; i < parts.length; i++) { out.set(parts[i], pos); pos += parts[i].length; }
    return out;
  }
  function connectPacket(b) {
    var flags = 0x02, parts = [mqttStr('MQTT'), [4, 0, T.keepalive >> 8, T.keepalive & 255], mqttStr(b.clientId)];
    if (b.user != null) { flags |= 0x80; parts.push(mqttStr(String(b.user))); }
    if (b.user != null && b.pass != null) { flags |= 0x40; parts.push(mqttStr(String(b.pass))); }
    parts[1][1] = flags;
    return packet(0x10, parts);
  }
  function report(e) { if (typeof console !== 'undefined' && console.error) console.error(e); }

  /* ---------- Transport ---------- */

  /* o.max: höchstens so viele Broker benutzen (die ersten der Liste) – für den Aushang der offenen Räume. */
  Net.transports.mqtt = function (roomCode, o) {
    var t = { onMessage: null, onStatus: null };
    var keys = roomKeys(roomCode);
    var prefix = 'karma1/' + keys.tag + '/';
    var sid = Net.randId(10), counter = 0;      // Absender-Kennung + Zähler = Nachrichten-ID
    var subs = [], brokers = [], WS = null, started = false, closed = false, online = false;
    var seen = Object.create(null), seenList = [];

    function refresh() {
      var any = false;
      for (var i = 0; i < brokers.length; i++) if (brokers[i].ready) any = true;
      if (closed || any === online) return;
      online = any;
      if (t.onStatus) { try { t.onStatus(any); } catch (e) { report(e); } }
    }
    function send(b, bytes) {
      var ws = b.ws;
      if (!ws || ws.readyState !== 1) return false;
      try { ws.send(bytes); return true; } catch (e) { return false; }
    }
    function stopTimers(b) {
      clearTimeout(b.hs); clearTimeout(b.live); clearTimeout(b.ping); clearTimeout(b.retry);
      b.hs = b.live = b.ping = b.retry = null;
    }

    /* Verbindung wegwerfen und neu aufbauen: sofort (now) oder nach Backoff. */
    function drop(b, now) {
      var ws = b.ws, stable = b.ready && Date.now() - b.readyAt >= T.stable;
      stopTimers(b);
      send(b, DISCONNECT);                      // falls noch offen: der Broker räumt dann sofort auf
      b.ws = null; b.buf = null; b.connected = b.ready = false; b.subWait = 0;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(); } catch (e) {}
      }
      if (closed) return;
      if (stable || now) b.attempt = 0;
      refresh();
      if (closed || b.ws || b.retry) return;    // onStatus hat bereits selbst reagiert (kick/close)
      if (now) return connect(b);
      var wait = Math.min(T.backoffMax, T.backoffMin * Math.pow(2, b.attempt++)) * (0.75 + Math.random() * 0.5);
      b.retry = setTimeout(function () { b.retry = null; connect(b); }, Math.min(T.backoffMax, wait));
    }

    function connect(b) {
      if (closed) return;
      stopTimers(b);
      var ws = null;
      try {
        ws = new WS(b.url, 'mqtt');
        ws.binaryType = 'arraybuffer';
      } catch (e) {
        if (ws) { try { ws.close(); } catch (e2) {} }
        b.ws = null;
        return drop(b);
      }
      b.ws = ws; b.since = Date.now(); b.buf = null; b.connected = b.ready = false; b.subWait = 0;
      b.clientId = 'karma' + Net.randId(14);    // je Versuch neu: keine Sitzungsübernahme alter, hängender Verbindungen
      ws.onopen = function () { if (b.ws === ws) send(b, connectPacket(b)); };
      ws.onmessage = function (ev) {
        if (b.ws !== ws) return;
        try { feed(b, ws, ev.data); } catch (e) { if (b.ws === ws) drop(b); }
      };
      ws.onclose = ws.onerror = function () { if (b.ws === ws) drop(b); };
      b.hs = setTimeout(function () { b.hs = null; drop(b); }, T.connack);
    }

    /* Innerhalb von ms muss irgendein vollständiges Paket ankommen, sonst gilt die Verbindung als tot. */
    function expectLife(b, ms, now) {
      var due = Date.now() + ms;
      if (b.live && b.liveDue <= due) return;
      clearTimeout(b.live);
      b.liveDue = due;
      b.live = setTimeout(function () { b.live = null; drop(b, now); }, ms);
    }
    function schedulePing(b) {
      b.ping = setTimeout(function () {
        b.ping = null;
        if (!send(b, PINGREQ)) return drop(b);
        expectLife(b, T.pong, false);
        schedulePing(b);
      }, T.ping);
    }
    /* Immer alle Kanäle in einem SUBSCRIBE (QoS 0); bereit ist der Broker erst mit dem passenden SUBACK. */
    function sendSubscribe(b) {
      var id = b.nextId = b.nextId % 65535 + 1, parts = [[id >> 8, id & 255]];
      for (var i = 0; i < subs.length; i++) parts.push(mqttStr(prefix + subs[i]), [0]);
      b.subWait = id;
      b.ready = false;
      send(b, packet(0x82, parts));
      clearTimeout(b.hs);
      b.hs = setTimeout(function () { b.hs = null; drop(b); }, T.connack);
    }
    function markReady(b) {
      clearTimeout(b.hs); b.hs = null;
      b.subWait = 0;
      if (!b.ready) { b.ready = true; b.readyAt = Date.now(); }
    }

    /* Eingehende WebSocket-Daten in MQTT-Pakete zerlegen: mehrere Pakete pro Frame und über
     * Frame-Grenzen verteilte Pakete (auch mitten im Längenfeld) kommen beide vor. */
    function feed(b, ws, data) {
      if (!data || typeof data === 'string' || data.byteLength === undefined) return;
      var c = data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      if (b.buf) { c = concat([b.buf, c]); b.buf = null; }
      var pos = 0, n = c.length;
      while (n - pos >= 2) {
        var i = pos + 1, len = 0, mult = 1, d = 128;
        while (d & 128) {
          if (i - pos > 4) throw new Error('mqtt: Längenfeld');
          if (i >= n) { len = -1; break; }
          d = c[i++];
          len += (d & 127) * mult;
          mult *= 128;
        }
        if (len < 0) break;
        if (len > MAX_PACKET) throw new Error('mqtt: Paket zu groß');
        if (n - i < len) break;
        if (b.live) { clearTimeout(b.live); b.live = null; }   // ein vollständiges Paket = Lebenszeichen
        handle(b, c[pos], c, i, i + len);
        pos = i + len;
        if (b.ws !== ws) return;
      }
      if (pos < n) b.buf = c.slice(pos);
    }

    function handle(b, head, c, p, end) {
      var type = head >> 4;
      if (type === 3) {                                   // PUBLISH
        var qos = head >> 1 & 3;
        if (end - p < 2) throw new Error('mqtt: PUBLISH');
        var tl = c[p] << 8 | c[p + 1];
        p += 2;
        if (p + tl + (qos ? 2 : 0) > end) throw new Error('mqtt: PUBLISH');
        if (head & 1 || tl <= prefix.length || tl > prefix.length + 64) return;   // retained senden wir nie
        var topic = '';
        for (var i = 0; i < tl; i++) topic += String.fromCharCode(c[p + i]);
        receive(topic, c.subarray(p + tl + (qos ? 2 : 0), end));
      } else if (type === 2) {                            // CONNACK
        if (end - p < 2 || c[p + 1] !== 0) throw new Error('mqtt: CONNACK');
        if (b.connected) return;
        b.connected = true;
        schedulePing(b);
        if (subs.length) sendSubscribe(b); else markReady(b);
        refresh();
      } else if (type === 9) {                            // SUBACK
        if (end - p < 3 || !b.connected || (c[p] << 8 | c[p + 1]) !== b.subWait) return;
        for (var k = p + 2; k < end; k++) if (c[k] & 0x80) throw new Error('mqtt: SUBACK');
        markReady(b);
        refresh();
      }
      /* PINGRESP und alles andere: zählt nur als Lebenszeichen */
    }

    function receive(topic, payload) {
      if (topic.slice(0, prefix.length) !== prefix) return;
      var chan = topic.slice(prefix.length);
      if (subs.indexOf(chan) < 0) return;
      var text = open(keys, chan, payload), env = null;
      if (text === null) return;
      try { env = JSON.parse(text); } catch (e) { return; }
      if (!env || typeof env.s !== 'string' || typeof env.n !== 'number' || env.s === sid) return;
      var id = env.s + ':' + env.n;
      if (seen[id]) return;                               // kam schon über einen anderen Broker
      seen[id] = true;
      seenList.push(id);
      if (seenList.length > 4000) seenList.splice(0, 2000).forEach(function (old) { delete seen[old]; });
      if (!closed && t.onMessage) { try { t.onMessage(chan, env.o); } catch (e2) { report(e2); } }
    }

    function onOnline() { t.kick(); }

    t.start = function () {
      if (started || closed) return;
      started = true;
      WS = Net.MQTT_WebSocket || root.WebSocket;
      brokers = (Net.MQTT_BROKERS || []).slice(0, o && o.max > 0 ? o.max : undefined).map(function (spec) {
        var o = typeof spec === 'string' ? { url: spec } : spec || {};
        return {
          url: String(o.url), user: o.user, pass: o.pass, clientId: '',
          ws: null, buf: null, connected: false, ready: false, subWait: 0, nextId: 0,
          attempt: 0, since: 0, readyAt: 0, liveDue: 0, hs: null, live: null, ping: null, retry: null
        };
      });
      brokers.forEach(connect);
      if (typeof root.addEventListener === 'function') { try { root.addEventListener('online', onOnline); } catch (e) {} }
    };

    t.subscribe = function (chan) {
      chan = String(chan);
      if (closed || subs.indexOf(chan) >= 0) return;
      subs.push(chan);
      brokers.forEach(function (b) { if (b.connected) sendSubscribe(b); });
      refresh();
    };

    t.publish = function (chan, obj) {
      if (closed || !started) return;
      var pkt = null;
      for (var i = 0; i < brokers.length; i++) {
        var b = brokers[i];
        if (!b.connected || !b.ws || b.ws.readyState !== 1) continue;
        if (b.ws.bufferedAmount > MAX_BUFFERED) { drop(b); continue; }
        if (!pkt) {
          try {
            pkt = packet(0x30, [mqttStr(prefix + chan), seal(keys, String(chan), JSON.stringify({ s: sid, n: ++counter, o: obj }))]);
          } catch (e) { report(e); return; }
        }
        send(b, pkt);
      }
    };

    /* Nach App-Wechsel: tote oder halb offene Sockets sofort ersetzen, offene mit PINGREQ prüfen. */
    t.kick = function () {
      if (closed || !started) return;
      brokers.forEach(function (b) {
        var ws = b.ws;
        if (!ws) { b.attempt = 0; return connect(b); }
        if (ws.readyState !== 1) {
          if (ws.readyState === 0 && Date.now() - b.since < T.kick) return;   // läuft gerade erst an: nicht stören
          return drop(b, true);
        }
        if (b.connected) send(b, PINGREQ);
        expectLife(b, T.kick, true);
      });
    };

    t.close = function () {
      if (closed) return;
      closed = true;
      online = false;
      brokers.forEach(function (b) {
        var ws = b.ws;
        stopTimers(b);
        send(b, DISCONNECT);
        b.ws = null; b.buf = null; b.connected = b.ready = false;
        if (ws) {
          ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
          try { ws.close(); } catch (e) {}
        }
      });
      if (typeof root.removeEventListener === 'function') { try { root.removeEventListener('online', onOnline); } catch (e) {} }
    };

    t._brokers = function () {
      return brokers.map(function (b) { return { url: b.url, ws: b.ws, connected: b.connected, ready: b.ready }; });
    };

    return t;
  };

  Net.MQTT_BROKERS = BROKERS;
  Net.MQTT_T = T;
  Net.mqttInternals = {
    sha256: sha256, hmac: hmac, chacha20: chacha20, roomKeys: roomKeys, seal: seal, open: open,
    utf8: utf8, hex: hex, packet: packet, mqttStr: mqttStr
  };
  if (typeof module === 'object' && module.exports) module.exports = Net.mqttInternals;
})(typeof globalThis !== 'undefined' ? globalThis : this);
