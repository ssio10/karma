/* Karma – Raum-Logik (Host/Mitspieler) über einen austauschbaren Transport.
 *
 * Ein Gerät ist Host und führt den Spielstand (KarmaEngine). Mitspieler schicken Aktionen,
 * der Host schickt jedem seine eigene Sicht zurück. Alle Nachrichten gelten als verlierbar:
 *  - Mitspieler wiederholen Aktionen, bis der Host sie bestätigt (ack).
 *  - Mitspieler pingen mit ihrer Versionsnummer; weicht sie ab, schickt der Host den Stand neu.
 *
 * Transport-Schnittstelle (KarmaNet.transports[kind](roomCode) liefert so ein Objekt):
 *   start()                 verbinden (und bei Abbruch selbstständig neu verbinden)
 *   subscribe(chan)         Kanal abonnieren ('h' oder 'p/<pid>'); vor oder nach start() erlaubt
 *   publish(chan, obj)      JSON-Objekt senden, best effort; nie an sich selbst zustellen
 *   kick()                  Verbindung prüfen / sofort neu verbinden (z. B. nach App-Wechsel)
 *   close()                 alles beenden
 *   onMessage(chan, obj)    wird vom Transport aufgerufen (Duplikate bereits entfernt)
 *   onStatus(online)        wird vom Transport aufgerufen, wenn sich die Verbindung ändert
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KarmaNet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var ID_ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var STORE_KEY = 'karma.session.v1';
  var MAX_AGE = 12 * 3600 * 1000;
  var BOT_NAMES = ['Bot Ada', 'Bot Ben', 'Bot Cleo', 'Bot Dino', 'Bot Elli'];
  /* Zeiten in ms – in Tests überschreibbar */
  var T = { tick: 400, ping: 3000, hostDead: 10000, playerDead: 10000, resend: 1200, hello: 1500, joinTimeout: 9000, bot: 900, sweep: 2000,
    turn: 50000,    // Zeit pro Zug; danach zieht der Host automatisch (0 = kein Zeitlimit)
    swap: 60000,    // Zeit für die Tauschphase; danach beginnt die Runde, auch wenn nicht alle bereit sind (0 = kein Limit)
    start: 3000 };  // sind alle bereit: so lange kann man „Bereit“ noch zurücknehmen (0 = Runde beginnt sofort)

  function randId(len, alpha) {
    alpha = alpha || ID_ALPHA;
    var out = '', c = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : null;
    var buf = new Uint8Array(len);
    if (c) c.getRandomValues(buf); else for (var i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < len; j++) out += alpha.charAt(buf[j] % alpha.length);
    return out;
  }
  function normalizeCode(str) {
    var s = String(str || '').toUpperCase(), out = '';
    for (var i = 0; i < s.length; i++) if (CODE_ALPHA.indexOf(s.charAt(i)) >= 0) out += s.charAt(i);
    return out.slice(0, 5);
  }
  function cleanName(n) {
    n = (typeof n === 'string' || typeof n === 'number' ? String(n) : '').replace(/\s+/g, ' ').trim().slice(0, 14);
    return n || 'Spieler';
  }

  var transports = {};

  /* In-Process-Bus für Tests (Node). drop = Verlustrate 0..1, delay = ms. */
  var memBus = { rooms: {}, drop: 0, delay: 0 };
  transports.mem = function (code) {
    var t = { onMessage: null, onStatus: null }, subs = {}, open = false;
    t.start = function () {
      (memBus.rooms[code] = memBus.rooms[code] || []).push(t);
      open = true;
      setTimeout(function () { if (open && t.onStatus) t.onStatus(true); }, 0);
    };
    t.subscribe = function (ch) { subs[ch] = true; };
    t._has = function (ch) { return open && subs[ch]; };
    t._deliver = function (ch, data) { if (open && t.onMessage) t.onMessage(ch, JSON.parse(data)); };
    t.publish = function (ch, obj) {
      if (!open) return;
      var data = JSON.stringify(obj);
      (memBus.rooms[code] || []).forEach(function (o) {
        if (o === t || !o._has(ch)) return;
        if (memBus.drop && Math.random() < memBus.drop) return;
        setTimeout(function () { o._deliver(ch, data); }, memBus.delay);
      });
    };
    t.kick = function () {};
    t.close = function () {
      open = false;
      var list = memBus.rooms[code] || [], i = list.indexOf(t);
      if (i >= 0) list.splice(i, 1);
    };
    return t;
  };

  /* BroadcastChannel: mehrere Tabs desselben Browsers, ohne Internet (zum lokalen Testen). */
  transports.bc = function (code) {
    var t = { onMessage: null, onStatus: null }, subs = {}, bc = null;
    t.start = function () {
      bc = new BroadcastChannel('karma-room-' + code);
      bc.onmessage = function (e) {
        var m = e.data;
        if (m && subs[m.ch] && t.onMessage) t.onMessage(m.ch, JSON.parse(m.d));
      };
      setTimeout(function () { if (bc && t.onStatus) t.onStatus(true); }, 0);
    };
    t.subscribe = function (ch) { subs[ch] = true; };
    t.publish = function (ch, obj) { if (bc) bc.postMessage({ ch: ch, d: JSON.stringify(obj) }); };
    t.kick = function () {};
    t.close = function () { if (bc) { bc.close(); bc = null; } };
    return t;
  };

  var DESIGNS = { table: ['normal', 'stahl', 'patio', 'nacht'], cards: ['normal', 'stift', 'filz', 'druck'] };
  /* Was vom Host kommt, wird nur in bekannter Form übernommen. */
  function cleanRoom(r) {
    if (!r || typeof r !== 'object') return null;
    return {
      table: DESIGNS.table.indexOf(r.table) >= 0 ? r.table : 'normal',
      cards: DESIGNS.cards.indexOf(r.cards) >= 0 ? r.cards : 'normal',
      wins: Array.isArray(r.wins) ? r.wins.slice(0, 6).map(function (n) { return typeof n === 'number' && n > 0 ? Math.min(999, n | 0) : 0; }) : []
    };
  }
  function idleSnap() {
    return { stage: 'idle', error: null, code: null, isHost: false, seat: -1, conn: 'offline', hostOnline: false, pending: 0, lobby: null, view: null, room: null };
  }

  /* opts: { engine, storage (localStorage-artig, optional), transport: 'mqtt'|'bc'|'mem', onUpdate(snap) }
   *
   * snap = {
   *   stage: 'idle' | 'connecting' | 'lobby' | 'game' | 'error',
   *   error: null | 'not-found' (Raum antwortet nicht – es wird weiter versucht) |
   *          'full' | 'running' | 'kicked' | 'closed' | 'unknown',
   *   code, isHost, seat,
   *   conn: 'offline' | 'connecting' | 'online'     eigene Verbindung zum Relay
   *   hostOnline: bool                              Host antwortet (für den Host immer true)
   *   pending: Anzahl noch unbestätigter eigener Aktionen
   *   lobby: { starter, players: [{name, bot, auto, online, left}] }   Sitzreihenfolge = Uhrzeigersinn; starter = Sitz, der die nächste Runde beginnt (Verlierer), sonst -1
   *   view: KarmaEngine.viewFor(...) oder null (in der Lobby)
   *   room: { table, cards, wins: [Siege je Sitz] }   Design (stellt der Host ein, gilt für alle) und Strichliste
   * }
   */
  function createSession(opts) {
    opts = opts || {};
    var E = opts.engine || root.KarmaEngine;
    var store = opts.storage || null;
    var kind = opts.transport || 'mqtt';
    var onUpdate = opts.onUpdate || function () {};

    var role = null, tr = null, online = false, tickTimer = null, botTimer = null, closeTimer = null;
    var clock = null, clockTimer = null;   // Host: laufendes Zeitlimit {key, base, swapEnd, end, total, kind: 'turn'|'swap'|'start'}
    var H = null;   // Host:  {code, epoch, ver, players:[{pid,name,bot,local,auto,left,online,seen,ack}], kicked:[pid], game}
    var C = null;   // Gast:  {code, pid, name, epoch, ver, got, seat, lobby, view, error, pending, seq, started, hostSeen, nextPing, nextHello, nextResend, hostOnline}
    var session = { snap: idleSnap() };

    function buildSnap() {
      var s = idleSnap();
      if (role === 'host' && H) {
        s.stage = H.game ? 'game' : 'lobby';
        s.code = H.code; s.isHost = true; s.seat = 0;
        s.conn = online ? 'online' : 'connecting';
        s.hostOnline = true;
        s.lobby = lobbyInfo();
        s.view = H.game ? E.viewFor(H.game, 0) : null;
        s.room = roomInfo();
      } else if (role === 'client' && C) {
        s.code = C.code; s.seat = C.seat;
        s.conn = online ? 'online' : 'connecting';
        s.error = C.error;
        s.pending = C.pending.length;
        if (C.error && C.error !== 'not-found') s.stage = 'error';
        else if (!C.got) s.stage = 'connecting';
        else {
          s.stage = C.view ? 'game' : 'lobby';
          s.hostOnline = C.hostOnline;
          s.lobby = C.lobby; s.view = C.view; s.room = C.room || null;
        }
      }
      return s;
    }
    function emit() {
      session.snap = buildSnap();
      try { onUpdate(session.snap); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
    }

    function save() {
      if (!store) return;
      try {
        if (role === 'host' && H) store.setItem(STORE_KEY, JSON.stringify({ role: 'host', at: Date.now(), H: H }));
        else if (role === 'client' && C) store.setItem(STORE_KEY, JSON.stringify({ role: 'client', at: Date.now(), code: C.code, pid: C.pid, name: C.name }));
      } catch (e) { /* Speicher voll oder gesperrt: Spiel läuft trotzdem weiter */ }
    }
    /* Nur löschen, was zu dieser Sitzung gehört (ein zweiter Tab kann denselben Speicher nutzen). */
    function forget() {
      if (!store) return;
      try {
        var cur = JSON.parse(store.getItem(STORE_KEY) || 'null');
        var mine = !cur || !role ||
          (role === 'host' && H && cur.role === 'host' && cur.H && cur.H.epoch === H.epoch) ||
          (role === 'client' && C && cur.role === 'client' && cur.pid === C.pid);
        if (mine) store.removeItem(STORE_KEY);
      } catch (e) { try { store.removeItem(STORE_KEY); } catch (e2) {} }
    }

    function openTransport(code, chan, onMsg) {
      var make = transports[kind];
      if (!make) throw new Error('Unbekannter Transport: ' + kind);
      online = false;
      tr = make(code);
      tr.onMessage = function (ch, m) {
        try { onMsg(ch, m); } catch (e) { if (typeof console !== 'undefined') console.error('Karma: Nachricht verworfen', e); }
      };
      tr.onStatus = function (on) {
        on = !!on;
        if (on === online) return;
        online = on;
        if (on && role === 'client' && C) { C.nextHello = 0; C.nextPing = 0; C.nextResend = 0; clientTick(); }
        // Was der Host offline verschickt hat, ging verloren: nach dem Wiederverbinden allen den Stand schicken.
        if (on && role === 'host' && H) { for (var i = 0; i < H.players.length; i++) sendState(i); }
        emit();
      };
      tr.subscribe(chan);
      tr.start();
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(role === 'host' ? hostTick : clientTick, role === 'host' ? T.sweep : T.tick);
    }
    function teardown() {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      if (botTimer) { clearTimeout(botTimer); botTimer = null; }
      if (clockTimer) { clearTimeout(clockTimer); clockTimer = null; }
      clock = null;
      if (tr) { var old = tr; tr = null; old.onMessage = null; old.onStatus = null; try { old.close(); } catch (e) {} }
      online = false;
    }

    /* ---------- Host ---------- */

    function lobbyInfo() {
      var starter = -1;   // Sitz, der die nächste Runde beginnt (Verlierer der letzten), sonst -1 = wird ausgelost
      if (!H.game && H.loserPid) for (var i = H.players.length - 1; i >= 0; i--) if (H.players[i].pid === H.loserPid) starter = i;
      return {
        starter: starter,
        players: H.players.map(function (p) {
          return { name: p.name, bot: !!p.bot, auto: !!p.auto, left: !!p.left, online: p.bot || p.local ? true : !!p.online };
        })
      };
    }
    /* Design und Strichliste: gehören zum Raum, nicht zur Runde. */
    function roomInfo() {
      var d = H.design || {};
      return {
        table: DESIGNS.table.indexOf(d.table) >= 0 ? d.table : 'normal',
        cards: DESIGNS.cards.indexOf(d.cards) >= 0 ? d.cards : 'normal',
        wins: H.players.map(function (p) { return p.wins | 0; })
      };
    }
    /* Ein Strich für den Sieger, sobald er feststeht – einmal pro Runde. Sitze und H.players decken sich während einer Partie. */
    function countWin() {
      var g = H.game;
      if (!g || g.winner === null || g.winner === undefined || H.wonRound === (H.round || 0) || !H.players[g.winner]) return;
      H.wonRound = H.round || 0;
      H.players[g.winner].wins = (H.players[g.winner].wins | 0) + 1;
    }
    function sendState(i) {
      var p = H.players[i];
      if (!p || p.bot || p.local || !tr) return;
      tr.publish('p/' + p.pid, {
        t: 'state', epoch: H.epoch, ver: H.ver, round: H.round || 0, ack: p.ack || 0, seat: i,
        lobby: lobbyInfo(), view: H.game ? E.viewFor(H.game, i) : null, clock: clockMsg(), room: roomInfo()
      });
    }

    /* ---------- Zeitlimit (führt der Host) ----------
     * Zug: T.turn ab jedem neuen Spielstand; läuft die Zeit ab, macht der Host den Zug (E.autoAction).
     * Tauschphase: T.swap ab Rundenbeginn; danach beginnt die Runde, auch wenn nicht alle bereit sind.
     * Sind alle bereit, beginnt sie nach T.start – bis dahin kann jeder „Bereit“ noch zurücknehmen.
     * Die Gäste bekommen mit jedem Stand die Restzeit und rechnen sie auf ihre eigene Uhr um. */
    function clockMsg() {
      if (!clock || !clock.end) return null;
      return { left: Math.max(0, clock.end - Date.now()), total: clock.total, kind: clock.kind };
    }
    function armClock() {
      if (role !== 'host' || !H) return;
      var g = H.game, now = Date.now(), next = null;
      if (g && g.phase === 'swap') {
        var base = 'swap:' + (H.round || 0);
        var swapEnd = clock && clock.base === base ? clock.swapEnd : (T.swap > 0 ? now + T.swap : 0);
        var all = g.holdStart && g.players.every(function (q) { return q.ready; });
        if (all) {
          var goEnd = clock && clock.key === base + ':go' ? clock.end : now + T.start;
          if (swapEnd && swapEnd < goEnd) goEnd = swapEnd;
          next = { key: base + ':go', base: base, swapEnd: swapEnd, end: goEnd, total: T.start, kind: 'start' };
        } else {
          next = { key: base, base: base, swapEnd: swapEnd, end: swapEnd, total: T.swap, kind: 'swap' };
        }
      } else if (g && g.phase === 'play' && T.turn > 0) {
        var key = 'play:' + (H.round || 0) + ':' + g.seq;
        next = clock && clock.key === key ? clock : { key: key, end: now + T.turn, total: T.turn, kind: 'turn' };
      }
      clock = next;
      if (clockTimer) { clearTimeout(clockTimer); clockTimer = null; }
      if (clock && clock.end) clockTimer = setTimeout(onClock, Math.max(0, clock.end - now));
    }
    function onClock() {
      clockTimer = null;
      if (role !== 'host' || !H || !H.game || !clock || !clock.end) return;
      if (Date.now() < clock.end) return armClock();
      var g = H.game;
      if (g.phase === 'swap') {
        if (E.startPlay(g, clock.kind !== 'start').ok) return bump();
      } else if (g.phase === 'play') {
        var seat = g.turn, a = E.autoAction(g, seat);
        if (a && E.applyAction(g, seat, a).ok) { g.ev.auto = true; return bump(); }
      }
      clock.end = 0;   // nichts zu tun: nicht in einer Schleife weiter feuern
    }
    function deny(pid, why) { if (tr) tr.publish('p/' + pid, { t: 'deny', why: why }); }
    function bump() {
      H.ver++;
      countWin();
      armClock();
      save();
      for (var i = 0; i < H.players.length; i++) sendState(i);
      emit();
      driveBots();
    }
    function isAuto(i) { var p = H.players[i]; return !!(p && (p.bot || p.auto)); }
    function driveBots() {
      if (!H || !H.game) return;
      var g = H.game;
      if (g.phase === 'swap') {
        var changed = false;
        for (var i = 0; i < g.players.length; i++) {
          if (isAuto(i) && !g.players[i].ready) {
            var a = E.botAction(g, i);
            if (a && E.applyAction(g, i, a).ok) changed = true;
          }
        }
        if (changed) bump();
        return;
      }
      if (g.phase === 'play' && isAuto(g.turn) && !botTimer) {
        botTimer = setTimeout(function () {
          botTimer = null;
          if (!H || !H.game || H.game.phase !== 'play') return;
          var seat = H.game.turn;
          if (!isAuto(seat)) return;
          var act = E.botAction(H.game, seat);
          if (act && E.applyAction(H.game, seat, act).ok) bump();
        }, botDelay(g.ev));
      }
    }
    /* Nach Joker, Konter und Aufnehmen wartet der Bot länger, damit die Meldung dazu lesbar bleibt. */
    function botDelay(ev) {
      var fx = ev && ev.fx;
      var slow = ev && (ev.t === 'pickup' || ev.t === 'flipfail' ||
        (fx && (fx.indexOf('joker') >= 0 || fx.indexOf('counter') >= 0)));
      return slow ? Math.round(T.bot * 1.7) : T.bot;
    }
    /* Der Verlierer der letzten Runde beginnt die nächste. Gemerkt wird er über seine Spieler-ID,
     * weil sich die Sitze ändern können, wenn jemand den Raum verlassen hat. */
    function rememberLoser() {
      var g = H.game;
      H.loserPid = null;
      if (g && g.phase === 'over' && typeof g.loser === 'number' && H.players[g.loser]) H.loserPid = H.players[g.loser].pid;
    }
    function newGame() {
      var ps = H.players.filter(function (q) { return !q.left; }), opts = {};
      for (var i = ps.length - 1; i >= 0; i--) if (H.loserPid && ps[i].pid === H.loserPid) { opts.startSeat = i; opts.startBy = 'loser'; }
      H.loserPid = null;
      H.round = (H.round || 0) + 1;   // Aktionen tragen die Rundennummer: Nachzügler aus einer alten Runde zählen nicht
      if (T.start > 0) opts.holdStart = true;   // alle bereit → kurzer Countdown, erst dann beginnt die Runde (siehe armClock)
      return E.createGame(ps.map(function (q) { return { name: q.name, bot: !!q.bot }; }), opts);
    }
    function removePlayer(i) { H.players.splice(i, 1); }
    /* Spieler, die mitten in der Partie gegangen sind, vor der nächsten Runde entfernen. */
    function dropLeft() {
      H.players = H.players.filter(function (p) { return !p.left; });
    }
    function hostOnMsg(ch, m) {
      if (!H || ch !== 'h' || !m || typeof m.pid !== 'string' || !m.pid) return;
      var i = -1;
      for (var k = 0; k < H.players.length; k++) if (H.players[k].pid === m.pid && !H.players[k].bot && !H.players[k].local) i = k;
      var now = Date.now();
      if (i < 0) {
        if (m.t === 'bye') return;
        if (H.kicked && H.kicked.indexOf(m.pid) >= 0) return deny(m.pid, 'kicked');
        if (m.t !== 'hello' || m.pid === 'local' || m.pid.indexOf('bot-') === 0) return deny(m.pid, 'unknown');
        if (H.game) return deny(m.pid, 'running');
        if (H.players.length >= 6) return deny(m.pid, 'full');
        H.players.push({ pid: m.pid, name: cleanName(m.name), online: true, seen: now, ack: 0 });
        return bump();
      }
      var p = H.players[i], changed = false;
      if (m.t === 'bye') {
        // In der Lobby verschwindet der Spieler; in einer laufenden Partie spielt ein Bot für ihn zu Ende.
        if (H.game) { p.online = false; p.left = true; p.auto = true; } else removePlayer(i);
        return bump();
      }
      if (p.left) return deny(m.pid, 'unknown');
      p.seen = now;
      if (!p.online) { p.online = true; changed = true; }
      if (p.auto) { p.auto = false; changed = true; }
      if (m.t === 'hello') {
        if (!H.game && m.name != null && cleanName(m.name) !== p.name) { p.name = cleanName(m.name); changed = true; }
        if (changed) bump(); else sendState(i);
        return;
      }
      if (m.t === 'ping') {
        if (changed) return bump();
        if (m.ver !== H.ver || m.epoch !== H.epoch) sendState(i);
        else tr.publish('p/' + p.pid, { t: 'pong', ver: H.ver });
        return;
      }
      if (m.t === 'act') {
        var n = typeof m.n === 'number' ? m.n | 0 : 0;
        if (n === (p.ack || 0) + 1) {
          p.ack = n;
          var stale = typeof m.r === 'number' && m.r !== (H.round || 0);
          var r = H.game && !stale ? E.applyAction(H.game, i, m.a) : { ok: false };
          if (r.ok || changed) return bump();
          save();
          return sendState(i);
        }
        if (changed) return bump();
        return sendState(i);   // Duplikat oder Lücke: Stand erneut schicken
      }
      if (changed) bump();
    }
    function hostTick() {
      if (!H) return;
      var now = Date.now(), changed = false;
      H.players.forEach(function (p) {
        if (p.bot || p.local) return;
        if (p.online && now - (p.seen || 0) > T.playerDead) { p.online = false; changed = true; }
      });
      // Falls der Zeitgeber des Zeitlimits verschluckt wurde (Seite war im Hintergrund): hier nachholen.
      if (clock && clock.end && now >= clock.end) onClock();
      if (changed) bump();
    }
    function nextBotName() {
      for (var i = 0; i < BOT_NAMES.length; i++) {
        var free = true;
        for (var k = 0; k < H.players.length; k++) if (H.players[k].name === BOT_NAMES[i]) free = false;
        if (free) return BOT_NAMES[i];
      }
      return 'Bot ' + randId(3);
    }
    function startHost() {
      role = 'host';
      openTransport(H.code, 'h', hostOnMsg);
      armClock();
      save();
      emit();
      driveBots();
    }

    /* Raum eröffnen. Der Host sitzt auf Platz 0. */
    session.host = function (name) {
      session.leave(true);
      H = {
        code: randId(5, CODE_ALPHA), epoch: randId(8), ver: 1,
        players: [{ pid: 'local', local: true, name: cleanName(name) }],
        kicked: [], game: null
      };
      startHost();
      return H.code;
    };

    /* Host-Befehle:
     *  {op:'addBot'}  {op:'kick', seat}            nur in der Lobby
     *  {op:'start'}                                Partie starten (2–6 Spieler; es beginnt der Verlierer der letzten Runde, sonst wird ausgelost)
     *  {op:'rematch'}                              neue Runde, sobald es einen Sieger gibt oder die Partie vorbei ist
     *  {op:'toLobby'}                              Partie abbrechen / zurück in die Lobby
     *  {op:'auto', seat, on}                       Bot übernimmt für einen abwesenden Spieler
     *  {op:'design', table, cards}                 Tisch- und Karten-Design für alle (jederzeit; fehlt ein Wert, bleibt er)
     */
    session.lobby = function (op) {
      if (role !== 'host' || !H || !op) return false;
      var seat = op.seat | 0, p = H.players[seat];
      switch (op.op) {
        case 'addBot':
          if (H.game || H.players.length >= 6) return false;
          H.players.push({ pid: 'bot-' + randId(6), name: nextBotName(), bot: true });
          break;
        case 'kick':
          if (H.game || seat <= 0 || !p) return false;
          removePlayer(seat);
          if (!p.bot) {
            H.kicked = (H.kicked || []).concat([p.pid]).slice(-12);
            deny(p.pid, 'kicked');
          }
          break;
        case 'start':
        case 'rematch':
          if (op.op === 'start' && H.game) return false;
          if (op.op === 'rematch' && !(H.game && (H.game.phase === 'over' || H.game.winner !== null))) return false;
          if (H.players.filter(function (q) { return !q.left; }).length < 2) {
            if (op.op === 'start' || !H.game) return false;
            rememberLoser();
            H.game = null;                // zu wenige übrig: zurück in die Lobby
          } else {
            if (op.op === 'rematch') rememberLoser();
            H.game = newGame();
          }
          dropLeft();
          H.players.forEach(function (q) { q.auto = false; });
          break;
        case 'toLobby':
          if (!H.game) return false;
          rememberLoser();
          H.game = null;
          dropLeft();
          H.players.forEach(function (q) { q.auto = false; });
          break;
        case 'auto':
          if (!H.game || !p || p.bot || p.local || p.left) return false;
          if (op.on && p.online) return false;   // nur für abwesende Spieler
          p.auto = !!op.on;
          break;
        case 'design':
          var cd = roomInfo();
          var nt = op.table == null ? cd.table : op.table, nc = op.cards == null ? cd.cards : op.cards;
          if (DESIGNS.table.indexOf(nt) < 0 || DESIGNS.cards.indexOf(nc) < 0) return false;
          if (nt === cd.table && nc === cd.cards) return true;
          H.design = { table: nt, cards: nc };
          break;
        default:
          return false;
      }
      bump();
      return true;
    };

    /* ---------- Mitspieler ---------- */

    function clientSend(m) { if (tr && C) { m.pid = C.pid; tr.publish('h', m); } }
    function clientFail(why) {
      var code = C.code, pid = C.pid;
      teardown();
      forget();
      C = { code: code, pid: pid, error: why, pending: [], got: false, seat: -1 };
      emit();
    }
    function clientOnMsg(ch, m) {
      if (!C || C.error && C.error !== 'not-found' || ch !== 'p/' + C.pid || !m) return;
      var wasOnline = C.hostOnline;
      C.hostSeen = Date.now();
      C.hostOnline = true;
      if (m.t === 'deny') {
        if (m.why === 'unknown' && !C.got) return;   // Antwort auf einen alten Ping – hello läuft noch
        return clientFail(typeof m.why === 'string' && m.why ? m.why : 'unknown');
      }
      if (m.t === 'state') {
        if (C.got && C.epoch === m.epoch && m.ver < C.ver) return;
        var fresh = !C.got || C.epoch !== m.epoch || C.ver !== m.ver;
        var before = C.pending.length;
        C.epoch = m.epoch; C.ver = m.ver; C.got = true; C.error = null;
        C.seat = m.seat; C.lobby = m.lobby; C.view = m.view;
        C.room = cleanRoom(m.room);
        C.round = typeof m.round === 'number' ? m.round : 0;
        C.clock = m.clock && typeof m.clock.left === 'number'
          ? { end: Date.now() + m.clock.left, total: m.clock.total, kind: m.clock.kind } : null;
        var ack = typeof m.ack === 'number' ? m.ack | 0 : 0;
        C.pending = C.pending.filter(function (x) { return x.n > ack; });
        if (C.seq < ack) C.seq = ack;
        if (fresh || before !== C.pending.length || !wasOnline) emit();
        return;
      }
      if (!wasOnline) emit();
    }
    function clientTick() {
      if (!C || !tr || C.error && C.error !== 'not-found') return;
      var now = Date.now(), changed = false;
      if (!C.got) {
        if (now >= C.nextHello) { C.nextHello = now + T.hello; clientSend({ t: 'hello', name: C.name }); }
        if (!C.error && now - C.started > T.joinTimeout) { C.error = 'not-found'; changed = true; }
      } else {
        if (now >= C.nextPing) { C.nextPing = now + T.ping; clientSend({ t: 'ping', ver: C.ver, epoch: C.epoch }); }
        if (C.pending.length && now >= C.nextResend) {
          C.nextResend = now + T.resend;
          C.pending.forEach(function (x) { clientSend({ t: 'act', n: x.n, r: x.r, a: x.a }); });
        }
        var alive = now - C.hostSeen < T.hostDead;
        if (alive !== C.hostOnline) { C.hostOnline = alive; changed = true; }
      }
      if (changed) emit();
    }
    function startClient(code, name, pid) {
      role = 'client';
      C = {
        code: code, pid: pid || randId(12), name: cleanName(name),
        epoch: null, ver: 0, got: false, seat: -1, lobby: null, view: null, error: null,
        pending: [], seq: 0, started: Date.now(), hostSeen: 0, hostOnline: false,
        nextPing: 0, nextHello: 0, nextResend: 0
      };
      openTransport(code, 'p/' + C.pid, clientOnMsg);
      save();
      emit();
    }

    /* Raum beitreten. Gibt false zurück, wenn der Code nicht 5 Zeichen hat. */
    session.join = function (code, name) {
      code = normalizeCode(code);
      if (code.length !== 5) return false;
      session.leave(true);
      startClient(code, name, null);
      return true;
    };

    /* ---------- gemeinsam ---------- */

    /* Spielaktion für den eigenen Sitz (siehe KarmaEngine.applyAction). */
    session.act = function (a) {
      if (role === 'host' && H) {
        if (!H.game) return false;
        var r = E.applyAction(H.game, 0, a);
        if (r.ok) bump();
        return r.ok;
      }
      if (role === 'client' && C && C.got) {
        var n = ++C.seq;
        var rd = C.round || 0;
        C.pending.push({ n: n, r: rd, a: a });
        C.nextResend = Date.now() + T.resend;
        clientSend({ t: 'act', n: n, r: rd, a: a });
        emit();
        return true;
      }
      return false;
    };

    /* Gespeicherte Sitzung (nach Neuladen) fortsetzen. true, wenn eine gefunden wurde. */
    session.resume = function () {
      if (!store || role) return false;
      var saved = null;
      try { saved = JSON.parse(store.getItem(STORE_KEY) || 'null'); } catch (e) { saved = null; }
      if (!saved || !saved.at || Date.now() - saved.at > MAX_AGE) { forget(); return false; }
      if (saved.role === 'host' && saved.H && saved.H.code && Array.isArray(saved.H.players)) {
        H = saved.H;
        if (!Array.isArray(H.kicked)) H.kicked = [];
        // Anwesenheit wie gespeichert übernehmen; wer wirklich weg ist, fällt nach T.playerDead heraus.
        H.players.forEach(function (p) { if (!p.bot && !p.local) p.seen = Date.now(); });
        startHost();
        return true;
      }
      if (saved.role === 'client' && saved.code && saved.pid) {
        startClient(saved.code, saved.name, saved.pid);
        return true;
      }
      forget();
      return false;
    };

    /* Raum verlassen (Host: Raum schließen). */
    session.leave = function (silent) {
      if (role === 'client' && C && tr && !C.error) clientSend({ t: 'bye' });
      if (role === 'host' && H && tr) H.players.forEach(function (p) { if (!p.bot && !p.local) deny(p.pid, 'closed'); });
      var old = tr;
      if (old) {   // kurz offen lassen, damit der Abschied noch rausgeht
        tr = null; old.onMessage = null; old.onStatus = null;
        setTimeout(function () { try { old.close(); } catch (e) {} }, 300);
      }
      teardown();
      forget();
      role = null; H = null; C = null;
      if (!silent) emit(); else session.snap = idleSnap();
    };

    /* Nach App-Wechsel / Bildschirm an: Verbindung prüfen und sofort neu abgleichen. */
    session.wake = function () {
      if (tr) tr.kick();
      if (role === 'client' && C) { C.nextPing = 0; C.nextHello = 0; C.nextResend = 0; clientTick(); }
    };

    /* Laufendes Zeitlimit auf der eigenen Uhr: {end (ms), total (ms), kind: 'turn'|'swap'|'start'} oder null. */
    session.clock = function () {
      if (role === 'host') return clock && clock.end ? { end: clock.end, total: clock.total, kind: clock.kind } : null;
      if (role === 'client' && C && C.got) return C.clock || null;
      return null;
    };

    /* Diagnose: Zustand der Relay-Verbindungen (falls der Transport das anbietet). */
    session.debug = function () { return tr && tr._brokers ? tr._brokers() : null; };

    return session;
  }

  return {
    createSession: createSession, transports: transports, memBus: memBus, T: T,
    normalizeCode: normalizeCode, cleanName: cleanName, randId: randId,
    CODE_ALPHA: CODE_ALPHA, STORE_KEY: STORE_KEY, DESIGNS: DESIGNS
  };
});
