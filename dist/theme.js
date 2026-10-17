export const THEME_KEY = 'blockpulse-theme';
export const THEME_CHOICES = Object.freeze(['system', 'light', 'dark']);
const THEME_LABELS = Object.freeze({ system: '跟随系统', light: '浅色', dark: '深色' });
const THEME_COLORS = Object.freeze({ light: '#f6f4fb', dark: '#10131c' });

export function resolveTheme(choice, prefersLight) {
  return choice === 'light' || (choice !== 'dark' && prefersLight) ? 'light' : 'dark';
}

export function nextTheme(choice) {
  return THEME_CHOICES[(THEME_CHOICES.indexOf(choice) + 1) % THEME_CHOICES.length];
}

export function mountTheme(button = document.getElementById('theme-toggle')) {
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  let choice = 'system';
  try { choice = THEME_CHOICES.includes(localStorage.getItem(THEME_KEY)) ? localStorage.getItem(THEME_KEY) : 'system'; } catch { /* Storage is optional. */ }

  function apply() {
    const theme = resolveTheme(choice, Boolean(media?.matches));
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themePreference = choice;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
    if (!button) return;
    button.dataset.choice = choice;
    button.querySelector('.theme-label').textContent = THEME_LABELS[choice];
    const label = `切换主题，当前${THEME_LABELS[choice]}${choice === 'system' ? `（${theme === 'light' ? '浅色' : '深色'}）` : ''}`;
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  button?.addEventListener('click', () => {
    choice = nextTheme(choice);
    try { localStorage.setItem(THEME_KEY, choice); } catch { /* Storage is optional. */ }
    apply();
  });
  media?.addEventListener?.('change', () => { if (choice === 'system') apply(); });
  apply();
}
