import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

test('Pages 产物完整内联脚本与样式，避免新页面读取旧版资源', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, ['scripts/build-local.mjs', '--pages'], { cwd: root });
  const html = await readFile(new URL('../_site/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="wallet-providers"/);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=|<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  assert.ok(scripts[0][1].length < 800, 'the head script only bootstraps theme and trade mode');
  assert.equal([...html.matchAll(/<style>/g)].length, 4);
  assert.match(html, /id="chain-market"/);
  assert.match(html, /id="theme-toggle"/);
  for (const [, code] of scripts) assert.doesNotThrow(() => new Script(code));
  assert.match(html, /id="event-panel"/);
});
