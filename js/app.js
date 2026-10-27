// Państwa-Miasta — kontroler aplikacji: ekrany, akcje gracza i logika gospodarza.
// Gospodarz (osoba, która założyła grę) trzyma oficjalny stan gry i rozsyła go wszystkim.
// Pozostali gracze wysyłają do niego tylko swoje akcje: dołączenie, Stop, odpowiedzi, głosy.

import { CONFIG } from './config.js';
import * as G from './game.js';
import { createTransport } from './net.js';
import { quickCheck, onlineCheck, resultKey } from './validator.js';

const params = new URLSearchParams(location.search);
const LOCAL = params.has('local') || !CONFIG.SUPABASE_URL;
const ONLINE_CHECK = CONFIG.ONLINE_CHECK && !params.has('offline');
const REVEAL_MS = 3200;

// W trybie lokalnym każda karta to osobny gracz, więc tożsamość trzymamy per karta.
const backing = LOCAL ? sessionStorage : localStorage;
const store = {
  get(k, d = null) {
    try { const v = backing.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { backing.setItem(k, JSON.stringify(v)); } catch { /* brak miejsca / tryb prywatny */ } },
  del(k) { try { backing.removeItem(k); } catch { /* ignore */ } },
};

const me = { id: store.get('pm-id') || G.uid(), name: store.get('pm-name') || '' };
store.set('pm-id', me.id);

let net = null;
let conn = 'idle'; // idle | connecting | online | offline
let session = null; // { code, host, t }
let state = null; // stan gry (u gospodarza — oficjalny)
let offset = 0; // różnica zegara: czas gospodarza − nasz
let presence = new Set();
let host = null; // dane robocze gospodarza: { collected, collectAt, reasked }
const ui = {
  error: '',
  toast: '',
  toastTimer: 0,
  joinTimer: 0,
  joinTries: 0,
  sentFor: '',
  mounted: '',
  revealSpin: 0,
  hostGoneSince: 0,
  lastJoinSent: 0,
};

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isHost = () => !!session?.host;
const hostNow = () => Date.now() + offset;
const pname = (id) => state?.players?.[id]?.name || 'Ktoś';
const hostName = () => pname(state?.hostId);

// ---------------------------------------------------------------- odpowiedzi gracza

function ansKey(round = state?.round) { return `pm-ans-${session?.code}-${state?.gameId || 0}-${round}`; }
// Usuwa odpowiedzi z wcześniejszych rozgrywek (np. po „Zagraj jeszcze raz” z tym samym kodem).
function pruneAnswers() {
  const keep = `pm-ans-${session?.code}-${state?.gameId || 0}-`;
  try {
    for (let i = backing.length - 1; i >= 0; i--) {
      const k = backing.key(i);
      if (k && k.startsWith('pm-ans-') && !k.startsWith(keep)) backing.removeItem(k);
    }
  } catch { /* ignore */ }
}
function myAnswers() { return store.get(ansKey(), {}) || {}; }
function saveAnswer(cat, value) {
  const a = myAnswers();
  a[cat] = G.clean(value);
  store.set(ansKey(), a);
}
function allFilled(answers = myAnswers()) {
  return state.settings.categories.every((c) => G.isFilled(answers[c.id], state.letter));
}

// ---------------------------------------------------------------- połączenie

async function connect(code, asHost) {
  disconnect(false);
  session = { code, host: asHost, t: Date.now() };
  store.set('pm-session', session);
  conn = 'connecting';
  ui.error = '';
  render();
  try {
    net = await createTransport({ code, me, local: LOCAL, onMessage, onPresence, onStatus });
  } catch {
    leaveToHome('Nie udało się wczytać modułu gry online. Sprawdź internet i odśwież stronę.');
  }
}

function disconnect(clearSession = true) {
  clearTimeout(ui.joinTimer);
  if (net) { try { net.close(); } catch { /* ignore */ } }
  net = null;
  conn = 'idle';
  presence = new Set();
  if (clearSession) {
    session = null;
    state = null;
    host = null;
    store.del('pm-session');
  }
}

function send(msg) {
  try { net?.send(msg); } catch { /* przy zerwanym połączeniu wyślemy ponownie po powrocie */ }
}

function onStatus(status, err) {
  if (status === 'SUBSCRIBED') {
    conn = 'online';
    if (isHost()) {
      commit();
    } else {
      sendJoin(true);
      if (!state) armJoinTimer();
    }
  } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
    if (!net) return;
    conn = 'offline';
    const msg = String(err?.message || err || '');
    if (!state && /unauthori|permission|private/i.test(msg)) {
      leaveToHome('Serwer odrzucił połączenie. W Supabase włącz „Allow public access” w ustawieniach Realtime.');
      return;
    }
  }
  renderStatus();
}

function sendJoin(force) {
  const t = Date.now();
  if (!force && t - ui.lastJoinSent < 1500) return;
  ui.lastJoinSent = t;
  send({ t: 'join', name: me.name });
  send({ t: 'hello' });
}

function armJoinTimer() {
  clearTimeout(ui.joinTimer);
  ui.joinTries = 0;
  const step = () => {
    if (state) return;
    ui.joinTries++;
    if (ui.joinTries >= 4) {
      leaveToHome(`Nie widzę gry o kodzie ${session.code}. Sprawdź kod albo poproś gospodarza, żeby nie zamykał gry.`);
      return;
    }
    sendJoin(true);
    ui.joinTimer = setTimeout(step, 2500);
  };
  ui.joinTimer = setTimeout(step, 2500);
}

function onPresence(ids) {
  presence = new Set(ids);
  if (isHost() && state) {
    let changed = false;
    for (const id of state.order) {
      const on = id === me.id || presence.has(id);
      if (state.players[id] && state.players[id].online !== on) {
        state.players[id].online = on;
        changed = true;
      }
    }
    if (changed) commitSoon();
  }
  if (!isHost() && state) {
    const hostHere = presence.has(state.hostId);
    if (hostHere) ui.hostGoneSince = 0;
    else if (!ui.hostGoneSince) ui.hostGoneSince = Date.now();
  }
  renderLive();
}

function onMessage(m) {
  if (!m || !session) return;
  if (isHost()) { hostHandle(m); return; }
  if (m.t === 'state') applyRemoteState(m.state);
}

function applyRemoteState(s) {
  if (!s || s.code !== session.code) return;
  if (state && s.hostId === state.hostId && s.v < state.v) return;
  offset = s.now - Date.now();
  state = s;
  clearTimeout(ui.joinTimer);
  if (!state.players[me.id] || state.players[me.id].left) sendJoin(false);
  if (state.phase === 'collecting') sendAnswersOnce();
  if (state.phase === 'closed') {
    disconnect(true);
    ui.error = 'Gospodarz zakończył grę.';
  }
  render();
}

function sendAnswersOnce() {
  const tag = state.round + ':' + state.v;
  if (ui.sentFor === tag) return;
  ui.sentFor = tag;
  send({ t: 'answers', round: state.round, answers: myAnswers() });
}

// ---------------------------------------------------------------- gospodarz

let commitTimer = 0;
function commit() {
  clearTimeout(commitTimer);
  if (!state) return;
  state.v++;
  state.now = Date.now();
  store.set('pm-host-' + state.code, { state, host });
  send({ t: 'state', state });
  render();
}
function commitSoon() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commit, 120);
}
function rebroadcast() {
  state.now = Date.now();
  send({ t: 'state', state });
}

function freshHostData() { return { collected: {}, collectAt: 0, reasked: false }; }

function hostCreate() {
  const code = G.makeCode();
  state = G.newGame(code, me);
  host = freshHostData();
  connect(code, true);
}

function hostHandle(m) {
  if (!state || !m.from || m.from === me.id) return;
  const p = state.players[m.from];
  switch (m.t) {
    case 'hello':
      rebroadcast();
      break;
    case 'join': {
      if (p && !p.left) {
        p.online = true;
        rebroadcast();
        break;
      }
      state.players[m.from] = {
        name: G.uniqueName(m.name, state.players, m.from),
        score: p?.score || 0,
        online: true,
      };
      if (!state.order.includes(m.from)) state.order.push(m.from);
      commit();
      break;
    }
    case 'leave':
      removePlayer(m.from);
      break;
    case 'stop':
      hostStop(m.from);
      break;
    case 'answers':
      if (m.round === state.round && (state.phase === 'playing' || state.phase === 'collecting')) {
        host.collected[m.from] = sanitizeAnswers(m.answers);
        if (state.phase === 'collecting') maybeFinishCollecting();
      }
      break;
    case 'vote':
      hostVote(m.from, m.target, m.cat, m.v);
      break;
    default:
      break;
  }
}

function sanitizeAnswers(a) {
  const out = {};
  for (const c of state.settings.categories) out[c.id] = G.clean(a?.[c.id]);
  return out;
}

function removePlayer(id) {
  if (!state.players[id] || id === state.hostId) return;
  if (state.phase === 'lobby') {
    delete state.players[id];
    state.order = state.order.filter((x) => x !== id);
  } else {
    state.players[id].left = true;
  }
  commit();
}

function hostStartGame() {
  if (state.phase !== 'lobby' && state.phase !== 'final') return;
  state.gameId = G.uid().slice(0, 8);
  for (const id of state.order) state.players[id].score = 0;
  state.history = [];
  state.usedLetters = [];
  state.round = 0;
  hostStartRound();
}

function hostStartRound() {
  state.round += 1;
  state.letter = G.drawLetter(state.usedLetters);
  state.usedLetters.push(state.letter);
  state.startAt = Date.now() + REVEAL_MS;
  state.endsAt = 0;
  state.stopBy = null;
  state.done = [];
  state.check = null;
  state.phase = 'playing';
  host = freshHostData();
  commit();
}

function hostStop(pid) {
  if (state.phase !== 'playing' || Date.now() < state.startAt) return;
  if (pid && !state.done.includes(pid)) state.done.push(pid);
  if (!state.endsAt) {
    state.endsAt = Date.now() + state.settings.countdown * 1000;
    state.stopBy = pid || null;
  }
  // Wszyscy obecni skończyli — nie ma na co czekać.
  const present = G.activePlayers(state).filter((id) => id === me.id || presence.has(id));
  if (present.every((id) => state.done.includes(id))) {
    state.endsAt = Math.min(state.endsAt, Date.now() + 1500);
  }
  commit();
}

function hostTick() {
  if (!isHost() || !state) return;
  const t = Date.now();
  if (state.phase === 'playing' && state.endsAt && t >= state.endsAt) {
    state.phase = 'collecting';
    host.collectAt = t;
    host.reasked = false;
    host.collected[me.id] = myAnswers();
    commit();
    return;
  }
  if (state.phase === 'collecting') {
    maybeFinishCollecting();
    if (state.phase === 'collecting' && !host.reasked && t - host.collectAt > 2500) {
      host.reasked = true;
      commit(); // nowa wersja stanu = prośba o ponowne przesłanie odpowiedzi
    }
  }
}

function maybeFinishCollecting() {
  if (state.phase !== 'collecting') return;
  const need = G.activePlayers(state).filter((id) => id === me.id || presence.has(id));
  const all = need.every((id) => host.collected[id]);
  if (all || Date.now() - host.collectAt > 7000) hostStartChecking();
}

function hostStartChecking() {
  host.collected[me.id] = myAnswers();
  const pids = G.activePlayers(state);
  const cats = state.settings.categories;
  const answers = {};
  const auto = {};
  const pending = [];
  for (const p of pids) {
    answers[p] = {};
    auto[p] = {};
    const src = host.collected[p] || {};
    for (const c of cats) {
      const a = G.clean(src[c.id]);
      answers[p][c.id] = a;
      let st = quickCheck(a, state.letter, c.id);
      if (st === 'pending' && !ONLINE_CHECK) st = 'unknown';
      auto[p][c.id] = st;
      if (st === 'pending') pending.push({ p, cat: c.id, answer: a });
    }
  }
  state.check = { pids, answers, auto, votes: {}, validating: pending.length > 0, strict: !!state.settings.strict, offline: false };
  state.phase = 'checking';
  commit();
  if (pending.length) runOnlineCheck();
}

async function runOnlineCheck() {
  const round = state.round;
  const pending = [];
  for (const p of state.check.pids) {
    for (const c of state.settings.categories) {
      if (state.check.auto[p][c.id] === 'pending') pending.push({ p, cat: c.id, answer: state.check.answers[p][c.id] });
    }
  }
  if (!pending.length) return;
  state.check.validating = true;
  const { result: res, offline } = await onlineCheck(pending.map((x) => ({ cat: x.cat, answer: x.answer })));
  if (!state || state.phase !== 'checking' || state.round !== round) return;
  for (const x of pending) {
    if (state.check.auto[x.p][x.cat] === 'pending') {
      state.check.auto[x.p][x.cat] = res.get(resultKey(x.cat, x.answer)) || 'unknown';
    }
  }
  state.check.validating = false;
  state.check.offline = offline;
  commit();
}

function hostVote(voter, target, cat, v) {
  if (state.phase !== 'checking' || voter === target) return;
  const st = state.check.auto[target]?.[cat];
  if (!G.canVote(st)) return;
  state.check.votes[target] ??= {};
  state.check.votes[target][cat] ??= {};
  const cell = state.check.votes[target][cat];
  if (!v || cell[voter] === v) delete cell[voter];
  else cell[voter] = v > 0 ? 1 : -1;
  commit();
}

function hostConfirm() {
  if (state.phase !== 'checking' || state.check.validating) return;
  // Odpowiedzi, których nie zdążyliśmy sprawdzić online, zostają do oceny przez głosy.
  for (const p of state.check.pids) {
    for (const c of state.settings.categories) {
      if (state.check.auto[p][c.id] === 'pending') state.check.auto[p][c.id] = 'unknown';
    }
  }
  state.check.validating = false;
  const { cells, totals } = G.scoreRound(state.check.pids, state.settings.categories, state.check);
  state.check.points = cells;
  for (const p of state.check.pids) {
    if (state.players[p]) state.players[p].score = (state.players[p].score || 0) + totals[p];
  }
  state.history.push({ round: state.round, letter: state.letter, totals });
  state.phase = 'summary';
  commit();
}

function hostNext() {
  if (state.phase !== 'summary') return;
  if (state.round >= state.settings.rounds) {
    state.phase = 'final';
    commit();
  } else {
    hostStartRound();
  }
}

function hostPlayAgain() {
  for (const id of state.order) {
    if (state.players[id].left) {
      delete state.players[id];
    } else {
      state.players[id].score = 0;
    }
  }
  state.order = state.order.filter((id) => state.players[id]);
  state.history = [];
  state.usedLetters = [];
  state.round = 0;
  state.check = null;
  state.phase = 'lobby';
  commit();
}

// Ustawienia (tylko gospodarz, w poczekalni)
function allCategoryOptions() {
  return [...G.PRESET_CATEGORIES.map((c) => ({ id: c.id, name: c.name, auto: c.auto })),
    ...(state.settings.custom || []).map((c) => ({ ...c, auto: false }))];
}
function setSelectedCategories(ids) {
  state.settings.categories = allCategoryOptions()
    .filter((o) => ids.has(o.id))
    .map((o) => (o.custom ? { id: o.id, name: o.name, custom: true } : { id: o.id, name: o.name }));
}

// ---------------------------------------------------------------- akcje

const actions = {
  create() {
    if (!readName()) return;
    hostCreate();
  },
  join() {
    if (!readName()) return;
    const code = G.normalizeCode(document.getElementById('code')?.value);
    if (code.length !== 4) {
      showHomeError('Kod gry ma 4 litery.');
      return;
    }
    connect(code, false);
  },
  resume() {
    const s = store.get('pm-session');
    if (s) resumeSession(s);
  },
  cancel() { leaveToHome(''); },
  leave() {
    if (isHost() && state && state.phase !== 'final') {
      if (!confirm('Jesteś gospodarzem. Jeśli wyjdziesz, gra skończy się dla wszystkich. Wyjść?')) return;
    } else if (!isHost() && state && state.phase !== 'final' && state.phase !== 'lobby') {
      if (!confirm('Na pewno wyjść z gry?')) return;
    }
    if (isHost() && state) {
      state.phase = 'closed';
      commit();
      store.del('pm-host-' + state.code);
    } else {
      send({ t: 'leave' });
    }
    setTimeout(() => leaveToHome(''), 150);
  },
  share() { shareGame(); },
  copy() {
    copyText(session.code).then((ok) => toast(ok ? 'Skopiowano kod' : 'Nie udało się skopiować'));
  },
  rounds(btn) {
    const d = Number(btn.dataset.d);
    state.settings.rounds = Math.min(G.MAX_ROUNDS, Math.max(1, state.settings.rounds + d));
    commit();
  },
  strict(btn) {
    state.settings.strict = btn.dataset.v === '1';
    commit();
  },
  countdown(btn) {
    state.settings.countdown = Number(btn.dataset.s);
    commit();
  },
  cat(btn) {
    const id = btn.dataset.id;
    const ids = new Set(state.settings.categories.map((c) => c.id));
    if (ids.has(id)) {
      if (ids.size <= G.MIN_CATEGORIES) { toast(`Minimum ${G.MIN_CATEGORIES} kategorie`); return; }
      ids.delete(id);
    } else {
      if (ids.size >= G.MAX_CATEGORIES) { toast(`Maksimum ${G.MAX_CATEGORIES} kategorii`); return; }
      ids.add(id);
    }
    setSelectedCategories(ids);
    commit();
  },
  addcat() {
    const input = document.getElementById('newcat');
    const name = G.clean(input?.value).slice(0, 24);
    if (!name) return;
    const exists = allCategoryOptions().find((o) => G.fold(o.name) === G.fold(name));
    const ids = new Set(state.settings.categories.map((c) => c.id));
    if (exists) {
      ids.add(exists.id);
    } else {
      if (ids.size >= G.MAX_CATEGORIES) { toast(`Maksimum ${G.MAX_CATEGORIES} kategorii`); return; }
      const c = G.customCategory(name);
      state.settings.custom = [...(state.settings.custom || []), c];
      ids.add(c.id);
    }
    input.value = '';
    setSelectedCategories(ids);
    commit();
  },
  kick(btn) { removePlayer(btn.dataset.id); },
  start() {
    if (G.activePlayers(state).length < 2
      && !confirm('Jesteś sam w poczekalni. Zagrać solo?')) return;
    hostStartGame();
  },
  stop() {
    if (!state || state.phase !== 'playing' || hostNow() < state.startAt) return;
    if (!state.endsAt && !allFilled()) return;
    navigator.vibrate?.(60);
    if (isHost()) hostStop(me.id);
    else {
      send({ t: 'answers', round: state.round, answers: myAnswers() });
      send({ t: 'stop' });
      ui.stopSentRound = state.round;
      renderLive();
    }
  },
  force() {
    if (isHost() && confirm('Włączyć odliczanie dla wszystkich?')) hostStop(null);
  },
  vote(btn) {
    const target = btn.dataset.t;
    const cat = btn.dataset.c;
    const v = Number(btn.dataset.v);
    const cur = state.check?.votes?.[target]?.[cat]?.[me.id] || 0;
    const nv = cur === v ? 0 : v;
    if (isHost()) hostVote(me.id, target, cat, nv);
    else send({ t: 'vote', target, cat, v: nv });
  },
  confirm() { hostConfirm(); },
  next() { hostNext(); },
  again() { hostPlayAgain(); },
  home() {
    if (!isHost()) send({ t: 'leave' });
    setTimeout(() => leaveToHome(''), 100);
  },
};

function readName() {
  const input = document.getElementById('name');
  const name = G.clean(input?.value).slice(0, 16);
  if (!name) {
    showHomeError('Wpisz swoje imię — zobaczą je inni gracze.');
    input?.focus();
    return false;
  }
  me.name = name;
  store.set('pm-name', name);
  return true;
}

function showHomeError(msg) {
  ui.error = msg;
  const el = document.getElementById('homeError');
  if (el) el.textContent = msg;
}

function leaveToHome(error) {
  disconnect(true);
  ui.error = error || '';
  render();
}

function resumeSession(s) {
  if (s.host) {
    const saved = store.get('pm-host-' + s.code);
    if (!saved?.state) { store.del('pm-session'); render(); return; }
    state = saved.state;
    host = saved.host || freshHostData();
    if (state.phase === 'collecting') host.collectAt = Date.now();
    connect(s.code, true).then(() => {
      if (state?.phase === 'checking' && state.check?.validating) runOnlineCheck();
    });
  } else {
    connect(s.code, false);
  }
}

function gameUrl() {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('g', session.code);
  if (LOCAL) u.searchParams.set('local', '1');
  return u.toString();
}

async function shareGame() {
  const url = gameUrl();
  const text = `Gramy w Państwa-Miasta! Kod gry: ${session.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Państwa-Miasta', text, url }); return; } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  const ok = await copyText(url);
  toast(ok ? 'Skopiowano link do gry' : url);
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
}

function toast(msg) {
  ui.toast = msg;
  clearTimeout(ui.toastTimer);
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  ui.toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------- render

function screenKey() {
  if (!session) return 'home';
  if (!state) return 'connecting';
  switch (state.phase) {
    case 'lobby': return 'lobby';
    case 'playing':
    case 'collecting': return 'play:' + state.round;
    case 'checking': return 'check:' + state.round;
    case 'summary': return 'summary:' + state.round;
    case 'final': return 'final';
    default: return 'home';
  }
}

function render() {
  const key = screenKey();
  const name = key.split(':')[0];
  if (key !== ui.mounted) {
    ui.mounted = key;
    document.body.classList.remove('no-scroll');
    app.innerHTML = BUILD[name]();
    app.dataset.screen = name;
    window.scrollTo(0, 0);
    MOUNT[name]?.();
  }
  UPDATE[name]?.();
  renderStatus();
  wakeLock(['play', 'check', 'summary'].includes(name));
}

function renderLive() {
  const name = ui.mounted.split(':')[0];
  UPDATE[name]?.();
  renderStatus();
}

function renderStatus() {
  const el = document.getElementById('conn');
  if (!el) return;
  let text = '';
  if (conn === 'connecting') text = 'Łączę…';
  else if (conn === 'offline') text = 'Brak połączenia, łączę ponownie…';
  else if (!isHost() && state && ui.hostGoneSince && Date.now() - ui.hostGoneSince > 3000) {
    text = `Brak połączenia z gospodarzem (${hostName()}). Czekamy, aż wróci.`;
  }
  el.textContent = text;
  el.hidden = !text;
}

function topbar(title) {
  return `<header class="topbar">
    <div class="topbar-title">${title}</div>
    <button class="topbar-btn" data-act="leave" type="button">Wyjdź</button>
  </header>
  <p class="conn" id="conn" role="status" hidden></p>`;
}

const RING = '<svg class="ring" viewBox="0 0 120 120" aria-hidden="true"><path pathLength="1" d="M64 9C95 9 114 33 111 63C108 94 82 113 54 110C25 107 7 84 10 55C13 27 37 8 70 13"/></svg>';

const BUILD = {
  home() {
    const saved = store.get('pm-session');
    const canResume = saved && Date.now() - saved.t < 6 * 3600e3;
    const prefill = G.normalizeCode(params.get('g'));
    return `<main class="screen home">
      <div class="home-head">
        <h1 class="wordmark" aria-label="Państwa-Miasta"><span>Państwa‑</span><span class="mk">Miasta</span></h1>
        <p class="lede">Gra z zeszytu w kratkę, tylko na telefonach. Jedna osoba zakłada grę i podaje reszcie kod.</p>
      </div>
      <div class="home-form">
        <label class="field">
          <span class="field-label">Jak się nazywasz?</span>
          <input id="name" maxlength="16" autocomplete="nickname" placeholder="Imię albo ksywka" value="${esc(me.name)}">
        </label>
        ${prefill ? `
        <button type="button" class="btn btn-ink" data-act="join">Dołącz do gry ${esc(prefill)}</button>
        <input id="code" type="hidden" value="${esc(prefill)}">
        <div class="divider"><span>albo</span></div>
        <button type="button" class="btn" data-act="create">Załóż własną grę</button>` : `
        <button type="button" class="btn btn-ink" data-act="create">Załóż nową grę</button>
        <div class="divider"><span>albo dołącz do znajomych</span></div>
        <div class="join">
          <input id="code" maxlength="4" placeholder="KOD" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-label="Kod gry">
          <button type="button" class="btn" data-act="join">Dołącz</button>
        </div>`}
        <p class="error" id="homeError" role="alert">${esc(ui.error)}</p>
        ${canResume ? `<button type="button" class="btn btn-quiet" data-act="resume">Wróć do gry ${esc(saved.code)}</button>` : ''}
      </div>
      <footer class="home-foot">
        ${LOCAL ? '<p>Tryb lokalny: gracze w kartach tej samej przeglądarki.</p>' : ''}
        <p>Punkty: 15 — tylko Ty masz odpowiedź w kategorii, 10 — unikalna, 5 — taka sama jak u kogoś.</p>
      </footer>
    </main>`;
  },

  connecting() {
    return `<main class="screen connecting">
      <p class="hand big">${isHost() ? 'Zakładam grę…' : `Łączę z grą ${esc(session.code)}…`}</p>
      <p class="conn" id="conn" hidden></p>
      <button type="button" class="btn btn-quiet" data-act="cancel">Anuluj</button>
    </main>`;
  },

  lobby() {
    const host = isHost();
    return `${topbar('Poczekalnia')}
    <main class="screen lobby">
      <section class="code-card">
        <p class="code-label">Kod gry</p>
        <p class="code" id="gameCode">${esc(state.code)}</p>
        <div class="code-actions">
          <button type="button" class="btn btn-small btn-ink" data-act="share">Wyślij zaproszenie</button>
          <button type="button" class="btn btn-small" data-act="copy">Kopiuj kod</button>
        </div>
      </section>
      <section class="block">
        <h2 class="block-title">Gracze <span class="count" id="pcount"></span></h2>
        <ul class="players" id="players"></ul>
      </section>
      <section class="block">
        <h2 class="block-title">Ustawienia</h2>
        <div class="setting">
          <span class="setting-name">Liczba rund</span>
          <div class="stepper">
            ${host ? '<button type="button" data-act="rounds" data-d="-1" aria-label="Mniej rund">−</button>' : ''}
            <output id="rounds"></output>
            ${host ? '<button type="button" data-act="rounds" data-d="1" aria-label="Więcej rund">+</button>' : ''}
          </div>
        </div>
        <div class="setting setting-col">
          <span class="setting-name">Czas po „Stop!”</span>
          <div class="seg" id="countdown" role="group" aria-label="Czas odliczania"></div>
          <p class="setting-help">Gdy pierwsza osoba wypełni wszystko i wciśnie Stop, reszta ma tyle czasu na dokończenie.</p>
        </div>
        <div class="setting setting-col">
          <span class="setting-name">Słowa, których aplikacja nie zna</span>
          <div class="seg" id="strict" role="group" aria-label="Zasada dla nieznanych słów"></div>
          <p class="setting-help" id="strictHelp"></p>
        </div>
        <div class="setting setting-col">
          <span class="setting-name">Kategorie</span>
          <div class="chips" id="cats"></div>
          ${host ? `<form class="addcat" id="addcatForm">
            <input id="newcat" maxlength="24" placeholder="Własna kategoria, np. Potrawa" autocomplete="off">
            <button type="submit" class="btn btn-small">Dodaj</button>
          </form>
          <p class="setting-help">Kategorie z ✓ sprawdzam automatycznie. Resztę oceniacie głosami.</p>` : ''}
        </div>
      </section>
    </main>
    <div class="dock" id="dock"></div>`;
  },

  play() {
    const cats = state.settings.categories;
    const saved = myAnswers();
    return `${topbar(`Runda ${state.round} z ${state.settings.rounds}`)}
    <main class="screen play">
      <section class="letter-zone">
        <div class="letter-box">${RING}<span class="letter" id="letter">${esc(state.letter)}</span></div>
        <div class="status" id="status" aria-live="polite"></div>
      </section>
      <ol class="sheet" id="sheet">
        ${cats.map((c, i) => `<li class="row" data-row="${esc(c.id)}">
          <label for="a-${i}">${esc(c.name)}</label>
          <input id="a-${i}" data-cat="${esc(c.id)}" value="${esc(saved[c.id] || '')}" maxlength="${G.ANSWER_MAX}"
            autocomplete="off" autocorrect="off" spellcheck="false" autocapitalize="sentences"
            enterkeyhint="${i === cats.length - 1 ? 'done' : 'next'}">
        </li>`).join('')}
      </ol>
    </main>
    <div class="dock" id="dock"></div>
    <div class="reveal" id="reveal" aria-hidden="true">
      <div class="reveal-box">${RING}<span class="reveal-letter" id="revealLetter"></span></div>
      <p class="reveal-text">Losuję literę…</p>
    </div>`;
  },

  check() {
    return `${topbar(`Sprawdzanie: runda ${state.round}`)}
    <main class="screen check">
      <div class="check-head">
        <span class="mini-letter">${esc(state.letter)}</span>
        <p class="check-intro" id="checkIntro"></p>
      </div>
      <div id="checkList"></div>
    </main>
    <div class="dock" id="dock"></div>`;
  },

  summary() {
    const last = state.round >= state.settings.rounds;
    return `${topbar(`Po rundzie ${state.round} z ${state.settings.rounds}`)}
    <main class="screen summary">
      <h2 class="hand big">${last ? 'To była ostatnia runda' : 'Punkty po tej rundzie'}</h2>
      <ol class="standings" id="standings"></ol>
    </main>
    <div class="dock" id="dock"></div>`;
  },

  final() {
    return `${topbar('Koniec gry')}
    <main class="screen final">
      <section class="winner" id="winner"></section>
      <ol class="standings" id="standings"></ol>
      <div class="table-wrap" id="roundsTable"></div>
    </main>
    <div class="dock" id="dock"></div>`;
  },
};

const MOUNT = {
  home() {
    const name = document.getElementById('name');
    const code = document.getElementById('code');
    if (!name.value) name.focus();
    code?.addEventListener('input', () => { code.value = G.normalizeCode(code.value); });
    const enter = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (e.target === code && code.value) actions.join();
      else if (params.get('g')) actions.join();
      else actions.create();
    };
    name.addEventListener('keydown', enter);
    code?.addEventListener('keydown', enter);
  },
  lobby() {
    document.getElementById('addcatForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      actions.addcat();
    });
  },
  play() {
    pruneAnswers();
    const inputs = [...document.querySelectorAll('#sheet input')];
    inputs.forEach((inp, i) => {
      inp.addEventListener('input', () => {
        saveAnswer(inp.dataset.cat, inp.value);
        markRow(inp);
        UPDATE.play();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (inputs[i + 1]) inputs[i + 1].focus();
        else inp.blur();
      });
      markRow(inp);
    });
    ui.revealShown = false;
  },
};

function markRow(inp) {
  const row = inp.closest('.row');
  const v = G.clean(inp.value);
  const ok = G.isFilled(v, state.letter);
  row.classList.toggle('filled', ok);
  row.classList.toggle('wrong', !!v && !G.startsWithLetter(v, state.letter));
}

const UPDATE = {
  lobby() {
    const host = isHost();
    const ids = G.activePlayers(state);
    document.getElementById('pcount').textContent = `(${ids.length})`;
    document.getElementById('players').innerHTML = ids.map((id) => {
      const p = state.players[id];
      const on = id === me.id || p.online;
      return `<li class="player ${on ? '' : 'away'}">
        <span class="dot" aria-hidden="true"></span>
        <span class="player-name">${esc(p.name)}</span>
        <span class="player-tag">${id === state.hostId ? 'gospodarz' : ''}${id === me.id ? (id === state.hostId ? ', to Ty' : 'to Ty') : ''}${!on ? 'rozłączony' : ''}</span>
        ${host && id !== me.id && !on ? `<button type="button" class="link-btn" data-act="kick" data-id="${esc(id)}">Usuń</button>` : ''}
      </li>`;
    }).join('');
    document.getElementById('rounds').textContent = state.settings.rounds;
    document.getElementById('countdown').innerHTML = G.COUNTDOWN_OPTIONS.map((s) => {
      const on = s === state.settings.countdown;
      return host
        ? `<button type="button" data-act="countdown" data-s="${s}" aria-pressed="${on}" class="${on ? 'on' : ''}">${s} s</button>`
        : `<span class="${on ? 'on' : 'off'}">${s} s</span>`;
    }).join('');
    const strict = !!state.settings.strict;
    document.getElementById('strict').innerHTML = [[false, 'Liczą się'], [true, 'Wymagają ✓']].map(([v, label]) => {
      const on = v === strict;
      return host
        ? `<button type="button" data-act="strict" data-v="${v ? 1 : 0}" aria-pressed="${on}" class="${on ? 'on' : ''}">${label}</button>`
        : `<span class="${on ? 'on' : 'off'}">${label}</span>`;
    }).join('');
    document.getElementById('strictHelp').textContent = strict
      ? 'Słowo spoza słownika dostaje punkty dopiero, gdy większość da ✓.'
      : 'Słowo spoza słownika dostaje punkty, chyba że większość da ✗.';
    const selected = new Set(state.settings.categories.map((c) => c.id));
    const opts = host ? allCategoryOptions() : allCategoryOptions().filter((o) => selected.has(o.id));
    document.getElementById('cats').innerHTML = opts.map((o) => {
      const on = selected.has(o.id);
      const label = `${esc(o.name)}${o.auto ? ' <span class="auto" title="Sprawdzane automatycznie">✓</span>' : ''}`;
      return host
        ? `<button type="button" class="chip ${on ? 'on' : ''}" data-act="cat" data-id="${esc(o.id)}" aria-pressed="${on}">${label}</button>`
        : `<span class="chip on">${label}</span>`;
    }).join('');
    const dock = document.getElementById('dock');
    if (host) {
      const n = ids.length;
      dock.innerHTML = `<button type="button" class="btn btn-ink btn-big" data-act="start">Zaczynamy (${n} ${plural(n, 'gracz', 'graczy', 'graczy')})</button>
        <p class="dock-hint">Zacznij, gdy wszyscy będą na liście.</p>`;
    } else {
      dock.innerHTML = `<p class="dock-wait">Czekamy, aż ${esc(hostName())} zacznie grę.</p>`;
    }
  },

  play() {
    if (!state || !ui.mounted.startsWith('play')) return;
    const t = hostNow();
    const reveal = document.getElementById('reveal');
    const revealing = t < state.startAt;
    reveal.classList.toggle('show', revealing);
    document.body.classList.toggle('no-scroll', revealing);
    if (revealing) {
      const left = state.startAt - t;
      const rl = document.getElementById('revealLetter');
      if (left > 1100 && !reducedMotion()) {
        rl.textContent = G.LETTERS[Math.floor(Math.random() * G.LETTERS.length)];
        reveal.classList.remove('landed');
      } else {
        rl.textContent = state.letter;
        reveal.classList.add('landed');
      }
    } else if (!ui.revealShown) {
      ui.revealShown = true;
      const first = [...document.querySelectorAll('#sheet input')].find((i) => !i.value);
      if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
    }

    const locked = state.phase === 'collecting' || (state.endsAt && t >= state.endsAt);
    document.querySelectorAll('#sheet input').forEach((inp) => { inp.disabled = !!locked || revealing; });
    if (locked && !isHost()) {
      // Wyślij odpowiedzi od razu po końcu czasu (gospodarz i tak o nie poprosi).
      if (ui.sentFor !== 'end:' + state.round) {
        ui.sentFor = 'end:' + state.round;
        send({ t: 'answers', round: state.round, answers: myAnswers() });
      }
    }

    const status = document.getElementById('status');
    const dock = document.getElementById('dock');
    const answers = myAnswers();
    const missing = state.settings.categories.filter((c) => !G.isFilled(answers[c.id], state.letter)).length;
    const iAmDone = state.done.includes(me.id) || ui.stopSentRound === state.round;

    if (state.phase === 'collecting' || locked) {
      status.className = 'status status-end';
      status.innerHTML = '<span class="hand">Koniec czasu!</span> Zbieram odpowiedzi…';
      setDock(dock, 'end', '<p class="dock-wait">Za chwilę sprawdzanie.</p>');
      return;
    }
    if (state.endsAt) {
      const secs = Math.max(0, Math.ceil((state.endsAt - t) / 1000));
      const who = state.stopBy === me.id ? 'Stop! Masz wszystko.'
        : state.stopBy ? `Stop! ${esc(pname(state.stopBy))} ma wszystko.` : 'Odliczanie dla wszystkich.';
      status.className = 'status status-count';
      status.innerHTML = `<span class="count-num">${secs}</span><span class="count-text">${who}<br>${state.stopBy === me.id ? 'Reszta kończy pisać.' : 'Dokończ, co się da!'}</span>`;
      if (ui.lastBuzz !== state.round && state.stopBy !== me.id) {
        ui.lastBuzz = state.round;
        navigator.vibrate?.([120, 60, 120]);
      }
      if (iAmDone) {
        setDock(dock, 'waiting', '<p class="dock-wait">Gotowe. Czekamy na resztę.</p>');
      } else {
        setDock(dock, 'done', `<button type="button" class="btn btn-stop" data-act="stop">Gotowe, kończę</button>`);
      }
      return;
    }
    status.className = 'status';
    status.innerHTML = revealing ? '' : 'Wpisz po jednym słowie na tę literę. Kto pierwszy wypełni wszystko, wciska Stop.';
    const disabled = missing > 0 || revealing;
    setDock(dock, 'stop', `<button type="button" class="btn btn-stop" data-act="stop" id="stopBtn">Stop!</button>
      <p class="dock-hint" id="stopHint"></p>
      ${isHost() ? '<button type="button" class="link-btn" data-act="force">Nikt nie może skończyć? Włącz odliczanie</button>' : ''}`);
    document.getElementById('stopBtn').disabled = disabled;
    document.getElementById('stopHint').textContent = revealing ? ''
      : missing ? `Brakuje jeszcze ${missing} ${plural(missing, 'odpowiedzi', 'odpowiedzi', 'odpowiedzi')} na literę ${state.letter}.`
        : 'Wszystko wypełnione — możesz wcisnąć Stop.';
  },

  check() {
    const c = state.check;
    const cats = state.settings.categories;
    const preview = G.scoreRound(c.pids, cats, c).cells;
    const intro = document.getElementById('checkIntro');
    intro.innerHTML = c.validating
      ? 'Szukam nieznanych słów w Wikidata i Wikisłowniku…'
      : c.offline
        ? 'Nie udało się połączyć z Wikidata, więc słowa spoza słownika oceniacie sami: ✓ albo ✗.'
        : c.strict
          ? 'Słowa, których nie znam, dostaną punkty tylko z ✓ od większości.'
          : 'Słowa, których nie znam, liczą się, chyba że większość da ✗.';
    document.getElementById('checkList').innerHTML = cats.map((cat) => `
      <section class="cat-block">
        <h3 class="cat-title">${esc(cat.name)}</h3>
        <ul class="answers">${c.pids.map((p) => answerRow(p, cat, preview)).join('')}</ul>
      </section>`).join('') + legend();
    const dock = document.getElementById('dock');
    if (isHost()) {
      let unvoted = 0;
      for (const p of c.pids) {
        for (const cat of cats) {
          const st = c.auto[p]?.[cat.id];
          const v = c.votes?.[p]?.[cat.id] || {};
          if ((st === 'unknown' || st === 'pending') && !Object.keys(v).length) unvoted++;
        }
      }
      const hint = c.validating ? 'Szukam słów spoza słownika, to trwa do 10 sekund.'
        : !unvoted ? 'Zatwierdź, gdy wszyscy zagłosują.'
          : c.strict ? `${unvoted} ${plural(unvoted, 'nieznane słowo', 'nieznane słowa', 'nieznanych słów')} bez ✓ dostanie 0 pkt.`
            : `${unvoted} ${plural(unvoted, 'nieznane słowo', 'nieznane słowa', 'nieznanych słów')} policzę, jeśli nikt nie da ✗.`;
      dock.innerHTML = `<button type="button" class="btn btn-ink btn-big" data-act="confirm" ${c.validating ? 'disabled' : ''}>${c.validating ? 'Sprawdzam odpowiedzi…' : 'Zatwierdź punkty'}</button>
        <p class="dock-hint">${hint}</p>`;
    } else {
      dock.innerHTML = `<p class="dock-wait">${esc(hostName())} zatwierdzi punkty, gdy skończycie głosować.</p>`;
    }
  },

  summary() {
    const last = state.history[state.history.length - 1];
    document.getElementById('standings').innerHTML = G.standings(state.players, state.order)
      .map((p) => `<li class="${p.id === me.id ? 'me' : ''}">
        <span class="place">${p.place}.</span>
        <span class="st-name">${esc(p.name)}</span>
        <span class="gain">${last?.totals?.[p.id] != null ? '+' + last.totals[p.id] : ''}</span>
        <span class="total">${p.score}</span>
      </li>`).join('');
    const isLast = state.round >= state.settings.rounds;
    document.getElementById('dock').innerHTML = isHost()
      ? `<button type="button" class="btn btn-ink btn-big" data-act="next">${isLast ? 'Pokaż wyniki końcowe' : `Runda ${state.round + 1}`}</button>`
      : `<p class="dock-wait">Czekamy, aż ${esc(hostName())} ${isLast ? 'pokaże wyniki' : 'zacznie kolejną rundę'}.</p>`;
  },

  final() {
    const list = G.standings(state.players, state.order);
    const winners = list.filter((p) => p.place === 1);
    document.getElementById('winner').innerHTML = winners.length > 1
      ? `<p class="winner-label">Remis na szczycie</p><h2 class="winner-name">${winners.map((w) => esc(w.name)).join(' i ')}</h2><p class="winner-score">${winners[0].score} pkt</p>`
      : `<p class="winner-label">Wygrywa</p><h2 class="winner-name">${esc(winners[0]?.name || '')}</h2><p class="winner-score">${winners[0]?.score || 0} pkt</p>`;
    document.getElementById('standings').innerHTML = list.map((p) => `<li class="${p.id === me.id ? 'me' : ''}">
      <span class="place">${p.place}.</span><span class="st-name">${esc(p.name)}</span><span class="total">${p.score}</span></li>`).join('');
    const rounds = state.history;
    document.getElementById('roundsTable').innerHTML = rounds.length ? `<table class="rounds">
      <caption>Punkty w rundach</caption>
      <thead><tr><th scope="col">Gracz</th>${rounds.map((r) => `<th scope="col">${esc(r.letter)}</th>`).join('')}<th scope="col">Razem</th></tr></thead>
      <tbody>${list.map((p) => `<tr><th scope="row">${esc(p.name)}</th>${rounds.map((r) => `<td>${r.totals[p.id] ?? '–'}</td>`).join('')}<td class="sum">${p.score}</td></tr>`).join('')}</tbody>
    </table>` : '';
    document.getElementById('dock').innerHTML = isHost()
      ? `<button type="button" class="btn btn-ink btn-big" data-act="again">Zagraj jeszcze raz</button>
         <button type="button" class="link-btn" data-act="leave">Zakończ</button>`
      : `<p class="dock-wait">${esc(hostName())} może zacząć nową grę z tymi samymi osobami.</p>
         <button type="button" class="link-btn" data-act="home">Wróć na start</button>`;
  },
};

// Zmieniaj zawartość doku tylko przy zmianie trybu, żeby nie gubić focusu i animacji.
function setDock(dock, mode, html) {
  if (dock.dataset.mode !== mode) {
    dock.dataset.mode = mode;
    dock.innerHTML = html;
  }
}

const STATUS_TEXT = {
  ok: 'pasuje',
  manual: 'do oceny',
  unknown: 'nie znam',
  pending: 'sprawdzam…',
  bad: 'zła litera',
  empty: 'brak',
};

function answerRow(p, cat, preview) {
  const c = state.check;
  const word = c.answers[p]?.[cat.id] || '';
  const st = c.auto[p]?.[cat.id] || 'empty';
  const votes = c.votes?.[p]?.[cat.id] || {};
  const up = Object.values(votes).filter((v) => v > 0).length;
  const down = Object.values(votes).filter((v) => v < 0).length;
  const mine = votes[me.id] || 0;
  const accepted = G.isAccepted(st, votes, !!c.strict);
  const pts = preview[p]?.[cat.id] ?? 0;
  const voting = G.canVote(st) && p !== me.id;
  let note = STATUS_TEXT[st];
  if (G.canVote(st) && (up || down)) note = accepted ? 'zaliczone głosami' : 'odrzucone głosami';
  if (st === 'ok' && !(up || down)) note = 'pasuje';
  if (st === 'unknown' && !(up || down)) note = c.strict ? 'nie znam — zaliczyć? daj ✓' : 'nie znam — liczę, chyba że ✗';
  return `<li class="ans st-${st} ${accepted ? 'acc' : 'rej'} ${up || down ? 'voted' : ''} ${p === me.id ? 'mine' : ''}">
    <span class="ans-who">${esc(pname(p))}${p === me.id ? ' (Ty)' : ''}</span>
    <span class="ans-word">${word ? esc(word) : '—'}</span>
    <span class="ans-note">${note}</span>
    <span class="ans-votes">${G.canVote(st) ? `
      <button type="button" class="vote up ${mine > 0 ? 'on' : ''}" data-act="vote" data-t="${esc(p)}" data-c="${esc(cat.id)}" data-v="1" ${voting ? '' : 'disabled'} aria-label="Zaliczam">✓ <b>${up}</b></button>
      <button type="button" class="vote down ${mine < 0 ? 'on' : ''}" data-act="vote" data-t="${esc(p)}" data-c="${esc(cat.id)}" data-v="-1" ${voting ? '' : 'disabled'} aria-label="Nie zaliczam">✗ <b>${down}</b></button>` : ''}
    </span>
    <span class="ans-pts pts-${pts}" aria-label="${pts} punktów">${pts}</span>
  </li>`;
}

function legend() {
  return `<details class="legend">
    <summary>Jak liczę punkty?</summary>
    <p><b>15</b> — tylko Ty masz zaliczoną odpowiedź w tej kategorii. <b>10</b> — Twoja odpowiedź jest inna niż wszystkich. <b>5</b> — ktoś napisał to samo. <b>0</b> — brak, zła litera albo odrzucone.</p>
    <p>„Pasuje” — znalazłem w słowniku, Wikidata albo Wikisłowniku; liczy się, chyba że większość da ✗. „Nie znam” — ${state.check?.strict ? 'liczy się tylko, jeśli większość da ✓' : 'liczy się, chyba że większość da ✗'} (gospodarz zmienia to w poczekalni). „Do oceny” — kategoria bez automatu; liczy się, chyba że większość da ✗. Zła litera i brak to zawsze 0.</p>
  </details>`;
}

function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10;
  const dd = n % 100;
  return d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14) ? few : many;
}

function reducedMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }

// Ekran nie gaśnie w trakcie rundy (tam, gdzie przeglądarka to wspiera).
let lock = null;
async function wakeLock(on) {
  try {
    if (on && !lock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch { lock = null; }
}

// ---------------------------------------------------------------- start

app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = actions[b.dataset.act];
  if (fn) fn(b, e);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (session && !isHost()) send({ t: 'hello' });
  if (session && isHost() && state) rebroadcast();
  render();
});

setInterval(() => {
  hostTick();
  const name = ui.mounted.split(':')[0];
  if (name === 'play') UPDATE.play();
  if (name === 'lobby' || name === 'play' || name === 'check') renderStatus();
}, 150);

(function boot() {
  const s = store.get('pm-session');
  const urlCode = G.normalizeCode(params.get('g'));
  if (s && Date.now() - s.t < 6 * 3600e3 && (!urlCode || urlCode === s.code)) {
    resumeSession(s);
  } else {
    render();
  }
}());

// Dla testów i ciekawskich.
window.__pm = { get state() { return state; }, me, get session() { return session; } };
