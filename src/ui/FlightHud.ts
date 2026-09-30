/**
 * Telemetria di volo in tempo reale della missione di lancio (in basso al centro):
 * tempo di missione, fase, valori principali, grafici (quota, velocità, accelerazione/Max-Q)
 * e registro degli eventi.
 */
import type { LaunchMission, MissionTelemetry } from '../launch/mission.ts';
import { escapeHtml, fmt1, fmt2, fmtInt, formatDistance, formatDuration } from './format.ts';

export interface FlightHudHandlers {
  onFocus(): void;
  onClose(): void;
}

function met(t: number): string {
  const sign = t < 0 ? 'T−' : 'T+';
  const a = Math.abs(t);
  const d = Math.floor(a / 86400);
  const h = Math.floor((a % 86400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = Math.floor(a % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${sign}${d ? d + 'g ' : ''}${p(h)}:${p(m)}:${p(s)}`;
}

export class FlightHud {
  readonly root: HTMLDivElement;
  mission: LaunchMission | null = null;
  private readonly charts: HTMLCanvasElement[];
  private clock = Infinity;
  private eventsShown = -1;

  constructor(container: HTMLElement, handlers: FlightHudHandlers) {
    this.root = document.createElement('div');
    this.root.className = 'flight-hud panel';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="fh-head">
        <div><div class="hud-title" data-r="title">Missione</div><div class="fh-met" data-r="met">T+00:00:00</div></div>
        <div class="fh-phase"><div data-r="phase"></div><div class="muted small" data-r="next"></div></div>
        <div class="fh-btns">
          <button type="button" data-a="focus" title="Aggancia la camera al veicolo">◎ Segui</button>
          <button type="button" data-a="collapse" title="Riduci/espandi">–</button>
          <button type="button" data-a="close" title="Chiudi la missione">✕</button>
        </div>
      </div>
      <div class="fh-body">
        <div class="fh-grid" data-r="grid"></div>
        <div class="fh-charts">
          <figure><figcaption>Quota</figcaption><canvas width="220" height="70"></canvas></figure>
          <figure><figcaption>Velocità</figcaption><canvas width="220" height="70"></canvas></figure>
          <figure><figcaption>Accelerazione (g)</figcaption><canvas width="220" height="70"></canvas></figure>
        </div>
        <ol class="fh-events" data-r="events"></ol>
      </div>`;
    container.appendChild(this.root);
    this.charts = [...this.root.querySelectorAll('canvas')];
    this.root.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (a === 'focus') handlers.onFocus();
      else if (a === 'close') handlers.onClose();
      else if (a === 'collapse') {
        const c = this.root.classList.toggle('collapsed');
        (e.target as HTMLElement).textContent = c ? '+' : '–';
      }
    });
  }

  private q<T extends HTMLElement>(r: string): T {
    return this.root.querySelector<T>(`[data-r="${r}"]`)!;
  }

  show(m: LaunchMission): void {
    this.mission = m;
    this.eventsShown = -1;
    this.root.hidden = false;
    this.q('title').textContent = `${m.cfg.rocket.name} · ${m.cfg.payload.name}`;
  }

  hide(): void {
    this.mission = null;
    this.root.hidden = true;
  }

  update(realDt: number): void {
    const m = this.mission;
    if (!m) return;
    this.clock += realDt;
    if (this.clock < 0.1) return;
    this.clock = 0;
    const t = m.telemetry();
    this.q('met').textContent = met(t.met);
    const phase = this.q('phase');
    phase.textContent = t.burning ? `🔥 ${t.burning}` : t.phase;
    phase.className = m.phase === 'failed' ? 'warn' : m.phase === 'complete' ? 'ok' : '';
    this.q('next').textContent = t.nextEvent && t.nextEvent.in > 0 ? `Prossimo: ${t.nextEvent.name} tra ${formatDuration(t.nextEvent.in)}` : '';
    this.q('grid').innerHTML = this.grid(t);
    if (m.events.length !== this.eventsShown) {
      this.eventsShown = m.events.length;
      const list = this.q('events');
      list.innerHTML = m.events.slice(-40).map((e) => `<li class="ev-${e.kind}"><b>${met(e.t)}</b> ${escapeHtml(e.text)}</li>`).join('');
      list.scrollTop = list.scrollHeight;
    }
    this.drawCharts(m);
  }

  private grid(t: MissionTelemetry): string {
    const cells: [string, string, string?][] = [
      ['Quota', formatDistance(t.altitude) + (t.ref !== 'Terra' ? ` (${t.ref})` : '')],
      ['Velocità', `${fmt2.format(t.speed / 1000)} km/s`],
    ];
    if (t.verticalSpeed !== undefined) cells.push(['Vel. verticale', `${fmtInt.format(t.verticalSpeed)} m/s`]);
    cells.push(['Accelerazione', `${fmt2.format(t.accelG)} g`, t.accelG > 5.5 ? 'warn' : undefined]);
    if (t.q !== undefined) cells.push(['Pressione dinamica', `${fmt1.format(t.q / 1000)} kPa`]);
    if (t.mach !== undefined && t.mach > 0.01) cells.push(['Mach', fmt2.format(t.mach)]);
    cells.push(['Massa', `${fmt1.format(t.mass / 1000)} t`]);
    cells.push(['Spinta', t.thrust > 0 ? `${fmtInt.format(t.thrust / 1000)} kN` : 'motori spenti']);
    if (t.throttle !== undefined) cells.push(['Regolazione', `${fmtInt.format(t.throttle * 100)} %`]);
    cells.push(['Stadio', t.stage]);
    if (t.propFraction !== undefined) cells.push(['Propellente stadio', `${fmtInt.format(t.propFraction * 100)} %`]);
    cells.push(['Apoasse / periasse', `${Number.isFinite(t.apoapsis) ? formatDistance(t.apoapsis) : '∞'} / ${formatDistance(t.periapsis)}`]);
    cells.push(['Inclinazione', `${fmt2.format(t.inclination)}°`]);
    if (t.period > 0 && Number.isFinite(t.period)) cells.push(['Periodo', formatDuration(t.period)]);
    cells.push(['Δv residuo', `${fmtInt.format(t.dvRemaining)} m/s`]);
    if (t.downrange !== undefined) cells.push(['Distanza a terra', formatDistance(t.downrange)]);
    if (t.lat !== undefined && t.lon !== undefined) cells.push(['Lat / Lon', `${fmt2.format(t.lat)}° / ${fmt2.format(t.lon)}°`]);
    if (t.distEarth > 2e7) cells.push(['Distanza dalla Terra', formatDistance(t.distEarth)]);
    if (t.upperProp > 0) cells.push(['Propellente stadio sup.', `${fmtInt.format(t.upperProp)} kg`]);
    cells.push(['Propellente satellite', `${fmtInt.format(t.payloadProp)} kg`]);
    return cells.map(([k, v, c]) => `<div><span>${k}</span><b class="${c ?? ''}">${escapeHtml(v)}</b></div>`).join('');
  }

  private drawCharts(m: LaunchMission): void {
    const h = m.history;
    const series: [(s: (typeof h)[number]) => number, string][] = [
      [(s) => s.alt / 1000, '#6fb6ff'],
      [(s) => s.v / 1000, '#7fe0a0'],
      [(s) => s.acc, '#ffb35c'],
    ];
    series.forEach(([f, color], i) => {
      const c = this.charts[i];
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const W = c.width;
      const H = c.height;
      ctx.clearRect(0, 0, W, H);
      if (h.length < 2) return;
      const t0 = h[0].t;
      const t1 = h[h.length - 1].t;
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of h) {
        const y = f(s);
        if (Number.isFinite(y)) {
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
      if (!Number.isFinite(lo)) return;
      if (hi - lo < 1e-9) hi = lo + 1;
      lo = Math.min(lo, 0);
      ctx.strokeStyle = 'rgba(140,170,220,0.15)';
      ctx.beginPath();
      ctx.moveTo(0, H - 0.5);
      ctx.lineTo(W, H - 0.5);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      h.forEach((s, k) => {
        const x = ((s.t - t0) / Math.max(t1 - t0, 1e-9)) * (W - 2) + 1;
        const y = H - 2 - ((f(s) - lo) / (hi - lo)) * (H - 14);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = 'rgba(223,230,243,0.8)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(fmt1.format(hi), 3, 10);
    });
  }
}
