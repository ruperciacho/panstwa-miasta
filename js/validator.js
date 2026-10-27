// Automatyczne sprawdzanie odpowiedzi.
// 1) szybko i offline: pusta? zła litera? jest w słowniku?
// 2) online (tylko u gospodarza, dla odpowiedzi spoza słownika): Wikidata / Wikisłownik.
// Wszystko, czego nie da się rozstrzygnąć, trafia do głosowania graczy.

import { DICTIONARIES } from './dict.js';
import { fold, clean, startsWithLetter } from './game.js';

// Jak sprawdzać każdą kategorię online.
//  class: element Wikidata musi być instancją/podklasą jednej z klas
//  taxon: element musi należeć do drzewa taksonów (zwierzęta / rośliny)
//  wikt:  słowo musi być polskim rzeczownikiem w Wikisłowniku
const CHECKS = {
  panstwo: { wd: { classes: ['Q6256', 'Q3624078'] } },
  miasto: { wd: { classes: ['Q515', 'Q3957', 'Q7930989', 'Q1549591', 'Q5119'] } },
  rzeka: { wd: { classes: ['Q4022', 'Q47521'] } },
  zwierze: { wd: { taxon: 'Q729' }, wikt: { title: 'lower', test: /\{\{zool/ } },
  roslina: { wd: { taxon: 'Q756' }, wikt: { title: 'lower', test: /\{\{bot/ } },
  imie: { wd: { classes: ['Q202444'] }, wikt: { title: 'upper', test: /imi[ęo]/i } },
  zawod: { wd: { classes: ['Q28640', 'Q12737077'] } },
  owoc: { wd: { classes: ['Q1364', 'Q11004', 'Q3314483'] }, wikt: { title: 'lower', test: /owoc|warzyw|\{\{bot/i } },
  kolor: { wd: { classes: ['Q1075'] } },
  sport: { wd: { classes: ['Q349', 'Q31629'] } },
  rzecz: { wikt: { title: 'lower', test: /rzeczownik/ } },
};

const INDEX = {};
function index(cat) {
  if (!INDEX[cat]) {
    const map = new Map();
    for (const w of DICTIONARIES[cat] || []) {
      const k = fold(w);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(w);
    }
    INDEX[cat] = map;
  }
  return INDEX[cat];
}

export function inDictionary(catId, answer, letter) {
  const hits = index(catId).get(fold(answer));
  return !!hits && hits.some((w) => startsWithLetter(w, letter));
}

export function hasAutoCheck(catId) {
  return !!(DICTIONARIES[catId] || CHECKS[catId]);
}

// Szybkie sprawdzenie, bez sieci.
export function quickCheck(answer, letter, catId) {
  const a = clean(answer);
  if (!a) return 'empty';
  if (!startsWithLetter(a, letter)) return 'bad';
  if (fold(a).replace(/\s/g, '').length < 2) return 'bad';
  if (!hasAutoCheck(catId)) return 'manual';
  if (inDictionary(catId, a, letter)) return 'ok';
  return CHECKS[catId] ? 'pending' : 'unknown';
}

// ---------- online ----------

async function getJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch { out[k] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Elementy Wikidata, których polska etykieta lub alias to dokładnie ta odpowiedź.
async function wikidataCandidates(answer) {
  const url = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*'
    + '&language=pl&uselang=pl&type=item&limit=12&search=' + encodeURIComponent(answer);
  const data = await getJSON(url, 5000);
  const want = fold(answer);
  return (data.search || [])
    .filter((r) => fold(r.match?.text) === want || fold(r.label) === want)
    .map((r) => r.id)
    .filter((id) => /^Q\d+$/.test(id));
}

async function sparqlPassing(ids, rule) {
  if (!ids.length) return new Set();
  const values = ids.map((id) => 'wd:' + id).join(' ');
  let where;
  if (rule.taxon) {
    where = `{ ?item wdt:P171* wd:${rule.taxon} . } UNION { ?item wdt:P279/wdt:P171* wd:${rule.taxon} . }`;
  } else {
    const cls = rule.classes.map((c) => 'wd:' + c).join(' ');
    where = `VALUES ?cls { ${cls} } ?item (wdt:P31|wdt:P279)/wdt:P279* ?cls .`;
  }
  const query = `SELECT DISTINCT ?item WHERE { VALUES ?item { ${values} } ${where} }`;
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
  const data = await getJSON(url, 8000);
  return new Set((data.results?.bindings || []).map((b) => b.item.value.split('/').pop()));
}

// Polskie sekcje haseł z Wikisłownika: Map(złożony tytuł → treść sekcji „język polski”).
async function wiktionarySections(titles, stats) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 40) {
    const batch = titles.slice(i, i + 40);
    const url = 'https://pl.wiktionary.org/w/api.php?action=query&format=json&formatversion=2&origin=*'
      + '&prop=revisions&rvprop=content&rvslots=main&titles=' + encodeURIComponent(batch.join('|'));
    stats.calls++;
    let data;
    try { data = await getJSON(url, 6000); } catch { stats.failed++; continue; }
    for (const page of data.query?.pages || []) {
      if (page.missing) continue;
      const text = page.revisions?.[0]?.slots?.main?.content || '';
      const pl = text.split(/\n==\s/).find((sec) => sec.includes('({{język polski}})'));
      if (pl) out.set(page.title, pl);
    }
  }
  return out;
}

function titleVariant(answer, mode) {
  const a = clean(answer).toLocaleLowerCase('pl');
  return mode === 'upper' ? a.charAt(0).toLocaleUpperCase('pl') + a.slice(1) : a;
}

// items: [{ cat, answer }] → { result: Map("cat|złożona odpowiedź" → 'ok' | 'unknown'), offline: bool }
// offline = żadne zapytanie do Wikidata/Wikisłownika się nie udało (np. brak internetu, blokada).
export async function onlineCheck(items, { budgetMs = 10000 } = {}) {
  const result = new Map();
  const stats = { calls: 0, failed: 0 };
  const key = (cat, a) => cat + '|' + fold(a);
  const uniq = new Map();
  for (const it of items) {
    const k = key(it.cat, it.answer);
    if (!uniq.has(k)) uniq.set(k, it);
    result.set(k, 'unknown');
  }
  const list = [...uniq.values()];
  const isOk = (it) => result.get(key(it.cat, it.answer)) === 'ok';

  const work = (async () => {
    // 1) Wikisłownik — jedno zbiorcze zapytanie, szybkie.
    const wikt = list.filter((it) => CHECKS[it.cat]?.wikt);
    if (wikt.length) {
      const titles = [...new Set(wikt.map((it) => titleVariant(it.answer, CHECKS[it.cat].wikt.title)))];
      const sections = await wiktionarySections(titles, stats);
      for (const it of wikt) {
        const rule = CHECKS[it.cat].wikt;
        const sec = sections.get(titleVariant(it.answer, rule.title));
        if (sec && rule.test.test(sec)) result.set(key(it.cat, it.answer), 'ok');
      }
    }
    // 2) Wikidata — dla tego, czego Wikisłownik nie potwierdził.
    const wd = list.filter((it) => CHECKS[it.cat]?.wd && !isOk(it));
    const cands = await pool(wd, 4, async (it) => {
      stats.calls++;
      try { return await wikidataCandidates(clean(it.answer)); } catch (e) { stats.failed++; throw e; }
    });
    const byCat = new Map();
    wd.forEach((it, i) => {
      if (!cands[i]?.length) return;
      if (!byCat.has(it.cat)) byCat.set(it.cat, []);
      byCat.get(it.cat).push({ it, ids: cands[i] });
    });
    await pool([...byCat.entries()], 3, async ([cat, entries]) => {
      const ids = [...new Set(entries.flatMap((e) => e.ids))].slice(0, 120);
      stats.calls++;
      let passing;
      try { passing = await sparqlPassing(ids, CHECKS[cat].wd); } catch (e) { stats.failed++; throw e; }
      for (const e of entries) {
        if (e.ids.some((id) => passing.has(id))) result.set(key(cat, e.it.answer), 'ok');
      }
    });
  })();

  await Promise.race([work.catch(() => {}), new Promise((r) => setTimeout(r, budgetMs))]);
  return { result, offline: stats.calls > 0 && stats.failed === stats.calls };
}

export function resultKey(cat, answer) {
  return cat + '|' + fold(answer);
}
