import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTheme, lightColor } from '../scripts/build-theme.mjs';
import { nextTheme, resolveTheme } from '../dist/theme.js';
import { MONAD_FAUCETS } from '../dist/monad.js';

test('主题偏好按 系统 → 浅色 → 深色 循环，系统偏好决定实际外观', () => {
  assert.equal(nextTheme('system'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'system');
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
});

test('浅色主题由深色样式生成且已提交的文件是最新的', async () => {
  const committed = await readFile(new URL('../dist/theme-light.css', import.meta.url), 'utf8');
  assert.equal(committed, await buildTheme(), '请运行 npm run build:theme 更新 dist/theme-light.css');
  assert.match(committed, /:root\[data-theme="light"\]\{color-scheme:light/);
  assert.match(committed, /@media/);
});

test('颜色转换让深色底变浅、浅色文字变深，并保留透明度', () => {
  const lightness = hex => {
    const value = parseInt(hex.slice(1, 7), 16);
    return ((value >> 16) + ((value >> 8) & 255) + (value & 255)) / 3;
  };
  assert.ok(lightness(lightColor('#10131c')) > 200);
  assert.ok(lightness(lightColor('#eff2fa')) < 80);
  assert.equal(lightColor('#b29afd16').slice(7), '16');
  assert.equal(lightColor('#000000'), '#000000');
  assert.match(lightColor('#fff'), /^#[\da-f]{6}$/);
});

test('水龙头列表只含 https 链接，名称与链接不重复', () => {
  assert.ok(MONAD_FAUCETS.length >= 5);
  assert.equal(new Set(MONAD_FAUCETS.map(item => item.url)).size, MONAD_FAUCETS.length);
  for (const item of MONAD_FAUCETS) {
    assert.match(item.url, /^https:\/\//);
    assert.ok(item.name && item.limit && item.requirement);
  }
  assert.equal(MONAD_FAUCETS[0].url, 'https://faucet.monad.xyz');
});
