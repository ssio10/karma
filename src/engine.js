/* Karma – Regelkern nach "KARMA – Spielregeln, Eure Hausregeln (2–6 Spieler)" (KARMA.pdf).
 * Reine Logik ohne DOM/Netzwerk, läuft im Browser und in Node.
 *
 * Karten-IDs: Farbe + Rang, z. B. "H7", "S14" (Ass). Farben: S ♠, H ♥, D ♦, C ♣.
 * Ränge: 2..10, 11 Bube, 12 Dame, 13 König, 14 Ass. Joker: "JB" (schwarz), "JR" (rot).
 * Bei mehr als einem Deck gibt es Karten doppelt: Das zweite Exemplar trägt dieselbe ID in
 * Kleinbuchstaben ("h7", "jb", "jr"). Für die Regeln sind beide Exemplare gleich.
 *
 * Decks (opts.decks): 1 = 54 Karten (bis 6 Spieler), 1.5 = 81 Karten (bis 9 Spieler; dazu kommen von
 * jedem Wert eine zufällige schwarze und eine zufällige rote Karte sowie ein schwarzer Joker, also
 * 2 schwarze + 1 roter Joker), 2 = 108 Karten (bis 12 Spieler; 2 schwarze + 2 rote Joker).
 *
 * Kurzfassung der Regeln, wie sie hier umgesetzt sind:
 *  - 54 Karten (bei mehr als 6 Spielern 81 oder 108, siehe oben). Jeder bekommt 3 verdeckte, 3 offene, 3 Handkarten; der Rest ist der Nachziehstapel.
 *  - Vor dem Start darf jeder genau eine Handkarte gegen eine offene Karte tauschen.
 *  - Startspieler zufällig, zunächst im Uhrzeigersinn (aufsteigende Sitze).
 *  - Legen: gleich hoch oder höher als die oberste Karte (3 < 4 < … < 10 < B < D < K < A);
 *    mehrere Karten gleichen Werts sind ein Zug. Die Sonderkarten 2, 7, 10 und Joker gehen immer
 *    (nur nicht auf einen Joker). Die 3 hat ihren normalen Wert (niedrigste Karte), danach passt alles.
 *  - Nach dem eigenen Zug auf 3 Handkarten nachziehen, solange der Nachziehstapel reicht.
 *  - Wer nicht legen kann, nimmt den ganzen Ablagestapel auf die Hand (zieht ggf. auf 3 auf) und
 *    spielt sofort selbst eine Karte aus der Hand auf den leeren Stapel.
 *  - Zonen: erst Hand, dann offene, dann verdeckte Karten. Kann man die LETZTE offene Karte nicht
 *    legen, kommt sie zusammen mit dem Stapel auf die Hand. Verdeckte Karten: eine pro Zug blind;
 *    passt sie nicht, kommt sie mit dem Stapel auf die Hand, danach sofort eine Handkarte spielen.
 *  - 3: Richtungswechsel; bei genau 2 (noch aktiven) Spielern ist der Leger sofort noch einmal dran.
 *  - 7: darf auf jede Karte (außer auf einen Joker); der nächste Spieler legt 3–7, eine 2, eine 10
 *    oder einen Joker.
 *  - 10: darf auf jede Karte (außer auf einen Joker), entfernt den Ablagestapel samt 10 dauerhaft;
 *    der nächste Spieler beginnt frei.
 *  - Joker: der nächste Spieler muss aufnehmen. Schwarz kann mit Rot gekontert werden (freiwillig),
 *    dann nimmt der Übernächste auf. Sonst darf nichts auf einen Joker (auch keine 2 oder 10).
 *    Ein Joker wirkt nur einmal: Beim Aufnehmen verschwindet er dauerhaft aus dem Spiel (wie die 10)
 *    und kommt NICHT mit auf die Hand. Aufgenommen wird nur der Stapel darunter.
 *  - Wer seine letzte Karte ablegt, ist fertig: Platz 1, 2, 3 … in dieser Reihenfolge. Gespielt wird,
 *    bis nur noch einer Karten hat – er ist der Verlierer und beginnt die nächste Runde.
 *  - Aufgeben: Sind nur noch zwei Spieler im Spiel, darf jeder der beiden jederzeit aufgeben. Er ist
 *    dann der Verlierer, der andere bekommt den nächsten freien Platz.
 *
 * Auslegungen, wo die PDF nichts sagt:
 *  - Mehrere 3er in einem Zug drehen die Richtung einmal (wie mehrere 10er nur einmal entfernen).
 *  - Freiwillig aufnehmen ist immer erlaubt, solange Karten im Ablagestapel liegen (taktischer Zug,
 *    um gute Karten zu behalten) – auch statt eine verdeckte Karte aufzudecken. Danach spielt man
 *    wie nach jedem Aufnehmen selbst aus. Die letzte offene Karte kommt nur dann mit auf die Hand,
 *    wenn sie nicht gepasst hätte.
 *  - Blind gegen einen Joker: bei Rot direkt aufnehmen; bei Schwarz aufnehmen oder aufdecken
 *    (ein aufgedeckter roter Joker kontert).
 *  - Joker auf leerem Stapel: der Nächste "nimmt auf" (nichts), der Joker ist weg, er spielt frei.
 *  - Sicherheitsnetz: Entsteht exakt dieselbe Stellung zum dritten Mal, wird geprüft, ob überhaupt
 *    noch ein Fortschritt erreichbar ist. Nur wenn nachweislich nicht, endet die Partie (deadlock).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KarmaEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SUITS = ['S', 'H', 'D', 'C'];
  var JB = 'JB', JR = 'JR';
  var HAND_SIZE = 3;

  var DECKS = [1, 1.5, 2];
  var MAX_PLAYERS = 12;
  function fullDeck() {
    var d = [];
    for (var s = 0; s < 4; s++) for (var r = 2; r <= 14; r++) d.push(SUITS[s] + r);
    d.push(JB, JR);
    return d;
  }
  function isBlackJoker(id) { return id === JB || id === 'jb'; }
  function isRedJoker(id) { return id === JR || id === 'jr'; }
  function isJoker(id) { return isBlackJoker(id) || isRedJoker(id); }
  function rank(id) { return isBlackJoker(id) ? 15 : isRedJoker(id) ? 16 : +id.slice(1); }
  function suit(id) { return isJoker(id) ? 'J' : id.charAt(0).toUpperCase(); }
  /* Wie viele Spieler ein Deck trägt (9 Karten pro Spieler) und welches Deck eine Runde mindestens braucht. */
  function maxPlayers(decks) { return decks === 2 ? 12 : decks === 1.5 ? 9 : 6; }
  function decksFor(n) { return n <= 6 ? 1 : n <= 9 ? 1.5 : 2; }
  function buildDeck(decks, rng) {
    var d = fullDeck(), r;
    if (decks === 1.5) {
      // Halbes Deck: von jedem Wert eine schwarze und eine rote Karte – so bleibt jeder Wert gleich häufig.
      for (r = 2; r <= 14; r++) {
        d.push((rng() < 0.5 ? 's' : 'c') + r);
        d.push((rng() < 0.5 ? 'h' : 'd') + r);
      }
      d.push('jb');
    } else if (decks === 2) {
      for (var s = 0; s < 4; s++) for (r = 2; r <= 14; r++) d.push(SUITS[s].toLowerCase() + r);
      d.push('jb', 'jr');
    }
    return d;
  }

  function defaultRng() {
    var c = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : null;
    if (!c) return Math.random();
    var a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] / 4294967296;
  }
  function shuffle(a, rng) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* players: [{name, bot}] (2–12). opts: {rng, decks (1 | 1.5 | 2; reicht das Deck nicht für alle, wird
   * das kleinste passende genommen), startSeat (sonst zufällig), startBy ('loser', wenn der Verlierer
   * der Vorrunde beginnt), holdStart (Runde beginnt erst mit startPlay()),
   * mixed (nur für die Anzeige: die Plätze wurden neu gemischt)} */
  function createGame(players, opts) {
    opts = opts || {};
    var n = players.length;
    if (!(n >= 2 && n <= MAX_PLAYERS)) throw new Error('Karma braucht 2 bis ' + MAX_PLAYERS + ' Spieler');
    var rng = opts.rng || defaultRng;
    var decks = DECKS.indexOf(opts.decks) >= 0 && n <= maxPlayers(opts.decks) ? opts.decks : decksFor(n);
    var deck = shuffle(buildDeck(decks, rng), rng);
    var ps = players.map(function (p) {
      return { name: String(p.name), bot: !!p.bot, hand: [], up: [], down: [], ready: false, swapped: false };
    });
    ['down', 'up', 'hand'].forEach(function (zone) {
      for (var k = 0; k < 3; k++) ps.forEach(function (p) { p[zone].push(deck.pop()); });
    });
    var start = opts.startSeat, startBy = opts.startBy === 'loser' ? 'loser' : 'set';
    if (typeof start !== 'number' || start % 1 !== 0 || start < 0 || start >= n) {
      start = Math.min(n - 1, Math.floor(rng() * n));
      startBy = 'random';
    }
    return {
      players: ps,
      decks: decks,         // 1, 1.5 oder 2
      mixed: !!opts.mixed,  // die Plätze wurden für diese Runde neu gemischt (nur für die Anzeige)
      holdStart: !!opts.holdStart,   // true: sind alle bereit, startet die Runde erst mit startPlay() (Host zählt herunter)
      phase: 'swap',        // 'swap' → 'play' → 'over'
      turn: -1,             // Sitz, der am Zug ist (nur in 'play')
      dir: 1,               // 1 = im Uhrzeigersinn (aufsteigende Sitze), -1 = gegen
      startSeat: start,
      startBy: startBy,     // 'random' (ausgelost), 'loser' (Verlierer der Vorrunde) oder 'set'
      pile: [],             // Ablagestapel, letzte Karte liegt oben
      stock: deck,          // Nachziehstapel (gezogen wird vom Ende)
      burned: [],           // dauerhaft aus dem Spiel: durch 10 entfernte Stapel und verbrauchte Joker
      finished: [],         // Sitze in der Reihenfolge, in der sie fertig wurden
      winner: null,         // erster fertiger Sitz
      loser: null,          // letzter Sitz mit Karten (bei regulärem Ende) bzw. wer aufgegeben hat
      gaveUp: null,         // Sitz, der aufgegeben hat
      deadlock: false,      // Partie wegen erzwungener Endlosschleife beendet
      freePlay: false,      // Spieler am Zug hat gerade aufgenommen und muss jetzt eine Handkarte spielen
      again: false,         // Spieler am Zug ist nach eigener 3 (zu zweit) noch einmal dran
      rep: {},              // Stellungszähler für das Endlosschleifen-Sicherheitsnetz
      repSig: '',
      repWait: 0,
      seq: 1,
      ev: { seq: 1, t: 'deal' }
    };
  }

  function topCard(s) { return s.pile.length ? s.pile[s.pile.length - 1] : null; }

  /* Darf `card` auf `top` gelegt werden? */
  function canPlayOn(card, top) {
    if (!top) return true;
    if (isRedJoker(top)) return false;       // roter Joker: nur aufnehmen
    if (isBlackJoker(top)) return isRedJoker(card);   // schwarzer Joker: nur ein roter Joker kontert (Schwarz auf Schwarz geht nicht)
    if (isJoker(card)) return true;          // Joker gehen sonst immer
    var r = rank(card), t = rank(top);
    if (r === 2 || r === 7 || r === 10) return true;   // Sonderkarten 2, 7 und 10 gehen auf alles
    if (t === 7) return r < 7;               // nach 7: 3–6 (2, 7, 10 und Joker s. o.)
    return r >= t;
  }

  function zoneOf(p) {
    if (p.hand.length) return 'hand';
    if (p.up.some(Boolean)) return 'up';
    if (p.down.some(Boolean)) return 'down';
    return null;                             // keine Karten mehr: fertig
  }
  function activeCount(s) {
    var c = 0;
    for (var i = 0; i < s.players.length; i++) if (zoneOf(s.players[i]) !== null) c++;
    return c;
  }
  /* Nächster Sitz in Spielrichtung, der noch Karten hat. */
  function nextSeat(s, seat) {
    var n = s.players.length;
    for (var i = 1; i <= n; i++) {
      var c = ((seat + s.dir * i) % n + n) % n;
      if (zoneOf(s.players[c]) !== null) return c;
    }
    return seat;
  }
  function refill(s, p) {
    var k = 0;
    while (p.hand.length < HAND_SIZE && s.stock.length) { p.hand.push(s.stock.pop()); k++; }
    return k;
  }

  /* Was verlangt die oberste Karte? Für die Anzeige. */
  function requirement(s) {
    var top = topCard(s);
    if (!top) return { k: 'any' };
    if (isRedJoker(top)) return { k: 'jokerR' };
    if (isBlackJoker(top)) return { k: 'jokerB' };
    var t = rank(top);
    if (t === 7) return { k: 'seven' };
    if (t <= 3) return { k: 'any' };         // auf 2 und 3 passt jede Karte
    return { k: 'min', rank: t };
  }

  /* Zugmöglichkeiten des Spielers am Zug, sonst null. */
  function options(s, seat) {
    if (s.phase !== 'play' || s.turn !== seat) return null;
    var p = s.players[seat], z = zoneOf(p), top = topCard(s);
    var o = { zone: z, playable: [], canPickup: false, canFlip: false, forced: false };
    if (z === 'down') {
      o.canFlip = !isRedJoker(top);
    } else {
      var cards = z === 'hand' ? p.hand : p.up.filter(Boolean);
      o.playable = cards.filter(function (c) { return canPlayOn(c, top); });
    }
    // Aufnehmen ist immer erlaubt, solange etwas im Ablagestapel liegt (auch freiwillig) – nur nicht im
    // Extra-Zug nach der eigenen 3: sonst könnte man "3 legen, aufnehmen, 3 legen …" endlos wiederholen,
    // ohne dass der Gegner je drankommt. (Auf eine 3 passt alles, erzwungen ist Aufnehmen dort nie.)
    o.canPickup = s.pile.length > 0 && !s.again;
    // forced: Es gibt keinen anderen Zug als aufzunehmen.
    o.forced = o.canPickup && !o.playable.length && !o.canFlip;
    return o;
  }

  function setEv(s, ev) { s.seq++; ev.seq = s.seq; s.ev = ev; }
  function fail(err) { return { ok: false, err: err }; }

  /* Endlosschleifen-Sicherheitsnetz. Die Regeln erlauben Schleifen ohne Ausweg (z. B. zwei Spieler,
   * die nur noch einen Joker auf der Hand hin- und herschieben: aufnehmen → Joker legen → aufnehmen …).
   * Entsteht exakt dieselbe Stellung zum dritten Mal, wird geprüft, ob von hier aus überhaupt noch ein
   * Fortschritt erreichbar ist (nachziehen, 10, Tischkarte gespielt/aufgenommen, jemand wird fertig).
   * Nur wenn nachweislich nicht, endet die Partie (deadlock). Solange ein Ausweg existiert, läuft sie weiter. */
  function positionKey(s) {
    return s.turn + '|' + s.dir + '|' + (s.freePlay ? 1 : 0) + (s.again ? 'a' : '') + '|' + s.pile.join(',') + '|' + s.players.map(function (p) {
      return p.hand.slice().sort().join(',') + '/' + p.up.join(',') + '/' + p.down.join(',');
    }).join('|');
  }
  function hashKey(str) {
    var h1 = 0x811c9dc5, h2 = 0x1b873593;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
    }
    return (h1 >>> 0).toString(36) + '.' + (h2 >>> 0).toString(36);
  }
  function progressSig(s) {
    var table = 0;
    s.players.forEach(function (p) {
      for (var i = 0; i < 3; i++) { if (p.up[i]) table++; if (p.down[i]) table++; }
    });
    return s.stock.length + ':' + s.burned.length + ':' + table + ':' + s.finished.length;
  }
  function trackRepetition(s) {
    if (s.phase !== 'play') return;
    var sig = progressSig(s);
    if (!s.rep || s.repSig !== sig) { s.rep = {}; s.repSig = sig; }
    var key = hashKey(positionKey(s));
    var c = s.rep[key] = (s.rep[key] || 0) + 1;
    if (c >= 2) s.ev.repeat = c;           // Hinweis für die Anzeige: die Stellung wiederholt sich
    if (c >= 3) {
      // Die Suche kostet Zeit: nach einem "es geht noch weiter" erst nach einigen Zügen erneut prüfen.
      if (!staticDead(s)) {
        if (s.seq < (s.repWait || 0)) return;
        if (canProgress(s)) { s.repWait = s.seq + 12; return; }
      }
      s.phase = 'over';
      s.deadlock = true;
      s.turn = -1;
      s.freePlay = false;
      s.again = false;
      s.ev.deadlock = true;
    }
  }
  /* Schneller, sicherer Nachweis einer Sackgasse (die Suche unten gibt bei vielen kreisenden Karten auf):
   * Nachziehstapel leer, keine 10 und kein Joker mehr im Umlauf (Hände + Ablagestapel), jeder Spieler hat
   * noch mindestens zwei offene Karten, und keine davon passt auf irgendeine kreisende Karte. Dann kann nie
   * wieder eine Tischkarte gespielt werden – es kreisen nur noch dieselben Karten. */
  function staticDead(s) {
    if (s.phase !== 'play' || s.stock.length) return false;
    var circ = s.pile.slice(), i, k, j;
    for (i = 0; i < s.players.length; i++) circ = circ.concat(s.players[i].hand);
    for (i = 0; i < circ.length; i++) if (isJoker(circ[i]) || rank(circ[i]) === 10) return false;
    for (i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      if (zoneOf(p) === null) continue;
      var up = p.up.filter(Boolean);
      if (up.length < 2) return false;
      for (k = 0; k < up.length; k++) for (j = 0; j < circ.length; j++) if (canPlayOn(up[k], circ[j])) return false;
    }
    return !(s.pile.length === 0 && s.players[s.turn].hand.length === 0);
  }
  /* Alle erlaubten Aktionen des Spielers am Zug (gleichwertige Karten eines Werts nur einmal je Anzahl). */
  function legalActions(s) {
    var seat = s.turn, o = options(s, seat), acts = [];
    if (!o) return acts;
    var p = s.players[seat];
    if (o.zone === 'down') {
      if (o.canFlip) for (var i = 0; i < 3; i++) if (p.down[i]) acts.push({ t: 'flip', slot: i });
    } else {
      var by = {};
      o.playable.forEach(function (c) { (by[rank(c)] = by[rank(c)] || []).push(c); });
      Object.keys(by).forEach(function (r) {
        var max = o.zone === 'up' ? 1 : by[r].length;   // offene Karten: nur eine pro Zug
        for (var k = 1; k <= max; k++) acts.push({ t: 'play', cards: by[r].slice(0, k) });
      });
    }
    if (o.canPickup) acts.push({ t: 'pickup' });
    return acts;
  }
  /* Ist von dieser Stellung aus noch irgendein unumkehrbarer Fortschritt erreichbar?
   * Breitensuche über alle Zugfolgen. Farben spielen für die Regeln keine Rolle, deshalb werden
   * Stellungen nur nach Kartenwerten unterschieden; Tischkarten und Nachziehstapel ändern sich ohne
   * Fortschritt nicht. Ist der Suchraum zu groß, gilt im Zweifel "es geht weiter". */
  function searchKey(x) {
    function ranks(a) { return a.map(rank).sort(function (m, n) { return m - n; }).join('.'); }
    return x.turn + '|' + x.dir + '|' + (x.freePlay ? 1 : 0) + (x.again ? 'a' : '') + '|' + (x.pile.length ? rank(x.pile[x.pile.length - 1]) : 0) + '|' +
      ranks(x.pile) + '|' + x.players.map(function (p) { return ranks(p.hand); }).join('|');
  }
  function liteClone(x) {
    return {
      players: x.players.map(function (p) {
        return { name: '', bot: false, hand: p.hand.slice(), up: p.up.slice(), down: p.down.slice(), ready: true, swapped: false };
      }),
      phase: 'play', turn: x.turn, dir: x.dir, startSeat: 0,
      pile: x.pile.slice(), stock: x.stock.slice(), burned: x.burned.slice(0, 0).concat(x.burned.length ? [x.burned[0]] : []),
      finished: x.finished.slice(), winner: x.winner, loser: null, gaveUp: null, deadlock: false, freePlay: !!x.freePlay, again: !!x.again,
      rep: null, repSig: '', seq: 0, ev: null
    };
  }
  function canProgress(s) {
    var LIMIT = 20000, root = liteClone(s), sig = progressSig(root), seen = {}, count = 0;
    var queue = [root];
    seen[searchKey(root)] = true;
    while (queue.length) {
      var cur = queue.pop(), acts = legalActions(cur);
      for (var i = 0; i < acts.length; i++) {
        var c = liteClone(cur);
        if (!applyTurn(c, c.turn, acts[i]).ok) continue;
        if (c.phase !== 'play' || progressSig(c) !== sig) return true;
        var k = searchKey(c);
        if (seen[k]) continue;
        seen[k] = true;
        if (++count > LIMIT) return true;
        queue.push(c);
      }
    }
    return false;
  }

  /* Karten liegen bereits nicht mehr in der Zone des Spielers. `active` = Spieler mit Karten vor dem Zug. */
  function resolvePlay(s, seat, cards, from, active, extra) {
    var p = s.players[seat];
    var counter = isBlackJoker(topCard(s)) && isRedJoker(cards[0]);
    for (var i = 0; i < cards.length; i++) s.pile.push(cards[i]);
    s.freePlay = false;
    var r = rank(cards[0]), fx = [], again = false;
    if (r === 10) {
      for (var b = 0; b < s.pile.length; b++) s.burned.push(s.pile[b]);
      s.pile = [];
      fx.push('burn');
    } else if (r === 3) {
      if (active > 2) { s.dir = -s.dir; fx.push('reverse'); }
      else again = true;
    } else if (isJoker(cards[0])) {
      fx.push(counter ? 'counter' : 'joker');
    }
    var ev = { t: 'play', seat: seat, cards: cards.slice(), from: from, fx: fx, drew: refill(s, p) };
    if (extra) for (var k in extra) ev[k] = extra[k];
    if (zoneOf(p) === null) {
      s.finished.push(seat);
      ev.place = s.finished.length;
      if (s.winner === null) { s.winner = seat; fx.push('win'); } else fx.push('out');
      again = false;
    }
    if (again) fx.push('again');
    s.again = again;
    if (activeCount(s) <= 1) {
      s.phase = 'over';
      s.turn = -1;
      s.loser = null;
      for (var q = 0; q < s.players.length; q++) if (zoneOf(s.players[q]) !== null) s.loser = q;
      fx.push('over');
    } else {
      s.turn = again ? seat : nextSeat(s, seat);
    }
    setEv(s, ev);
  }

  /* Stapel (+ Zusatzkarte) auf die Hand; der Spieler bleibt am Zug und spielt danach selbst aus.
   * Joker im Stapel sind verbraucht: Sie verschwinden aus dem Spiel und kommen nicht auf die Hand.
   * Rückgabe {n: aufgenommene Stapelkarten, gone: [entfernte Joker]}. */
  function takePile(s, seat, extraCard) {
    var p = s.players[seat], n = 0, gone = [];
    for (var i = 0; i < s.pile.length; i++) {
      var c = s.pile[i];
      if (isJoker(c)) { s.burned.push(c); gone.push(c); } else { p.hand.push(c); n++; }
    }
    if (extraCard) p.hand.push(extraCard);
    s.pile = [];
    s.freePlay = true;
    s.again = false;
    return { n: n, gone: gone };
  }

  function validSeat(s, seat) {
    return typeof seat === 'number' && seat % 1 === 0 && seat >= 0 && seat < s.players.length;
  }
  /* Aufgeben ist möglich, sobald nur noch zwei Spieler Karten haben – für jeden der beiden, jederzeit. */
  function canGiveUp(s, seat) {
    return s.phase === 'play' && validSeat(s, seat) &&
      zoneOf(s.players[seat]) !== null && activeCount(s) === 2;
  }
  function applyGiveUp(s, seat) {
    if (!canGiveUp(s, seat)) return fail('cannot-giveup');
    var other = -1;
    for (var q = 0; q < s.players.length; q++) if (q !== seat && zoneOf(s.players[q]) !== null) other = q;
    s.finished.push(other);
    var fx = [];
    if (s.winner === null) { s.winner = other; fx.push('win'); } else fx.push('out');
    fx.push('over');
    s.loser = seat;
    s.gaveUp = seat;
    s.phase = 'over';
    s.turn = -1;
    s.freePlay = false;
    s.again = false;
    setEv(s, { t: 'giveup', seat: seat, other: other, place: s.finished.length, fx: fx });
    return { ok: true };
  }

  /* Aktionen:
   *  {t:'ready', swap?: {hand: cardId, up: slot 0..2}}   Tauschphase: optional 1:1 tauschen, dann bereit
   *  {t:'unready'}                                       Tauschphase: „bereit“ zurücknehmen, der eigene Tausch wird rückgängig
   *  {t:'play', cards: [cardId,...]}                     eine oder mehrere Karten gleichen Werts
   *  {t:'flip', slot: 0..2}                              verdeckte Karte blind spielen
   *  {t:'pickup'}                                        Ablagestapel aufnehmen
   *  {t:'giveup'}                                        aufgeben (nur bei zwei verbliebenen Spielern, auch außerhalb des eigenen Zugs)
   * Rückgabe {ok:true} oder {ok:false, err}. Verändert `s` nur bei ok.
   */
  function applyAction(s, seat, a) {
    if (!a || typeof a !== 'object') return fail('bad-action');
    if (typeof seat !== 'number' || seat % 1 !== 0 || seat < 0 || seat >= s.players.length) return fail('bad-seat');
    if (a.t === 'ready') return applyReady(s, seat, a);
    if (a.t === 'unready') return applyUnready(s, seat);
    if (s.phase !== 'play') return fail('wrong-phase');
    if (a.t === 'giveup') return applyGiveUp(s, seat);
    if (s.turn !== seat) return fail('not-your-turn');
    var res = applyTurn(s, seat, a);
    if (res.ok) trackRepetition(s);
    return res;
  }

  function applyReady(s, seat, a) {
    var p = s.players[seat];
    if (s.phase !== 'swap') return fail('wrong-phase');
    if (p.ready) return fail('already-ready');
    var swapInfo = null;
    if (a.swap) {
      var hi = p.hand.indexOf(a.swap.hand), sl = a.swap.up;
      if (hi < 0 || !(sl === 0 || sl === 1 || sl === 2) || !p.up[sl]) return fail('bad-swap');
      var tmp = p.hand[hi]; p.hand[hi] = p.up[sl]; p.up[sl] = tmp;
      p.swapped = true;
      p.swap = { slot: sl, was: p.hand[hi] };   // was = die Karte, die vorher offen lag (jetzt auf der Hand)
      swapInfo = { slot: sl };
    }
    p.ready = true;
    var all = allReady(s);
    if (all && !s.holdStart) { s.phase = 'play'; s.turn = s.startSeat; }
    var ev = { t: all && !s.holdStart ? 'start' : 'ready', seat: seat, swap: swapInfo };
    if (all && s.holdStart) ev.all = true;
    setEv(s, ev);
    return { ok: true };
  }
  function allReady(s) { return s.players.every(function (q) { return q.ready; }); }
  /* „Bereit“ zurücknehmen, solange die Runde nicht läuft. Der eigene Tausch wird dabei rückgängig gemacht. */
  function applyUnready(s, seat) {
    var p = s.players[seat];
    if (s.phase !== 'swap') return fail('wrong-phase');
    if (!p.ready) return fail('not-ready');
    var swapInfo = null;
    if (p.swap) {
      var sl = p.swap.slot, hi = p.hand.indexOf(p.swap.was);
      if (hi >= 0 && p.up[sl]) { var tmp = p.hand[hi]; p.hand[hi] = p.up[sl]; p.up[sl] = tmp; swapInfo = { slot: sl }; }
    }
    p.swap = null;
    p.swapped = false;
    p.ready = false;
    setEv(s, { t: 'unready', seat: seat, swap: swapInfo });
    return { ok: true };
  }
  /* Runde beginnen (nur mit holdStart nötig). force: auch wenn nicht alle bereit sind – wer noch
   * nicht bereit war, spielt mit den Karten, die er hat. */
  function startPlay(s, force) {
    if (s.phase !== 'swap') return fail('wrong-phase');
    if (!force && !allReady(s)) return fail('not-ready');
    s.players.forEach(function (q) { q.ready = true; });
    s.phase = 'play';
    s.turn = s.startSeat;
    setEv(s, { t: 'start', seat: -1, swap: null, forced: !!force });
    return { ok: true };
  }

  function applyTurn(s, seat, a) {
    var p = s.players[seat];
    var o = options(s, seat);
    var active = activeCount(s);

    if (a.t === 'play') {
      var cards = a.cards;
      if (!Array.isArray(cards) || !cards.length || cards.length > 8) return fail('no-cards');
      if (o.zone !== 'hand' && o.zone !== 'up') return fail('must-flip');
      // Von den offenen Tischkarten darf pro Zug nur eine gelegt werden – auch bei gleichen Werten.
      if (o.zone === 'up' && cards.length > 1) return fail('one-up');
      var src = o.zone === 'hand' ? p.hand : p.up;
      var r0 = null;
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        if (typeof c !== 'string' || src.indexOf(c) < 0 || cards.indexOf(c) !== i) return fail('not-in-zone');
        if (r0 === null) r0 = rank(c); else if (rank(c) !== r0) return fail('mixed-ranks');
      }
      if (!canPlayOn(cards[0], topCard(s))) return fail('not-playable');
      cards = cards.slice();
      cards.forEach(function (c) {
        var ix = src.indexOf(c);
        if (o.zone === 'hand') src.splice(ix, 1); else src[ix] = null;
      });
      resolvePlay(s, seat, cards, o.zone, active);
      return { ok: true };
    }

    if (a.t === 'flip') {
      if (o.zone !== 'down') return fail('not-blind');
      if (!o.canFlip) return fail('must-pickup');
      var slot = a.slot;
      if (!(slot === 0 || slot === 1 || slot === 2) || !p.down[slot]) return fail('bad-slot');
      var card = p.down[slot];
      p.down[slot] = null;
      if (canPlayOn(card, topCard(s))) {
        resolvePlay(s, seat, [card], 'down', active, { slot: slot });
      } else {
        var ft = takePile(s, seat, card);
        setEv(s, { t: 'flipfail', seat: seat, card: card, slot: slot, n: ft.n + 1, gone: ft.gone, drew: refill(s, p) });
      }
      return { ok: true };
    }

    if (a.t === 'pickup') {
      if (!o.canPickup) return fail('cannot-pickup');
      var top = topCard(s), lastUp = null, lastSlot = -1;
      if (o.zone === 'up') {
        // Letzte offene Karte, die nicht passt: sie kommt zusammen mit dem Stapel auf die Hand.
        var left = p.up.filter(Boolean);
        if (left.length === 1 && !canPlayOn(left[0], top)) { lastUp = left[0]; lastSlot = p.up.indexOf(lastUp); p.up[lastSlot] = null; }
      }
      var tk = takePile(s, seat, lastUp);
      var pev = { t: 'pickup', seat: seat, n: tk.n, joker: isJoker(top), vol: !o.forced, gone: tk.gone, drew: refill(s, p) };
      if (lastUp) { pev.upCard = lastUp; pev.slot = lastSlot; }
      setEv(s, pev);
      return { ok: true };
    }

    return fail('bad-action');
  }

  /* Sicht eines Spielers: fremde Handkarten, alle verdeckten Karten und der Nachziehstapel bleiben geheim. */
  function viewFor(s, seat) {
    var ev = JSON.parse(JSON.stringify(s.ev));
    // Eine verdeckte Karte, die nicht passt, sieht nur ihr Besitzer: sie geht mit dem Stapel auf seine Hand.
    if (ev && ev.t === 'flipfail' && ev.seat !== seat) ev.card = null;
    return {
      phase: s.phase,
      decks: s.decks || 1,
      mixed: !!s.mixed,
      allReady: s.phase === 'swap' && allReady(s),
      you: seat,
      turn: s.turn,
      dir: s.dir,
      startSeat: s.startSeat,
      startBy: s.startBy || 'random',
      pile: s.pile.slice(),
      stock: s.stock.length,
      burned: s.burned.length,
      finished: s.finished.slice(),
      winner: s.winner,
      loser: s.loser,
      gaveUp: typeof s.gaveUp === 'number' ? s.gaveUp : null,
      canGiveUp: canGiveUp(s, seat),
      deadlock: !!s.deadlock,
      freePlay: !!s.freePlay,
      again: !!s.again,
      req: requirement(s),
      seq: s.seq,
      ev: ev,
      players: s.players.map(function (p, i) {
        return {
          name: p.name,
          bot: p.bot,
          n: p.hand.length,
          hand: i === seat ? p.hand.slice() : null,
          up: p.up.slice(),
          down: p.down.map(Boolean),
          ready: p.ready,
          zone: zoneOf(p),
          place: s.finished.indexOf(i) + 1     // 0 = noch im Spiel
        };
      }),
      my: validSeat(s, seat) ? options(s, seat) : null
    };
  }

  /* Einfacher Bot: legt die schwächste passende Karte, spart Sonderkarten auf. */
  function botValue(c) {
    var r = rank(c);
    if (r === 2) return 20;
    if (r === 10) return 21;
    if (r === 15) return 22;
    if (r === 16) return 23;
    return r;
  }
  function botAction(s, seat) {
    var p = s.players[seat];
    if (!p) return null;
    if (s.phase === 'swap') {
      if (p.ready) return null;
      var best = null, worst = -1;
      p.hand.forEach(function (c) { if (best === null || botValue(c) > botValue(best)) best = c; });
      p.up.forEach(function (c, i) { if (c && (worst < 0 || botValue(c) < botValue(p.up[worst]))) worst = i; });
      if (best !== null && worst >= 0 && botValue(best) > botValue(p.up[worst])) {
        return { t: 'ready', swap: { hand: best, up: worst } };
      }
      return { t: 'ready' };
    }
    var o = options(s, seat);
    if (!o) return null;
    if (o.zone === 'down') {
      if (o.canFlip) {
        for (var i = 0; i < 3; i++) if (p.down[i]) return { t: 'flip', slot: i };
      }
      return { t: 'pickup' };
    }
    if (!o.playable.length) return { t: 'pickup' };
    var pick = o.playable[0];
    o.playable.forEach(function (c) { if (botValue(c) < botValue(pick)) pick = c; });
    // Wiederholt sich die Stellung (oder zieht sich die Partie sehr lang), spielt der Bot zufällig
    // etwas anderes – das bricht Schleifen, in die feste Strategien sonst geraten.
    var looping = s.rep && s.rep[hashKey(positionKey(s))] >= 2;
    if (looping) {
      // Erst unter den Legezügen würfeln; aufnehmen kommt erst dazu, wenn die Stellung schon dreimal da war.
      var acts = legalActions(s);
      if (s.rep[hashKey(positionKey(s))] < 3) acts = acts.filter(function (x) { return x.t !== 'pickup'; });
      if (acts.length) return acts[Math.floor(Math.random() * acts.length)];
    }
    var cards = [pick];
    if (botValue(pick) < 20 && o.zone === 'hand') {   // mehrere gleiche nur aus der Hand
      cards = p.hand.filter(function (c) { return rank(c) === rank(pick); });
    }
    return { t: 'play', cards: cards };
  }

  /* Zug, den der Timer für einen Spieler macht, dessen Zeit abgelaufen ist: die niedrigste passende Karte
   * (einzeln), Sonderkarten 2, 7, 10 und Joker erst, wenn nichts anderes geht. Passt nichts: aufnehmen.
   * Bei verdeckten Karten wird eine zufällige aufgedeckt. Dreht sich die Partie im Kreis, wird gewürfelt. */
  function autoValue(c) {
    var r = rank(c);
    if (r === 2) return 20;
    if (r === 7) return 21;
    if (r === 10) return 22;
    if (r >= 15) return 8 + r;   // schwarzer Joker 23, roter 24
    return r;
  }
  function autoAction(s, seat, rng) {
    var p = s.players[seat], o = options(s, seat);
    if (!p || !o) return null;
    if (o.zone === 'down') {
      if (!o.canFlip) return o.canPickup ? { t: 'pickup' } : null;
      var slots = [];
      for (var i = 0; i < 3; i++) if (p.down[i]) slots.push(i);
      return { t: 'flip', slot: slots[Math.min(slots.length - 1, Math.floor((rng || Math.random)() * slots.length))] };
    }
    if (!o.playable.length) return o.canPickup ? { t: 'pickup' } : null;
    // Wiederholt sich die Stellung (z. B. alle sind weg und der Timer spielt allein), wird gewürfelt:
    // Eine feste Regel würde sich sonst endlos im Kreis drehen.
    if (s.rep && s.rep[hashKey(positionKey(s))] >= 2) {
      var acts = legalActions(s).filter(function (x) { return x.t !== 'play' || x.cards.length === 1; });
      if (acts.length) return acts[Math.min(acts.length - 1, Math.floor((rng || Math.random)() * acts.length))];
    }
    var pick = o.playable[0];
    o.playable.forEach(function (c) { if (autoValue(c) < autoValue(pick)) pick = c; });
    return { t: 'play', cards: [pick] };
  }

  return {
    SUITS: SUITS, JB: JB, JR: JR, HAND_SIZE: HAND_SIZE, DECKS: DECKS, MAX_PLAYERS: MAX_PLAYERS,
    fullDeck: fullDeck, buildDeck: buildDeck, maxPlayers: maxPlayers, decksFor: decksFor,
    rank: rank, suit: suit, isJoker: isJoker, isRedJoker: isRedJoker, isBlackJoker: isBlackJoker,
    createGame: createGame, applyAction: applyAction, viewFor: viewFor,
    options: options, requirement: requirement, canPlayOn: canPlayOn,
    topCard: topCard, zoneOf: zoneOf, nextSeat: nextSeat, activeCount: activeCount,
    legalActions: legalActions, botAction: botAction, canGiveUp: canGiveUp,
    startPlay: startPlay, autoAction: autoAction
  };
});
