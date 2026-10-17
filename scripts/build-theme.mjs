import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Derives the light theme from the dark stylesheets: every rule that sets a hex color gets a
// :root[data-theme="light"] override, so dark styles stay the single source of truth.
const SOURCES = ['style.css', 'monad.css'];
const OUTPUT = 'theme-light.css';
const LIGHT = ':root[data-theme="light"]';

// Hand-tuned tokens; everything else is converted by lightColor().
const TOKENS = Object.freeze({
  '--bg': '#f4f2f9', '--surface': '#ffffff', '--soft': '#efebf7', '--border': '#ddd6ea', '--muted': '#5f6880',
  '--text': '#1c2030', '--purple': '#6a4bd6', '--red': '#cc3d57', '--blue': '#3466c4', '--green': '#12825b', '--warm': '#b95a21',
});

// The trading ticket is light in the dark theme; in the light theme it becomes the dark accent card.
const MANUAL = `${LIGHT} .order-panel{--text:#eef0f8;--muted:#a9b0c6;--border:#3a3550;background:linear-gradient(145deg,#232036,#1b1a2a);border-color:#3a3550;color:#eef0f8;box-shadow:0 14px 34px #2a204a2e}
${LIGHT} .order-panel .primary-button{background:#b9a2ff;border-color:#b9a2ff;color:#1b1430}
${LIGHT} .order-panel .primary-button:not(:disabled):hover{background:#cbb8ff}
${LIGHT} .brand-mark path{stroke:#ffffff}
${LIGHT} .trade-mode>button.selected .trade-mode-mark{color:#ffffff}
${LIGHT} .countdown-dial:before{background:#ffffff}
${LIGHT} .chart-prompt{background:radial-gradient(ellipse,#ffffffeb 10%,#ffffff00 72%)}
${LIGHT} .overview>div,${LIGHT} .chain-stats>div,${LIGHT} .trade-mode>button{box-shadow:0 1px 2px #1c20300d}
`;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function parseHex(hex) {
  let digits = hex.slice(1);
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map(char => char + char).join('');
  const channel = index => parseInt(digits.slice(index, index + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), alpha: digits.length === 8 ? digits.slice(6) : '' };
}

function toHsl({ r, g, b }) {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === red ? (green - blue) / d + (green < blue ? 6 : 0) : max === green ? (blue - red) / d + 2 : (red - green) / d + 4;
  return { h: h * 60, s, l };
}

function toHex({ h, s, l }, alpha) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map(value => value.toString(16).padStart(2, '0')).join('')}${alpha}`;
}

export function lightColor(hex) {
  const color = parseHex(hex);
  if (color.r + color.g + color.b === 0) return hex;
  const { h, s, l } = toHsl(color);
  let next;
  if (s < 0.22) {
    // Neutrals: dark surfaces become light surfaces, light text becomes dark text.
    next = { h, s: Math.min(s, 0.18), l: l < 0.5 ? 1 - l * 0.42 : clamp(1.1 - l * 1.04, 0.08, 0.6) };
  } else if (l > 0.9) {
    next = { h, s: Math.min(s, 0.3), l: 0.08 + (1 - l) * 0.8 };
  } else if (l < 0.35) {
    next = { h, s: Math.min(s, 0.45), l: 1 - l * 0.38 };
  } else {
    // Pastel accents for dark backgrounds turn into deeper accents; greens need extra depth.
    next = { h, s: Math.min(s, 0.78), l: clamp(1.02 - l * 0.72, 0.3, 0.52) - (h >= 60 && h <= 190 ? 0.1 : 0) };
  }
  return toHex(next, color.alpha);
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseRules(css) {
  const rules = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open < 0) break;
    const prelude = css.slice(index, open).trim();
    if (prelude.startsWith('@')) {
      let depth = 1;
      let cursor = open + 1;
      while (depth && cursor < css.length) {
        if (css[cursor] === '{') depth += 1;
        else if (css[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      rules.push({ at: prelude, rules: parseRules(css.slice(open + 1, cursor - 1)) });
      index = cursor;
    } else {
      const close = css.indexOf('}', open);
      rules.push({ selector: prelude, body: css.slice(open + 1, close) });
      index = close + 1;
    }
  }
  return rules;
}

function scopeSelector(selector) {
  return selector.split(',').map(part => part.trim()).filter(Boolean)
    .map(part => (part.startsWith(':root') ? `${LIGHT}${part.slice(5)}` : `${LIGHT} ${part}`)).join(',');
}

function convertRule({ selector, body }) {
  const declarations = [];
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (selector === ':root' && TOKENS[property]) declarations.push(`${property}:${TOKENS[property]}`);
    else if (property === 'color-scheme') declarations.push('color-scheme:light');
    else if (/#[\da-f]{3,8}\b/i.test(value)) declarations.push(`${property}:${value.replace(/#[\da-f]{3,8}\b/gi, lightColor)}`);
  }
  return declarations.length ? `${scopeSelector(selector)}{${declarations.join(';')}}` : '';
}

function convert(rules) {
  return rules.map(rule => {
    if (!rule.at) return convertRule(rule);
    const inner = convert(rule.rules).filter(Boolean);
    return inner.length ? `${rule.at}{${inner.join('')}}` : '';
  }).filter(Boolean);
}

export async function buildTheme(root = new URL('../dist/', import.meta.url)) {
  const sheets = await Promise.all(SOURCES.map(file => readFile(new URL(file, root), 'utf8')));
  const rules = sheets.flatMap(css => convert(parseRules(stripComments(css))));
  return `/* Generated by scripts/build-theme.mjs from ${SOURCES.join(' and ')}. Do not edit. */\n${rules.join('\n')}\n${MANUAL}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const css = await buildTheme();
  await writeFile(new URL(`../dist/${OUTPUT}`, import.meta.url), css, 'utf8');
  console.log(`Wrote dist/${OUTPUT} (${css.split('\n').length} rules).`);
}
