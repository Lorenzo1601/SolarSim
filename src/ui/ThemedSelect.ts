/**
 * Menu a tendina con lo stile dell'interfaccia (sfondo scuro, bordo sottile, evidenziazione blu).
 *
 * Le tendine native del browser aprono un elenco bianco di sistema (su Windows in particolare) che
 * non segue il tema. Qui il <select> originale resta nel DOM (nascosto) come fonte di verità:
 * valore, opzioni ed eventi `change` funzionano come prima; sopra viene disegnato un pulsante e,
 * all'apertura, un elenco nello stesso stile dei pannelli.
 */

const themed = new Set<{ sel: HTMLSelectElement; label: HTMLSpanElement; btn: HTMLButtonElement }>();
let openList: { close: () => void } | null = null;

function optionText(sel: HTMLSelectElement): string {
  const o = sel.selectedOptions[0] ?? sel.options[sel.selectedIndex];
  return o ? o.textContent ?? '' : '—';
}

export function themeSelect(sel: HTMLSelectElement): void {
  if (sel.dataset.themed) return;
  sel.dataset.themed = '1';
  const wrap = document.createElement('span');
  wrap.className = 'tsel';
  sel.parentNode?.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('tsel-native');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tsel-btn';
  const label = document.createElement('span');
  label.className = 'tsel-label';
  label.textContent = optionText(sel);
  const caret = document.createElement('span');
  caret.className = 'tsel-caret';
  caret.setAttribute('aria-hidden', 'true');
  btn.append(label, caret);
  wrap.appendChild(btn);
  const entry = { sel, label, btn };
  themed.add(entry);

  const choose = (value: string) => {
    if (sel.value !== value) {
      sel.value = value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    label.textContent = optionText(sel);
  };

  const open = () => {
    openList?.close();
    const list = document.createElement('div');
    list.className = 'tsel-list';
    list.setAttribute('role', 'listbox');
    const items: HTMLDivElement[] = [];
    const addOption = (o: HTMLOptionElement, indent: boolean) => {
      const it = document.createElement('div');
      it.className = 'tsel-item' + (indent ? ' indent' : '') + (o.value === sel.value ? ' selected' : '') + (o.disabled ? ' disabled' : '');
      it.textContent = o.textContent;
      it.dataset.value = o.value;
      if (!o.disabled) {
        it.addEventListener('pointerdown', (e) => e.preventDefault());
        it.addEventListener('click', () => {
          choose(o.value);
          close();
          btn.focus();
        });
      }
      list.appendChild(it);
      items.push(it);
    };
    for (const child of Array.from(sel.children)) {
      if (child instanceof HTMLOptGroupElement) {
        const h = document.createElement('div');
        h.className = 'tsel-group';
        h.textContent = child.label;
        list.appendChild(h);
        for (const o of Array.from(child.children)) if (o instanceof HTMLOptionElement) addOption(o, true);
      } else if (child instanceof HTMLOptionElement) addOption(child, false);
    }
    document.body.appendChild(list);

    // posizione: sotto il pulsante (o sopra se non c'è spazio), larga almeno quanto il pulsante
    const r = btn.getBoundingClientRect();
    list.style.minWidth = `${r.width}px`;
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const spaceAbove = r.top - 8;
    const h = Math.min(list.scrollHeight, 320);
    if (spaceBelow >= Math.min(h, 200) || spaceBelow >= spaceAbove) {
      list.style.top = `${r.bottom + 2}px`;
      list.style.maxHeight = `${Math.max(120, Math.min(320, spaceBelow))}px`;
    } else {
      list.style.top = `${Math.max(8, r.top - 2 - Math.min(h, spaceAbove))}px`;
      list.style.maxHeight = `${Math.max(120, Math.min(320, spaceAbove))}px`;
    }
    list.style.left = `${Math.min(r.left, window.innerWidth - Math.max(r.width, list.offsetWidth) - 8)}px`;

    let active = items.findIndex((i) => i.classList.contains('selected'));
    const highlight = (k: number) => {
      items.forEach((i, j) => i.classList.toggle('active', j === k));
      items[k]?.scrollIntoView({ block: 'nearest' });
    };
    highlight(active);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        btn.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        let k = active;
        do k = Math.max(0, Math.min(items.length - 1, k + step));
        while (items[k]?.classList.contains('disabled') && k > 0 && k < items.length - 1);
        active = k;
        highlight(active);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const it = items[active];
        if (it && !it.classList.contains('disabled')) choose(it.dataset.value ?? '');
        close();
        btn.focus();
      } else if (e.key.length === 1) {
        // ricerca per iniziale
        const k = items.findIndex((i, j) => j > active && (i.textContent ?? '').toLowerCase().startsWith(e.key.toLowerCase()));
        const k2 = k >= 0 ? k : items.findIndex((i) => (i.textContent ?? '').toLowerCase().startsWith(e.key.toLowerCase()));
        if (k2 >= 0) {
          active = k2;
          highlight(active);
        }
      }
      e.stopPropagation();
    };
    const onDown = (e: PointerEvent) => {
      if (!list.contains(e.target as Node) && e.target !== btn && !btn.contains(e.target as Node)) close();
    };
    const onScroll = (e: Event) => {
      if (!list.contains(e.target as Node)) close();
    };
    function close() {
      list.remove();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      wrap.classList.remove('open');
      if (openList?.close === close) openList = null;
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    wrap.classList.add('open');
    openList = { close };
  };

  btn.addEventListener('click', () => {
    if (wrap.classList.contains('open')) openList?.close();
    else if (!sel.disabled) open();
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (!wrap.classList.contains('open')) open();
    }
  });
  sel.addEventListener('change', () => (label.textContent = optionText(sel)));
}

/** Applica lo stile a tutte le tendine dentro `root`. */
export function themeAllSelects(root: ParentNode): void {
  root.querySelectorAll('select').forEach((s) => themeSelect(s as HTMLSelectElement));
}

// Il valore può essere cambiato dal codice (sel.value = …, opzioni rigenerate) senza eventi:
// l'etichetta dei pulsanti viene riallineata periodicamente.
setInterval(() => {
  for (const e of themed) {
    if (!e.sel.isConnected) {
      themed.delete(e);
      continue;
    }
    const t = optionText(e.sel);
    if (e.label.textContent !== t) e.label.textContent = t;
    e.btn.disabled = e.sel.disabled;
  }
}, 300);
