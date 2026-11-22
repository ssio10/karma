/* Karma – Oberfläche.
 * Der Zustand kommt als Snapshot aus KarmaNet (siehe net.js). Rendern ist idempotent:
 * derselbe Snapshot darf mehrfach ankommen. Animationen laufen nur, wenn view.seq um genau 1 gestiegen ist.
 */
(function () {
  'use strict';
  var E = window.KarmaEngine, N = window.KarmaNet, doc = document, body = doc.body;

  function $(id) { return doc.getElementById(id); }
  function el(tag, cls, txt) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function drop(n) { if (n && n.parentNode) n.parentNode.removeChild(n); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rectOf(n) { var r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function svgUse(id) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#' + id + '"/></svg>'; }

  if (!E || !N) {
    var se = $('startErr');
    se.hidden = false;
    se.textContent = 'Das Spiel konnte nicht geladen werden. Bitte lade die Seite neu.';
    return;
  }

  /* ---------- Karten ---------- */

  var RANK_LABEL = { 11: 'B', 12: 'D', 13: 'K', 14: 'A' };
  var RANK_NAME = { 11: 'Bube', 12: 'Dame', 13: 'König', 14: 'Ass' };
  var SUIT_NAME = { S: 'Pik', H: 'Herz', D: 'Karo', C: 'Kreuz' };
  var SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3, J: 4 };
  function rankName(r) { return RANK_NAME[r] || String(r); }
  function sortCards(a) {
    return a.slice().sort(function (x, y) {
      return E.rank(x) - E.rank(y) || SUIT_ORDER[E.suit(x)] - SUIT_ORDER[E.suit(y)];
    });
  }
  function cardFace(id, extra) {
    var d = el('div', 'card' + (extra ? ' ' + extra : ''));
    d.setAttribute('data-card', id);
    if (E.isJoker(id)) {
      d.className += ' jk' + (id === E.JR ? ' red' : '');
      d.innerHTML = '<div class="ci">' + svgUse('s-J') + '<span class="jt">JOKER</span></div><div class="big">' + svgUse('s-J') + '</div>';
      d.setAttribute('aria-label', id === E.JR ? 'Roter Joker' : 'Schwarzer Joker');
    } else {
      var s = E.suit(id), r = E.rank(id);
      if (s === 'H' || s === 'D') d.className += ' red';
      d.innerHTML = '<div class="ci"><span class="rk' + (r === 10 ? ' ten' : '') + '">' + (RANK_LABEL[r] || r) + '</span>' + svgUse('s-' + s) + '</div><div class="big">' + svgUse('s-' + s) + '</div>';
      d.setAttribute('aria-label', SUIT_NAME[s] + ' ' + rankName(r));
    }
    return d;
  }
  function cardBack(extra) { return el('div', 'card back' + (extra ? ' ' + extra : '')); }

  /* ---------- Speicher ---------- */

  function storeOf(name) {
    try { var s = window[name]; if (!s) return null; s.getItem('karma.probe'); return s; } catch (e) { return null; }
  }
  var SS = storeOf('sessionStorage'), LS = storeOf('localStorage');
  function sGet(st, k) { try { return st ? st.getItem(k) : null; } catch (e) { return null; } }
  function sSet(st, k, v) { try { if (st) st.setItem(k, v); } catch (e) {} }
  function sDel(st, k) { try { if (st) st.removeItem(k); } catch (e) {} }
  /* Tab-eigener Speicher zuerst: zwei Tabs im selben Browser können so zwei verschiedene Spieler sein. */
  var storage = {
    getItem: function (k) { var v = sGet(SS, k); return v != null ? v : sGet(LS, k); },
    setItem: function (k, v) { sSet(SS, k, v); sSet(LS, k, v); },
    removeItem: function (k) { sDel(SS, k); sDel(LS, k); }
  };
  var NAME_KEY = 'karma.name';

  /* ---------- Zustand ---------- */

  var netKind = /(^|&)net=bc(&|$)/.test(location.search.replace(/^\?/, '')) ? 'bc' : 'mqtt';
  var soloOnly = false;
  if (typeof N.transports[netKind] !== 'function' || (netKind === 'bc' && typeof BroadcastChannel === 'undefined')) {
    /* Fehlt das Verbindungsmodul (mqtt.js nicht geladen), bleibt das Spiel benutzbar:
     * ein Raum nur auf diesem Gerät, gegen Bots. Der Transport verschickt dann schlicht nichts. */
    N.transports.solo = function () {
      var t = { onMessage: null, onStatus: null }, open = false;
      t.start = function () { open = true; setTimeout(function () { if (open && t.onStatus) t.onStatus(true); }, 0); };
      t.subscribe = function () {};
      t.publish = function () {};
      t.kick = function () {};
      t.close = function () { open = false; };
      return t;
    };
    netKind = 'solo';
    soloOnly = true;
  }
  var session = null;
  var cur = null;                 // zuletzt verarbeiteter Snapshot
  var queue = [], pumping = false, pumpQueued = false, snapCount = 0;
  var sel = [];                   // gewählte Karten (eigener Zug)
  var opt = null;                 // gesendete, noch unbestätigte Aktion {kind, seq, after, cards|slot}
  var giving = null;              // „Aufgeben“ ist gesendet und noch nicht beantwortet {after}
  var optFly = null;              // läuft noch: Flug der eigenen Karten zum Stapel
  var ov = null;                  // Anzeige-Zwischenstand während einer Animation {pile, holdSeat, holdN, req, burned, stock, drawSeat, drawN, hide}
  var won = null, wonTimer = 0, wonTurnTimer = 0;   // Sieger-Hinweis, solange die Runde weiterläuft {seat, at}
  var overAt = 0, overTimer = 0;  // wann die Rangliste erschienen ist (Schutz vor versehentlichem Tippen)
  var lock = false, afterLock = null;
  var handNodes = {}, handOrder = [], pileNodes = {};
  var swapSel = null, swapPrev = null;
  /* Spielhilfe (pro Gerät): Hinweis am Stapel, welche Karten passen, und unpassende Karten abgedunkelt. */
  var help = sGet(LS, 'karma.help') !== '0';
  var press = null, drag = null, dragDone = null;
  var cwCache = 0;
  var hashOwned = false;

  /* ---------- Hinweise ---------- */

  var toastTimer = 0, gToastTimer = 0;
  /* text: eine Zeile oder mehrere (Array) */
  function showToast(node, text, cls, ms) {
    node.className = cls;
    clear(node);
    var box = el('span'), lines = Array.isArray(text) ? text : [text];
    lines.forEach(function (t, i) { box.appendChild(el('i', i ? 'more' : null, t)); });
    node.appendChild(box);
    void node.offsetWidth;
    node.classList.add('show');
    return setTimeout(function () { node.classList.remove('show'); }, ms);
  }
  function toast(text) { clearTimeout(toastTimer); toastTimer = showToast($('toast'), text, 'toast', 2600); }
  function gToast(text, bad, ms) {
    var node = $('gToast');
    clearTimeout(gToastTimer);
    gToastTimer = showToast(node, text, 'g-toast' + (bad ? ' bad' : ''), ms || 1400);
    /* Die Meldung steht normalerweise im freien Raum unter der Anforderung. Fehlt der Platz
     * (sehr niedrige Bildschirme), rückt sie an den oberen Rand des Tischs, über den Ablagestapel –
     * Stapel und Anforderung bleiben so frei. Nur wenn auch dort kein Platz ist, steht sie direkt
     * über der Anforderung; verdecken darf sie die nie. */
    try {
      var tb = $('table').getBoundingClientRect(), rq = $('req').getBoundingClientRect(), pl = $('pileTap').getBoundingClientRect(), h = node.offsetHeight;
      var top = false, bottom = 4;
      if (tb.bottom - rq.bottom < h + 8) {
        if (pl.top - tb.top >= h + 8) top = true;
        else bottom = Math.round(tb.bottom - rq.top + 4);
      }
      node.style.top = top ? '4px' : '';
      node.style.bottom = top ? 'auto' : bottom + 'px';
    } catch (e) {}
  }
  function shake(node) {
    if (!node) return;
    node.classList.remove('shake');
    void node.offsetWidth;
    node.classList.add('shake');
    setTimeout(function () { node.classList.remove('shake'); }, 400);
  }
  function flashReq() {
    var c = $('req');
    c.classList.remove('flash');
    void c.offsetWidth;
    c.classList.add('flash');
  }

  /* ---------- Sheets ---------- */

  var openSheetId = null, cfCb = null, cfTag = '';
  function openSheet(id) {
    closeSheet();
    openSheetId = id;
    $(id).classList.add('open');
    if (id === 'sheetMenu') renderMenu();
  }
  function closeSheet() {
    if (openSheetId) $(openSheetId).classList.remove('open');
    openSheetId = null;
  }
  /* tag: Kennung, über die sich die Rückfrage wieder schließen lässt, wenn sie sich erledigt hat */
  function confirmBox(title, text, yes, cb, danger, tag) {
    cfTag = tag || '';
    $('cfTitle').textContent = title;
    $('cfText').textContent = text || '';
    var y = $('cfYes');
    y.textContent = yes;
    y.className = 'btn' + (danger ? ' danger' : '');
    cfCb = cb;
    $('confirm').classList.add('open');
  }
  function closeConfirm() { $('confirm').classList.remove('open'); cfCb = null; cfTag = ''; }

  /* ---------- Start ---------- */

  function startError(msg) {
    var e = $('startErr');
    e.hidden = !msg;
    e.textContent = msg || '';
  }
  var SOLO_NOTE = 'Online-Spiel ist gerade nicht verfügbar. Du kannst trotzdem einen Raum erstellen und gegen Bots spielen. Lade die Seite neu, um es online nochmal zu versuchen.';
  function getName() {
    var inp = $('inName'), n = inp.value.replace(/\s+/g, ' ').trim();
    if (!n) { shake(inp); try { inp.focus(); } catch (e) {} toast('Bitte gib erst deinen Namen ein.'); return null; }
    sSet(LS, NAME_KEY, n);
    return n;
  }
  function hashCode() {
    var m = /[#&]r=([^&]+)/.exec(location.hash || '');
    var c = m ? N.normalizeCode(decodeURIComponent(m[1])) : '';
    return c.length === 5 ? c : '';
  }
  function syncJoinUi() {
    var code = N.normalizeCode($('inCode').value), full = code.length === 5, link = full && code === hashCode();
    $('btnJoin').className = 'btn' + (full ? '' : ' sec');
    $('btnResume').className = 'btn' + (full ? ' sec' : '');
    $('btnJoin').textContent = link ? 'Raum ' + code + ' beitreten' : 'Beitreten';
    $('btnCreate').className = 'btn' + (full || !$('btnResume').hidden ? ' sec' : '');
    doc.querySelector('.join-row').style.flexDirection = link ? 'column' : '';
  }
  function savedSession(st) {
    var o = null;
    try { o = JSON.parse(sGet(st, N.STORE_KEY) || 'null'); } catch (e) { o = null; }
    if (!o || !o.at || Date.now() - o.at > 12 * 3600 * 1000) return null;
    return o;
  }
  function doCreate() {
    var n = getName();
    if (!n) return;
    try { session.host(n); } catch (e) { console.error(e); startError('Der Raum konnte nicht erstellt werden. Bitte versuche es nochmal.'); }
  }
  function doJoin() {
    if (soloOnly) { toast('Beitreten geht nur mit Online-Verbindung.'); return; }
    var code = N.normalizeCode($('inCode').value);
    if (code.length !== 5) { shake($('inCode')); toast('Der Raumcode hat 5 Zeichen.'); return; }
    var n = getName();
    if (!n) return;
    try { session.join(code, n); } catch (e) { console.error(e); startError('Beitreten hat nicht geklappt. Bitte versuche es nochmal.'); }
  }
  function doResume() {
    var ok = false;
    try { ok = session.resume(); } catch (e) { console.error(e); }
    if (!ok) { $('btnResume').hidden = true; syncJoinUi(); toast('Das letzte Spiel ist nicht mehr verfügbar.'); }
  }

  /* ---------- Rahmen: Banner, Wake Lock, Adresse ---------- */

  var bannerTimer = 0, bannerMsg = '';
  function syncBanner(s) {
    var msg = '';
    if (s.stage === 'lobby' || s.stage === 'game') {
      if (s.conn !== 'online') msg = 'Verbindung wird wiederhergestellt …';
      else if (!s.isHost && !s.hostOnline) msg = 'Host ist nicht erreichbar – warte …';
    }
    if (msg === bannerMsg) return;
    bannerMsg = msg;
    clearTimeout(bannerTimer);
    var b = $('net');
    if (!msg) { b.classList.remove('show'); body.classList.remove('net-warn'); return; }
    bannerTimer = setTimeout(function () {
      b.textContent = bannerMsg;
      b.classList.add('show');
      body.classList.add('net-warn');
    }, b.classList.contains('show') ? 0 : 1200);
  }
  var wl = null, wlBusy = false;
  function syncWakeLock() {
    var want = !!(cur && cur.stage === 'game' && doc.visibilityState === 'visible');
    if (want && !wl && !wlBusy && navigator.wakeLock && navigator.wakeLock.request) {
      wlBusy = true;
      try {
        navigator.wakeLock.request('screen').then(function (l) {
          wlBusy = false;
          wl = l;
          l.addEventListener('release', function () { if (wl === l) wl = null; });
          syncWakeLock();
        }, function () { wlBusy = false; });
      } catch (e) { wlBusy = false; }
    } else if (!want && wl) {
      var old = wl;
      wl = null;
      try { old.release().catch(function () {}); } catch (e) {}
    }
  }
  function syncHash(s) {
    try {
      var base = location.pathname + location.search;
      if (s.code && (s.stage === 'lobby' || s.stage === 'game')) {
        var want = '#r=' + s.code;
        if (location.hash !== want) history.replaceState(null, '', base + want);
        hashOwned = true;
      } else if (s.stage === 'idle' && hashOwned) {
        hashOwned = false;
        history.replaceState(null, '', base);
        syncJoinUi();
      }
    } catch (e) {}
  }
  function syncChrome(s) {
    body.classList.toggle('is-host', !!s.isHost);
    syncBanner(s);
    syncHash(s);
    syncWakeLock();
  }
  function shareLink() {
    if (!cur || !cur.code) return;
    var url = location.origin + location.pathname + location.search + '#r=' + cur.code;
    function showLink() { $('linkOut').value = url; openSheet('sheetLink'); }
    function copy() {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { toast('Link kopiert'); }, showLink);
      } else showLink();
    }
    if (navigator.share) {
      try {
        navigator.share({ title: 'Karma', text: 'Spiel mit mir Karma – Raum ' + cur.code, url: url }).catch(function (e) {
          if (!e || e.name !== 'AbortError') copy();
        });
        return;
      } catch (e) { /* weiter mit Kopieren */ }
    }
    copy();
  }

  /* ---------- Rendern: Bildschirmwahl ---------- */

  function screenFor(s) {
    if (!s || s.stage === 'idle') return 'start';
    if (s.stage === 'connecting' || s.stage === 'error') return 'connect';
    if (s.stage === 'lobby' || !s.view) return 'lobby';
    return s.view.phase === 'swap' ? 'swap' : 'game';
  }
  function renderAll() {
    var s = cur, scr = screenFor(s), was = body.getAttribute('data-screen');
    if (was !== scr) {
      body.setAttribute('data-screen', scr);
      if (scr === 'start' || scr === 'connect') { closeSheet(); closeConfirm(); }
      if (scr !== 'game') clear($('fx'));
      cwCache = 0;
    }
    if (scr === 'start') renderStart();
    else if (scr === 'connect') renderConnect();
    else if (scr === 'lobby') renderLobby();
    else if (scr === 'swap') renderSwap();
    else renderGame();
    if (openSheetId === 'sheetMenu') renderMenu();
    syncGiveUp();
  }
  function renderStart() {
    var only = !sGet(SS, N.STORE_KEY) && savedSession(LS);
    /* Ohne Online-Verbindung lässt sich nur ein eigener Raum (gegen Bots) fortsetzen. */
    if (only && soloOnly && only.role !== 'host') only = null;
    $('btnResume').hidden = !only;
    syncJoinUi();
  }
  var ERR_TEXT = {
    full: ['Raum ist voll', 'In diesem Raum sitzen schon 6 Spieler.'],
    running: ['Spiel läuft bereits', 'Du kannst dazukommen, sobald der Host wieder in der Lobby ist.'],
    kicked: ['Du wurdest entfernt', 'Der Host hat dich aus dem Raum genommen.'],
    closed: ['Raum geschlossen', 'Der Host hat den Raum beendet.'],
    unknown: ['Sitzung abgelaufen', 'Der Raum kennt dich nicht mehr. Tritt einfach neu bei.']
  };
  function renderConnect() {
    var s = cur, t = $('conTitle'), m = $('conMsg'), sp = $('conSpin'), back = $('btnConBack');
    if (s.stage === 'error') {
      var e = ERR_TEXT[s.error] || ERR_TEXT.unknown;
      t.textContent = e[0];
      m.textContent = e[1];
      sp.classList.add('off');
      back.className = 'btn';
      back.textContent = 'Zur Startseite';
    } else if (s.error === 'not-found') {
      t.textContent = 'Raum antwortet nicht';
      m.textContent = 'Der Host muss die Seite geöffnet haben. Ich versuche es weiter … (Raum ' + s.code + ')';
      sp.classList.remove('off');
      back.className = 'btn sec';
      back.textContent = 'Abbrechen';
    } else {
      t.textContent = 'Verbinde …';
      m.textContent = s.code ? 'Raum ' + s.code : '';
      sp.classList.remove('off');
      back.className = 'btn sec';
      back.textContent = 'Abbrechen';
    }
  }

  /* ---------- Lobby ---------- */

  /* o: {you, place (0 = noch im Spiel), game (läuft eine Partie?), starts (beginnt die nächste Runde), lost (Verlierer der Runde)} */
  function playerRow(p, seat, o) {
    var gone = !!p.left, off = gone || p.online === false;
    var row = el('div', 'prow' + (off ? ' off' : '') + (gone ? ' gone' : ''));
    var main = el('div', 'prow-main');
    main.appendChild(el('span', 'dot'));
    var mid = el('span', 'pmain'), nm = el('span', 'pname');
    nm.appendChild(el('span', null, p.name));
    if (o.you) nm.appendChild(el('span', 'badge gold', 'Du'));
    if (seat === 0) nm.appendChild(el('span', 'badge', 'Host'));
    if (p.bot) nm.appendChild(el('span', 'badge', 'Bot'));
    if (p.auto && !gone) nm.appendChild(el('span', 'badge', 'Bot spielt'));
    if (o.place) nm.appendChild(el('span', 'badge gold', 'Platz ' + o.place));
    if (o.lost) nm.appendChild(el('span', 'badge red', 'Verlierer'));
    if (o.starts) nm.appendChild(el('span', 'badge gold', 'beginnt'));
    mid.appendChild(nm);
    if (gone) mid.appendChild(el('span', 'psub grey', o.game ? 'hat verlassen – Bot spielt' : 'hat verlassen'));
    else if (off) mid.appendChild(el('span', 'psub grey', 'offline'));
    main.appendChild(mid);
    row.appendChild(main);
    return row;
  }
  function renderLobby() {
    var s = cur, lob = s.lobby;
    if (!lob) return;
    $('lobbyCode').textContent = s.code || '';
    var list = $('lobbyList'), n = lob.players.length;
    clear(list);
    /* Der Verlierer der letzten Runde beginnt die nächste; sonst wird ausgelost. */
    var st = typeof lob.starter === 'number' && lob.players[lob.starter] ? lob.starter : -1;
    var who = st < 0 ? 'Wer beginnt, wird ausgelost.'
      : st === s.seat ? 'Du hast die letzte Runde verloren und beginnst.'
        : lob.players[st].name + ' hat die letzte Runde verloren und beginnt.';
    lob.players.forEach(function (p, i) {
      var row = playerRow(p, i, { you: i === s.seat, starts: i === st });
      if (s.isHost && i > 0) {
        var x = el('button', 'icon-btn');
        x.innerHTML = svgUse('i-x');
        x.setAttribute('data-kick', i);
        x.setAttribute('aria-label', p.name + ' entfernen');
        row.appendChild(x);
      }
      list.appendChild(row);
    });
    var hint;
    if (soloOnly) hint = 'Ohne Online-Verbindung: Füge Bots hinzu. ' + who;
    else if (!s.isHost) hint = who + ' Der Host startet das Spiel.';
    else if (n < 2) hint = 'Teile den Code oder Link – oder füge Bots hinzu. ' + who;
    else hint = who;
    $('lobbyHint').textContent = hint;
    $('btnShare').hidden = soloOnly;
    $('btnAddBot').disabled = n >= 6;
    $('btnStart').disabled = n < 2;
    $('btnStart').textContent = n < 2 ? 'Mindestens 2 Spieler' : 'Spiel starten (' + n + ' Spieler)';
  }

  /* ---------- Tauschphase ---------- */

  function myPlayer() { return cur.view.players[cur.view.you]; }
  function swapEditable() {
    return !!(cur && cur.stage === 'game' && cur.view && cur.view.phase === 'swap' && !myPlayer().ready && !(opt && opt.kind === 'ready'));
  }
  function swapShown() {
    var p = myPlayer(), hand = p.hand.slice(), up = p.up.slice(), moved = {};
    if (swapPrev && !p.ready) {
      var hi = hand.indexOf(swapPrev.hand), sl = swapPrev.up;
      if (hi >= 0 && up[sl]) {
        moved[hand[hi]] = 1; moved[up[sl]] = 1;
        var t = hand[hi]; hand[hi] = up[sl]; up[sl] = t;
      } else swapPrev = null;
    }
    return { hand: hand, up: up, moved: moved };
  }
  function renderSwap() {
    var v = cur.view, p = myPlayer(), d = swapShown(), edit = swapEditable();
    var rows = [[$('swUp'), d.up, 'up'], [$('swHand'), d.hand, 'hand']];
    rows.forEach(function (r) {
      clear(r[0]);
      r[0].className = 'sw-row' + (edit ? '' : ' locked');
      r[1].forEach(function (id) {
        if (!id) return;
        var c = cardFace(id);
        c.setAttribute('data-zone', r[2]);
        if (id === swapSel && edit) c.classList.add('sel');
        if (d.moved[id]) c.classList.add('swapped');
        r[0].appendChild(c);
      });
    });
    var hint;
    if (opt && (opt.kind === 'ready' || opt.kind === 'unready')) hint = 'Wird gesendet …';
    else if (p.ready) hint = (v.allReady ? 'Alle sind bereit, gleich geht es los.' : 'Du bist bereit. Warte auf die anderen …') + ' Mit „Zurück“ kannst du noch einmal tauschen.';
    else if (swapPrev) hint = 'Getauscht! Passt das so? Dann tippe auf „Bereit“.';
    else if (swapSel) hint = 'Jetzt die Karte antippen, mit der du tauschen willst.';
    else hint = 'Du darfst genau eine Handkarte mit einer offenen Karte tauschen. Antippen oder ziehen.';
    $('swHint').textContent = hint;
    $('btnUndo').disabled = !(edit && swapPrev);
    var back = p.ready && !(opt && opt.kind === 'ready');
    $('btnReady').disabled = back ? !!opt : !edit;
    $('btnReady').textContent = back ? 'Zurück' : 'Bereit';
    $('btnReady').className = back ? 'btn sec' : 'btn';
    tickClock();
    var chips = $('swReady');
    clear(chips);
    v.players.forEach(function (q, i) {
      var c = el('span', 'pchip' + (q.ready ? ' ok' : ''));
      if (q.ready) c.innerHTML = svgUse('i-check'); else c.appendChild(el('i', null, '…'));
      c.appendChild(el('span', null, i === v.you ? 'Du' : q.name));
      chips.appendChild(c);
    });
    $('swStart').textContent = startText(v);
  }
  /* Die erste Runde beginnt ein ausgeloster Spieler, danach der Verlierer der Runde davor. */
  function startText(v) {
    var mine = v.startSeat === v.you, name = nameOf(v, v.startSeat);
    if (v.startBy === 'loser') return mine ? 'Du hast die letzte Runde verloren und beginnst.' : name + ' hat die letzte Runde verloren und beginnt.';
    return mine ? 'Ausgelost: Du beginnst.' : 'Ausgelost: ' + name + ' beginnt.';
  }
  function origZone(id) { return myPlayer().hand.indexOf(id) >= 0 ? 'hand' : 'up'; }
  /* Zwei angezeigte Karten aus verschiedenen Reihen sollen die Plätze tauschen – erlaubt ist insgesamt nur ein Tausch. */
  function setSwap(a, b) {
    var p = myPlayer(), X = swapPrev ? swapPrev.hand : null, s0 = swapPrev ? swapPrev.up : -1, Y = swapPrev ? p.up[s0] : null;
    var za = origZone(a), zb = origZone(b), next = null;
    if (swapPrev && ((a === X && b === Y) || (a === Y && b === X))) next = null;
    else if (za !== zb) next = { hand: za === 'hand' ? a : b, up: p.up.indexOf(za === 'hand' ? b : a) };
    else if (za === 'hand' && swapPrev) next = { hand: a === X ? b : a, up: s0 };
    swapPrev = next;
    swapSel = null;
    renderSwap();
  }
  function shownZone(id) {
    var n = $('swap').querySelector('.card[data-card="' + id + '"]');
    return n ? n.getAttribute('data-zone') : null;
  }
  function swapTap(id) {
    if (!swapEditable()) return;
    if (!swapSel || shownZone(swapSel) == null) swapSel = id;
    else if (swapSel === id) swapSel = null;
    else if (shownZone(swapSel) === shownZone(id)) swapSel = id;
    else return setSwap(swapSel, id);
    renderSwap();
  }
  function doReady() {
    if (!swapEditable()) return;
    var a = { t: 'ready' };
    if (swapPrev) a.swap = { hand: swapPrev.hand, up: swapPrev.up };
    opt = { kind: 'ready', seq: cur.view.seq, after: snapCount };
    swapSel = null;
    renderSwap();
    if (!session.act(a)) { opt = null; renderSwap(); }
  }
  /* „Bereit“ zurücknehmen: geht, bis die Runde läuft. Der Tausch ist dann wieder offen. */
  function doUnready() {
    if (!cur || cur.stage !== 'game' || !cur.view || cur.view.phase !== 'swap' || !myPlayer().ready || opt) return;
    opt = { kind: 'unready', seq: cur.view.seq, after: snapCount };
    renderSwap();
    if (!session.act({ t: 'unready' })) { opt = null; renderSwap(); }
  }
  function readyButton() {
    if (cur && cur.stage === 'game' && cur.view && cur.view.phase === 'swap' && myPlayer().ready) doUnready(); else doReady();
  }

  /* ---------- Spieltisch: Anzeigezustand ---------- */

  function display() {
    var v = cur.view, me = v.you, p = v.players[me], hide = {};
    var pile = ov ? ov.pile : v.pile;
    if (ov && ov.holdSeat === me) ov.pile.forEach(function (c) { hide[c] = 1; });
    if (ov && ov.hide) ov.hide.forEach(function (c) { hide[c] = 1; });
    var o = opt && opt.kind !== 'ready' && opt.kind !== 'unready' && opt.seq === v.seq ? opt : null;
    if (o && o.kind === 'play') {
      pile = pile.concat(o.cards);
      o.cards.forEach(function (c) { hide[c] = 1; });
    }
    return {
      v: v, me: me, p: p, pile: pile, opt: o,
      stock: ov && ov.stock != null ? ov.stock : v.stock,
      hand: sortCards(p.hand.filter(function (c) { return !hide[c]; })),
      up: p.up.map(function (c) { return c && !hide[c] ? c : null; }),
      my: v.phase === 'play' && v.turn === me && v.my && !o ? v.my : null
    };
  }
  var STATES = ['ok', 'no', 'sel', 'match'];
  function cardState(d, id) {
    if (sel.indexOf(id) >= 0) return 'sel';
    if (d.my.playable.indexOf(id) < 0) return help ? 'no' : 'ok';   // ohne Spielhilfe sehen alle Karten gleich aus
    if (d.my.zone === 'hand' && sel.length && E.rank(sel[0]) === E.rank(id)) return 'match';   // mehrere gleiche nur aus der Hand
    return 'ok';
  }
  function setState(node, st) {
    for (var i = 0; i < STATES.length; i++) node.classList.toggle(STATES[i], STATES[i] === st);
  }
  /* Was jetzt passt – nur zur Anzeige. Ob eine Karte wirklich geht, sagt allein die Engine (view.my.playable).
   * Die Sonderkarten 2, 7, 10 und Joker gehen immer – sie werden immer alle genannt. */
  var ALWAYS = ' · immer: 2, 7, 10, Joker';
  function reqText(req) {
    switch (req.k) {
      case 'min': return (req.rank >= 14 ? 'Ass' : rankName(req.rank) + ' oder höher') + ALWAYS;
      case 'seven': return 'Unter 7 (3 bis 6)' + ALWAYS;
      case 'jokerB': return 'Schwarzer Joker: aufnehmen oder mit Rot kontern';
      case 'jokerR': return 'Roter Joker: aufnehmen';
      default: return 'Beliebige Karte';
    }
  }
  function nameOf(v, seat) { return v.players[seat] ? v.players[seat].name : '?'; }
  function cardsLeft(p) { return p.n + p.up.filter(Boolean).length + p.down.filter(Boolean).length; }
  function countText(n) { return n === 1 ? '1 Karte' : n + ' Karten'; }

  /* ---------- Spieltisch: Rendern ---------- */

  function renderGame() {
    var d = display();
    renderTop(d);
    renderOpps(d);
    renderCenter(d);
    renderMineWith(d);
    renderWon(d);
    renderOver(d);
  }
  function renderMine() { renderMineWith(display()); }
  function renderMineWith(d) {
    var done = d.p.place > 0;
    $('mine').classList.toggle('done', done);
    if (done) renderDone(d);
    renderMyTable(d);
    renderHand(d);
    renderActions(d);
    $('center').classList.toggle('can', !!(d.my && sel.length));
  }
  /* Du hast keine Karten mehr und schaust zu. */
  function renderDone(d) {
    var running = d.v.phase === 'play';
    $('doneTitle').textContent = 'Du bist fertig – Platz ' + d.p.place;
    $('doneText').textContent = !running ? '' : cur.isHost
      ? 'Du schaust jetzt zu, bis die Runde zu Ende ist – oder startest gleich eine neue.'
      : 'Du schaust jetzt zu, bis die Runde zu Ende ist. Der Host kann auch gleich eine neue starten.';
    $('btnDoneRematch').hidden = !running;
  }
  function renderTop(d) {
    var v = d.v, t = $('turn'), x = $('turnText');
    if (v.phase === 'over') { t.className = 'tbar'; x.textContent = 'Runde beendet'; }
    else if (v.turn === d.me) { t.className = 'tbar me'; x.textContent = 'Du bist dran'; }
    else { t.className = 'tbar'; x.textContent = nameOf(v, v.turn) + ' ist dran'; }
    tickClock();
  }

  /* ---------- Zeitlimit: Anzeige ---------- */

  /* Die Uhr führt der Host; session.clock() gibt das Ende auf der eigenen Uhr. Viermal pro Sekunde nachgeführt. */
  function tickClock() {
    var v = cur && cur.stage === 'game' ? cur.view : null, c = v && session.clock ? session.clock() : null;
    var left = c ? c.end - Date.now() : 0, secs = Math.max(0, Math.ceil(left / 1000));
    var turn = !!c && c.kind === 'turn' && v.phase === 'play';
    var t = $('turn'), sec = $('turnSec'), bar = $('turnBar');
    sec.hidden = bar.hidden = !turn;
    if (turn) {
      if (sec.textContent !== String(secs)) sec.textContent = String(secs);
      bar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, left / c.total)).toFixed(3) + ')';
    }
    t.classList.toggle('low', turn && secs <= 10);
    var txt = '', go = false;
    if (c && v.phase === 'swap') {
      go = c.kind === 'start';
      txt = go ? 'Alle bereit – los geht’s in ' + Math.max(1, secs) + ' …'
        : c.kind === 'swap' ? 'Noch ' + secs + (secs === 1 ? ' Sekunde' : ' Sekunden') + ' zum Tauschen' : '';
    }
    var sw = $('swClock');
    if (sw.textContent !== txt) sw.textContent = txt;
    sw.className = 'sw-clock' + (go ? ' go' : c && c.kind === 'swap' && secs <= 10 ? ' low' : '');
  }
  setInterval(tickClock, 250);
  function oppPanel(d, seat) {
    var v = d.v, p = v.players[seat], info = cur.lobby && cur.lobby.players[seat] || {};
    var box = el('div', 'opp');
    box.setAttribute('data-seat', seat);
    if (v.phase === 'play' && v.turn === seat) box.classList.add('turn');
    var head = el('div', 'opp-head');
    head.appendChild(el('span', 'opp-name', p.name));
    box.appendChild(head);
    if (p.place) {
      /* fertig: bleibt am Tisch sitzen, mit Platz, und wird übersprungen */
      box.classList.add('done');
      if (p.place === 1) box.classList.add('first');
      var dn = el('div', 'opp-done');
      dn.appendChild(el('small', null, 'fertig'));
      dn.appendChild(el('b', null, 'Platz ' + p.place));
      box.appendChild(dn);
      box.setAttribute('aria-label', p.name + ': fertig, Platz ' + p.place);
      return box;
    }
    var off = !p.bot && (info.online === false || !!info.left);
    if (off) box.classList.add('off');
    var n = p.n - (ov && ov.holdSeat === seat ? (ov.holdN != null ? ov.holdN : ov.pile.length) : 0) - (ov && ov.drawSeat === seat ? ov.drawN : 0);
    if (n < 0) n = 0;
    var hb = el('span', 'opp-hand' + (n ? '' : ' zero'));
    hb.appendChild(cardBack());
    hb.appendChild(el('span', null, String(n)));
    hb.setAttribute('aria-label', n + ' Handkarten');
    head.appendChild(hb);
    var row = el('div', 'opp-row');
    for (var i = 0; i < 3; i++) {
      var slot = el('div', 'slot');
      if (p.down[i]) { var b = cardBack('mini dn'); b.setAttribute('data-down', i); slot.appendChild(b); }
      if (p.up[i]) slot.appendChild(cardFace(p.up[i], 'mini up'));
      row.appendChild(slot);
    }
    box.appendChild(row);
    if (info.left) box.appendChild(el('span', 'opp-tag auto gone', 'hat verlassen – Bot spielt'));
    else if (info.auto) box.appendChild(el('span', 'opp-tag auto', 'Bot spielt'));
    else if (off) box.appendChild(el('span', 'opp-tag', cur.isHost ? 'offline – tippen' : 'offline'));
    return box;
  }
  function renderOpps(d) {
    var n = d.v.players.length, k = n - 1, top = $('oppTop'), L = $('oppL'), R = $('oppR');
    clear(top); clear(L); clear(R);
    for (var i = 0; i < k; i++) {
      var seat = (d.me + 1 + i) % n, box = top;
      /* im Uhrzeigersinn: der nächste Spieler sitzt links von dir, dann oben herum nach rechts */
      if (k >= 3) { if (i === 0) box = L; else if (i === k - 1) box = R; }
      box.appendChild(oppPanel(d, seat));
    }
  }
  function pileTf(id, idx) {
    var s = id + ':' + idx, h = 7;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    var rot = (h % 25) - 12, x = ((h >>> 5) % 17) - 8, y = ((h >>> 10) % 11) - 5;
    return 'translate3d(' + x + '%,' + y + '%,0) rotate(' + rot + 'deg)';
  }
  function renderPile(pile) {
    var box = $('pile'), from = Math.max(0, pile.length - 6), keep = {}, pos = 0;
    for (var i = from; i < pile.length; i++) {
      var id = pile[i], node = pileNodes[id];
      /* Die Lage wird nur beim Hinlegen bestimmt: Bleibt ein Joker allein zurück, während der Rest
       * aufgenommen wird, darf er nicht verrutschen. */
      if (!node) { node = cardFace(id); pileNodes[id] = node; node.style.transform = pileTf(id, i); }
      keep[id] = 1;
      if (box.children[pos] !== node) box.insertBefore(node, box.children[pos] || null);
      pos++;
    }
    for (var k in pileNodes) if (!keep[k]) { drop(pileNodes[k]); delete pileNodes[k]; }
    box.classList.toggle('empty', !pile.length);
    $('pileCount').textContent = pile.length > 1 ? String(pile.length) : '';
  }
  function renderStock(n) {
    var box = $('stock'), cards = $('stockCards'), want = n <= 0 ? 0 : n === 1 ? 1 : n <= 6 ? 2 : 3;
    while (cards.children.length > want) cards.removeChild(cards.lastChild);
    while (cards.children.length < want) cards.appendChild(cardBack());
    box.classList.toggle('empty', n <= 0);
    $('stockCount').textContent = n > 0 ? String(n) : '';
    box.setAttribute('aria-label', n > 0 ? 'Nachziehstapel: ' + countText(n) : 'Nachziehstapel leer');
  }
  function renderCenter(d) {
    var v = d.v, chip = $('req'), ring = $('ring'), n = v.players.length;
    var req = ov && ov.req ? ov.req : v.req;   // während einer Animation gilt noch die alte Anforderung
    renderPile(d.pile);
    renderStock(d.stock);
    var ended = v.phase === 'over' && !ov;
    chip.textContent = ended ? 'Runde beendet' : reqText(req);
    chip.className = 'chip' + (ended ? '' : req.k === 'jokerR' ? ' warn' : req.k === 'jokerB' ? ' dark' : '') + (!help && !ended ? ' off' : '');
    ring.classList.toggle('ccw', v.dir === -1);
    ring.classList.toggle('none', n < 3);
    var info = $('tinfo'), again = v.phase === 'play' && !!v.ev && v.ev.repeat >= 2, parts = [];
    if (again) parts.push('Die Stellung wiederholt sich');
    else {
      if (n > 2) parts.push(v.dir === 1 ? '\u21bb\ufe0e im Uhrzeigersinn' : '\u21ba\ufe0e gegen den Uhrzeigersinn');
      var burned = ov && ov.burned != null ? ov.burned : v.burned;
      if (burned) parts.push(burned + ' aus dem Spiel');
    }
    info.textContent = parts.join(' · ');
    info.classList.toggle('rep', again);
  }
  function renderMyTable(d) {
    var box = $('myTable'), zone = d.my ? d.my.zone : null, i;
    if (box.children.length !== 3) {
      clear(box);
      for (i = 0; i < 3; i++) box.appendChild(el('div', 'slot'));
    }
    /* Knoten bleiben erhalten, damit eine gerade berührte Karte nicht unter dem Finger ersetzt wird */
    for (i = 0; i < 3; i++) {
      var slot = box.children[i], dn = slot.querySelector('.dn'), up = slot.querySelector('.up'), want = d.up[i];
      if (d.p.down[i]) {
        if (!dn) {
          dn = cardBack('dn');
          dn.setAttribute('data-down', i);
          slot.insertBefore(dn, slot.firstChild);
        }
        dn.classList.toggle('flip-ok', zone === 'down' && d.my.canFlip);
        dn.classList.toggle('pend', !!(d.opt && d.opt.kind === 'flip' && d.opt.slot === i));
      } else if (dn) drop(dn);
      if (up && up.getAttribute('data-card') !== want) { drop(up); up = null; }
      if (want) {
        if (!up) { up = cardFace(want, 'up'); slot.appendChild(up); }
        setState(up, zone === 'up' ? cardState(d, want) : '');
      }
    }
  }
  function cardW() {
    if (!cwCache) cwCache = $('cwProbe').offsetWidth || 56;
    return cwCache;
  }
  function layoutHand() {
    var sc = $('handScroll'), box = $('hand'), n = handOrder.length, cw = cardW();
    var avail = sc.clientWidth - 16, step = 0;
    if (n > 1) step = Math.max(14, Math.min(cw + 6, (avail - cw) / (Math.min(n, 12) - 1)));
    var total = n ? cw + step * (n - 1) : 0;
    box.style.width = Math.ceil(total) + 'px';
    sc.classList.toggle('scrolls', total > avail + 1);
    for (var i = 0; i < n; i++) handNodes[handOrder[i]].style.transform = 'translate3d(' + (i * step).toFixed(1) + 'px,0,0)';
    var info = $('handInfo');
    info.hidden = n <= 12;
    if (n > 12) info.textContent = n + ' Karten \u2190 wischen \u2192';
  }
  function renderHand(d) {
    var box = $('hand'), ids = d.hand, keep = {}, fresh = [], inHand = !!(d.my && d.my.zone === 'hand');
    var first = !box.firstChild && !handOrder.length;   // erster Aufbau: sofort sichtbar, ohne Einblenden
    ids.forEach(function (id, i) {
      var hc = handNodes[id];
      if (!hc) {
        hc = el('div', first ? 'hc' : 'hc enter');
        hc.setAttribute('data-id', id);
        hc.appendChild(cardFace(id));
        handNodes[id] = hc;
        fresh.push(hc);
      }
      keep[id] = 1;
      setState(hc, inHand ? cardState(d, id) : '');
      hc.style.zIndex = String(i + 1);
    });
    for (var k in handNodes) if (!keep[k]) { drop(handNodes[k]); delete handNodes[k]; }
    handOrder = ids;
    layoutHand();
    if (fresh.length) {
      fresh.forEach(function (n) { box.appendChild(n); });
      void box.offsetWidth;
      setTimeout(function () { fresh.forEach(function (n) { n.classList.remove('enter'); }); }, 20);
    }
  }
  function renderActions(d) {
    var v = d.v, bP = $('btnPickup'), bL = $('btnPlay'), hint = $('actHint');
    var text = '', showP = false, showL = false, pulse = false, strong = false, counter = false, quiet = false;
    var top = v.pile.length ? v.pile[v.pile.length - 1] : null;
    /* Liegen nur Joker auf dem Stapel, gibt es nichts aufzunehmen: Der Joker wird bloß abgeräumt. */
    var bare = v.pile.length > 0 && v.pile.every(E.isJoker);
    /* Nach dem Aufnehmen (freePlay) spielt derselbe Spieler aus. War der Stapel bis auf den Joker leer,
     * hat er nichts aufgenommen – dann spielt er aus der Zone, die gerade dran ist. */
    var took = !(v.ev && v.ev.t === 'pickup' && !v.ev.n && !v.ev.upCard);
    if (v.phase !== 'play' || d.opt || d.p.place || (ov && ov.holdSeat === d.me)) text = '';   // auch solange die aufgedeckte Karte noch gezeigt wird
    else if (!d.my) {
      if (v.turn !== d.me) {
        text = !v.freePlay ? 'Warte auf ' + nameOf(v, v.turn) + ' …'
          : took ? nameOf(v, v.turn) + ' hat aufgenommen und spielt aus' : 'Joker ist weg – ' + nameOf(v, v.turn) + ' spielt aus';
      }
    } else if (d.my.zone === 'down') {
      showP = d.my.canPickup;
      pulse = d.my.forced;
      quiet = showP && isVoluntary(d);   // statt aufzudecken freiwillig aufnehmen: geht, steht aber im Hintergrund
      if (d.my.forced) text = bare ? 'Roter Joker: du musst ihn abräumen' : 'Roter Joker: du musst aufnehmen';
      else if (showP && !quiet) text = (bare ? 'Abräumen' : 'Aufnehmen') + ' – oder eine verdeckte Karte antippen';
      else if (v.freePlay) { text = (took ? 'Aufgenommen' : 'Joker ist weg') + ' – decke jetzt eine verdeckte Karte auf'; strong = true; }
      else text = 'Tippe eine verdeckte Karte an';
    } else {
      var lastUp = d.my.zone === 'up' && d.up.filter(Boolean).length === 1;
      showL = d.my.playable.length > 0;
      showP = d.my.canPickup;
      /* Aufnehmen geht immer, solange etwas liegt. Dringend ist es nur, wenn nichts anderes geht (forced).
       * Schwarzer Joker oben und der rote ist spielbar: Aufnehmen und Kontern stehen gleichwertig nebeneinander.
       * Sonst ist es ein freiwilliger, taktischer Zug – klein und mit Rückfrage. */
      counter = showL && showP && top === E.JB;
      quiet = showL && showP && !counter;
      pulse = d.my.forced;
      if (d.my.forced) {
        text = lastUp ? (E.isJoker(top) ? 'Joker – ' : 'Passt nicht – ') + 'die letzte offene Karte kommt mit'
          : !E.isJoker(top) ? 'Keine Karte passt' : bare ? 'Joker: darunter liegt nichts' : 'Joker: du musst aufnehmen';
      } else if (v.freePlay) {
        text = (took ? 'Aufgenommen' : 'Joker ist weg') + ' – spiele jetzt eine ' + (d.my.zone === 'up' ? 'offene Karte' : took ? 'Karte aus der Hand' : 'beliebige Karte');
        strong = true;
      } else if (!sel.length) text = d.my.zone === 'up' ? 'Offene Karte wählen oder ziehen' : 'Karte wählen oder ziehen';
    }
    /* Nach dem Aufnehmen steht der Hinweis über die ganze Breite, bis eine Karte gewählt ist. */
    var wide = strong && !sel.length;
    bP.hidden = !showP;
    bP.className = 'btn' + (pulse ? ' pulse' : quiet ? ' sec quiet' : ' sec');
    bP.textContent = bare && !(d.my && d.my.forced && lastUp) ? 'Joker abräumen' : 'Stapel aufnehmen';
    /* Neben dem kleinen „Stapel aufnehmen“ erscheint „Legen“ erst, wenn eine Karte gewählt ist – bis dahin steht dort der Hinweis. */
    bL.hidden = !showL || wide || (quiet && !sel.length);
    bL.disabled = !sel.length && !counter;
    bL.textContent = counter ? 'Mit Rot kontern' : sel.length > 1 ? sel.length + ' Karten legen' : 'Legen';
    hint.textContent = text;
    hint.className = 'act-hint' + (strong ? ' strong' : '');
    hint.hidden = counter || (showL && sel.length > 0);
  }
  /* Freiwillig aufnehmen: Es gäbe einen anderen Zug, und kein Joker verlangt das Aufnehmen. */
  function isVoluntary(d) {
    var pile = d.v.pile, top = pile.length ? pile[pile.length - 1] : null;
    return !!(d.my && d.my.canPickup && !d.my.forced && !E.isJoker(top));
  }
  /* Sieger-Hinweis, während die anderen weiterspielen (erscheint nur beim Ereignis selbst). */
  var WON_MIN = 2400, WON_MAX = 7000;
  function showWon(seat) {
    won = { seat: seat, at: Date.now() };
    clearTimeout(wonTimer);
    clearTimeout(wonTurnTimer);
    wonTimer = setTimeout(hideWon, WON_MAX);
    wonTurnTimer = setTimeout(wonCheckTurn, WON_MIN + 50);
  }
  function hideWon() {
    clearTimeout(wonTimer);
    clearTimeout(wonTurnTimer);
    if (!won) return;
    won = null;
    $('won').classList.remove('open');
  }
  /* Der Hinweis liegt über der Tischmitte: Wer selbst am Zug ist, soll nicht lange darunter suchen müssen. */
  function wonBlocksMe() {
    var v = cur && cur.stage === 'game' ? cur.view : null;
    return !!(won && v && v.phase === 'play' && v.turn === v.you && Date.now() - won.at >= WON_MIN);
  }
  function wonCheckTurn() { if (wonBlocksMe()) hideWon(); }
  function renderWon(d) {
    var v = d.v, box = $('won');
    if (!won || v.phase !== 'play' || v.winner !== won.seat || wonBlocksMe()) { hideWon(); box.classList.remove('open'); return; }
    var mine = won.seat === d.me;
    $('wonTitle').textContent = mine ? 'Du hast gewonnen!' : nameOf(v, won.seat) + ' hat gewonnen!';
    $('wonText').textContent = (mine ? 'Platz 1! Die anderen spielen noch um die weiteren Plätze.' : 'Platz 1 ist vergeben – ihr spielt um die weiteren Plätze.') +
      (cur.isHost ? '' : ' Der Host kann jetzt eine neue Runde starten.');
    $('btnWonClose').textContent = mine ? 'Zuschauen' : 'Weiterspielen';
    box.classList.add('open');
  }
  function renderOver(d) {
    var v = d.v, o = $('over'), me = d.me;
    if (v.phase !== 'over') { clearTimeout(overTimer); o.classList.remove('open', 'shown'); return; }
    if (!o.classList.contains('open')) {
      overAt = Date.now();
      /* Sicherheitsnetz, falls die Einblend-Animation nicht läuft: danach steht die Rangliste fest da. */
      clearTimeout(overTimer);
      overTimer = setTimeout(function () { o.classList.add('shown'); }, 1000);
    }
    var title, note = '', gave = typeof v.gaveUp === 'number' ? v.gaveUp : -1;
    if (v.deadlock) {
      title = v.winner == null ? 'Unentschieden' : 'Runde festgefahren';
      note = 'Die Runde hat sich festgefahren – es gibt keinen Zug mehr, der das Spiel voranbringt.';
    } else if (v.winner == null) title = 'Runde beendet';
    else title = v.winner === me ? 'Du hast gewonnen!' : nameOf(v, v.winner) + ' gewinnt!';
    if (gave >= 0) note = gave === me ? 'Du hast aufgegeben.' : nameOf(v, gave) + ' hat aufgegeben.';
    $('overTitle').textContent = title;
    $('overNote').textContent = note;
    $('overNote').hidden = !note;
    $('overStar').style.display = v.deadlock ? 'none' : '';
    var list = $('overList');
    clear(list);
    /* sub: zweite Zeile unter dem Namen (nur beim Verlierer) */
    function row(place, seat, tag, cls, sub) {
      var r = el('div', 'rank' + (cls ? ' ' + cls : '') + (seat === me ? ' me' : ''));
      r.appendChild(el('b', null, place));
      r.appendChild(el('span', 'rank-name', seat === me ? 'Du' : nameOf(v, seat)));
      r.appendChild(el('span', 'rank-tag', tag));
      if (sub) r.appendChild(el('span', 'rank-sub', sub));
      list.appendChild(r);
    }
    /* Plätze in der Reihenfolge, in der die Spieler fertig wurden. Wer übrig bleibt, hat verloren. */
    v.finished.forEach(function (seat, i) {
      /* Nach einer Aufgabe hat der Gegner seinen Platz bekommen, ohne die Karten los zu sein. */
      var byGiveUp = gave >= 0 && i === v.finished.length - 1;
      row((i + 1) + '.', seat, i === 0 ? (byGiveUp ? 'Sieger durch Aufgabe' : 'Sieger') : byGiveUp ? 'durch Aufgabe' : 'fertig', i === 0 ? 'first' : '');
    });
    v.players.forEach(function (p, seat) {
      if (p.place) return;
      var left = 'noch ' + countText(cardsLeft(p));
      if (v.deadlock) { row('–', seat, 'unentschieden · ' + left, 'draw'); return; }
      /* Wer die Partie verlassen hat, ist in der nächsten Runde nicht mehr dabei. */
      var info = cur.lobby && cur.lobby.players[seat], stays = !(info && info.left);
      var sub = 'Verlierer' + (!stays ? '' : seat === me ? ' – du beginnst die nächste Runde' : ' – beginnt die nächste Runde');
      row((v.finished.length + 1) + '.', seat, seat === gave ? 'hat aufgegeben' : left, 'last', sub);
    });
    o.classList.add('open');
  }

  /* ---------- Menü ---------- */

  function renderMenu() {
    var s = cur, list = $('menuList');
    clear(list);
    if (!s || !s.lobby) { closeSheet(); return; }
    var v = s.stage === 'game' ? s.view : null;
    $('menuCode').textContent = s.code || '';
    s.lobby.players.forEach(function (p, i) {
      var row = playerRow(p, i, {
        you: i === s.seat, game: !!v, place: v && v.players[i] ? v.players[i].place : 0,
        lost: !!(v && v.phase === 'over' && v.loser === i)
      });
      if (s.isHost && v && i !== s.seat && !p.bot && !p.left && (p.auto || p.online === false)) {
        var b = el('button', 'btn sec small', p.auto ? 'Bot aus' : 'Bot übernimmt');
        b.setAttribute('data-auto', i);
        b.setAttribute('data-on', p.auto ? '0' : '1');
        row.appendChild(b);
      }
      list.appendChild(row);
    });
    var canNew = !!(v && (v.phase === 'over' || v.winner != null));
    $('btnMenuRematch').hidden = !(s.isHost && canNew);
    $('menuNote').hidden = !(canNew && !s.isHost);
    $('menuNote').textContent = 'Es gibt einen Sieger: Der Host kann jetzt eine neue Runde starten.';
    $('btnMenuGiveUp').hidden = !canGive();
    $('btnMenuGiveUp').disabled = !!giving;
    $('btnMenuLobby').hidden = !(s.isHost && s.stage === 'game');
    $('btnLeave').textContent = s.isHost ? 'Raum schließen' : 'Spiel verlassen';
  }
  /* Neue Runde: sofort, wenn die Runde vorbei ist – mit Rückfrage, solange noch gespielt wird. */
  function askRematch() {
    var v = cur && cur.stage === 'game' ? cur.view : null;
    if (!v || !cur.isHost) return;
    if (v.phase === 'over') { closeSheet(); session.lobby({ op: 'rematch' }); return; }
    if (v.winner == null) return;
    confirmBox('Neue Runde starten?', 'Die laufende Runde wird für alle beendet und es wird neu ausgeteilt.', 'Neue Runde', function () {
      closeSheet();
      session.lobby({ op: 'rematch' });
    });
  }
  /* Aufgeben: nur solange genau zwei Spieler noch Karten haben – auch außerhalb des eigenen Zugs. */
  function canGive() {
    var v = cur && cur.stage === 'game' ? cur.view : null;
    return !!(v && v.phase === 'play' && v.canGiveUp);
  }
  function syncGiveUp() {
    var can = canGive(), b = $('btnGiveUp');
    b.hidden = !can;
    b.disabled = !!giving;
    if (!can && cfTag === 'giveup') closeConfirm();
    /* Die Rückfrage zum freiwilligen Aufnehmen gilt nur für genau diese Stellung. */
    if (cfTag.indexOf('pickup:') === 0) {
      var v = cur && cur.stage === 'game' ? cur.view : null;
      if (!v || v.phase !== 'play' || v.turn !== v.you || cfTag !== 'pickup:' + v.seq) closeConfirm();
    }
  }
  function askGiveUp() {
    if (!canGive() || giving) return;
    var v = cur.view, other = -1, place = v.finished.length + 1;
    v.players.forEach(function (p, i) { if (i !== v.you && !p.place && p.zone) other = i; });
    var text = 'Du wirst Letzter und beginnst die nächste Runde.';
    if (other >= 0) text += ' ' + nameOf(v, other) + (place === 1 ? ' gewinnt.' : ' bekommt Platz ' + place + '.');
    confirmBox('Aufgeben?', text, 'Aufgeben', doGiveUp, true, 'giveup');
  }
  function doGiveUp() {
    closeSheet();
    if (!canGive() || giving) return;
    giving = { after: snapCount };
    var ok = false;
    try { ok = session.act({ t: 'giveup' }); } catch (e) { console.error(e); }
    if (!ok) { giving = null; toast('Aufgeben ist gerade nicht möglich.'); }
    syncGiveUp();
  }
  function askAuto(seat, on) {
    var p = cur && cur.lobby && cur.lobby.players[seat];
    if (!p || !cur.isHost) return;
    if (on) confirmBox('Bot für ' + p.name + '?', 'Ein Bot spielt weiter, bis ' + p.name + ' wieder da ist.', 'Bot an', function () { session.lobby({ op: 'auto', seat: seat, on: true }); });
    else confirmBox('Bot ausschalten?', p.name + ' muss dann wieder selbst spielen.', 'Bot aus', function () { session.lobby({ op: 'auto', seat: seat, on: false }); });
  }
  function askLeave() {
    var s = cur;
    if (!s) return;
    var text = s.isHost ? 'Du bist der Host: Der Raum wird für alle geschlossen.'
      : s.stage === 'game' ? 'Ein Bot spielt deine Karten zu Ende. In die laufende Runde kannst du danach nicht mehr zurück.' : '';
    confirmBox(s.isHost ? 'Raum schließen?' : 'Spiel verlassen?', text, s.isHost ? 'Schließen' : 'Verlassen', function () {
      closeSheet();
      session.leave();
    }, true);
  }

  /* ---------- Snapshots verarbeiten ---------- */

  function onSnap(s) {
    s._n = ++snapCount;
    queue.push(s);
    if (!pumpQueued) { pumpQueued = true; Promise.resolve().then(pump); }
  }
  function pump() {
    pumpQueued = false;
    if (pumping) return;
    pumping = true;
    (function next() {
      if (!queue.length) { pumping = false; return; }
      /* nichts unter dem Finger umbauen: erst das Ziehen (bzw. in der Tauschphase das Antippen) abwarten */
      if (drag || (press && body.getAttribute('data-screen') === 'swap')) { dragDone = next; return; }
      var s = queue.shift(), p = null;
      try { p = apply(s, queue.length >= 2); } catch (e) { console.error(e); p = null; }
      if (p && p.then) p.then(next, function (e) { console.error(e); next(); });
      else next();
    })();
  }
  function resetGame() {
    sel = []; swapSel = null; swapPrev = null; ov = null; lock = false; afterLock = null; optFly = null;
    hideWon();
    clear($('fx'));
    $('center').classList.remove('burning', 'drop', 'can');
  }
  function settle() {
    ov = null;
    lock = false;
    renderAll();
    $('center').classList.remove('burning');
    var f = afterLock;
    afterLock = null;
    if (f) f();
  }
  function apply(snap, skip) {
    var prev = cur;
    cur = snap;
    syncChrome(snap);
    var v = snap.stage === 'game' ? snap.view : null;
    var pv = prev && prev.stage === 'game' && prev.view && prev.code === snap.code ? prev.view : null;
    if (giving) {
      if (!v || v.phase !== 'play' || !v.canGiveUp) giving = null;
      else if (snap._n > giving.after && (snap.isHost || snap.pending === 0)) { giving = null; toast('Aufgeben hat nicht geklappt – bitte nochmal.'); }
    }
    if (!v) { opt = null; resetGame(); renderAll(); return null; }
    var had = null, me = v.players[v.you];
    if (opt) {
      var answered = !snap.isHost && snap.pending === 0 && snap._n > opt.after;
      if (opt.kind === 'ready') { if (v.phase !== 'swap' || (me && me.ready) || answered) opt = null; }
      else if (opt.kind === 'unready') { if (v.phase !== 'swap' || (me && !me.ready) || answered) opt = null; }
      else if (v.seq !== opt.seq) { had = opt; opt = null; }
      else if (answered) { opt = null; toast('Das hat nicht geklappt – bitte nochmal.'); }
    }
    if (!pv || v.seq < pv.seq || (v.phase === 'swap' && pv.phase !== 'swap')) resetGame();
    if (v.phase === 'play' && v.turn === v.you && v.my) sel = sel.filter(function (c) { return v.my.playable.indexOf(c) >= 0; });
    else sel = [];
    /* Jemand hat die laufende Partie verlassen: kurz Bescheid sagen. */
    if (pv && prev.lobby && snap.lobby && v.seq >= pv.seq) {
      snap.lobby.players.forEach(function (q, i) {
        var was = prev.lobby.players[i];
        if (q.left && was && !was.left && was.name === q.name) toast(q.name + ' hat verlassen – ein Bot spielt weiter');
      });
    }

    var ev = v.ev, p = null;
    if (pv && ev && ev.seq === v.seq && v.seq > pv.seq && !skip) {
      if (ev.auto) toast(ev.seat === v.you ? 'Zeit abgelaufen – es wurde für dich gespielt' : 'Zeit abgelaufen: Für ' + nameOf(v, ev.seat) + ' wurde gespielt');
      else if (ev.t === 'start' && ev.forced) toast('Zeit abgelaufen – die Runde beginnt');
    }
    var anim = !skip && pv && pv.phase === 'play' && ev && ev.seq === v.seq && v.seq === pv.seq + 1 && pv.turn === ev.seat &&
      doc.visibilityState !== 'hidden' && body.getAttribute('data-screen') === 'game';
    if (anim) {
      try {
        if (ev.t === 'play') p = animPlay(pv, v, had);
        else if (ev.t === 'pickup') p = animPickup(pv, v);
        else if (ev.t === 'flipfail') p = animFlipFail(pv, v);
      } catch (e) { console.error(e); p = null; }
    }
    /* Auch nach dem eigenen Aufnehmen oder einer 3 zu zweit bin ich (wieder) am Zug. */
    var myTurnNow = v.phase === 'play' && v.turn === v.you && !!pv && (pv.phase !== 'play' || pv.turn !== v.you || v.seq !== pv.seq);
    if (!p) {
      settle();
      if (pv && pv.phase === 'swap' && v.phase === 'play' && !skip) gToast(v.turn === v.you ? 'Los geht’s – du beginnst!' : nameOf(v, v.turn) + ' beginnt');
      /* Aufgeben kommt auch außerhalb des eigenen Zugs: allen kurz sagen, warum die Runde vorbei ist. */
      if (pv && pv.phase === 'play' && v.phase === 'over' && ev && ev.t === 'giveup' && ev.seq === v.seq) {
        gToast(ev.seat === v.you ? 'Du hast aufgegeben' : nameOf(v, ev.seat) + ' hat aufgegeben', false, 2400);
      }
      if (myTurnNow) revealPlayable();
      return null;
    }
    return p.then(function () { settle(); if (myTurnNow) revealPlayable(); }, function (e) { console.error(e); settle(); });
  }
  function revealPlayable() {
    var sc = $('handScroll'), v = cur && cur.view;
    if (!help || !v || !v.my || v.my.zone !== 'hand' || !sc.classList.contains('scrolls')) return;
    var first = -1;
    for (var i = 0; i < handOrder.length && first < 0; i++) if (v.my.playable.indexOf(handOrder[i]) >= 0) first = i;
    if (first < 0) return;
    var n = handOrder.length, total = $('hand').offsetWidth, x = total * first / n - sc.clientWidth * 0.3;
    x = Math.max(0, Math.min(x, sc.scrollWidth - sc.clientWidth));
    try { sc.scrollTo({ left: x, behavior: 'smooth' }); } catch (e) { sc.scrollLeft = x; }
  }

  /* ---------- Animationen ---------- */

  var FLY = 290;
  function sameCards(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) < 0) return false;
    return true;
  }
  function oppPanelNode(seat) { return $('table').querySelector('.opp[data-seat="' + seat + '"]'); }
  function myCardNode(id) {
    if (handNodes[id]) return handNodes[id].firstChild;
    return $('myTable').querySelector('.card[data-card="' + id + '"]');
  }
  function srcRect(seat, from, id, slot, me) {
    var node = null, exact = true;
    if (seat === me) {
      if (from === 'down') node = $('myTable').querySelector('[data-down="' + slot + '"]');
      else node = myCardNode(id);
      if (!node) { node = $('handScroll'); exact = false; }
    } else {
      var panel = oppPanelNode(seat);
      if (!panel) return null;
      if (from === 'hand') node = panel.querySelector('.opp-hand .card');
      else if (from === 'up') node = panel.querySelector('[data-card="' + id + '"]');
      else node = panel.querySelector('[data-down="' + slot + '"]');
      if (!node) { node = panel; exact = false; }
    }
    var r = rectOf(node);
    if (!exact) r = { x: r.x + r.w / 2 - 12, y: r.y + r.h / 2 - 17, w: 24, h: 34 };
    return r;
  }
  /* Karten liegen im DOM schon auf dem Stapel (versteckt) und fliegen als Kopie von `rects` dorthin. */
  function flyToPile(ids, rects) {
    var pr = rectOf($('pile')), layer = $('fx'), items = [];
    ids.forEach(function (id, i) {
      var node = pileNodes[id], from = rects && rects[i];
      if (!node || !from || !pr.w) return;
      node.classList.add('inflight');
      var g = cardFace(id, 'ghost');
      g.style.setProperty('--w', pr.w + 'px');
      g.style.left = pr.x + 'px';
      g.style.top = pr.y + 'px';
      var dx = from.x + from.w / 2 - (pr.x + pr.w / 2), dy = from.y + from.h / 2 - (pr.y + pr.h / 2);
      g.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(' + Math.max(0.12, from.w / pr.w).toFixed(3) + ')';
      layer.appendChild(g);
      items.push({ g: g, node: node });
    });
    if (!items.length) return Promise.resolve();
    void layer.offsetWidth;
    items.forEach(function (o, i) {
      o.g.style.transition = 'transform ' + FLY + 'ms cubic-bezier(.2,.75,.25,1) ' + (i * 50) + 'ms';
      o.g.style.transform = o.node.style.transform || 'none';
    });
    return wait(FLY + (items.length - 1) * 50 + 30).then(function () {
      items.forEach(function (o) { o.node.classList.remove('inflight'); drop(o.g); });
    });
  }
  /* Kopie des sichtbaren Stapels ohne die Karten in `skip`; null, wenn dann nichts übrig ist. */
  function clonePile(skip) {
    var box = $('pile'), r = rectOf(box), g = el('div', 'ghost-pile');
    g.style.left = r.x + 'px'; g.style.top = r.y + 'px';
    g.style.width = r.w + 'px'; g.style.height = r.h + 'px';
    for (var i = 0; i < box.children.length; i++) {
      if (skip && skip.indexOf(box.children[i].getAttribute('data-card')) >= 0) continue;
      var c = box.children[i].cloneNode(true);
      c.classList.remove('inflight');
      g.appendChild(c);
    }
    if (!g.firstChild) return null;
    $('fx').appendChild(g);
    return { g: g, r: r };
  }
  function flyPileTo(gh, seat, me) {
    var node = seat === me ? $('handScroll') : (oppPanelNode(seat) || $('table'));
    var t = rectOf(node), dx = t.x + t.w / 2 - (gh.r.x + gh.r.w / 2), dy = t.y + t.h / 2 - (gh.r.y + gh.r.h / 2);
    void gh.g.offsetWidth;
    gh.g.style.transition = 'transform 340ms cubic-bezier(.45,0,.7,.6), opacity 340ms ease-in';
    gh.g.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(' + (seat === me ? 0.85 : 0.35) + ')';
    gh.g.style.opacity = '0';
    return wait(360).then(function () { drop(gh.g); });
  }
  /* Eine einzelne offene Karte fliegt mit auf die Hand (letzte offene Karte beim Aufnehmen). */
  function flyCardTo(id, from, seat, me) {
    if (!from) return Promise.resolve();
    var node = seat === me ? $('handScroll') : (oppPanelNode(seat) || $('table'));
    var t = rectOf(node), g = cardFace(id, 'ghost');
    g.style.setProperty('--w', from.w + 'px');
    g.style.left = from.x + 'px';
    g.style.top = from.y + 'px';
    $('fx').appendChild(g);
    void g.offsetWidth;
    var dx = t.x + t.w / 2 - (from.x + from.w / 2), dy = t.y + t.h / 2 - (from.y + from.h / 2);
    g.style.transition = 'transform 380ms cubic-bezier(.45,0,.7,.6), opacity 380ms ease-in';
    g.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(' + (seat === me ? 1 : 0.5) + ')';
    g.style.opacity = seat === me ? '0.2' : '0';
    return wait(400).then(function () { drop(g); });
  }

  /* Eine verdeckte Karte fliegt verdeckt zu ihrem Besitzer (fremder Blindzug, der nicht passt). */
  function flyBackTo(from, seat, me) {
    if (!from) return Promise.resolve();
    var node = seat === me ? $('handScroll') : (oppPanelNode(seat) || $('table'));
    var t = rectOf(node), g = cardBack('ghost');
    g.style.setProperty('--w', from.w + 'px');
    g.style.left = from.x + 'px';
    g.style.top = from.y + 'px';
    $('fx').appendChild(g);
    void g.offsetWidth;
    var dx = t.x + t.w / 2 - (from.x + from.w / 2), dy = t.y + t.h / 2 - (from.y + from.h / 2);
    g.style.transition = 'transform 380ms cubic-bezier(.45,0,.7,.6), opacity 380ms ease-in';
    g.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(.6)';
    g.style.opacity = '0';
    return wait(400).then(function () { drop(g); });
  }

  /* --- Nachziehen: Die Karten sind im neuen Stand schon da; bis der Zug gezeigt ist, bleiben sie
   *     verborgen (ov.stock / ov.drawN / ov.hide) und fliegen dann sichtbar vom Nachziehstapel. --- */
  function drawInfo(pv, v) {
    var ev = v.ev, me = v.you, ids = [];
    if (!ev.drew) return null;
    if (ev.seat === me) {
      var old = {};
      pv.players[me].hand.forEach(function (c) { old[c] = 1; });
      pv.pile.forEach(function (c) { old[c] = 1; });
      if (ev.card) old[ev.card] = 1;
      if (ev.upCard) old[ev.upCard] = 1;
      ids = v.players[me].hand.filter(function (c) { return !old[c]; });
      if (ids.length !== ev.drew) ids = [];
    }
    return { seat: ev.seat, n: ev.drew, ids: ids, stock: v.stock + ev.drew };
  }
  function holdDraw(o, dr) {
    if (dr) { o.stock = dr.stock; o.drawSeat = dr.seat; o.drawN = dr.n; o.hide = dr.ids; }
    return o;
  }
  var DRAW = 300;
  function animDraw(dr) {
    if (!dr) return null;
    var me = cur.view.you, from = rectOf($('stock'));
    if (ov) { ov.stock = null; ov.drawSeat = -1; ov.drawN = 0; ov.hide = null; }
    renderGame();     // Zähler des Nachziehstapels und die Handkarten zeigen jetzt den neuen Stand
    var targets = [], mine = dr.seat === me, i;
    if (mine) {
      dr.ids.forEach(function (id) {
        var hc = handNodes[id];
        if (!hc) return;
        hc.classList.add('fresh');
        targets.push(rectOf(hc));
        setTimeout(function () { hc.classList.remove('fresh'); }, 2400);
      });
      if (!targets.length) { var hr = rectOf($('handScroll')); for (i = 0; i < dr.n; i++) targets.push({ x: hr.x + hr.w / 2 - from.w / 2, y: hr.y + hr.h / 2, w: from.w, h: from.h }); }
    } else {
      var panel = oppPanelNode(dr.seat), node = panel && (panel.querySelector('.opp-hand .card') || panel);
      if (!node) return null;
      var r = rectOf(node);
      for (i = 0; i < dr.n; i++) targets.push(r);
    }
    if (!from.w) return null;
    var layer = $('fx'), ghosts = [];
    targets.forEach(function (t, k) {
      var g = cardBack('ghost');
      g.style.setProperty('--w', from.w + 'px');
      g.style.left = from.x + 'px';
      g.style.top = from.y + 'px';
      layer.appendChild(g);
      ghosts.push(g);
      void g.offsetWidth;
      var dx = t.x + t.w / 2 - (from.x + from.w / 2), dy = t.y + t.h / 2 - (from.y + from.h / 2);
      g.style.transition = 'transform ' + DRAW + 'ms cubic-bezier(.3,.7,.3,1) ' + (k * 90) + 'ms, opacity 120ms linear ' + (k * 90 + DRAW - 90) + 'ms';
      g.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(' + Math.max(0.2, t.w / from.w).toFixed(3) + ')';
      g.style.opacity = '0';
    });
    return wait(DRAW + (targets.length - 1) * 90 + 60).then(function () { ghosts.forEach(drop); });
  }

  /* Meldungen zu einem gelegten Zug; die wichtigste zuerst. */
  function playLines(ev, v) {
    var me = v.you, fx = ev.fx, lines = [];
    function has(f) { return fx.indexOf(f) >= 0; }
    var next = v.turn < 0 ? '' : v.turn === me ? ' Du musst aufnehmen' : ' ' + nameOf(v, v.turn) + ' muss aufnehmen';
    /* Der erste Fertige bekommt bei laufender Runde den Sieger-Hinweis statt einer Zeile hier. */
    if (ev.place && !(has('win') && v.phase === 'play')) lines.push(ev.seat === me ? 'Du bist fertig – Platz ' + ev.place : nameOf(v, ev.seat) + ' ist fertig – Platz ' + ev.place);
    if (has('burn')) lines.push('Stapel entfernt!');
    if (has('reverse')) lines.push('Richtungswechsel');
    if (has('again')) lines.push(ev.seat === me ? 'Du bist nochmal dran' : nameOf(v, ev.seat) + ' ist nochmal dran');
    /* Endet die Runde mit diesem Zug, muss niemand mehr aufnehmen. */
    /* Joker auf leerem Stapel: Es gibt nichts aufzunehmen, der Nächste räumt ihn nur ab. */
    if (v.pile.length && v.pile.every(E.isJoker)) next = ' Der Stapel ist aber leer';
    if (has('joker') && v.turn >= 0) lines.push(v.turn === me && v.my && v.my.playable.length ? 'Joker! Aufnehmen oder mit Rot kontern' : 'Joker!' + next);
    if (has('counter') && v.turn >= 0) lines.push('Gekontert!' + next);
    return lines;
  }
  function animPlay(pv, v, had) {
    var ev = v.ev, me = v.you, burn = ev.fx.indexOf('burn') >= 0, dr = drawInfo(pv, v);
    var mine = !!(had && had.kind === 'play' && ev.seat === me && sameCards(had.cards, ev.cards));
    var from = mine ? null : ev.cards.map(function (id) { return srcRect(ev.seat, ev.from, id, ev.slot, me); });
    if (burn || dr) ov = holdDraw({ pile: burn ? pv.pile.concat(ev.cards) : v.pile, holdSeat: -1, req: burn ? pv.req : v.req, burned: burn ? pv.burned : null }, dr);
    if (burn) lock = true;
    renderGame();
    var fly = mine ? (optFly || Promise.resolve()) : flyToPile(ev.cards, from);
    return fly.then(function () {
      var lines = playLines(ev, v);
      if (ev.fx.indexOf('reverse') >= 0) {
        var ring = $('ring');
        ring.classList.add('pulse');
        setTimeout(function () { ring.classList.remove('pulse'); }, 900);
      }
      if (lines.length) gToast(lines, false, ev.place ? 2400 : 1400);
      if (!burn) return null;
      $('center').classList.add('burning');
      return wait(500).then(function () {
        if (ov) { ov.pile = v.pile; ov.req = v.req; ov.burned = null; }
        renderGame();
        $('center').classList.remove('burning');
      });
    }).then(function () {
      return animDraw(dr);
    }).then(function () {
      if (!ev.place || v.phase !== 'play') return null;
      if (ev.fx.indexOf('win') >= 0) { showWon(ev.seat); renderWon(display()); }
      return wait(500);            // kurz stehen lassen, bevor der Nächste zieht
    });
  }
  /* Joker, die mit diesem Aufnehmen verbraucht sind (sie kommen nicht auf die Hand). */
  function goneOf(ev) { return Array.isArray(ev.gone) ? ev.gone : []; }
  function goneLine(ev) {
    var k = goneOf(ev).length;
    return !k ? '' : k > 1 ? 'Beide Joker sind aus dem Spiel' : 'Joker ist aus dem Spiel';
  }
  function takesLine(ev, v) {
    return ev.seat === v.you ? 'Du nimmst ' + countText(ev.n) + ' auf' : nameOf(v, ev.seat) + ' nimmt ' + countText(ev.n) + ' auf';
  }
  function pickupLines(ev, v) {
    var mine = ev.seat === v.you, who = nameOf(v, ev.seat), gone = goneLine(ev), lines = [];
    if (ev.n) {
      lines.push(takesLine(ev, v));
      if (ev.upCard) lines.push('und die letzte offene Karte');
    } else if (ev.upCard) lines.push(mine ? 'Du nimmst die letzte offene Karte auf' : who + ' nimmt die letzte offene Karte auf');
    if (gone) lines.push(gone);
    /* Unter dem Joker lag nichts: Er verschwindet, und der Spieler legt einfach los. */
    if (!ev.n && !ev.upCard) lines.push(mine ? 'Nichts aufzunehmen – du spielst aus' : 'Nichts aufzunehmen – ' + who + ' spielt aus');
    return lines;
  }
  /* Aufnehmen zeigen. `shown` ist der Stapel, wie er gerade zu sehen ist: Seine Karten fliegen zum
   * Spieler. Verbrauchte Joker bleiben dabei liegen und verschwinden danach wie ein mit der 10
   * entfernter Stapel – erst dann steigt der Zähler „aus dem Spiel“. */
  function takeAway(pv, v, shown, dr, upFrom) {
    var ev = v.ev, me = v.you;
    var gone = shown.filter(function (c) { return goneOf(ev).indexOf(c) >= 0; });
    var gh = clonePile(gone);
    if (gone.length) ov = holdDraw({ pile: gone, holdSeat: -1, req: pv.req, burned: pv.burned }, dr);
    else ov = dr ? holdDraw({ pile: v.pile, holdSeat: -1, req: v.req }, dr) : null;
    renderGame();
    return Promise.all([gh ? flyPileTo(gh, ev.seat, me) : null, ev.upCard ? flyCardTo(ev.upCard, upFrom, ev.seat, me) : null]).then(function () {
      if (!gone.length) return null;
      $('center').classList.add('burning');
      return wait(500).then(function () {
        if (ov) { ov.pile = v.pile; ov.req = v.req; ov.burned = null; }
        renderGame();
        $('center').classList.remove('burning');
      });
    }).then(function () {
      return animDraw(dr);
    });
  }
  function animPickup(pv, v) {
    var ev = v.ev, me = v.you, dr = drawInfo(pv, v), lines = pickupLines(ev, v);
    lock = true;
    var upFrom = ev.upCard ? srcRect(ev.seat, 'up', ev.upCard, ev.slot, me) : null;
    gToast(lines, false, lines.length > 1 ? 2000 : 1400);
    return takeAway(pv, v, pv.pile, dr, upFrom);
  }
  function animFlipFail(pv, v) {
    var ev = v.ev, me = v.you, dr = drawInfo(pv, v);
    lock = true;
    var from = srcRect(ev.seat, 'down', ev.card, ev.slot, me);
    if (!ev.card) {
      /* Fremde verdeckte Karte, die nicht passt: Sie bleibt geheim und geht verdeckt mit dem Stapel auf die Hand. */
      var hl = [nameOf(v, ev.seat) + ': verdeckte Karte passt nicht', takesLine(ev, v)], hg = goneLine(ev);
      if (hg) hl.push(hg);
      gToast(hl, false, hg ? 2100 : 1700);
      return Promise.all([takeAway(pv, v, pv.pile, dr, null), flyBackTo(from, ev.seat, me)]);
    }
    var shown = pv.pile.concat([ev.card]);
    ov = holdDraw({ pile: shown, holdSeat: ev.seat, holdN: ev.n, req: pv.req, burned: pv.burned }, dr);
    renderGame();
    return flyToPile([ev.card], [from]).then(function () {
      var lines = ['Passt nicht!', takesLine(ev, v)], gone = goneLine(ev);
      if (gone) lines.push(gone);
      gToast(lines, true, gone ? 2100 : 1700);
      return wait(1000);
    }).then(function () {
      return takeAway(pv, v, shown, dr, null);
    });
  }

  /* ---------- eigene Züge ---------- */

  function tapCard(id, zone) {
    var d = display();
    if (!d.my || d.my.zone !== zone) return;
    if (d.my.playable.indexOf(id) < 0) { shake(myCardNode(id)); if (help) flashReq(); else toast('Diese Karte passt nicht'); return; }
    var i = sel.indexOf(id);
    if (i >= 0) sel.splice(i, 1);
    else if (zone === 'hand' && sel.length && E.rank(sel[0]) === E.rank(id)) sel.push(id);   // offene Karten: nur eine pro Zug
    else sel = [id];
    renderMineWith(d);
  }
  /* true, wenn der Zug angenommen (gesendet oder vorgemerkt) wurde. rects: Startpositionen für den Flug. */
  function tryPlay(ids, rects) {
    var d = display();
    if (!ids.length || !d.my || d.my.zone === 'down') return false;
    if (d.my.zone === 'up' && ids.length > 1) ids = ids.slice(0, 1);   // offene Karten: nur eine pro Zug
    for (var i = 0; i < ids.length; i++) {
      if (d.my.playable.indexOf(ids[i]) < 0 || E.rank(ids[i]) !== E.rank(ids[0])) {
        if (help) flashReq(); else { var bad = myCardNode(ids[i]); if (bad) shake(bad); toast('Diese Karte passt nicht'); }
        return false;
      }
    }
    if (lock) { afterLock = function () { tryPlay(ids, null); }; return true; }
    if (!rects) rects = ids.map(function (id) { var n = myCardNode(id); return n ? rectOf(n) : null; });
    opt = { kind: 'play', cards: ids.slice(), seq: d.v.seq, after: snapCount };
    sel = [];
    renderGame();
    var fly = flyToPile(ids, rects);
    optFly = fly;
    fly.then(function () { if (optFly === fly) optFly = null; });
    if (!session.act({ t: 'play', cards: ids.slice() })) { opt = null; renderGame(); toast('Das hat nicht geklappt – bitte nochmal.'); }
    return true;
  }
  /* Freiwilliges Aufnehmen ist auf dem Telefon schnell versehentlich getippt: erst nachfragen. */
  function askPickup() {
    var d = display();
    if (!d.my || !d.my.canPickup) return;
    if (!isVoluntary(d)) { doPickup(); return; }
    var n = d.v.pile.length;
    var text = (d.my.zone === 'down' ? 'Du könntest auch eine verdeckte Karte aufdecken. ' : 'Du könntest auch eine Karte legen. ') +
      'Du nimmst ' + (n === 1 ? 'die Karte' : n === 2 ? 'beide Karten' : 'alle ' + n + ' Karten') + ' vom Ablagestapel auf die Hand und spielst danach selbst aus.';
    confirmBox('Stapel freiwillig aufnehmen?', text, 'Aufnehmen', doPickup, false, 'pickup:' + d.v.seq);
  }
  function doPickup() {
    var d = display();
    if (!d.my || !d.my.canPickup) return;
    if (lock) { afterLock = doPickup; return; }
    opt = { kind: 'pickup', seq: d.v.seq, after: snapCount };
    sel = [];
    renderMine();
    if (!session.act({ t: 'pickup' })) { opt = null; renderMine(); }
  }
  function doFlip(slot) {
    var d = display();
    if (!d.my || d.my.zone !== 'down' || !d.p.down[slot]) return;
    if (!d.my.canFlip) { flashReq(); return; }
    if (lock) { afterLock = function () { doFlip(slot); }; return; }
    opt = { kind: 'flip', slot: slot, seq: d.v.seq, after: snapCount };
    renderMine();
    if (!session.act({ t: 'flip', slot: slot })) { opt = null; renderMine(); }
  }
  function playSelection() {
    if (sel.length) tryPlay(sel.slice(), null);
    else if (display().my) { flashReq(); }
  }
  /* Knopf „Legen“ – beim Kontern (nur der rote Joker passt) auch ohne vorherige Auswahl. */
  function playButton() {
    var d = display();
    var top = d.v.pile.length ? d.v.pile[d.v.pile.length - 1] : null;
    if (!sel.length && d.my && d.my.zone !== 'down' && top === E.JB && d.my.playable.length === 1) tryPlay(d.my.playable.slice(), null);
    else playSelection();
  }

  /* ---------- Zeiger: Tippen und Ziehen ---------- */

  function startPress(e, info) {
    if (press || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, info: info, far: false, touch: e.pointerType === 'touch', last: Date.now() };
    try { info.node.setPointerCapture(e.pointerId); } catch (err) {}
    watchPress(press);
  }
  /* Sicherheitsnetz: geht das Loslassen verloren (z. B. weil das System die Geste übernimmt), nach 8 s Stillstand abbrechen */
  function watchPress(p) {
    setTimeout(function () {
      if (press !== p) return;
      if (Date.now() - p.last < 8000) return watchPress(p);
      press = null;
      if (drag && !drag.ending) { drag.ending = true; endDrag(0, 0, 0, true); }
      else pressDone();
    }, 3000);
  }
  function pressDone() {
    var f = dragDone;
    dragDone = null;
    if (f) f();
  }
  function beginDrag() {
    var info = press.info, ids = info.ids(), main = rectOf(info.node), layer = $('fx');
    var group = el('div', 'drag-group'), items = [];
    ids.forEach(function (id) {
      var node = info.nodeFor(id);
      if (!node) return;
      var r = rectOf(node), g = cardFace(id, 'ghost');
      g.style.setProperty('--w', main.w + 'px');
      g.style.left = r.x + 'px';
      g.style.top = r.y + 'px';
      group.appendChild(g);
      node.classList.add('lifted');
      items.push({ id: id, node: node, g: g, r: r });
    });
    if (!items.length) return false;
    layer.appendChild(group);
    var mi = 0;
    items.forEach(function (it, k) { if (it.id === info.id) mi = k; });
    if (items.length > 1) {
      void group.offsetWidth;
      items.forEach(function (it, k) {
        if (k === mi) { it.g.style.zIndex = '5'; return; }
        var tx = main.x + (k - mi) * main.w * 0.32 - it.r.x, ty = main.y - it.r.y;
        it.g.style.transition = 'transform .16s ease-out';
        it.g.style.transform = 'translate3d(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px,0)';
      });
    }
    drag = { group: group, items: items, ids: items.map(function (it) { return it.id; }), info: info, over: null };
    body.classList.add('dragging');
    return true;
  }
  function finishDrag() {
    body.classList.remove('dragging');
    pressDone();
  }
  function endDrag(x, y, dist, cancelled) {
    var d = drag, info = d.info;
    var target = cancelled ? null : info.target(x, y, dist);
    info.hover(null);
    var ok = false;
    if (target) {
      try { ok = !!info.drop(target, d); } catch (e) { console.error(e); ok = false; }
    }
    if (ok) {
      drop(d.group);
      d.items.forEach(function (it) { it.node.classList.remove('lifted'); });
      drag = null;
      finishDrag();
      return;
    }
    d.group.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
    d.group.style.transform = 'translate3d(0,0,0)';
    d.items.forEach(function (it) { it.g.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)'; it.g.style.transform = 'none'; });
    setTimeout(function () {
      drop(d.group);
      d.items.forEach(function (it) { it.node.classList.remove('lifted'); });
      if (target && info.rejected) info.rejected(d);
      drag = null;
      finishDrag();
    }, cancelled ? 0 : 230);
  }
  function onMove(e) {
    if (!press || e.pointerId !== press.id) return;
    var dx = e.clientX - press.x, dy = e.clientY - press.y, dist = Math.sqrt(dx * dx + dy * dy);
    press.last = Date.now();
    if (!drag) {
      if (dist < 8) return;
      press.far = true;
      if (press.noDrag || !press.info.canDrag()) { press.noDrag = true; return; }
      /* im wischbaren Blatt hebt nur eine überwiegend senkrechte Bewegung die Karte an */
      if (press.touch && press.info.pan && Math.abs(dy) <= Math.abs(dx)) { press.noDrag = true; return; }
      if (!beginDrag()) { press.noDrag = true; return; }
    }
    drag.group.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)';
    var t = press.info.target(e.clientX, e.clientY, dist);
    if (t !== drag.over) { drag.over = t; press.info.hover(t); }
  }
  function onUp(e) {
    if (!press || e.pointerId !== press.id) return;
    var p = press, dx = e.clientX - p.x, dy = e.clientY - p.y;
    press = null;
    try { p.info.node.releasePointerCapture(e.pointerId); } catch (err) {}
    if (drag) { drag.ending = true; endDrag(e.clientX, e.clientY, Math.sqrt(dx * dx + dy * dy), false); return; }
    if (!p.far) {
      try { p.info.tap(); } catch (err) { console.error(err); }
    }
    pressDone();
  }
  function onCancel(e) {
    if (!press || e.pointerId !== press.id) return;
    press = null;
    if (drag) { drag.ending = true; endDrag(0, 0, 0, true); }
    else pressDone();
  }
  doc.addEventListener('pointermove', onMove);
  doc.addEventListener('pointerup', onUp);
  doc.addEventListener('pointercancel', onCancel);

  function playInfo(id, node, zone) {
    return {
      id: id, node: node,
      pan: zone === 'hand' && $('handScroll').classList.contains('scrolls'),
      canDrag: function () { var d = display(); return !!(d.my && d.my.zone === zone) && cur.view.phase === 'play'; },
      ids: function () { return sel.indexOf(id) >= 0 ? sel.slice() : [id]; },
      nodeFor: myCardNode,
      tap: function () { tapCard(id, zone); },
      target: function (x, y, dist) {
        var r = $('table').getBoundingClientRect();
        return dist > 34 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom - 6 ? 'pile' : null;
      },
      hover: function (t) { $('center').classList.toggle('drop', !!t); },
      drop: function (t, d) { return tryPlay(d.ids, d.items.map(function (it) { return rectOf(it.g); })); },
      rejected: function (d) { d.ids.forEach(function (c) { shake(myCardNode(c)); }); }
    };
  }
  $('hand').addEventListener('pointerdown', function (e) {
    var hc = e.target.closest ? e.target.closest('.hc') : null;
    if (!hc || !cur || !cur.view) return;
    hideWon();
    startPress(e, playInfo(hc.getAttribute('data-id'), hc.firstChild, 'hand'));
  });
  $('myTable').addEventListener('pointerdown', function (e) {
    var c = e.target.closest ? e.target.closest('.card') : null;
    if (!c || !cur || !cur.view) return;
    hideWon();
    if (c.hasAttribute('data-down')) {
      var slot = +c.getAttribute('data-down');
      startPress(e, { id: null, node: c, pan: false, canDrag: function () { return false; }, tap: function () { doFlip(slot); } });
    } else startPress(e, playInfo(c.getAttribute('data-card'), c, 'up'));
  });
  function swapPress(e) {
    var c = e.target.closest ? e.target.closest('.card') : null;
    if (!c || !swapEditable()) return;
    var id = c.getAttribute('data-card'), zone = c.getAttribute('data-zone'), hot = null;
    startPress(e, {
      id: id, node: c, pan: false,
      canDrag: swapEditable,
      ids: function () { return [id]; },
      nodeFor: function () { return c; },
      tap: function () { swapTap(id); },
      target: function (x, y) {
        var list = $(zone === 'hand' ? 'swUp' : 'swHand').children;
        for (var i = 0; i < list.length; i++) {
          var r = list[i].getBoundingClientRect();
          if (x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 12 && y <= r.bottom + 12) return list[i].getAttribute('data-card');
        }
        return null;
      },
      hover: function (t) {
        if (hot) hot.classList.remove('drop');
        hot = t ? $('swap').querySelector('.card[data-card="' + t + '"]') : null;
        if (hot) hot.classList.add('drop');
      },
      drop: function (t) { setSwap(id, t); return true; }
    });
  }
  $('swUp').addEventListener('pointerdown', swapPress);
  $('swHand').addEventListener('pointerdown', swapPress);

  /* ---------- Knöpfe ---------- */

  function on(id, fn) { $(id).addEventListener('click', fn); }
  on('btnCreate', doCreate);
  on('btnJoin', doJoin);
  on('btnResume', doResume);
  on('btnConBack', function () { session.leave(); });
  on('btnAddBot', function () { session.lobby({ op: 'addBot' }); });
  on('btnStart', function () { session.lobby({ op: 'start' }); });
  on('btnUndo', function () { if (swapEditable()) { swapPrev = null; swapSel = null; renderSwap(); } });
  on('btnReady', readyButton);
  function renderHelpBtn() {
    var b = $('btnHelp');
    b.textContent = 'Spielhilfe: ' + (help ? 'an' : 'aus');
    b.setAttribute('aria-pressed', help ? 'true' : 'false');
  }
  on('btnHelp', function () {
    help = !help;
    sSet(LS, 'karma.help', help ? '1' : '0');
    renderHelpBtn();
    if (cur && cur.stage === 'game') renderAll();
    toast(help ? 'Spielhilfe an: Du siehst, welche Karten passen' : 'Spielhilfe aus: keine Hinweise, keine grauen Karten');
  });
  renderHelpBtn();
  on('btnPickup', askPickup);
  on('btnPlay', playButton);
  on('pileTap', playSelection);
  /* Die Rangliste erscheint mitten im Spiel: Ein Tipp, der noch einer Karte galt, darf keinen Knopf auslösen. */
  function overReady() { return Date.now() - overAt > 1100; }
  on('btnRematch', function () { if (overReady()) askRematch(); });
  on('btnMenuRematch', askRematch);
  on('btnDoneRematch', askRematch);
  on('btnWonRematch', askRematch);
  on('btnWonClose', hideWon);
  on('btnToLobby', function () { if (overReady()) session.lobby({ op: 'toLobby' }); });
  on('btnMenuLobby', function () {
    confirmBox('Zurück zur Lobby?', 'Die laufende Runde wird für alle beendet.', 'Zur Lobby', function () {
      closeSheet();
      session.lobby({ op: 'toLobby' });
    });
  });
  on('btnLeave', askLeave);
  on('btnGiveUp', askGiveUp);
  on('btnMenuGiveUp', askGiveUp);
  on('cfNo', closeConfirm);
  on('cfYes', function () { var f = cfCb; closeConfirm(); if (f) f(); });
  on('lobbyList', function (e) {
    var k = e.target.closest('[data-kick]');
    if (k) session.lobby({ op: 'kick', seat: +k.getAttribute('data-kick') });
  });
  on('menuList', function (e) {
    var b = e.target.closest('[data-auto]');
    if (b) askAuto(+b.getAttribute('data-auto'), b.getAttribute('data-on') === '1');
  });
  on('table', function (e) {
    var o = e.target.closest('.opp');
    if (!o || !cur || !cur.isHost || !cur.lobby) return;
    var seat = +o.getAttribute('data-seat'), p = cur.lobby.players[seat];
    if (!p || p.bot || p.left) return;
    if (p.auto) askAuto(seat, false);
    else if (p.online === false) askAuto(seat, true);
  });
  doc.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (t) {
      var a = t.getAttribute('data-act');
      if (a === 'menu') openSheet('sheetMenu');
      else if (a === 'rules') openSheet('sheetRules');
      else if (a === 'share') shareLink();
      else if (a === 'close') closeSheet();
      return;
    }
    if (e.target.hasAttribute && e.target.hasAttribute('data-sheet')) closeSheet();
  });
  $('inName').addEventListener('input', function () { sSet(LS, NAME_KEY, this.value.trim()); });
  $('inName').addEventListener('keydown', function (e) { if (e.key === 'Enter') this.blur(); });
  $('inCode').addEventListener('input', function () {
    var c = N.normalizeCode(this.value);
    if (this.value !== c) this.value = c;
    syncJoinUi();
  });
  $('inCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') { this.blur(); doJoin(); } });
  $('linkOut').addEventListener('focus', function () { try { this.select(); } catch (e) {} });
  /* iOS lässt die Seite nach dem Schließen der Tastatur manchmal verschoben stehen */
  function resetScroll() { setTimeout(function () { try { window.scrollTo(0, 0); } catch (e) {} }, 60); }
  $('inName').addEventListener('blur', resetScroll);
  $('inCode').addEventListener('blur', resetScroll);
  window.addEventListener('hashchange', function () {
    var c = hashCode();
    if (c && (!cur || cur.stage === 'idle')) { $('inCode').value = c; syncJoinUi(); }
  });

  /* ---------- Gerät: kein Scrollen/Zoomen der Seite, Aufwachen, Größe ---------- */

  doc.addEventListener('touchmove', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('.scrolly, .scrollx, textarea')) return;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  doc.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  doc.addEventListener('dblclick', function (e) { e.preventDefault(); });
  doc.addEventListener('contextmenu', function (e) {
    if (e.target && e.target.closest && e.target.closest('input, textarea, .rules-text, .code-big')) return;
    e.preventDefault();
  });
  function wake() {
    try { session.wake(); } catch (e) {}
    syncWakeLock();
  }
  doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') wake(); else syncWakeLock(); });
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);
  var resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      cwCache = 0;
      if (body.getAttribute('data-screen') === 'game' && cur && cur.view) layoutHand();
    }, 60);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  /* ---------- Los ---------- */

  (function init() {
    var fan = $('logoFan');
    ['H10', 'JR', 'S2'].forEach(function (id) { fan.appendChild(cardFace(id)); });
    $('inName').value = sGet(LS, NAME_KEY) || '';
    var hc = hashCode();
    if (hc) $('inCode').value = hc;
    session = N.createSession({ engine: E, storage: storage, transport: netKind, onUpdate: onSnap });
    cur = session.snap;
    renderAll();
    if (soloOnly) startError(SOLO_NOTE);
    if (sGet(SS, N.STORE_KEY)) {
      try { session.resume(); } catch (e) { console.error(e); }
    }
  })();

  window.KarmaApp = { session: session, snap: function () { return cur; }, net: netKind, debug: function () { return session.debug(); } };
})();
