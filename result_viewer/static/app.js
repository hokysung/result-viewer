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

  /* QC criteria: thresholds on tables/units.csv columns (u.metrics), all of which a unit must pass.
   * `op` 'min' keeps units with value >= v, 'max' value <= v. A criterion on a metric this session
   * does not have (e.g. conn_* without connectivity mapping) is shown greyed and not applied;
   * a unit without a value fails it. Known metrics get a label and a sensible default. */
  const METRICS = {
    mean_rate_hz: {label: 'Rate (Hz)', op: 'min', v: 1, tip: 'session mean firing rate'},
    n_stable_trials: {label: 'Stable trials', op: 'min', v: 300, tip: 'completed trials inside the unit\'s stable interval'},
    frac_stable_trials: {label: 'Stable fraction', op: 'min', v: 0.8, tip: 'stable / completed trials'},
    presence_ratio: {label: 'Presence ratio', op: 'min', v: 0.9},
    snr: {label: 'SNR', op: 'min', v: 3},
    isi_violations_ratio: {label: 'ISI violations', op: 'max', v: 0.1},
    amplitude_median: {label: 'Amplitude (µV)', op: 'min', v: 50},
    n_spikes: {label: 'Spikes', op: 'min', v: 1000},
    depth_um: {label: 'Depth (µm)', op: 'min', v: 0},
    conn_pulse_p: {label: 'Pulse-locked p', op: 'max', v: 0.001, tip: 'one-sided Poisson p: spikes 0.5–6 ms after the pulse TTL vs −20…−3 ms before'},
    conn_pulse_ratio: {label: 'Pulse ratio', op: 'min', v: 2, tip: 'rate 0.5–6 ms after the pulse / rate −20…−3 ms before'},
    conn_spikes_per_pulse: {label: 'Excess spikes/pulse', op: 'min', v: 0.01},
    conn_latency_ms: {label: 'Pulse latency (ms)', op: 'max', v: 6, tip: 'peak of the excess histogram, only where pulse p < 0.01'},
    conn_train_p: {label: 'Train p', op: 'max', v: 0.001, tip: 'two-sided Poisson p: rate during the 1 s train vs the second before'},
    conn_train_ratio: {label: 'Train ratio', op: 'min', v: 1.5, tip: 'rate during the train / the second before (below 1: suppressed)'},
    prof_epoch_p: {label: 'Epoch-modulated p', op: 'max', v: 0.01, tip: 'probe profile: cue / late / reward vs fixation, Wilcoxon, Bonferroni over 3'},
    prof_task_p: {label: 'Task-selective p', op: 'max', v: 0.01, tip: 'probe profile: MS / SP / PM differ in cue or late, Kruskal–Wallis, Bonferroni over 2'},
    prof_task_precue_p: {label: 'Task p before the cue', op: 'max', v: 0.01, tip: 'probe profile: the task test before the cue (a control: tasks are interleaved)'},
    prof_task_eta2: {label: 'Task η² (late)', op: 'min', v: 0.02},
    prof_pulse_p: {label: 'Pulse p 2.5–20 ms', op: 'max', v: 0.01, tip: 'probe profile: spikes 2.5–20 ms after single FEF pulses vs −20…−3 ms, one-sided Poisson'},
    prof_pulse_ratio: {label: 'Pulse ratio 2.5–20 ms', op: 'min', v: 1.2},
    prof_pulse_ctrl_p: {label: 'Pulse control p', op: 'min', v: 0.01, tip: 'the pulse test at mid-interval, where no pulse is'},
    prof_train_p: {label: 'Train-responsive p', op: 'max', v: 0.05, tip: 'probe profile: 50–350 ms after train offset, stim vs sham, Mann–Whitney, Bonferroni over contexts'},
    prof_train_ratio: {label: 'Train stim/sham', op: 'min', v: 1.2},
    prof_n_task_trials: {label: 'Stable task trials', op: 'min', v: 60},
  };
  const QC_PRESETS = [
    {label: 'Watters', tip: 'Watters et al. 2026 inclusion: mean rate ≥ 1 Hz and ≥ 300 stable completed trials',
     crit: [{key: 'mean_rate_hz', op: 'min', v: 1}, {key: 'n_stable_trials', op: 'min', v: 300}]},
    {label: 'Pulse-locked', tip: 'Connectivity: excess spikes 0.5–6 ms after the pulse, p ≤ 0.001',
     crit: [{key: 'conn_pulse_p', op: 'max', v: 0.001}]},
    {label: 'Train-modulated', tip: 'Connectivity: rate changes over the 1 s train, p ≤ 0.001',
     crit: [{key: 'conn_train_p', op: 'max', v: 0.001}]},
    {label: 'Epoch-modulated', tip: 'Probe profile: responds to task events (p < 0.01)', crit: [{key: 'prof_epoch_p', op: 'max', v: 0.0099}]},
    {label: 'Task-selective', tip: 'Probe profile: MS / SP / PM differ (p < 0.01)', crit: [{key: 'prof_task_p', op: 'max', v: 0.0099}]},
    {label: 'Pulse 2.5–20 ms', tip: 'Probe profile: excited 2.5–20 ms after single FEF pulses (p < 0.01)', crit: [{key: 'prof_pulse_p', op: 'max', v: 0.0099}]},
    {label: 'Train-responsive', tip: 'Probe profile: stim ≠ sham after train offset (p < 0.05)', crit: [{key: 'prof_train_p', op: 'max', v: 0.0499}]},
  ];
  const metricLabel = k => (METRICS[k] ? METRICS[k].label : k.replace(/_/g, ' '));
  const fmtNum = v => (v == null ? '–' : v === 0 ? '0' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? String(+v.toFixed(2))
    : Math.abs(v) < 0.001 ? v.toExponential(0) : String(+v.toPrecision(2)));
  function metric(u, key) { const m = u && u.metrics; return m && m[key] != null ? m[key] : null; }

  /* Sort keys: `desc` is the natural direction (highest rate first); S.sort.dir = -1 reverses it.
   * Units without a value (no stability table, or not in the current units) always sort last. */
  const fmtRate = v => (v == null ? '–' : v >= 10 ? v.toFixed(0) : v.toFixed(1));
  const SORTS = {
    id: {label: 'Unit #', value: u => u.id, desc: false, cell: () => ''},
    rate: {label: 'Rate', value: u => u.rate_hz, desc: true,
           cell: u => (u.rate_hz == null ? '' : `${fmtRate(u.rate_hz)}<small> Hz</small>`), tip: 'session mean firing rate'},
    stable: {label: 'Stable trials', value: u => u.n_stable, desc: true,
             cell: u => (u.n_stable == null ? '' : `${u.n_stable}<small>/${u.n_trials}</small>`), tip: 'trials in the stable block'},
    pulse: {label: 'Pulse p', value: u => metric(u, 'conn_pulse_p'), desc: false, needs: 'conn_pulse_p',
            cell: u => (metric(u, 'conn_pulse_p') == null ? '' : `<small>p </small>${fmtNum(metric(u, 'conn_pulse_p'))}`),
            tip: 'connectivity: pulse-locked p, smallest first'},
    train: {label: 'Train p', value: u => metric(u, 'conn_train_p'), desc: false, needs: 'conn_train_p',
            cell: u => (metric(u, 'conn_train_p') == null ? '' : `<small>p </small>${fmtNum(metric(u, 'conn_train_p'))}`),
            tip: 'connectivity: train-modulation p, smallest first'},
  };

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('rv.' + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem('rv.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };

  const S = {
    // sorting: the open sorting's folder name under <sid>/sortings/, null for the session's default sorting
    config: null, sessions: [], sid: null, sorting: null, sortings: [], session: null, units: [], byId: new Map(),
    notebook: {units: {}}, mtime: null, conflicts: [], files: {},
    filtered: [], cur: null, view: store.get('view', 'raster'), zoom: false,
    filters: Object.assign(noFilters(), store.get('filters', {})),
    qc: (store.get('qc', []) || []).filter(c => c && typeof c.key === 'string' && isFinite(c.v)),
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
  /* A notebook is one sorting of one session: "<sid>" (default sorting) or "<sid>@<sorting>", as on the server.
   * Unit ids of two sortings are unrelated, so everything per unit (notes, last unit) is keyed by this. */
  const nbKey = (sid, sorting) => (sorting ? `${sid}@${sorting}` : sid);
  const curKey = () => nbKey(S.sid, S.sorting);
  const nbTarget = () => ({sid: S.sid, sorting: S.sorting, key: curKey()});
  const sortingQuery = sorting => (sorting ? '&sorting=' + encodeURIComponent(sorting) : '');
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
    await openSession(sid, h.u, h.v, sid === h.s ? h.so : null);
    egLoop(true);
    setInterval(poll, 15000);
  }

  function parseHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const u = p.get('u');
    // sorting: absent = the session's default sorting
    return {s: p.get('s'), so: p.get('sorting') || null,
            u: u != null && u !== '' && Number.isFinite(Number(u)) ? Number(u) : null, v: p.get('v')};
  }

  function writeHash() {
    if (!S.sid) return;
    const p = new URLSearchParams({s: S.sid});
    if (S.sorting) p.set('sorting', S.sorting);
    p.set('u', S.cur == null ? '' : S.cur);
    p.set('v', S.view);
    history.replaceState(null, '', '#' + p.toString());
  }

  async function openSession(sid, unitId = null, view = null, sorting = null) {
    flushNote();
    $('title').textContent = `Loading ${prettySid(sid)}${sorting ? ` · ${sorting}` : ''}…`;
    let data;
    try {
      data = await api('/api/session?sid=' + encodeURIComponent(sid) + sortingQuery(sorting));
    } catch (e) {
      if (sorting && e.status === 404) {  // a link to a sorting this session no longer has: open its default
        toast(`${sid} has no sorting ${sorting}; showing its default sorting`, 5000);
        return openSession(sid, null, view, null);
      }
      toast(`Cannot open ${sid}: ${e.message}`, 5000);
      if (S.sid) { $('session').value = S.sid; $('sorting').value = S.sorting || ''; }
      return;
    }
    S.sid = sid;
    S.sorting = sorting;
    S.sortings = data.sortings || [];
    S.session = data.session;
    S.units = data.session.units;
    S.byId = new Map(S.units.map(u => [u.id, u]));
    S.notebook = data.notebook || {units: {}};
    S.mtime = data.mtime;
    S.conflicts = data.conflicts || [];
    S.files = data.files || {};
    store.set('session', sid);
    $('session').value = sid;
    S.session.views = [SESSION_VIEW, PROBE_VIEW].concat(S.session.views.filter(v => v.kind !== SESSION_VIEW.kind && v.kind !== PROBE_VIEW.kind));
    renderSortingSelect();
    if (view) S.view = view;
    if (!S.session.views.some(v => v.kind === S.view)) S.view = 'raster';
    loadTimeline(sid);
    if ($('probePane')) $('probePane').innerHTML = '';
    loadProbe(sid);
    computeFiltered();
    let target = unitId != null && S.byId.has(unitId) ? unitId : store.get('last.' + curKey(), null);
    if (target == null || !S.byId.has(target)) target = S.filtered.length ? S.filtered[0] : (S.units.length ? S.units[0].id : null);
    S.cur = null;
    renderFilters();
    renderQc();
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
    return passesQc(u);
  }

  // -------------------------------------------------------------------- QC
  /** Metric keys some unit of this session has, in METRICS order, then the rest alphabetically. */
  function sessionMetrics() {
    const have = new Set();
    for (const u of S.units) for (const k in (u.metrics || {})) have.add(k);
    const known = Object.keys(METRICS).filter(k => have.has(k));
    return known.concat(Array.from(have).filter(k => !METRICS[k]).sort());
  }
  /** The criteria that apply here: switched on, and on a metric this session has. */
  function activeQc() { const have = new Set(sessionMetrics()); return S.qc.filter(c => c.on !== false && have.has(c.key)); }
  function passes(u, c) { const v = metric(u, c.key); return v != null && (c.op === 'max' ? v <= c.v : v >= c.v); }
  function passesQc(u) { return activeQc().every(c => passes(u, c)); }

  function renderQc() {
    const have = sessionMetrics();
    const box = $('qc');
    if (!have.length) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    const active = activeQc();
    const nPass = S.units.filter(u => active.every(c => passes(u, c))).length;
    const rows = S.qc.map((c, i) => {
      const missing = !have.includes(c.key);
      const fails = missing ? null : S.units.filter(u => !passes(u, c)).length;
      const tip = (METRICS[c.key] && METRICS[c.key].tip) || c.key;
      return `<div class="qcrow${missing ? ' missing' : ''}${c.on === false ? ' off' : ''}" data-i="${i}">` +
        `<input type="checkbox" data-qc="on" ${c.on === false ? '' : 'checked'} aria-label="Apply this criterion"${missing ? ' disabled' : ''}>` +
        `<span class="qlbl" title="${esc(tip)}">${esc(metricLabel(c.key))}</span>` +
        `<button type="button" class="qop" data-qc="op" title="Switch ≥ / ≤">${c.op === 'max' ? '≤' : '≥'}</button>` +
        `<input type="number" step="any" data-qc="v" value="${esc(c.v)}" aria-label="Threshold">` +
        `<span class="qn" title="${missing ? 'This session has no such column' : `${fails} of ${S.units.length} units fail this criterion on its own`}">` +
        `${missing ? 'n/a' : `−${fails}`}</span>` +
        `<button type="button" class="qx" data-qc="rm" aria-label="Remove criterion">✕</button></div>`;
    }).join('');
    const options = have.map(k => `<option value="${esc(k)}">${esc(metricLabel(k))}</option>`).join('');
    box.innerHTML =
      `<div class="qchead"><b>QC</b><span class="muted small">${S.qc.length ? `${nPass} of ${S.units.length} pass all` : 'units must pass every criterion'}</span>` +
      (S.qc.length ? '<button type="button" class="chip clear" data-qc="clear">clear</button>' : '') + '</div>' + rows +
      `<div class="qcadd"><select data-qc="add" aria-label="Add a QC criterion"><option value="">+ criterion…</option>${options}</select>` +
      QC_PRESETS.filter(p => p.crit.some(c => have.includes(c.key)))
        .map((p, i) => `<button type="button" class="chip" data-qc="preset" data-p="${QC_PRESETS.indexOf(p)}" title="${esc(p.tip)}">${esc(p.label)}</button>`).join('') +
      (active.length ? '<button type="button" class="chip" data-qc="copy" title="Copy the ids of the units that pass every QC criterion and filter">copy ids</button>' : '') +
      '</div>';
  }

  function qcChanged() {
    store.set('qc', S.qc);
    filtersChanged();
  }

  function addQc(key) {
    const d = METRICS[key] || {op: 'min', v: 0};
    const i = S.qc.findIndex(c => c.key === key);
    if (i >= 0) S.qc[i].on = true; else S.qc.push({key, op: d.op, v: d.v, on: true});
  }

  $('qc').addEventListener('click', e => {
    const el = e.target.closest('[data-qc]');
    if (!el) return;
    const row = el.closest('.qcrow'), i = row ? Number(row.dataset.i) : -1;
    const what = el.dataset.qc;
    if (what === 'op') S.qc[i].op = S.qc[i].op === 'max' ? 'min' : 'max';
    else if (what === 'rm') S.qc.splice(i, 1);
    else if (what === 'clear') S.qc = [];
    else if (what === 'preset') {
      for (const c of QC_PRESETS[Number(el.dataset.p)].crit) {
        const j = S.qc.findIndex(x => x.key === c.key);
        if (j >= 0) S.qc[j] = Object.assign({}, c, {on: true}); else S.qc.push(Object.assign({}, c, {on: true}));
      }
    } else if (what === 'copy') {
      const ids = S.filtered.join(' ');
      (navigator.clipboard ? navigator.clipboard.writeText(ids) : Promise.reject()).then(
        () => toast(`Copied ${S.filtered.length} unit ids`), () => window.prompt('Unit ids', ids));
      return;
    } else return;
    qcChanged();
  });
  $('qc').addEventListener('change', e => {
    const el = e.target.closest('[data-qc]');
    if (!el) return;
    if (el.dataset.qc === 'add') { if (el.value) addQc(el.value); qcChanged(); return; }
    const i = Number(el.closest('.qcrow').dataset.i);
    if (el.dataset.qc === 'on') S.qc[i].on = el.checked;
    if (el.dataset.qc === 'v') { const v = parseFloat(el.value); if (!isFinite(v)) { renderQc(); return; } S.qc[i].v = v; }
    qcChanged();
  });

  function sortUnits() {
    const s = sortAvailable(S.sort.key) ? SORTS[S.sort.key] : SORTS.id;
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
    renderQc();
    renderList();
    if (S.view === PROBE_VIEW.kind && $('ppBox')) renderProbe();
    if (S.filtered.length && !S.filtered.includes(S.cur)) {
      const next = nearestFiltered(1);
      go(next != null ? next : S.filtered[S.filtered.length - 1]);
    } else {
      renderPos();
      preload();
    }
  }

  /** Unit id always; the p-value sorts only where some unit has that column; the rest need the stability table. */
  function sortAvailable(key) {
    const s = SORTS[key];
    if (!s) return false;
    if (key === 'id') return true;
    return s.needs ? S.units.some(u => metric(u, s.needs) != null) : hasStability();
  }

  function renderSort() {
    const enabled = hasStability();
    $('sortBar').innerHTML = '<span class="lbl">Sort</span><span class="seg">' + Object.entries(SORTS).filter(([key, s]) => !s.needs || sortAvailable(key)).map(([key, s]) => {
      const on = S.sort.key === key;
      const descending = s.desc !== (S.sort.dir < 0);
      const tip = key === 'id' ? 'Unit id (s cycles the sort, S reverses it)' : `${s.tip}${sortAvailable(key) ? '' : ' (no stability table in this session)'}`;
      return `<button type="button" data-sort="${key}" aria-pressed="${on}"${!sortAvailable(key) ? ' disabled' : ''} title="${esc(tip)}">` +
        `${esc(s.label)}${on ? `<span class="dir">${descending ? '▼' : '▲'}</span>` : ''}</button>`;
    }).join('') + '</span>';
  }

  function setSort(key, dir) {
    if (!sortAvailable(key)) return;
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
    const keys = Object.keys(SORTS).filter(sortAvailable);
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
    if (opt && info && !S.sorting) { info.noted = ids.length; opt.textContent = sessionLabel(info); }
    const so = S.sortings.find(s => (s.name || null) === S.sorting);
    if (so) { so.noted = ids.length; renderSortingSelect(); }
  }

  // the session list's counts are the default sorting's
  function sessionLabel(s) { return `${prettySid(s.id)} · ${s.n_units} units${s.noted ? ` · ${s.noted} noted` : ''}`; }

  function renderSessionSelect() {
    $('session').innerHTML = S.sessions.map(s => `<option value="${esc(s.id)}">${esc(sessionLabel(s))}</option>`).join('');
  }

  function sortingLabel(s) {
    return `${s.label}${s.n_units != null ? ` · ${s.n_units} units` : ''}${s.noted ? ` · ${s.noted} noted` : ''}`;
  }

  /** The sorting picker: shown only when the open session has more than one sorting. */
  function renderSortingSelect() {
    const sel = $('sorting');
    sel.hidden = S.sortings.length < 2;
    sel.innerHTML = S.sortings.map(s => `<option value="${esc(s.name || '')}">${esc(sortingLabel(s))}</option>`).join('');
    sel.value = S.sorting || '';
    const cur = S.sortings.find(s => (s.name || null) === S.sorting);
    sel.title = `Spike sorting of this session${cur ? `: ${cur.label}` : ''}. Unit ids differ between sortings; each has its own notes.`;
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
    store.set('last.' + curKey(), id);
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
    document.title = `Unit ${u.id} · ${prettySid(S.sid)}${S.sorting ? ` · ${S.sorting}` : ''}`;
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
    const pp = metric(u, 'conn_pulse_p'), tp = metric(u, 'conn_train_p');
    if (pp != null || tp != null) {
      const tr = metric(u, 'conn_train_ratio'), lat = metric(u, 'conn_latency_ms');
      const hit = (pp != null && pp <= 0.001) || (tp != null && tp <= 0.001);
      html += `<span class="badge${hit ? ' ok' : ''}" title="Connectivity mapping (tables/units.csv conn_*): pulse-locked p (0.5–6 ms after the TTL vs −20…−3 ms), train p and ratio (1 s train vs the second before)">` +
        `pulse p ${fmtNum(pp)}${lat != null ? ` @ ${fmtNum(lat)} ms` : ''} · train ×${fmtNum(tr)} p ${fmtNum(tp)}</span>`;
    }
    if (u.relabelled_from && u.relabelled_from.length) html += `<span class="badge" title="Older rasters with other labels exist">relabelled · was ${esc(u.relabelled_from.map(upper).join(', '))}</span>`;
    if (fig && fig.label_in_figure) html += `<span class="badge warn" title="${esc(fig.name)}">this figure predates the relabel (labelled ${esc(upper(fig.label_in_figure))})</span>`;
    $('badges').innerHTML = html;
  }

  function renderViews() {
    const u = S.byId.get(S.cur);
    $('views').innerHTML = S.session.views.map(v => {
      const whole = v.kind === SESSION_VIEW.kind || v.kind === PROBE_VIEW.kind;
      const has = whole || (u && u.figures[v.kind]);
      return `<button class="view${has ? '' : ' missing'}${whole ? ' session' : ''}" data-kind="${esc(v.kind)}" aria-current="${v.kind === S.view}" title="${esc(v.label)}${has ? '' : ' (none for this unit)'}">${esc(v.label)}</button>`;
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

  // --------------------------------------------------------------- session
  /* The Session view and the per-unit strip: tables/session_timeline.json (trials, trains, stable intervals,
   * rates, on the imec clock) and the rig dashboard's session_log.jsonl put on that clock by the server
   * (/api/timeline). Times are seconds from the start of the recording. */
  const SESSION_VIEW = {kind: 'session', label: 'Session', n: 0};
  const TASK_COLORS = {fixation: '#495057', memory_saccade: '#1971c2', pursuit: '#2f9e44', reveal: '#f08c00',
    overlap_saccade: '#9c36b5', freeview: '#868e96', pursuit_memory: '#c2255c'};
  const PROTO_COLORS = ['#4c6ef5', '#12b886', '#fab005', '#e64980', '#7950f2', '#15aabf', '#fd7e14', '#82c91e', '#be4bdb', '#228be6'];
  const LOG_KINDS = {
    note: {label: 'Note', on: true, color: '#1c7ed6'}, mark: {label: 'Mark', on: true, color: '#2b8a3e'},
    control: {label: 'Protocol', on: true, color: '#7950f2'}, manual_stim: {label: 'Manual stim', on: true, color: '#e03131'},
    warn: {label: 'Warning', on: true, color: '#f08c00'}, probe: {label: 'Probe', on: true, color: '#495057'},
    calibration: {label: 'Calibration', on: false, color: '#868e96'}, phys: {label: 'Depth', on: false, color: '#0c8599'},
    set: {label: 'Setting', on: false, color: '#868e96'}, ask: {label: 'Asked', on: false, color: '#868e96'},
    answer: {label: 'Answer', on: false, color: '#868e96'}, todo: {label: 'To-do', on: false, color: '#868e96'},
    todo_done: {label: 'To-do done', on: false, color: '#868e96'}, todo_addressed: {label: 'To-do addressed', on: false, color: '#868e96'},
  };
  const EVENT_KINDS = ['note', 'mark', 'manual_stim', 'warn', 'calibration'];
  S.tl = null;
  S.tlKinds = Object.assign(Object.fromEntries(Object.entries(LOG_KINDS).map(([k, v]) => [k, v.on])), store.get('tlKinds', {}));
  S.tlCursor = null;

  async function loadTimeline(sid) {
    S.tl = null;
    S.tlCursor = null;
    renderStrip();
    if ($('sessionPane')) $('sessionPane').innerHTML = '';
    try {
      const data = await api('/api/timeline?sid=' + encodeURIComponent(sid));
      if (S.sid !== sid) return;
      S.tl = prepTimeline(data);
    } catch (e) {
      if (S.sid !== sid) return;
      S.tl = {error: e.message};
    }
    renderStrip();
    if (S.view === SESSION_VIEW.kind) renderSession();
  }

  function prepTimeline(data) {
    const tl = data.timeline, log = data.log || {entries: [], runs: [], depths: [], alignment: {}};
    const tr = tl ? tl.trials : {start: [], stop: []};
    const starts = tr.start.filter(v => v != null), stops = tr.stop.filter(v => v != null);
    const dur = tl ? tl.duration_s : null;
    let x0 = Math.min(0, ...(starts.length ? [Math.min(...starts)] : []));
    let x1 = Math.max(dur || 0, ...(stops.length ? [Math.max(...stops)] : []));
    if (!tl) {  // no export timeline: span the aligned log during the task
      const ts = log.entries.map(e => e.t).filter(t => t != null);
      if (ts.length) { x0 = Math.min(...ts); x1 = Math.max(...ts); }
    }
    const protos = [];
    for (const r of log.runs) if (!protos.includes(r.protocol)) protos.push(r.protocol);
    return Object.assign({}, data, {tl, log, x0, x1: Math.max(x1, x0 + 1), dur, protos,
      offset: log.alignment ? log.alignment.offset : null});
  }

  const protoColor = p => PROTO_COLORS[Math.max(0, S.tl.protos.indexOf(p)) % PROTO_COLORS.length];
  function wallAt(t) {
    if (S.tl.offset == null || t == null) return '';
    const d = new Date((t - S.tl.offset) * 1000);
    return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hour12: false});
  }
  const fmtClock = t => {
    if (t == null) return '–';
    const s = Math.round(Math.abs(t)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return `${t < 0 ? '−' : ''}${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s % 60).padStart(2, '0')}`;
  };
  function entryText(e) {
    if (e.kind === 'control') return `${e.action || ''} ${e.protocol || ''}`.trim() + (e.text && !e.protocol ? ` — ${e.text}` : '');
    if (e.kind === 'set') return `${e.name}: ${e.old} → ${e.new}`;
    if (e.kind === 'phys' && !e.text) return `${e.probe} at ${e.depth} mm`;
    return e.text || e.name || '';
  }

  /** One SVG of stacked lanes over the session; `lanes` are {h, label, draw(x, y0, h) -> svg string}. */
  function timelineSvg(width, lanes, {labelW = 96, axis = true, cursor = null} = {}) {
    const T = S.tl, padR = 8, W = Math.max(width, 200);
    const plotW = W - labelW - padR;
    const x = t => labelW + (Math.min(Math.max(t, T.x0), T.x1) - T.x0) / (T.x1 - T.x0) * plotW;
    let y = 2, body = '';
    // not recording: before 0 and after the end
    const H = lanes.reduce((s, l) => s + l.h + 3, 0) + 2;
    if (T.dur != null) {
      if (T.x0 < 0) body += `<rect x="${labelW}" y="0" width="${x(0) - labelW}" height="${H}" class="tl-off"><title>not recording</title></rect>`;
      if (T.x1 > T.dur) body += `<rect x="${x(T.dur)}" y="0" width="${labelW + plotW - x(T.dur)}" height="${H}" class="tl-off"><title>not recording</title></rect>`;
    }
    for (const lane of lanes) {
      if (labelW) body += `<text x="${labelW - 6}" y="${y + lane.h / 2 + 4}" class="tl-lbl" text-anchor="end">${esc(lane.label)}</text>`;
      body += lane.draw(x, y, lane.h, plotW);
      y += lane.h + 3;
    }
    if (cursor != null) body += `<line x1="${x(cursor)}" x2="${x(cursor)}" y1="0" y2="${y}" class="tl-cursor"/>`;
    let ax = '';
    if (axis) {
      const span = T.x1 - T.x0, step = [60, 300, 600, 900, 1800, 3600].find(s => span / s <= 10) || 7200;
      for (let t = Math.ceil(T.x0 / step) * step; t <= T.x1; t += step) {
        const label = S.tl.offset != null ? wallAt(t) : `${Math.round(t / 60)} min`;
        ax += `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${y}" class="tl-grid"/><text x="${x(t)}" y="${y + 12}" class="tl-ax" text-anchor="middle">${label}</text>`;
      }
      y += 16;
    }
    return `<svg class="tl" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" data-x0="${T.x0}" data-x1="${T.x1}" data-lw="${labelW}" data-pw="${plotW}">${ax}${body}</svg>`;
  }

  // lanes
  function laneProtocols(h, label = 'Protocol') {
    return {h, label, draw: (x, y0) => S.tl.log.runs.filter(r => r.t0 != null).map(r => {
      const t1 = r.t1 != null ? r.t1 : r.t0 + 30, w = Math.max(1, x(t1) - x(r.t0));
      const tip = `${r.protocol} · run ${r.run} · ${wallAt(r.t0)}–${wallAt(t1)} (${fmtClock(t1 - r.t0)})`;
      const txt = w > 46 && h >= 14 ? `<text x="${x(r.t0) + 3}" y="${y0 + h / 2 + 4}" class="tl-in">${esc(r.protocol.replace(/^(MultiTask|Connectivity)/, m => m === 'MultiTask' ? 'MT' : 'Conn'))}</text>` : '';
      return `<g><rect x="${x(r.t0)}" y="${y0}" width="${w}" height="${h}" fill="${protoColor(r.protocol)}" opacity=".8"><title>${esc(tip)}</title></rect>${txt}</g>`;
    }).join('')};
  }
  function laneTasks(h) {
    const tr = S.tl.tl.trials;
    return {h, label: 'Task', draw: (x, y0) => tr.id.map((id, i) => {
      if (tr.start[i] == null) return '';
      const w = Math.max(0.6, x(tr.stop[i]) - x(tr.start[i]));
      return `<rect x="${x(tr.start[i])}" y="${y0}" width="${w}" height="${h}" fill="${TASK_COLORS[tr.task[i]] || '#adb5bd'}"><title>trial ${id} · ${esc(tr.task[i])}${tr.block[i] != null ? ' · block ' + tr.block[i] : ''}</title></rect>`;
    }).join('')};
  }
  function laneStim(h) {
    const tr = S.tl.tl.trials;
    return {h, label: 'Stim · sham · conn', draw: (x, y0) => {
      let s = tr.id.map((id, i) => {
        if (tr.start[i] == null || !(tr.stim[i] || tr.conn[i])) return '';
        const c = tr.conn[i] ? '' : tr.stim[i] === 1 ? 'tl-stim' : 'tl-sham';
        return c ? `<rect x="${x(tr.start[i])}" y="${y0 + (tr.stim[i] === 1 ? 0 : h / 2)}" width="1" height="${h / 2}" class="${c}"><title>trial ${id} · ${tr.stim[i] === 1 ? 'stim' : 'sham'}</title></rect>` : '';
      }).join('');
      s += S.tl.tl.trains.map(([a, b, amp]) => `<rect x="${x(a)}" y="${y0}" width="${Math.max(1, x(b) - x(a))}" height="${h}" class="tl-conn"><title>connectivity train ${amp != null ? amp + ' µA' : ''}</title></rect>`).join('');
      return s;
    }};
  }
  function laneSuccess(h) {
    const tr = S.tl.tl.trials, pts = [], win = [];
    tr.id.forEach((id, i) => {
      // rewarded, not `success`: MWorks sets success on every completed trial in these sessions
      if (tr.stop[i] == null || tr.rew[i] == null || tr.conn[i]) return;
      win.push(tr.rew[i]); if (win.length > 25) win.shift();
      pts.push([tr.stop[i], win.reduce((a, b) => a + b, 0) / win.length]);
    });
    return {h, label: 'Rewarded (25 trials)', draw: (x, y0) => pts.length
      ? `<line x1="${x(S.tl.x0)}" x2="${x(S.tl.x1)}" y1="${y0 + h / 2}" y2="${y0 + h / 2}" class="tl-grid"/>` +
        `<polyline points="${pts.map(([t, v]) => `${x(t).toFixed(1)},${(y0 + h - v * h).toFixed(1)}`).join(' ')}" class="tl-line"/>` : ''};
  }
  function laneDepths(h) {
    const by = {};
    for (const d of S.tl.log.depths) if (d.t != null && d.t >= S.tl.x0 - 60 && d.t <= S.tl.x1 + 60) (by[d.probe] = by[d.probe] || []).push(d);
    return Object.entries(by).map(([probe, ds]) => {
      ds.sort((a, b) => a.t - b.t);
      const lo = Math.min(...ds.map(d => d.depth)), hi = Math.max(...ds.map(d => d.depth));
      const yv = (v, y0) => y0 + 2 + (hi > lo ? (v - lo) / (hi - lo) : 0.5) * (h - 4);  // deeper is lower
      return {h, label: `${probe} ${fmtNum(lo)}–${fmtNum(hi)} mm`, draw: (x, y0) => {
        let pts = '';
        ds.forEach((d, i) => { pts += `${i ? `${x(d.t).toFixed(1)},${yv(ds[i - 1].depth, y0).toFixed(1)} ` : ''}${x(d.t).toFixed(1)},${yv(d.depth, y0).toFixed(1)} `; });
        pts += `${x(S.tl.x1).toFixed(1)},${yv(ds[ds.length - 1].depth, y0).toFixed(1)}`;
        return `<polyline points="${pts}" class="tl-depth"><title>${esc(probe)} depth (dashboard), ${fmtNum(lo)}–${fmtNum(hi)} mm</title></polyline>`;
      }};
    });
  }
  function laneNStable(h) {
    const n = S.tl.tl.n_stable, bin = S.tl.tl.bin_s, mx = Math.max(1, ...n);
    return {h, label: `Units stable (≤${mx})`, draw: (x, y0) => {
      const pts = n.map((v, i) => `${x(i * bin).toFixed(1)},${(y0 + h - v / mx * h).toFixed(1)} ${x((i + 1) * bin).toFixed(1)},${(y0 + h - v / mx * h).toFixed(1)}`).join(' ');
      return `<polygon points="${x(0)},${y0 + h} ${pts} ${x(n.length * bin)},${y0 + h}" class="tl-area"><title>SUA/MUA units inside their stable interval, per ${bin} s</title></polygon>`;
    }};
  }
  function laneUnit(h, label) {
    const u = S.tl.tl && S.tl.tl.units[String(S.cur)];
    return {h, label: label || `Unit ${S.cur}`, draw: (x, y0) => {
      if (!u) return `<text x="${x(S.tl.x0) + 4}" y="${y0 + h / 2 + 4}" class="tl-ax">no timeline for this unit</text>`;
      const bin = S.tl.tl.bin_s, mx = Math.max(0.5, ...u.rate);
      let s = u.stable.map(([a, b]) => `<rect x="${x(a)}" y="${y0}" width="${Math.max(1, x(b) - x(a))}" height="${h}" class="tl-stable"><title>stable ${wallAt(a)}–${wallAt(b)} (${fmtClock(b - a)})</title></rect>`).join('');
      const pts = u.rate.map((v, i) => `${x((i + 0.5) * bin).toFixed(1)},${(y0 + h - 1 - v / mx * (h - 2)).toFixed(1)}`).join(' ');
      s += `<polyline points="${pts}" class="tl-rate"><title>rate per ${bin} s, peak ${fmtNum(mx)} Hz</title></polyline>`;
      if (!u.stable.length) s += `<text x="${x(S.tl.x1) - 4}" y="${y0 + 11}" class="tl-ax" text-anchor="end">never stable</text>`;
      return s;
    }};
  }
  function laneEvents(h) {
    const ev = S.tl.log.entries.filter(e => e.t != null && EVENT_KINDS.includes(e.kind) && S.tlKinds[e.kind] && e.t >= S.tl.x0 && e.t <= S.tl.x1);
    return {h, label: 'Notes · marks', draw: (x, y0) => ev.map(e => {
      const k = LOG_KINDS[e.kind];
      return `<circle cx="${x(e.t).toFixed(1)}" cy="${(y0 + h / 2).toFixed(1)}" r="4" fill="${k.color}" class="tl-ev" data-t="${e.t}"><title>${esc(e.wall || '')} ${esc(k.label)}: ${esc(entryText(e))}</title></circle>`;
    }).join('')};
  }

  /** The per-unit strip above the figure: protocol runs, and this unit's stable intervals and rate. */
  function renderStrip() {
    const el = $('unitStrip');
    if (!S.tl || S.tl.error || !S.tl.tl || S.view === SESSION_VIEW.kind || S.cur == null) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const w = el.clientWidth || $('stage').clientWidth - 24;
    el.innerHTML = timelineSvg(w, [laneProtocols(7, 'Protocol'), laneUnit(22, 'Stable · rate')], {labelW: 78, axis: true});
  }

  function renderSession() {
    const pane = $('sessionPane');
    if (!S.tl) { pane.innerHTML = '<p class="muted">Loading the session timeline…</p>'; return; }
    if (S.tl.error) { pane.innerHTML = `<p class="warn">Could not load the session timeline: ${esc(S.tl.error)}</p>`; return; }
    const T = S.tl, tl = T.tl, log = T.log, al = log.alignment || {};
    let html = '<div class="sp-head">';
    if (tl) {
      const tasks = {};
      tl.trials.task.forEach((t, i) => { if (tl.trials.start[i] != null && tl.trials.start[i] >= 0 && tl.trials.stop[i] <= T.dur) tasks[t] = (tasks[t] || 0) + 1; });
      const q = {};
      for (const u of S.units) q[u.quality] = (q[u.quality] || 0) + 1;
      html += `<span class="badge">recording ${fmtClock(T.dur)}${T.offset != null ? ` · ${wallAt(0)}–${wallAt(T.dur)}` : ''}</span>` +
        `<span class="badge">${Object.values(tasks).reduce((a, b) => a + b, 0)} trials in recording</span>` +
        Object.entries(tasks).map(([t, n]) => `<span class="badge"><span class="tdot" style="--c:${TASK_COLORS[t] || '#adb5bd'}"></span>${esc(t.replace(/_/g, ' '))} ${n}</span>`).join('') +
        (tl.trains.length ? `<span class="badge"><span class="tdot" style="--c:#7048e8"></span>${tl.trains.length} connectivity trains</span>` : '') +
        `<span class="badge">${Q_ORDER.filter(k => q[k]).map(k => `${q[k]} ${k}`).join(' · ')}</span>`;
    } else {
      html += '<span class="badge warn">No tables/session_timeline.json in this export yet (phys-analysis: python -m session_viewer refresh).</span>';
    }
    html += log.sources.length
      ? `<span class="badge" title="${esc(log.sources.join('\n'))}">dashboard log aligned by ${esc(al.method)}${al.votes ? ` (${al.votes}/${al.n} entries)` : ''}</span>`
      : '<span class="badge warn">no dashboard session_log.jsonl found for this date</span>';
    html += '</div><div id="tlBox"></div>';
    if (log.runs.length) {
      html += '<details class="sp-sec" open><summary>Protocol runs</summary><table class="sp-runs"><thead><tr><th>Run</th><th>Protocol</th><th>Start</th><th>Length</th><th>Trials</th></tr></thead><tbody>';
      for (const r of log.runs) {
        let counts = {};
        if (tl && r.t0 != null) tl.trials.task.forEach((t, i) => { const s = tl.trials.start[i]; if (s != null && s >= r.t0 && s < (r.t1 != null ? r.t1 : Infinity)) counts[t] = (counts[t] || 0) + 1; });
        const n = Object.values(counts).reduce((a, b) => a + b, 0);
        html += `<tr data-t="${r.t0}"><td>${esc(r.run)}</td><td><span class="tdot" style="--c:${protoColor(r.protocol)}"></span>${esc(r.protocol)}</td>` +
          `<td>${esc(r.wall0 || '')} <small class="muted">${fmtClock(r.t0)}</small></td><td>${r.t1 != null ? fmtClock(r.t1 - r.t0) : '…'}</td>` +
          `<td>${n}${n ? ` <small class="muted">${Object.entries(counts).map(([t, c]) => `${esc(t.replace(/_/g, ' '))} ${c}`).join(', ')}</small>` : ''}</td></tr>`;
      }
      html += '</tbody></table></details>';
    }
    html += '<details class="sp-sec" open><summary>Log</summary><div class="sp-kinds">' +
      Object.entries(LOG_KINDS).filter(([k]) => log.entries.some(e => e.kind === k)).map(([k, v]) =>
        `<button class="chip" data-kind="${k}" aria-pressed="${!!S.tlKinds[k]}"><span class="tdot" style="--c:${v.color}"></span>${esc(v.label)} ${log.entries.filter(e => e.kind === k).length}</button>`).join('') +
      '<input id="tlSearch" type="search" placeholder="search the log" aria-label="Search the log"></div><ol id="tlLog" class="sp-log"></ol></details>';
    if (T.plan) html += `<details class="sp-sec"><summary>Experiment log · ${esc(T.plan.path.split('/').pop())}</summary><pre class="sp-plan">${esc(T.plan.text)}</pre></details>`;
    pane.innerHTML = html;
    renderSessionSvg();
    renderLog();
  }

  function renderSessionSvg() {
    const box = $('tlBox');
    if (!box || !S.tl) return;
    const lanes = [laneProtocols(18)];
    if (S.tl.tl) lanes.push(laneTasks(12), laneStim(12), laneSuccess(26));
    lanes.push(...laneDepths(26));
    if (S.tl.tl) lanes.push(laneNStable(26), laneUnit(26));
    lanes.push(laneEvents(14));
    box.innerHTML = timelineSvg(box.clientWidth || 800, lanes, {labelW: 118, cursor: S.tlCursor}) +
      '<div class="sp-legend muted small">' + Object.entries(TASK_COLORS).filter(([t]) => S.tl.tl && S.tl.tl.trials.task.includes(t))
        .map(([t, c]) => `<span><span class="tdot" style="--c:${c}"></span>${esc(t.replace(/_/g, ' '))}</span>`).join('') +
      '<span><i class="sw tl-stim"></i>stim</span><span><i class="sw tl-sham"></i>sham</span><span><i class="sw tl-conn"></i>connectivity</span>' +
      '<span><i class="sw tl-stable"></i>unit stable</span><span>shaded: not recording · click to find the log entry</span></div>';
  }

  function renderLog() {
    const ol = $('tlLog');
    if (!ol) return;
    const q = ($('tlSearch') && $('tlSearch').value || '').trim().toLowerCase();
    const rows = S.tl.log.entries.filter(e => S.tlKinds[e.kind] && (!q || entryText(e).toLowerCase().includes(q)));
    ol.innerHTML = rows.map(e => {
      const k = LOG_KINDS[e.kind] || {label: e.kind, color: '#868e96'};
      const inRec = e.t != null && S.tl.dur != null && e.t >= 0 && e.t <= S.tl.dur;
      return `<li class="k-${esc(e.kind)}${inRec ? '' : ' outside'}" data-t="${e.t == null ? '' : e.t}"><span class="lt">${esc(e.wall || '')}</span>` +
        `<span class="ls">${e.t == null ? '' : fmtClock(e.t)}</span><span class="lk" style="--c:${k.color}">${esc(k.label)}</span>` +
        `<span class="lx">${esc(entryText(e))}${e.after_trial != null ? ` <small class="muted">after trial ${e.after_trial}</small>` : ''}</span></li>`;
    }).join('') || '<li class="muted">Nothing of these kinds.</li>';
  }

  $('sessionPane').addEventListener('click', e => {
    const chip = e.target.closest('.sp-kinds .chip');
    if (chip) {
      S.tlKinds[chip.dataset.kind] = !S.tlKinds[chip.dataset.kind];
      store.set('tlKinds', S.tlKinds);
      chip.setAttribute('aria-pressed', String(S.tlKinds[chip.dataset.kind]));
      renderLog(); renderSessionSvg();
      return;
    }
    const row = e.target.closest('[data-t]');
    const svg = e.target.closest('svg.tl');
    if (svg) {  // a click on the timeline: the time under it, and the first log entry from then
      const r = svg.getBoundingClientRect(), lw = Number(svg.dataset.lw), pw = Number(svg.dataset.pw);
      const f = (e.clientX - r.left - lw) / pw;
      if (f < 0 || f > 1) return;
      const t = e.target.dataset && e.target.dataset.t ? Number(e.target.dataset.t) : Number(svg.dataset.x0) + f * (Number(svg.dataset.x1) - Number(svg.dataset.x0));
      S.tlCursor = t; renderSessionSvg();
      const li = Array.from(document.querySelectorAll('#tlLog li[data-t]')).find(el => el.dataset.t !== '' && Number(el.dataset.t) >= t - 1);
      if (li) { document.querySelectorAll('#tlLog li.hit').forEach(el => el.classList.remove('hit')); li.classList.add('hit'); li.scrollIntoView({block: 'center', behavior: 'smooth'}); }
      return;
    }
    if (row && row.dataset.t !== '') { S.tlCursor = Number(row.dataset.t); renderSessionSvg(); }
  });
  $('sessionPane').addEventListener('input', e => { if (e.target.id === 'tlSearch') renderLog(); });
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { renderStrip(); if (S.view === SESSION_VIEW.kind) renderSessionSvg(); if (S.view === PROBE_VIEW.kind) renderProbePlot(); }, 150); });

  // ---------------------------------------------------------------- probe
  /* The Probe view: every unit at its depth (µm above the probe tip, tables/units.csv depth_um) against its
   * session mean rate, marked by its probe-profile classes (the prof_* columns, phys-analysis
   * session_viewer.profile), over the sort-free MUA profile (tables/mua_profile.csv via /api/probe).
   * Units outside the filters / QC are faint (or hidden). Click a unit to inspect it here; double-click
   * (or the raster thumbnail) opens its raster. ← / → still step through the filtered list. */
  const PROBE_VIEW = {kind: 'probe', label: 'Probe', n: 0};
  const PROBE_CLASSES = [
    {key: 'epoch', metric: 'prof_epoch_p', alpha: 0.01, label: 'epoch-modulated', color: '#8172B3', shape: 'ring',
     tip: 'cue (0.05–0.35 s), late (0.35–0.8 s) or reward (0–0.3 s) differs from fixation (−0.3–0 s); Wilcoxon, Bonferroni over 3, p < 0.01'},
    {key: 'task', metric: 'prof_task_p', alpha: 0.01, label: 'task-selective', color: '#C44E52', shape: 'x', control: 'prof_task_precue_p',
     tip: 'MS / SP / PM differ in the cue or late epoch; Kruskal–Wallis, Bonferroni over 2, p < 0.01. Control: the same test before the cue'},
    {key: 'pulse', metric: 'prof_pulse_p', alpha: 0.01, label: 'pulse-excited 2.5–20 ms', color: '#DD8452', shape: 'tri', control: 'prof_pulse_ctrl_p',
     tip: 'single FEF pulses: spikes 2.5–20 ms after the TTL vs −20…−3 ms, one-sided Poisson p < 0.01. The test is anti-conservative: read it against the mid-interval control'},
    {key: 'train', metric: 'prof_train_p', alpha: 0.05, label: 'train-responsive', color: '#2f9e44', shape: 'sq',
     tip: 'rate 50–350 ms after train offset, stim vs sham, Mann–Whitney, Bonferroni over contexts, p < 0.05'},
  ];
  S.probe = null;
  S.probeShow = Object.assign({epoch: true, task: true, pulse: true, train: true}, store.get('probeShow', {}));
  S.probeOnly = store.get('probeOnly', false);
  const inClass = (u, c) => { const v = metric(u, c.metric); return v != null && v < c.alpha; };
  const hasProfile = () => S.units.some(u => PROBE_CLASSES.some(c => metric(u, c.metric) != null));

  async function loadProbe(sid) {
    S.probe = null;
    try {
      const data = await api('/api/probe?sid=' + encodeURIComponent(sid));
      if (S.sid !== sid) return;
      S.probe = data;
    } catch (e) {
      if (S.sid !== sid) return;
      S.probe = {error: e.message, mua: null};
    }
    if (S.view === PROBE_VIEW.kind) renderProbe();
  }

  function probeSvg(width, height) {
    const L = 58, R = 14, T = 30, B = 40, pw = Math.max(width - L - R, 80), ph = Math.max(height - T - B, 120);
    const pts = S.units.filter(u => u.depth_um != null && u.rate_hz != null && u.rate_hz > 0);
    const mua = (S.probe && S.probe.mua) || [];
    const ys = pts.map(u => u.depth_um).concat(mua.map(m => m.y_um));
    const y0 = Math.min(0, ...ys) - 50, y1 = Math.max(3840, ...ys) + 50;
    const lx = pts.map(u => Math.log10(Math.max(u.rate_hz, 0.03)));
    const x0 = Math.floor(Math.min(-1, ...lx) * 2) / 2, x1 = Math.ceil(Math.max(1, ...lx) * 2) / 2;
    const X = v => L + (v - x0) / (x1 - x0) * pw, Y = d => T + (1 - (d - y0) / (y1 - y0)) * ph;
    let g = '';
    // MUA area, 100 µm bins
    if (mua.length) {
      const bins = new Map();
      for (const m of mua) { const k = Math.floor(m.y_um / 100) * 100; const b = bins.get(k) || [0, 0]; b[0] += m.mua_hz; b[1] += 1; bins.set(k, b); }
      const rows = Array.from(bins.entries()).sort((a, b) => a[0] - b[0]).map(([k, b]) => [k + 50, b[0] / b[1]]);
      const mmax = Math.max(60, ...rows.map(r => r[1]) ) * 1.05;
      const MX = v => L + v / mmax * pw;
      const poly = [[0, rows[0][0]]].concat(rows).concat([[0, rows[rows.length - 1][0]]]).map(([v, d]) => `${MX(v).toFixed(1)},${Y(d).toFixed(1)}`).join(' ');
      g += `<polygon class="pp-mua" points="${poly}"><title>sort-free MUA (threshold crossings, Hz), 100 µm bins</title></polygon>`;
      for (const v of [0, 20, 40, 60].filter(v => v <= mmax)) g += `<text class="pp-tick mua" x="${MX(v)}" y="${T - 8}" text-anchor="middle">${v}</text>`;
      g += `<text class="pp-axl mua" x="${L + pw}" y="${T - 20}" text-anchor="end">sort-free MUA (Hz), grey</text>`;
    }
    // axes
    for (let d = Math.ceil(y0 / 500) * 500; d <= y1; d += 500) g += `<line class="pp-grid" x1="${L}" x2="${L + pw}" y1="${Y(d)}" y2="${Y(d)}"/><text class="pp-tick" x="${L - 6}" y="${Y(d) + 4}" text-anchor="end">${d}</text>`;
    for (const hz of [0.03, 0.1, 0.3, 1, 3, 10, 30, 100]) {
      const v = Math.log10(hz);
      if (v < x0 || v > x1) continue;
      g += `<line class="pp-grid" x1="${X(v)}" x2="${X(v)}" y1="${T}" y2="${T + ph}"/><text class="pp-tick" x="${X(v)}" y="${T + ph + 15}" text-anchor="middle">${hz}</text>`;
    }
    g += `<rect class="pp-frame" x="${L}" y="${T}" width="${pw}" height="${ph}"/>`;
    g += `<text class="pp-axl" x="${L + pw / 2}" y="${height - 6}" text-anchor="middle">session mean rate (Hz, log)</text>`;
    g += `<text class="pp-axl" transform="translate(14 ${T + ph / 2}) rotate(-90)" text-anchor="middle">µm above the probe tip</text>`;
    // units: faint ones first, the current unit last
    const keep = new Set(S.filtered);
    const order = pts.slice().sort((a, b) => (keep.has(a.id) - keep.has(b.id)) || (a.id === S.cur) - (b.id === S.cur));
    for (const u of order) {
      const on = keep.has(u.id);
      if (!on && S.probeOnly) continue;
      const cx = X(Math.log10(Math.max(u.rate_hz, 0.03))), cy = Y(u.depth_um);
      let m = `<circle class="pp-dot ${esc(u.quality)}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3"/>`;
      for (const c of PROBE_CLASSES) {
        if (!S.probeShow[c.key] || !inClass(u, c)) continue;
        const s = `stroke="${c.color}"`;
        if (c.shape === 'ring') m += `<circle cx="${cx}" cy="${cy}" r="5.5" fill="none" ${s} stroke-width="1.3"/>`;
        else if (c.shape === 'x') m += `<path d="M${cx - 4.5},${cy - 4.5}L${cx + 4.5},${cy + 4.5}M${cx - 4.5},${cy + 4.5}L${cx + 4.5},${cy - 4.5}" ${s} stroke-width="1.6"/>`;
        else if (c.shape === 'tri') m += `<path d="M${cx},${cy - 9}L${cx + 8},${cy + 5.5}L${cx - 8},${cy + 5.5}Z" fill="none" ${s} stroke-width="1.4"/>`;
        else if (c.shape === 'sq') m += `<rect x="${cx - 7.5}" y="${cy - 7.5}" width="15" height="15" fill="none" ${s} stroke-width="1.4"/>`;
      }
      if (u.id === S.cur) m += `<circle class="pp-cur" cx="${cx}" cy="${cy}" r="11"/>`;
      const cls = PROBE_CLASSES.filter(c => inClass(u, c)).map(c => c.label).join(', ');
      g += `<g class="pp-u${on ? '' : ' faint'}" data-id="${u.id}"><title>Unit ${u.id} · ${esc(upper(u.quality))} · ${u.depth_um} µm · ${fmtRate(u.rate_hz)} Hz${cls ? '\n' + esc(cls) : ''}</title>` +
        `<circle class="pp-hit" cx="${cx}" cy="${cy}" r="9"/>${m}</g>`;
    }
    return `<svg class="pp" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Units along the probe">${g}</svg>`;
  }

  function probeCard() {
    const u = S.byId.get(S.cur);
    if (!u) return '<p class="muted">Click a unit.</p>';
    const bits = [`Unit ${u.id}`, upper(u.quality), upper(u.area)];
    if (u.peak_channel != null) bits.push(`ch ${u.peak_channel}`);
    if (u.depth_um != null) bits.push(`${u.depth_um} µm`);
    const row = (label, p, alpha, extra, tip) => {
      const tested = p != null, hit = tested && p < alpha;
      return `<tr title="${esc(tip || '')}"><td>${esc(label)}</td><td class="${hit ? 'hit' : ''}">${tested ? `p ${fmtNum(p)}${hit ? ' ✓' : ''}` : '<span class="muted">not tested</span>'}</td><td class="muted">${extra || ''}</td></tr>`;
    };
    const m = k => metric(u, k);
    let html = `<h3>${esc(bits.filter(Boolean).join(' · '))}</h3>`;
    html += `<p class="muted small">${u.rate_hz != null ? `${fmtRate(u.rate_hz)} Hz` : ''}${u.n_trials != null ? ` · stable ${u.n_stable}/${u.n_trials} trials` : ''}` +
      `${m('prof_n_task_trials') != null ? ` · ${m('prof_n_task_trials')} stable task trials` : ''}${S.filtered.includes(u.id) ? '' : ' · <b>outside the filters</b>'}</p>`;
    html += '<table class="pp-stats"><tbody>' +
      row('Epoch-modulated', m('prof_epoch_p'), 0.01, '', PROBE_CLASSES[0].tip) +
      row('Task-selective', m('prof_task_p'), 0.01, [m('prof_task_eta2') != null ? `η² ${fmtNum(m('prof_task_eta2'))}` : '', m('prof_task_precue_p') != null ? `pre-cue p ${fmtNum(m('prof_task_precue_p'))}` : ''].filter(Boolean).join(' · '), PROBE_CLASSES[1].tip) +
      row('Pulse 2.5–20 ms', m('prof_pulse_p'), 0.01, [m('prof_pulse_ratio') != null ? `×${fmtNum(m('prof_pulse_ratio'))}` : '', m('prof_pulse_ctrl_p') != null ? `control p ${fmtNum(m('prof_pulse_ctrl_p'))}` : ''].filter(Boolean).join(' · '), PROBE_CLASSES[2].tip) +
      row('Train, after offset', m('prof_train_p'), 0.05, m('prof_train_ratio') != null ? `stim/sham ×${fmtNum(m('prof_train_ratio'))} (best context)` : '', PROBE_CLASSES[3].tip) +
      (m('conn_pulse_p') != null ? row('Pulse 0.5–6 ms (conn)', m('conn_pulse_p'), 0.001, m('conn_latency_ms') != null ? `@ ${fmtNum(m('conn_latency_ms'))} ms` : '', METRICS.conn_pulse_p.tip) : '') +
      '</tbody></table>';
    const fig = u.figures && u.figures.raster;
    if (fig) html += `<button class="pp-thumb" data-open="raster" title="Open the raster (double-click a unit does the same)"><img src="${esc(fig.url)}" alt="raster of unit ${u.id}" loading="lazy"></button>`;
    const kinds = S.session.views.filter(v => v.kind !== SESSION_VIEW.kind && v.kind !== PROBE_VIEW.kind && u.figures[v.kind]);
    html += '<div class="pp-open">' + kinds.map(v => `<button class="chip" data-open="${esc(v.kind)}">${esc(v.label)} ↗</button>`).join('') + '</div>';
    return html;
  }

  function renderProbe() {
    const pane = $('probePane');
    const counts = PROBE_CLASSES.map(c => {
      const tested = S.units.filter(u => metric(u, c.metric) != null), hit = tested.filter(u => inClass(u, c)).length;
      const ctrl = c.control ? S.units.filter(u => { const v = metric(u, c.control); return v != null && v < c.alpha; }).length : null;
      return {c, tested: tested.length, hit, ctrl};
    });
    let head = '<div class="pp-head">' + counts.map(({c, tested, hit, ctrl}) =>
      `<button class="chip" data-pc="${c.key}" aria-pressed="${!!S.probeShow[c.key]}" title="${esc(c.tip)}"${tested ? '' : ' disabled'}>` +
      `<span class="tdot" style="--c:${c.color}"></span>${esc(c.label)} ${tested ? `${hit}/${tested}` : 'n/a'}` +
      `${ctrl != null && tested ? ` <small class="muted">(control ${ctrl})</small>` : ''}</button>`).join('') +
      `<button class="chip" data-pc="only" aria-pressed="${!!S.probeOnly}" title="Hide the units outside the filters and QC instead of fading them">only filtered units</button></div>`;
    if (!hasProfile()) head += '<p class="warn small">This export has no probe-profile columns yet (phys-analysis: <code>python -m session_viewer refresh &lt;session.h5&gt;</code>). Units are shown by depth and rate only.</p>';
    if (S.probe && !S.probe.mua) head += '<p class="muted small">No <code>tables/mua_profile.csv</code> in this export: the sort-free MUA profile is not drawn.</p>';
    pane.innerHTML = head + '<div class="pp-wrap"><div id="ppBox"></div><div id="ppCard"></div></div>';
    renderProbePlot();
  }

  function renderProbePlot() {
    const box = $('ppBox');
    if (!box) return;
    const w = Math.max(box.clientWidth || 520, 300), h = Math.max(Math.min(window.innerHeight - 230, 900), 420);
    box.innerHTML = probeSvg(w, h);
    $('ppCard').innerHTML = probeCard();
  }

  $('probePane').addEventListener('click', e => {
    const chip = e.target.closest('[data-pc]');
    if (chip) {
      if (chip.dataset.pc === 'only') { S.probeOnly = !S.probeOnly; store.set('probeOnly', S.probeOnly); }
      else { S.probeShow[chip.dataset.pc] = !S.probeShow[chip.dataset.pc]; store.set('probeShow', S.probeShow); }
      renderProbe();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) { setView(open.dataset.open); return; }
    const pt = e.target.closest('g.pp-u');
    if (pt) go(Number(pt.dataset.id));
  });
  $('probePane').addEventListener('dblclick', e => {
    const pt = e.target.closest('g.pp-u');
    if (pt) { go(Number(pt.dataset.id)); setView('raster'); }
  });

  // ---------------------------------------------------------------- panels
  /* figures/panels/<unit>/<key>.png, one PNG per alignment x condition (catalog: unit.figures.panels.panels,
   * session.panels = manifest with title / group / desc in display order). Grid: every panel of the unit,
   * 1-4 per row, filtered by group. Single: one panel, large; flipping units keeps it (`,` `.` step panels). */
  S.panel = store.get('panel', null);
  S.panelCols = store.get('panelCols', 3);
  S.panelGroup = store.get('panelGroup', '');

  const panelMeta = key => (S.session.panels || []).find(p => p.key === key) || {key, title: key.replace(/_/g, ' '), group: ''};
  function unitPanels() {
    const u = S.byId.get(S.cur), f = u && u.figures.panels;
    return f ? f.panels : [];
  }

  function renderPanels() {
    const pane = $('panelPane'), all = unitPanels();
    if (!all.length) { pane.innerHTML = `<p class="muted">No panels for unit ${esc(S.cur)}. ] / [ for another figure.</p>`; return; }
    const groups = [];
    for (const p of all) { const g = panelMeta(p.key).group || ''; if (g && !groups.includes(g)) groups.push(g); }
    const group = groups.includes(S.panelGroup) ? S.panelGroup : '';
    const shown = all.filter(p => !group || panelMeta(p.key).group === group);
    const single = S.panel && all.some(p => p.key === S.panel) ? S.panel : null;
    let bar = '<div class="pbar">' +
      `<span class="seg"><button type="button" data-pm="grid" aria-pressed="${!single}" title="All panels (p, Esc)">Grid</button>` +
      `<button type="button" data-pm="single" aria-pressed="${!!single}" title="One panel, kept while you flip units (p)">Single</button></span>`;
    if (single) {
      bar += `<button type="button" class="icon" data-pstep="-1" title="Previous panel (,)">‹</button>` +
        `<select data-pick aria-label="Panel">${all.map(p => `<option value="${esc(p.key)}"${p.key === single ? ' selected' : ''}>${esc((panelMeta(p.key).group ? panelMeta(p.key).group + ' · ' : '') + panelMeta(p.key).title)}</option>`).join('')}</select>` +
        `<button type="button" class="icon" data-pstep="1" title="Next panel (.)">›</button>`;
    } else {
      bar += '<span class="seg" title="Panels per row">' + [1, 2, 3, 4].map(n => `<button type="button" data-cols="${n}" aria-pressed="${S.panelCols === n}">${n}</button>`).join('') + '</span>';
      if (groups.length > 1) bar += `<span class="pgroups"><button class="chip" data-pg="" aria-pressed="${!group}">all ${all.length}</button>` +
        groups.map(g => `<button class="chip" data-pg="${esc(g)}" aria-pressed="${g === group}">${esc(g)} ${all.filter(p => panelMeta(p.key).group === g).length}</button>`).join('') + '</span>';
    }
    bar += '</div>';
    const card = (p, big) => {
      const m = panelMeta(p.key);
      return `<figure class="pcard${big ? ' big' : ''}" data-key="${esc(p.key)}"><figcaption><b>${esc(m.title)}</b>` +
        `${m.group ? ` <span class="muted small">${esc(m.group)}</span>` : ''}${m.desc ? `<small class="muted">${esc(m.desc)}</small>` : ''}</figcaption>` +
        `<img src="${esc(p.url)}" alt="${esc(m.title)} · unit ${esc(S.cur)}" loading="${big ? 'eager' : 'lazy'}" decoding="async"></figure>`;
    };
    pane.innerHTML = bar + (single
      ? card(all.find(p => p.key === single), true)
      : `<div class="pgrid" style="--cols:${isPhone() ? 1 : S.panelCols}">${shown.map(p => card(p, false)).join('')}</div>`);
    preloadPanels();
  }

  function setPanel(key) {
    S.panel = key;
    store.set('panel', key);
    if (S.view === 'panels') renderPanels();
  }
  function togglePanelMode() {
    if (S.view !== 'panels') { setView('panels'); return; }
    const all = unitPanels();
    setPanel(S.panel ? null : (all[0] && all[0].key) || null);
  }
  function stepPanel(d) {
    if (S.view !== 'panels') return;
    const all = unitPanels();
    if (!all.length) return;
    let i = all.findIndex(p => p.key === S.panel);
    i = i < 0 ? (d > 0 ? 0 : all.length - 1) : (i + d + all.length) % all.length;
    setPanel(all[i].key);
  }
  function preloadPanels() {
    if (!S.panel) return;
    const ids = S.filtered, i = ids.indexOf(S.cur);
    for (const d of [1, 2, -1]) {
      const u = S.byId.get(ids[i + d]), f = u && u.figures.panels;
      const p = f && f.panels.find(x => x.key === S.panel);
      if (p) getImg(p.url);
    }
  }

  $('panelPane').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b && b.dataset.pm) { setPanel(b.dataset.pm === 'grid' ? null : (S.panel || (unitPanels()[0] || {}).key || null)); return; }
    if (b && b.dataset.pstep) { stepPanel(Number(b.dataset.pstep)); return; }
    if (b && b.dataset.cols) { S.panelCols = Number(b.dataset.cols); store.set('panelCols', S.panelCols); renderPanels(); return; }
    if (b && b.dataset.pg != null) { S.panelGroup = b.dataset.pg; store.set('panelGroup', S.panelGroup); renderPanels(); return; }
    const c = e.target.closest('.pcard');
    if (c && !c.classList.contains('big')) setPanel(c.dataset.key);
  });
  $('panelPane').addEventListener('change', e => { if (e.target.matches('select[data-pick]')) setPanel(e.target.value); });

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
    const onSession = S.view === SESSION_VIEW.kind, onProbe = S.view === PROBE_VIEW.kind, onPanels = S.view === 'panels';
    box.hidden = onSession || onProbe || onPanels;
    $('sessionPane').hidden = !onSession;
    $('probePane').hidden = !onProbe;
    $('panelPane').hidden = !onPanels;
    renderStrip();
    if (onPanels) { spinner(false); renderPanels(); return; }
    if (onProbe) {
      spinner(false);
      if ($('ppBox')) renderProbePlot(); else renderProbe();  // a new unit: redraw the plot and its card
      return;
    }
    if (onSession) {
      spinner(false);
      if ($('tlBox')) renderSessionSvg(); else renderSession();  // a new unit: only its lane changes
      return;
    }
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
    if (i < 0 || S.view === SESSION_VIEW.kind) return;
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
  // dirty.nb, and save()'s / optimistic()'s first argument: nbTarget() of the notebook the edit belongs to
  const editingHere = () => document.activeElement === noteBox || (dirty && dirty.nb.key === curKey() && dirty.unit === S.cur);

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
  function optimistic(nb, unit, changes) {
    if (nb.key !== curKey()) return;
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

  function save(nb, unit, changes, keepalive = false) {
    pending++;
    setSave('saving');
    const body = Object.assign({sid: nb.sid, unit}, nb.sorting ? {sorting: nb.sorting} : {}, changes);
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await api('/api/note', {method: 'POST', keepalive, body: JSON.stringify(body)});
          pending--;
          if (!pending && nb.key === curKey()) {
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
    optimistic(d.nb, d.unit, {note: d.note});
    save(d.nb, d.unit, {note: d.note}, keepalive);
  }

  noteBox.addEventListener('input', () => {
    if (S.cur == null) return;
    dirty = {nb: nbTarget(), unit: S.cur, note: noteBox.value};
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
    optimistic(nbTarget(), S.cur, {tags});
    save(nbTarget(), S.cur, {tags});
    if (document.body.classList.contains('focus')) toast(`Unit ${S.cur}: ${k >= 0 ? '−' : '+'} ${tag}`, 1200);
  }

  function toggleFlag() {
    if (S.cur == null) return;
    flushNote();
    const e = entry(S.cur), flag = !(e && e.flag);
    optimistic(nbTarget(), S.cur, {flag});
    save(nbTarget(), S.cur, {flag});
    if (document.body.classList.contains('focus')) toast(`Unit ${S.cur}: ${flag ? '★ flagged' : 'flag removed'}`, 1200);
  }

  $('tagBtns').addEventListener('click', e => {
    const b = e.target.closest('button[data-i]');
    if (b) toggleTag(Number(b.dataset.i));
  });
  $('flag').addEventListener('click', toggleFlag);

  async function poll() {
    if (document.hidden || !S.sid || pending || dirty) return;
    const nb = nbTarget();
    try {
      const r = await api('/api/notebook?sid=' + encodeURIComponent(nb.sid) + sortingQuery(nb.sorting));
      if (nb.key !== curKey() || pending || dirty) return;
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

  /** Another sorting than the default goes in electro_gui's ?sorting= (and the state); the default's links carry neither. */
  function egLink(u) {
    const state = {session: S.sid, unit: u.id};
    if (S.sorting) state.sorting = S.sorting;
    if (u.quality && !EG_DEFAULT_Q.includes(u.quality)) state.unitQ = EG_DEFAULT_Q.concat([u.quality]);
    const url = new URL(S.eg.url);
    if (S.sorting) url.searchParams.set('sorting', S.sorting);
    else url.searchParams.delete('sorting');
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
  $('sorting').addEventListener('change', e => { openSession(S.sid, null, S.view, e.target.value || null); e.target.blur(); });

  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h.s && (h.s !== S.sid || h.so !== S.sorting) && S.sessions.some(s => s.id === h.s)) openSession(h.s, h.u, h.v, h.so);
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
      case ',': stepPanel(-1); break;
      case '.': stepPanel(1); break;
      case 'p': togglePanelMode(); break;
      case 'e': openEg(); break;
      case 'm': togglePanels(); break;
      case 's': cycleSort(); break;
      case 'S': setSort(S.sort.key, -S.sort.dir); break;
      case '?': showHelp(); break;
      case 'Escape':
        if (S.zoom) toggleZoom(false);
        else if (S.view === 'panels' && S.panel) setPanel(null);
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
