/* ============================================================================
 * MÓDULO 3 — Telemetría de conducción · Score de OPERACIÓN (no de seguridad)
 * PLAN_MAESTRO §4.3 · Snapshot v2 (DATA_CONTRACT.md)
 *
 * Consume:  data.registros (grano operador×unidad×día), data.meta.catalogo,
 *           data.unidades, data.semanas
 * Fórmula OPERACIÓN (propia de este módulo — NO altera el score de seguridad):
 *   PuntosOp     = Σ ( peso_hábito × n_eventos_extendido )
 *   PuntosOpX100h= PuntosOp / horas × 100
 *   ScoreOp      = FLOOR(95 − 0.005 × PuntosOpX100h), min 5, max 95
 *   (coeficiente 0.005 calibrado sobre el snapshot 2026-07: mediana ≈ 90,
 *    p75 ≈ 75, p90 ≈ 59, peor operador → 5)
 *
 * API pública:
 *   window.MODULOS.m3operacion.render(container, state)
 *   window.MODULOS.m3operacion.setConsejos(catalogo)   // inyección posterior
 *   window.MODULOS.m3operacion.opScore(extendido, horas) // reutilizable
 * ==========================================================================*/
(function () {
  'use strict';

  /* ---------- pesos por hábito (eventos "extendido" del snapshot) ---------- */
  var FAMILIAS = [
    { id: 'motor',   label: 'Eficiencia motor', css: 'fam-motor',
      pesos: { rpm_fuera_banda: 6, alto_consumo: 6, torque_bajo_rpm: 5, apagado_brusco: 8 } },
    { id: 'ralenti', label: 'Ralentí / Neutral', css: 'fam-ralenti',
      pesos: { ralenti_5min: 2, ralenti_15min: 5, neutral: 8 } },
    { id: 'clutch',  label: 'Clutch', css: 'fam-clutch',
      pesos: { clutch_arranque_alto: 3, clutch_parado: 4, clutch_movimiento: 6 } },
    { id: 'pedales', label: 'Pedales', css: 'fam-pedales',
      pesos: { freno_prolongado: 4, acelerador_brusco: 3, acelerador_detenido: 2 } }
  ];
  var PESOS = {};        // llave → peso
  var FAM_DE = {};       // llave → familia.id
  FAMILIAS.forEach(function (f) {
    Object.keys(f.pesos).forEach(function (k) { PESOS[k] = f.pesos[k]; FAM_DE[k] = f.id; });
  });
  /* hábitos que dañan la unidad (sección "Daño a la unidad") */
  var HABITOS_DANO = ['clutch_arranque_alto', 'clutch_parado', 'clutch_movimiento',
    'freno_prolongado', 'rpm_fuera_banda', 'torque_bajo_rpm', 'apagado_brusco', 'alto_consumo'];

  var COEF = 0.005;

  /* ---------- consejos (catálogo opcional) ---------- */
  var CONSEJOS = null;          // { llave_extendido: {titulo, consejo, felicitacion?} | string }
  var consejosFetched = false;
  var lastRender = null;        // {container, state} para re-render al inyectar consejos

  var CONSEJOS_FALLBACK = {
    rpm_fuera_banda:      'Mantener el motor dentro de la banda verde: subir de cambio antes de 1,800 rpm.',
    alto_consumo:         'Revoluciones fuera de banda verde disparan el consumo: anticipar y usar el cambio correcto.',
    torque_bajo_rpm:      'Exigir torque con rpm bajas fuerza el tren motriz: bajar un cambio antes de la pendiente.',
    apagado_brusco:       'Dejar enfriar el turbo 1–2 min en ralentí antes de apagar el motor.',
    ralenti_5min:         'Apagar el motor en esperas mayores a 5 minutos: el ralentí consume sin avanzar.',
    ralenti_15min:        'Ralentí prolongado (>15 min): programar apagado en esperas largas de patio.',
    neutral:              'No conducir en neutral: se pierde freno de motor y control, y no ahorra combustible.',
    clutch_arranque_alto: 'Arrancar con el cambio correcto y sin patinar el clutch: desgasta el disco.',
    clutch_parado:        'No mantener el clutch pisado detenido (>30 s): usar neutral y freno.',
    clutch_movimiento:    'Clutch presionado en movimiento (>20 s) quema el collarín: soltarlo por completo.',
    freno_prolongado:     'Freno pisado >10 s a velocidad cristaliza balatas: usar freno de motor y bajar cambio.',
    acelerador_brusco:    'Acelerar progresivo: los picos de pedal disparan consumo y esfuerzo mecánico.',
    acelerador_detenido:  'No acelerar con el vehículo detenido: desgaste sin trabajo útil.'
  };

  /* ================= utilidades ================= */
  /* ---------- iconos DASHTRAX: registro único aplicacion/iconos.js ---------- */
  function ico(kind, accent) {
    return window.ICONOS
      ? window.ICONOS.ic(kind, { cls: 'm3op-ic', accent: accent })
      : '<span class="ic m3op-ic"></span>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n, dec) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString('es-MX', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }
  function semanaISO(d) {
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    var w = Math.ceil(((t - y0) / 864e5 + 1) / 7);
    return t.getUTCFullYear() + '-W' + (w < 10 ? '0' + w : w);
  }
  function claseScore(s) {
    if (s == null) return 'sc-na';
    if (s >= 85) return 'sc-ok';
    if (s >= 70) return 'sc-warn';
    if (s >= 50) return 'sc-high';
    return 'sc-bad';
  }

  /* Estado de actividad (snapshot.estadoOperador, ver aplicacion/archivo.js).
     Se refresca en cada render; mismo patrón de badge/chip que M4 rankings. */
  var ESTADOS = {};
  function estadoOp(n) { var e = ESTADOS[n]; return e ? e.estado : 'activo'; }
  function badgeEstado(n) {
    var e = ESTADOS[n];
    if (!e || e.estado === 'activo') return '';
    var lbl = e.estado === 'inactivo' ? 'INACTIVO' : 'POSIBLE BAJA';
    return '<span class="op-est ' + e.estado + '" title="Última actividad: ' + esc(e.ultimaSemana || '—') +
      ' · ' + e.semanasSin + ' sem sin señal">' + lbl + '</span>';
  }

  /* ================= score de operación ================= */
  /* llavesActivas: null = todas; array = subconjunto (filtro #5 de eventos) */
  function opScore(extendido, horas, llavesActivas) {
    var puntos = 0, ext = extendido || {};
    for (var k in PESOS) {
      if (llavesActivas && llavesActivas.indexOf(k) < 0) continue;
      puntos += (ext[k] || 0) * PESOS[k];
    }
    if (!horas || horas <= 0) {
      return { puntos: puntos, x100h: puntos > 0 ? null : 0, score: puntos > 0 ? null : 95 };
    }
    var x = puntos / horas * 100;
    return { puntos: puntos, x100h: x, score: Math.max(5, Math.min(95, Math.floor(95 - COEF * x))) };
  }
  function puntosPorFamilia(extendido, llavesActivas) {
    var out = {}, ext = extendido || {};
    FAMILIAS.forEach(function (f) { out[f.id] = 0; });
    for (var k in PESOS) {
      if (llavesActivas && llavesActivas.indexOf(k) < 0) continue;
      out[FAM_DE[k]] += (ext[k] || 0) * PESOS[k];
    }
    return out;
  }

  /* ================= filtros (DATA_CONTRACT §filtros) ================= */
  function filtrar(data, f) {
    f = f || {};
    var regs = (data && data.registros) || [];
    var semAct = f.semanaActual === true ? semanaISO(new Date())
      : (typeof f.semanaActual === 'string' && f.semanaActual ? f.semanaActual : null);
    var sems = (f.semanasComparar && f.semanasComparar.length) ? f.semanasComparar : null;
    return regs.filter(function (r) {
      if (f.udn && r.udn !== f.udn) return false;
      if (f.cliente && r.cliente !== f.cliente) return false;
      if (f.operador && r.conductor !== f.operador) return false;
      if (f.vehiculo && r.vehicle_id !== f.vehiculo && r.placa !== f.vehiculo) return false;
      if (f.desde && r.fecha < f.desde) return false;
      if (f.hasta && r.fecha > f.hasta) return false;
      if (semAct && r.semana !== semAct) return false;
      if (sems && sems.indexOf(r.semana) < 0) return false;
      return true;
    });
  }
  /* filtro #5: si eventos[] trae llaves de "extendido" que pesan aquí, restringe */
  function llavesActivas(f) {
    if (!f || !f.eventos || !f.eventos.length) return null;
    var sel = f.eventos.filter(function (k) { return PESOS.hasOwnProperty(k); });
    return sel.length ? sel : null;
  }

  /* ================= agregación ================= */
  function nuevoAcum() {
    return { horas: 0, km: 0, viajes: 0, dias: {}, extendido: {}, categorias: {}, dtc: {}, unidades: {}, operadores: {} };
  }
  function acumular(a, r) {
    a.horas += r.horas || 0; a.km += r.km || 0; a.viajes += r.viajes || 0;
    a.dias[r.fecha] = 1;
    if (r.placa) a.unidades[r.placa] = 1;
    /* criterio central: los viajes sin identificar no cuentan como persona */
    if (r.conductor && (!r.sinIdentificar && r.esOperador !== false)) a.operadores[r.conductor] = 1;
    var k, ext = r.extendido || {}, cat = r.categorias || {};
    for (k in ext) a.extendido[k] = (a.extendido[k] || 0) + ext[k];
    for (k in cat) a.categorias[k] = (a.categorias[k] || 0) + cat[k];
    (r.dtc || []).forEach(function (d) {
      var id = (d.spn || '?') + '/' + (d.fmi || '?');
      var cur = a.dtc[id] || (a.dtc[id] = { spn: d.spn, fmi: d.fmi, desc: d.desc || '', n: 0 });
      cur.n += d.n || 1;
    });
  }
  function agruparPor(regs, keyFn) {
    var m = {};
    regs.forEach(function (r) {
      var k = keyFn(r); if (k == null) return;
      var a = m[k] || (m[k] = nuevoAcum());
      acumular(a, r);
    });
    return m;
  }

  /* ================= SVG builders (custom, sin librerías) ================= */
  function svgGauge(score, size) {
    size = size || 118;
    var r = (size - 18) / 2, cx = size / 2, cy = size / 2;
    var a0 = -220, a1 = 40, span = a1 - a0;
    function pt(a) {
      var rad = a * Math.PI / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    }
    function arc(from, to) {
      var p0 = pt(from), p1 = pt(to), large = (to - from) > 180 ? 1 : 0;
      return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
        ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
    }
    var frac = score == null ? 0 : Math.max(0, Math.min(1, (score - 5) / 90));
    var val = score == null ? '—' : score;
    var cls = claseScore(score);
    // marcas cada 15 unidades
    var ticks = '';
    for (var i = 0; i <= 6; i++) {
      var a = a0 + span * i / 6, p1 = pt(a), rad = a * Math.PI / 180;
      var p2 = [cx + (r - 5) * Math.cos(rad), cy + (r - 5) * Math.sin(rad)];
      ticks += '<line x1="' + p1[0].toFixed(1) + '" y1="' + p1[1].toFixed(1) +
        '" x2="' + p2[0].toFixed(1) + '" y2="' + p2[1].toFixed(1) + '" class="m3op-gauge-tick"/>';
    }
    return '<svg class="m3op-gauge ' + cls + '" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="Score de operación ' + esc(val) + '">' +
      '<path class="m3op-gauge-track" d="' + arc(a0, a1) + '"/>' +
      (frac > 0 ? '<path class="m3op-gauge-fill" d="' + arc(a0, a0 + span * frac) + '"/>' : '') +
      ticks +
      '<text class="m3op-gauge-val" x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle">' + esc(val) + '</text>' +
      '<text class="m3op-gauge-sub" x="' + cx + '" y="' + (cy + 20) + '" text-anchor="middle">/ 95</text>' +
      '</svg>';
  }

  function barraFamilias(fams, maxTotal, ancho) {
    ancho = ancho || 100;
    var total = 0; FAMILIAS.forEach(function (f) { total += fams[f.id] || 0; });
    if (!maxTotal) maxTotal = total || 1;
    var x = 0, segs = '', w;
    FAMILIAS.forEach(function (f) {
      w = maxTotal > 0 ? (fams[f.id] || 0) / maxTotal * ancho : 0;
      if (w > 0.15) {
        segs += '<rect class="m3op-seg ' + f.css + '" x="' + x.toFixed(2) + '" y="0" width="' + w.toFixed(2) + '" height="8" rx="1.5"></rect>';
        x += w + 0.6;
      }
    });
    return '<svg class="m3op-stack" viewBox="0 0 ' + (ancho + 2) + ' 8" preserveAspectRatio="none" aria-hidden="true">' + segs + '</svg>';
  }

  function sparkSemanas(pares, w, h) {
    /* pares: [{semana, score}] ordenados */
    w = w || 160; h = h || 42;
    var vals = pares.map(function (p) { return p.score; }).filter(function (v) { return v != null; });
    if (!vals.length) return '<span class="m3op-nodata">sin datos</span>';
    var pad = 6, n = pares.length;
    function X(i) { return n === 1 ? w / 2 : pad + (w - 2 * pad) * i / (n - 1); }
    function Y(v) { return h - pad - (h - 2 * pad) * (v - 5) / 90; }
    var d = '', dots = '';
    pares.forEach(function (p, i) {
      if (p.score == null) return;
      var x = X(i), y = Y(p.score);
      d += (d ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      dots += '<circle class="m3op-spark-dot ' + claseScore(p.score) + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3"></circle>' +
        '<text class="m3op-spark-lb" x="' + x.toFixed(1) + '" y="' + (h - 0.5) + '" text-anchor="middle">' + esc(p.semana.slice(5)) + '</text>' +
        '<text class="m3op-spark-v ' + claseScore(p.score) + '" x="' + x.toFixed(1) + '" y="' + (y - 6).toFixed(1) + '" text-anchor="middle">' + p.score + '</text>';
    });
    return '<svg class="m3op-spark" viewBox="0 0 ' + w + ' ' + (h + 10) + '" aria-hidden="true">' +
      '<path class="m3op-spark-line" d="' + d + '"/>' + dots + '</svg>';
  }

  /* ================= render ================= */
  function render(container, state) {
    lastRender = { container: container, state: state };
    var data = (state && state.data) || {};
    var filtros = (state && state.filtros) || {};
    var regs = filtrar(data, filtros);
    var act = llavesActivas(filtros);
    var catalogoExt = (data.meta && data.meta.catalogo && data.meta.catalogo.extendido) || {};

    // intento único de cargar consejos.json (si existe junto a la app)
    if (!consejosFetched && typeof fetch === 'function') {
      consejosFetched = true;
      fetch('consejos.json').then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j) setConsejos(j); })
        .catch(function () { /* opcional: no existe */ });
    }

    container.classList.add('m3op');
    if (!regs.length) {
      container.innerHTML =
        '<div class="m3op-head"><h2>Score de Operación</h2></div>' +
        '<div class="m3op-empty">Sin registros para los filtros seleccionados.</div>';
      return;
    }

    /* --- agregados --- */
    var flota = nuevoAcum(); regs.forEach(function (r) { acumular(flota, r); });
    var scFlota = opScore(flota.extendido, flota.horas, act);
    var famFlota = puntosPorFamilia(flota.extendido, act);
    var diasFlota = Object.keys(flota.dias).length;
    var kmViaje = flota.viajes ? flota.km / flota.viajes : null;
    var kmHora = flota.horas ? flota.km / flota.horas : null;
    var ralX100 = flota.horas ? ((flota.extendido.ralenti_5min || 0) + (flota.extendido.ralenti_15min || 0)) / flota.horas * 100 : null;

    /* ranking de PERSONAS: fuera los "SIN OPERADOR (unidad)" (criterio central) */
    var porOp = agruparPor(regs.filter(function (r) { return (!r.sinIdentificar && r.esOperador !== false); }),
      function (r) { return r.conductor; });
    var opsArr = Object.keys(porOp).map(function (n) {
      var a = porOp[n], sc = opScore(a.extendido, a.horas, act);
      return { nombre: n, a: a, sc: sc, fams: puntosPorFamilia(a.extendido, act) };
    });
    /* PETICIÓN 3 — ranking del PEOR al MEJOR: score de operación ascendente.
       Sin score medible (sin horas) va al final, no arriba. */
    opsArr.sort(function (x, y) {
      if (x.sc.score == null && y.sc.score == null) return x.nombre.localeCompare(y.nombre);
      if (x.sc.score == null) return 1;
      if (y.sc.score == null) return -1;
      return x.sc.score - y.sc.score || x.nombre.localeCompare(y.nombre);
    });
    /* ---- SOLO ACTIVOS POR DEFECTO (petición del cliente 2026-07-27) ----
     * Con el año entero cargado, el ranking mezcla cientos de bajas con la
     * plantilla viva. Por defecto solo rankean ACTIVOS (gap ≤1 semana según
     * snapshot.estadoOperador); los demás se anuncian en un chip visible —
     * NUNCA se ocultan en silencio. `opsTodos` conserva el universo completo
     * para que la selección de un operador no-activo siga funcionando. */
    ESTADOS = data.estadoOperador || {};
    var verBajas = container.__m3opVerBajas === true;
    var opsTodos = opsArr;
    var noActivos = opsArr.filter(function (o) { return estadoOp(o.nombre) !== 'activo'; });
    if (!verBajas) opsArr = opsArr.filter(function (o) { return estadoOp(o.nombre) === 'activo'; });

    var maxX100 = 0;
    opsArr.forEach(function (o) { if (o.sc.x100h != null && o.sc.x100h > maxX100) maxX100 = o.sc.x100h; });

    /* ---------------------------------------------------------------------
       SELECCIÓN LOCAL DE OPERADOR (petición del cliente): clic en el ranking
       enfoca a esa persona y TODO lo demás — KPIs, familias, tendencia,
       daño a la unidad y recomendaciones — se recalcula con SUS registros.
       Clic de nuevo (o el botón "volver a flota") restaura la vista de flota.
       --------------------------------------------------------------------- */
    var sel = container.__m3opSel || null;
    var selObj = null;
    if (sel) {
      /* buscar en el universo COMPLETO: un no-activo enfocado no pierde su selección */
      for (var si = 0; si < opsTodos.length; si++) if (opsTodos[si].nombre === sel) { selObj = opsTodos[si]; break; }
      if (!selObj) { sel = container.__m3opSel = null; }
    }
    var regsFoco = sel ? regs.filter(function (r) { return r.conductor === sel && (!r.sinIdentificar && r.esOperador !== false); }) : regs;
    var focoAcum = sel ? selObj.a : flota;          // acumulado del foco
    var scFoco  = sel ? selObj.sc : scFlota;
    var famFoco = sel ? selObj.fams : famFlota;

    /* --- semanal (del foco) --- */
    var porSem = agruparPor(regsFoco, function (r) { return r.semana; });
    var semanas = Object.keys(porSem).sort();
    var serieSem = semanas.map(function (s) {
      return { semana: s, score: opScore(porSem[s].extendido, porSem[s].horas, act).score };
    });
    /* delta % de un indicador entre las dos últimas semanas del foco */
    function deltaSemanal(fn) {
      if (semanas.length < 2) return null;
      var a = fn(porSem[semanas[semanas.length - 2]]);
      var b = fn(porSem[semanas[semanas.length - 1]]);
      if (a == null || b == null || !isFinite(a) || !isFinite(b) || a === 0) return null;
      return (b - a) / Math.abs(a) * 100;
    }

    /* --- unidades (daño) — del foco: con operador elegido, SUS unidades --- */
    var porUni = agruparPor(regsFoco, function (r) { return r.placa || r.vehicle_id; });
    var uniInfo = {};
    ((data.unidades) || []).forEach(function (u) { uniInfo[u.placa] = u; });
    var unisArr = Object.keys(porUni).map(function (p) {
      var a = porUni[p], danio = 0;
      HABITOS_DANO.forEach(function (k) { danio += a.extendido[k] || 0; });
      var danioX100 = a.horas ? danio / a.horas * 100 : null;
      return {
        placa: p, a: a, danio: danio, danioX100: danioX100,
        dtcCat: (a.categorias.DTC || 0),
        dtcList: Object.keys(a.dtc).map(function (id) { return a.dtc[id]; }).sort(function (x, y) { return y.n - x.n; }),
        udn: (uniInfo[p] && uniInfo[p].udn) || ''
      };
    }).sort(function (x, y) { return (y.dtcCat - x.dtcCat) || (y.danio - x.danio); });

    /* --- top hábitos (para recomendaciones) — del FOCO: con un operador
       seleccionado, los consejos hablan de SUS eventos dominantes --- */
    var habitosOrden = Object.keys(PESOS).filter(function (k) { return !act || act.indexOf(k) >= 0; })
      .map(function (k) { return { k: k, n: focoAcum.extendido[k] || 0, pts: (focoAcum.extendido[k] || 0) * PESOS[k] }; })
      .sort(function (a, b) { return b.pts - a.pts; });

    /* --- métricas del foco (flota u operador seleccionado) --- */
    var kmViajeF = focoAcum.viajes ? focoAcum.km / focoAcum.viajes : null;
    var kmHoraF = focoAcum.horas ? focoAcum.km / focoAcum.horas : null;
    var ralF = (focoAcum.extendido.ralenti_5min || 0) + (focoAcum.extendido.ralenti_15min || 0);
    var ralX100F = focoAcum.horas ? ralF / focoAcum.horas * 100 : null;
    /* peor familia del foco (la que más puntos aporta) */
    var peorFamFoco = null, peorFamPts = 0;
    FAMILIAS.forEach(function (f) { if ((famFoco[f.id] || 0) > peorFamPts) { peorFamPts = famFoco[f.id]; peorFamFoco = f; } });

    /* chip de delta vs semana previa del foco */
    function chipSem(pct, invertir) {
      if (pct == null || !isFinite(pct)) return '';
      if (Math.abs(pct) < 0.05) return '<span class="m3op-kd eq mono">＝ igual vs sem. previa</span>';
      var bueno = invertir == null ? null : (invertir ? pct < 0 : pct > 0);
      var cls = bueno == null ? 'neu' : (bueno ? 'up' : 'down');
      return '<span class="m3op-kd ' + cls + ' mono">' + (pct > 0 ? '▲ +' : '▼ ') +
        fmt(pct, Math.abs(pct) < 10 ? 1 : 0) + '% vs sem. previa</span>';
    }

    /* ================= HTML ================= */
    var h = '';
    h += '<div class="m3op-head"><div><h2>Score de Operación</h2>' +
      '<div class="m3op-sub">EFICIENCIA · HÁBITOS · APROVECHAMIENTO — DISTINTO AL SCORE DE SEGURIDAD</div></div>' +
      '<div class="m3op-formula mono" title="Pesos por hábito: motor 5–8 · ralentí 2–8 · clutch 3–6 · pedales 2–4">' +
      'ScoreOp = ⌊95 − 0.005 · Pts/100h⌋ &nbsp;[5..95]</div></div>';

    /* barra de selección: SIEMPRE visible quién manda en la vista */
    if (sel) {
      h += '<div class="m3op-selbar" role="status">' + ico('operadores') +
        '<span class="m3op-selbar-t">Viendo a <b>' + esc(sel) + '</b>' + badgeEstado(sel) +
        '<span class="m3op-selbar-sc mono ' + claseScore(scFoco.score) + '">score ' + (scFoco.score == null ? '—' : scFoco.score) + '</span>' +
        '<span class="m3op-selbar-n mono">' + fmt(focoAcum.horas, 1) + ' h · ' + fmt(focoAcum.km, 0) + ' km · ' +
        fmt(Object.keys(focoAcum.unidades).length) + ' unidad(es)</span></span>' +
        '<button type="button" class="m3op-selbar-x mono" data-m3op-clear>✕ Volver a flota</button></div>';
    }

    /* KPIs — con contexto: delta vs semana previa + peor familia del foco */
    h += '<div class="m3op-kpis">';
    h += '<div class="m3op-kpi m3op-kpi-gauge ' + claseScore(scFoco.score) + '">' + svgGauge(scFoco.score) +
      '<div class="m3op-kpi-cap">' + ico('motor') + (sel ? 'SCORE DE ' + esc(sel.split(' ')[0]) : 'SCORE OPERACIÓN') +
      '<span class="m3op-kpi-note">' + (scFoco.x100h != null ? fmt(scFoco.x100h, 1) + ' pts/100h' : 'sin horas') + '</span></div>' +
      (peorFamFoco ? '<span class="m3op-kd fam mono"><i class="m3op-famdot ' + peorFamFoco.css + '"></i>peor familia: ' +
        esc(peorFamFoco.label) + ' · ' + fmt(peorFamPts) + ' pts</span>' : '') + '</div>';
    function kpi(v, unit, cap, note, icono, extra, tono) {
      return '<div class="m3op-kpi' + (tono ? ' ' + tono : '') + '"><div class="m3op-kpi-v mono">' + v +
        (unit ? '<span class="m3op-kpi-u">' + unit + '</span>' : '') + '</div>' +
        '<div class="m3op-kpi-cap">' + (icono ? ico(icono) : '') + cap +
        (note ? '<span class="m3op-kpi-note">' + note + '</span>' : '') + '</div>' +
        (extra || '') + '</div>';
    }
    h += kpi(fmt(kmViajeF, 1), ' km', 'KM / VIAJE', fmt(focoAcum.viajes) + ' viajes', 'viajes',
      chipSem(deltaSemanal(function (a) { return a.viajes ? a.km / a.viajes : null; }), null));
    h += kpi(fmt(kmHoraF, 1), ' km/h', 'APROVECHAMIENTO', fmt(focoAcum.km, 0) + ' km · ' + fmt(focoAcum.horas, 1) + ' h', 'distancia',
      chipSem(deltaSemanal(function (a) { return a.horas ? a.km / a.horas : null; }), false));
    h += kpi(fmt(ralX100F, 1), '', 'RALENTÍ / 100 H', fmt(ralF) + ' eventos', 'combustible',
      chipSem(deltaSemanal(function (a) {
        var r = (a.extendido.ralenti_5min || 0) + (a.extendido.ralenti_15min || 0);
        return a.horas ? r / a.horas * 100 : null;
      }), true),
      ralX100F == null ? '' : (ralX100F >= 40 ? 'sc-bad' : ralX100F >= 20 ? 'sc-high' : ''));
    h += sel
      ? kpi(fmt(Object.keys(focoAcum.unidades).length), '', 'UNIDADES QUE MANEJÓ',
          fmt(Object.keys(focoAcum.dias).length) + ' días activos · ' + fmt(focoAcum.viajes) + ' viajes', 'operadores', '')
      : kpi(fmt(opsArr.length), '', 'OPERADORES' + (verBajas ? '' : ' ACTIVOS'),
          fmt(diasFlota) + ' días · ' + fmt(Object.keys(porUni).length) + ' unidades' +
          (!verBajas && noActivos.length ? ' · +' + noActivos.length + ' bajas' : ''), 'operadores',
          chipSem(deltaSemanal(function (a) { return Object.keys(a.operadores).length || null; }), null));
    h += '</div>';

    /* ---- desglose por familia (con vista expandida POR SUBCATEGORÍA) ---- */
    function htmlFams(expandido) {
      var out = '';
      var famTotal = 0; FAMILIAS.forEach(function (f) { famTotal += famFoco[f.id]; });
      if (!expandido) {
        FAMILIAS.forEach(function (f) {
          var v = famFoco[f.id], pct = famTotal ? v / famTotal * 100 : 0;
          out += '<div class="m3op-famrow"><span class="m3op-famdot ' + f.css + '"></span>' +
            '<span class="m3op-famlb">' + esc(f.label) + '</span>' +
            '<span class="m3op-fambar"><span class="m3op-famfill ' + f.css + '" style="width:' + pct.toFixed(1) + '%"></span></span>' +
            '<span class="m3op-famv mono">' + fmt(v) + ' pts · ' + fmt(pct, 0) + '%</span></div>';
        });
        return out;
      }
      /* EXPANDIDO: desglose por subcategoría de evento (todas las llaves con
         peso), agrupado por familia — no las mismas 4 barras más grandes. */
      var maxPts = 1;
      FAMILIAS.forEach(function (f) {
        Object.keys(f.pesos).forEach(function (k) {
          var p = (focoAcum.extendido[k] || 0) * PESOS[k];
          if (p > maxPts) maxPts = p;
        });
      });
      FAMILIAS.forEach(function (f) {
        var v = famFoco[f.id], pct = famTotal ? v / famTotal * 100 : 0;
        out += '<div class="m3op-famgrp"><div class="m3op-famrow cab"><span class="m3op-famdot ' + f.css + '"></span>' +
          '<span class="m3op-famlb"><b>' + esc(f.label) + '</b></span>' +
          '<span class="m3op-famv mono"><b>' + fmt(v) + ' pts · ' + fmt(pct, 0) + '%</b></span></div>';
        Object.keys(f.pesos).forEach(function (k) {
          if (act && act.indexOf(k) < 0) return;
          var n = focoAcum.extendido[k] || 0, p = n * PESOS[k];
          var w = p / maxPts * 100;
          out += '<div class="m3op-famrow sub"><span class="m3op-famdot ' + f.css + '"></span>' +
            '<span class="m3op-famlb">' + esc(catalogoExt[k] || k) + '</span>' +
            '<span class="m3op-fambar"><span class="m3op-famfill ' + f.css + '" style="width:' + w.toFixed(1) + '%"></span></span>' +
            '<span class="m3op-famv mono">' + fmt(n) + ' ev × ' + PESOS[k] + ' = <b>' + fmt(p) + ' pts</b></span></div>';
        });
        out += '</div>';
      });
      return out;
    }

    /* desglose por familia + tendencia semanal */
    var sufSel = sel ? ' · ' + esc(sel) : '';
    h += '<div class="m3op-row2">';
    h += '<section class="m3op-panel" id="m3op-g-fams" data-graf="Puntos por familia de hábito' + sufSel + '"><h3>' + ico('motor') + 'Puntos por familia de hábito' + sufSel + '</h3>' +
      '<div class="m3op-fams" data-graf-lienzo>' + htmlFams(false) + '</div></section>';
    h += '<section class="m3op-panel" id="m3op-g-tend" data-graf="Tendencia semanal del score de operación' + sufSel + '"><h3>' + ico('tendencia') + 'Tendencia semanal' + sufSel +
      (filtros.semanasComparar && filtros.semanasComparar.length ? ' · comparativa' : '') + '</h3>' +
      '<div class="m3op-sparkwrap" data-graf-lienzo>' + sparkSemanas(serieSem, 300, 64) + '</div>';
    if (serieSem.length >= 2) {
      var a1 = serieSem[serieSem.length - 2].score, b1 = serieSem[serieSem.length - 1].score;
      if (a1 != null && b1 != null) {
        var dlt = b1 - a1;
        h += '<div class="m3op-delta ' + (dlt >= 0 ? 'up' : 'down') + ' mono">' +
          (dlt >= 0 ? '▲ +' : '▼ ') + dlt + ' pts vs semana previa</div>';
      }
    }
    h += '</section></div>';

    /* ranking de operadores — clic = seleccionar (interactividad pedida) */
    var TOP = 15, verTodos = container.__m3opVerTodos === true;
    function htmlRanking(todos) {
      var lista = (filtros.operador || verTodos || todos) ? opsArr : opsArr.slice(0, TOP);
      /* el operador seleccionado siempre es visible, aunque no esté en el top */
      if (sel && selObj && lista.indexOf(selObj) < 0) lista = lista.concat([selObj]);
      var out = '';
      lista.forEach(function (o) {
        /* un no-activo enfocado no está en el ranking filtrado → sin posición */
        var rank = opsArr.indexOf(o) + 1;
        var esSel = (sel === o.nombre) || (filtros.operador === o.nombre);
        out += '<div class="m3op-oprow' + (esSel ? ' sel' : '') + '" data-op="' + esc(o.nombre) + '" role="button" tabindex="0"' +
          ' aria-pressed="' + (sel === o.nombre ? 'true' : 'false') + '"' +
          ' title="' + esc(sel === o.nombre ? 'Quitar selección y volver a flota' : 'Ver familias, recomendaciones y daño de ' + o.nombre) + '">' +
          '<span class="m3op-rk mono">' + (rank > 0 ? rank : '—') + '</span>' +
          '<span class="m3op-score mono ' + claseScore(o.sc.score) + '">' + (o.sc.score == null ? '—' : o.sc.score) + '</span>' +
          '<span class="m3op-opname" title="' + esc(o.nombre) + '">' + esc(o.nombre) + badgeEstado(o.nombre) + '</span>' +
          '<span class="m3op-opbar">' + barraFamilias(o.fams, maxX100 && o.a.horas ? maxX100 * o.a.horas / 100 : null, 100) + '</span>' +
          '<span class="m3op-opmeta mono">' + fmt(o.sc.x100h, 0) + ' p/100h · ' + fmt(o.a.horas, 1) + ' h · ' +
          fmt(o.a.viajes ? o.a.km / o.a.viajes : null, 1) + ' km/vj</span>' +
          '</div>';
      });
      return out;
    }
    h += '<section class="m3op-panel" id="m3op-g-rank" data-graf="Ranking de operadores — del peor al mejor"><h3>' + ico('ranking') + 'Ranking de operadores — score de operación <em class="m3op-sub">del peor al mejor · clic para enfocar' + (verBajas ? '' : ' · solo activos') + '</em>' +
      (noActivos.length ?
        '<button type="button" class="m3op-bajas mono' + (verBajas ? ' on' : '') + '" data-m3op-bajas ' +
          'title="Operadores sin actividad reciente (inactivos 2–4 sem · posible baja ≥5 sem)">' +
          (verBajas ? noActivos.length + ' inactivos/bajas VISIBLES · ocultar'
                    : '+' + noActivos.length + ' bajas ocultas · ver') + '</button>' : '') + '</h3>';
    h += '<div class="m3op-leyenda">';
    FAMILIAS.forEach(function (f) {
      h += '<span class="m3op-leg"><span class="m3op-famdot ' + f.css + '"></span>' + esc(f.label) + '</span>';
    });
    h += '</div><div class="m3op-ranking" data-graf-lienzo>' + htmlRanking(false) + '</div>';
    if (!filtros.operador && !sel && opsArr.length > TOP) {
      h += '<button type="button" class="m3op-vermas" data-m3op-toggle>' +
        (verTodos ? 'Ver top ' + TOP : 'Ver los ' + opsArr.length + ' operadores') + '</button>';
    }
    h += '</section>';

    /* daño a la unidad */
    h += '<section class="m3op-panel" id="m3op-g-danio" data-graf="Daño a la unidad' + sufSel + '"><h3>' + ico('diagnostico') + 'Daño a la unidad — diagnóstico y hábitos que dañan' +
      (sel ? ' <em class="m3op-sub">unidades operadas por ' + esc(sel) + '</em>' : '') + '</h3>';
    var unisDanio = unisArr.slice(0, 12);
    h += '<div class="m3op-tablewrap"><table class="m3op-table"><thead><tr>' +
      '<th>Unidad</th><th>UDN</th><th class="num">DTC</th><th class="num">Háb. dañinos</th>' +
      '<th class="num">Dañ./100h</th><th>Códigos SPN/FMI</th><th class="num">Ops.</th></tr></thead><tbody>';
    unisDanio.forEach(function (u) {
      var nOps = Object.keys(u.a.operadores).length;
      var codigos = u.dtcList.length
        ? u.dtcList.slice(0, 3).map(function (d) {
            return '<span class="m3op-dtc mono" title="' + esc(d.desc) + '">' + esc(d.spn) + '/' + esc(d.fmi) + '×' + d.n + '</span>';
          }).join(' ')
        : (u.dtcCat > 0 ? '<span class="m3op-dtc-pend">detalle vía cron</span>' : '<span class="m3op-nodata">—</span>');
      var danCls = u.danioX100 == null ? '' : (u.danioX100 >= 400 ? 'sc-bad' : u.danioX100 >= 150 ? 'sc-high' : u.danioX100 >= 50 ? 'sc-warn' : 'sc-ok');
      h += '<tr><td class="mono m3op-placa">' + esc(u.placa) + '</td>' +
        '<td class="m3op-udn">' + esc(u.udn) + '</td>' +
        '<td class="num mono' + (u.dtcCat ? ' sc-bad' : '') + '">' + fmt(u.dtcCat) + '</td>' +
        '<td class="num mono">' + fmt(u.danio) + '</td>' +
        '<td class="num mono ' + danCls + '">' + fmt(u.danioX100, 0) + '</td>' +
        '<td>' + codigos + '</td>' +
        '<td class="num mono" title="' + esc(Object.keys(u.a.operadores).sort().join(', ')) + '">' + nOps + '</td></tr>';
    });
    h += '</tbody></table></div>';
    h += '<div class="m3op-nota">Hábitos que dañan: clutch (arranque/parado/movimiento), freno prolongado, rpm fuera de banda, torque bajo rpm, alto consumo y apagado brusco. ' +
      'El testigo MIL y el detalle SPN/FMI histórico se completan con el cron (get_incremental_events); el backfill solo trae la categoría DTC.</div>';
    h += '</section>';

    /* recomendaciones — del FOCO: con operador elegido, SOLO sus hábitos */
    h += '<section class="m3op-panel"><h3>' + ico('llave') + 'Recomendaciones accionables' +
      (sel ? ' <em class="m3op-sub">para ' + esc(sel) + '</em>' : '') + '</h3><div class="m3op-consejos">';
    var topH = habitosOrden.filter(function (x) { return x.n > 0; }).slice(0, sel ? 6 : 4);
    if (!topH.length) {
      h += '<div class="m3op-consejo felic"><div class="m3op-consejo-t">Operación limpia</div>' +
        '<div class="m3op-consejo-b">' + (sel
          ? esc(sel) + ' no registra hábitos de riesgo operativo en el periodo filtrado. Reconocerlo.'
          : 'Sin hábitos de riesgo operativo en el periodo filtrado. Reconocer al equipo.') + '</div></div>';
    }
    topH.forEach(function (x) {
      var c = CONSEJOS && CONSEJOS[x.k];
      var titulo = catalogoExt[x.k] || x.k;
      var cuerpo = c ? (typeof c === 'string' ? c : (c.consejo || c.texto || '')) : (CONSEJOS_FALLBACK[x.k] || 'Reforzar capacitación sobre este hábito.');
      if (c && typeof c === 'object' && c.titulo) titulo = c.titulo;
      h += '<div class="m3op-consejo"><div class="m3op-consejo-t">' + esc(titulo) +
        '<span class="mono m3op-consejo-n">×' + fmt(x.n) + ' · ' + fmt(x.pts) + ' pts</span></div>' +
        '<div class="m3op-consejo-b">' + esc(cuerpo) + '</div></div>';
    });
    // mejor y peor operador del filtro (sólo en la vista de flota)
    if (!sel && opsArr.length >= 2) {
      var best = opsArr[0], worst = opsArr[opsArr.length - 1];
      if (best.sc.score != null) {
        h += '<div class="m3op-consejo felic"><div class="m3op-consejo-t">Reconocer · ' + esc(best.nombre) +
          '<span class="mono m3op-consejo-n">score ' + best.sc.score + '</span></div>' +
          '<div class="m3op-consejo-b">' +
          esc((CONSEJOS && CONSEJOS.__felicitacion) || 'Mejor score de operación del periodo: felicitar y compartir sus hábitos con el equipo.') +
          '</div></div>';
      }
      if (worst.sc.score != null && worst.sc.score < 70) {
        var peorFam = FAMILIAS.slice().sort(function (a, b) { return worst.fams[b.id] - worst.fams[a.id]; })[0];
        h += '<div class="m3op-consejo alerta"><div class="m3op-consejo-t">Corregir · ' + esc(worst.nombre) +
          '<span class="mono m3op-consejo-n">score ' + worst.sc.score + '</span></div>' +
          '<div class="m3op-consejo-b">Retroalimentación inmediata: su mayor carga de puntos está en ' +
          esc(peorFam.label.toLowerCase()) + '.</div></div>';
      }
    }
    h += '</div>' + (CONSEJOS ? '' : '<div class="m3op-nota">Catálogo de consejos genérico (deep-research pendiente). Inyectar con <code>MODULOS.m3operacion.setConsejos(catalogo)</code> o <code>aplicacion/consejos.json</code>.</div>') +
      '</section>';

    container.innerHTML = h;

    /* ---------- gráficas expandibles a primer plano (UIX) ----------
       El tercer argumento del contrato de redibujo es `expandido`: en grande
       cada gráfica MUESTRA MÁS, no solo se agranda. */
    if (window.UIX) {
      var gT = container.querySelector('#m3op-g-tend');
      if (gT) window.UIX.registrarGrafica(gT, function (w, hh) {
        gT.querySelector('[data-graf-lienzo]').innerHTML =
          /* hh = 0 en reposo → se mantiene el alto de diseño (64 px) */
          sparkSemanas(serieSem, Math.max(280, w), hh ? Math.max(120, Math.min(hh, 460)) : 64);
      });
      var gF = container.querySelector('#m3op-g-fams');
      if (gF) window.UIX.registrarGrafica(gF, function (w, hh, expandido) {
        /* expandido: desglose por SUBCATEGORÍA (todas las llaves con peso),
           no las mismas 4 barras estiradas */
        gF.querySelector('[data-graf-lienzo]').innerHTML = htmlFams(!!expandido);
      });
      var gR = container.querySelector('#m3op-g-rank');
      if (gR) window.UIX.registrarGrafica(gR, function (w, hh, expandido) {
        /* expandido: el ranking COMPLETO, no el top 15 */
        gR.querySelector('[data-graf-lienzo]').innerHTML = htmlRanking(!!expandido);
      });
      var gD = container.querySelector('#m3op-g-danio');
      if (gD) window.UIX.registrarGrafica(gD, null);   // tabla fluida
    }

    var btn = container.querySelector('[data-m3op-toggle]');
    if (btn) btn.addEventListener('click', function () {
      container.__m3opVerTodos = !verTodos;
      render(container, state);
    });
    var btnBajas = container.querySelector('[data-m3op-bajas]');
    if (btnBajas) btnBajas.addEventListener('click', function () {
      container.__m3opVerBajas = !verBajas;
      render(container, state);
    });

    /* selección de operador: delegación sobre el contenedor, UNA sola vez
       (el contenedor sobrevive a los re-render; las filas no) */
    if (!container.__m3opDeleg) {
      container.__m3opDeleg = true;
      var toggleOp = function (nombre) {
        container.__m3opSel = (container.__m3opSel === nombre) ? null : nombre;
        if (window.UIX && window.UIX.cerrarExpandida) window.UIX.cerrarExpandida();
        if (lastRender) render(lastRender.container, lastRender.state);
      };
      container.addEventListener('click', function (ev) {
        var clear = ev.target.closest('[data-m3op-clear]');
        if (clear && container.contains(clear)) { toggleOp(container.__m3opSel); return; }
        var row = ev.target.closest('.m3op-oprow[data-op]');
        if (row && container.contains(row)) toggleOp(row.getAttribute('data-op'));
      });
      container.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        var row = ev.target.closest && ev.target.closest('.m3op-oprow[data-op]');
        if (row) { ev.preventDefault(); toggleOp(row.getAttribute('data-op')); }
      });
    }
  }

  function setConsejos(catalogo) {
    CONSEJOS = catalogo || null;
    if (lastRender && lastRender.container && lastRender.container.isConnected) {
      render(lastRender.container, lastRender.state);
    }
  }

  window.MODULOS = window.MODULOS || {};
  window.MODULOS.m3operacion = {
    id: 'm3operacion',
    titulo: 'Operación',
    render: render,
    setConsejos: setConsejos,
    opScore: opScore,
    _internals: { filtrar: filtrar, FAMILIAS: FAMILIAS, PESOS: PESOS, COEF: COEF }
  };
})();
