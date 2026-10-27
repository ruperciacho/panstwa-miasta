// Czysta logika gry — bez DOM i sieci, łatwa do testowania.

// Litery losowane w rundach (bez Q, V, X, Y i rzadkich polskich znaków).
export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'Ł', 'M',
  'N', 'O', 'P', 'R', 'S', 'T', 'U', 'W', 'Z'];

// Kategorie do wyboru w poczekalni. `auto: true` = aplikacja umie je sprawdzić sama.
export const PRESET_CATEGORIES = [
  { id: 'panstwo', name: 'Państwo', auto: true },
  { id: 'miasto', name: 'Miasto', auto: true },
  { id: 'rzeka', name: 'Rzeka', auto: true },
  { id: 'zwierze', name: 'Zwierzę', auto: true },
  { id: 'roslina', name: 'Roślina', auto: true },
  { id: 'imie', name: 'Imię', auto: true },
  { id: 'rzecz', name: 'Rzecz', auto: true },
  { id: 'zawod', name: 'Zawód', auto: true },
  { id: 'owoc', name: 'Owoc lub warzywo', auto: true },
  { id: 'kolor', name: 'Kolor', auto: true },
  { id: 'sport', name: 'Sport', auto: true },
  { id: 'marka', name: 'Marka', auto: false },
  { id: 'film', name: 'Film lub serial', auto: false },
  { id: 'slawny', name: 'Sławna osoba', auto: false },
];

export const DEFAULT_CATEGORY_IDS = ['panstwo', 'miasto', 'rzeka', 'zwierze', 'roslina', 'imie', 'rzecz'];
export const COUNTDOWN_OPTIONS = [10, 15, 20, 30, 45, 60];
export const MIN_CATEGORIES = 3;
export const MAX_CATEGORIES = 10;
export const MAX_ROUNDS = 12;
export const ANSWER_MAX = 40;

export const POINTS = { ALONE: 15, UNIQUE: 10, SAME: 5, NONE: 0 };

// Kod gry: 4 litery, bez mylących znaków (I/O/Q/V).
const CODE_CHARS = 'ABCDEFGHJKLMNPRSTUWXYZ';
export function makeCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return s;
}
export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
}

// "Składanie" tekstu do porównań: małe litery, bez polskich znaków i interpunkcji.
export function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[-–—_/.,'’"`!?()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Porządkuje odpowiedź wpisaną przez gracza.
export function clean(s) {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ANSWER_MAX);
}

// Czy odpowiedź zaczyna się na literę rundy (Ł ≠ L, Ż ≠ Z).
export function startsWithLetter(answer, letter) {
  const a = clean(answer).replace(/^[^\p{L}]+/u, '');
  if (!a) return false;
  return a.charAt(0).toLocaleUpperCase('pl') === letter;
}

// Odpowiedź "wygląda na wypełnioną" — warunek przycisku Stop.
export function isFilled(answer, letter) {
  const a = clean(answer);
  return startsWithLetter(a, letter) && fold(a).replace(/\s/g, '').length >= 2;
}

export function drawLetter(used = [], rand = Math.random) {
  let pool = LETTERS.filter((l) => !used.includes(l));
  if (!pool.length) pool = LETTERS.slice();
  return pool[Math.floor(rand() * pool.length)];
}

// Statusy automatycznego sprawdzania:
//  ok      – potwierdzone (słownik / Wikidata / Wikisłownik) → zaliczone, chyba że większość zagłosuje przeciw
//  manual  – kategoria bez automatu → zaliczone, chyba że większość zagłosuje przeciw
//  unknown – nie znalazłem → zależy od ustawienia gry:
//            luźne (domyślne): zaliczone, chyba że większość zagłosuje przeciw
//            ścisłe: niezaliczone, chyba że większość zagłosuje za
//  pending – trwa sprawdzanie online (traktowane jak unknown)
//  bad     – zła litera / za krótkie → 0 pkt, bez głosowania
//  empty   – brak odpowiedzi → 0 pkt
export function isAccepted(auto, votes, strict = false) {
  if (!auto || auto === 'empty' || auto === 'bad') return false;
  let up = 0;
  let down = 0;
  for (const v of Object.values(votes || {})) {
    if (v > 0) up++;
    else if (v < 0) down++;
  }
  if ((auto === 'unknown' || auto === 'pending') && strict) return up > down;
  return !(down > up);
}

export function canVote(auto) {
  return auto === 'ok' || auto === 'manual' || auto === 'unknown' || auto === 'pending';
}

// Punktacja rundy (klasyczne zasady):
// 15 – tylko Ty masz zaliczoną odpowiedź w tej kategorii
// 10 – Twoja odpowiedź jest inna niż wszystkich
//  5 – ktoś napisał to samo
//  0 – brak / niezaliczona
export function scoreRound(pids, categories, check) {
  const cells = {};
  const totals = {};
  for (const p of pids) {
    cells[p] = {};
    totals[p] = 0;
  }
  for (const c of categories) {
    const accepted = pids.filter((p) =>
      isAccepted(check.auto?.[p]?.[c.id], check.votes?.[p]?.[c.id], !!check.strict));
    const counts = {};
    for (const p of accepted) {
      const k = fold(check.answers?.[p]?.[c.id]);
      counts[k] = (counts[k] || 0) + 1;
    }
    for (const p of pids) {
      let pts = POINTS.NONE;
      if (accepted.includes(p)) {
        const k = fold(check.answers?.[p]?.[c.id]);
        if (counts[k] > 1) pts = POINTS.SAME;
        else if (accepted.length === 1 && pids.length > 1) pts = POINTS.ALONE;
        else pts = POINTS.UNIQUE;
      }
      cells[p][c.id] = pts;
      totals[p] += pts;
    }
  }
  return { cells, totals };
}

// Ranking z miejscami ex aequo.
export function standings(players, order) {
  const list = order
    .filter((id) => players[id] && !players[id].left)
    .map((id) => ({ id, name: players[id].name, score: players[id].score || 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'pl'));
  let place = 0;
  let prev = null;
  list.forEach((p, i) => {
    if (p.score !== prev) place = i + 1;
    p.place = place;
    prev = p.score;
  });
  return list;
}

export function uniqueName(name, players, selfId) {
  const base = clean(name).slice(0, 16) || 'Gracz';
  const taken = new Set(Object.entries(players)
    .filter(([id, p]) => id !== selfId && !p.left)
    .map(([, p]) => fold(p.name)));
  if (!taken.has(fold(base))) return base;
  for (let i = 2; i < 50; i++) {
    const n = `${base} ${i}`;
    if (!taken.has(fold(n))) return n;
  }
  return base + ' ' + uid().slice(0, 3);
}

export function newGame(code, host) {
  return {
    v: 0,
    code,
    hostId: host.id,
    phase: 'lobby',
    settings: { rounds: 5, countdown: 20, strict: false, categories: DEFAULT_CATEGORY_IDS.map(catById) },
    players: { [host.id]: { name: host.name, score: 0, online: true } },
    order: [host.id],
    round: 0,
    usedLetters: [],
    letter: null,
    startAt: 0,
    endsAt: 0,
    stopBy: null,
    done: [],
    check: null,
    history: [],
  };
}

export function catById(id) {
  const c = PRESET_CATEGORIES.find((x) => x.id === id);
  return c ? { id: c.id, name: c.name } : null;
}

export function customCategory(name) {
  const n = clean(name).slice(0, 24);
  return { id: 'c-' + fold(n).replace(/\s+/g, '-').slice(0, 20) + '-' + uid().slice(0, 4), name: n, custom: true };
}

export function activePlayers(state) {
  return state.order.filter((id) => state.players[id] && !state.players[id].left);
}
