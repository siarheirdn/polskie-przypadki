// Sprawdza bazę: liczba pytań w każdym polu, poprawność dystraktorów
// i zapisuje wszystkie zdania z poprawną odpowiedzią do tools/all-sentences.txt.
// Użycie: node tools/check.js
const fs = require('fs'), path = require('path');
const E = require('./load')();
const SKIP = c => c.startsWith('0:') && !c.endsWith(':pv') && !c.endsWith(':pn');
const pool = E.buildPool().filter(p => !SKIP(p.cell));
const cnt = {}; let bad = 0; const lines = new Set();
for (const p of pool) {
  cnt[p.cell] = (cnt[p.cell] || 0) + 1;
  const q = E.makeQuestion(p);
  if (new Set(q.adjOptions).size < 4 || new Set(q.nounOptions).size < 4) { bad++; console.log('MAŁO WARIANTÓW:', q.sentence, q.base); }
  lines.add(q.sentence.replace('___', q.adjAnswer + ' ' + q.nounAnswer));
}
console.log('Pole'.padEnd(6) + E.GROUPS.map(g => g.short.padEnd(11)).join(''));
E.CASES.forEach((c, i) => console.log(c.short.padEnd(6) + E.GROUPS.map(g => String(cnt[i + ':' + g.id] || '—').padEnd(11)).join('')));
const v = Object.values(cnt).sort((a, b) => a - b);
console.log(`\nPytań: ${pool.length} · rzeczowników: ${E.NOUNS.length} · zdań: ${E.TEMPLATES.length} · pole min ${v[0]}, mediana ${v[v.length >> 1]}, max ${v[v.length - 1]}`);
fs.writeFileSync(path.join(__dirname, 'all-sentences.txt'), [...lines].sort().join('\n') + '\n');
console.log(`Zdania zapisane: tools/all-sentences.txt (${lines.size})`);
if (bad) process.exit(1);
