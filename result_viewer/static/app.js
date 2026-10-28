/* result-viewer page: flip through per-unit figures, keep notes per session.
 *
 * The server owns the data (catalog + notebook JSON in the data dir); this page keeps
 * a copy of the open session's notebook, applies edits optimistically and sends
 * them one at a time (POST /api/note), retrying while the network is away. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const TAG_COLORS = ['#2f6fde', '#d9480f', '#7c3aed', '#0f8a7e', '#c2255c', '#5f6b7a', '#a16207', '#2b8a3e', '#c92a2a'];
  const Q_ORDER = ['sua', 'mua', 'noise'];
  const EG_DEFAULT_Q = ['sua', 'mua'];

  function noFilters() { return {q: [], area: [], tags: [], flagged: false, noted: false, fullStable: false}; }

  /* Sort keys: `desc` is the natural direction (highest rate first); S.sort.dir = -1 reverses it.
   * Units without a value (no stability table, or not in the current units) always sort last. */
  const fmtRate = v => (v == null ? '–' : v >= 10 ? v.toFixed(0) : v.toFixed(1));
  const SORTS = {
    id: {label: 'Unit #', value: u => u.id, desc: false, cell: () => ''},
    rate: {label: 'Rate', value: u => u.rate_hz, desc: true,
           cell: u => (u.rate_hz == null ? '' : `${fmtRate(u.rate_hz)}<small> Hz</small>`), tip: 'session mean firing rate'},
    stable: {label: 'Stable trials', value: u => u.n_stable, desc: true,
             cell: u => (u.n_stable == null ? '' : `${u.n_stable}<small>/${u.n_trials}</small>`), tip: 'trials in the stable block'},
  };

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('rv.' + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem('rv.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };

  const S = {
    config: null, sessions: [], sid: null, session: null, units: [], byId: new Map(),
    notebook: {units: {}}, mtime: null, conflicts: [], files: {},
    filtered: [], cur: null, view: store.get('view', 'raster'), zoom: false,
    filters: Object.assign(noFilters(), store.get('filters', {})),
    sort: Object.assign({key: 'id', dir: 1}, store.get('sort', {})), sorted: [],
    eg: {url: '', running: false},
  };

  // ------------------------------------------------------------------ utils
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const entry = id => (id == null ? null : S.notebook.units[String(id)] || null);
  const tagColor = t => { const i = S.config.tags.indexOf(t); return i < 0 ? '#8a8a90' : TAG_COLORS[i % TAG_COLORS.length]; };
  const upper = s => (s ? String(s).toUpperCase() : '');
  const viewLabel = kind => { const v = S.session && S.session.views.find(x => x.kind === kind); return v ? v.label : kind; };
  const qRank = q => { const i = Q_ORDER.indexOf(q); return i < 0 ? Q_ORDER.length : i; };
  const prettySid = sid => { const m = /^sub-([^_]+)_ses-(\d{4})_(\d\d)_(\d\d)/.exec(sid); return m ? `${m[1]} ${m[2]}-${m[3]}-${m[4]}` : sid; };

  async function api(path, opts = {}) {
    const r = await fetch(path, Object.assign({headers: {'Content-Type': 'application/json'}, cache: 'no-store'}, opts));
    let body = null;
    try { body = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok) {
      const err = new Error((body && body.error) || `${r.status} ${r.statusText}`);
      err.status = r.status;
      throw err;
    }
    return body;
  }

  let toastTimer = null;
  function toast(text, ms = 2200, html = false) {
    const t = $('toast');
    if (html) t.innerHTML = text; else t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function fatal(message) {
    $('title').textContent = 'Nothing to show';
    $('img').hidden = true;
    const m = $('figMsg'); m.hidden = false; m.textContent = message;
  }

  // ------------------------------------------------------------------- boot
  async function boot() {
    try {
      S.config = await api('/api/config');
    } catch (e) {
      fatal(`Cannot reach the viewer server (${e.message}).`);
      return;
    }
    if (store.get('focus', false)) document.body.classList.add('focus');
    if (isPhone()) noteBox.placeholder = 'Note for this unit…';
    renderTagButtons();
    $('helpPaths').innerHTML = `Notes: <code>${esc(S.config.paths.notes)}</code><br>Results: ${S.config.roots.map(r => `<code>${esc(r)}</code>`).join(', ')}<br>v${esc(S.config.version)} on ${esc(S.config.host)}`;
    S.eg.url = S.config.electro_gui.url;
    renderEg();
    let sessions;
    try {
      sessions = (await api('/api/sessions')).sessions;
    } catch (e) {
      fatal(`Cannot list sessions (${e.message}).`);
      return;
    }
    S.sessions = sessions;
    renderSessionSelect();
    if (!sessions.length) {
      fatal(`No results found under ${S.config.roots.join(' or ')}. Is the drive mounted?`);
      return;
    }
    const h = parseHash();
    const known = sid => sid && sessions.some(s => s.id === sid);
    const sid = known(h.s) ? h.s : known(store.get('session')) ? store.get('session') : sessions[sessions.length - 1].id;
    await openSession(sid, h.u, h.v);
    egLoop(true);
    setInterval(poll, 15000);
  }

  function parseHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const u = p.get('u');
    return {s: p.get('s'), u: u != null && u !== '' && Number.isFinite(Number(u)) ? Number(u) : null, v: p.get('v')};
  }

  function writeHash() {
    if (!S.sid) return;
    const p = new URLSearchParams({s: S.sid, u: S.cur == null ? '' : S.cur, v: S.view});
    history.replaceState(null, '', '#' + p.toString());
  }

  async function openSession(sid, unitId = null, view = null) {
    flushNote();
    $('title').textContent = `Loading ${prettySid(sid)}…`;
    let data;
    try {
      data = await api('/api/session?sid=' + encodeURIComponent(sid));
    } catch (e) {
      toast(`Cannot open ${sid}: ${e.message}`, 5000);
      if (S.sid) $('session').value = S.sid;
      return;
    }
    S.sid = sid;
    S.session = data.session;
    S.units = data.session.units;
    S.byId = new Map(S.units.map(u => [u.id, u]));
    S.notebook = data.notebook || {units: {}};
    S.mtime = data.mtime;
    S.conflicts = data.conflicts || [];
    S.files = data.files || {};
    store.set('session', sid);
    $('session').value = sid;
    if (view) S.view = view;
    if (!S.session.views.some(v => v.kind === S.view)) S.view = 'raster';
    computeFiltered();
    let target = unitId != null && S.byId.has(unitId) ? unitId : store.get('last.' + sid, null);
    if (target == null || !S.byId.has(target)) target = S.filtered.length ? S.filtered[0] : (S.units.length ? S.units[0].id : null);
    S.cur = null;
    renderFilters();
    renderSort();
    renderList();
    renderNoted();
    renderConflicts();
    renderFiles();
    if (target == null) { fatal(`${sid} has no unit rasters.`); return; }
    go(target);
  }

  // ---------------------------------------------------------------- filters
  function matches(u) {
    const f = S.filters, e = entry(u.id);
    if (f.q.length && !f.q.includes(u.quality)) return false;
    if (f.area.length && !f.area.includes(u.area)) return false;
    if (f.flagged && !(e && e.flag)) return false;
    if (f.noted && !e) return false;
    if (f.tags.length && !(e && (e.tags || []).some(t => f.tags.includes(t)))) return false;
    if (f.fullStable && !u.full_stable) return false;
    return true;
  }

  function sortUnits() {
    const s = SORTS[S.sort.key] || SORTS.id;
    const sign = (s.desc ? -1 : 1) * (S.sort.dir < 0 ? -1 : 1);
    S.sorted = S.units.slice().sort((a, b) => {
      const va = s.value(a), vb = s.value(b);
      if (va == null || vb == null) return va == null && vb == null ? a.id - b.id : va == null ? 1 : -1;
      return (va - vb) * sign || a.id - b.id;
    }).map(u => u.id);
  }

  /** The units to step through: every unit in sort order, then the filters. */
  function computeFiltered() {
    sortUnits();
    S.filtered = S.sorted.filter(id => matches(S.byId.get(id)));
  }
  const anyFilter = () => { const f = S.filters; return f.q.length || f.area.length || f.tags.length || f.flagged || f.noted || f.fullStable; };
  const hasStability = () => S.units.some(u => u.n_trials != null);

  /** The first unit matching the filters after (d > 0) or before (d < 0) the current one, in sort order. */
  function nearestFiltered(d) {
    const keep = new Set(S.filtered);
    let i = S.sorted.indexOf(S.cur);
    if (i < 0) return S.filtered.length ? S.filtered[d > 0 ? 0 : S.filtered.length - 1] : null;
    for (i += d; i >= 0 && i < S.sorted.length; i += d) if (keep.has(S.sorted[i])) return S.sorted[i];
    return null;
  }

  function renderFilters() {
    const uniq = xs => Array.from(new Set(xs.filter(Boolean)));
    const qs = uniq(S.units.map(u => u.quality)).sort((a, b) => qRank(a) - qRank(b) || a.localeCompare(b));
    const areas = uniq(S.units.map(u => u.area)).sort();
    const chip = (group, value, label) => `<button class="chip" data-f="${group}" data-v="${esc(value)}" aria-pressed="${S.filters[group].includes(value)}">${label}</button>`;
    const bool = (key, label, tip) => `<button class="chip" data-b="${key}" aria-pressed="${!!S.filters[key]}"${tip ? ` title="${esc(tip)}"` : ''}>${label}</button>`;
    let html = qs.map(q => chip('q', q, esc(upper(q)))).join('');
    if (hasStability()) {
      const n = (S.units.find(u => u.n_trials != null) || {}).n_trials;
      html += bool('fullStable', 'full-session stable', `Only units stable on all ${n} completed trials (stability_per_unit.csv)`);
    }
    if (areas.length > 1) html += '<span class="sep"></span>' + areas.map(a => chip('area', a, esc(upper(a)))).join('');
    html += '<span class="sep"></span>' + bool('flagged', '★ flagged') + bool('noted', '✎ noted');
    html += '<span class="sep"></span>' + S.config.tags.map(t => chip('tags', t, `<span class="tdot" style="--c:${tagColor(t)}"></span>${esc(t)}`)).join('');
    if (anyFilter()) html += '<button class="chip clear" data-clear="1">clear filters</button>';
    $('filters').innerHTML = html;
  }

  function filtersChanged() {
    store.set('filters', S.filters);
    computeFiltered();
    renderFilters();
    renderList();
    if (S.filtered.length && !S.filtered.includes(S.cur)) {
      const next = nearestFiltered(1);
      go(next != null ? next : S.filtered[S.filtered.length - 1]);
    } else {
      renderPos();
      preload();
    }
  }

  function renderSort() {
    const enabled = hasStability();
    $('sortBar').innerHTML = '<span class="lbl">Sort</span><span class="seg">' + Object.entries(SORTS).map(([key, s]) => {
      const on = S.sort.key === key;
      const descending = s.desc !== (S.sort.dir < 0);
      const tip = key === 'id' ? 'Unit id (s cycles the sort, S reverses it)' : `${s.tip}${enabled ? '' : ' (no stability table in this session)'}`;
      return `<button type="button" data-sort="${key}" aria-pressed="${on}"${key !== 'id' && !enabled ? ' disabled' : ''} title="${esc(tip)}">` +
        `${esc(s.label)}${on ? `<span class="dir">${descending ? '▼' : '▲'}</span>` : ''}</button>`;
    }).join('') + '</span>';
  }

  function setSort(key, dir) {
    if (!SORTS[key] || (key !== 'id' && !hasStability())) return;
    S.sort = {key, dir: dir === -1 ? -1 : 1};
    store.set('sort', S.sort);
    computeFiltered();
    renderSort();
    renderList();
    renderPos();
    preload();
    if (document.body.classList.contains('focus')) toast(`Sorted by ${SORTS[key].label.toLowerCase()}${S.sort.dir < 0 ? ', reversed' : ''}`, 1200);
  }

  function cycleSort() {
    const keys = Object.keys(SORTS).filter(k => k === 'id' || hasStability());
    setSort(keys[(keys.indexOf(S.sort.key) + 1) % keys.length], 1);
  }

  $('sortBar').addEventListener('click', e => {
    const b = e.target.closest('button[data-sort]');
    if (!b || b.disabled) return;
    const key = b.dataset.sort;
    setSort(key, key === S.sort.key ? -S.sort.dir : 1);  // clicking the active sort reverses it
  });

  $('filters').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.clear) {
      S.filters = noFilters();
    } else if (b.dataset.b) {
      S.filters[b.dataset.b] = !S.filters[b.dataset.b];
    } else if (b.dataset.f) {
      const list = S.filters[b.dataset.f], v = b.dataset.v, i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1); else list.push(v);
    }
    filtersChanged();
  });

  // ------------------------------------------------------------------ lists
  function marks(e) {
    if (!e) return '';
    let html = (e.tags || []).map(t => `<span class="tdot" style="--c:${tagColor(t)}" title="${esc(t)}"></span>`).join('');
    if ((e.note || '').trim()) html += '<span class="mnote" title="has a note">✎</span>';
    if (e.flag) html += '<span class="mstar" title="flagged">★</span>';
    return html;
  }

  function renderList() {
    const cell = (SORTS[S.sort.key] || SORTS.id).cell;
    const rows = S.filtered.map(id => {
      const u = S.byId.get(id);
      const cls = [id === S.cur ? 'cur' : '', u.in_units === false ? 'gone' : ''].filter(Boolean).join(' ');
      const tip = u.in_units === false ? ' title="Not in the current units table (a figure from an older build)"' : '';
      return `<li data-id="${id}"${cls ? ` class="${cls}"` : ''}${tip}><span class="uid">${id}</span>` +
        `<span class="q ${esc(u.quality)}">${esc(upper(u.quality))}</span><span class="ar">${esc(upper(u.area))}</span>` +
        `<span class="sv">${cell(u)}</span><span class="marks">${marks(entry(id))}</span></li>`;
    });
    $('unitList').innerHTML = rows.join('') || '<li class="muted" style="display:block">No unit matches these filters.</li>';
    const total = S.units.length, n = S.filtered.length;
    $('count').textContent = n === total ? `${total} units` : `${n} of ${total} units`;
    highlight();
  }

  function highlight() {
    for (const el of document.querySelectorAll('#unitList li.cur, #noted li.cur')) el.classList.remove('cur');
    const row = document.querySelector(`#unitList li[data-id="${S.cur}"]`);
    if (row) { row.classList.add('cur'); row.scrollIntoView({block: 'nearest'}); }
    const nrow = document.querySelector(`#noted li[data-id="${S.cur}"]`);
    if (nrow) nrow.classList.add('cur');
  }

  function renderNoted() {
    const ids = Object.keys(S.notebook.units).map(Number).sort((a, b) => a - b);
    $('nbTitle').textContent = `Notebook · ${ids.length} unit${ids.length === 1 ? '' : 's'}`;
    const items = ids.map(id => {
      const e = S.notebook.units[String(id)], u = S.byId.get(id);
      const q = u ? u.quality : e.quality;
      const first = (e.note || '').trim().split('\n')[0];
      const tags = (e.tags || []).map(t => `<span class="tdot" style="--c:${tagColor(t)}"></span>${esc(t)}`).join(' ');
      return `<li data-id="${id}"${id === S.cur ? ' class="cur"' : ''}><div class="nh">${e.flag ? '<span class="mstar">★</span>' : ''}` +
        `<b>Unit ${id}</b><span class="q ${esc(q)}">${esc(upper(q))}</span><span class="small">${tags}</span></div>` +
        (first ? `<div class="snip">${esc(first)}</div>` : '') + '</li>';
    });
    $('noted').innerHTML = items.join('') || (isPhone()
      ? '<li class="empty small">No notes in this session yet. Tap a tag or Flag, or write in the box above.</li>'
      : `<li class="empty small">No notes in this session yet. Write in the box, press 1–${S.config.tags.length} to tag, f to flag.</li>`);
    const opt = $('session').querySelector(`option[value="${CSS.escape(S.sid)}"]`);
    const info = S.sessions.find(s => s.id === S.sid);
    if (opt && info) { info.noted = ids.length; opt.textContent = sessionLabel(info); }
  }

  function sessionLabel(s) { return `${prettySid(s.id)} · ${s.n_units} units${s.noted ? ` · ${s.noted} noted` : ''}`; }

  function renderSessionSelect() {
    $('session').innerHTML = S.sessions.map(s => `<option value="${esc(s.id)}">${esc(sessionLabel(s))}</option>`).join('');
  }

  function renderConflicts() {
    const c = $('conflicts');
    c.hidden = !S.conflicts.length;
    if (S.conflicts.length) {
      c.innerHTML = `Dropbox made a conflicted copy of this notebook: ${S.conflicts.map(n => `<code>${esc(n)}</code>`).join(', ')}. ` +
        'The viewer shows only the main file; merge the copy by hand, then delete it.';
    }
  }

  function renderFiles() {
    const f = S.files;
    if (!f.markdown) { $('files').textContent = ''; return; }
    $('files').innerHTML = `Notebook: <code>${esc(f.markdown)}</code> <button data-copy="${esc(f.markdown)}">copy path</button><br>` +
      `electro_gui configs: <code>${esc(f.configs)}</code>`;
  }

  $('files').addEventListener('click', async e => {
    const b = e.target.closest('button[data-copy]');
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Path copied'); } catch (err) { toast('Copy failed'); }
  });

  $('unitList').addEventListener('click', e => {
    const li = e.target.closest('li[data-id]');
    if (li) { go(Number(li.dataset.id)); closeDrawer(); }
  });

  $('noted').addEventListener('click', e => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const id = Number(li.dataset.id);
    if (S.byId.has(id)) go(id);
    else toast(`Unit ${id} is not in the current results (it may have been re-sorted).`, 4000);
  });

  // -------------------------------------------------------------- the unit
  function go(id) {
    if (id == null || !S.byId.has(id)) return;
    if (S.cur !== id) flushNote();
    const changed = S.cur !== id;
    S.cur = id;
    store.set('last.' + S.sid, id);
    writeHash();
    renderUnit(changed);
  }

  function step(d) {
    const ids = S.filtered;
    if (!ids.length) { toast('No unit matches the filters'); return; }
    const i = ids.indexOf(S.cur);
    if (i < 0) {  // the current unit is outside the filters: go to the nearest one that matches
      const j = nearestFiltered(d);
      if (j == null) { toast(d > 0 ? 'No matching unit after this one' : 'No matching unit before this one'); return; }
      go(j);
      return;
    }
    const j = i + d;
    if (j < 0) { toast('First unit · { for the previous session'); return; }
    if (j >= ids.length) { toast('Last unit · } for the next session'); return; }
    go(ids[j]);
  }

  function edge(which) { if (S.filtered.length) go(which === 0 ? S.filtered[0] : S.filtered[S.filtered.length - 1]); }

  function renderPos() {
    const i = S.filtered.indexOf(S.cur);
    $('pos').textContent = `${i >= 0 ? i + 1 : '–'} / ${S.filtered.length}`;
    $('pos').title = S.filtered.length === S.units.length ? `${S.units.length} units` : `${S.filtered.length} of ${S.units.length} units match the filters`;
  }

  function renderUnit(changed) {
    const u = S.byId.get(S.cur);
    const bits = [`Unit ${u.id}`, upper(u.quality), upper(u.area)];
    if (u.peak_channel != null) bits.push(`ch ${u.peak_channel}`);
    if (u.depth_um != null) bits.push(`${u.depth_um} µm`);
    $('title').textContent = bits.filter(Boolean).join(' · ');
    document.title = `Unit ${u.id} · ${prettySid(S.sid)}`;
    renderBadges();
    renderViews();
    showFigure();
    renderNoteEditor(changed);
    renderTagState();
    renderPos();
    highlight();
  }

  function renderBadges() {
    const u = S.byId.get(S.cur);
    const fig = u.figures[S.view];
    let html = '';
    if (u.in_units === false) html += '<span class="badge warn" title="The session\'s current units table (stability_per_unit.csv, same build as the NWB) has no such unit">not in the current units</span>';
    if (u.n_trials != null) {
      html += `<span class="badge${u.full_stable ? ' ok' : ''}" title="stability_per_unit.csv: session mean rate; trials in the stable block of ${u.n_trials} completed">` +
        `${fmtRate(u.rate_hz)} Hz · ${u.full_stable ? `stable on all ${u.n_trials} trials` : `stable ${u.n_stable}/${u.n_trials} trials`}</span>`;
    }
    if (u.relabelled_from && u.relabelled_from.length) html += `<span class="badge" title="Older rasters with other labels exist">relabelled · was ${esc(u.relabelled_from.map(upper).join(', '))}</span>`;
    if (fig && fig.label_in_figure) html += `<span class="badge warn" title="${esc(fig.name)}">this figure predates the relabel (labelled ${esc(upper(fig.label_in_figure))})</span>`;
    $('badges').innerHTML = html;
  }

  function renderViews() {
    const u = S.byId.get(S.cur);
    $('views').innerHTML = S.session.views.map(v => {
      const has = u && u.figures[v.kind];
      return `<button class="view${has ? '' : ' missing'}" data-kind="${esc(v.kind)}" aria-current="${v.kind === S.view}" title="${esc(v.label)}${has ? '' : ' (none for this unit)'}">${esc(v.label)}</button>`;
    }).join('');
    const cur = $('views').querySelector('[aria-current="true"]');
    if (cur) cur.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }

  $('views').addEventListener('click', e => {
    const b = e.target.closest('button[data-kind]');
    if (b) setView(b.dataset.kind);
  });

  function setView(kind) {
    if (!S.session || !S.session.views.some(v => v.kind === kind) || kind === S.view) return;
    S.view = kind;
    store.set('view', kind);
    writeHash();
    renderBadges();
    renderViews();
    showFigure();
  }

  function cycleView(d) {
    const kinds = S.session.views.map(v => v.kind);
    const i = kinds.indexOf(S.view);
    setView(kinds[(i + d + kinds.length) % kinds.length]);
  }

  function cycleSession(d) {
    const i = S.sessions.findIndex(s => s.id === S.sid);
    const j = i + d;
    if (j < 0 || j >= S.sessions.length) { toast(d > 0 ? 'Last session' : 'First session'); return; }
    openSession(S.sessions[j].id, null, S.view);
  }

  // ---------------------------------------------------------------- figure
  const imgCache = new Map();
  function getImg(url) {
    let im = imgCache.get(url);
    if (im) { imgCache.delete(url); imgCache.set(url, im); return im; }
    im = new Image();
    im.decoding = 'async';
    im.src = url;
    imgCache.set(url, im);
    while (imgCache.size > 24) imgCache.delete(imgCache.keys().next().value);
    return im;
  }

  let figSeq = 0, spinTimer = null;
  function spinner(on) { clearTimeout(spinTimer); if (on) spinTimer = setTimeout(() => { $('spinner').hidden = false; }, 250); else $('spinner').hidden = true; }

  async function showFigure() {
    const u = S.byId.get(S.cur), fig = u && u.figures[S.view];
    const img = $('img'), msg = $('figMsg'), box = $('figure');
    const mine = ++figSeq;
    if (!fig) {
      img.hidden = true; img.removeAttribute('src');
      msg.hidden = false; msg.textContent = `No “${viewLabel(S.view)}” figure for unit ${u ? u.id : ''}. ] / [ for another figure, r for the raster.`;
      box.classList.remove('loading'); spinner(false);
      preload();
      return;
    }
    const pre = getImg(fig.url);
    if (!pre.complete) { box.classList.add('loading'); spinner(true); }
    try {
      await pre.decode();
    } catch (e) {
      if (mine !== figSeq) return;
      if (!pre.naturalWidth) {
        imgCache.delete(fig.url);
        img.hidden = true;
        msg.hidden = false; msg.textContent = `Could not load ${fig.name}. Is the results drive still mounted?`;
        box.classList.remove('loading'); spinner(false);
        return;
      }
    }
    if (mine !== figSeq) return;
    img.src = fig.url;
    img.alt = `${viewLabel(S.view)} · unit ${u.id}`;
    img.hidden = false; msg.hidden = true;
    box.classList.remove('loading'); spinner(false);
    preload();
  }

  function preload() {
    const ids = S.filtered, i = ids.indexOf(S.cur);
    if (i < 0) return;
    for (const d of [1, 2, 3, -1]) {
      const id = ids[i + d];
      const f = id != null && S.byId.get(id).figures[S.view];
      if (f) getImg(f.url);
    }
  }

  // zoom: click/tap toggles fit <-> natural size; drag with the mouse to pan
  let suppressClick = false, drag = null, touch = null;
  function toggleZoom(force, ev) {
    const box = $('figure'), img = $('img');
    const on = force == null ? !S.zoom : !!force;
    if (on === S.zoom || img.hidden) return;
    let fx = 0.5, fy = 0.5;
    if (ev && ev.clientX != null) {
      const r = img.getBoundingClientRect();
      fx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      fy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
    }
    S.zoom = on;
    box.classList.toggle('zoom', on);
    if (on) {
      requestAnimationFrame(() => {
        box.scrollLeft = img.offsetLeft + fx * img.offsetWidth - box.clientWidth / 2;
        box.scrollTop = img.offsetTop + fy * img.offsetHeight - box.clientHeight / 2;
      });
    }
  }

  // on #figure, not #img: while zoomed the pan below captures the pointer, so the click lands on #figure
  const box = $('figure');
  box.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    if (S.zoom) toggleZoom(false);
    else if (e.target === $('img')) toggleZoom(true, e);
  });

  box.addEventListener('pointerdown', e => {
    suppressClick = false;
    if (!S.zoom || e.pointerType !== 'mouse' || e.button !== 0) return;
    drag = {x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop, moved: false};
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; box.classList.add('dragging'); }
    box.scrollLeft = drag.left - dx;
    box.scrollTop = drag.top - dy;
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) suppressClick = true;
    drag = null;
    box.classList.remove('dragging');
  };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);

  // swipe left/right on the figure (fit mode, page not pinch-zoomed) to flip units
  box.addEventListener('touchstart', e => {
    const pinched = window.visualViewport && window.visualViewport.scale > 1.05;
    if (e.touches.length !== 1 || S.zoom || pinched) { touch = null; return; }
    touch = {x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now()};
  }, {passive: true});
  box.addEventListener('touchend', e => {
    if (!touch) return;
    const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y, dt = Date.now() - touch.at;
    touch = null;
    if (dt < 800 && Math.abs(dx) > 50 && Math.abs(dx) > 1.6 * Math.abs(dy)) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 450);
      step(dx < 0 ? 1 : -1);
    }
  }, {passive: true});
  box.addEventListener('touchcancel', () => { touch = null; }, {passive: true});

  $('edgePrev').addEventListener('click', () => step(-1));
  $('edgeNext').addEventListener('click', () => step(1));
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));

  // ----------------------------------------------------------------- notes
  let dirty = null, noteTimer = null, pending = 0, chain = Promise.resolve();
  const noteBox = $('note');
  const editingHere = () => document.activeElement === noteBox || (dirty && dirty.sid === S.sid && dirty.unit === S.cur);

  function renderNoteEditor(force) {
    if (!force && editingHere()) return;
    const e = entry(S.cur);
    noteBox.value = e ? e.note || '' : '';
  }

  function renderTagButtons() {
    $('tagBtns').innerHTML = S.config.tags.map((t, i) =>
      `<button class="tag" data-i="${i}" aria-pressed="false" style="--c:${tagColor(t)}" title="Toggle “${esc(t)}” (${i + 1})">` +
      `<span class="tdot"></span><span class="tname">${esc(t)}</span><kbd>${i + 1}</kbd></button>`).join('');
  }

  function renderTagState() {
    const e = entry(S.cur), tags = (e && e.tags) || [];
    for (const b of document.querySelectorAll('#tagBtns .tag')) b.setAttribute('aria-pressed', String(tags.includes(S.config.tags[Number(b.dataset.i)])));
    const flagged = !!(e && e.flag);
    $('flag').setAttribute('aria-pressed', String(flagged));
    $('flag').querySelector('.star').textContent = flagged ? '★' : '☆';
  }

  function setSave(state, detail) {
    const el = $('saveState');
    el.classList.toggle('err', state === 'error' || state === 'retry');
    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    el.textContent = {editing: 'Editing…', saving: 'Saving…', saved: `Saved ${time}`, retry: 'Offline · retrying…', error: `Not saved: ${detail || ''}`}[state] || '';
    if (state === 'saved' && detail) { el.textContent += ' · ' + detail; el.classList.add('err'); }
  }

  /** Apply changes to the local copy right away; the server's answer replaces it once nothing is queued. */
  function optimistic(sid, unit, changes) {
    if (sid !== S.sid) return;
    const key = String(unit);
    const next = Object.assign({unit_id: unit, note: '', tags: [], flag: false}, S.notebook.units[key] || {}, changes);
    if (!(next.note || '').trim() && !(next.tags || []).length && !next.flag) delete S.notebook.units[key];
    else S.notebook.units[key] = next;
    notebookChanged();
  }

  function notebookChanged() {
    computeFiltered();
    renderList();
    renderNoted();
    renderTagState();
    renderPos();
  }

  function save(sid, unit, changes, keepalive = false) {
    pending++;
    setSave('saving');
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await api('/api/note', {method: 'POST', keepalive, body: JSON.stringify(Object.assign({sid, unit}, changes))});
          pending--;
          if (!pending && sid === S.sid) {
            S.notebook = r.notebook;
            S.mtime = r.mtime;
            notebookChanged();
            renderNoteEditor(false);
          }
          setSave(pending ? 'saving' : 'saved', r.warning);
          return r;
        } catch (e) {
          if (e.status && e.status < 500) { pending--; setSave('error', e.message); toast(`Not saved: ${e.message}`, 5000); return null; }
          setSave('retry');
          await sleep(Math.min(10000, 600 * 2 ** attempt));
        }
      }
    };
    chain = chain.then(run, run);
    return chain;
  }

  function flushNote(keepalive = false) {
    clearTimeout(noteTimer);
    if (!dirty) return;
    const d = dirty;
    dirty = null;
    optimistic(d.sid, d.unit, {note: d.note});
    save(d.sid, d.unit, {note: d.note}, keepalive);
  }

  noteBox.addEventListener('input', () => {
    if (S.cur == null) return;
    dirty = {sid: S.sid, unit: S.cur, note: noteBox.value};
    setSave('editing');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, 700);
  });
  noteBox.addEventListener('blur', () => flushNote());

  function toggleTag(i) {
    const tag = S.config.tags[i];
    if (!tag || S.cur == null) return;
    flushNote();
    const e = entry(S.cur), tags = ((e && e.tags) || []).slice(), k = tags.indexOf(tag);
    if (k >= 0) tags.splice(k, 1); else tags.push(tag);
    optimistic(S.sid, S.cur, {tags});
    save(S.sid, S.cur, {tags});
    if (document.body.classList.contains('focus')) toast(`Unit ${S.cur}: ${k >= 0 ? '−' : '+'} ${tag}`, 1200);
  }

  function toggleFlag() {
    if (S.cur == null) return;
    flushNote();
    const e = entry(S.cur), flag = !(e && e.flag);
    optimistic(S.sid, S.cur, {flag});
    save(S.sid, S.cur, {flag});
    if (document.body.classList.contains('focus')) toast(`Unit ${S.cur}: ${flag ? '★ flagged' : 'flag removed'}`, 1200);
  }

  $('tagBtns').addEventListener('click', e => {
    const b = e.target.closest('button[data-i]');
    if (b) toggleTag(Number(b.dataset.i));
  });
  $('flag').addEventListener('click', toggleFlag);

  async function poll() {
    if (document.hidden || !S.sid || pending || dirty) return;
    const sid = S.sid;
    try {
      const r = await api('/api/notebook?sid=' + encodeURIComponent(sid));
      if (sid !== S.sid || pending || dirty) return;
      const conflictsChanged = (r.conflicts || []).join() !== S.conflicts.join();
      S.conflicts = r.conflicts || [];
      if (conflictsChanged) renderConflicts();
      if (r.mtime !== S.mtime) {
        S.notebook = r.notebook;
        S.mtime = r.mtime;
        notebookChanged();
        renderNoteEditor(false);
      }
    } catch (e) { /* offline; try again later */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushNote(true);
    else { poll(); egLoop(); }
  });
  window.addEventListener('pagehide', () => flushNote(true));
  window.addEventListener('focus', () => egLoop(true));  // back from the electro_gui tab: is it still up?

  // ------------------------------------------------------------ electro_gui
  function egEncode(state) {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function egLink(u) {
    const state = {session: S.sid, unit: u.id};
    if (u.quality && !EG_DEFAULT_Q.includes(u.quality)) state.unitQ = EG_DEFAULT_Q.concat([u.quality]);
    const url = new URL(S.eg.url);
    url.hash = 's=' + egEncode(state);
    return url.toString();
  }

  async function refreshEg() {
    try { S.eg = await api('/api/electro_gui'); } catch (e) { S.eg = {url: S.eg.url, running: false}; }
    renderEg();
  }

  // every 30 s while electro_gui answers, every 5 s while it does not (so a fresh start shows up quickly)
  let egTimer = null;
  async function egLoop(always = false) {
    clearTimeout(egTimer);
    if (always || !document.hidden) await refreshEg();
    egTimer = setTimeout(egLoop, S.eg.url && !S.eg.running ? 5000 : 30000);
  }

  function renderEg() {
    const b = $('egBtn');
    b.hidden = !S.eg.url;
    b.classList.toggle('up', !!S.eg.running);
    b.classList.toggle('down', !S.eg.running);
    b.title = S.eg.running ? 'Open this unit in electro_gui (e)'
      : S.config.electro_gui.can_start ? 'electro_gui is not running: e starts it and opens this unit'
      : `electro_gui is not answering at ${S.eg.url}`;
  }

  /** Open (or re-point) the "electro_gui" tab at this unit; its hashchange handler applies the new state in place.
   *  When electro_gui is not answering, the tab first shows eg-start.html, which starts it (on this Mac) and
   *  then goes to the unit; the tab is opened right here so the browser does not block it as a popup. */
  function openEg() {
    const u = S.byId.get(S.cur);
    if (!u || !S.eg.url) return;
    const link = egLink(u);
    if (S.eg.running) { window.open(link, 'electro_gui'); return; }
    if (S.config.electro_gui.can_start) {
      window.open('/static/eg-start.html#' + encodeURIComponent(link), 'electro_gui');
      setTimeout(() => egLoop(true), 3000);
      return;
    }
    window.open(link, 'electro_gui');
    toast(`electro_gui did not answer at <code>${esc(S.eg.url)}</code>. Start it on the Mac:<br><code>${esc(S.config.electro_gui.launch)}</code>`, 10000, true);
    egLoop(true);
  }
  $('egBtn').addEventListener('click', openEg);

  // ------------------------------------------------------------- chrome
  function togglePanels(force) {
    const on = force == null ? !document.body.classList.contains('focus') : !!force;
    document.body.classList.toggle('focus', on);
    store.set('focus', on);
  }
  $('panelsBtn').addEventListener('click', () => togglePanels());

  const isPhone = () => window.matchMedia('(max-width: 999px)').matches;
  function openDrawer() { document.body.classList.add('drawer'); }
  function closeDrawer() { document.body.classList.remove('drawer'); }
  $('drawerBtn').addEventListener('click', openDrawer);
  $('drawerClose').addEventListener('click', closeDrawer);
  document.addEventListener('click', e => {
    if (document.body.classList.contains('drawer') && !e.target.closest('#units, #drawerBtn')) closeDrawer();
    // a mouse click leaves focus on the button, where Space would press it again
    const b = e.target.closest('button');
    if (b && e.detail > 0) b.blur();
  });

  function openJump() {
    if (isPhone()) openDrawer(); else togglePanels(false);
    const j = $('jump');
    j.focus();
    j.select();
  }

  function jumpTo(text) {
    const id = parseInt(String(text).replace(/\D+/g, ''), 10);
    if (!Number.isFinite(id)) return;
    if (S.byId.has(id)) { go(id); $('jump').value = ''; $('jump').blur(); closeDrawer(); }
    else toast(`No unit ${id} in this session`);
  }

  function showHelp() { $('help').hidden = false; }
  function hideHelp() { $('help').hidden = true; }
  $('helpBtn').addEventListener('click', showHelp);
  $('helpClose').addEventListener('click', hideHelp);
  $('help').addEventListener('click', e => { if (e.target === $('help')) hideHelp(); });
  $('toast').addEventListener('click', () => { $('toast').hidden = true; });

  $('session').addEventListener('change', e => { openSession(e.target.value, null, S.view); e.target.blur(); });

  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h.s && h.s !== S.sid && S.sessions.some(s => s.id === h.s)) openSession(h.s, h.u, h.v);
    else {
      if (h.v && h.v !== S.view) setView(h.v);
      if (h.u != null && h.u !== S.cur) go(h.u);
    }
  });

  document.addEventListener('keydown', e => {
    const t = e.target;
    if (!$('help').hidden && (e.key === 'Escape' || e.key === '?')) { hideHelp(); e.preventDefault(); return; }
    if (t.closest && t.closest('input, textarea, select')) {
      if (t === noteBox) {
        if (e.key === 'Escape') { e.preventDefault(); flushNote(); noteBox.blur(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); flushNote(); step(1); }
      } else if (t.id === 'jump') {
        if (e.key === 'Enter') { e.preventDefault(); jumpTo(t.value); }
        else if (e.key === 'Escape') { t.value = ''; t.blur(); closeDrawer(); }
      } else if (e.key === 'Escape') {
        t.blur();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || !S.sid) return;
    if ((e.key === ' ' || e.key === 'Enter') && t.closest && t.closest('button')) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'j': step(1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'k': step(-1); break;
      case ' ': step(e.shiftKey ? -1 : 1); break;
      case 'Home': edge(0); break;
      case 'End': edge(-1); break;
      case ']': cycleView(1); break;
      case '[': cycleView(-1); break;
      case '}': cycleSession(1); break;
      case '{': cycleSession(-1); break;
      case 'r': setView('raster'); break;
      case 'f': toggleFlag(); break;
      case 'n': case 'Enter': if (!isPhone()) togglePanels(false); noteBox.focus(); break;
      case 'g': case '/': openJump(); break;
      case 'z': toggleZoom(); break;
      case 'e': openEg(); break;
      case 'm': togglePanels(); break;
      case 's': cycleSort(); break;
      case 'S': setSort(S.sort.key, -S.sort.dir); break;
      case '?': showHelp(); break;
      case 'Escape':
        if (S.zoom) toggleZoom(false);
        else if (document.body.classList.contains('drawer')) closeDrawer();
        else handled = false;
        break;
      default:
        if (/^[1-9]$/.test(e.key)) toggleTag(Number(e.key) - 1);
        else handled = false;
    }
    if (handled) e.preventDefault();
  });

  boot();
})();
