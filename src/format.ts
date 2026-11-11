const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Decimal units, matching how Finder reports sizes. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let i = 0;
  while (n >= 1000 && i < UNITS.length - 1) {
    n /= 1000;
    i++;
  }
  const digits = n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(digits)} ${UNITS[i]}`;
}

/** Split into number and unit for big typographic display. */
export function bytesParts(n: number): [string, string] {
  const [num, unit] = bytes(n).split(' ');
  return [num, unit];
}

export const int = (n: number) => Math.round(n).toLocaleString('en-US');

export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Shorten a path for display, keeping the tail. */
export function shortPath(p: string, home: string, max = 64): string {
  let s = home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  if (s.length > max) s = '…' + s.slice(s.length - max + 1);
  return s;
}
