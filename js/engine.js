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
  // Дистракторы прилагательного: сначала формы того же рода/числа, потом остальные
  const F = adjForms(item.adj);
  let same;
  if (plural) same = Object.values(F.p).filter(Boolean);
  else same = Object.values(n.g === 'f' ? F.f : n.g === 'n' ? F.n : F.m);
  const all = uniq([...Object.values(F.m), ...Object.values(F.f), ...Object.values(F.n), ...Object.values(F.p).filter(Boolean)]);
  const adjD = pick3(uniq(same).filter(x => x !== ca), all.filter(x => x !== ca));
  const sameN = uniq(plural ? n.pl : n.sg).filter(x => x !== cn);
  const allN = uniq([...n.sg, ...n.pl]).filter(x => x !== cn);
  const nounD = pick3(sameN, allN);
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

