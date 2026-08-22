// Theme application: reads the persisted `theme` setting and drives a
// data-theme attribute on <html>. Absent attribute = follow OS preference
// (prefers-color-scheme); explicit light/dark override wins.
export function applyTheme(theme: string): void {
  const root = document.documentElement;
  if (theme === 'dark') root.dataset.theme = 'dark';
  else if (theme === 'light') root.dataset.theme = 'light';
  else delete root.dataset.theme;
}

export function getThemeLabel(theme: string): string {
  if (theme === 'dark') return 'Dark';
  if (theme === 'light') return 'Light';
  return 'System';
}
