import { readFile, writeFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const root = new URL('../', import.meta.url);
const modules = [
  ['game.js', 'GameEngine'],
  ['monad.js', 'MonadNetwork'],
  ['monad-monitor.js', 'MonadMonitor'],
  ['monad-ui.js', 'MonadUI'],
];
const styles = ['style.css', 'monad.css'];
const read = file => readFile(new URL(`dist/${file}`, root), 'utf8');
const [html, app, sources, sheets] = await Promise.all([
  read('index.html'), read('app.js'),
  Promise.all(modules.map(([file]) => read(file))),
  Promise.all(styles.map(read)),
]);
const available = new Map();

function inlineImports(source) {
  const code = source.replace(/^import \{ ([^}]+) \} from '(\.\/[^']+)';\r?\n/gm, (_, names, path) => {
    const dependency = available.get(path);
    const imported = names.split(',').map(name => name.trim());
    if (!dependency || imported.some(name => !dependency.names.includes(name))) {
      throw new Error(`模块导入不受支持：${path}。`);
    }
    return `const { ${imported.join(', ')} } = ${dependency.namespace};\n`;
  });
  if (/^\s*(?:import|export)\b/m.test(code)) throw new Error('模块含有未支持的导入或导出语法。');
  return code;
}

const bundled = modules.map(([file, namespace], index) => {
  const source = sources[index];
  const names = [...source.matchAll(/^export (?:async )?(?:const|let|class|function) ([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1]);
  if (!names.length) throw new Error(`模块没有可打包的导出：${file}。`);
  const code = inlineImports(source.replace(/^export (?=(?:async )?(?:const|let|class|function)\b)/gm, ''));
  available.set(`./${file}`, { namespace, names });
  return `const ${namespace} = (() => {\n${code}\nreturn { ${names.join(', ')} };\n})();`;
});
const script = `(() => {\n'use strict';\n${bundled.join('\n')}\n${inlineImports(app)}\n})();`;
new Script(script, { filename: '本地试玩.html' });
if (/<\/script/i.test(script) || sheets.some(css => /<\/style/i.test(css))) {
  throw new Error('源文件含有内联标签结束符，未生成单文件。');
}
const scriptTag = '<script type="module" src="./app.js"></script>';
if (!html.includes(scriptTag)) {
  throw new Error('找不到网页资源入口，未生成单文件。');
}
let standalone = html
  .replace('class="brand" href="./"', 'class="brand" href="#"')
  .replace(scriptTag, () => `<script>\n${script}\n</script>`);
styles.forEach((file, index) => {
  const tag = `<link rel="stylesheet" href="./${file}">`;
  if (!standalone.includes(tag)) throw new Error(`找不到样式入口：${file}。`);
  standalone = standalone.replace(tag, () => `<style>\n${sheets[index]}\n</style>`);
});
await writeFile(new URL('本地试玩.html', root), standalone, 'utf8');
console.log('已生成 本地试玩.html，可直接双击打开。');
