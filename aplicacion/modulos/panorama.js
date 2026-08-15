/* ============================================================================
 * MÓDULO 0 — PANORAMA · KPIs generales por Unidad de Negocio y Cliente
 * ----------------------------------------------------------------------------
 * window.MODULOS.panorama = { id, titulo, render(container, state) }
 *   state = { data, filtros }
 *     data    → snapshot v2 (docs/DATA_CONTRACT.md): registros, semanas, meta…
 *     filtros → los 8 filtros jerárquicos globales del portal
 *
 * QUÉ RESPONDE
 *   1. KPIs agregados del recorte activo, por UDN y por Cliente.
 *   2. Barras comparativas segmento vs segmento (periodo actual vs anterior).
 *   3. Tendencia por SEMANA ISO sobre TODO el histórico disponible.
 *   4. Patrón por DÍA de la semana (lunes..domingo) + mapa semana × día.
 *   5. Comparativas: semana vs semana, periodo vs periodo, segmento vs segmento.
 *   6. Selector de histórico: semana actual · últimas 4 · trimestre · año · todo.
 *
 * ── DECISIÓN DOCUMENTADA: cómo se calcula el SCORE de un segmento ───────────
 * El score de una UDN / cliente NO es la media simple de los scores de sus
 * operadores. Se **re-aplica la fórmula** sobre los agregados del segmento:
 *
 *      Puntos_seg = Σ puntos de todos sus registros
 *      X100h_seg  = Puntos_seg / Σ horas_netas * 100
 *      Score_seg  = FLOOR(95 - 0.003 * X100h_seg)      [5..95]
 *
 * Eso es exactamente una **ponderación por horas**: un operador con 40 h pesa
 * 40 veces más que uno con 1 h, y un operador de 0.2 h con un evento alto no
 * hunde a toda la UDN (que es lo que pasa con la media simple, porque su score
 * individual se va al mínimo 5). Es además lo que exige DATA_CONTRACT.md:
 * «después de filtrar, recalcular los agregados y el score con la fórmula —
 * nunca promediar scores». La fórmula es intocable y está validada contra
 * ABARCA MARQUEZ = 93 (455 pts / 402.78 x100h).
 * Idéntico criterio para el Score de Operación (pesos de telemetría extendida,
 * coef. 0.005) — misma implementación que el Módulo 3.
 * ========================================================================== */
(function () {
  "use strict";

  var ID = 'panorama';

  var LLAVES = ["AcAlto", "AcMed", "AcBajo", "FrAlto", "FrMed", "FrBajo",
                "GirAlto", "GirMed", "GirBajo", "VelAlto", "VelMed", "VelBajo"];

  /* Lunes-primero (ISO) */
  var DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  var DOW_L = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

  /* Score de operación — espejo del Módulo 3 (se prefiere su implementación viva) */
  var COEF_OP = 0.005;
  var PESOS_OP = {
    rpm_fuera_banda: 6, alto_consumo: 6, torque_bajo_rpm: 5, apagado_brusco: 8,
    ralenti_5min: 2, ralenti_15min: 5, neutral: 8,
    clutch_arranque_alto: 3, clutch_parado: 4, clutch_movimiento: 6,
    freno_prolongado: 4, acelerador_brusco: 3, acelerador_detenido: 2
  };

  /* Métricas del "lente" común (barras · tendencia · día de semana · mapa)
   * dir: +1 = más alto es mejor · -1 = más bajo es mejor · 0 = neutro (volumen) */
  var METRICAS = [
    { id: 'ev100h',   label: 'Eventos / 100 h',   corto: 'EV/100H', dec: 1, dir: -1, tipo: 'tasa' },
    { id: 'scoreSeg', label: 'Score seguridad',   corto: 'SCORE SEG', dec: 0, dir: 1, tipo: 'score' },
    { id: 'scoreOp',  label: 'Score operación',   corto: 'SCORE OP', dec: 0, dir: 1, tipo: 'score' },
    { id: 'evTotal',  label: 'Eventos',           corto: 'EVENTOS', dec: 0, dir: -1, tipo: 'vol' },
    { id: 'km',       label: 'Kilómetros',        corto: 'KM', dec: 0, dir: 0, tipo: 'vol' },
    { id: 'horas',    label: 'Horas de conducción', corto: 'HORAS', dec: 0, dir: 0, tipo: 'vol' },
    { id: 'operadores', label: 'Operadores activos', corto: 'OPERADORES', dec: 0, dir: 0, tipo: 'vol' },
    { id: 'unidades', label: 'Unidades',          corto: 'UNIDADES', dec: 0, dir: 0, tipo: 'vol' },
    { id: 'pctSinId', label: '% viajes sin identificar', corto: '% SIN ID', dec: 1, dir: -1, tipo: 'pct' },
    { id: 'pctFatiga', label: '% en riesgo de fatiga', corto: '% FATIGA', dec: 0, dir: -1, tipo: 'pct' }
  ];
  function metricaDe(id) {
    for (var i = 0; i < METRICAS.length; i++) if (METRICAS[i].id === id) return METRICAS[i];
    return METRICAS[0];
  }

  var SERIE_CLS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

  /* ========================= utilidades ==================================== */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n, d) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString('es-MX', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function fmtCompacto(n) {
    if (n == null || !isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e6) return fmt(n / 1e6, 1) + 'M';
    if (a >= 10000) return fmt(n / 1000, 0) + 'k';
    return fmt(n, 0);
  }
  function horasHM(h) {
    if (h == null || !isFinite(h)) return '—';
    var t = Math.round(h * 60), hh = Math.floor(t / 60), mm = t % 60;
    return fmt(hh) + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function semanaCorta(w) { var m = /W(\d+)$/.exec(String(w || '')); return m ? 'S' + m[1] : String(w || ''); }
  function anioDeSemana(w) { var m = /^(\d{4})-W/.exec(String(w || '')); return m ? m[1] : ''; }
  function dayNum(f) { return Math.floor(Date.UTC(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10)) / 864e5); }
  function fechaDe(n) { var d = new Date(n * 864e5); return d.toISOString().slice(0, 10); }
  function dowDe(f) { return (new Date(f + 'T00:00:00Z').getUTCDay() + 6) % 7; }   // 0 = lunes
  function fechaCorta(f) {
    if (!f) return '—';
    return f.slice(8, 10) + '/' + f.slice(5, 7);
  }
  function claseSeg(s) {
    if (s == null) return 'na';
    if (s >= 90) return 'ok'; if (s >= 70) return 'warn'; if (s >= 50) return 'high'; return 'bad';
  }
  function claseOp(s) {
    if (s == null) return 'na';
    if (s >= 85) return 'ok'; if (s >= 70) return 'warn'; if (s >= 50) return 'high'; return 'bad';
  }

  /* ========================= fórmulas ====================================== */
  /* Score de seguridad — FÓRMULA INTOCABLE (validada: ABARCA = 93) */
  function safetyScore(eventos, horas) {
    var alto = 0, med = 0, bajo = 0;
    for (var i = 0; i < LLAVES.length; i++) {
      var k = LLAVES[i], n = (eventos && +eventos[k]) || 0;
      if (k.indexOf('Alto') > 0) alto += n;
      else if (k.indexOf('Med') > 0) med += n;
      else bajo += n;
    }
    var puntos = alto * 50 + med * 25 + bajo * 5;
    if (!horas || horas <= 0) {
      return puntos === 0 ? { puntos: 0, x100h: 0, score: 95 } : { puntos: puntos, x100h: null, score: null };
    }
    var x = puntos / horas * 100;
    return { puntos: puntos, x100h: x, score: Math.max(5, Math.min(95, Math.floor(95 - 0.003 * x))) };
  }
  /* Score de operación — usa la implementación viva del M3 si está cargada */
  function opScore(ext, horas) {
    var m3 = window.MODULOS && window.MODULOS.m3operacion;
    if (m3 && typeof m3.opScore === 'function') return m3.opScore(ext || {}, horas, null);
    var puntos = 0, e = ext || {};
    for (var k in PESOS_OP) puntos += (e[k] || 0) * PESOS_OP[k];
    if (!horas || horas <= 0) return { puntos: puntos, x100h: puntos > 0 ? null : 0, score: puntos > 0 ? null : 95 };
    var x = puntos / horas * 100;
    return { puntos: puntos, x100h: x, score: Math.max(5, Math.min(95, Math.floor(95 - COEF_OP * x))) };
  }

  /* ================= filtros globales (los 8 jerárquicos) ================== */
  function filtrar(data, f) {
    var regs = (data && data.registros) || [];
    f = f || {};
    var sems = (f.semanasComparar && f.semanasComparar.length) ? f.semanasComparar.slice() : null;
    var act = typeof f.semanaActual === 'string' && f.semanaActual ? f.semanaActual : null;
    if (act) { sems = sems || []; if (sems.indexOf(act) < 0) sems.push(act); }
    return regs.filter(function (r) {
      if (f.udn && r.udn !== f.udn) return false;
      if (f.cliente && r.cliente !== f.cliente) return false;
      if (f.operador && r.conductor !== f.operador) return false;
      if (f.vehiculo && r.vehicle_id !== f.vehiculo && r.placa !== f.vehiculo) return false;
      if (f.desde && r.fecha < f.desde) return false;
      if (f.hasta && r.fecha > f.hasta) return false;
      if (sems && sems.indexOf(r.semana) < 0) return false;
      return true;
    });
  }

  /* ========================= agregación ==================================== */
  function nuevoAcc() {
    var ev = {}; for (var i = 0; i < LLAVES.length; i++) ev[LLAVES[i]] = 0;
    return { regs: 0, horas: 0, km: 0, viajes: 0, viajesSinId: 0, eventos: ev, evTotal: 0, ext: {},
             conExt: 0, ops: {}, veh: {}, dias: {}, semanas: {} };
  }
  function acum(a, r) {
    a.regs++;
    a.horas += (+r.horas) || 0; a.km += (+r.km) || 0; a.viajes += (+r.viajes) || 0;
    if (r.fecha) a.dias[r.fecha] = 1;
    if (r.semana) a.semanas[r.semana] = 1;
    /* criterio central: los "SIN OPERADOR (unidad)" NO son operadores — son
       viajes sin identificar. Cuentan como viaje/hora/km/evento (la telemetría
       es real) pero jamás como persona. */
    if (r.conductor && (!r.sinIdentificar && r.esOperador !== false)) a.ops[r.conductor] = 1;
    if (r.sinIdentificar) a.viajesSinId += (+r.viajes) || 0;
    var v = r.vehicle_id || r.placa; if (v) a.veh[v] = 1;
    for (var i = 0; i < LLAVES.length; i++) {
      var n = (r.eventos && +r.eventos[LLAVES[i]]) || 0;
      a.eventos[LLAVES[i]] += n; a.evTotal += n;
    }
    if (r.extendido) {
      var vacio = true;
      for (var k in r.extendido) { a.ext[k] = (a.ext[k] || 0) + ((+r.extendido[k]) || 0); vacio = false; }
      if (!vacio) a.conExt++;
    }
  }
  function cerrar(a) {
    var s = safetyScore(a.eventos, a.horas);
    a.puntos = s.puntos; a.x100h = s.x100h; a.scoreSeg = s.score;
    var o = opScore(a.ext, a.horas);
    a.opPuntos = o.puntos; a.opX100h = o.x100h; a.scoreOp = o.score;
    a.operadores = Object.keys(a.ops).length;
    a.unidades = Object.keys(a.veh).length;
    a.diasActivos = Object.keys(a.dias).length;
    a.nSemanas = Object.keys(a.semanas).length;
    a.ev100h = a.horas > 0 ? a.evTotal / a.horas * 100 : null;
    a.kmPorHora = a.horas > 0 ? a.km / a.horas : null;
    a.horasPorOp = a.operadores ? a.horas / a.operadores : null;
    a.pctSinId = a.viajes > 0 ? a.viajesSinId / a.viajes * 100 : null;
    a.pctFatiga = null;   // se inyecta aparte (necesita el rango del periodo)
    return a;
  }
  function agrupar(regs, campo) {
    var m = {};
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i], k = r[campo] || 'Sin asignar';
      if (!m[k]) m[k] = nuevoAcc();
      acum(m[k], r);
    }
    for (var k2 in m) cerrar(m[k2]);
    return m;
  }
  function totalDe(regs) {
    var a = nuevoAcc();
    for (var i = 0; i < regs.length; i++) acum(a, regs[i]);
    return cerrar(a);
  }
  function valorDe(a, met) {
    if (!a) return null;
    var v = a[met.id];
    return (v == null || !isFinite(v)) ? (met.tipo === 'vol' ? 0 : null) : v;
  }

  /* ==================== riesgo de fatiga (reusa el M2) ===================== */
  /* Criterio: operador ACTIVO cuya racha máxima de días consecutivos trabajados
   * dentro del periodo llega a 10 (umbral naranja del PLAN_MAESTRO §4.2).
   * Jornada = perfil "normal" del M2 (≥15 min y ≥5 km). Si el M2 no está
   * cargado, se devuelve null y la métrica se muestra como no disponible. */
  function coreCargas() {
    var m = window.MODULOS && window.MODULOS.cargas;
    return (m && m.core && typeof m.core.calcularCargas === 'function') ? m.core : null;
  }
  function fatigaDe(regs, desde, hasta, sinDatos) {
    var core = coreCargas();
    if (!core || !regs.length || !desde || !hasta) return null;
    /* fatiga = personas: los viajes sin identificar no forman rachas de nadie */
    regs = regs.filter(function (r) { return (!r.sinIdentificar && r.esOperador !== false); });
    var ops = core.calcularCargas(regs, {
      desde: desde, hasta: hasta,
      umbral: core.PERFILES[core.PERFIL_DEFAULT], sinDatos: sinDatos || {}
    });
    var act = ops.filter(function (o) { return o.diasTrabajados > 0; });
    var riesgo = act.filter(function (o) { return o.rachaMax >= 10; });
    return {
      ops: ops, activos: act.length, enRiesgo: riesgo.length,
      pct: act.length ? riesgo.length / act.length * 100 : 0
    };
  }

  /* ================= iconos DASHTRAX (2 tonos) =====================
   * Registro único del portal: aplicacion/iconos.js. Aquí sólo vive el
   * envoltorio con el prefijo del módulo; los paths NO se duplican. */
  function ico(kind, accent) {
    return window.ICONOS
      ? window.ICONOS.ic(kind, { cls: 'pn-ic', accent: accent })
      : '<span class="ic pn-ic"></span>';
  }

  /* ========================= delta ======================================== */
  function delta(cur, prev, met) {
    if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return null;
    if (met.tipo === 'score' || met.tipo === 'pct') return { v: cur - prev, txt: (cur - prev > 0 ? '+' : '') + fmt(cur - prev, met.tipo === 'pct' ? 1 : 0) + (met.tipo === 'pct' ? ' pp' : ' pts') };
    if (prev === 0) return cur === 0 ? { v: 0, txt: '=' } : { v: 1, txt: 'nuevo' };
    var p = (cur - prev) / Math.abs(prev) * 100;
    return { v: p, txt: (p > 0 ? '+' : '') + fmt(p, Math.abs(p) < 10 ? 1 : 0) + '%' };
  }
  function chipDelta(cur, prev, met) {
    var d = delta(cur, prev, met);
    if (!d) return '<span class="pn-d pn-d-na" title="sin periodo previo comparable">— s/d</span>';
    var casiCero = Math.abs(d.v) < 0.05;
    var bueno = met.dir === 0 ? null : (met.dir > 0 ? d.v > 0 : d.v < 0);
    var cls = casiCero ? 'eq' : (bueno == null ? 'neu' : (bueno ? 'good' : 'bad'));
    var fl = casiCero ? '＝' : (d.v > 0 ? '▲' : '▼');
    return '<span class="pn-d pn-d-' + cls + '">' + fl + ' ' + esc(d.txt) + '</span>';
  }

  /* ============================ GRÁFICAS ================================== */

  /* ---- sparkline (KPI) ---- */
  function sparkline(vals, dir) {
    var pts = vals.filter(function (v) { return v != null && isFinite(v); });
    if (pts.length < 2) return '<svg viewBox="0 0 120 26" class="pn-spark" aria-hidden="true"></svg>';
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    if (max === min) { max = min + 1; }
    var W = 120, H = 26, n = vals.length;
    var x = function (i) { return n === 1 ? W / 2 : 3 + i / (n - 1) * (W - 6); };
    var y = function (v) { return 22 - (v - min) / (max - min) * 18; };
    var d = '', area = '', primero = null, ultimo = null;
    for (var i = 0; i < n; i++) {
      var v = vals[i];
      if (v == null || !isFinite(v)) continue;
      var px = x(i), py = y(v);
      if (primero == null) primero = [px, py];
      ultimo = [px, py, v];
      d += (d ? ' L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    if (primero && ultimo) area = d + ' L' + ultimo[0].toFixed(1) + ' 26 L' + primero[0].toFixed(1) + ' 26 Z';
    var tend = pts[pts.length - 1] - pts[0];
    var cls = dir === 0 || Math.abs(tend) < 1e-9 ? 'neu' : ((dir > 0 ? tend > 0 : tend < 0) ? 'good' : 'bad');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="pn-spark pn-spark-' + cls + '" preserveAspectRatio="none" aria-hidden="true">' +
      (area ? '<path d="' + area + '" class="pn-spark-a"/>' : '') +
      '<path d="' + d + '" class="pn-spark-l"/>' +
      (ultimo ? '<circle cx="' + ultimo[0].toFixed(1) + '" cy="' + ultimo[1].toFixed(1) + '" r="2.4" class="pn-spark-p"/>' : '') +
      '</svg>';
  }

  /* ---- barras comparativas por segmento (actual vs periodo anterior) ----
   * W/H llegan en píxeles REALES del lienzo: al expandir la card, UIX vuelve a
   * llamar aquí con el tamaño nuevo y el SVG se regenera (más rejilla, barras
   * más anchas, etiquetas completas). No es un zoom. */
  function svgBarras(rows, met, etiquetaPrev, W0, H0, exp) {
    if (!rows.length) return '<div class="pn-empty">Sin segmentos con los filtros actuales</div>';
    var n = rows.length;
    var W = Math.max(360, Math.round(W0 || 760));
    var H = Math.max(210, Math.round(H0 || 262));
    var PT = 30, PB = 62, PL = 46, PR = 14;
    var ih = H - PT - PB, iw = W - PL - PR;
    var vals = [];
    rows.forEach(function (r) {
      if (r.act != null && isFinite(r.act)) vals.push(r.act);
      if (r.prev != null && isFinite(r.prev)) vals.push(r.prev);
    });
    var esScore = met.tipo === 'score';
    var vmax = vals.length ? Math.max.apply(null, vals) : 1;
    var vmin = esScore ? Math.min(5, Math.min.apply(null, vals.length ? vals : [95])) : 0;
    if (esScore) { vmin = Math.max(0, Math.floor((Math.min.apply(null, vals) - 6) / 10) * 10); vmax = 95; }
    if (vmax <= vmin) vmax = vmin + 1;
    var top = esScore ? vmax : vmax * 1.14;
    var y = function (v) { return PT + ih * (1 - (v - vmin) / (top - vmin)); };
    var cw = iw / n;
    var bw = Math.max(4, Math.min(cw * 0.34, 92));

    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="pn-svg pn-svg-barras" role="img" aria-label="Comparativa por segmento — ' + esc(met.label) + '">';
    /* rejilla — más divisiones cuando hay más alto real disponible */
    var nG = Math.max(4, Math.min(10, Math.round(ih / 46)));
    for (var g = 0; g <= nG; g++) {
      var vv = vmin + (top - vmin) * g / nG, gy = y(vv);
      out += '<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '" class="pn-grid"/>' +
        '<text x="' + (PL - 7) + '" y="' + (gy + 3.4).toFixed(1) + '" class="pn-ax pn-ax-r">' +
        (met.tipo === 'vol' ? fmtCompacto(vv) : fmt(vv, met.dec)) + '</text>';
    }
    rows.forEach(function (r, i) {
      var xc = PL + cw * (i + 0.5);
      var cls = esScore ? (met.id === 'scoreOp' ? claseOp(r.act) : claseSeg(r.act)) : 'lime';
      /* fantasma = periodo anterior */
      if (r.prev != null && isFinite(r.prev)) {
        var yp = y(r.prev);
        out += '<rect x="' + (xc - bw - 3).toFixed(1) + '" y="' + yp.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + Math.max(1.2, PT + ih - yp).toFixed(1) + '" rx="2" class="pn-bar-prev">' +
          '<title>' + esc(r.label) + ' · ' + esc(etiquetaPrev) + ': ' + fmt(r.prev, met.dec) + '</title></rect>';
        /* expandido: el periodo anterior también lleva su cifra visible */
        if (exp) out += '<text x="' + (xc - 3 - bw / 2).toFixed(1) + '" y="' + (yp - 6).toFixed(1) + '" class="pn-ax pn-ax-c pn-ax-dim">' +
          (met.tipo === 'vol' ? fmtCompacto(r.prev) : fmt(r.prev, met.dec)) + '</text>';
      }
      if (r.act != null && isFinite(r.act)) {
        var ya = y(r.act);
        out += '<rect x="' + (xc + 3).toFixed(1) + '" y="' + ya.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + Math.max(1.2, PT + ih - ya).toFixed(1) + '" rx="2" class="pn-bar pn-bar-' + cls + '">' +
          '<title>' + esc(r.label) + ' · periodo actual: ' + fmt(r.act, met.dec) + '</title></rect>';
        out += '<text x="' + (xc + 3 + bw / 2).toFixed(1) + '" y="' + (ya - 6).toFixed(1) + '" class="pn-ax pn-ax-c pn-ax-strong">' +
          (met.tipo === 'vol' ? fmtCompacto(r.act) : fmt(r.act, met.dec)) + '</text>';
      } else {
        out += '<text x="' + xc.toFixed(1) + '" y="' + (PT + ih / 2).toFixed(1) + '" class="pn-ax pn-ax-c pn-ax-dim">s/d</text>';
      }
      /* etiqueta + delta — el recorte depende del ancho real de la columna;
         expandido no se recorta salvo columnas realmente estrechas */
      var maxCh = Math.max(exp ? 14 : 6, Math.floor(cw / (exp ? 6.4 : 7.2)));
      var lbl = r.label.length > maxCh ? r.label.slice(0, maxCh - 1) + '…' : r.label;
      out += '<text x="' + xc.toFixed(1) + '" y="' + (PT + ih + 16) + '" class="pn-ax pn-ax-c pn-ax-seg">' + esc(lbl) +
        '<title>' + esc(r.label) + '</title></text>';
      var d = delta(r.act, r.prev, met);
      if (d) {
        var casiCero = Math.abs(d.v) < 0.05;
        var bueno = met.dir === 0 ? null : (met.dir > 0 ? d.v > 0 : d.v < 0);
        var dc = casiCero ? 'eq' : (bueno == null ? 'neu' : (bueno ? 'good' : 'bad'));
        out += '<text x="' + xc.toFixed(1) + '" y="' + (PT + ih + 31) + '" class="pn-ax pn-ax-c pn-dsvg pn-dsvg-' + dc + '">' +
          (casiCero ? '＝ ' : (d.v > 0 ? '▲ ' : '▼ ')) + esc(d.txt) + '</text>';
      }
      /* la nota (op · horas) sólo cabe si la columna es lo bastante ancha */
      if (cw > (exp ? 72 : 96)) out += '<text x="' + xc.toFixed(1) + '" y="' + (PT + ih + 45) + '" class="pn-ax pn-ax-c pn-ax-dim">' +
        esc(r.nota || '') + '</text>';
    });
    /* leyenda */
    out += '<rect x="' + PL + '" y="8" width="9" height="9" rx="1.5" class="pn-bar pn-bar-lime"/>' +
      '<text x="' + (PL + 14) + '" y="16" class="pn-ax">periodo actual</text>' +
      '<rect x="' + (PL + 108) + '" y="8" width="9" height="9" rx="1.5" class="pn-bar-prev"/>' +
      '<text x="' + (PL + 122) + '" y="16" class="pn-ax">' + esc(etiquetaPrev) + '</text>';
    out += '</svg>';
    return out;
  }

  /* ---- tendencia semanal multiserie sobre TODO el histórico ---- */
  function svgTendencia(semanas, series, selSet, met, ocultas, W0, H0, exp) {
    if (!semanas.length) return '<div class="pn-empty">Sin semanas en el histórico disponible</div>';
    var W = Math.max(420, Math.round(W0 || 980));
    var H = Math.max(200, Math.round(H0 || 300));
    var PL = 52, PR = 16, PT = 22, PB = 46;
    var iw = W - PL - PR, ih = H - PT - PB, n = semanas.length;
    var vals = [];
    series.forEach(function (s) {
      if (ocultas[s.key]) return;
      s.pts.forEach(function (p) { if (p.v != null && isFinite(p.v)) vals.push(p.v); });
    });
    var esScore = met.tipo === 'score';
    var vmin = 0, vmax = vals.length ? Math.max.apply(null, vals) : 1;
    if (esScore) { vmin = Math.max(0, Math.floor((Math.min.apply(null, vals.length ? vals : [90]) - 6) / 10) * 10); vmax = 95; }
    else vmax = vmax * 1.12 || 1;
    if (vmax <= vmin) vmax = vmin + 1;
    var x = function (i) { return n === 1 ? PL + iw / 2 : PL + i / (n - 1) * iw; };
    var y = function (v) { return PT + ih * (1 - (v - vmin) / (vmax - vmin)); };

    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="pn-svg pn-svg-trend" role="img" aria-label="Tendencia semanal — ' + esc(met.label) + '">';
    /* banda de la selección activa */
    var iSel = [];
    semanas.forEach(function (w, i) { if (selSet[w]) iSel.push(i); });
    if (iSel.length && iSel.length < n) {
      var a = x(iSel[0]) - (n > 1 ? iw / (n - 1) / 2 : 0), b = x(iSel[iSel.length - 1]) + (n > 1 ? iw / (n - 1) / 2 : 0);
      a = Math.max(PL - 4, a); b = Math.min(W - PR + 4, b);
      out += '<rect x="' + a.toFixed(1) + '" y="' + (PT - 6) + '" width="' + (b - a).toFixed(1) + '" height="' + (ih + 6) +
        '" class="pn-band"/><text x="' + ((a + b) / 2).toFixed(1) + '" y="' + (PT - 10) + '" class="pn-ax pn-ax-c pn-ax-band">SELECCIÓN</text>';
    }
    var nG = Math.max(4, Math.min(10, Math.round(ih / 46)));
    for (var g = 0; g <= nG; g++) {
      var vv = vmin + (vmax - vmin) * g / nG, gy = y(vv);
      out += '<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '" class="pn-grid"/>' +
        '<text x="' + (PL - 8) + '" y="' + (gy + 3.4).toFixed(1) + '" class="pn-ax pn-ax-r">' +
        (met.tipo === 'vol' ? fmtCompacto(vv) : fmt(vv, met.dec)) + '</text>';
    }
    /* eje X — cuantas más semanas quepan en el ancho real, menos se saltan;
       expandido apura el espaciado (etiquetas cada 26px en vez de 37px) */
    var paso = Math.max(1, Math.ceil(n / Math.max(6, Math.floor(iw / (exp ? 26 : 37)))));
    semanas.forEach(function (w, i) {
      if (i % paso) return;
      out += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 22) + '" class="pn-ax pn-ax-c' + (selSet[w] ? ' pn-ax-strong' : ' pn-ax-dim') + '">' +
        esc(semanaCorta(w)) + '</text>';
    });
    var y0 = anioDeSemana(semanas[0]), yN = anioDeSemana(semanas[n - 1]);
    out += '<text x="' + PL + '" y="' + (H - 8) + '" class="pn-ax pn-ax-dim">' + esc(y0) + '</text>';
    if (yN !== y0) out += '<text x="' + (W - PR) + '" y="' + (H - 8) + '" class="pn-ax pn-ax-r2 pn-ax-dim">' + esc(yN) + '</text>';

    /* series */
    series.forEach(function (s) {
      if (ocultas[s.key]) return;
      var dIn = '', dOut = '', prevIdx = -2;
      s.pts.forEach(function (p, i) {
        if (p.v == null || !isFinite(p.v)) { prevIdx = -2; return; }
        var px = x(i), py = y(p.v);
        var cont = (i - 1 === prevIdx);
        if (selSet[semanas[i]]) dIn += (cont && dIn ? ' L' : ' M') + px.toFixed(1) + ' ' + py.toFixed(1);
        dOut += (cont && dOut ? ' L' : ' M') + px.toFixed(1) + ' ' + py.toFixed(1);
        prevIdx = i;
      });
      out += '<path d="' + dOut.trim() + '" class="pn-line pn-' + s.cls + (s.total ? ' pn-line-total' : '') + ' pn-line-fuera"/>';
      if (dIn) out += '<path d="' + dIn.trim() + '" class="pn-line pn-' + s.cls + (s.total ? ' pn-line-total' : '') + '"/>';
      s.pts.forEach(function (p, i) {
        if (p.v == null || !isFinite(p.v)) return;
        out += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) + '" r="' + (s.total ? 3.4 : 2.8) +
          '" class="pn-dot pn-' + s.cls + (selSet[semanas[i]] ? '' : ' pn-line-fuera') + '">' +
          '<title>' + esc(s.label) + ' · ' + esc(semanas[i]) + ': ' + fmt(p.v, met.dec) +
          (p.horas != null ? ' · ' + horasHM(p.horas) + ' h' : '') + '</title></circle>';
      });
    });
    /* expandido: etiquetas de valor en cada punto — siempre en la serie TOTAL
       y en las demás cuando quedan pocas visibles (evita el amasijo de cifras) */
    if (exp) {
      var visibles = series.filter(function (s) { return !ocultas[s.key]; });
      var etiquetar = visibles.filter(function (s) { return s.total || visibles.length <= 4; });
      var cadaPto = Math.max(1, Math.ceil(n / Math.max(4, Math.floor(iw / 34))));
      etiquetar.forEach(function (s) {
        s.pts.forEach(function (p, i) {
          if (p.v == null || !isFinite(p.v)) return;
          if (i % cadaPto && i !== n - 1) return;
          out += '<text x="' + x(i).toFixed(1) + '" y="' + (y(p.v) - (s.total ? 9 : 7)).toFixed(1) + '" class="pn-lab">' +
            (met.tipo === 'vol' ? fmtCompacto(p.v) : fmt(p.v, met.dec)) + '</text>';
        });
      });
    }
    out += '</svg>';
    return out;
  }

  /* ---- patrón por día de la semana ---- */
  function svgDow(dias, met, W0, H0, exp) {
    var W = Math.max(320, Math.round(W0 || 470));
    var H = Math.max(180, Math.round(H0 || 216));
    var PL = 42, PR = 34, PT = 18, PB = 44;
    var iw = W - PL - PR, ih = H - PT - PB;
    var vals = dias.map(function (d) { return d.v; }).filter(function (v) { return v != null && isFinite(v); });
    var esScore = met.tipo === 'score';
    var vmin = 0, vmax = vals.length ? Math.max.apply(null, vals) : 1;
    if (esScore) { vmin = Math.max(0, Math.floor((Math.min.apply(null, vals.length ? vals : [90]) - 6) / 10) * 10); vmax = 95; }
    else vmax = vmax * 1.16 || 1;
    if (vmax <= vmin) vmax = vmin + 1;
    var cw = iw / 7, bw = Math.max(6, Math.min(cw * 0.5, 72));
    var y = function (v) { return PT + ih * (1 - (v - vmin) / (vmax - vmin)); };
    var maxOc = Math.max.apply(null, dias.map(function (d) { return d.ocurrencias || 0; }).concat([1]));

    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="pn-svg" role="img" aria-label="Patrón por día de la semana — ' + esc(met.label) + '">';
    var nG = Math.max(3, Math.min(9, Math.round(ih / 48)));
    for (var g = 0; g <= nG; g++) {
      var vv = vmin + (vmax - vmin) * g / nG, gy = y(vv);
      out += '<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '" class="pn-grid"/>' +
        '<text x="' + (PL - 6) + '" y="' + (gy + 3.4).toFixed(1) + '" class="pn-ax pn-ax-r">' +
        (met.tipo === 'vol' ? fmtCompacto(vv) : fmt(vv, met.dec)) + '</text>';
    }
    dias.forEach(function (d, i) {
      var xc = PL + cw * (i + 0.5);
      /* fantasma: cuántos días calendario de ese día de la semana hay en el periodo */
      var ha = ih * ((d.ocurrencias || 0) / maxOc) * 0.9;
      out += '<rect x="' + (xc - bw / 2 - 6).toFixed(1) + '" y="' + (PT + ih - ha).toFixed(1) + '" width="' + (bw + 12).toFixed(1) +
        '" height="' + Math.max(0.6, ha).toFixed(1) + '" rx="2" class="pn-bar-ghost"><title>' + DOW_L[i] + ' — ' +
        (d.ocurrencias || 0) + ' fecha(s) en el periodo · ' + fmt(d.operadores, 0) + ' operadores activos</title></rect>';
      if (d.v == null || !isFinite(d.v)) {
        out += '<text x="' + xc.toFixed(1) + '" y="' + (PT + ih / 2) + '" class="pn-ax pn-ax-c pn-ax-dim">s/d</text>';
      } else {
        var yy = y(d.v);
        var cls = esScore ? (met.id === 'scoreOp' ? claseOp(d.v) : claseSeg(d.v)) : 'lime';
        out += '<rect x="' + (xc - bw / 2).toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + Math.max(1.2, PT + ih - yy).toFixed(1) + '" rx="2" class="pn-bar pn-bar-' + cls + '">' +
          '<title>' + DOW_L[i] + ' — ' + esc(met.label) + ': ' + fmt(d.v, met.dec) + ' · ' + horasHM(d.horas) + ' h · ' + fmt(d.km, 0) + ' km</title></rect>';
        out += '<text x="' + xc.toFixed(1) + '" y="' + (yy - 5).toFixed(1) + '" class="pn-ax pn-ax-c pn-ax-strong">' +
          (met.tipo === 'vol' ? fmtCompacto(d.v) : fmt(d.v, met.dec)) + '</text>';
      }
      out += '<text x="' + xc.toFixed(1) + '" y="' + (H - 24) + '" class="pn-ax pn-ax-c' + (i >= 5 ? ' pn-ax-fin' : '') + '">' +
        (exp ? DOW_L[i] : DOW[i]) + '</text>';
      out += '<text x="' + xc.toFixed(1) + '" y="' + (H - 11) + '" class="pn-ax pn-ax-c pn-ax-dim">' + horasHM(d.horas) +
        (exp ? ' h · ' + fmt(d.operadores, 0) + ' op · ' + fmtCompacto(d.km) + ' km' : '') + '</text>';
    });
    out += '<text x="' + (W - PR + 5) + '" y="' + (PT + ih + 4) + '" class="pn-ax pn-ax-dim">fechas</text>';
    out += '</svg>';
    return out;
  }

  /* ---- mapa de calor semana × día ---- */
  function heatmap(filas, met) {
    if (!filas.length) return '<div class="pn-empty">Sin semanas para el mapa</div>';
    var vals = [];
    filas.forEach(function (f) { f.celdas.forEach(function (c) { if (c.v != null && isFinite(c.v)) vals.push(c.v); }); });
    if (!vals.length) return '<div class="pn-empty">Sin actividad registrada en el periodo</div>';
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (mx === mn) mx = mn + 1;
    var inv = met.dir < 0;   // más bajo es mejor → intensidad = "peor"
    var h = '<div class="pn-hm"><div class="pn-hm-row pn-hm-head"><span class="pn-hm-lbl"></span>' +
      DOW.map(function (d, i) { return '<span class="pn-hm-c pn-hm-h' + (i >= 5 ? ' fin' : '') + '">' + d + '</span>'; }).join('') +
      '<span class="pn-hm-tot">Σ</span></div>';
    filas.forEach(function (f) {
      h += '<div class="pn-hm-row' + (f.sel ? ' sel' : '') + '"><span class="pn-hm-lbl" title="' + esc(f.semana) + '">' +
        esc(semanaCorta(f.semana)) + '</span>';
      f.celdas.forEach(function (c, i) {
        if (c.v == null || !isFinite(c.v)) {
          h += '<span class="pn-hm-c vacio' + (i >= 5 ? ' fin' : '') + '" title="' + esc(f.semana) + ' · ' + DOW_L[i] + ' — sin registros"></span>';
          return;
        }
        var t = (c.v - mn) / (mx - mn);
        var inten = inv ? t : t;                          // 0..1
        h += '<span class="pn-hm-c' + (i >= 5 ? ' fin' : '') + '" style="--i:' + inten.toFixed(3) + '" title="' +
          esc(f.semana) + ' · ' + DOW_L[i] + ' — ' + esc(met.label) + ': ' + fmt(c.v, met.dec) +
          ' · ' + horasHM(c.horas) + ' h · ' + fmt(c.km, 0) + ' km"><b>' +
          (met.tipo === 'vol' ? fmtCompacto(c.v) : fmt(c.v, met.dec)) + '</b></span>';
      });
      h += '<span class="pn-hm-tot">' + (f.total == null ? '—' : (met.tipo === 'vol' ? fmtCompacto(f.total) : fmt(f.total, met.dec))) + '</span>';
      h += '</div>';
    });
    h += '</div><div class="pn-hm-leg"><span>' + (met.tipo === 'vol' ? fmtCompacto(mn) : fmt(mn, met.dec)) + '</span>' +
      '<i class="pn-hm-ramp"></i><span>' + (met.tipo === 'vol' ? fmtCompacto(mx) : fmt(mx, met.dec)) + '</span></div>';
    return h;
  }

  /* ============================== RENDER ================================== */
  function render(container, state) {
    var data = (state && state.data) || {};
    var filtros = (state && state.filtros) || {};
    container.__pnState = state;
    var UI = container.__pn || (container.__pn = {
      dim: 'udn', metrica: 'ev100h',
      orden: 'valor', ordenDir: -1, ocultas: {}, tablaOrden: 'horas', tablaDir: -1
    });
    var met = metricaDe(UI.metrica);

    /* ---------- 1. universo filtrado (los 8 filtros globales) ---------- */
    var regsAll = filtrar(data, filtros);
    if (!regsAll.length) {
      container.innerHTML = '<div class="pn-mod"><div class="pn-empty grande">' + ico('capas') +
        '<b>Sin registros con los filtros actuales</b>' +
        '<span>Ajusta los filtros del panel lateral o limpia la selección.</span></div></div>';
      return;
    }
    var semanasAll = Object.keys(regsAll.reduce(function (m, r) { m[r.semana] = 1; return m; }, {})).sort();
    var fechasAll = regsAll.map(function (r) { return r.fecha; }).sort();
    var fecha0 = fechasAll[0], fechaN = fechasAll[fechasAll.length - 1];

    /* ---------- 2. ventana de histórico ----------
       2026-08-08: se retiró el selector propio del módulo (Semana actual /
       Últimas 4 / Trimestre / Año / Todo). Era un segundo filtro temporal que
       competía con el filtro 7 del panel lateral. La ventana ES ahora lo que
       entregan los filtros globales; el periodo ANTERIOR se busca en el
       histórico completo (mismos filtros menos el recorte temporal), que es lo
       único que permite que las deltas existan. */
    var semanasSel = semanasAll.slice();
    var selSet = {}; semanasSel.forEach(function (w) { selSet[w] = 1; });

    var fSinTiempo = {};
    for (var kf in filtros) fSinTiempo[kf] = filtros[kf];
    fSinTiempo.desde = null; fSinTiempo.hasta = null;
    fSinTiempo.semanasComparar = null; fSinTiempo.semanaActual = null;
    var regsHist = filtrar(data, fSinTiempo);
    var semanasHist = Object.keys(regsHist.reduce(function (m, r) { m[r.semana] = 1; return m; }, {})).sort();

    /* periodo anterior de la MISMA longitud (lo que exista) */
    var iIni = semanasHist.indexOf(semanasSel[0]);
    var semanasPrev = iIni > 0 ? semanasHist.slice(Math.max(0, iIni - semanasSel.length), iIni) : [];
    var prevSet = {}; semanasPrev.forEach(function (w) { prevSet[w] = 1; });

    var regsSel = regsAll.filter(function (r) { return selSet[r.semana]; });
    var regsPrev = regsHist.filter(function (r) { return prevSet[r.semana]; });

    var fSel = regsSel.map(function (r) { return r.fecha; }).sort();
    var desdeSel = fSel[0], hastaSel = fSel[fSel.length - 1];
    var fPrev = regsPrev.map(function (r) { return r.fecha; }).sort();
    var desdePrev = fPrev[0], hastaPrev = fPrev[fPrev.length - 1];
    /* días calendario que abarca la ventana (no los días con datos) */
    var diasVentana = (desdeSel && hastaSel) ? (dayNum(hastaSel) - dayNum(desdeSel) + 1) : 0;

    /* ---------- 3. agregados ---------- */
    var totalSel = totalDe(regsSel);
    var totalPrev = regsPrev.length ? totalDe(regsPrev) : null;
    var campo = UI.dim === 'cliente' ? 'cliente' : 'udn';
    var segSel = agrupar(regsSel, campo);
    var segPrev = agrupar(regsPrev, campo);
    /* la otra dimensión, para el resumen cruzado */
    var campoAlt = campo === 'udn' ? 'cliente' : 'udn';
    var segAlt = agrupar(regsSel, campoAlt);

    /* ---------- 4. fatiga (reusa el Módulo 2) ---------- */
    var core = coreCargas();
    var sinDatos = core ? core.coberturaGlobal((data && data.registros) || [], desdeSel, hastaSel) : {};
    var fatSel = fatigaDe(regsSel, desdeSel, hastaSel, sinDatos);
    var fatPrev = regsPrev.length && core
      ? fatigaDe(regsPrev, desdePrev, hastaPrev, core.coberturaGlobal((data && data.registros) || [], desdePrev, hastaPrev))
      : null;
    if (fatSel) totalSel.pctFatiga = fatSel.pct;
    if (fatPrev && totalPrev) totalPrev.pctFatiga = fatPrev.pct;
    /* por segmento (solo si hace falta: la métrica o la tabla la muestran siempre) */
    var fatSeg = {}, fatSegPrev = {};
    if (core) {
      var porSeg = {}; regsSel.forEach(function (r) { (porSeg[r[campo] || 'Sin asignar'] = porSeg[r[campo] || 'Sin asignar'] || []).push(r); });
      Object.keys(porSeg).forEach(function (k) {
        var f = fatigaDe(porSeg[k], desdeSel, hastaSel, sinDatos);
        fatSeg[k] = f; if (segSel[k] && f) segSel[k].pctFatiga = f.pct;
      });
      if (regsPrev.length) {
        var sdP = core.coberturaGlobal((data && data.registros) || [], desdePrev, hastaPrev);
        var porSegP = {}; regsPrev.forEach(function (r) { (porSegP[r[campo] || 'Sin asignar'] = porSegP[r[campo] || 'Sin asignar'] || []).push(r); });
        Object.keys(porSegP).forEach(function (k) {
          var f = fatigaDe(porSegP[k], desdePrev, hastaPrev, sdP);
          fatSegPrev[k] = f; if (segPrev[k] && f) segPrev[k].pctFatiga = f.pct;
        });
      }
    }

    /* ---------- 5. series por semana (histórico COMPLETO disponible) ------- */
    var porSemanaTotal = {};
    semanasAll.forEach(function (w) { porSemanaTotal[w] = nuevoAcc(); });
    regsAll.forEach(function (r) { if (porSemanaTotal[r.semana]) acum(porSemanaTotal[r.semana], r); });
    semanasAll.forEach(function (w) { cerrar(porSemanaTotal[w]); });

    var segsAll = {};
    regsAll.forEach(function (r) { segsAll[r[campo] || 'Sin asignar'] = 1; });
    var clavesSeg = Object.keys(segsAll);
    /* orden de las series: por horas del periodo seleccionado (desc) */
    clavesSeg.sort(function (a, b) {
      var ha = segSel[a] ? segSel[a].horas : 0, hb = segSel[b] ? segSel[b].horas : 0;
      return hb - ha || a.localeCompare(b, 'es');
    });
    var clavesSerie = clavesSeg.slice(0, 8);

    var porSemanaSeg = {};
    clavesSerie.forEach(function (k) {
      porSemanaSeg[k] = {}; semanasAll.forEach(function (w) { porSemanaSeg[k][w] = nuevoAcc(); });
    });
    regsAll.forEach(function (r) {
      var k = r[campo] || 'Sin asignar';
      if (porSemanaSeg[k] && porSemanaSeg[k][r.semana]) acum(porSemanaSeg[k][r.semana], r);
    });
    clavesSerie.forEach(function (k) { semanasAll.forEach(function (w) { cerrar(porSemanaSeg[k][w]); }); });

    /* fatiga por semana (solo si la métrica activa lo pide — es la cara) */
    var fatSemanaTotal = null, fatSemanaSeg = null;
    if (met.id === 'pctFatiga' && core) {
      var sdAll = core.coberturaGlobal((data && data.registros) || [], fecha0, fechaN);
      var opsTodos = core.calcularCargas(regsAll, {
        desde: fecha0, hasta: fechaN, umbral: core.PERFILES[core.PERFIL_DEFAULT], sinDatos: sdAll });
      fatSemanaTotal = {};
      core.tendenciaSemanal(opsTodos, fecha0, fechaN).forEach(function (t) { fatSemanaTotal[t.semana] = t.pctRiesgo; });
      fatSemanaSeg = {};
      clavesSerie.forEach(function (k) {
        var rs = regsAll.filter(function (r) { return (r[campo] || 'Sin asignar') === k; });
        if (!rs.length) { fatSemanaSeg[k] = {}; return; }
        var o = core.calcularCargas(rs, { desde: fecha0, hasta: fechaN, umbral: core.PERFILES[core.PERFIL_DEFAULT], sinDatos: sdAll });
        var m = {}; core.tendenciaSemanal(o, fecha0, fechaN).forEach(function (t) { m[t.semana] = t.pctRiesgo; });
        fatSemanaSeg[k] = m;
      });
    }
    function valSemana(acc, w, mapaFat) {
      if (met.id === 'pctFatiga') return mapaFat ? (mapaFat[w] == null ? null : mapaFat[w]) : null;
      if (!acc || !acc.regs) return null;
      return valorDe(acc, met);
    }

    var series = clavesSerie.map(function (k, i) {
      return {
        key: k, label: k, cls: SERIE_CLS[i % SERIE_CLS.length], total: false,
        pts: semanasAll.map(function (w) {
          return { v: valSemana(porSemanaSeg[k][w], w, fatSemanaSeg && fatSemanaSeg[k]),
                   horas: porSemanaSeg[k][w] ? porSemanaSeg[k][w].horas : null };
        })
      };
    });
    series.unshift({
      key: '__total', label: 'TOTAL (selección de filtros)', cls: 'stot', total: true,
      pts: semanasAll.map(function (w) {
        return { v: valSemana(porSemanaTotal[w], w, fatSemanaTotal), horas: porSemanaTotal[w].horas };
      })
    });

    /* ---------- 6. por día de la semana ---------- */
    var dowAcc = []; for (var i = 0; i < 7; i++) dowAcc.push({ acc: nuevoAcc(), fechas: {} });
    regsSel.forEach(function (r) {
      var d = dowDe(r.fecha);
      acum(dowAcc[d].acc, r); dowAcc[d].fechas[r.fecha] = 1;
    });
    var dias = dowAcc.map(function (o, idx) {
      var a = cerrar(o.acc);
      var oc = Object.keys(o.fechas).length;
      var v = a.regs ? valorDe(a, met) : null;
      /* volúmenes: se muestran promediados por fecha para que L..D sea comparable */
      if (v != null && met.tipo === 'vol' && oc > 0) v = v / oc;
      return { dow: idx, v: v, horas: oc ? a.horas / oc : 0, km: oc ? a.km / oc : 0,
               ocurrencias: oc, operadores: a.operadores, acc: a };
    });

    /* ---------- 7. mapa semana × día ---------- */
    var mapa = {};
    regsSel.forEach(function (r) {
      var w = r.semana, d = dowDe(r.fecha);
      var f = mapa[w] || (mapa[w] = { celdas: [], tot: nuevoAcc() });
      if (!f.celdas[d]) f.celdas[d] = nuevoAcc();
      acum(f.celdas[d], r); acum(f.tot, r);
    });
    var filasMapa = semanasSel.map(function (w) {
      var f = mapa[w];
      var celdas = [];
      for (var d = 0; d < 7; d++) {
        if (!f || !f.celdas[d]) { celdas.push({ v: null }); continue; }
        var a = cerrar(f.celdas[d]);
        celdas.push({ v: valorDe(a, met), horas: a.horas, km: a.km });
      }
      var tot = f ? cerrar(f.tot) : null;
      return { semana: w, sel: true, celdas: celdas,
               total: tot ? (met.id === 'pctFatiga' ? null : valorDe(tot, met)) : null };
    });

    /* ---------- 8. tabla semana vs semana ---------- */
    var filasSemana = semanasSel.map(function (w) {
      var a = porSemanaTotal[w] || cerrar(nuevoAcc());
      return { semana: w, a: a, fat: fatSemanaTotal ? fatSemanaTotal[w] : null };
    });

    /* ---------- 9. filas comparativas de segmento ---------- */
    var filasSeg = clavesSeg.map(function (k) {
      var a = segSel[k], p = segPrev[k] || null;
      return {
        key: k, label: k, a: a || cerrar(nuevoAcc()), p: p,
        act: a ? valorDe(a, met) : null,
        prev: p ? valorDe(p, met) : null,
        nota: a && a.regs ? (fmt(a.operadores) + ' op · ' + fmtCompacto(a.horas) + ' h') : 'sin actividad'
      };
    });
    filasSeg.sort(function (x, y) {
      if (UI.orden === 'alfa') return x.label.localeCompare(y.label, 'es') * (UI.ordenDir < 0 ? 1 : -1);
      var a = x.act == null ? -Infinity : x.act, b = y.act == null ? -Infinity : y.act;
      return (b - a) * (UI.ordenDir < 0 ? 1 : -1) || x.label.localeCompare(y.label, 'es');
    });

    /* ---------- 10. cobertura real (nunca fingir datos) ----------
       Ya no se compara contra una ventana pedida por el módulo: se avisa de las
       semanas que el filtro 7 SELECCIONÓ y que el snapshot no tiene. */
    var pedidas = (filtros.semanasComparar || []).filter(function (w) { return !selSet[w]; });
    var pctExt = totalSel.regs ? totalSel.conExt / totalSel.regs * 100 : 0;

    /* ============================ HTML =================================== */
    var h = '<div class="pn-mod">';

    /* --- cabecera --- */
    h += '<header class="pn-head">' +
      '<div class="pn-head-l">' +
        '<h2 class="pn-title">Panorama <em>· ' + (campo === 'udn' ? 'Unidades de negocio' : 'Clientes') + '</em></h2>' +
        '<div class="pn-sub">' +
          'Selección <b>' + esc(semanasSel[0]) + ' → ' + esc(semanasSel[semanasSel.length - 1]) + '</b> · ' +
          semanasSel.length + ' sem · ' + fmt(totalSel.diasActivos) + ' días con datos (' + fechaCorta(desdeSel) + '–' + fechaCorta(hastaSel) + ')' +
          ' &nbsp;|&nbsp; Histórico disponible <b>' + esc(semanasHist[0]) + ' → ' + esc(semanasHist[semanasHist.length - 1]) + '</b> · ' +
          semanasHist.length + ' sem' +
        '</div>' +
      '</div>' +
      '<div class="pn-head-r">' +
        '<div class="pn-seg" role="group" aria-label="Dimensión"><span class="pn-seg-l">Segmentar por</span>' +
          '<button type="button" class="pn-seg-b' + (campo === 'udn' ? ' on' : '') + '" data-dim="udn">UDN</button>' +
          '<button type="button" class="pn-seg-b' + (campo === 'cliente' ? ' on' : '') + '" data-dim="cliente">Cliente</button>' +
        '</div>' +
      '</div>' +
    '</header>';

    if (pedidas.length) {
      h += '<div class="pn-aviso">' + ico('calendario') +
        '<span><b>Cobertura real:</b> ' + esc(pedidas.join(', ')) +
        (pedidas.length === 1 ? ' no tiene' : ' no tienen') + ' registros en el snapshot con estos filtros. ' +
        'Se muestra lo que existe — el backfill histórico va llenando hacia atrás.</span></div>';
    }

    /* --- KPIs --- */
    var etiquetaPrev = semanasPrev.length
      ? (semanasPrev.length === 1 ? 'semana previa (' + semanaCorta(semanasPrev[0]) + ')'
         : semanasPrev.length + ' sem previas (' + semanaCorta(semanasPrev[0]) + '→' + semanaCorta(semanasPrev[semanasPrev.length - 1]) + ')')
      : 'sin periodo previo';

    function kpi(iconKey, label, valor, sub, cls, spark, delta) {
      return '<div class="pn-kpi' + (cls ? ' ' + cls : '') + '">' +
        '<div class="pn-kpi-top">' + ico(iconKey) + '<span class="pn-kpi-l">' + esc(label) + '</span></div>' +
        '<div class="pn-kpi-v">' + valor + '</div>' +
        '<div class="pn-kpi-b">' + (delta || '') + (sub ? '<span class="pn-kpi-s">' + sub + '</span>' : '') + '</div>' +
        (spark || '') + '</div>';
    }
    function serieKpi(id) {
      return semanasSel.map(function (w) {
        var a = porSemanaTotal[w];
        if (id === 'pctFatiga') return fatSemanaTotal ? fatSemanaTotal[w] : null;
        return a && a.regs ? a[id] : null;
      });
    }
    var mVol = { tipo: 'vol', dir: 0, dec: 0 }, mEv = { tipo: 'vol', dir: -1, dec: 0 },
        mSc = { tipo: 'score', dir: 1, dec: 0 }, mPct = { tipo: 'pct', dir: -1, dec: 1 };

    h += '<section class="pn-kpis">' +
      kpi('operadores', 'Operadores activos', fmt(totalSel.operadores), esc(fmt(totalSel.diasActivos) + ' días · ' + horasHM(totalSel.horasPorOp) + ' h/op'),
          '', sparkline(serieKpi('operadores'), 0), chipDelta(totalSel.operadores, totalPrev && totalPrev.operadores, mVol)) +
      kpi('unidades', 'Unidades en operación', fmt(totalSel.unidades), esc(fmt(totalSel.viajes) + ' viajes'),
          '', sparkline(serieKpi('unidades'), 0), chipDelta(totalSel.unidades, totalPrev && totalPrev.unidades, mVol)) +
      kpi('sinDatos', 'Viajes sin identificar', (totalSel.pctSinId == null ? '—' : fmt(totalSel.pctSinId, 1) + '<small>%</small>'),
          esc(fmt(totalSel.viajesSinId) + ' viajes sin logueo de operador'),
          totalSel.pctSinId == null ? '' : (totalSel.pctSinId >= 30 ? 'sc-bad' : totalSel.pctSinId >= 15 ? 'sc-warn' : 'sc-ok'),
          sparkline(serieKpi('pctSinId'), -1), chipDelta(totalSel.pctSinId, totalPrev && totalPrev.pctSinId, mPct)) +
      kpi('horas', 'Horas de conducción', horasHM(totalSel.horas) + '<small> h</small>', esc(fmt(totalSel.kmPorHora, 1) + ' km/h medios'),
          '', sparkline(serieKpi('horas'), 0), chipDelta(totalSel.horas, totalPrev && totalPrev.horas, mVol)) +
      kpi('km', 'Kilómetros', fmtCompacto(totalSel.km) + '<small> km</small>', esc(fmt(totalSel.km / (totalSel.viajes || 1), 1) + ' km/viaje'),
          '', sparkline(serieKpi('km'), 0), chipDelta(totalSel.km, totalPrev && totalPrev.km, mVol)) +
      kpi('eventos', 'Eventos de seguridad', fmt(totalSel.evTotal), esc(fmt(totalSel.ev100h, 1) + ' por 100 h'),
          '', sparkline(serieKpi('evTotal'), -1), chipDelta(totalSel.evTotal, totalPrev && totalPrev.evTotal, mEv)) +
      kpi('escudo', 'Score de seguridad', (totalSel.scoreSeg == null ? '—' : totalSel.scoreSeg) + '<small>/95</small>',
          esc(fmt(totalSel.puntos) + ' pts · ' + fmt(totalSel.x100h, 1) + ' x100h'),
          'sc-' + claseSeg(totalSel.scoreSeg), sparkline(serieKpi('scoreSeg'), 1),
          chipDelta(totalSel.scoreSeg, totalPrev && totalPrev.scoreSeg, mSc)) +
      kpi('motor', 'Score de operación', (totalSel.scoreOp == null ? '—' : totalSel.scoreOp) + '<small>/95</small>',
          esc(fmt(totalSel.opPuntos) + ' pts · telemetría en ' + fmt(pctExt, 0) + '% de registros'),
          'sc-' + claseOp(totalSel.scoreOp), sparkline(serieKpi('scoreOp'), 1),
          chipDelta(totalSel.scoreOp, totalPrev && totalPrev.scoreOp, mSc)) +
      kpi('fatiga', 'En riesgo de fatiga', (fatSel ? fmt(fatSel.pct, 0) + '<small>%</small>' : '—'),
          (fatSel
            ? (diasVentana < 10
                ? esc('ventana de ' + diasVentana + ' días: una racha de 10 no cabe — amplía el histórico')
                : esc(fatSel.enRiesgo + ' de ' + fatSel.activos + ' op · racha ≥10 días'))
            : 'módulo de cargas no cargado'),
          fatSel ? (fatSel.pct >= 20 ? 'sc-bad' : fatSel.pct >= 8 ? 'sc-warn' : 'sc-ok') : '',
          sparkline(serieKpi('pctFatiga'), -1),
          chipDelta(fatSel && fatSel.pct, fatPrev && fatPrev.pct, mPct)) +
    '</section>';

    h += '<div class="pn-nota-comp">' +
      (semanasPrev.length
        ? 'Los deltas comparan el periodo seleccionado contra <b>' + esc(etiquetaPrev) + '</b>. '
        : 'No hay <b>periodo previo</b> en el snapshot para comparar (' + esc(semanasSel[0]) + ' es la primera semana con datos), por eso los deltas van en blanco. ') +
      'Los scores de cada segmento se recalculan con su fórmula sobre los agregados (ponderación por horas), <b>nunca promediando scores</b> de operador.</div>';

    /* --- lente de métrica --- */
    h += '<div class="pn-lente">' +
      '<span class="pn-lente-l">' + ico('balanza') + 'Métrica del panorama</span>' +
      '<div class="pn-chips">' + METRICAS.map(function (m) {
        return '<button type="button" class="pn-chip' + (m.id === met.id ? ' on' : '') + '" data-met="' + m.id + '">' + esc(m.label) + '</button>';
      }).join('') + '</div>' +
    '</div>';

    /* --- comparativa por segmento --- */
    var etqPrev = semanasPrev.length ? etiquetaPrev : 'sin periodo previo';
    h += '<section class="pn-card pn-card-wide" id="pn-g-barras" data-graf="Comparativa por ' +
        (campo === 'udn' ? 'unidad de negocio' : 'cliente') + ' · ' + esc(met.label) + '">' +
      '<header class="pn-card-h"><span class="pn-tag">' + ico('capas') +
        'Comparativa por ' + (campo === 'udn' ? 'unidad de negocio' : 'cliente') + ' · ' + esc(met.label) + '</span>' +
        '<span class="pn-card-tools">' +
          '<button type="button" class="pn-mini' + (UI.orden === 'valor' ? ' on' : '') + '" data-orden="valor">por valor</button>' +
          '<button type="button" class="pn-mini' + (UI.orden === 'alfa' ? ' on' : '') + '" data-orden="alfa">alfabético</button>' +
          '<button type="button" class="pn-mini" data-dir="1" title="invertir orden">' + (UI.ordenDir < 0 ? '↓' : '↑') + '</button>' +
        '</span></header>' +
      '<div class="pn-lienzo" data-graf-lienzo>' +
        svgBarras(filasSeg, met, etqPrev) + '</div>' +
    '</section>';

    /* --- tendencia semanal --- */
    h += '<section class="pn-card pn-card-wide" id="pn-g-tendencia" data-graf="Tendencia por semana · ' + esc(met.label) + '">' +
      '<header class="pn-card-h"><span class="pn-tag">' + ico('semana') +
        'Tendencia por semana · ' + esc(met.label) + '</span>' +
        '<span class="pn-sub-h">histórico completo disponible · ' + semanasAll.length + ' semanas (' +
          esc(semanasAll[0]) + ' → ' + esc(semanasAll[semanasAll.length - 1]) + ')</span></header>' +
      '<div class="pn-lienzo" data-graf-lienzo>' +
        svgTendencia(semanasAll, series, selSet, met, UI.ocultas) + '</div>' +
      '<div class="pn-leyenda">' + series.map(function (s) {
        return '<button type="button" class="pn-leg pn-' + s.cls + (UI.ocultas[s.key] ? ' off' : '') + '" data-serie="' + esc(s.key) + '">' +
          '<i></i>' + esc(s.label) + '</button>';
      }).join('') + '</div>' +
      (met.id === 'pctFatiga' && !core ? '<div class="pn-nota">El % de fatiga requiere el módulo <b>Cargas · Fatiga</b> (no cargado).</div>' : '') +
    '</section>';

    /* --- día de la semana + mapa --- */
    h += '<div class="pn-grid2">' +
      '<section class="pn-card" id="pn-g-dow" data-graf="Patrón por día de la semana · ' + esc(met.label) + '">' +
        '<header class="pn-card-h"><span class="pn-tag">' + ico('calendario') + 'Patrón por día de la semana</span>' +
          '<span class="pn-sub-h">' + (met.tipo === 'vol' ? 'promedio por fecha' : esc(met.label)) + '</span></header>' +
        '<div class="pn-lienzo" data-graf-lienzo>' + svgDow(dias, met) + '</div>' +
        '<div class="pn-nota">Barra clara de fondo = cuántas fechas de ese día caen en el periodo (' +
          fmt(totalSel.diasActivos) + ' días con datos). ' +
          (met.tipo === 'vol' ? 'Los volúmenes se dividen entre esas fechas para que lunes y domingo sean comparables.' :
           'Las tasas y los scores se recalculan con la fórmula sobre el agregado del día.') + '</div>' +
      '</section>' +
      '<section class="pn-card" id="pn-g-mapa" data-graf="Mapa semana × día · ' + esc(met.corto) + '">' +
        '<header class="pn-card-h"><span class="pn-tag">' + ico('reloj') + 'Mapa semana × día</span>' +
          '<span class="pn-sub-h">' + esc(met.corto) + '</span></header>' +
        '<div class="pn-lienzo pn-lienzo-hm" data-graf-lienzo>' + heatmap(filasMapa, met) + '</div>' +
      '</section>' +
    '</div>';

    /* --- semana vs semana + periodo vs periodo --- */
    h += '<div class="pn-grid2 pn-grid2-b">' +
      '<section class="pn-card">' +
        '<header class="pn-card-h"><span class="pn-tag">' + ico('semana') + 'Semana vs semana</span>' +
          '<span class="pn-sub-h">Δ contra la semana previa</span></header>' +
        '<div class="pn-tabla-wrap"><table class="pn-tabla pn-tabla-sem"><thead><tr>' +
          '<th>Semana</th><th class="n">Op.</th><th class="n">Horas</th><th class="n">Km</th>' +
          '<th class="n">Eventos</th><th class="n">EV/100h</th><th class="n">Score</th><th class="n">Δ</th>' +
        '</tr></thead><tbody>';
    filasSemana.forEach(function (f, idx) {
      var prev = idx > 0 ? filasSemana[idx - 1].a : null;
      var d = delta(f.a.scoreSeg, prev && prev.scoreSeg, { tipo: 'score', dir: 1, dec: 0 });
      var dcls = !d ? 'na' : (Math.abs(d.v) < 0.05 ? 'eq' : (d.v > 0 ? 'good' : 'bad'));
      h += '<tr' + (idx === filasSemana.length - 1 ? ' class="ult"' : '') + '>' +
        '<td class="pn-w"><b>' + esc(semanaCorta(f.semana)) + '</b><small>' + esc(f.semana) + '</small></td>' +
        '<td class="n">' + fmt(f.a.operadores) + '</td>' +
        '<td class="n">' + horasHM(f.a.horas) + '</td>' +
        '<td class="n">' + fmtCompacto(f.a.km) + '</td>' +
        '<td class="n">' + fmt(f.a.evTotal) + '</td>' +
        '<td class="n">' + fmt(f.a.ev100h, 1) + '</td>' +
        '<td class="n sc-' + claseSeg(f.a.scoreSeg) + '"><b>' + (f.a.scoreSeg == null ? '—' : f.a.scoreSeg) + '</b></td>' +
        '<td class="n"><span class="pn-d pn-d-' + dcls + '">' + (d ? (Math.abs(d.v) < 0.05 ? '＝' : (d.v > 0 ? '▲' : '▼')) + ' ' + esc(d.txt) : '—') + '</span></td>' +
      '</tr>';
    });
    h += '</tbody></table></div></section>';

    /* periodo vs periodo */
    h += '<section class="pn-card" id="pn-g-pvp" data-graf="Periodo vs periodo">' +
      '<header class="pn-card-h"><span class="pn-tag">' + ico('balanza') + 'Periodo vs periodo</span>' +
        '<span class="pn-sub-h">' + semanasSel.length + ' sem vs ' + semanasPrev.length + ' sem</span></header>';
    if (!semanasPrev.length) {
      h += '<div class="pn-empty">No hay historia previa a <b>' + esc(semanasSel[0]) + '</b> en el snapshot. ' +
        'Cuando el backfill avance hacia atrás, esta comparativa se llena sola.</div>';
    } else {
      var comparables = [
        { l: 'Operadores activos', a: totalSel.operadores, b: totalPrev.operadores, d: 0, dec: 0 },
        { l: 'Unidades', a: totalSel.unidades, b: totalPrev.unidades, d: 0, dec: 0 },
        { l: 'Horas de conducción', a: totalSel.horas, b: totalPrev.horas, d: 0, dec: 0, hm: true },
        { l: 'Kilómetros', a: totalSel.km, b: totalPrev.km, d: 0, dec: 0 },
        { l: 'Eventos de seguridad', a: totalSel.evTotal, b: totalPrev.evTotal, d: -1, dec: 0 },
        { l: 'Eventos / 100 h', a: totalSel.ev100h, b: totalPrev.ev100h, d: -1, dec: 1 },
        { l: 'Score de seguridad', a: totalSel.scoreSeg, b: totalPrev.scoreSeg, d: 1, dec: 0, score: true },
        { l: 'Score de operación', a: totalSel.scoreOp, b: totalPrev.scoreOp, d: 1, dec: 0, score: true },
        { l: '% en riesgo de fatiga', a: fatSel && fatSel.pct, b: fatPrev && fatPrev.pct, d: -1, dec: 1, pct: true }
      ];
      h += '<div class="pn-pvp">';
      comparables.forEach(function (c) {
        var mm = { tipo: c.score ? 'score' : (c.pct ? 'pct' : 'vol'), dir: c.d, dec: c.dec };
        var mx = Math.max(c.a || 0, c.b || 0) || 1;
        var fmtv = function (v) { return v == null ? '—' : (c.hm ? horasHM(v) : (c.dec ? fmt(v, c.dec) : fmtCompacto(v))); };
        h += '<div class="pn-pvp-row">' +
          '<span class="pn-pvp-l">' + esc(c.l) + '</span>' +
          '<span class="pn-pvp-bars">' +
            '<i class="pn-pvp-b act" style="width:' + ((c.a || 0) / mx * 100).toFixed(1) + '%"></i>' +
            '<i class="pn-pvp-b prev" style="width:' + ((c.b || 0) / mx * 100).toFixed(1) + '%"></i>' +
          '</span>' +
          '<span class="pn-pvp-v"><b>' + fmtv(c.a) + '</b><small>' + fmtv(c.b) + '</small></span>' +
          '<span class="pn-pvp-d">' + chipDelta(c.a, c.b, mm) + '</span>' +
        '</div>';
      });
      h += '</div>';
    }
    h += '</section></div>';

    /* --- tabla detalle por segmento --- */
    var COLS = [
      { id: 'label', l: campo === 'udn' ? 'Unidad de negocio' : 'Cliente', tipo: 'txt' },
      { id: 'operadores', l: 'Op.', dec: 0 },
      { id: 'unidades', l: 'Unid.', dec: 0 },
      { id: 'diasActivos', l: 'Días', dec: 0 },
      { id: 'horas', l: 'Horas', hm: true },
      { id: 'km', l: 'Km', comp: true },
      { id: 'viajes', l: 'Viajes', dec: 0 },
      { id: 'evTotal', l: 'Eventos', dec: 0 },
      { id: 'ev100h', l: 'EV/100h', dec: 1 },
      { id: 'scoreSeg', l: 'Score seg.', dec: 0, score: 'seg' },
      { id: 'scoreOp', l: 'Score op.', dec: 0, score: 'op' },
      { id: 'pctFatiga', l: '% fatiga', dec: 0, pct: true }
    ];
    var filasTabla = clavesSeg.map(function (k) {
      var a = segSel[k] || cerrar(nuevoAcc());
      var p = segPrev[k] || null;
      return { key: k, label: k, a: a, p: p };
    });
    var to = UI.tablaOrden, td = UI.tablaDir;
    filasTabla.sort(function (x, y) {
      if (to === 'label') return x.label.localeCompare(y.label, 'es') * (td > 0 ? 1 : -1);
      var xa = x.a[to], ya = y.a[to];
      xa = (xa == null || !isFinite(xa)) ? -Infinity : xa;
      ya = (ya == null || !isFinite(ya)) ? -Infinity : ya;
      return (xa - ya) * (td > 0 ? 1 : -1) || x.label.localeCompare(y.label, 'es');
    });

    h += '<section class="pn-card pn-card-wide">' +
      '<header class="pn-card-h"><span class="pn-tag">' + ico('capas') + 'Detalle por ' +
        (campo === 'udn' ? 'unidad de negocio' : 'cliente') + '</span>' +
        '<span class="pn-sub-h">clic en un encabezado para ordenar' +
          (semanasPrev.length ? ' · Δ = vs ' + esc(etiquetaPrev) : ' · sin periodo previo para Δ') + '</span></header>' +
      '<div class="pn-tabla-wrap"><table class="pn-tabla pn-tabla-det"><thead><tr>' +
      COLS.map(function (c) {
        return '<th' + (c.tipo === 'txt' ? '' : ' class="n"') + ' data-col="' + c.id + '" tabindex="0" role="button">' +
          esc(c.l) + (to === c.id ? '<i class="pn-sort">' + (td > 0 ? '▲' : '▼') + '</i>' : '') + '</th>';
      }).join('') + '</tr></thead><tbody>';
    filasTabla.forEach(function (f) {
      var a = f.a, p = f.p;
      h += '<tr>' +
        '<td class="pn-seg-nom"><b>' + esc(f.label) + '</b>' +
          (a.regs ? '' : '<small>sin actividad en el periodo</small>') + '</td>' +
        '<td class="n">' + fmt(a.operadores) + celdaDelta(a.operadores, p && p.operadores, 0) + '</td>' +
        '<td class="n">' + fmt(a.unidades) + '</td>' +
        '<td class="n">' + fmt(a.diasActivos) + '</td>' +
        '<td class="n">' + horasHM(a.horas) + celdaDelta(a.horas, p && p.horas, 0) + '</td>' +
        '<td class="n">' + fmtCompacto(a.km) + celdaDelta(a.km, p && p.km, 0) + '</td>' +
        '<td class="n">' + fmt(a.viajes) + '</td>' +
        '<td class="n">' + fmt(a.evTotal) + celdaDelta(a.evTotal, p && p.evTotal, -1) + '</td>' +
        '<td class="n">' + fmt(a.ev100h, 1) + celdaDelta(a.ev100h, p && p.ev100h, -1) + '</td>' +
        '<td class="n sc-' + claseSeg(a.scoreSeg) + '"><b>' + (a.scoreSeg == null ? '—' : a.scoreSeg) + '</b>' +
          celdaDelta(a.scoreSeg, p && p.scoreSeg, 1, true) + '</td>' +
        '<td class="n sc-' + claseOp(a.scoreOp) + '"><b>' + (a.scoreOp == null ? '—' : a.scoreOp) + '</b>' +
          celdaDelta(a.scoreOp, p && p.scoreOp, 1, true) + '</td>' +
        '<td class="n">' + (fatSeg[f.key] ? fmt(fatSeg[f.key].pct, 0) + '%' : '—') +
          (fatSeg[f.key] ? '<small class="pn-cd-sub">' + fatSeg[f.key].enRiesgo + '/' + fatSeg[f.key].activos + '</small>' : '') + '</td>' +
      '</tr>';
    });
    /* fila total */
    h += '<tr class="pn-tot"><td class="pn-seg-nom"><b>TOTAL selección</b></td>' +
      '<td class="n">' + fmt(totalSel.operadores) + '</td>' +
      '<td class="n">' + fmt(totalSel.unidades) + '</td>' +
      '<td class="n">' + fmt(totalSel.diasActivos) + '</td>' +
      '<td class="n">' + horasHM(totalSel.horas) + '</td>' +
      '<td class="n">' + fmtCompacto(totalSel.km) + '</td>' +
      '<td class="n">' + fmt(totalSel.viajes) + '</td>' +
      '<td class="n">' + fmt(totalSel.evTotal) + '</td>' +
      '<td class="n">' + fmt(totalSel.ev100h, 1) + '</td>' +
      '<td class="n sc-' + claseSeg(totalSel.scoreSeg) + '"><b>' + (totalSel.scoreSeg == null ? '—' : totalSel.scoreSeg) + '</b></td>' +
      '<td class="n sc-' + claseOp(totalSel.scoreOp) + '"><b>' + (totalSel.scoreOp == null ? '—' : totalSel.scoreOp) + '</b></td>' +
      '<td class="n">' + (fatSel ? fmt(fatSel.pct, 0) + '%' : '—') + '</td></tr>';
    h += '</tbody></table></div>';

    /* 2026-08-08 — Se retiró el bloque "Clientes dentro de la selección":
       era un muro de tarjetas con op/h/ev/score por cliente que nadie leía y
       que no llevaba a ninguna decisión (petición del cliente). El corte por
       cliente sigue disponible con el segmentador "Segmentar por · Cliente",
       que sí recalcula toda la vista. */
    h += '</section>';

    /* pie metodológico */
    h += '<div class="pn-pie">' +
      '<b>Cómo se calcula.</b> Score de seguridad = FLOOR(95 − 0.003 × Puntos/horas×100) con pesos alto 50 · medio 25 · bajo 5, ' +
      'aplicado sobre los <b>agregados del segmento</b> (equivale a ponderar por horas; nunca es la media de los scores de operador). ' +
      'Score de operación = misma mecánica con los pesos de telemetría extendida del Módulo 3 (coef. 0.005) — ' +
      'presente en el <b>' + fmt(pctExt, 0) + '%</b> de los registros del periodo (la API no entrega telemetría extendida en todo el backfill). ' +
      '% en riesgo de fatiga = operadores activos con racha de <b>≥10 días</b> consecutivos trabajados (jornada ≥15 min y ≥5 km), criterio del Módulo 2. ' +
      'Los 8 filtros globales se aplican antes de cualquier agregación.' +
    '</div>';

    h += '</div>';
    container.innerHTML = h;

    /* ---------------------- interacción ---------------------- */
    function rerender() { render(container, container.__pnState); }
    function on(sel, fn) {
      var ns = container.querySelectorAll(sel);
      for (var i = 0; i < ns.length; i++) ns[i].addEventListener('click', fn);
    }
    on('[data-dim]', function () { UI.dim = this.getAttribute('data-dim'); UI.ocultas = {}; rerender(); });
    on('[data-met]', function () { UI.metrica = this.getAttribute('data-met'); rerender(); });
    on('[data-orden]', function () { UI.orden = this.getAttribute('data-orden'); rerender(); });
    on('[data-dir]', function () { UI.ordenDir = -UI.ordenDir; rerender(); });
    on('[data-serie]', function () {
      var k = this.getAttribute('data-serie');
      if (UI.ocultas[k]) delete UI.ocultas[k]; else UI.ocultas[k] = 1;
      rerender();
    });
    var ths = container.querySelectorAll('.pn-tabla-det th[data-col]');
    for (var t = 0; t < ths.length; t++) {
      (function (th) {
        var col = th.getAttribute('data-col');
        var act = function () {
          if (UI.tablaOrden === col) UI.tablaDir = -UI.tablaDir;
          else { UI.tablaOrden = col; UI.tablaDir = col === 'label' ? 1 : -1; }
          rerender();
        };
        th.addEventListener('click', act);
        th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
      })(ths[t]);
    }

    /* ------- gráficas expandibles a primer plano (UIX) -------
     * Cada card registra CÓMO se regenera su SVG al tamaño real del lienzo.
     * Al expandir/restaurar/redimensionar, UIX vuelve a llamar a estas
     * funciones: se dibuja de nuevo, no se escala. */
    function reg(id, gen) {
      var host = container.querySelector('#' + id);
      if (!host || !window.UIX) return;
      var l = host.querySelector('[data-graf-lienzo]');
      window.UIX.registrarGrafica(host, gen && l ? function (w, hh, exp) {
        l.innerHTML = gen(w, hh, exp);
        requestAnimationFrame(function () {
          var ns = l.querySelectorAll('.pn-bar, .pn-bar-prev, .pn-line');
          for (var i = 0; i < ns.length; i++) ns[i].classList.add('pn-anim');
        });
      } : null);
    }
    reg('pn-g-barras', function (w, hh, exp) { return svgBarras(filasSeg, met, etqPrev, w, hh, exp); });
    reg('pn-g-tendencia', function (w, hh, exp) { return svgTendencia(semanasAll, series, selSet, met, UI.ocultas, w, hh, exp); });
    reg('pn-g-dow', function (w, hh, exp) { return svgDow(dias, met, w, hh, exp); });
    reg('pn-g-mapa', null);   // el mapa de calor es una rejilla CSS: reflowea sola
    reg('pn-g-pvp', null);    // barras proporcionales en %: reflowean solas

    /* animación de entrada */
    requestAnimationFrame(function () {
      var ns = container.querySelectorAll('.pn-bar, .pn-bar-prev, .pn-line, .pn-pvp-b');
      for (var i = 0; i < ns.length; i++) ns[i].classList.add('pn-anim');
    });
  }

  /* delta compacto para celdas de tabla */
  function celdaDelta(cur, prev, dir, esScore) {
    if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return '';
    var d, txt;
    if (esScore) { d = cur - prev; txt = (d > 0 ? '+' : '') + fmt(d, 0); }
    else if (prev === 0) { if (cur === 0) return ''; d = 1; txt = 'nuevo'; }
    else { d = (cur - prev) / Math.abs(prev) * 100; txt = (d > 0 ? '+' : '') + fmt(d, 0) + '%'; }
    if (Math.abs(d) < 0.5 && !esScore) return '<small class="pn-cd pn-cd-eq">＝</small>';
    if (esScore && d === 0) return '<small class="pn-cd pn-cd-eq">＝</small>';
    var bueno = dir === 0 ? null : (dir > 0 ? d > 0 : d < 0);
    var cls = bueno == null ? 'neu' : (bueno ? 'good' : 'bad');
    return '<small class="pn-cd pn-cd-' + cls + '">' + (d > 0 ? '▲' : '▼') + txt + '</small>';
  }

  /* ============================== EXPORT ================================== */
  window.MODULOS = window.MODULOS || {};
  window.MODULOS[ID] = {
    id: ID,
    titulo: 'Panorama — KPIs por UDN y Cliente',
    render: render,
    /* lógica pura, para pruebas desde node/consola */
    core: {
      LLAVES: LLAVES, METRICAS: METRICAS,
      safetyScore: safetyScore, opScore: opScore,
      filtrar: filtrar, agrupar: agrupar, totalDe: totalDe,
      nuevoAcc: nuevoAcc, acum: acum, cerrar: cerrar,
      dowDe: dowDe, fatigaDe: fatigaDe
    }
  };
})();
