// Generator pytań: formy przymiotników, pula pytań, dystraktory.
function adjForms(base) {
  const velar = base.endsWith('i');
  const st = base.slice(0, -1);
  const Y = velar ? 'i' : 'y', E = velar ? 'ie' : 'e';
  return {
    m: { N: st + Y, G: st + E + 'go', D: st + E + 'mu', Aan: st + E + 'go', Ain: st + Y, I: st + Y + 'm', L: st + Y + 'm' },
    f: { N: st + 'a', G: st + E + 'j', D: st + E + 'j', A: st + 'ą', I: st + 'ą', L: st + E + 'j' },
    n: { N: st + E, G: st + E + 'go', D: st + E + 'mu', A: st + E, I: st + Y + 'm', L: st + Y + 'm' },
    p: { Nv: VIR[base] || null, Nn: st + E, G: st + Y + 'ch', D: st + Y + 'm', Av: st + Y + 'ch', An: st + E, I: st + Y + 'mi', L: st + Y + 'ch' },
  };
}

// Род: mp — мужской личный, ma — мужской одушевлённый, mi — мужской неодушевлённый, f, n
// Формы: ед. ч. N|G|D|A|I|L ; мн. ч. N|G|D|A|I|L

function groupOf(noun, plural) {
  if (!plural) return noun.g;
  return noun.g === 'mp' ? 'pv' : 'pn';
}

function correctAdj(adj, noun, c, plural) {
  const F = adjForms(adj);
  if (plural) {
    const vir = noun.g === 'mp';
    if (c === 'N') return vir ? F.p.Nv : F.p.Nn;
    if (c === 'A') return vir ? F.p.Av : F.p.An;
    return F.p[c];
  }
  if (noun.g === 'f') return F.f[c];
  if (noun.g === 'n') return F.n[c];
  if (c === 'A') return noun.g === 'mi' ? F.m.Ain : F.m.Aan;
  return F.m[c];
}

// Все возможные пары (шаблон, существительное, число)
function buildPool() {
  const pool = [];
  TEMPLATES.forEach((t, ti) => {
    NOUNS.forEach((n, ni) => {
      if (n.cat !== t.cat) return;
      if (t.tag && !n.tags.includes(t.tag)) return;
      if (t.notTag && n.tags.includes(t.notTag)) return;
      [false, true].forEach(plural => {
        if (plural && (t.sgOnly || n.noPl)) return;
        if (!plural && t.plOnly) return;
        n.adjs.forEach(a => {
          if (t.noAdj && t.noAdj.includes(a)) return;
          if (plural && n.g === 'mp' && !VIR[a]) return;
          pool.push({ ti, ni, plural, adj: a, cell: CI[t.c] + ':' + groupOf(n, plural) });
        });
      });
    });
  });
  return pool;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function uniq(a) { return [...new Set(a)]; }

function makeQuestion(item) {
  const t = TEMPLATES[item.ti], n = NOUNS[item.ni], c = t.c, plural = item.plural;
  const ca = correctAdj(item.adj, n, c, plural);
  const cn = (plural ? n.pl : n.sg)[CI[c]];
  const { adjD, nounD } = distractors(t, n, item.adj, c, plural, ca, cn);
  let sentence = (plural && t.pl) ? t.pl : t.sg;
  sentence = sentence.replace('{z}', /^[sśzźż][^aeiouyąęó]/i.test(ca) ? 'ze' : 'z');
  sentence = sentence.replace('{w}', /^[wf][^aeiouyąęó]/i.test(ca) ? 'we' : 'w');
  sentence = sentence.replace('{W}', /^[wf][^aeiouyąęó]/i.test(ca) ? 'We' : 'W');
  return {
    key: item.ti + '|' + item.ni + '|' + item.adj + '|' + (plural ? 1 : 0),
    cell: item.cell, caseIdx: CI[c], group: groupOf(n, plural),
    sentence, base: correctAdj(item.adj, n, 'N', false) + ' ' + n.sg[0], plural,
    adjAnswer: ca, nounAnswer: cn,
    adjOptions: shuffle([ca, ...adjD]), nounOptions: shuffle([cn, ...nounD]),
    hint: t.hint, ti: item.ti, ni: item.ni,
  };
}
// ===== Dystraktory: całe spójne pary z przypadków, które łatwo pomylić =====
// Domyślnie: z czym myli się dany przypadek.
const CONFUSE = { N: ['A', 'G'], G: ['A', 'I', 'L'], D: ['A', 'G', 'L'], A: ['G', 'N', 'I'], I: ['L', 'G', 'A'], L: ['I', 'D', 'A'] };
// Pułapki zależne od zdania (rosyjska logika, przyimki z dwoma przypadkami).
const TRAPS = [
  [/dziękować|pomagać|pożyczyć|oddać|dać komu|dawać|wysłać|przedstawić|czytać|kupić komu|przyglądać|oprzeć|dzięki/, ['A', 'G']],
  [/szukać|używać|potrzebować|przeczeni|nie ma|nie było|nie mamy|bać się|pilnować|kawałek|lubić/, ['A']],
  [/czekać na/, ['G']],
  [/zadowolony|kanapka z/, ['I']],
  [/jeździć na/, ['A']],
  [/z \(skąd/, ['I']],
  [/z kim|z czym|spotkać się|zaprzyjaźnić/, ['G']],
  [/do \(dokąd/, ['A']],
  [/o kim|o czym/, ['A']],
  [/przed|za \(gdzie/, ['A', 'L']],
  [/w \(gdzie|w czym|w \(w czym/, ['A']],
  [/środek transportu/, ['L']],
  [/opiekować się|zajmować się|zachwycać|częstować|dzielić/, ['L', 'A']],
];
function trapCases(t) {
  if (t.trap) return t.trap.filter(x => x !== t.c);
  for (const [re, cs] of TRAPS) if (re.test(t.hint)) return cs.filter(x => x !== t.c);
  return [];
}
function adjFor(adj, g, c, plural, vir) {
  const F = adjForms(adj);
  if (plural) { if (c === 'N') return vir ? F.p.Nv : F.p.Nn; if (c === 'A') return vir ? F.p.Av : F.p.An; return F.p[c]; }
  if (g === 'f') return F.f[c];
  if (g === 'n') return F.n[c];
  if (c === 'A') return g === 'mi' ? F.m.Ain : F.m.Aan;
  return F.m[c];
}
// Prawdopodobne, ale błędne końcówki — dokładnie tam, gdzie się je myli.
const NEAR_MISS_PL_I = { 'dziećmi': 'dzieciami', 'końmi': 'koniami', 'przyjaciółmi': 'przyjacielami' };
function nearMissNoun(n, c, plural, cn) {
  const masc = n.g === 'mp' || n.g === 'ma' || n.g === 'mi';
  const lemma = n.sg[0], lemmaA = /a$/.test(lemma);       // kolega, kierowca — inne końcówki
  const out = [];
  if (!plural && masc && !lemmaA && c === 'G') {
    if (/a$/.test(cn)) out.push(cn.slice(0, -1) + 'u');          // chleba → chlebu
    else if (/u$/.test(cn)) out.push(cn.slice(0, -1) + 'a');     // sklepu → sklepa
  } else if (!plural && masc && !lemmaA && c === 'D') {
    if (/owi$/.test(cn)) out.push(cn.slice(0, -3) + 'u');        // telefonowi → telefonu
    else if (/u$/.test(cn)) out.push(cn.slice(0, -1) + 'owi');   // psu → psowi
  } else if (!plural && c === 'A' && /ę$/.test(cn) && !/ę$/.test(lemma)) {
    out.push(cn.slice(0, -1) + 'u');                             // gruszkę → gruszku (ros. грушу)
  } else if (!plural && c === 'L' && (masc || n.g === 'n') && !lemmaA && /e$/.test(cn) && !/[ęe]$/.test(lemma)) {
    const stem = n.g === 'n' ? lemma.replace(/o$/, '') : lemma;
    if (!/ó[^aeiouyąęó]*$/.test(stem)) {                         // stół, samochód — tu nie
      if (/[tdszn]$/.test(stem) && stem + 'ie' !== cn) out.push(stem + 'ie'); // lesie → lasie, studencie → studentie
      out.push(stem + 'u');                                      // o studencie → o studentu
    }
  } else if (plural && c === 'D' && /om$/.test(cn)) {
    out.push(cn.slice(0, -2) + 'am');                            // studentom → studentam (ros. -ам)
  } else if (plural && n.g === 'mp' && (c === 'N' || c === 'A') && !/(ec|eń)$/.test(lemma)) {
    const b = lemmaA ? lemma.slice(0, -1) : lemma;               // studenci → studenty, koledzy → kolegi
    if (!/(rz|cz|sz|ż|l|j|ń|ć|ś|ź)$/.test(b)) out.push(b + (/[kg]$/.test(b) ? 'i' : 'y'));
  } else if (plural && masc && c === 'G' && /[yi]$/.test(cn) && !/ów$/.test(cn)) {
    out.push(cn.slice(0, -1) + 'ów');                            // lekarzy → lekarzów
  } else if (plural && c === 'I' && NEAR_MISS_PL_I[cn]) {
    out.push(NEAR_MISS_PL_I[cn]);
  }
  return out.filter(f => f && f !== cn);
}
function distractors(t, n, adj, c, plural, ca, cn) {
  const vir = n.g === 'mp';
  const baseA = adjFor(adj, n.g, 'N', false), baseN = n.sg[0];
  const pairs = [];
  const push = (cs, pl, g) => cs.forEach(x => {
    if (pl && n.noPl) return;
    pairs.push([adjFor(adj, g || n.g, x, pl, vir), (pl ? n.pl : n.sg)[CI[x]]]);
  });
  const trap = trapCases(t), conf = CONFUSE[c].filter(x => !trap.includes(x));
  push(trap, plural); push(conf, plural);          // ten sam numer: pułapki, potem typowe pomyłki
  push([c], !plural);                              // ten sam przypadek, druga liczba (formy-homonimy)
  push(trap, !plural); push(conf, !plural);
  const other = n.g === 'f' ? 'mi' : (n.g === 'n' ? 'ma' : (/a$/.test(baseN) ? 'f' : 'n'));
  if (!plural) push([c, ...trap], false, other);   // pułapka rodzaju (kolega → młodej, kotka → młodego)
  push(['N', 'G', 'D', 'A', 'I', 'L'], plural); push(['N', 'G', 'D', 'A', 'I', 'L'], !plural);
  const A = [], N = [];
  nearMissNoun(n, c, plural, cn).slice(0, 2).forEach(f => { if (!N.includes(f)) N.push(f); });
  const okA = x => x && x !== ca && !A.includes(x) && (x !== baseA || ca === baseA);
  const okN = x => x && x !== cn && !N.includes(x) && (x !== baseN || cn === baseN);
  for (const [a, nn] of pairs) {
    if (A.length < 3 && okA(a)) A.push(a);
    if (N.length < 3 && okN(nn)) N.push(nn);
    if (A.length === 3 && N.length === 3) break;
  }
  // za mało form (rzadko) — wtedy także forma podstawowa
  for (const [a, nn] of pairs) { if (A.length < 3 && a && a !== ca && !A.includes(a)) A.push(a); if (N.length < 3 && nn && nn !== cn && !N.includes(nn)) N.push(nn); }
  return { adjD: A, nounD: N };
}
function pick3(primary, fallback) {
  const p = shuffle([...primary]).slice(0, 3);
  if (p.length < 3) {
    const rest = shuffle(fallback.filter(x => !p.includes(x)));
    while (p.length < 3 && rest.length) p.push(rest.shift());
  }
  return p;
}


function rulesFor(caseId, group) {
  return { adj: ADJ_END[caseId][group], noun: (NOUN_END[caseId] || {})[group] || 'forma słownikowa' };
}
// Przykład z innymi słowami z tego samego pola
function exampleFor(q, pool) {
  const cands = pool.filter(p => p.ni !== q.ni && p.ti !== q.ti);
  const alt = cands.length ? cands : pool.filter(p => p.ni !== q.ni);
  if (!alt.length) return null;
  const e = makeQuestion(alt[Math.floor(Math.random() * alt.length)]);
  return { sentence: e.sentence, phrase: e.adjAnswer + ' ' + e.nounAnswer, base: e.base };
}

