// Składa jeden samodzielny plik HTML (CSS i JS w środku) — dla wersji na claude.ai.
// Użycie: node tools/build-artifact.js  →  dist/artifact.html
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), rd = f => fs.readFileSync(path.join(root, f), 'utf8');
let html = rd('index.html')
  .replace(/<link rel="manifest"[^>]*>\n/, '')
  .replace(/<link rel="icon"[^>]*>\n/, '')
  .replace(/<link rel="apple-touch-icon"[^>]*>\n/, '')
  .replace('<link rel="stylesheet" href="css/style.css">', () => '<style>\n' + rd('css/style.css') + '</style>')
  .replace(/<script src="js\/data.js"><\/script>\n<script src="js\/engine.js"><\/script>\n<script src="js\/app.js"><\/script>/,
    () => '<script>\n' + rd('js/data.js') + '\n' + rd('js/engine.js') + '\n</script>\n<script>\n' + rd('js/app.js') + '</script>');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), html);
console.log('dist/artifact.html', html.length, 'B');
