import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [html, css, engine, app] = await Promise.all(
  ['dist/index.html', 'dist/style.css', 'dist/game.js', 'dist/app.js']
    .map(file => readFile(new URL(file, root), 'utf8')),
);
const importLine = /^import \{ ([^}]+) \} from '\.\/game\.js';\r?\n/;
const names = app.match(importLine)?.[1].split(',').map(name => name.trim());
if (!names?.length || names.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) {
  throw new Error('找不到支持的游戏模块导入，未生成单文件。');
}
const exports = names.join(', ');
const engineCode = engine.replace(/^export (?=(?:const|let|class|function)\b)/gm, '');
if (/^export\b/m.test(engineCode)) throw new Error('游戏模块含有未支持的导出语法。');
const appCode = app.replace(importLine, 'const { $1 } = GameEngine;\n');
const script = `(() => {\n'use strict';\nconst GameEngine = (() => {\n${engineCode}\nreturn { ${exports} };\n})();\n${appCode}\n})();`;
if (/<\/script/i.test(script) || /<\/style/i.test(css)) {
  throw new Error('源文件含有内联标签结束符，未生成单文件。');
}
const styleTag = '<link rel="stylesheet" href="./style.css">';
const scriptTag = '<script type="module" src="./app.js"></script>';
if (!html.includes(styleTag) || !html.includes(scriptTag)) {
  throw new Error('找不到网页资源入口，未生成单文件。');
}
const standalone = html
  .replace('class="brand" href="./"', 'class="brand" href="#"')
  .replace(styleTag, () => `<style>\n${css}\n</style>`)
  .replace(scriptTag, () => `<script>\n${script}\n</script>`);
await writeFile(new URL('本地试玩.html', root), standalone, 'utf8');
console.log('已生成 本地试玩.html，可直接双击打开。');
