/** Formats d'affichage français (fuseau et devise fournis par la session). */
export function formatDateTime(iso: string | null | undefined, timezone = 'Africa/Tunis'): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined, timezone = 'Africa/Tunis'): string {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeZone: timezone }).format(new Date(iso));
}

export function formatKm(value: string | number | null | undefined, options: { estimate?: boolean } = {}): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  // Compteurs affichés tronqués au kilomètre entier (13.1) : 90 000,9 s'affiche 90 000.
  const text = `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Math.trunc(n))} km`;
  return options.estimate ? `≈ ${text} (estimé GPS)` : text;
}

export function formatMoney(value: string | number | null | undefined, currency = 'TND', decimals = 3): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)} ${currency}`;
}

export function formatLiters(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(n)} L`;
}

export function fullName(p: { firstName: string; lastName: string }): string {
  return `${p.firstName} ${p.lastName}`.trim();
}
