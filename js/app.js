// ===================== Хранилище =====================
// Облако (db артефакта): progress/<ID> — ответы сессии, sessions/<ID> — вопросы сессии,
// legacy/<ID> — старая статистика из браузера, meta/main — служебное (resetAt).
// Если облако недоступно — то же самое в localStorage.
const LOCAL_KEY = 'pl-cases-v2';
const OLD_KEY = 'pl-cases-trainer-v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const Store = {
  db: null,
  cloud: false,
  status: '',
  local: null,
  async init() {
    try {
      const c = window.claude;
      if (c && typeof c.use === 'function') {
        const db = await Promise.race([c.use('db'), sleep(10000).then(() => null)]);
        if (db) { this.db = db; this.cloud = true; }
      }
    } catch (e) { this.db = null; this.cloud = false; }
    if (!this.cloud) {
      try { this.local = JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch (e) {}
      this.local = this.local || {};
      ['progress', 'questions', 'legacy'].forEach(k => this.local[k] = this.local[k] || {});
      this.local.meta = this.local.meta || {};
    }
  },
  saveLocal() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this.local)); }
    catch (e) {
      // места мало: удаляем вопросы законченных сессий
      Object.keys(this.local.questions).forEach(id => { const p = this.local.progress[id]; if (!p || p.done) delete this.local.questions[id]; });
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this.local)); } catch (e2) { setStatus('Nie udało się zapisać (brak miejsca w przeglądarce).'); }
    }
  },
  async listAll(col) {
    if (!this.cloud) return Object.values(this.local[col === 'progress' ? 'progress' : 'legacy']);
    const out = [];
    const snap = await this.db.collection(col).get();
    snap.docs.forEach(d => { if (d.exists) out.push(d.data()); });
    return out;
  },
  async getDoc(path) {
    if (!this.cloud) {
      const [col, id] = path.split('/');
      if (col === 'meta') return this.local.meta;
      return (this.local[col === 'sessions' ? 'questions' : col] || {})[id] || null;
    }
    const d = await this.db.doc(path).get();
    return d.exists ? d.data() : null;
  },
  pend: {}, busy: {},
  write(path, data) {
    if (!this.cloud) {
      const [col, id] = path.split('/');
      if (col === 'meta') this.local.meta = data;
      else this.local[col === 'sessions' ? 'questions' : col][id] = data;
      this.saveLocal();
      return Promise.resolve();
    }
    this.pend[path] = data;
    if (!this.busy[path]) return this.flush(path);
    return Promise.resolve();
  },
  async flush(path) {
    this.busy[path] = true;
    while (this.pend[path] !== undefined) {
      const d = this.pend[path]; delete this.pend[path];
      try { await this.db.doc(path).set(d); }
      catch (e) {
        if (!e || e.code === 'unavailable') {
          await sleep(600 + Math.random() * 800);
          try { await this.db.doc(path).set(d); } catch (e2) { setStatus('Nie udało się zapisać — sprawdź połączenie.'); }
        } else if (e.code === 'quota_exceeded') setStatus('Brak miejsca w chmurze — usuń stare sesje.');
        else setStatus('Nie udało się zapisać (' + e.code + ').');
      }
    }
    this.busy[path] = false;
  },
  async remove(path) {
    if (!this.cloud) {
      const [col, id] = path.split('/');
      delete this.local[col === 'sessions' ? 'questions' : col][id];
      this.saveLocal(); return;
    }
    try { await this.db.doc(path).delete(); } catch (e) { setStatus('Nie udało się usunąć.'); }
  },
};
function setStatus(t) { Store.status = t; const el = document.getElementById('status'); if (el) el.textContent = t; }

// ===================== Данные в памяти =====================
let progress = {};   // id -> документ progress
let legacies = [];
let meta = {};
let stats = { cells: {}, tcells: {}, log: [], tlog: [] };
let loaded = false;

const CK = kind => kind === 'type' ? 'tcells' : 'cells';
const LK = kind => kind === 'type' ? 'tlog' : 'log';
function totalN(kind) { return Object.values(stats[CK(kind)]).reduce((a, s) => a + s.n, 0); }

const POOL = buildPool();
const BY_CELL = {};
POOL.forEach(p => (BY_CELL[p.cell] = BY_CELL[p.cell] || []).push(p));
// Równomiernie: najpierw kategoria (ludzie, zwierzęta, rzeczy…), potem rzeczownik, potem zdanie
const BY_CELL_CAT = {};
POOL.forEach(p => { const c = NOUNS[p.ni].cat; const m = (BY_CELL_CAT[p.cell] = BY_CELL_CAT[p.cell] || {}); const k = (m[c] = m[c] || {}); (k[p.ni] = k[p.ni] || []).push(p); });
const rnd = a => a[Math.floor(Math.random() * a.length)];
const ikey = o => o.ti + '|' + o.ni + '|' + o.plural;
function pickItem(cell, used) {
  const m = BY_CELL_CAT[cell];
  for (let t = 0; t < 40; t++) {
    const byNoun = m[rnd(Object.keys(m))];
    const it = rnd(byNoun[rnd(Object.keys(byNoun))]);
    if (!used.has(ikey(it))) return it;
  }
  const free = BY_CELL[cell].filter(o => !used.has(ikey(o)));
  return rnd(free.length ? free : BY_CELL[cell]);
}
const ALL_CELLS = [];
// mianownik l. poj. pomijamy: forma jest taka sama jak podana
const SKIP = c => c.startsWith('0:') && !c.endsWith(':pv') && !c.endsWith(':pn');
for (let c = 0; c < 6; c++) GROUPS.forEach(g => { const id = c + ':' + g.id; if (!SKIP(id)) ALL_CELLS.push(id); });
const NC = ALL_CELLS.length;
const ROUNDS = [4, 5, 6, 7].map(r => r * NC);

// ===================== Plan nauki: co powtarzać =====================
const DAY = 86400000, STEPS = [1, 3, 7];
const RULE_OF_TI = TEMPLATES.map(t => ruleLabel(t.hint));
const CASE_OF_TI = TEMPLATES.map(t => t.c);
let TRAP_ITEMS = null;
function trapItems() {
  if (TRAP_ITEMS) return TRAP_ITEMS;
  TRAP_ITEMS = {};
  POOL.forEach(p => { if (SKIP(p.cell)) return; const k = trapKind(NOUNS[p.ni], TEMPLATES[p.ti].c, p.plural); if (k) (TRAP_ITEMS[k] = TRAP_ITEMS[k] || []).push(p); });
  return TRAP_ITEMS;
}
function computePlan(all) {
  const rules = {}, traps = {}, conf = {}, wantN = {};
  const add = (m, k, r) => { const x = (m[k] = m[k] || { n: 0, w: 0, last: null }); x.n++; if (!r.ok) { x.w++; x.last = r; } return x; };
  all.forEach(r => {
    if (r.rl) add(rules, r.rl, r);
    if (r.tk) { const x = (traps[r.tk] = traps[r.tk] || { n: 0, w: 0, last: null }); x.n++; if (!r.no) { x.w++; x.last = r; } }
    const [ci, g] = r.c.split(':'); const want = CASES[+ci].id + (g === 'pv' || g === 'pn' ? '+' : '');
    wantN[want] = (wantN[want] || 0) + 1;
    if (!r.ok && r.cc && r.et !== 'dia') { const k = want + '>' + r.cc; const x = (conf[k] = conf[k] || { w: 0, last: null, want, got: r.cc }); x.w++; x.last = r; }
  });
  const out = [];
  Object.entries(rules).forEach(([k, x]) => { if (x.w >= 2 && x.w / x.n >= 0.3) out.push({ kind: 'rule', key: k, n: x.n, w: x.w, score: x.w * x.w / x.n, last: x.last }); });
  Object.entries(traps).forEach(([k, x]) => { if (x.w >= 2 && x.w / x.n >= 0.3) out.push({ kind: 'trap', key: k, n: x.n, w: x.w, score: x.w * x.w / x.n * 1.1, last: x.last }); });
  Object.values(conf).forEach(x => { const n = wantN[x.want] || 1; if (x.w >= 2 && x.w / n >= 0.15) out.push({ kind: 'conf', key: x.want + '>' + x.got, want: x.want, got: x.got, n, w: x.w, score: x.w * x.w / n * 0.9, last: x.last }); });
  out.sort((a, b) => b.score - a.score);
  const picked = [], seenWant = new Set();
  for (const p of out) {
    if (p.kind === 'conf') { if (seenWant.has(p.want)) continue; seenWant.add(p.want); }
    picked.push(p); if (picked.length >= 3) break;
  }
  return { items: picked, enough: all.length >= 30 };
}
function computeReview(all) {
  const m = {};
  all.forEach(r => {
    if (r.ti == null || SKIP(r.c)) return;
    const k = r.ti + '|' + r.c, t = r.t || 0;
    const x = m[k] || (m[k] = { ti: r.ti, cell: r.c, stage: 0, due: 0, active: false, ni: r.ni });
    if (!r.ok) { x.active = true; x.stage = 0; x.due = t + DAY; x.ni = r.ni; x.last = r; }
    else if (x.active && t >= x.due - 3 * 3600000) { x.stage++; if (x.stage >= STEPS.length) x.active = false; else x.due = t + STEPS[x.stage] * DAY; }
  });
  const now = Date.now(), act = Object.values(m).filter(x => x.active);
  const due = act.filter(x => x.due <= now).sort((a, b) => a.due - b.due);
  const later = act.filter(x => x.due > now).sort((a, b) => a.due - b.due);
  return { due, later, next: later[0] ? later[0].due : null };
}
function caseLabel(k) { const c = CASES.find(x => x.id === k[0]); return c.ru + (k.endsWith('+') ? ' (l. mn.)' : ''); }
function planText(p) {
  if (p.kind === 'rule') {
    const tis = TEMPLATES.map((t, i) => i).filter(i => RULE_OF_TI[i] === p.key);
    const cs = [...new Set(tis.map(i => CASES[CI[CASE_OF_TI[i]]]))].map(c => `${c.ru} (${c.pl})`).join(', ');
    return { title: p.key, desc: `Potrzebny przypadek: ${cs}.` };
  }
  if (p.kind === 'trap') return { title: TRAP_INFO[p.key].t, desc: TRAP_INFO[p.key].d };
  const w = CASES.find(x => x.id === p.want[0]);
  return { title: `${caseLabel(p.got)} zamiast: ${caseLabel(p.want)}`, desc: `Gdy zdanie wymaga przypadku ${w.ru} (${w.pl}), wybierasz ${caseLabel(p.got)}.` };
}
function mistakeHTML(r) {
  if (!r || !r.s) return '';
  const got = esc((r.ga || '') + ' ' + (r.gn || ''));
  return `<div class="mist"><span class="muted">Twój błąd:</span> ${esc(r.s).replace('___', `<s>${got}</s> <b>${esc(r.rt || '')}</b>`)}</div>`;
}
function drillItems(p) {
  if (p.kind === 'rule') {
    let keys = [p.key];
    const m = p.key.match(/^(pod|na|za|nad) \+/);                       // ruch i miejsce razem — dla kontrastu
    if (m) keys = [...new Set(RULE_OF_TI.filter(l => l && l.startsWith(m[1] + ' +')))];
    return POOL.filter(o => keys.includes(RULE_OF_TI[o.ti]) && !SKIP(o.cell));
  }
  if (p.kind === 'trap') return trapItems()[p.key] || [];
  const ci = CI[p.want[0]], pl = p.want.endsWith('+');
  return POOL.filter(o => !SKIP(o.cell) && CI[TEMPLATES[o.ti].c] === ci && o.plural === pl);
}
function startDrill(p, kind) {
  const t = planText(p);
  session = sessionFromItems(pickVaried(drillItems(p), 15), 'focus', kind, 'Ćwicz: ' + t.title);
  tab = 'train'; document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.dataset.tab === 'train'));
  render(); window.scrollTo(0, 0);
}
function startReview(kind) {
  const items = stats.review.due.slice(0, 30).map(x => {
    const c = POOL.filter(o => o.ti === x.ti && o.cell === x.cell);
    const other = c.filter(o => o.ni !== x.ni);
    return rnd(other.length ? other : (c.length ? c : BY_CELL[x.cell]));
  });
  session = sessionFromItems(shuffle(items), 'review', kind, 'Powtórka błędów');
  render(); window.scrollTo(0, 0);
}
function whenText(t) {
  const d = Math.round((t - Date.now()) / DAY);
  return d <= 0 ? 'dziś później' : d === 1 ? 'jutro' : `za ${d} ${plural(d, 'dzień', 'dni', 'dni')}`;
}
function planHTML(where) {
  const P = stats.plan, R = stats.review;
  const rev = R.due.length
    ? `<div class="card plan-rev"><div class="lbl">Do powtórki dziś: ${R.due.length}</div>
        <div class="muted">Pytania, w których pomyliłeś się wcześniej, z nowymi słowami. Błąd znika po trzech dobrych powtórkach (po 1, 3 i 7 dniach).</div>
        <button class="big" id="revBtn">Powtórz ${pyt(Math.min(30, R.due.length))}</button></div>`
    : (R.later.length ? `<div class="card plan-rev quiet"><div class="lbl">Na dziś wszystko powtórzone</div><div class="muted">W kolejce: ${R.later.length}. Następna powtórka ${whenText(R.next)}.</div></div>` : '');
  let body;
  if (!P.items.length) body = `<div class="muted">${P.enough ? 'Nie widać powtarzających się błędów. Tak trzymaj — albo przejdź etap 2 (wpisywanie).' : 'Plan pojawi się po około 30 odpowiedziach: wtedy będzie widać, które błędy się powtarzają.'}</div>`;
  else body = P.items.map((p, i) => {
    const t = planText(p);
    return `<div class="prob">
      <div class="ptop"><div class="ptitle">${esc(t.title)}</div><div class="pstat">${p.n - p.w} z ${p.n}</div></div>
      <div class="pdesc">${esc(t.desc)}</div>
      ${mistakeHTML(p.last)}
      <button class="ghost drill" data-drill="${i}">Ćwicz to (15 pytań)</button>
    </div>`;
  }).join('');
  if (where === 'start') return rev;
  return rev + `<div class="card plan"><div class="lbl">Co ćwiczyć</div>${body}</div>`;
}
// Ćwiczenie z drzewa: przypadek + liczba, słabsze rodzaje częściej
function startCaseDrill(key, kind) {
  const [ci, num] = key.split('|'), cells = stats[CK(kind)];
  const ids = (num === 'sg' ? SG_G : PL_G).map(([g]) => ci + ':' + g).filter(id => !SKIP(id));
  const w = ids.map(id => { const x = cells[id]; return x && x.n ? Math.pow((x.wrong + 1) / (x.n + 2), 2) : 0.15; });
  const sum = w.reduce((a, b) => a + b, 0), used = new Set(), items = [];
  for (let k = 0; k < 15; k++) {
    let r = Math.random() * sum, j = 0; while (r > w[j] && j < w.length - 1) { r -= w[j]; j++; }
    const it = pickItem(ids[j], used); used.add(ikey(it)); items.push(it);
  }
  const c = CASES[+ci];
  session = sessionFromItems(items, 'focus', kind, `Ćwicz: ${c.ru}, ${num === 'sg' ? 'l. poj.' : 'l. mn.'}`);
  tab = 'train'; document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.dataset.tab === 'train'));
  render(); window.scrollTo(0, 0);
}
function bindPlan(kind) {
  document.querySelectorAll('[data-cdrill]').forEach(b => b.onclick = () => startCaseDrill(b.dataset.cdrill, kind));
  const rb = document.getElementById('revBtn'); if (rb) rb.onclick = () => startReview(kind);
  document.querySelectorAll('[data-drill]').forEach(b => b.onclick = () => startDrill(stats.plan.items[+b.dataset.drill], kind));
}

function emptyAn() { return { hist: {}, rules: {}, types: {}, conf: {}, errs: 0, untyped: 0 }; }
// stan pola: mało danych / słabe / opanowane (ostatnie 5 odpowiedzi dobrze)
function cellState(kind, c) {
  const h = (stats.an && stats.an[kind].hist[c]) || [];
  if (h.length < 3) return 'few';
  if (h.length >= 5 && h.slice(-5).every(x => x[1])) return 'done';
  return 'open';
}
// uzupełnienie analizy dla starszych odpowiedzi (z zapisanych pytań sesji)
async function backfill() {
  let changed = false;
  for (const p of Object.values(progress)) {
    if (!(p.r || []).some(r => r.rl === undefined)) continue;
    let q = null; try { q = await Store.getDoc('sessions/' + p.id); } catch (e) {}
    if (!q || !q.questions) continue;
    p.r.forEach((r, k) => {
      if (r.rl !== undefined) return;
      const qq = q.questions[r.qi != null ? r.qi : k];
      if (!qq || qq.ni == null) { r.rl = null; return; }
      const an = analyzeAnswer(qq, r.ga, r.gn, r.ao, r.no, r.d);
      r.rl = an.rl || null; if (an.et) r.et = an.et; if (an.cc) r.cc = an.cc;
      if (qq.ti != null) r.ti = qq.ti;
      r.ni = qq.ni; const tk = trapKind(NOUNS[qq.ni], CASES[qq.caseIdx].id, qq.plural); if (tk) r.tk = tk;
      changed = true;
    });
  }
  if (changed) { recompute(); if (tab === 'stats') render(); }
}

function recompute() {
  const st = { cells: {}, tcells: {}, log: [], tlog: [], all: [], an: { choice: emptyAn(), type: emptyAn() } };
  const resetAt = meta.resetAt || 0;
  const cs = (k, c) => st[k][c] || (st[k][c] = { n: 0, wrong: 0, adjWrong: 0, nounWrong: 0 });
  legacies.forEach(L => {
    if ((L.t || 0) <= resetAt) return;
    ['cells', 'tcells'].forEach(k => Object.entries(L[k] || {}).forEach(([c, s]) => {
      if (SKIP(c)) return; const x = cs(k, c); x.n += s.n || 0; x.wrong += s.wrong || 0; x.adjWrong += s.adjWrong || 0; x.nounWrong += s.nounWrong || 0;
    }));
    ['log', 'tlog'].forEach(k => (L[k] || []).forEach(e => { if (!SKIP(e.cell)) st[k].push(Object.assign({ t: L.t }, e)); }));
  });
  Object.values(progress).forEach(p => {
    const k = CK(p.kind), lk = LK(p.kind);
    (p.r || []).forEach(r => {
      if ((r.t || 0) <= resetAt || SKIP(r.c)) return;
      const x = cs(k, r.c); x.n++; if (!r.ok) x.wrong++; if (!r.ao) x.adjWrong++; if (!r.no) x.nounWrong++;
      if (!r.ok) st[lk].push({ s: r.s, base: r.b, cell: r.c, right: r.rt, got: r.ga + ' ' + r.gn, dia: r.d || undefined, t: r.t });
      st.all.push(r);
      const A = st.an[p.kind === 'type' ? 'type' : 'choice'];
      (A.hist[r.c] = A.hist[r.c] || []).push([r.t || 0, !!r.ok]);
      if (r.rl) { const x = (A.rules[r.rl] = A.rules[r.rl] || { n: 0, w: 0 }); x.n++; if (!r.ok) x.w++; }
      if (!r.ok) {
        A.errs++;
        if (r.et) A.types[r.et] = (A.types[r.et] || 0) + 1; else A.untyped++;
        if (r.cc) {
          const [ci, g] = r.c.split(':'); const want = CASES[+ci].id + (g === 'pv' || g === 'pn' ? '+' : '');
          const m = (A.conf[want] = A.conf[want] || { n: 0 }); m.n++; m[r.cc] = (m[r.cc] || 0) + 1;
        }
      }
    });
  });
  ['choice', 'type'].forEach(k => Object.values(st.an[k].hist).forEach(h => h.sort((a, b) => a[0] - b[0])));
  st.log.sort((a, b) => (a.t || 0) - (b.t || 0)); st.tlog.sort((a, b) => (a.t || 0) - (b.t || 0));
  st.all.sort((a, b) => (a.t || 0) - (b.t || 0));
  st.plan = computePlan(st.all);
  st.review = computeReview(st.all);
  stats = st;
}

async function loadAll() {
  try {
    meta = (await Store.getDoc('meta/main')) || {};
    const [ps, ls] = await Promise.all([Store.listAll('progress'), Store.listAll('legacy')]);
    progress = {}; ps.forEach(p => { if (p && p.id) progress[p.id] = p; });
    legacies = ls || [];
    // однократный перенос старой статистики из этого браузера
    let old = null; try { old = JSON.parse(localStorage.getItem(OLD_KEY)); } catch (e) {}
    if (old && old.cells && !meta.legacyImported) {
      const id = 'L' + newId();
      const doc = { id, t: Date.now(), cells: old.cells || {}, tcells: old.tcells || {}, log: (old.log || []).slice(-100), tlog: (old.tlog || []).slice(-100) };
      legacies.push(doc);
      await Store.write('legacy/' + id, doc);
      meta = Object.assign({}, meta, { legacyImported: true });
      await Store.write('meta/main', meta);
    }
  } catch (e) {
    setStatus('Nie udało się wczytać danych z chmury.');
  }
  recompute();
  loaded = true;
}

// ===================== Сессии =====================
const ID_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newId() { let s = ''; for (let i = 0; i < 6; i++) s += ID_ABC[Math.floor(Math.random() * ID_ABC.length)]; return s; }

let tab = 'train';
let stage = 'choice';
let statsKind = 'choice';
let session = null;
let confirmReset = false;
let confirmDel = null;
let openErr = '';

document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
  render();
});

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function caseName(i) { return CASES[i].ru + ' (' + CASES[i].pl + ')'; }
function groupName(id) { return GROUPS.find(g => g.id === id).ru; }
const plural = (n, a, b, c) => n === 1 ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? b : c;
const pyt = n => n + ' ' + plural(n, 'pytanie', 'pytania', 'pytań');
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const DIA = { 'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z' };
const plain = s => norm(s).replace(/[ąćęłńóśźż]/g, c => DIA[c]);
const kindName = k => k === 'type' ? 'wpisywanie' : 'wybór';
function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildSession(mode, count, kind) {
  let cells = [];
  if (mode === 'test') {
    const rounds = Math.ceil(count / NC);
    for (let r = 0; r < rounds; r++) cells.push(...shuffle([...ALL_CELLS]));
    cells = cells.slice(0, count);
  } else {
    const useBoth = kind === 'type' && totalN('type') < NC;
    const w = ALL_CELLS.map(c => {
      let n = 0, wr = 0;
      [CK(kind), ...(useBoth ? ['cells'] : [])].forEach(k => { const s = stats[k][c]; if (s) { n += s.n; wr += s.wrong; } });
      return Math.pow((wr + 1) / (n + 2), 2) * (cellState(kind, c) === 'done' ? 0.15 : 1);
    });
    const sum = w.reduce((a, b) => a + b, 0);
    for (let k = 0; k < count; k++) {
      let r = Math.random() * sum, idx = 0;
      while (r > w[idx] && idx < w.length - 1) { r -= w[idx]; idx++; }
      cells.push(ALL_CELLS[idx]);
    }
    for (let k = 1; k < cells.length; k++) if (cells[k] === cells[k - 1]) {
      const j = cells.findIndex((c, m) => m > k && c !== cells[k]); if (j > 0) [cells[k], cells[j]] = [cells[j], cells[k]];
    }
  }
  const used = new Set();
  const items = cells.map(cell => {
    const item = pickItem(cell, used);
    used.add(item.ti + '|' + item.ni + '|' + item.plural);
    return item;
  });
  return sessionFromItems(items, mode, kind);
}
function shapeQuestion(item) {
  const q = makeQuestion(item);
  return { cell: q.cell, caseIdx: q.caseIdx, group: q.group, sentence: q.sentence, base: q.base, plural: q.plural,
    adjAnswer: q.adjAnswer, nounAnswer: q.nounAnswer, adjOptions: q.adjOptions, nounOptions: q.nounOptions, hint: q.hint,
    ti: q.ti, ni: q.ni, ex: exampleFor(q, BY_CELL[q.cell]) };
}
function sessionFromItems(items, mode, kind, title) {
  const questions = items.map(shapeQuestion), count = questions.length;
  let id; do { id = newId(); } while (progress[id]);
  const now = Date.now();
  const s = { id, mode, kind, count, title, questions, i: 0, results: [], byQ: {}, front: 0, createdAt: now, selAdj: null, selNoun: null, inAdj: '', inNoun: '' };
  Store.write('sessions/' + id, { id, mode, kind, count, title: title || null, createdAt: now, questions });
  saveProgress(s);
  return s;
}
// wybór różnorodnych pozycji z listy: różne słowa i zdania, potem dopiero powtórki
function pickVaried(list, count) {
  const out = [], seen = new Set(), pool = shuffle([...list]);
  for (const it of pool) { const k = it.ni + '|' + it.ti; if (seen.has(k)) continue; seen.add(k); out.push(it); if (out.length >= count) return out; }
  for (const it of pool) { if (out.length >= count) break; if (!out.includes(it)) out.push(it); }
  return shuffle(out);
}

function firstUnanswered(s) { for (let k = 0; k < s.count; k++) if (!s.byQ[k]) return k; return -1; }
function nextUnanswered(s, from) { for (let k = 1; k <= s.count; k++) { const idx = (from + k) % s.count; if (!s.byQ[idx]) return idx; } return -1; }
function exampleOf(q) {
  if (q.ex === undefined) {
    const pool = BY_CELL[q.cell] || [];
    const noun = q.base.split(' ').pop();
    q.ex = exampleFor({ ni: pool.length ? -1 : -1, ti: -1 }, pool.filter(p => NOUNS[p.ni].sg[0] !== noun));
  }
  return q.ex;
}

function progressDoc(s) {
  return {
    id: s.id, mode: s.mode, kind: s.kind, count: s.count, title: s.title || null, createdAt: s.createdAt, updatedAt: Date.now(),
    done: s.results.length >= s.count, r: s.results.map(x => x.raw),
  };
}
function saveProgress(s) {
  const doc = progressDoc(s);
  progress[s.id] = doc;
  Store.write('progress/' + s.id, doc);
}

async function resumeSession(id) {
  id = String(id || '').trim().toUpperCase();
  openErr = '';
  const p = progress[id] || await Store.getDoc('progress/' + id);
  const q = await Store.getDoc('sessions/' + id);
  if (!p || !q || !q.questions) { openErr = `Nie znaleziono sesji ${esc(id)}.`; render(); return; }
  progress[id] = p;
  const results = (p.r || []).map((raw, k) => ({ cell: raw.c, ok: raw.ok, adjOk: raw.ao, nounOk: raw.no, diaOnly: !!raw.d, gotA: raw.ga, gotN: raw.gn, qi: raw.qi != null ? raw.qi : k, raw }));
  const byQ = {}; results.forEach(r => byQ[r.qi] = r);
  session = { id, mode: q.mode, kind: q.kind, count: q.count, title: q.title || null, questions: q.questions, i: 0, results, byQ,
    createdAt: q.createdAt, selAdj: null, selNoun: null, inAdj: '', inNoun: '' };
  const first = firstUnanswered(session);
  if (first < 0) session.finished = true; else session.i = first;
  // najdalsze miejsce, do którego doszedł użytkownik: dalej przyciskiem „Dalej” nie wolno
  session.front = Math.max(session.i, ...results.map(r => r.qi));
  stage = q.kind;
  render(); window.scrollTo(0, 0);
}

// ===================== Рендер =====================
function render() {
  const v = document.getElementById('view');
  const hz = document.getElementById('hfsz'); if (hz) { hz.innerHTML = fszHTML(); }
  document.body.classList.remove('focus');
  if (!loaded) { v.innerHTML = '<div class="card muted">Wczytywanie…</div>'; return; }
  if (tab === 'stats') { v.innerHTML = statsHTML() + footer(); bindStats(); bindFsz(); return; }
  if (!session) { v.innerHTML = startHTML() + footer(); bindStart(); bindFsz(); return; }
  if (session.finished || session.paused) { v.innerHTML = finishHTML() + footer(); bindFinish(); bindFsz(); return; }
  document.body.classList.add('focus');
  v.innerHTML = questionHTML() + footer(); bindQuestion(); bindFsz();
}
function footer() {
  const sid = session && !session.finished && !session.paused && tab === 'train' ? `Sesja <span class="sid">${esc(session.id)}</span>. ` : '';
  return `<div class="foot">${sid}${Store.cloud ? 'Wyniki zapisują się w chmurze i są dostępne na każdym urządzeniu.' : 'Wyniki zapisują się tylko w tej przeglądarce.'}
  <div id="status">${esc(Store.status)}</div></div>`;
}

function stageSwitch(id, cur) {
  return `<div class="seg" id="${id}">
    <button data-k="choice" class="${cur === 'choice' ? 'on' : ''}">1. Wybór</button>
    <button data-k="type" class="${cur === 'type' ? 'on' : ''}">2. Wpisywanie</button></div>`;
}

let selSess = null;
function unfinishedHTML() {
  const list = Object.values(progress).filter(p => !p.done).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!list.length) return openErr ? `<div class="card"><div class="fix">${openErr}</div></div>` : '';
  if (!list.find(p => p.id === selSess)) selSess = list[0].id;
  return `
  <div class="card">
    <div class="lbl">Niedokończone sesje (${list.length})</div>
    <div class="sessrow">
      <select id="sessSel" class="sesssel">
        ${list.map(p => `<option value="${esc(p.id)}" ${p.id === selSess ? 'selected' : ''}>${esc(p.id)} · ${esc(p.title || kindName(p.kind))} · ${(p.r || []).length} z ${p.count} · ${fmtDate(p.updatedAt)}</option>`).join('')}
      </select>
      <button class="ibtn go" id="contBtn" title="Kontynuuj" aria-label="Kontynuuj">
        <svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></button>
      ${confirmDel === selSess
        ? `<button class="ibtn del on" id="delYes" title="Kliknij jeszcze raz, aby usunąć" aria-label="Potwierdź usunięcie">
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
        : `<button class="ibtn del" id="delBtn" title="Usuń" aria-label="Usuń">
            <svg viewBox="0 0 24 24" width="21" height="21"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`}
    </div>
    ${confirmDel === selSess ? '<div class="fix" style="margin-top:6px">Usunąć tę sesję? Kliknij ✓, aby potwierdzić.</div>' : ''}
    ${openErr ? `<div class="fix">${openErr}</div>` : ''}
  </div>`;
}

function startHTML() {
  const total = totalN(stage), anyTotal = totalN('choice') + totalN('type');
  const descr = stage === 'choice'
    ? 'Wybierasz przymiotnik i rzeczownik spośród czterech wariantów.'
    : 'Wpisujesz obie formy samodzielnie. Wielkość liter nie ma znaczenia, polskie znaki (ą, ę, ł, ó, ś, ż…) — mają.';
  return `
  ${unfinishedHTML()}
  ${planHTML('start')}
  <h2 class="sub">Nowa sesja</h2>
  ${stageSwitch('stageSw', stage)}
  <div class="muted" style="margin:-4px 0 12px">${descr}</div>
  <div class="card">
    <div class="lbl">Test: wszystkie pola po równo</div>
    <div class="muted">${NC} pól: 6 przypadków × 7 grup rodzaju i liczby, bez mianownika w liczbie pojedynczej (tam forma się nie zmienia). Każda runda przechodzi przez wszystkie pola po razie, w losowej kolejności.</div>
    <div style="margin-top:8px">
      ${ROUNDS.map((n, k) => [n, ['4 rundy', '5 rund', '6 rund', '7 rund'][k]]).map(([n, t]) =>
        `<label class="opt"><input type="radio" name="cnt" value="${n}" ${n === (stage === 'choice' ? ROUNDS[2] : ROUNDS[0]) ? 'checked' : ''}> ${pyt(n)} <span class="muted">(${t})</span></label>`).join('')}
    </div>
    <button class="big" id="startTest">Rozpocznij test</button>
  </div>
  <div class="card">
    <div class="lbl">Słabe punkty</div>
    <div class="muted">30 pytań, najczęściej z pól, w których jest najwięcej błędów.${total < NC ? ' Najlepiej najpierw przejść przynajmniej jedną rundę testu na tym etapie.' : ''}</div>
    <button class="big" id="startWeak" ${anyTotal === 0 ? 'disabled' : ''}>Ćwicz słabe punkty</button>
  </div>
  <div class="muted">Odpowiedzi w statystykach: wybór — ${totalN('choice')}, wpisywanie — ${totalN('type')}.</div>`;
}
function bindSeg(id, set) {
  document.querySelectorAll('#' + id + ' button').forEach(b => b.onclick = () => { set(b.dataset.k); render(); });
}
function bindStart() {
  bindSeg('stageSw', k => stage = k);
  bindPlan(stage);
  document.getElementById('startTest').onclick = () => {
    const n = +document.querySelector('input[name=cnt]:checked').value;
    session = buildSession('test', n, stage); render();
  };
  document.getElementById('startWeak').onclick = () => { session = buildSession('weak', 30, stage); render(); };
  const sel = document.getElementById('sessSel');
  if (sel) {
    sel.onchange = () => { selSess = sel.value; confirmDel = null; render(); };
    document.getElementById('contBtn').onclick = () => resumeSession(selSess);
    const db_ = document.getElementById('delBtn'); if (db_) db_.onclick = () => { confirmDel = selSess; render(); };
    const dy = document.getElementById('delYes'); if (dy) dy.onclick = async () => {
      const id = selSess; confirmDel = null; selSess = null;
      delete progress[id]; recompute(); render();
      await Store.remove('progress/' + id); await Store.remove('sessions/' + id);
    };
  }
}

const ICON = {
  stats: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M5 20V11M12 20V5M19 20v-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ok: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bad: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  tag: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 12V4h8l10 10-8 8L3 12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7.5" cy="8.5" r="1.4" fill="currentColor"/></svg>',
  noun: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 10h8M8 14h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  okc: '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  badc: '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round"/></svg>',
};
// ---- Rozmiar tekstu (zapamiętany w przeglądarce)
const ZOOMS = [0.85, 0.92, 1, 1.08, 1.16, 1.25, 1.35];
let zoomIdx = 2;
try { const z = +localStorage.getItem('pp-zoom'); const i = ZOOMS.indexOf(z); if (i >= 0) zoomIdx = i; } catch (e) {}
function applyZoom() { document.documentElement.style.setProperty('--z', ZOOMS[zoomIdx]); }
applyZoom();
function fszHTML() {
  return `<span class="fsz" role="group" aria-label="Rozmiar tekstu"><button data-fz="-1" title="Mniejszy tekst" aria-label="Mniejszy tekst" ${zoomIdx === 0 ? 'disabled' : ''}>A−</button><button class="big-a" data-fz="1" title="Większy tekst" aria-label="Większy tekst" ${zoomIdx === ZOOMS.length - 1 ? 'disabled' : ''}>A+</button></span>`;
}
function bindFsz() {
  document.querySelectorAll('[data-fz]').forEach(b => b.onclick = () => {
    zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, zoomIdx + +b.dataset.fz));
    try { localStorage.setItem('pp-zoom', ZOOMS[zoomIdx]); } catch (e) {}
    applyZoom(); render();
  });
}
const NUM_TXT = pl => pl ? 'liczba mnoga' : 'liczba pojedyncza';
function verdictText(q, res) {
  const c = CASES[q.caseIdx], g = groupName(q.group).replace(/^l\. (poj|mn)\., /, '');
  const where = `${c.ru}, ${NUM_TXT(q.plural)}, ${g}`;
  const R = rulesFor(c.id, q.group);
  if (res.ok) return { head: 'Dobrze!', line: `${q.hint}` };
  if (res.diaOnly) return { head: 'Prawie — tylko polskie znaki.', line: 'Forma jest dobra, sprawdź ą, ę, ł, ó, ś, ż.' };
  const et = res.raw && res.raw.et;
  if (et === 'przypadek') return { head: 'Zły przypadek.', line: `${q.hint} Wybrałeś ${caseLabel(res.raw.cc)}.` };
  if (et === 'liczba') return { head: 'Zła liczba.', line: `Potrzebna ${NUM_TXT(q.plural)}.` };
  if (et === 'forma') {
    const tk = res.raw.tk && TRAP_INFO[res.raw.tk];
    return { head: 'Takiej formy nie ma.', line: tk ? tk.d : `${where}: rzeczownik ${R.noun}.` };
  }
  if (!res.adjOk && res.nounOk) return { head: 'Błędny przymiotnik.', line: `To ${where}, dlatego przymiotnik ma formę ${q.adjAnswer}. Końcówka: ${R.adj.replace(/-/g, '\u2011')}.` };
  if (res.adjOk && !res.nounOk) return { head: 'Błędny rzeczownik.', line: `To ${where}, dlatego rzeczownik ma formę ${q.nounAnswer}.` };
  return { head: 'Oba słowa są błędne.', line: `${q.hint} To ${where}.` };
}
function questionHTML() {
  const s = session, q = s.questions[s.i], typing = s.kind === 'type';
  const res = s.byQ[s.i], done = !!res;
  const curA = done ? res.gotA : (typing ? s.inAdj : s.selAdj), curN = done ? res.gotN : (typing ? s.inNoun : s.selNoun);
  const w = Math.max(q.base.length * 0.8, 9, done ? (q.adjAnswer.length + q.nounAnswer.length + 1) * 0.85 : 0);
  const pa = typing && !done ? norm(curA) : curA, pn = typing && !done ? norm(curN) : curN;
  const pick = (pa || pn) ? esc(pa || '…') + ' ' + esc(pn || '…') : '&nbsp;';
  const filled = `<span class="slot ${done ? (res.ok ? 'ok' : 'bad') : ''}"><span class="stop">${esc(q.base)}</span><span class="gap ${done ? '' : 'pick'}" id="gap" style="min-width:${w}ch">${done ? esc(q.adjAnswer) + ' ' + esc(q.nounAnswer) : pick}</span><span class="sbot num ${q.plural ? 'pl' : 'sg'}">${NUM_TXT(q.plural)}</span></span>`;
  const sentence = esc(q.sentence).replace('___', filled);
  const btn = (opt, kind) => {
    const sel = kind === 'adj' ? curA : curN, ans = kind === 'adj' ? q.adjAnswer : q.nounAnswer;
    let cls = 'choice', ic = '';
    if (done) { if (opt === ans) { cls += ' ok'; ic = ICON.ok; } else if (opt === sel) { cls += ' bad'; ic = ICON.bad; } }
    else if (opt === sel) cls += ' sel';
    return `<button class="${cls}" data-kind="${kind}" data-v="${esc(opt)}" ${done ? 'disabled' : ''}><span>${esc(opt)}</span>${ic ? `<i class="cic">${ic}</i>` : ''}</button>`;
  };
  const inp = (id, val, ok, ph) => `<input class="tin ${done ? (ok ? 'ok' : 'bad') : ''}" id="${id}" value="${esc(val || '')}" placeholder="${ph}"
      autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" lang="pl" ${done ? 'disabled' : ''}>`;
  const sec = (icon, label) => `<div class="sec">${icon}<span>${label}</span></div>`;
  const body = typing
    ? `${sec(ICON.tag, 'Przymiotnik')}${inp('inAdj', curA, res && res.adjOk, 'wpisz przymiotnik')}
       ${sec(ICON.noun, 'Rzeczownik')}${inp('inNoun', curN, res && res.nounOk, 'wpisz rzeczownik')}`
    : `${sec(ICON.tag, 'Przymiotnik')}<div class="opts">${q.adjOptions.map(o => btn(o, 'adj')).join('')}</div>
       ${sec(ICON.noun, 'Rzeczownik')}<div class="opts">${q.nounOptions.map(o => btn(o, 'noun')).join('')}</div>`;
  const ready = typing ? (norm(s.inAdj) && norm(s.inNoun)) : (s.selAdj && s.selNoun);
  const answered = s.results.length, correct = s.results.filter(x => x.ok).length;
  const nextU = nextUnanswered(s, s.i);
  const rules = rulesFor(CASES[q.caseIdx].id, q.group);
  const ex = done ? exampleOf(q) : null;
  const v = done ? verdictText(q, res) : null;
  return `
  <div class="topbar">
    <button class="tbtn" id="quit" title="Zakończ — postęp jest zapisany" aria-label="Zakończ sesję">${ICON.close}</button>
    <div class="tcenter"><div class="tpos">Pytanie ${s.i + 1} z ${s.count}</div>
      <div class="progress"><div style="width:${Math.max(2, (answered / s.count) * 100)}%"></div></div></div>
    <div class="tally"><div class="t-ok"><span>Dobrze</span><b>${correct}</b></div><div class="t-bad"><span>Źle</span><b>${answered - correct}</b></div></div>
    ${fszHTML()}
    <button class="tbtn" id="toStatsQ" title="Statystyki" aria-label="Statystyki">${ICON.stats}</button>
  </div>
  <div class="sent">${sentence}</div>
  ${body}
  ${done ? `
    <div class="fb ${res.ok ? 'ok' : 'bad'}" id="fb">
      <div class="vhead">${res.ok ? ICON.okc : ICON.badc}<span>${esc(v.head)}</span></div>
      ${res.ok ? '' : `<div class="vright">Poprawnie: <b>${esc(q.adjAnswer)} ${esc(q.nounAnswer)}</b>.</div>`}
      <div class="vline">${esc(v.line)}</div>
      <details class="rule">
        <summary>Zobacz regułę</summary>
        <div class="rbody">
          <div class="why-case"><b>${esc(CASES[q.caseIdx].ru)}</b> <span class="muted">${esc(CASES[q.caseIdx].pl)}</span></div>
          <div>${esc(q.hint)}</div>
          <div class="endings">
            <div class="cap">Końcówki: ${esc(groupName(q.group))}</div>
            <div><span class="muted">przymiotnik</span><span>${esc(rules.adj)}</span></div>
            <div><span class="muted">rzeczownik</span><span>${esc(rules.noun)}</span></div>
          </div>
          ${ex ? `<div class="cap">Inny przykład</div><div class="ex">${esc(ex.sentence).replace('___', '<b>' + esc(ex.phrase) + '</b>')} <span class="muted">(${esc(ex.base)})</span></div>` : ''}
        </div>
      </details>
    </div>` : `<button class="linkbtn" id="skip" ${nextU < 0 ? 'disabled' : ''}>Pomiń to pytanie</button>`}
  <div class="actions">
    <button class="ibtn nav-i" id="prev" title="Poprzednie pytanie" aria-label="Poprzednie pytanie" ${s.i === 0 ? 'disabled' : ''}>${ICON.prev}</button>
    ${done
      ? (nextU >= 0 ? `<button class="big" id="nextU">Następne pytanie ${ICON.arrow}</button>` : `<button class="big" id="finish">Zobacz wyniki ${ICON.arrow}</button>`)
      : `<button class="big" id="check" ${ready ? '' : 'disabled'}>Sprawdź ${ICON.arrow}</button>`}
    <button class="ibtn nav-i" id="fwd" title="Następne pytanie z odpowiedzią" aria-label="Dalej" ${s.i + 1 > (s.front || 0) || s.i + 1 >= s.count ? 'disabled' : ''}>${ICON.next}</button>
  </div>`;
}
function advance(idx) { session.front = Math.max(session.front || 0, idx); goTo(idx); }
function goTo(idx) {
  const s = session; s.i = idx; s.selAdj = s.selNoun = null; s.inAdj = s.inNoun = '';
  render(); window.scrollTo(0, 0);
}
function bindQuestion() {
  const s = session, q = s.questions[s.i], done = !!s.byQ[s.i];
  document.querySelectorAll('.choice').forEach(b => b.onclick = () => {
    if (done) return;
    if (b.dataset.kind === 'adj') s.selAdj = b.dataset.v; else s.selNoun = b.dataset.v;
    render();
  });
  const check = document.getElementById('check');
  const ia = document.getElementById('inAdj'), inn = document.getElementById('inNoun');
  if (ia && !done) {
    const upd = () => {
      s.inAdj = ia.value; s.inNoun = inn.value; check.disabled = !(norm(s.inAdj) && norm(s.inNoun));
      const g = document.getElementById('gap'), pa = norm(s.inAdj), pn = norm(s.inNoun);
      if (g) g.textContent = (pa || pn) ? (pa || '…') + ' ' + (pn || '…') : ' ';
    };
    ia.oninput = inn.oninput = upd;
    ia.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); inn.focus(); } };
    inn.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (!check.disabled) check.click(); } };
    if (!s.inAdj) ia.focus();
  }
  if (check) check.onclick = () => {
    let adjOk, nounOk, diaOnly = false, gotA, gotN;
    if (s.kind === 'type') {
      gotA = norm(s.inAdj); gotN = norm(s.inNoun);
      adjOk = gotA === q.adjAnswer; nounOk = gotN === q.nounAnswer;
      diaOnly = (!adjOk || !nounOk) && plain(gotA) === plain(q.adjAnswer) && plain(gotN) === plain(q.nounAnswer);
    } else {
      gotA = s.selAdj; gotN = s.selNoun;
      adjOk = gotA === q.adjAnswer; nounOk = gotN === q.nounAnswer;
    }
    const ok = adjOk && nounOk;
    const raw = { qi: s.i, c: q.cell, ok, ao: adjOk, no: nounOk, ga: gotA, gn: gotN, t: Date.now() };
    if (diaOnly) raw.d = true;
    { const an = analyzeAnswer(q, gotA, gotN, adjOk, nounOk, diaOnly); Object.keys(an).forEach(k => { if (an[k] != null) raw[k] = an[k]; }); }
    if (q.ti != null) raw.ti = q.ti;
    if (q.ni != null) { raw.ni = q.ni; const tk = trapKind(NOUNS[q.ni], CASES[q.caseIdx].id, q.plural); if (tk) raw.tk = tk; }
    if (!ok) { raw.s = q.sentence; raw.b = q.base + (q.plural ? ' → l. mn.' : ' → l. poj.'); raw.rt = q.adjAnswer + ' ' + q.nounAnswer; }
    const r = { qi: s.i, cell: q.cell, ok, adjOk, nounOk, diaOnly, gotA, gotN, raw };
    s.results.push(r); s.byQ[s.i] = r;
    saveProgress(s);
    recompute();
    render();
    const nx = document.getElementById('nextU') || document.getElementById('finish'); if (nx) nx.focus({ preventScroll: true });
    const fb = document.getElementById('fb');
    if (fb) fb.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const nu = document.getElementById('nextU');
  if (nu) nu.onclick = () => advance(nextUnanswered(s, s.i));
  const fin = document.getElementById('finish');
  if (fin) fin.onclick = () => { s.finished = true; render(); window.scrollTo(0, 0); };
  document.getElementById('prev').onclick = () => { if (s.i > 0) goTo(s.i - 1); };
  document.getElementById('fwd').onclick = () => { if (s.i + 1 <= (s.front || 0) && s.i + 1 < s.count) goTo(s.i + 1); };
  const sk = document.getElementById('skip'); if (sk) sk.onclick = () => { const n = nextUnanswered(s, s.i); if (n >= 0) advance(n); };
  document.getElementById('quit').onclick = () => { s.paused = true; render(); window.scrollTo(0, 0); };
  document.getElementById('toStatsQ').onclick = () => { statsKind = s.kind; document.querySelector('.tab[data-tab=stats]').click(); window.scrollTo(0, 0); };
}

function finishHTML() {
  const s = session, r = s.results, ok = r.filter(x => x.ok).length;
  const finished = r.length >= s.count;
  const byCase = CASES.map((c, i) => { const a = r.filter(x => +x.cell.split(':')[0] === i); return { name: c.ru, n: a.length, ok: a.filter(x => x.ok).length }; });
  const byGroup = GROUPS.map(g => { const a = r.filter(x => x.cell.split(':')[1] === g.id); return { name: g.ru, n: a.length, ok: a.filter(x => x.ok).length }; });
  const line = x => x.n ? `<li>${esc(x.name)}: ${x.ok} z ${x.n}</li>` : '';
  const dia = r.filter(x => x.diaOnly).length;
  const nextCount = Math.max(ROUNDS[0], Math.min(s.count, ROUNDS[3]));
  return `
  <div class="card">
    <div class="lbl">${finished ? 'Wynik' : 'Sesja przerwana'} · sesja <b class="sid">${esc(s.id)}</b> · ${s.kind === 'type' ? 'etap 2, wpisywanie' : 'etap 1, wybór'}</div>
    <div class="score">${ok} z ${r.length}</div>
    <div class="muted">${r.length ? Math.round(ok / r.length * 100) : 0}% dobrze. Błędy w przymiotnikach: ${r.filter(x => !x.adjOk).length}, w rzeczownikach: ${r.filter(x => !x.nounOk).length}.${dia ? ` W tym tylko w polskich znakach: ${dia}.` : ''}</div>
    ${finished ? '' : `<div style="margin-top:8px">Odpowiedziano na ${r.length} z ${s.count}. Postęp jest zapisany — sesję <b class="sid">${esc(s.id)}</b> możesz dokończyć później z listy na ekranie startowym.</div>
      <button class="big" id="resume">Kontynuuj teraz</button>`}
  </div>
  ${finished && s.kind === 'choice' && (s.mode === 'test' || s.mode === 'weak') ? `
  <div class="card">
    <div class="lbl">Dalej: etap 2</div>
    <div class="muted">Te same pola, nowe zdania, ale obie formy trzeba wpisać samodzielnie.</div>
    <button class="big" id="toType">Rozpocznij etap 2 (${pyt(s.mode === 'test' ? nextCount : 30)})</button>
  </div>` : ''}
  <div class="card"><div class="lbl">Według przypadków</div><ul class="list">${byCase.map(line).join('')}</ul></div>
  <div class="card"><div class="lbl">Według rodzaju i liczby</div><ul class="list">${byGroup.map(line).join('')}</ul></div>
  <button class="big" id="again" style="background:var(--muted)">Ekran startowy</button>
  <button class="big" id="toStats" style="background:var(--muted)">Statystyki ogólne</button>`;
}
function bindFinish() {
  const s = session;
  const rs = document.getElementById('resume');
  if (rs) rs.onclick = () => { s.paused = false; const f = s.byQ[s.i] ? nextUnanswered(s, s.i) : s.i; if (f >= 0) { s.i = f; s.front = Math.max(s.front || 0, f); } render(); };
  const t = document.getElementById('toType');
  if (t) t.onclick = () => { stage = 'type'; session = buildSession(s.mode, s.mode === 'test' ? Math.max(ROUNDS[0], Math.min(s.count, ROUNDS[3])) : 30, 'type'); render(); window.scrollTo(0, 0); };
  document.getElementById('again').onclick = () => { stage = s.kind; session = null; render(); };
  document.getElementById('toStats').onclick = () => { statsKind = s.kind; session = null; document.querySelector('.tab[data-tab=stats]').click(); };
}

// ===================== Статистика =====================
function color(rate, n) {
  if (!n) return 'var(--line)';
  const h = 130 - Math.min(1, rate * 2) * 130;
  return `hsla(${h}, 60%, 50%, .35)`;
}
function historyHTML() {
  const list = Object.values(progress).filter(p => p.done).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30);
  if (!list.length) return '';
  return `<div class="card"><div class="lbl">Historia sesji</div>${list.map(p => {
    const r = p.r || [], ok = r.filter(x => x.ok).length;
    return `<div class="sess"><div><b class="sid">${esc(p.id)}</b> · ${esc(p.title || kindName(p.kind))}<br><span class="muted">${fmtDate(p.updatedAt)}</span></div><div><b>${ok} z ${r.length}</b> <span class="muted">(${r.length ? Math.round(ok / r.length * 100) : 0}%)</span></div></div>`;
  }).join('')}</div>`;
}
function statsHTML() {
  const cells = stats[CK(statsKind)];
  const total = Object.values(cells).reduce((a, s) => a + s.n, 0);
  const wrong = Object.values(cells).reduce((a, s) => a + s.wrong, 0);
  const rows = GROUPS.map(g => `<tr><th class="r">${g.short}</th>${CASES.map((c, i) => {
    if (SKIP(i + ':' + g.id)) return '<td style="background:transparent"></td>';
    const id = i + ':' + g.id, s = cells[id]; const n = s ? s.n : 0, w = s ? s.wrong : 0, stt = cellState(statsKind, id);
    if (stt === 'done') return `<td class="c-done" title="Opanowane: ostatnie 5 odpowiedzi dobrze">✓<small>${w}/${n}</small></td>`;
    if (stt === 'few') return `<td class="c-few" title="Za mało odpowiedzi">${n ? n + '×' : '—'}</td>`;
    return `<td style="background:${color(w / n, n)}">${Math.round(w / n * 100)}%<small>${w}/${n}</small></td>`;
  }).join('')}</tr>`).join('');
  const caseTot = CASES.map((c, i) => { let n = 0, w = 0; GROUPS.forEach(g => { const s = cells[i + ':' + g.id]; if (s) { n += s.n; w += s.wrong; } }); return { name: c.ru, n, w }; });
  const grpTot = GROUPS.map(g => { let n = 0, w = 0; CASES.forEach((c, i) => { const s = cells[i + ':' + g.id]; if (s) { n += s.n; w += s.wrong; } }); return { name: g.ru, n, w }; });
  const pct = x => x.n ? Math.round(x.w / x.n * 100) + '% błędów (' + x.w + ' z ' + x.n + ')' : 'brak odpowiedzi';
  const weak = ALL_CELLS.map(c => ({ c, s: cells[c] })).filter(x => x.s && x.s.n >= 2 && x.s.wrong > 0)
    .sort((a, b) => (b.s.wrong / b.s.n) - (a.s.wrong / a.s.n) || b.s.n - a.s.n).slice(0, 8);
  const cellName = c => { const [ci, g] = c.split(':'); return CASES[+ci].ru + ', ' + groupName(g); };
  const adjW = Object.values(cells).reduce((a, s) => a + s.adjWrong, 0), nounW = Object.values(cells).reduce((a, s) => a + s.nounWrong, 0);
  const dia = statsKind === 'type' ? stats.tlog.filter(e => e.dia).length : 0;
  return `
  ${stageSwitch('statSw', statsKind)}
  ${planHTML('stats')}
  <h2 class="sub">Szczegóły</h2>
  <div class="card">
    <div class="lbl">Łącznie</div>
    <div>Odpowiedzi: ${total}, z błędem: ${total ? Math.round(wrong / total * 100) : 0}%. Błędy w przymiotniku: ${adjW}, w rzeczowniku: ${nounW}.${dia ? ` Tylko w polskich znakach: ${dia}.` : ''}</div>
  </div>
  ${caseTreeHTML(cells)}
  ${analysisHTML(statsKind)}
  <div class="card"><div class="lbl">Najsłabsze pola</div>${weak.length ? `<ul class="list">${weak.map(x => `<li>${esc(cellName(x.c))} — ${x.s.wrong} z ${x.s.n}</li>`).join('')}</ul>` : '<div class="muted">Na razie za mało danych (potrzebne są co najmniej 2 odpowiedzi w polu).</div>'}</div>
  ${historyHTML()}
  ${backupHTML()}
  <div class="card">
    <div class="lbl">Przekaż statystyki do czatu</div>
    <div class="muted">Kopiowane są statystyki obu etapów. Wklej tekst do rozmowy — na jego podstawie można przygotować ćwiczenia.</div>
    <button class="big" id="copy">Kopiuj</button>
    <textarea id="exp" class="hidden" readonly></textarea>
  </div>
  <div class="row">
    ${confirmReset ? `<button class="ghost" id="resetYes" style="color:var(--bad)">Tak, wyzeruj</button><button class="ghost" id="resetNo">Anuluj</button>`
      : `<button class="ghost" id="reset">Wyzeruj statystyki</button>`}
  </div>
  <div class="muted" style="margin-top:6px">Zerowanie liczy statystyki od nowa; historia sesji zostaje.</div>`;
}
// ---- Kopia zapasowa (tylko gdy wyniki są w przeglądarce)
let backupMsg = '';
function backupHTML() {
  if (Store.cloud) return '';
  return `<div class="card">
    <div class="lbl">Kopia zapasowa</div>
    <div class="muted">Wyniki są zapisane tylko w tej przeglądarce. Pobierz plik, żeby ich nie stracić albo przenieść na inne urządzenie. Wczytanie pliku łączy wyniki z tymi, które już tu są.</div>
    <div class="row" style="margin-top:8px">
      <button class="ghost" id="bkDown">Pobierz plik</button>
      <label class="ghost filebtn">Wczytaj plik<input type="file" id="bkUp" accept=".json,application/json" hidden></label>
    </div>
    ${backupMsg ? `<div style="margin-top:8px">${esc(backupMsg)}</div>` : ''}
  </div>`;
}
function downloadBackup() {
  const L = Store.local;
  const data = { app: 'polskie-przypadki', version: 1, exportedAt: new Date().toISOString(),
    progress: L.progress, questions: L.questions, legacy: L.legacy, meta: L.meta };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'polskie-przypadki-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importBackup(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!d || d.app !== 'polskie-przypadki') throw new Error('format');
    const L = Store.local; let added = 0, updated = 0;
    Object.values(d.progress || {}).forEach(p => {
      if (!p || !p.id) return;
      const cur = L.progress[p.id];
      if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) {
        cur ? updated++ : added++;
        L.progress[p.id] = p;
        if (d.questions && d.questions[p.id]) L.questions[p.id] = d.questions[p.id];
      }
    });
    Object.values(d.legacy || {}).forEach(x => { if (x && x.id && !L.legacy[x.id]) L.legacy[x.id] = x; });
    const m = d.meta || {};
    L.meta = Object.assign({}, L.meta, { resetAt: Math.max(L.meta.resetAt || 0, m.resetAt || 0), legacyImported: !!(L.meta.legacyImported || m.legacyImported) });
    Store.saveLocal();
    await loadAll();
    backupMsg = `Wczytano: nowe sesje — ${added}, zaktualizowane — ${updated}.`;
  } catch (e) {
    backupMsg = 'To nie jest plik z wynikami tego trenera.';
  }
  render();
}

// Przypadek → liczba → rodzaj: gdzie dokładnie są błędy
const SG_G = [['mp', 'm.-os.'], ['ma', 'm.-zw.'], ['mi', 'm.-rz.'], ['f', 'ż.'], ['n', 'nij.']];
const PL_G = [['pv', 'męskoosobowy'], ['pn', 'niemęskoosobowy']];
function agg(cells, ids) { let n = 0, w = 0; ids.forEach(id => { const x = cells[id]; if (x) { n += x.n; w += x.wrong; } }); return { n, w, r: n ? w / n : 0 }; }
function level(x) { return x.n < 3 ? 'few' : x.r >= 0.4 ? 'bad' : x.r >= 0.2 ? 'mid' : 'good'; }
function pctTxt(x) { return x.n ? `${Math.round(x.r * 100)}%` : '—'; }
function caseTreeHTML(cells) {
  const rows = CASES.map((c, i) => {
    const sgIds = SG_G.map(([g]) => i + ':' + g).filter(id => !SKIP(id)), plIds = PL_G.map(([g]) => i + ':' + g);
    const all = agg(cells, [...sgIds, ...plIds]), sg = agg(cells, sgIds), pl = agg(cells, plIds);
    const gens = (list) => list.filter(([g]) => !SKIP(i + ':' + g)).map(([g, name]) => {
      const x = agg(cells, [i + ':' + g]);
      return { name, x };
    }).sort((a, b) => (b.x.n >= 3) - (a.x.n >= 3) || b.x.r - a.x.r);
    return { c, i, all, sg, pl, sgG: gens(SG_G), plG: gens(PL_G) };
  }).filter(r => r.all.n).sort((a, b) => (b.all.n >= 3) - (a.all.n >= 3) || b.all.r - a.all.r);
  if (!rows.length) return '';
  const chip = ({ name, x }) => `<span class="gchip ${level(x)}">${esc(name)} <b>${pctTxt(x)}</b><small>${x.w}/${x.n}</small></span>`;
  const numRow = (label, x, gl, key) => x.n ? `<div class="nrow"><div class="nhead"><span>${label}</span><span class="nval ${level(x)}">${pctTxt(x)} błędów <small>${x.w} z ${x.n}</small></span></div><div class="gchips">${gl.filter(g => g.x.n).map(chip).join('')}</div>
    ${x.n >= 3 && x.w && x.r >= 0.2 ? `<button class="ghost cdrill" data-cdrill="${key}">Ćwicz: ${esc(label.toLowerCase())} (15 pytań)</button>` : ''}</div>` : '';
  const worst = rows.find(r => r.all.n >= 3 && r.all.r >= 0.2);
  let head = '<div class="muted">Za mało odpowiedzi, żeby wskazać słabe miejsca.</div>';
  if (worst) {
    const num = worst.sg.n >= 3 && worst.pl.n >= 3 ? (worst.sg.r > worst.pl.r + 0.1 ? 'w liczbie pojedynczej' : worst.pl.r > worst.sg.r + 0.1 ? 'w liczbie mnogiej' : 'w obu liczbach') : '';
    const g = [...worst.sgG, ...worst.plG].filter(x => x.x.n >= 3).sort((a, b) => b.x.r - a.x.r)[0];
    head = `<div class="tree-head">Najsłabszy: <b>${esc(worst.c.ru)}</b>${num ? ', ' + num : ''}${g && g.x.r >= 0.3 ? `, zwłaszcza ${esc(g.name)}` : ''}.</div>`;
  } else if (rows.some(r => r.all.n >= 3)) head = '<div class="tree-head">Żaden przypadek nie odstaje — błędów poniżej 20%.</div>';
  return `<div class="card"><div class="lbl">Przypadki od najsłabszego</div>${head}
    ${rows.map((r, k) => `<details class="case ${level(r.all)}" ${k < 2 && r.all.n >= 3 && r.all.r >= 0.2 ? 'open' : ''}>
      <summary><span class="cname">${esc(r.c.ru)}</span><span class="cbar"><span class="bar ${level(r.all) === 'bad' ? 'red' : level(r.all) === 'mid' ? 'amber' : 'green'}"><i style="width:${Math.max(3, Math.round(r.all.r * 100))}%"></i></span></span><span class="cval">${pctTxt(r.all)} <small>${r.all.w}/${r.all.n}</small></span></summary>
      ${numRow('Liczba pojedyncza', r.sg, r.sgG, r.i + '|sg')}${numRow('Liczba mnoga', r.pl, r.plG, r.i + '|pl')}
    </details>`).join('')}
    <div class="legend">Odsetek błędów. Szare — mniej niż 3 odpowiedzi, za mało, żeby oceniać.</div></div>`;
}
const caseName2 = k => CASES.find(c => c.id === k[0]).ru + (k.endsWith('+') ? ' (l. mn.)' : '');
function analysisHTML(kind) {
  const A = stats.an[kind];
  if (!A || !A.errs) return '';
  const typed = Object.entries(A.types).sort((a, b) => b[1] - a[1]);
  const tot = typed.reduce((a, x) => a + x[1], 0);
  const bar = (v, max, cls) => `<span class="bar ${cls || ''}"><i style="width:${Math.max(4, Math.round(v / max * 100))}%"></i></span>`;
  const types = typed.length ? `<div class="card"><div class="lbl">Rodzaje błędów</div>
    <div class="bars">${typed.map(([k, v]) => `<div class="brow"><div class="btxt">${esc(ERR_TYPES[k] || k)}</div><div class="bval">${bar(v, typed[0][1], 'red')}<b>${v}</b><span class="muted">${Math.round(v / tot * 100)}%</span></div></div>`).join('')}</div>
    ${A.untyped ? `<div class="legend">Bez opisu: ${A.untyped} (starsze odpowiedzi).</div>` : ''}</div>` : '';
  const conf = Object.entries(A.conf).sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([want, m]) => {
    const picks = Object.entries(m).filter(([k]) => k !== 'n').sort((a, b) => b[1] - a[1]).slice(0, 3);
    return `<div class="crow"><div class="cwant">potrzebny <b>${esc(caseName2(want))}</b></div><div class="cgot">${picks.map(([k, v]) => `<span class="chip">${esc(caseName2(k))} <b>${v}</b></span>`).join('')}</div></div>`;
  }).join('');
  const confHTML = conf ? `<div class="card"><div class="lbl">Z czym mylisz przypadki</div><div class="muted" style="margin-bottom:6px">Jaki przypadek wybrałeś zamiast potrzebnego.</div>${conf}</div>` : '';
  const rules = Object.entries(A.rules).filter(([, x]) => x.n >= 2).map(([k, x]) => ({ k, ...x, r: x.w / x.n }))
    .sort((a, b) => b.r - a.r || b.n - a.n);
  const rows = rules.map(x => `<tr class="${x.w === 0 ? 'ok' : ''}"><td>${esc(x.k)}</td><td class="num2">${x.n - x.w} z ${x.n}</td><td class="pbar">${bar(x.n - x.w, x.n, x.r > 0.5 ? 'red' : x.r > 0 ? 'amber' : 'green')}</td></tr>`).join('');
  const rulesHTML = rows ? `<div class="card"><div class="lbl">Czasowniki i przyimki</div><div class="muted" style="margin-bottom:6px">Dobre odpowiedzi według tego, czego wymaga zdanie. Od najsłabszych; tylko reguły z co najmniej 2 odpowiedziami.</div>
    <table class="rules">${rows}</table></div>` : '';
  return types + confHTML + rulesHTML;
}

function exportText() {
  const lines = ['Statystyki: polskie przypadki'];
  const cellName = c => { const [ci, g] = c.split(':'); return CASES[+ci].ru + ' / ' + GROUPS.find(x => x.id === g).ru; };
  [['choice', 'Etap 1 — wybór'], ['type', 'Etap 2 — wpisywanie']].forEach(([k, title]) => {
    lines.push('', '== ' + title + ' ==');
    ALL_CELLS.forEach(c => { const s = stats[CK(k)][c]; if (s && s.n) lines.push(`${cellName(c)}: błędy ${s.wrong}/${s.n} (przym. ${s.adjWrong}, rzecz. ${s.nounWrong})`); });
    const A = stats.an[k];
    if (A && A.errs) {
      const ty = Object.entries(A.types).sort((a, b) => b[1] - a[1]);
      if (ty.length) lines.push('Rodzaje błędów: ' + ty.map(([t, v]) => `${t} ${v}`).join(', '));
      Object.entries(A.conf).forEach(([w, m]) => lines.push(`Pomyłki: potrzebny ${caseName2(w)} → ` + Object.entries(m).filter(([x]) => x !== 'n').map(([x, v]) => `${caseName2(x)} ${v}`).join(', ')));
      Object.entries(A.rules).filter(([, x]) => x.w).sort((a, b) => b[1].w / b[1].n - a[1].w / a[1].n).forEach(([r, x]) => lines.push(`Reguła „${r}”: błędy ${x.w}/${x.n}`));
    }
    const lg = stats[LK(k)].slice(-50);
    if (lg.length) {
      lines.push('Ostatnie błędy (zdanie | podano | poprawnie | moja odpowiedź):');
      lg.forEach(e => lines.push(`${e.s} | ${e.base} | ${e.right} | ${e.got}${e.dia ? ' (tylko polskie znaki)' : ''}`));
    }
  });
  return lines.join('\n');
}
function bindStats() {
  bindSeg('statSw', k => statsKind = k);
  bindPlan(statsKind);
  const bd = document.getElementById('bkDown'); if (bd) bd.onclick = downloadBackup;
  const bu = document.getElementById('bkUp'); if (bu) bu.onchange = () => { if (bu.files && bu.files[0]) importBackup(bu.files[0]); };
  document.getElementById('copy').onclick = async () => {
    const t = exportText(), ta = document.getElementById('exp');
    try { await navigator.clipboard.writeText(t); document.getElementById('copy').textContent = 'Skopiowano'; }
    catch (e) { ta.classList.remove('hidden'); ta.value = t; ta.focus(); ta.select(); document.getElementById('copy').textContent = 'Zaznacz tekst poniżej i skopiuj'; }
  };
  const r = document.getElementById('reset'); if (r) r.onclick = () => { confirmReset = true; render(); };
  const y = document.getElementById('resetYes'); if (y) y.onclick = () => {
    meta = Object.assign({}, meta, { resetAt: Date.now() }); Store.write('meta/main', meta);
    confirmReset = false; recompute(); render();
  };
  const n = document.getElementById('resetNo'); if (n) n.onclick = () => { confirmReset = false; render(); };
}

render();
Store.init().then(loadAll).then(render).then(backfill);

// Aplikacja offline (tylko na zwykłej stronie, nie w podglądzie claude.ai)
if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.claude) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
