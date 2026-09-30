/**
 * HUD temporaneo (verrà esteso nello STEP 5):
 *  - data simulata e stato del time-warp
 *  - pulsanti [Pausa] [1x] [100.000x] collegati a Simulation.paused / Simulation.timeWarp
 *  - menu a tendina per agganciare la camera a un corpo
 *  - scelta della scala (logaritmica / reale), orbite ed etichette on/off
 *  - riquadro informativo sul corpo agganciato
 */
import { themeAllSelects } from './ThemedSelect.ts';
import { AU, DAY, KM } from '../physics/constants.ts';
import type { Simulation } from '../physics/simulation.ts';
import type { ScaleMode } from '../graphics/ScaleManager.ts';
import { TIME_WARP_LEVELS } from '../physics/simulation.ts';

export interface HudHandlers {
  onFocus(id: string): void;
  onScaleMode(mode: ScaleMode): void;
  onToggleOrbits(show: boolean): void;
  onToggleLabels(show: boolean): void;
  /** Attiva la modalità LIVE (simulazione sincronizzata con l'ora reale). */
  onLive(): void;
  /** L'utente ha cambiato pausa/warp: la modalità LIVE termina. */
  onManualTime(): void;
  /** Salto a una data (passata o futura). */
  onGoToDate(date: Date): void;
  /** Apre il simulatore di lancio. */
  onOpenLaunch(): void;
  /** Immagini satellitari della superficie terrestre da vicino. */
  onSurfaceSource?(src: string): void;
}

const WARP_PRESETS = [1, 100_000];
const fmtInt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const fmt4 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 4, minimumFractionDigits: 4 });
const dateFmt = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  timeZone: 'UTC',
});

function formatDistance(m: number): string {
  return m > 0.05 * AU ? `${fmt4.format(m / AU)} AU` : `${fmtInt.format(m / KM)} km`;
}

function formatPeriod(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const d = s / DAY;
  return d > 730 ? `${fmt2.format(d / 365.25)} anni` : d > 2 ? `${fmt2.format(d)} giorni` : `${fmt2.format(s / 3600)} ore`;
}

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class HudControls {
  readonly root: HTMLDivElement;
  private readonly sim: Simulation;
  private readonly handlers: HudHandlers;
  private readonly dateEl: HTMLDivElement;
  private readonly warpEl: HTMLDivElement;
  private readonly infoEl: HTMLDivElement;
  private readonly select: HTMLSelectElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly liveBtn: HTMLButtonElement;
  private readonly warpRange: HTMLInputElement;
  private readonly dateInput: HTMLInputElement;
  private readonly qualityEl: HTMLDivElement;
  /** Impostato da main.ts: true se la simulazione segue l'ora reale. */
  live = false;
  /** Stato della sincronizzazione con le effemeridi JPL (impostato da main.ts). */
  ephem: { status: string; bodies: number } | null = null;
  private readonly warpBtns: HTMLButtonElement[] = [];
  private readonly scaleBtns: HTMLButtonElement[] = [];
  private infoClock = Infinity;
  private focusId = 'sun';

  constructor(container: HTMLElement, sim: Simulation, handlers: HudHandlers) {
    this.sim = sim;
    this.handlers = handlers;
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <section class="panel">
        <div class="hud-title">SolarSim</div>
        <div class="sim-date" data-ref="date"></div>
        <div class="btn-row" data-ref="warp-buttons">
          <button type="button" data-ref="pause" title="Pausa / riprendi (Spazio)">❚❚ Pausa</button>
          ${WARP_PRESETS.map((w) => `<button type="button" data-warp="${w}">${fmtInt.format(w)}x</button>`).join('')}
        </div>
        <div class="btn-row live-row">
          <button type="button" data-ref="live" title="Sincronizza con l'ora reale e segui i dati in tempo reale">● LIVE · ora reale</button>
        </div>
        <label class="warp-slider" title="Velocità del tempo (tasti , e .)">
          <input type="range" data-ref="warpRange" min="0" max="${TIME_WARP_LEVELS.length - 1}" step="1" value="0" />
        </label>
        <div class="warp-status" data-ref="warp"></div>
        <div class="date-row">
          <input type="datetime-local" data-ref="dateInput" title="Data e ora (ora locale)" />
          <button type="button" data-ref="goDate" title="Calcola la posizione di tutto a questa data">Vai</button>
        </div>
        <div class="data-quality" data-ref="quality"></div>
        <button type="button" class="launch-btn" data-ref="openLaunch">🚀 Simulatore di lancio</button>
      </section>
      <section class="panel">
        <label class="field">Aggancia camera
          <select data-ref="focus"></select>
        </label>
        <div class="field">Scala
          <div class="btn-row seg">
            <button type="button" data-scale="log">Logaritmica</button>
            <button type="button" data-scale="real">Reale</button>
          </div>
        </div>
        <div class="checks">
          <label><input type="checkbox" data-ref="orbits" checked /> Orbite</label>
          <label><input type="checkbox" data-ref="labels" checked /> Etichette</label>
        </div>
        <label class="field surface-field">Superficie terrestre da vicino
          <select data-ref="surface">
            <option value="esri">Esri World Imagery (fino a ~0,5 m)</option>
            <option value="s2">Sentinel-2 cloudless 2023 (10 m)</option>
            <option value="off">Solo mappa globale NASA</option>
          </select>
        </label>
      </section>
      <section class="panel info" data-ref="info"></section>
    `;
    container.appendChild(this.root);

    const q = <T extends Element>(sel: string) => {
      const el = this.root.querySelector<T>(sel);
      if (!el) throw new Error(`HUD: elemento mancante ${sel}`);
      return el;
    };
    this.dateEl = q('[data-ref="date"]');
    this.warpEl = q('[data-ref="warp"]');
    this.infoEl = q('[data-ref="info"]');
    this.select = q('[data-ref="focus"]');
    this.pauseBtn = q('[data-ref="pause"]');
    this.liveBtn = q('[data-ref="live"]');
    this.liveBtn.addEventListener('click', () => this.handlers.onLive());
    this.warpRange = q('[data-ref="warpRange"]');
    this.warpRange.addEventListener('input', () => this.setWarp(TIME_WARP_LEVELS[Number(this.warpRange.value)]));
    this.dateInput = q('[data-ref="dateInput"]');
    this.qualityEl = q('[data-ref="quality"]');
    const go = () => {
      const d = new Date(this.dateInput.value);
      if (!Number.isNaN(d.getTime())) this.handlers.onGoToDate(d);
    };
    q<HTMLButtonElement>('[data-ref="goDate"]').addEventListener('click', go);
    this.dateInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
    });
    q<HTMLButtonElement>('[data-ref="openLaunch"]').addEventListener('click', () => this.handlers.onOpenLaunch());

    this.pauseBtn.addEventListener('click', () => this.togglePause());
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-warp]')) {
      this.warpBtns.push(b);
      b.addEventListener('click', () => this.setWarp(Number(b.dataset.warp)));
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-scale]')) {
      this.scaleBtns.push(b);
      b.addEventListener('click', () => {
        const mode = b.dataset.scale as ScaleMode;
        this.setScaleButtons(mode);
        this.handlers.onScaleMode(mode);
      });
    }
    q<HTMLInputElement>('[data-ref="orbits"]').addEventListener('change', (e) =>
      this.handlers.onToggleOrbits((e.target as HTMLInputElement).checked),
    );
    q<HTMLInputElement>('[data-ref="labels"]').addEventListener('change', (e) =>
      this.handlers.onToggleLabels((e.target as HTMLInputElement).checked),
    );

    this.populateSelect();
    this.select.addEventListener('change', () => this.handlers.onFocus(this.select.value));
    const surface = q<HTMLSelectElement>('[data-ref="surface"]');
    try {
      const saved = localStorage.getItem('solarsim.surface');
      if (saved) surface.value = saved;
    } catch {
      /* archivio del browser non disponibile */
    }
    surface.addEventListener('change', () => {
      try {
        localStorage.setItem('solarsim.surface', surface.value);
      } catch {
        /* ignora */
      }
      this.handlers.onSurfaceSource?.(surface.value);
    });
    queueMicrotask(() => this.handlers.onSurfaceSource?.(surface.value));
    themeAllSelects(this.root);
    this.setScaleButtons('log');
    // Dopo un clic il pulsante perde il focus: così Spazio resta la scorciatoia di pausa
    // invece di "ripremere" l'ultimo pulsante cliccato.
    this.root.addEventListener('click', (e) => {
      if (e.target instanceof HTMLButtonElement) e.target.blur();
    });
  }

  private populateSelect(): void {
    const bodies = this.sim.bodies.filter((b) => b.kind !== 'probe');
    const opts: string[] = [];
    for (const b of bodies) {
      if (b.kind === 'moon') continue;
      opts.push(`<option value="${b.id}">${b.name}</option>`);
      for (const m of bodies.filter((x) => x.parentId === b.id && x.kind === 'moon')) {
        opts.push(`<option value="${m.id}">   ↳ ${m.name}</option>`);
      }
    }
    this.select.innerHTML = opts.join('');
  }

  togglePause(): void {
    this.sim.paused = !this.sim.paused;
    this.handlers.onManualTime();
  }

  setWarp(w: number): void {
    this.sim.timeWarp = w;
    this.sim.paused = false;
    this.handlers.onManualTime();
  }

  setFocus(id: string): void {
    this.focusId = id;
    // Gli oggetti artificiali non sono nel menu: in quel caso il menu resta vuoto
    this.select.value = this.sim.has(id) ? id : '';
    this.infoClock = Infinity;
  }

  /** Indica da dove vengono i dati alla data simulata. */
  private updateQuality(): void {
    const now = Date.now();
    const simMs = this.sim.date.getTime();
    const diffDays = (simMs - now) / 86400000;
    const year = this.sim.date.getUTCFullYear();
    let text: string;
    let cls = '';
    if (this.live) text = '● Dati in tempo reale';
    else if (Math.abs(diffDays) < 1) text = 'Presente: dati reali (TLE e JPL aggiornati)';
    else if (diffDays < 0) {
      text = `Passato (${Math.round(-diffDays).toLocaleString('it-IT')} giorni fa): sonde e asteroidi dall'archivio JPL; satelliti ricostruiti da TLE attuali (affidabili ±30 giorni)`;
      cls = 'past';
    } else {
      text = `Futuro (+${Math.round(diffDays).toLocaleString('it-IT')} giorni): STIMA — pianeti e asteroidi calcolati, sonde da traiettorie JPL previste`;
      cls = 'future';
    }
    if (year < 1800 || year > 2050) {
      text += ' · fuori dal periodo di validità degli elementi planetari (1800–2050)';
      cls = 'future';
    }
    const e = this.ephem;
    if (e) {
      text += e.status === 'loading' ? ' · pianeti: sincronizzazione con JPL…'
        : e.status === 'ok' || e.status === 'partial' ? ` · pianeti e lune: effemeridi JPL DE440 (${e.bodies} corpi)`
        : e.status === 'error' ? ' · pianeti: modello kepleriano (JPL non raggiungibile)' : '';
    }
    this.qualityEl.textContent = text;
    this.qualityEl.className = `data-quality ${cls}`;
  }

  private setScaleButtons(mode: ScaleMode): void {
    for (const b of this.scaleBtns) b.classList.toggle('active', b.dataset.scale === mode);
  }

  update(realDt: number): void {
    const sim = this.sim;
    this.dateEl.textContent = `${dateFmt.format(sim.date)} UTC`;

    this.pauseBtn.classList.toggle('active', sim.paused);
    this.pauseBtn.textContent = sim.paused ? '▶ Riprendi' : '❚❚ Pausa';
    for (const b of this.warpBtns) {
      b.classList.toggle('active', !this.live && !sim.paused && Number(b.dataset.warp) === sim.timeWarp);
    }
    this.liveBtn.classList.toggle('live-on', this.live);
    if (document.activeElement !== this.warpRange) {
      const idx = TIME_WARP_LEVELS.findIndex((w) => w >= sim.timeWarp);
      this.warpRange.value = String(idx < 0 ? TIME_WARP_LEVELS.length - 1 : idx);
    }
    if (document.activeElement !== this.dateInput) this.dateInput.value = toLocalInput(sim.date);
    this.updateQuality();

    const f = sim.lastFrame;
    const warpText = this.live ? 'LIVE · sincronizzato con l\'ora reale' : sim.paused ? 'In pausa' : `Warp ${fmtInt.format(sim.timeWarp)}×`;
    const eff = f.requested > 0 && f.limited ? ` · limitato a ${fmtInt.format((f.simulated / f.requested) * sim.timeWarp)}×` : '';
    this.warpEl.textContent = this.live ? warpText : `${warpText}${eff} · ${f.substeps} passi/frame`;
    this.warpEl.classList.toggle('warn', f.limited);

    // Il riquadro informativo si aggiorna 5 volte al secondo
    this.infoClock += realDt;
    if (this.infoClock < 0.2) return;
    this.infoClock = 0;
    // Oggetto artificiale agganciato: la sua telemetria è nel pannello dedicato
    this.infoEl.hidden = !sim.has(this.focusId);
    if (this.infoEl.hidden) return;
    const body = sim.get(this.focusId);
    if (body.kind === 'star') {
      const v = sim.velocity(body.id).length();
      this.infoEl.innerHTML = `
        <div class="info-name" style="--body-color:${body.def?.color}">${body.name}</div>
        <dl>
          <dt>Raggio</dt><dd>${fmtInt.format(body.radius / KM)} km</dd>
          <dt>Vel. baricentrica</dt><dd>${fmt2.format(v)} m/s</dd>
        </dl>`;
      return;
    }
    const t = sim.telemetry(body.id);
    const ref = sim.get(t.refId);
    this.infoEl.innerHTML = `
      <div class="info-name" style="--body-color:${body.def?.color ?? '#fff'}">${body.name}</div>
      <dl>
        <dt>Riferimento</dt><dd>${ref.name}</dd>
        <dt>Distanza</dt><dd>${formatDistance(t.distance)}</dd>
        <dt>Velocità</dt><dd>${fmt2.format(t.speed / 1000)} km/s</dd>
        <dt>Periasse</dt><dd>${formatDistance(t.orbit.periapsis)}</dd>
        <dt>Apoasse</dt><dd>${Number.isFinite(t.orbit.apoapsis) ? formatDistance(t.orbit.apoapsis) : '—'}</dd>
        <dt>Eccentricità</dt><dd>${fmt4.format(t.orbit.e)}</dd>
        <dt>Periodo</dt><dd>${formatPeriod(t.orbit.period)}</dd>
      </dl>`;
  }
}
