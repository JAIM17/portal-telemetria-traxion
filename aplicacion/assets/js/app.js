/* Reportes Conductores · runtime del panel (vanilla, estilo DASHTRAX) */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const state = {
    view: 'trips',            // trips | events
    data: { updated_at: null, range: '—', trips: [], events: [] },
    search: '',
    grupo: '',
    evento: '',
    sort: { trips: { key: 'distancia_km', dir: -1 }, events: { key: 'cantidad', dir: -1 } },
  };

  /* ---------- utilidades ---------- */
  const hmsToSec = (v) => {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v > 3 ? v : Math.round(v * 86400); // fracción de día de Excel
    const p = String(v).trim().split(':').map(Number);
    if (p.some(isNaN)) return 0;
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 3600 + p[1] * 60 : p[0];
  };
  const secToHms = (s) => {
    s = Math.max(0, Math.round(s));
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map((n, i) => String(n).padStart(i ? 2 : 2, '0')).join(':');
  };
  const num = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
    return isNaN(n) ? 0 : n;
  };
  const fmt = (n, d = 0) => n.toLocaleString('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d });
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  /* ---------- columnas por vista ---------- */
  const COLS = {
    trips: [
      { key: 'conductor', label: 'Conductor' },
      { key: 'grupo', label: 'Grupo' },
      { key: 'recuento_de_viajes', label: 'Viajes', num: true },
      { key: 'tiempo_de_inactividad', label: 'T. inactividad', num: true, time: true },
      { key: 'tiempo_neto_de_conduccion', label: 'T. neto conducción', num: true, time: true },
      { key: 'distancia_km', label: 'Distancia (km)', num: true, dec: 1 },
    ],
    events: [
      { key: 'conductor', label: 'Conductor' },
      { key: 'grupo', label: 'Grupo' },
      { key: 'evento', label: 'Evento' },
      { key: 'cantidad', label: 'Cantidad', num: true },
    ],
  };

  /* ---------- encabezados flexibles (exportaciones Traffilog ES/EN) ---------- */
  const HEADER_MAP = [
    { re: /(nombre del conductor|conductor|driver name|driver)/, key: 'conductor' },
    { re: /(nombre del grupo|grupo|group)/, key: 'grupo' },
    { re: /(recuento de viajes|viajes|trip count|trips)/, key: 'recuento_de_viajes' },
    { re: /(inactividad|idle)/, key: 'tiempo_de_inactividad' },
    { re: /(neto de conduccion|net driving|conduccion)/, key: 'tiempo_neto_de_conduccion' },
    { re: /(distancia|distance|km conducidos)/, key: 'distancia_km' },
    { re: /(nombre del evento|evento|event name|event)/, key: 'evento' },
    { re: /(recuento|cantidad|count|quantity|qty)/, key: 'cantidad' },
  ];
  const mapHeader = (h) => HEADER_MAP.find((m) => m.re.test(norm(h)))?.key ?? null;

  /* ---------- carga de datos ---------- */
  async function loadJson() {
    try {
      const res = await fetch('data/data.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      applyData(await res.json(), 'data.json');
    } catch {
      // Abierto como file:// o sin data.json publicado: el panel queda vacío, listo para importar.
      applyData(state.data, 'sin data.json — usa Importar Excel/CSV');
    }
  }

  function applyData(data, label) {
    state.data = {
      updated_at: data.updated_at ?? null,
      range: data.range ?? '—',
      trips: (data.trips ?? []).map((t) => ({
        conductor: t.conductor ?? '', grupo: t.grupo ?? '',
        recuento_de_viajes: num(t.recuento_de_viajes),
        tiempo_de_inactividad: typeof t.tiempo_de_inactividad === 'string' ? t.tiempo_de_inactividad : secToHms(hmsToSec(t.tiempo_de_inactividad)),
        tiempo_neto_de_conduccion: typeof t.tiempo_neto_de_conduccion === 'string' ? t.tiempo_neto_de_conduccion : secToHms(hmsToSec(t.tiempo_neto_de_conduccion)),
        distancia_km: num(t.distancia_km),
      })),
      events: (data.events ?? []).map((e) => ({
        conductor: e.conductor ?? '', grupo: e.grupo ?? '', evento: e.evento ?? '', cantidad: num(e.cantidad),
      })),
    };
    $('#rcRange').textContent = state.data.range;
    $('#rcUpdated').textContent = state.data.updated_at
      ? `Actualizado ${new Date(state.data.updated_at).toLocaleString('es-MX')} · ${label}`
      : label;
    fillFilters();
    render();
  }

  /* ---------- filtros ---------- */
  function fillFilters() {
    const opts = (values, sel, keep) => {
      const cur = keep ?? '';
      sel.innerHTML = '<option value="">Todos</option>' +
        [...new Set(values.filter(Boolean))].sort().map((v) => `<option${v === cur ? ' selected' : ''}>${v}</option>`).join('');
    };
    opts([...state.data.trips, ...state.data.events].map((r) => r.grupo), $('#fGrupo'), state.grupo);
    opts(state.data.events.map((r) => r.evento), $('#fEvento'), state.evento);
  }

  function filteredRows() {
    const rows = state.data[state.view];
    const q = norm(state.search);
    return rows.filter((r) =>
      (!q || norm(r.conductor).includes(q)) &&
      (!state.grupo || r.grupo === state.grupo) &&
      (state.view !== 'events' || !state.evento || r.evento === state.evento)
    );
  }

  /* ---------- render ---------- */
  function render() {
    const cols = COLS[state.view];
    const sort = state.sort[state.view];
    const rows = filteredRows().slice().sort((a, b) => {
      const col = cols.find((c) => c.key === sort.key) ?? cols[0];
      const va = col.time ? hmsToSec(a[col.key]) : a[col.key];
      const vb = col.time ? hmsToSec(b[col.key]) : b[col.key];
      return (col.num ? va - vb : String(va).localeCompare(String(vb), 'es')) * sort.dir;
    });

    renderKpis(rows);
    renderTable(rows, cols, sort);
    renderChart(rows);

    $('#tblTitle').textContent = state.view === 'trips'
      ? 'Resumen de Viajes de Conductores' : 'Resumen de Eventos de Conductores';
    $('#chartTitle').textContent = state.view === 'trips'
      ? 'Top conductores por distancia (km)' : 'Eventos por tipo';
    $('#fEventoWrap').hidden = state.view !== 'events';
  }

  function renderKpis(rows) {
    let kpis;
    if (state.view === 'trips') {
      const viajes = rows.reduce((s, r) => s + r.recuento_de_viajes, 0);
      const km = rows.reduce((s, r) => s + r.distancia_km, 0);
      const neto = rows.reduce((s, r) => s + hmsToSec(r.tiempo_neto_de_conduccion), 0);
      const idle = rows.reduce((s, r) => s + hmsToSec(r.tiempo_de_inactividad), 0);
      kpis = [
        [fmt(rows.length), 'Conductores'],
        [fmt(viajes), 'Viajes'],
        [fmt(km, 1), 'Km conducidos'],
        [secToHms(neto), 'T. neto conducción'],
        [secToHms(idle), 'T. inactividad'],
        [viajes ? fmt(km / viajes, 1) : '0', 'Km por viaje'],
      ];
    } else {
      const total = rows.reduce((s, r) => s + r.cantidad, 0);
      const conductores = new Set(rows.map((r) => r.conductor)).size;
      const tipos = new Set(rows.map((r) => r.evento)).size;
      kpis = [
        [fmt(total), 'Eventos totales'],
        [fmt(conductores), 'Conductores'],
        [fmt(tipos), 'Tipos de evento'],
        [conductores ? fmt(total / conductores, 1) : '0', 'Eventos por conductor'],
      ];
    }
    $('#rcKpis').innerHTML = kpis.map(([v, l]) => `<div class="rc-kpi"><b>${v}</b><span>${l}</span></div>`).join('');
  }

  function renderTable(rows, cols, sort) {
    $('#rcTable thead').innerHTML = '<tr>' + cols.map((c) =>
      `<th data-key="${c.key}" class="${c.num ? 'num' : ''}">${c.label}${sort.key === c.key ? ` <span class="dir">${sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`
    ).join('') + '</tr>';
    $('#rcTable tbody').innerHTML = rows.map((r) => '<tr>' + cols.map((c) => {
      const v = r[c.key];
      const text = c.num && !c.time ? fmt(num(v), c.dec ?? 0) : v;
      return `<td class="${c.num ? 'num' : ''}">${text}</td>`;
    }).join('') + '</tr>').join('');
    $('#rcEmpty').hidden = rows.length > 0;
  }

  function renderChart(rows) {
    let items;
    if (state.view === 'trips') {
      items = rows.slice().sort((a, b) => b.distancia_km - a.distancia_km).slice(0, 10)
        .map((r) => [r.conductor, r.distancia_km, fmt(r.distancia_km, 1)]);
    } else {
      const byType = new Map();
      rows.forEach((r) => byType.set(r.evento, (byType.get(r.evento) ?? 0) + r.cantidad));
      items = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, fmt(v)]);
    }
    const max = Math.max(1, ...items.map((i) => i[1]));
    $('#rcChart').innerHTML = items.map(([lbl, v, txt]) =>
      `<div class="rc-bar"><span class="lbl" title="${lbl}">${lbl}</span><span class="trk"><span class="fil" style="width:${(v / max) * 100}%"></span></span><span class="val">${txt}</span></div>`
    ).join('') || '<p class="rc-empty">Sin datos.</p>';
  }

  /* ---------- importación Excel / CSV ---------- */
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',' || ch === ';') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((c) => c.trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    return rows;
  }

  function ingestRows(rows, fileName) {
    // Busca la fila de encabezados (las exportaciones traen filas de título arriba).
    let hIdx = -1, keys = [];
    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const mapped = rows[i].map(mapHeader);
      if (mapped.filter(Boolean).length >= 3) { hIdx = i; keys = mapped; break; }
    }
    if (hIdx < 0) { alert('No reconocí los encabezados del archivo. ¿Es una exportación de "Resumen de Viajes/Eventos de Conductores"?'); return; }

    const recs = rows.slice(hIdx + 1).map((r) => {
      const o = {};
      keys.forEach((k, i) => { if (k && o[k] === undefined) o[k] = r[i]; });
      return o;
    }).filter((o) => o.conductor && String(o.conductor).trim());

    const isEvents = keys.includes('evento');
    if (isEvents) {
      state.data.events = recs.map((o) => ({
        conductor: String(o.conductor).trim(), grupo: String(o.grupo ?? '').trim(),
        evento: String(o.evento).trim(), cantidad: num(o.cantidad),
      }));
      state.view = 'events';
    } else {
      state.data.trips = recs.map((o) => ({
        conductor: String(o.conductor).trim(), grupo: String(o.grupo ?? '').trim(),
        recuento_de_viajes: num(o.recuento_de_viajes),
        tiempo_de_inactividad: secToHms(hmsToSec(o.tiempo_de_inactividad)),
        tiempo_neto_de_conduccion: secToHms(hmsToSec(o.tiempo_neto_de_conduccion)),
        distancia_km: num(o.distancia_km),
      }));
      state.view = 'trips';
    }
    document.querySelectorAll('.rc-tab').forEach((t) => t.classList.toggle('on', t.dataset.view === state.view));
    $('#rcUpdated').textContent = `Importado ${fileName} · ${new Date().toLocaleString('es-MX')}`;
    fillFilters();
    render();
  }

  async function importFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv')) {
      ingestRows(parseCsv(await file.text()), file.name);
    } else if (typeof XLSX !== 'undefined') {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      ingestRows(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }), file.name);
    } else {
      alert('No se pudo cargar la librería XLSX (sin internet). Exporta el reporte como CSV.');
    }
  }

  /* ---------- eventos de UI ---------- */
  document.querySelectorAll('.rc-tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      state.view = tab.dataset.view;
      document.querySelectorAll('.rc-tab').forEach((t) => t.classList.toggle('on', t === tab));
      render();
    }));

  $('#fSearch').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#fGrupo').addEventListener('change', (e) => { state.grupo = e.target.value; render(); });
  $('#fEvento').addEventListener('change', (e) => { state.evento = e.target.value; render(); });

  $('#rcTable thead').addEventListener('click', (e) => {
    const th = e.target.closest('th'); if (!th) return;
    const sort = state.sort[state.view];
    if (sort.key === th.dataset.key) sort.dir *= -1;
    else { sort.key = th.dataset.key; sort.dir = COLS[state.view].find((c) => c.key === sort.key)?.num ? -1 : 1; }
    render();
  });

  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; });
  $('#btnReset').addEventListener('click', loadJson);

  // Drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) $('#rcDrop').hidden = false; });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth === 0) $('#rcDrop').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('#rcDrop').hidden = true;
    if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
  });

  // Tema claro/oscuro persistente
  const applyTheme = (t) => document.documentElement.setAttribute('data-theme', t);
  const savedTheme = localStorage.getItem('rc-theme');
  if (savedTheme) applyTheme(savedTheme);
  else if (matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark');
  $('#rcTheme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('rc-theme', next);
  });

  loadJson();
})();
