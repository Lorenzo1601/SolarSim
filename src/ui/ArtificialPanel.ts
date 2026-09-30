/**
 * Pannello "Oggetti artificiali" (a destra):
 *  - ricerca per nome / numero NORAD
 *  - oggetti in evidenza divisi per categoria, ciascuno attivabile e agganciabile
 *  - cataloghi CelesTrak (nuvole di punti) attivabili
 *  - telemetria in tempo reale dell'oggetto agganciato (riquadro in basso a destra)
 */
import type { ArtificialObjects, ArtificialTelemetry } from '../spacecraft/ArtificialObjects.ts';
import { CATEGORY_INFO, type ArtificialCategory } from '../spacecraft/catalog.ts';
import type { SatelliteGroups } from '../spacecraft/SatelliteGroups.ts';
import type { SmallBodyGroups } from '../spacecraft/SmallBodyGroups.ts';
import {
  escapeHtml, fmt1, fmt2, fmt3, fmtInt, formatDistance, formatDuration, formatFarDistance, formatRate,
} from './format.ts';

export interface ArtificialPanelHandlers {
  onFocus(id: string): void;
  /** Promuove un satellite di un catalogo (id "norad:<n>") e lo aggancia. */
  onFocusNorad(norad: number): void;
  /** Promuove un asteroide di un catalogo SBDB (nome completo JPL) e lo aggancia. */
  onFocusSmallBody(fullName: string, color: string): void;
}

export class ArtificialPanel {
  private readonly objects: ArtificialObjects;
  private readonly groups: SatelliteGroups;
  private readonly smallBodies: SmallBodyGroups | null;
  private readonly handlers: ArtificialPanelHandlers;
  private readonly sbEl: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly groupsEl: HTMLElement;
  private readonly resultsEl: HTMLElement;
  private readonly searchEl: HTMLInputElement;
  private readonly telemetryEl: HTMLElement;
  private focusId = '';
  private clock = Infinity;
  private dirty = true;

  constructor(
    container: HTMLElement,
    objects: ArtificialObjects,
    groups: SatelliteGroups,
    handlers: ArtificialPanelHandlers,
    /** Dove mostrare la telemetria (colonna di sinistra, così non copre la lista). */
    telemetryContainer: HTMLElement = container,
    smallBodies: SmallBodyGroups | null = null,
  ) {
    this.objects = objects;
    this.groups = groups;
    this.smallBodies = smallBodies;
    this.handlers = handlers;

    this.panel = document.createElement('aside');
    this.panel.className = 'art-panel panel';
    this.panel.innerHTML = `
      <header class="art-header">
        <span class="hud-title">Oggetti artificiali e asteroidi</span>
        <button type="button" class="icon-btn" data-ref="collapse" title="Riduci / espandi">–</button>
      </header>
      <div class="art-body">
        <input type="search" data-ref="search" placeholder="Cerca: ISS, Voyager, Apophis, STARLINK-1234, n° NORAD…" />
        <div class="art-results" data-ref="results"></div>
        <div data-ref="list"></div>
        <details class="art-groups" data-ref="groups-wrap">
          <summary>Cataloghi CelesTrak (satelliti e detriti)</summary>
          <div data-ref="groups"></div>
        </details>
        <details class="art-groups" data-ref="sb-wrap">
          <summary>Cataloghi di asteroidi (JPL Small-Body Database)</summary>
          <div data-ref="sbgroups"></div>
        </details>
        <p class="art-note">Dati reali: CelesTrak (elementi GP/TLE, SGP4), JPL Horizons (effemeridi ufficiali e archivio),
        JPL Small-Body Database (asteroidi), NASA DSN Now (collegamenti in tempo reale).</p>
      </div>`;
    container.appendChild(this.panel);

    this.telemetryEl = document.createElement('section');
    this.telemetryEl.className = 'panel art-telemetry';
    this.telemetryEl.hidden = true;
    telemetryContainer.appendChild(this.telemetryEl);

    const q = <T extends Element>(ref: string) => this.panel.querySelector<T>(`[data-ref="${ref}"]`)!;
    this.listEl = q('list');
    this.groupsEl = q('groups');
    this.sbEl = q('sbgroups');
    this.resultsEl = q('results');
    this.searchEl = q('search');
    q<HTMLButtonElement>('collapse').addEventListener('click', (e) => {
      const collapsed = this.panel.classList.toggle('collapsed');
      (e.target as HTMLButtonElement).textContent = collapsed ? '+' : '–';
    });
    this.searchEl.addEventListener('input', () => this.renderResults());
    this.searchEl.addEventListener('keydown', (e) => e.stopPropagation());

    // Delegazione eventi
    this.panel.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.obj) this.objects.setVisible(t.dataset.obj, t.checked);
      else if (t.dataset.group) this.groups.setVisible(t.dataset.group, t.checked);
      else if (t.dataset.sbgroup) this.smallBodies?.setVisible(t.dataset.sbgroup, t.checked);
      else if (t.dataset.cat) {
        for (const o of this.objects.list()) if (o.def.category === t.dataset.cat && !o.transient) this.objects.setVisible(o.def.id, t.checked);
      }
    });
    this.panel.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-focus]');
      if (!b) return;
      e.preventDefault();
      const id = b.dataset.focus!;
      if (id.startsWith('norad:')) this.handlers.onFocusNorad(Number(id.slice(6)));
      else if (id.startsWith('sbname:')) this.handlers.onFocusSmallBody(id.slice(7), b.dataset.color ?? '#d9b48c');
      else {
        this.objects.setVisible(id, true);
        this.handlers.onFocus(id);
      }
      if (b.closest('.art-results')) {
        this.searchEl.value = '';
        this.renderResults();
      }
    });

    const refresh = () => (this.dirty = true);
    objects.onChange = refresh;
    groups.onChange = refresh;
    if (smallBodies) smallBodies.onChange = refresh;
  }

  setFocus(id: string): void {
    this.focusId = id;
    this.clock = Infinity;
    this.dirty = true;
  }

  private statusBadge(status: string, message: string, valid: boolean): string {
    if (status === 'loading') return '<span class="st loading" title="Caricamento">…</span>';
    if (status === 'error') return `<span class="st error" title="${escapeHtml(message)}">!</span>`;
    if (status === 'ready' && !valid && message) return `<span class="st warn" title="${escapeHtml(message)}">?</span>`;
    return '';
  }

  private renderList(): void {
    const cats = Object.keys(CATEGORY_INFO) as ArtificialCategory[];
    const all = this.objects.list();
    const html: string[] = [];
    const transient = all.filter((o) => o.transient);
    if (transient.length) {
      html.push(`<details open class="art-cat"><summary><span class="dot" style="--c:#9ab8d8"></span>Selezionati dai cataloghi</summary><ul>`);
      for (const o of transient) html.push(this.itemHtml(o.def.id, o.def.name, o.visible, o.color, this.statusBadge(o.status, o.message, o.valid)));
      html.push('</ul></details>');
    }
    for (const cat of cats) {
      const items = all.filter((o) => o.def.category === cat && !o.transient);
      if (!items.length) continue;
      const on = items.filter((o) => o.visible).length;
      const info = CATEGORY_INFO[cat];
      html.push(`
        <details class="art-cat" ${on ? 'open' : ''}>
          <summary>
            <input type="checkbox" data-cat="${cat}" ${on === items.length ? 'checked' : ''} title="Tutti / nessuno" />
            <span class="dot" style="--c:${info.color}"></span>${info.label}
            <span class="count">${on}/${items.length}</span>
          </summary>
          <ul>`);
      for (const o of items) html.push(this.itemHtml(o.def.id, o.def.name, o.visible, info.color, this.statusBadge(o.status, o.message, o.valid)));
      html.push('</ul></details>');
    }
    // Mantieni aperti/chiusi i gruppi già aperti dall'utente
    const openState = new Map<string, boolean>();
    this.listEl.querySelectorAll<HTMLDetailsElement>('details.art-cat').forEach((d) => {
      const cat = d.querySelector<HTMLInputElement>('[data-cat]')?.dataset.cat ?? 'transient';
      openState.set(cat, d.open);
    });
    this.listEl.innerHTML = html.join('');
    this.listEl.querySelectorAll<HTMLDetailsElement>('details.art-cat').forEach((d) => {
      const cat = d.querySelector<HTMLInputElement>('[data-cat]')?.dataset.cat ?? 'transient';
      if (openState.has(cat)) d.open = openState.get(cat)!;
      const box = d.querySelector<HTMLInputElement>('[data-cat]');
      if (box) {
        const items = all.filter((o) => o.def.category === cat && !o.transient);
        const on = items.filter((o) => o.visible).length;
        box.indeterminate = on > 0 && on < items.length;
        box.addEventListener('click', (e) => e.stopPropagation());
      }
    });

    const g: string[] = [];
    for (const grp of this.groups.groups.values()) {
      const st = grp.status === 'loading' ? '…' : grp.status === 'error' ? '!' : '';
      g.push(`
        <label class="grp" title="${escapeHtml(grp.message)}">
          <input type="checkbox" data-group="${grp.def.id}" ${grp.visible ? 'checked' : ''} />
          <span class="dot" style="--c:${grp.def.color}"></span>
          <span class="grp-name">${grp.def.label}</span>
          <span class="count ${grp.status === 'error' ? 'err' : ''}">${grp.omms.length ? fmtInt.format(grp.omms.length) : st}</span>
        </label>`);
    }
    this.groupsEl.innerHTML = g.join('');

    const sb: string[] = [];
    for (const grp of this.smallBodies?.groups.values() ?? []) {
      const st = grp.status === 'loading' ? '…' : grp.status === 'error' ? '!' : '';
      sb.push(`
        <label class="grp" title="${escapeHtml(grp.message)}">
          <input type="checkbox" data-sbgroup="${grp.def.id}" ${grp.visible ? 'checked' : ''} />
          <span class="dot" style="--c:${grp.def.color}"></span>
          <span class="grp-name">${grp.def.label}</span>
          <span class="count ${grp.status === 'error' ? 'err' : ''}">${grp.count ? fmtInt.format(grp.count) : st}</span>
        </label>`);
    }
    this.sbEl.innerHTML = sb.join('');
  }

  private itemHtml(id: string, name: string, visible: boolean, color: string, badge: string): string {
    const focused = id === this.focusId ? ' focused' : '';
    return `<li class="${focused}">
      <label><input type="checkbox" data-obj="${id}" ${visible ? 'checked' : ''} /> ${escapeHtml(name)}</label>
      ${badge}
      <button type="button" class="icon-btn" data-focus="${id}" title="Aggancia la camera" style="--c:${color}">◎</button>
    </li>`;
  }

  private renderResults(): void {
    const q = this.searchEl.value.trim().toLowerCase();
    if (q.length < 2) {
      this.resultsEl.innerHTML = '';
      return;
    }
    const featured = this.objects.list().filter((o) => o.def.name.toLowerCase().includes(q)).slice(0, 10);
    const fromGroups = this.groups.search(q, 25);
    const fromSb = this.smallBodies?.search(q, 15) ?? [];
    const rows = [
      ...featured.map((o) => `<button type="button" data-focus="${o.def.id}"><span class="dot" style="--c:${o.color}"></span>${escapeHtml(o.def.name)}<small>${CATEGORY_INFO[o.def.category].label}</small></button>`),
      ...fromGroups.map((r) => `<button type="button" data-focus="norad:${r.omm.NORAD_CAT_ID}"><span class="dot" style="--c:${r.group.def.color}"></span>${escapeHtml(r.omm.OBJECT_NAME)}<small>NORAD ${r.omm.NORAD_CAT_ID} · ${r.group.def.label}</small></button>`),
      ...fromSb.map((r) => `<button type="button" data-focus="sbname:${escapeHtml(r.name)}" data-color="${r.group.def.color}"><span class="dot" style="--c:${r.group.def.color}"></span>${escapeHtml(r.name)}<small>${r.group.def.label}</small></button>`),
    ];
    const loaded = [...this.groups.groups.values()].some((g) => g.omms.length) || [...(this.smallBodies?.groups.values() ?? [])].some((g) => g.count);
    this.resultsEl.innerHTML = rows.length
      ? rows.join('')
      : `<div class="empty">Nessun risultato${loaded ? '' : ' (attiva un catalogo CelesTrak o di asteroidi per cercare fra migliaia di oggetti)'}</div>`;
  }

  update(realDt: number): void {
    if (this.dirty) {
      this.dirty = false;
      this.renderList();
    }
    this.clock += realDt;
    if (this.clock < 0.25) return;
    this.clock = 0;
    this.renderTelemetry();
  }

  private renderTelemetry(): void {
    const o = this.objects.get(this.focusId);
    if (!o) {
      this.telemetryEl.hidden = true;
      return;
    }
    this.telemetryEl.hidden = false;
    const t = this.objects.telemetry(o.def.id);
    const head = `
      <div class="info-name" style="--body-color:${o.color}">${escapeHtml(o.def.name)}</div>
      <div class="art-meta">${escapeHtml(o.def.categoryLabel ?? CATEGORY_INFO[o.def.category].label)}${o.def.operator !== '—' ? ' · ' + escapeHtml(o.def.operator) : ''}${o.def.launch ? ' · lancio ' + o.def.launch : ''}</div>`;
    if (!t) {
      this.telemetryEl.innerHTML = `${head}<p class="art-msg">${escapeHtml(o.message || (o.status === 'loading' ? 'Caricamento dati…' : 'Dati non disponibili a questa data'))}</p>`;
      return;
    }
    this.telemetryEl.innerHTML = `${head}${this.telemetryHtml(t)}`;
  }

  private telemetryHtml(t: ArtificialTelemetry): string {
    const o = t.obj;
    const rows: [string, string][] = [];
    const earthOrbit = o.def.center !== 'sun';
    const lagrange = o.def.category === 'lagrange';
    rows.push(['Riferimento', t.centerName]);
    if (t.altitude !== undefined && !lagrange) rows.push(['Quota', formatDistance(t.altitude)]);
    else if (lagrange) rows.push(['Distanza dal Sole', formatFarDistance(t.distSun)]);
    else rows.push(['Distanza dal Sole', formatFarDistance(t.distSun)]);
    rows.push([earthOrbit ? `Velocità (rel. ${t.centerName})` : 'Velocità eliocentrica', `${fmt3.format((earthOrbit ? t.speed : t.speedSun) / 1000)} km/s`]);
    if (earthOrbit) rows.push(['Distanza dal centro', formatDistance(t.distance)]);
    if (o.def.center !== 'earth' || o.def.category === 'lagrange') rows.push(['Distanza dalla Terra', formatFarDistance(t.distEarth)]);
    rows.push(['Tempo luce dalla Terra', formatDuration(t.lightTime)]);
    if (o.geodetic) {
      const g = o.geodetic;
      rows.push(['Lat / Lon', `${fmt2.format(g.lat)}° ${g.lat >= 0 ? 'N' : 'S'} · ${fmt2.format(Math.abs(g.lon))}° ${g.lon >= 0 ? 'E' : 'O'}`]);
    }
    const orb = t.orbit;
    if (lagrange) {
      rows.push(['Velocità eliocentrica', `${fmt3.format(t.speedSun / 1000)} km/s`]);
    } else if (orb && orb.isBound && earthOrbit) {
      const R = t.distance - (t.altitude ?? 0);
      rows.push(['Perigeo / apogeo', `${formatDistance(orb.periapsis - R)} / ${formatDistance(orb.apoapsis - R)}`]);
      rows.push(['Periodo', formatDuration(t.periodTle ?? orb.period)]);
      if (t.inclinationEq !== undefined) rows.push(['Inclinazione (equatore)', `${fmt2.format(t.inclinationEq)}°`]);
      rows.push(['Eccentricità', fmt3.format(orb.e)]);
    } else if (orb && !earthOrbit) {
      rows.push(['Eccentricità (Sole)', fmt3.format(orb.e)]);
      rows.push([orb.isBound ? 'Orbita' : 'Traiettoria', orb.isBound ? `chiusa · perielio ${formatDistance(orb.periapsis)}` : 'iperbolica: sfugge al Sistema Solare']);
    }
    if (t.dataAge !== undefined) rows.push(['Età elementi TLE', formatDuration(t.dataAge)]);

    const dl = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    if (t.phys) {
      const p = t.phys.phys;
      const v = (k: string) => (p[k] ? `${p[k].value}${p[k].units ? ' ' + p[k].units : ''}` : null);
      if (t.phys.orbitClass) rows.push(['Classe orbitale', escapeHtml(t.phys.orbitClass)]);
      const d = v('diameter');
      if (d) rows.push(['Diametro', escapeHtml(d)]);
      const h = v('H');
      if (h) rows.push(['Magnitudine assoluta H', escapeHtml(h)]);
      const rot = v('rot_per');
      if (rot) rows.push(['Periodo di rotazione', `${escapeHtml(p.rot_per.value)} h`]);
      const alb = v('albedo');
      if (alb) rows.push(['Albedo', escapeHtml(alb)]);
    }
    let dsn = '';
    if (o.def.source.type === 'horizons' && !o.def.sbdb) {
      if (t.dsn.length) {
        const items = t.dsn.map((l) => `
          <li><b>${escapeHtml(l.station)} ${escapeHtml(l.dish)}</b>
            ${l.downRate ? `↓ ${formatRate(l.downRate)}` : ''} ${l.upRate ? `↑ ${formatRate(l.upRate)}` : ''} ${l.band ? `· banda ${escapeHtml(l.band)}` : ''}
            ${l.rangeKm ? `<br/>distanza misurata ${fmtInt.format(l.rangeKm)} km` : ''}${l.rtlt ? ` · andata/ritorno ${formatDuration(l.rtlt)}` : ''}
            ${l.downPower !== undefined ? `<br/>potenza ricevuta ${fmt1.format(l.downPower)} dBm` : ''}</li>`).join('');
        dsn = `<div class="dsn on"><div class="dsn-title">● Deep Space Network — contatto in corso (LIVE)</div><ul>${items}</ul></div>`;
      } else if (this.objects.dsn) {
        dsn = `<div class="dsn"><div class="dsn-title">Deep Space Network: nessun contatto in questo momento</div></div>`;
      }
    }
    const warn = o.message ? `<p class="art-msg">${escapeHtml(o.message)}</p>` : '';
    return `<dl>${dl}</dl>${dsn}${warn}<p class="art-src">${escapeHtml(t.source)}</p><p class="art-note">${escapeHtml(o.def.note)}</p>`;
  }
}
