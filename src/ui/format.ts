/** Formattazione numerica in italiano per HUD e telemetria. */
import { AU, DAY, KM } from '../physics/constants.ts';

export const fmtInt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
export const fmt1 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
export const fmt2 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
export const fmt3 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 3, minimumFractionDigits: 3 });

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return Math.abs(m) > 0.05 * AU ? `${fmt3.format(m / AU)} AU` : `${fmtInt.format(m / KM)} km`;
}

/** Distanza con doppia unità per le sonde lontane (AU + miliardi di km). */
export function formatFarDistance(m: number): string {
  if (Math.abs(m) < 0.05 * AU) return formatDistance(m);
  return `${fmt3.format(m / AU)} AU · ${fmt2.format(m / 1e12)} mld km`;
}

export function formatDuration(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const a = Math.abs(s);
  if (a < 1) return `${fmtInt.format(a * 1000)} ms`;
  if (a < 60) return `${fmt2.format(a)} s`;
  if (a < 3600) return `${Math.floor(a / 60)} min ${Math.round(a % 60)} s`;
  if (a < 2 * DAY) return `${Math.floor(a / 3600)} h ${Math.round((a % 3600) / 60)} min`;
  if (a < 730 * DAY) return `${fmt1.format(a / DAY)} giorni`;
  return `${fmt2.format(a / (365.25 * DAY))} anni`;
}

export function formatRate(bps: number | undefined): string {
  if (bps === undefined || !(bps > 0)) return '—';
  if (bps >= 1e6) return `${fmt2.format(bps / 1e6)} Mbit/s`;
  if (bps >= 1e3) return `${fmt2.format(bps / 1e3)} kbit/s`;
  return `${fmtInt.format(bps)} bit/s`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
