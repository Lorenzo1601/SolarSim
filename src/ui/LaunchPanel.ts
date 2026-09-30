/**
 * Simulatore di lancio — finestra di configurazione:
 *   lanciatore (preset reali modificabili stadio per stadio), carico utile, sito, missione,
 *   finestra di lancio, analisi pre-lancio (salita simulata e ottimizzata) e lancio.
 */
import { themeAllSelects } from './ThemedSelect.ts';
import { DAY, dateFromSimTime, simTimeFromDate } from '../physics/constants.ts';
import type { Simulation } from '../physics/simulation.ts';
import { DEG_RAD, idealDeltaV, optimizePitchKick, type AscentResult } from '../launch/ascent.ts';
import { G0, MU_EARTH, R_EQ, R_GEO, gmst } from '../launch/earthModel.ts';
import type { MissionConfig, MissionType } from '../launch/mission.ts';
import { TRANSFER_RANGES, lunarWindow, findPlaneWindow, searchTransfer, ssoInclination, type TransferPlan } from '../launch/planner.ts';
import { ROCKETS, SITES, cloneRocket, type RocketDef, type StageDef } from '../launch/rockets.ts';
import { escapeHtml, fmt1, fmt2, fmtInt } from './format.ts';

export interface LaunchPanelHandlers {
  onLaunch(cfg: MissionConfig): void;
}

const MISSION_LABELS: Record<MissionType, string> = {
  leo: 'Orbita bassa (LEO)',
  sso: 'Orbita eliosincrona (SSO)',
  gto: 'Trasferimento geostazionario (GTO)',
  geo: 'Orbita geostazionaria (GEO)',
  moon: 'Luna',
  planet: 'Pianeta',
};

const dateFmt = new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class LaunchPanel {
  private readonly sim: Simulation;
  private readonly handlers: LaunchPanelHandlers;
  private readonly root: HTMLDivElement;
  private rocket: RocketDef = cloneRocket(ROCKETS[0]);
  private transfer: TransferPlan | null = null;
  private windowTime: { t: number; southward: boolean; inclination: number } | null = null;
  private analysis: { result: AscentResult; kick: number; cfgKey: string } | null = null;

  constructor(container: HTMLElement, sim: Simulation, handlers: LaunchPanelHandlers) {
    this.sim = sim;
    this.handlers = handlers;
    this.root = document.createElement('div');
    this.root.className = 'launch-modal';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="launch-dialog panel" role="dialog" aria-label="Simulatore di lancio">
        <header class="launch-head">
          <div><div class="hud-title">Simulatore di lancio</div><h2>Prepara la missione</h2></div>
          <button type="button" class="icon-btn" data-act="close" title="Chiudi">✕</button>
        </header>
        <div class="launch-body">
          <section class="lsec">
            <h3>1 · Lanciatore</h3>
            <div class="row">
              <select data-f="rocket">${ROCKETS.map((r) => `<option value="${r.id}">${r.name}</option>`).join('')}<option value="custom">Personalizzato…</option></select>
              <label>Carico dichiarato <span data-f="reference" class="muted"></span></label>
            </div>
            <p class="muted small" data-f="rocketNote"></p>
            <div class="stage-table-wrap"><table class="stage-table" data-f="stages"></table></div>
            <div class="row">
              <button type="button" data-act="addStage">+ Stadio</button>
              <label>Ogiva/LES (kg) <input type="number" data-f="fairing" min="0" step="10" /></label>
              <label>Diametro (m) <input type="number" data-f="diameter" min="0.5" step="0.1" /></label>
              <label>Cd <input type="number" data-f="cd" min="0.1" max="1.5" step="0.01" /></label>
            </div>
          </section>

          <section class="lsec">
            <h3>2 · Carico utile</h3>
            <div class="row">
              <label>Nome <input type="text" data-f="plName" value="Satellite" /></label>
              <label>Massa totale (kg) <input type="number" data-f="plMass" min="1" step="10" /></label>
              <label>Propellente a bordo (kg) <input type="number" data-f="plProp" min="0" step="10" value="1500" /></label>
              <label>Spinta motore (N) <input type="number" data-f="plThrust" min="0" step="10" value="450" /></label>
              <label>Isp (s) <input type="number" data-f="plIsp" min="50" step="1" value="320" /></label>
            </div>
          </section>

          <section class="lsec">
            <h3>3 · Missione</h3>
            <div class="row">
              <label>Sito di lancio <select data-f="site">${SITES.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')}</select></label>
              <label>Destinazione <select data-f="type">${(Object.keys(MISSION_LABELS) as MissionType[]).map((k) => `<option value="${k}">${MISSION_LABELS[k]}</option>`).join('')}</select></label>
            </div>
            <div class="row" data-group="orbit">
              <label>Quota (km) <input type="number" data-f="alt" min="150" max="36000" step="10" value="400" /></label>
              <label>Inclinazione (°) <input type="number" data-f="incl" min="0" max="180" step="0.1" value="51.6" /></label>
              <label class="chk"><input type="checkbox" data-f="south" /> Lancio verso sud</label>
            </div>
            <div class="row" data-group="target">
              <label data-group="planetOnly">Pianeta <select data-f="target">${Object.entries(TRANSFER_RANGES).map(([k, v]) => `<option value="${k}"${k === 'mars' ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>
              <label>Arrivo <select data-f="arrival"><option value="orbit">Inserimento in orbita</option><option value="flyby">Flyby</option></select></label>
              <label>Quota del periasse (km) <input type="number" data-f="arrAlt" min="20" step="10" value="400" /></label>
              <button type="button" data-act="window">Calcola la finestra di lancio</button>
            </div>
            <div data-f="windowOut" class="window-out"></div>
          </section>

          <section class="lsec">
            <h3>4 · Data, ora e opzioni di volo</h3>
            <div class="row">
              <label>Decollo <select data-f="when"><option value="now">Tra 60 secondi</option><option value="custom">Data e ora scelte</option><option value="window">Finestra calcolata</option></select></label>
              <label data-group="custom">Data e ora (ora locale) <input type="datetime-local" data-f="date" /></label>
              <label>Accelerazione max (g) <input type="number" data-f="maxG" min="1.5" max="12" step="0.1" value="5" /></label>
              <label>Max-Q (kPa) <input type="number" data-f="maxQ" min="10" max="100" step="1" value="35" /></label>
              <label class="chk" data-group="recovery"><input type="checkbox" data-f="recovery" /> Recupero del primo stadio</label>
            </div>
          </section>

          <section class="lsec">
            <h3>5 · Analisi pre-lancio</h3>
            <div class="row"><button type="button" data-act="analyze">Simula la salita</button><span class="muted small">La traiettoria (angolo di beccheggio) viene ottimizzata automaticamente.</span></div>
            <div data-f="analysis" class="analysis"></div>
          </section>
        </div>
        <footer class="launch-foot">
          <span class="muted small" data-f="status"></span>
          <button type="button" class="go" data-act="launch">🚀 Lancia</button>
        </footer>
      </div>`;
    container.appendChild(this.root);

    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'close') this.close();
      else if (act === 'addStage') this.addStage();
      else if (act === 'window') this.computeWindow();
      else if (act === 'analyze') this.analyze();
      else if (act === 'launch') this.launch();
      else if (act.startsWith('delStage:')) this.delStage(Number(act.slice(9)));
    });
    this.root.addEventListener('change', (e) => this.onChange(e.target as HTMLElement));
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    this.el<HTMLSelectElement>('rocket').value = this.rocket.id;
    this.el<HTMLInputElement>('date').value = toLocalInput(new Date(Date.now() + 3600e3));
    this.loadRocket();
    this.updateVisibility();
    themeAllSelects(this.root);
  }

  private el<T extends HTMLElement>(f: string): T {
    return this.root.querySelector<T>(`[data-f="${f}"]`)!;
  }

  private num(f: string): number {
    return Number(this.el<HTMLInputElement>(f).value);
  }

  open(): void {
    this.root.hidden = false;
  }

  close(): void {
    this.root.hidden = true;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  private loadRocket(): void {
    const r = this.rocket;
    this.el('reference').textContent = r.reference;
    this.el('rocketNote').textContent = `${r.maker} — ${r.note}`;
    this.el<HTMLInputElement>('fairing').value = String(r.fairingMass);
    this.el<HTMLInputElement>('diameter').value = String(r.diameter);
    this.el<HTMLInputElement>('cd').value = String(r.cd);
    this.el<HTMLInputElement>('plMass').value = String(r.defaultPayload);
    this.renderStages();
    this.invalidate();
  }

  private renderStages(): void {
    const head = `<tr><th>Stadio</th><th>N°</th><th>Massa a secco (t)</th><th>Propellente (t)</th><th>Spinta liv. mare (kN)</th><th>Spinta vuoto (kN)</th><th>Isp mare (s)</th><th>Isp vuoto (s)</th><th>Regol. min</th><th title="Booster laterale acceso insieme allo stadio successivo">Parall.</th><th>Solido</th><th>Recup.</th><th></th></tr>`;
    const rows = this.rocket.stages.map((s, i) => {
      const burn = (s.propMass * s.ispVac * G0) / s.thrustVac;
      return `<tr data-stage="${i}">
        <td><input type="text" data-s="name" value="${escapeHtml(s.name)}" /><div class="muted small">combustione ≈ ${fmtInt.format(burn)} s</div></td>
        <td><input type="number" data-s="count" min="1" max="9" step="1" value="${s.count}" /></td>
        <td><input type="number" data-s="dryMass" step="0.01" value="${s.dryMass / 1000}" /></td>
        <td><input type="number" data-s="propMass" step="0.1" value="${s.propMass / 1000}" /></td>
        <td><input type="number" data-s="thrustSL" step="1" value="${s.thrustSL / 1000}" /></td>
        <td><input type="number" data-s="thrustVac" step="1" value="${s.thrustVac / 1000}" /></td>
        <td><input type="number" data-s="ispSL" step="1" value="${s.ispSL}" /></td>
        <td><input type="number" data-s="ispVac" step="0.1" value="${s.ispVac}" /></td>
        <td><input type="number" data-s="minThrottle" min="0.1" max="1" step="0.01" value="${s.minThrottle}" /></td>
        <td><input type="checkbox" data-s="parallel" ${s.parallel ? 'checked' : ''} /></td>
        <td><input type="checkbox" data-s="solid" ${s.solid ? 'checked' : ''} /></td>
        <td><input type="checkbox" data-s="recoverable" ${s.recoverable ? 'checked' : ''} /></td>
        <td><button type="button" class="icon-btn" data-act="delStage:${i}" title="Rimuovi">✕</button></td>
      </tr>`;
    });
    this.el('stages').innerHTML = head + rows.join('');
    const payload = this.num('plMass') || this.rocket.defaultPayload;
    const d = idealDeltaV(this.rocket, payload);
    this.el('status').textContent = `Massa al decollo ${fmt1.format(d.liftoffMass / 1000)} t · spinta/peso ${fmt2.format(d.twr)} · Δv ideale ${fmtInt.format(d.total)} m/s`;
    this.el<HTMLElement>('recovery').closest('label')!.hidden = !this.rocket.stages.some((s) => s.recoverable);
  }

  private addStage(): void {
    const last = this.rocket.stages[this.rocket.stages.length - 1];
    const s: StageDef = last ? { ...last, name: `Stadio ${this.rocket.stages.length + 1}`, parallel: false } : {
      name: 'Stadio 1', count: 1, dryMass: 5000, propMass: 50000, thrustSL: 800e3, thrustVac: 900e3, ispSL: 280, ispVac: 310, minThrottle: 1,
    };
    this.rocket.stages.push(s);
    this.markCustom();
    this.renderStages();
  }

  private delStage(i: number): void {
    if (this.rocket.stages.length <= 1) return;
    this.rocket.stages.splice(i, 1);
    this.markCustom();
    this.renderStages();
  }

  private markCustom(): void {
    this.invalidate();
  }

  private invalidate(): void {
    this.analysis = null;
    this.el('analysis').innerHTML = '';
  }

  private onChange(t: HTMLElement): void {
    const f = t.dataset.f;
    const sf = t.dataset.s;
    if (f === 'rocket') {
      const v = (t as HTMLSelectElement).value;
      if (v !== 'custom') this.rocket = cloneRocket(ROCKETS.find((r) => r.id === v)!);
      else this.rocket = { ...cloneRocket(this.rocket), id: 'custom', name: 'Razzo personalizzato', reference: '—', note: 'Modifica liberamente stadi, masse, spinte e impulsi specifici.' };
      this.loadRocket();
    } else if (sf) {
      const i = Number(t.closest<HTMLElement>('[data-stage]')!.dataset.stage);
      const s = this.rocket.stages[i] as unknown as Record<string, unknown>;
      const inp = t as HTMLInputElement;
      if (inp.type === 'checkbox') s[sf] = inp.checked;
      else if (sf === 'name') s[sf] = inp.value;
      else {
        const k = ['dryMass', 'propMass'].includes(sf) ? 1000 : ['thrustSL', 'thrustVac'].includes(sf) ? 1000 : 1;
        s[sf] = Number(inp.value) * k;
      }
      this.markCustom();
      this.renderStages();
    } else if (f === 'fairing' || f === 'diameter' || f === 'cd') {
      const key = f === 'fairing' ? 'fairingMass' : f;
      (this.rocket as unknown as Record<string, number>)[key] = this.num(f);
      this.invalidate();
      this.renderStages();
    } else if (f === 'type') {
      const type = (t as HTMLSelectElement).value as MissionType;
      const alt = this.el<HTMLInputElement>('alt');
      const incl = this.el<HTMLInputElement>('incl');
      if (type === 'sso') {
        alt.value = '600';
        incl.value = (ssoInclination(600e3) / DEG_RAD).toFixed(1);
      } else if (type === 'leo') incl.value = '51.6';
      if (type === 'moon') this.el<HTMLInputElement>('arrAlt').value = '100';
      if (type === 'planet') this.el<HTMLInputElement>('arrAlt').value = '400';
      this.transfer = null;
      this.windowTime = null;
      this.el('windowOut').innerHTML = '';
      this.updateVisibility();
      this.invalidate();
    } else {
      if (f === 'alt' && this.el<HTMLSelectElement>('type').value === 'sso') {
        this.el<HTMLInputElement>('incl').value = (ssoInclination(this.num('alt') * 1000) / DEG_RAD).toFixed(1);
      }
      if (f === 'target' || f === 'site' || f === 'arrival') {
        this.transfer = null;
        this.windowTime = null;
        this.el('windowOut').innerHTML = '';
      }
      if (f === 'plMass') this.renderStages();
      this.updateVisibility();
      this.invalidate();
    }
  }

  private updateVisibility(): void {
    const type = this.el<HTMLSelectElement>('type').value as MissionType;
    const show = (sel: string, on: boolean) => this.root.querySelectorAll<HTMLElement>(`[data-group="${sel}"]`).forEach((e) => (e.hidden = !on));
    show('orbit', type === 'leo' || type === 'sso');
    show('target', type === 'moon' || type === 'planet');
    show('planetOnly', type === 'planet');
    show('custom', this.el<HTMLSelectElement>('when').value === 'custom');
  }

  private site() {
    return SITES.find((s) => s.id === this.el<HTMLSelectElement>('site').value)!;
  }

  /** Inclinazione dell'orbita di parcheggio per GTO/Luna/pianeti. */
  private parkingInclination(type: MissionType): number {
    const lat = Math.abs(this.site().lat);
    if (type === 'planet' && this.transfer) return Math.max(lat + 0.3, Math.abs(this.transfer.dla) / DEG_RAD + 1) * DEG_RAD;
    if (type === 'moon') return Math.max(lat + 0.3, 29) * DEG_RAD;
    return (lat + 0.3) * DEG_RAD;
  }

  private computeWindow(): void {
    const type = this.el<HTMLSelectElement>('type').value as MissionType;
    const out = this.el('windowOut');
    out.innerHTML = '<span class="muted">Calcolo in corso…</span>';
    setTimeout(() => {
      const site = this.site();
      if (type === 'moon') {
        const incl = this.parkingInclination('moon');
        const from = this.whenBase();
        const w = lunarWindow(this.sim, site, incl, from, DAY);
        this.windowTime = { t: w.t, southward: w.southward, inclination: incl };
        out.innerHTML = `<b>Finestra lunare:</b> decollo ${dateFmt.format(dateFromSimTime(w.t))} UTC, azimut ${w.southward ? 'verso sud-est' : 'verso nord-est'},
          orbita di parcheggio a ${fmt1.format(incl / DEG_RAD)}°: il piano orbitale contiene la posizione della Luna all'arrivo (~3,6 giorni).`;
      } else if (type === 'planet') {
        const target = this.el<HTMLSelectElement>('target').value;
        const insertion = this.el<HTMLSelectElement>('arrival').value === 'orbit';
        const span = target === 'mars' ? 800 : target === 'venus' || target === 'mercury' ? 600 : 420;
        const from = this.whenBase();
        const plan = searchTransfer(this.sim.catalog, target, from, span, insertion, this.num('arrAlt') * 1000);
        if (!plan) {
          out.innerHTML = '<span class="warn">Nessuna traiettoria trovata.</span>';
          return;
        }
        this.transfer = plan;
        const incl = this.parkingInclination('planet');
        const day0 = Math.floor(plan.departure / DAY) * DAY;
        const w = findPlaneWindow(site, incl, day0, DAY, () => plan.vInfDep);
        this.windowTime = { t: w.t, southward: w.southward, inclination: incl };
        const tof = (plan.arrival - plan.departure) / DAY;
        out.innerHTML = `
          <table class="win-table">
            <tr><th>Partenza</th><td>${dateFmt.format(dateFromSimTime(w.t))} UTC</td><th>Arrivo</th><td>${dateFmt.format(dateFromSimTime(plan.arrival))} UTC (${fmtInt.format(tof)} giorni)</td></tr>
            <tr><th>Energia C3</th><td>${fmt2.format(plan.c3 / 1e6)} km²/s²</td><th>v∞ all'arrivo</th><td>${fmt2.format(plan.vInfArr.length() / 1000)} km/s</td></tr>
            <tr><th>Δv fuga da LEO</th><td>${fmtInt.format(plan.dvDeparture)} m/s</td><th>Δv cattura</th><td>${fmtInt.format(plan.dvCapture)} m/s</td></tr>
            <tr><th>Declinazione asintoto</th><td>${fmt1.format(plan.dla / DEG_RAD)}°</td><th>Parcheggio</th><td>${fmt1.format(incl / DEG_RAD)}°, azimut ${w.southward ? 'sud-est' : 'nord-est'}</td></tr>
          </table>`;
      }
      this.el<HTMLSelectElement>('when').value = 'window';
      this.updateVisibility();
      this.invalidate();
    }, 30);
  }

  private whenBase(): number {
    const when = this.el<HTMLSelectElement>('when').value;
    if (when === 'custom') return simTimeFromDate(new Date(this.el<HTMLInputElement>('date').value));
    return this.sim.time + 60;
  }

  private launchTime(): number {
    const when = this.el<HTMLSelectElement>('when').value;
    if (when === 'window' && this.windowTime) return this.windowTime.t;
    return this.whenBase();
  }

  /** Configurazione della missione dai campi del modulo. */
  buildConfig(): MissionConfig {
    const type = this.el<HTMLSelectElement>('type').value as MissionType;
    const site = this.site();
    const orbitType = type === 'leo' || type === 'sso';
    const win = this.el<HTMLSelectElement>('when').value === 'window' ? this.windowTime : null;
    const inclination = orbitType ? this.num('incl') * DEG_RAD : win?.inclination ?? this.parkingInclination(type);
    return {
      rocket: cloneRocket(this.rocket),
      site,
      payload: {
        name: this.el<HTMLInputElement>('plName').value || 'Carico utile',
        mass: this.num('plMass'),
        propellant: Math.min(this.num('plProp'), this.num('plMass') * 0.9),
        thrust: this.num('plThrust'),
        isp: this.num('plIsp'),
      },
      type,
      altitude: orbitType ? this.num('alt') * 1000 : 200e3,
      inclination,
      southward: orbitType ? this.el<HTMLInputElement>('south').checked : win?.southward ?? false,
      recovery: this.el<HTMLInputElement>('recovery').checked,
      maxAccelG: this.num('maxG'),
      maxQ: this.num('maxQ') * 1000,
      pitchKick: this.analysis?.kick ?? 5 * DEG_RAD,
      parkingAltitude: 200e3,
      launchTime: this.launchTime(),
      arrivalMode: this.el<HTMLSelectElement>('arrival').value as 'orbit' | 'flyby',
      arrivalAltitude: this.num('arrAlt') * 1000,
      target: type === 'planet' ? this.el<HTMLSelectElement>('target').value : undefined,
      transfer: type === 'planet' ? this.transfer ?? undefined : undefined,
    };
  }

  private cfgKey(c: MissionConfig): string {
    return JSON.stringify([c.rocket, c.payload.mass, c.site.id, c.type, c.altitude, c.inclination, c.southward, c.recovery, c.maxAccelG, c.maxQ]);
  }

  /** Simula la salita (con ottimizzazione del pitch kick) e stima il margine per il resto della missione. */
  private analyze(): boolean {
    const c = this.buildConfig();
    const out = this.el('analysis');
    const orbitType = c.type === 'leo' || c.type === 'sso';
    const insPeri = orbitType ? Math.min(c.altitude, 200e3) : 200e3;
    const insApo = orbitType ? c.altitude : 200e3;
    const opt = optimizePitchKick({
      rocket: c.rocket, payloadMass: c.payload.mass, site: c.site, targetAltitude: insPeri, targetApoapsis: insApo,
      inclination: c.inclination, southward: c.southward, maxAccelG: c.maxAccelG, maxQ: c.maxQ, pitchStartSpeed: 50,
      recovery: c.recovery, theta0: gmst(c.launchTime),
    });
    this.analysis = { result: opt.result, kick: opt.pitchKick, cfgKey: this.cfgKey(c) };
    const v = opt.result.vehicle;
    const tel = v.telemetry();
    const ideal = idealDeltaV(c.rocket, c.payload.mass);
    const up = v.upperStage();
    const dvUpper = up && up.prop > 0 ? up.isp * G0 * Math.log((c.payload.mass + up.dry + up.prop) / (c.payload.mass + up.dry)) : 0;
    const dvPayload = c.payload.isp * G0 * Math.log(c.payload.mass / Math.max(1, c.payload.mass - c.payload.propellant));
    // Δv richiesto dopo l'orbita di parcheggio
    const r0 = R_EQ + insPeri;
    let needUpper = 0;
    let needPayload = 0;
    let needText = '';
    if (orbitType) {
      const rT = R_EQ + c.altitude;
      const aT = (r0 + rT) / 2;
      needUpper = c.altitude > insPeri ? Math.sqrt(MU_EARTH / rT) - Math.sqrt(MU_EARTH * (2 / rT - 1 / aT)) : 0;
      needText = 'circolarizzazione';
    } else if (c.type === 'gto' || c.type === 'geo') {
      needUpper = Math.sqrt(MU_EARTH * (2 / r0 - 2 / (r0 + R_GEO))) - Math.sqrt(MU_EARTH / r0);
      if (c.type === 'geo') {
        const vA = Math.sqrt(MU_EARTH * (2 / R_GEO - 2 / (r0 + R_GEO)));
        const vG = Math.sqrt(MU_EARTH / R_GEO);
        needPayload = Math.sqrt(vA * vA + vG * vG - 2 * vA * vG * Math.cos(c.inclination));
      }
      needText = c.type === 'gto' ? 'iniezione in GTO' : 'GTO + apogeo';
    } else if (c.type === 'moon') {
      needUpper = 3130;
      needPayload = 30 + (c.arrivalMode === 'orbit' ? 850 : 0);
      needText = 'TLI + correzioni + cattura';
    } else if (c.type === 'planet' && c.transfer) {
      needUpper = c.transfer.dvDeparture;
      needPayload = 40 + (c.arrivalMode === 'orbit' ? c.transfer.dvCapture : 0);
      needText = 'fuga + correzioni + cattura';
    }
    const okAscent = opt.result.success;
    const okUpper = dvUpper >= needUpper * 1.02;
    const okPayload = dvPayload >= needPayload;
    const verdict = okAscent && okUpper && okPayload;
    const ev = v.events.filter((e) => ['maxq', 'booster', 'meco', 'seco', 'orbit', 'failure', 'fairing'].includes(e.kind))
      .map((e) => `<li><b>T+${Math.floor(e.t / 60)}:${String(Math.floor(e.t % 60)).padStart(2, '0')}</b> ${escapeHtml(e.text)}</li>`).join('');
    out.innerHTML = `
      <div class="verdict ${verdict ? 'ok' : 'ko'}">${verdict ? '✔ Missione fattibile' : '✖ Missione non fattibile con questa configurazione'}</div>
      <div class="an-grid">
        <div><span>Massa al decollo</span><b>${fmt1.format(ideal.liftoffMass / 1000)} t</b></div>
        <div><span>Spinta/peso al decollo</span><b class="${ideal.twr < 1.05 ? 'warn' : ''}">${fmt2.format(ideal.twr)}</b></div>
        <div><span>Δv ideale (Tsiolkovsky)</span><b>${fmtInt.format(ideal.total)} m/s</b></div>
        <div><span>Salita</span><b class="${okAscent ? '' : 'warn'}">${okAscent ? `orbita ${fmtInt.format(tel.periapsis / 1000)} × ${fmtInt.format(tel.apoapsis / 1000)} km` : 'orbita NON raggiunta'}</b></div>
        <div><span>Max-Q</span><b>${fmt1.format(v.maxQ / 1000)} kPa a T+${fmtInt.format(v.maxQTime)} s</b></div>
        <div><span>Angolo di beccheggio ottimale</span><b>${fmt2.format(opt.pitchKick / DEG_RAD)}°</b></div>
        <div><span>Δv stadio superiore residuo</span><b class="${okUpper ? '' : 'warn'}">${fmtInt.format(dvUpper)} m/s (servono ${fmtInt.format(needUpper)} per ${needText || '—'})</b></div>
        <div><span>Δv del satellite</span><b class="${okPayload ? '' : 'warn'}">${fmtInt.format(dvPayload)} m/s (servono ~${fmtInt.format(needPayload)})</b></div>
      </div>
      <ul class="an-events">${ev}</ul>`;
    return verdict;
  }

  private launch(): void {
    const c = this.buildConfig();
    if (c.type === 'planet' && !c.transfer) {
      this.el('windowOut').innerHTML = '<span class="warn">Calcola prima la finestra di lancio verso il pianeta.</span>';
      return;
    }
    if (!this.analysis || this.analysis.cfgKey !== this.cfgKey(c)) this.analyze();
    c.pitchKick = this.analysis!.kick;
    this.close();
    this.handlers.onLaunch(c);
  }
}
