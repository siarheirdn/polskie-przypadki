// Ładuje data.js i engine.js w Node (te same pliki co w przeglądarce).
const fs = require('fs'), path = require('path'), vm = require('vm');
module.exports = function load() {
  const ctx = {};
  vm.createContext(ctx);
  for (const f of ['data.js', 'engine.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx, { filename: f });
  vm.runInContext('this.E = { CASES, GROUPS, NOUNS, TEMPLATES, buildPool, makeQuestion, rulesFor, exampleFor }', ctx);
  return ctx.E;
};
