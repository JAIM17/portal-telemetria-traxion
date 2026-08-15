/* ============================================================================
 * MÓDULO 4 — Rankings & Calificaciones (PLAN_MAESTRO §4.4)
 * TRAXION / LIPU · DASHTRAX
 * ----------------------------------------------------------------------------
 * Consume el snapshot v2 (DATA_CONTRACT.md). TODO se deriva de `registros`
 * (grano operador × unidad × día) aplicando los 8 filtros jerárquicos y
 * RE-CALCULANDO agregados + score con la fórmula exacta (nunca promediar scores).
 *
 * FÓRMULA EXACTA SCORE SEGURIDAD (no alterar):
 *   Puntos = Altos*50 + Medios*25 + Bajos*5
 *   X100h  = Puntos / horas * 100
 *   Score  = FLOOR(95 - 0.003*X100h), min 5, max 95
 *
 * SCORE OPERACIÓN (misma estructura, sobre eventos `extendido`):
 *   pesos: severo {dtc:25, apagado_brusco:25, alto_consumo:25}
 *          medio  {rpm_fuera_banda:10, clutch_arranque_alto:10, clutch_parado:10,
 *                  clutch_movimiento:10, torque_bajo_rpm:10, freno_prolongado:10}
 *          leve   {ralenti_5min:5, ralenti_15min:5, neutral:5, acelerador_brusco:5,
 *                  acelerador_detenido:5, exceso_40kmh:5}
 *   ScoreOp = FLOOR(95 - 0.003 * PuntosOpX100h), min 5, max 95
 *
 * SCORE CARGA (semáforo días sin descanso ≤6 verde · 7 amarillo · 10 naranja · ≥15 rojo):
 *   ScoreCarga = clamp( 95 - max(0, rachaMax-6)*6 - max(0, promHorasDia-9)*5, 5, 95 )
 *
 * CALIFICACIÓN 10 → reprobado (pesos DEFAULT configurables en la UI, persisten
 * en localStorage): seguridad 50% · operación 30% · carga 20%.
 *   Cal = (Wseg*Sseg + Wop*Sop + Wcar*Scar) / (Wtotal*95) * 10   → 1 decimal
 *   Cal < 6.0 ⇒ REPROBADO.
 *
 * ÍNDICE DE DAÑO por unidad: dtc*10 + eventosAlto*5 + clutch/apagado/rpm*2 + Mechanic*1
 * ========================================================================== */
(function () {
  'use strict';
  window.MODULOS = window.MODULOS || {};

  var LLAVES = ['AcAlto','AcMed','AcBajo','FrAlto','FrMed','FrBajo','GirAlto','GirMed','GirBajo','VelAlto','VelMed','VelBajo'];
  var ALTOS = ['AcAlto','FrAlto','GirAlto','VelAlto'];
  var MEDS  = ['AcMed','FrMed','GirMed','VelMed'];
  var BAJOS = ['AcBajo','FrBajo','GirBajo','VelBajo'];

  var PESOS_OP = {
    dtc:25, apagado_brusco:25, alto_consumo:25,
    rpm_fuera_banda:10, clutch_arranque_alto:10, clutch_parado:10,
    clutch_movimiento:10, torque_bajo_rpm:10, freno_prolongado:10,
    ralenti_5min:5, ralenti_15min:5, neutral:5, acelerador_brusco:5,
    acelerador_detenido:5, exceso_40kmh:5
  };
  var PESOS_DANO_EXT = { clutch_arranque_alto:2, clutch_parado:2, clutch_movimiento:2, apagado_brusco:2, rpm_fuera_banda:2 };

  // pesos de calificación (persisten)
  var LS_KEY = 'm4_pesos_cal';
  var pesosCal = { seg: 50, op: 30, car: 20 };
  try { var s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && s.seg != null) pesosCal = s; } catch (e) {}

  // estado UI local del módulo (sobrevive re-render)
  /* dir: 1 = del PEOR al MEJOR (por defecto, petición 3) · -1 = al revés
   * verBajas: false = ranking SOLO con operadores activos (actividad ≤2 semanas
   * del archivo); las bajas nunca se ocultan en silencio — hay chip visible. */
  var ui = { vista: 'operadores', orden: 'cal', dir: 1, verBajas: false };

  /* Estado de actividad (snapshot.estadoOperador, ver aplicacion/archivo.js).
     Se refresca en cada render; helpers a nivel módulo para usarlos en filas,
     podio y tops sin arrastrar el snapshot por parámetros. */
  var ESTADOS = {};
  function estadoOp(n) { var e = ESTADOS[n]; return e ? e.estado : 'activo'; }
  function badgeEstado(n) {
    var e = ESTADOS[n];
    if (!e || e.estado === 'activo') return '';
    var lbl = e.estado === 'inactivo' ? 'INACTIVO' : 'POSIBLE BAJA';
    return '<span class="op-est ' + e.estado + '" title="Última actividad: ' + esc(e.ultimaSemana || '—') +
      ' · ' + e.semanasSin + ' sem sin señal">' + lbl + '</span>';
  }

  /* ---------------- utilidades ---------------- */
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function fmt(n, d) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(d == null ? 1 : d); }
  /* ---------- iconos DASHTRAX: registro único aplicacion/iconos.js ---------- */
  function ico(kind, accent) {
    return window.ICONOS
      ? window.ICONOS.ic(kind, { cls: 'm4-ic', accent: accent })
      : '<span class="ic m4-ic"></span>';
  }

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nombreCorto(n) { var p = String(n || '').split(/\s+/); return p.slice(0, 2).join(' '); }
  function semanaISO(dstr) {
    var d = dstr ? new Date(dstr + 'T12:00:00') : new Date();
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var dow = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dow);
    var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    var w = Math.ceil(((t - y0) / 864e5 + 1) / 7);
    return t.getUTCFullYear() + '-W' + (w < 10 ? '0' : '') + w;
  }

  // FÓRMULA EXACTA — no alterar
  function safetyScore(ev, horas) {
    var altos = 0, meds = 0, bajos = 0, k;
    for (k = 0; k < 4; k++) { altos += ev[ALTOS[k]] || 0; meds += ev[MEDS[k]] || 0; bajos += ev[BAJOS[k]] || 0; }
    var puntos = altos * 50 + meds * 25 + bajos * 5;
    if (!horas || horas <= 0) return { puntos: puntos, x100h: puntos === 0 ? 0 : null, score: puntos === 0 ? 95 : null };
    var x = puntos / horas * 100;
    return { puntos: puntos, x100h: x, score: clamp(Math.floor(95 - 0.003 * x), 5, 95) };
  }

  function opScore(ext, horas) {
    var pts = 0, k;
    for (k in PESOS_OP) pts += (ext[k] || 0) * PESOS_OP[k];
    if (!horas || horas <= 0) return { puntos: pts, x100h: pts === 0 ? 0 : null, score: pts === 0 ? 95 : null };
    var x = pts / horas * 100;
    return { puntos: pts, x100h: x, score: clamp(Math.floor(95 - 0.003 * x), 5, 95) };
  }

  function rachaMaxima(fechas) { // días activos consecutivos sin descanso
    var arr = Object.keys(fechas).sort(), max = 0, run = 0, prev = null, i;
    for (i = 0; i < arr.length; i++) {
      var d = new Date(arr[i] + 'T12:00:00');
      run = (prev && (d - prev) === 864e5) ? run + 1 : 1;
      if (run > max) max = run; prev = d;
    }
    return max;
  }

  function cargaScore(rachaMax, promHoras) {
    return clamp(Math.round(95 - Math.max(0, rachaMax - 6) * 6 - Math.max(0, promHoras - 9) * 5), 5, 95);
  }
  function semCarga(dias) { return dias >= 15 ? 'bad' : dias >= 10 ? 'high' : dias >= 7 ? 'warn' : 'ok'; }

  function calificacion(sSeg, sOp, sCar) {
    var w = pesosCal, tot = w.seg + w.op + w.car;
    if (!tot) return null;
    var vSeg = sSeg == null ? 5 : sSeg, vOp = sOp == null ? 5 : sOp, vCar = sCar == null ? 5 : sCar;
    return Math.round((w.seg * vSeg + w.op * vOp + w.car * vCar) / (tot * 95) * 100) / 10;
  }

  function danoIdx(a) { // a = acumulador con eventos/extendido/categorias/dtcN
    var altos = 0, i;
    for (i = 0; i < 4; i++) altos += a.eventos[ALTOS[i]] || 0;
    var mec = (a.categorias && a.categorias.Mechanic) || 0, ext2 = 0, k;
    for (k in PESOS_DANO_EXT) ext2 += (a.extendido[k] || 0) * PESOS_DANO_EXT[k];
    return (a.dtcN || 0) * 10 + altos * 5 + ext2 + mec;
  }

  /* ---------------- filtros (PLAN_MAESTRO §2 / DATA_CONTRACT) ---------------- */
  function filtrar(regs, f) {
    f = f || {};
    var sems = (f.semanasComparar && f.semanasComparar.length) ? f.semanasComparar : null;
    var semAct = f.semanaActual ? (typeof f.semanaActual === 'string' ? f.semanaActual : semanaISO()) : null;
    return regs.filter(function (r) {
      if (f.udn && r.udn !== f.udn) return false;
      if (f.cliente && r.cliente !== f.cliente) return false;
      if (f.operador && r.conductor !== f.operador) return false;
      if (f.vehiculo && r.vehicle_id !== f.vehiculo && r.placa !== f.vehiculo) return false;
      if (f.desde && r.fecha < f.desde) return false;
      if (f.hasta && r.fecha > f.hasta) return false;
      if (semAct && r.semana !== semAct) return false;
      if (sems && sems.indexOf(r.semana) === -1) return false;
      return true;
    });
  }

  function nuevoAcc() {
    var ev = {}, i; for (i = 0; i < LLAVES.length; i++) ev[LLAVES[i]] = 0;
    return { horas: 0, km: 0, viajes: 0, eventos: ev, extendido: {}, categorias: {}, dtcN: 0, fechas: {}, horasPorDia: {}, unidades: {}, semanas: {}, conductores: {}, udnsH: {} };
  }
  function acumular(a, r, llavesEvSel) {
    a.horas += r.horas || 0; a.km += r.km || 0; a.viajes += r.viajes || 0;
    var i, k;
    for (i = 0; i < LLAVES.length; i++) { k = LLAVES[i]; if (!llavesEvSel || llavesEvSel[k]) a.eventos[k] += (r.eventos && r.eventos[k]) || 0; }
    for (k in (r.extendido || {})) a.extendido[k] = (a.extendido[k] || 0) + r.extendido[k];
    for (k in (r.categorias || {})) a.categorias[k] = (a.categorias[k] || 0) + r.categorias[k];
    if (r.dtc && r.dtc.length) for (i = 0; i < r.dtc.length; i++) a.dtcN += r.dtc[i].n || 1;
    a.fechas[r.fecha] = 1;
    a.horasPorDia[r.fecha] = (a.horasPorDia[r.fecha] || 0) + (r.horas || 0);
    if (r.udn) a.udnsH[r.udn] = (a.udnsH[r.udn] || 0) + (r.horas || 0);
    if (r.placa) a.unidades[r.placa] = 1;
    a.semanas[r.semana] = 1;
    if ((!r.sinIdentificar && r.esOperador !== false)) a.conductores[r.conductor] = 1;   // solo personas
  }
  function totalSeg(ev) { var t = 0, i; for (i = 0; i < LLAVES.length; i++) t += ev[LLAVES[i]] || 0; return t; }

  /* ---------------- agregación por operador ---------------- */
  function agregarOperadores(regs, f) {
    var sel = null;
    if (f && f.eventos && f.eventos.length) { sel = {}; f.eventos.forEach(function (k) { sel[k] = 1; }); }
    var by = {}, i, r;
    for (i = 0; i < regs.length; i++) {
      r = regs[i];
      /* criterio central: "SIN OPERADOR (unidad)" no es una persona — no entra
         al ranking de operadores. Su telemetría vive en la vista de UNIDADES. */
      if (r.sinIdentificar || r.esOperador === false) continue;   // escuela y administrativos no rankean
      var a = by[r.conductor] || (by[r.conductor] = nuevoAcc());
      a.conductor = r.conductor; a.udn = r.udn; a.cliente = r.cliente;
      acumular(a, r, sel);
    }
    var out = [];
    for (var c in by) {
      var a2 = by[c];
      /* UDN del conductor = aquella donde acumuló MÁS horas en el periodo.
         Tomar la del último registro clasifica a los operadores multi-UDN por
         un dato accidental (cuál fue su última jornada) y los deja en el
         acordeón que no corresponde. */
      var udns = Object.keys(a2.udnsH).sort(function (x, y) { return a2.udnsH[y] - a2.udnsH[x]; });
      if (udns.length) a2.udn = udns[0];
      var seg = safetyScore(a2.eventos, a2.horas);
      var op = opScore(a2.extendido, a2.horas);
      var dias = Object.keys(a2.fechas).length;
      var racha = rachaMaxima(a2.fechas);
      var prom = dias ? a2.horas / dias : 0;
      var car = cargaScore(racha, prom);
      var evTot = totalSeg(a2.eventos);
      out.push({
        conductor: c, udn: a2.udn, cliente: a2.cliente, udnsN: udns.length, udnsLista: udns,
        horas: a2.horas, km: a2.km, viajes: a2.viajes,
        dias: dias, racha: racha, promHoras: prom,
        unidades: Object.keys(a2.unidades),
        evTot: evTot,
        evXh: a2.horas > 0 ? evTot / a2.horas : null,
        evX100km: a2.km > 0 ? evTot / a2.km * 100 : null,
        sSeg: seg.score, x100h: seg.x100h, puntos: seg.puntos,
        sOp: op.score, sCar: car,
        cal: calificacion(seg.score, op.score, car),
        acc: a2
      });
    }
    return out;
  }

  /* ---------------- agregación por unidad ---------------- */
  function agregarUnidades(regs, unidadesCat) {
    var info = {}; (unidadesCat || []).forEach(function (u) { info[u.vehicle_id] = u; });
    var by = {}, i, r;
    for (i = 0; i < regs.length; i++) {
      r = regs[i];
      var key = r.vehicle_id;
      var a = by[key] || (by[key] = nuevoAcc());
      a.vehicle_id = key; a.placa = r.placa; a.udn = r.udn;
      a.opSem = a.opSem || {};                                    // semana → set operadores
      if ((!r.sinIdentificar && r.esOperador !== false)) (a.opSem[r.semana] = a.opSem[r.semana] || {})[r.conductor] = 1;
      a.porOp = a.porOp || {};                                    // conductor → daño atribuible
      var d = a.porOp[r.conductor] || (a.porOp[r.conductor] = nuevoAcc());
      acumular(d, r, null);
      acumular(a, r, null);
    }
    var out = [];
    for (var k in by) {
      var a2 = by[k];
      var opsSemana = {}; for (var s2 in a2.opSem) opsSemana[s2] = Object.keys(a2.opSem[s2]).length;
      var correl = [];
      for (var c in a2.porOp) {
        var d2 = a2.porOp[c];
        /* el daño de los viajes sin identificar se conserva (la unidad la dañaron
           aunque no sepamos quién) pero NO se presenta como una persona */
        correl.push({ conductor: /^SIN OPERADOR/.test(c) ? 'Viajes sin identificar' : c,
          dano: danoIdx(d2), horas: d2.horas, eventos: totalSeg(d2.eventos), dtcN: d2.dtcN });
      }
      correl.sort(function (x, y) { return y.dano - x.dano; });
      out.push({
        vehicle_id: k, placa: a2.placa, udn: a2.udn,
        horas: a2.horas, km: a2.km,
        nOps: Object.keys(a2.conductores).length,
        opsSemana: opsSemana,
        eventos: totalSeg(a2.eventos), dtcN: a2.dtcN,
        dano: danoIdx(a2), correl: correl
      });
    }
    out.sort(function (x, y) { return y.dano - x.dano; });
    return out;
  }

  /* ---------------- tendencias por UDN × semana ---------------- */
  function tendencias(regs, semanas, dim) { // dim: 'udn' | 'cliente'
    var by = {}, i, r;
    for (i = 0; i < regs.length; i++) {
      r = regs[i];
      var g = r[dim] || '—';
      var a = (by[g] = by[g] || {});
      var w = (a[r.semana] = a[r.semana] || nuevoAcc());
      acumular(w, r, null);
    }
    var out = [];
    for (var g2 in by) {
      var serie = semanas.map(function (s) {
        var w2 = by[g2][s];
        if (!w2) return { semana: s, score: null, evXh: null, horas: 0 };
        var sc = safetyScore(w2.eventos, w2.horas);
        return { semana: s, score: sc.score, evXh: w2.horas > 0 ? totalSeg(w2.eventos) / w2.horas : null, horas: w2.horas, eventos: totalSeg(w2.eventos) };
      });
      var conDatos = serie.filter(function (p) { return p.score != null; });
      var delta = conDatos.length >= 2 ? conDatos[conDatos.length - 1].score - conDatos[conDatos.length - 2].score : null;
      out.push({ grupo: g2, serie: serie, delta: delta, horas: serie.reduce(function (t, p) { return t + p.horas; }, 0) });
    }
    out.sort(function (x, y) { return y.horas - x.horas; });
    return out;
  }

  /* ---------------- SVG custom ---------------- */
  function svgBarraH(valor, max, w, h, clase) {
    var pct = max > 0 ? clamp(valor / max, 0, 1) : 0;
    return '<svg class="m4-bar" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
      '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="2" class="m4-bar-bg"/>' +
      '<rect x="0" y="0" width="' + (pct * w).toFixed(1) + '" height="' + h + '" rx="2" class="m4-bar-fill ' + (clase || '') + '"/></svg>';
  }
  function svgSpark(serie, w, h) { // serie de {score}
    var pts = [], i, n = serie.length;
    if (!n) return '';
    var min = 5, max = 95, dx = n > 1 ? w / (n - 1) : 0;
    var d = '', started = false;
    for (i = 0; i < n; i++) {
      var v = serie[i].score;
      if (v == null) { continue; }
      var x = (n > 1 ? i * dx : w / 2).toFixed(1);
      var y = (h - 3 - (v - min) / (max - min) * (h - 6)).toFixed(1);
      d += (started ? 'L' : 'M') + x + ',' + y; started = true;
      pts.push('<circle cx="' + x + '" cy="' + y + '" r="2.2" class="m4-sp-dot"/>');
    }
    return '<svg class="m4-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<line x1="0" y1="' + (h - 3 - (70 - min) / (max - min) * (h - 6)).toFixed(1) + '" x2="' + w + '" y2="' + (h - 3 - (70 - min) / (max - min) * (h - 6)).toFixed(1) + '" class="m4-sp-ref"/>' +
      '<path d="' + d + '" class="m4-sp-line"/>' + pts.join('') + '</svg>';
  }
  function gaugeCal(cal) { // arco 0..10 (220° de barrido, sentido horario)
    var r = 26, cx = 32, cy = 30;
    var aIni = 200 * Math.PI / 180, span = 220 * Math.PI / 180; // 200° → -20°
    function arco(frac) {
      var ang = aIni - span * frac;
      return { x: cx + r * Math.cos(ang), y: cy - r * Math.sin(ang) };
    }
    function path(f0, f1) {
      var p0 = arco(f0), p1 = arco(f1);
      var large = (f1 - f0) * span > Math.PI ? 1 : 0;
      return 'M ' + p0.x.toFixed(1) + ' ' + p0.y.toFixed(1) + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1);
    }
    var frac = clamp((cal == null ? 0 : cal) / 10, 0, 1);
    var cls = cal == null ? 'na' : cal < 6 ? 'bad' : cal < 7.5 ? 'warn' : cal < 9 ? 'ok' : 'top';
    return '<svg class="m4-gauge" width="64" height="52" viewBox="0 0 64 52">' +
      '<path d="' + path(0, 1) + '" class="m4-g-bg"/>' +
      (frac > 0.01 ? '<path d="' + path(0, frac) + '" class="m4-g-val ' + cls + '"/>' : '') +
      '<text x="32" y="33" class="m4-g-txt ' + cls + '">' + (cal == null ? '—' : fmt(cal, 1)) + '</text>' +
      '<text x="32" y="46" class="m4-g-sub">' + (cal == null ? 'S/D' : cal < 6 ? 'REPROBADO' : 'CAL/10') + '</text></svg>';
  }

  /* ---------------- render ---------------- */
  /* `peor` = signo que hay que aplicar para dejar lo PEOR arriba:
   *   -1 → valores bajos son peores (calificación, scores)
   *   +1 → valores altos son peores (eventos por hora, por 100 km)
   * En horas y km no hay "peor": se ordena de mayor a menor exposición. */
  var ORDENES = {
    cal:     { label: 'Calificación /10', peor: -1, get: function (o) { return o.cal; } },
    sSeg:    { label: 'Score seguridad',  peor: -1, get: function (o) { return o.sSeg; } },
    sOp:     { label: 'Score operación',  peor: -1, get: function (o) { return o.sOp; } },
    sCar:    { label: 'Score carga',      peor: -1, get: function (o) { return o.sCar; } },
    evXh:    { label: 'Eventos / hora',   peor:  1, get: function (o) { return o.evXh; } },
    evX100km:{ label: 'Eventos / 100 km', peor:  1, get: function (o) { return o.evX100km; } },
    horas:   { label: 'Horas',            peor:  1, get: function (o) { return o.horas; } },
    km:      { label: 'Km',               peor:  1, get: function (o) { return o.km; } }
  };

  function render(container, state) {
    var data = state && state.data ? state.data : {};
    var filtros = state && state.filtros ? state.filtros : {};
    var regs = filtrar(data.registros || [], filtros);
    var semanas = data.semanas || [];
    var root = document.createElement('section');
    root.className = 'm4';
    container.innerHTML = '';
    container.appendChild(root);

    if (!regs.length) {
      root.innerHTML = '<div class="m4-empty"><span class="m4-empty-badge">M4</span>Sin registros para los filtros seleccionados.<br><small>Ajusta UDN, fechas o semanas para ver rankings.</small></div>';
      return;
    }

    var ops = agregarOperadores(regs, filtros);

    /* ---- SOLO ACTIVOS POR DEFECTO (petición del cliente 2026-07-27) ----
     * Con el año entero cargado, el ranking mezcla 500+ bajas con la plantilla
     * viva. Por defecto solo rankean ACTIVOS (actividad ≤2 semanas del archivo);
     * los demás se anuncian en un chip — NUNCA se ocultan en silencio. */
    ESTADOS = data.estadoOperador || {};
    var noActivos = ops.filter(function (o) { return estadoOp(o.conductor) !== 'activo'; });
    if (!ui.verBajas) ops = ops.filter(function (o) { return estadoOp(o.conductor) === 'activo'; });

    var unidades = agregarUnidades(regs, data.unidades);
    var tendUdn = tendencias(regs, semanas, 'udn');
    var tendCli = tendencias(regs, semanas, 'cliente');

    /* Orden por defecto: del PEOR al MEJOR. `dir` sólo invierte esa lectura,
       nunca cambia qué extremo es "peor" (eso lo dice ORDENES[k].peor). */
    function ordenar(lista) {
      var o = ORDENES[ui.orden] || ORDENES.cal;
      var signo = (o.peor || -1) * ui.dir;   // +1 → descendente, -1 → ascendente
      return lista.slice().sort(function (a, b) {
        var va = o.get(a), vb = o.get(b);
        if (va == null && vb == null) return a.conductor.localeCompare(b.conductor, 'es');
        if (va == null) return 1; if (vb == null) return -1;   // sin dato, siempre al final
        return signo > 0 ? vb - va : va - vb;
      });
    }

    /* --- cabecera del módulo + tabs --- */
    var head = document.createElement('header');
    head.className = 'm4-head';
    head.innerHTML =
      '<div class="m4-title"><span class="m4-num">04</span>' + ico('ranking') + '<h2>Rankings &amp; Calificaciones</h2>' +
      '<span class="m4-sub mono">' + ops.length + ' operadores' + (ui.verBajas ? '' : ' activos') + ' · ' + unidades.length + ' unidades · ' + regs.length + ' registros</span>' +
      (noActivos.length ?
        '<button type="button" class="m4-bajas mono' + (ui.verBajas ? ' on' : '') + '" ' +
          'title="Operadores sin actividad reciente (inactivos 2–4 sem · posible baja ≥5 sem)">' +
          (ui.verBajas ? noActivos.length + ' inactivos/bajas VISIBLES · ocultar'
                       : '+' + noActivos.length + ' bajas ocultas · ver') + '</button>' : '') +
      '</div>' +
      '<nav class="m4-tabs" role="tablist">' +
      ['operadores|Operadores', 'unidades|Unidades', 'tendencias|Tendencias'].map(function (t) {
        var p = t.split('|');
        return '<button role="tab" data-v="' + p[0] + '" class="m4-tab' + (ui.vista === p[0] ? ' on' : '') + '" aria-selected="' + (ui.vista === p[0]) + '">' + p[1] + '</button>';
      }).join('') + '</nav>';
    root.appendChild(head);
    head.querySelectorAll('.m4-tab').forEach(function (b) {
      b.addEventListener('click', function () { ui.vista = b.getAttribute('data-v'); render(container, state); });
    });
    var bBajas = head.querySelector('.m4-bajas');
    if (bBajas) bBajas.addEventListener('click', function () { ui.verBajas = !ui.verBajas; render(container, state); });

    var body = document.createElement('div');
    body.className = 'm4-body';
    root.appendChild(body);

    if (ui.vista === 'operadores') renderOperadores(body, ops, ordenar, container, state);
    else if (ui.vista === 'unidades') renderUnidades(body, unidades, semanas);
    else renderTendencias(body, tendUdn, tendCli, semanas);
    expandibles(body);
  }

  /* --- vista OPERADORES: podio mejor/peor + ranking + pesos --- */
  function renderOperadores(body, ops, ordenar, container, state) {
    var lista = ordenar(ops);
    var conCal = ops.filter(function (o) { return o.cal != null && o.horas >= 1; });
    conCal.sort(function (a, b) { return b.cal - a.cal; });
    var mejor = conCal[0], peor = conCal[conCal.length - 1];
    var reprobados = conCal.filter(function (o) { return o.cal < 6; }).length;
    var pctRepro = conCal.length ? reprobados / conCal.length * 100 : 0;

    var pod = document.createElement('div');
    pod.className = 'm4-podio';
    function tarjeta(o, tipo) {
      if (!o) return '<div class="m4-card m4-card-empty">—</div>';
      return '<article class="m4-card ' + tipo + '">' +
        '<div class="m4-card-tag mono">' + (tipo === 'best' ? ico('podio') + 'MEJOR OPERADOR' : ico('aviso') + 'PEOR OPERADOR') + '</div>' +
        '<div class="m4-card-row">' + gaugeCal(o.cal) +
        '<div class="m4-card-info"><strong>' + esc(o.conductor) + '</strong>' + badgeEstado(o.conductor) +
        '<span class="mono m4-card-udn">' + esc(o.udn) + '</span></div></div>' +
        '<div class="m4-card-scores mono">' +
        '<span>SEG <b>' + (o.sSeg == null ? '—' : o.sSeg) + '</b></span>' +
        '<span>OPE <b>' + (o.sOp == null ? '—' : o.sOp) + '</b></span>' +
        '<span>CAR <b>' + o.sCar + '</b></span>' +
        '<span>EV/H <b>' + fmt(o.evXh, 2) + '</b></span>' +
        '<span>EV/100KM <b>' + fmt(o.evX100km, 1) + '</b></span></div></article>';
    }
    pod.innerHTML = tarjeta(mejor, 'best') + tarjeta(peor, 'worst') +
      '<article class="m4-card m4-kpi"><div class="m4-card-tag mono">' + ico('balanza') + 'REPROBADOS (&lt;6.0)</div>' +
      '<div class="m4-kpi-v mono">' + reprobados + '<small>/' + conCal.length + '</small></div>' +
      svgBarraH(pctRepro, 100, 180, 8, pctRepro > 30 ? 'bad' : pctRepro > 10 ? 'warn' : 'ok') +
      '<div class="m4-kpi-pct mono">' + fmt(pctRepro, 1) + '% del total con ≥1 h</div></article>';
    body.appendChild(pod);

    /* ---------------------------------------------------------------
     * PETICIÓN 3 — TOP 10 PEORES y TOP 10 MEJORES.
     * Dos bloques deliberadamente distintos entre sí y del ranking largo:
     * el de peores lleva borde rojo, numeración descendente hacia el peor y
     * el motivo principal de la baja calificación; el de mejores va en lima,
     * más sobrio, sin diagnóstico. Sólo entran operadores con calificación
     * medible (≥1 h): sin horas no se es ni el peor ni el mejor.
     * ------------------------------------------------------------- */
    var tops = document.createElement('div');
    tops.className = 'm4-tops';
    var peores = conCal.slice().sort(function (a, b) { return a.cal - b.cal; }).slice(0, 10);
    var mejores = conCal.slice().sort(function (a, b) { return b.cal - a.cal; }).slice(0, 10);
    function motivo(o) {
      var c = [
        { l: 'seguridad', v: o.sSeg }, { l: 'operación', v: o.sOp }, { l: 'carga', v: o.sCar }
      ].filter(function (x) { return x.v != null; }).sort(function (x, y) { return x.v - y.v; })[0];
      return c ? c.l + ' ' + c.v : 'sin desglose';
    }
    function filaTop(o, i, tipo) {
      var cls = o.cal == null ? 'na' : o.cal < 6 ? 'bad' : o.cal < 7.5 ? 'warn' : o.cal < 9 ? 'ok' : 'top';
      return '<li class="m4-top-i">' +
        '<span class="m4-top-n mono">' + (i + 1) + '</span>' +
        '<span class="m4-top-nom"><b>' + esc(o.conductor) + '</b>' + badgeEstado(o.conductor) +
          '<i class="mono">' + esc(o.udn || '—') + ' · ' + fmt(o.horas, 0) + ' h' +
          (tipo === 'peor' ? ' · peor eje: ' + esc(motivo(o)) : '') + '</i></span>' +
        '<span class="m4-top-cal mono ' + cls + '">' + fmt(o.cal, 1) + '</span></li>';
    }
    if (peores.length) {
      tops.innerHTML =
        '<section class="m4-top m4-top-peor" data-graf="Top 10 peores operadores">' +
          '<h3 class="mono">' + ico('aviso') + 'TOP 10 PEORES' +
            '<em>calificación más baja · atender primero</em></h3>' +
          '<ol class="m4-top-l">' + peores.map(function (o, i) { return filaTop(o, i, 'peor'); }).join('') + '</ol>' +
        '</section>' +
        '<section class="m4-top m4-top-mejor" data-graf="Top 10 mejores operadores">' +
          '<h3 class="mono">' + ico('podio') + 'TOP 10 MEJORES' +
            '<em>calificación más alta · reconocer</em></h3>' +
          '<ol class="m4-top-l">' + mejores.map(function (o, i) { return filaTop(o, i, 'mejor'); }).join('') + '</ol>' +
        '</section>';
      body.appendChild(tops);
    }

    /* pesos configurables */
    var pw = document.createElement('div');
    pw.className = 'm4-pesos';
    pw.innerHTML = '<span class="m4-pesos-t mono">PESOS CALIFICACIÓN</span>' +
      [['seg', 'Seguridad'], ['op', 'Operación'], ['car', 'Carga']].map(function (p) {
        return '<label class="mono">' + p[1] + ' <input type="range" min="0" max="100" step="5" data-k="' + p[0] + '" value="' + pesosCal[p[0]] + '"><b data-out="' + p[0] + '">' + pesosCal[p[0]] + '%</b></label>';
      }).join('') +
      '<button class="m4-pesos-reset mono" title="Restaurar 50/30/20" aria-label="Restaurar 50/30/20">' + ico('reiniciar') + '</button>';
    body.appendChild(pw);
    pw.querySelectorAll('input[type=range]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        pesosCal[inp.getAttribute('data-k')] = +inp.value;
        pw.querySelector('[data-out="' + inp.getAttribute('data-k') + '"]').textContent = inp.value + '%';
      });
      inp.addEventListener('change', function () {
        try { localStorage.setItem(LS_KEY, JSON.stringify(pesosCal)); } catch (e) {}
        render(container, state);
      });
    });
    pw.querySelector('.m4-pesos-reset').addEventListener('click', function () {
      pesosCal = { seg: 50, op: 30, car: 20 };
      try { localStorage.setItem(LS_KEY, JSON.stringify(pesosCal)); } catch (e) {}
      render(container, state);
    });

    /* selector de orden */
    var ord = document.createElement('div');
    ord.className = 'm4-orden';
    ord.innerHTML = '<span class="mono">ORDENAR POR</span>' + Object.keys(ORDENES).map(function (k) {
      return '<button class="m4-chip mono' + (ui.orden === k ? ' on' : '') + '" data-k="' + k + '">' + ORDENES[k].label + '</button>';
    }).join('') + '<button class="m4-chip mono m4-dir' + (ui.dir === 1 ? ' on' : '') + '" title="Invertir el sentido del ranking">' +
      (ui.dir === 1 ? '▼ PEOR → MEJOR' : '▲ MEJOR → PEOR') + '</button>';
    body.appendChild(ord);
    ord.querySelectorAll('.m4-chip[data-k]').forEach(function (b) {
      b.addEventListener('click', function () { ui.orden = b.getAttribute('data-k'); render(container, state); });
    });
    ord.querySelector('.m4-dir').addEventListener('click', function () { ui.dir = -ui.dir; render(container, state); });

    /* tabla ranking */
    var maxEvXh = Math.max.apply(null, ops.map(function (o) { return o.evXh || 0; }).concat([0.001]));
    var tw = document.createElement('div');
    tw.className = 'm4-tabla-wrap';
    var filas = lista.map(function (o, i) {
      var calCls = o.cal == null ? 'na' : o.cal < 6 ? 'bad' : o.cal < 7.5 ? 'warn' : o.cal < 9 ? 'ok' : 'top';
      var sem = semCarga(o.racha);
      return '<tr data-udn="' + esc(o.udn || '—') + '" data-cliente="' + esc(o.cliente || o.udn || '—') + '">' +
        '<td class="mono m4-pos">' + (i + 1) + '</td>' +
        '<td class="m4-nom"><strong>' + esc(o.conductor) + '</strong>' + badgeEstado(o.conductor) +
        (o.udnsN > 1 ? '<span class="m4-multiudn" title="Operó en: ' + esc((o.udnsLista || []).join(' · ')) + '">×' + o.udnsN + ' UDN</span>' : '') +
        '<span class="mono">' + esc(o.udn) + ' · ' + o.unidades.length + ' unid.</span></td>' +
        '<td class="mono num"><span class="m4-cal ' + calCls + '">' + (o.cal == null ? '—' : fmt(o.cal, 1)) + '</span>' + (o.cal != null && o.cal < 6 ? '<em class="m4-rep">REPROBADO</em>' : '') + '</td>' +
        '<td class="mono num">' + (o.sSeg == null ? '—' : o.sSeg) + '</td>' +
        '<td class="mono num">' + (o.sOp == null ? '—' : o.sOp) + '</td>' +
        '<td class="mono num"><i class="m4-dot ' + sem + '"></i>' + o.sCar + '</td>' +
        '<td class="mono num">' + fmt(o.evXh, 2) + '<div class="m4-mini">' + svgBarraH(o.evXh || 0, maxEvXh, 70, 5, (o.evXh || 0) / maxEvXh > 0.66 ? 'bad' : (o.evXh || 0) / maxEvXh > 0.33 ? 'warn' : 'ok') + '</div></td>' +
        '<td class="mono num">' + fmt(o.evX100km, 1) + '</td>' +
        '<td class="mono num">' + fmt(o.horas, 1) + '</td>' +
        '<td class="mono num">' + fmt(o.km, 0) + '</td>' +
        '<td class="mono num">' + o.racha + 'd</td></tr>';
    }).join('');
    tw.setAttribute('data-graf', 'Ranking completo de operadores');
    tw.innerHTML = '<p class="m4-orden-nota mono">Ranking ordenado <b>del peor al mejor</b> por ' +
      esc((ORDENES[ui.orden] || ORDENES.cal).label) + '. Los grupos arrancan colapsados: abre la UDN que quieras revisar.</p>' +
      '<table class="m4-tabla"><thead><tr>' +
      '<th>#</th><th>Operador</th><th>Cal/10</th><th>Seg</th><th>Ope</th><th>Carga</th><th>Ev/h</th><th>Ev/100km</th><th>Horas</th><th>Km</th><th>Racha</th>' +
      '</tr></thead><tbody>' + filas + '</tbody></table>';
    body.appendChild(tw);

    /* Acordeón jerárquico UDN → operador (aplicacion/ui.js). El estado de
       expansión se recuerda entre renders y entre sesiones. */
    if (window.UIX) {
      window.UIX.agruparTabla(tw.querySelector('table'), {
        id: 'm4-ranking', niveles: ['udn'], etiquetas: ['UDN'],
        /* UDN peor primero: menor calificación media arriba (petición 3) */
        riesgo: function (trs, nivel, clave) {
          var cal = lista.filter(function (o) { return (o.udn || '—') === clave && o.cal != null && o.horas >= 1; });
          if (!cal.length) return -Infinity;
          return -cal.reduce(function (a, o) { return a + o.cal; }, 0) / cal.length;
        },
        resumen: function (nivel, clave, trs) {
          var g = lista.filter(function (o) { return (o.udn || '—') === clave; });
          var cal = g.filter(function (o) { return o.cal != null && o.horas >= 1; });
          var rep = cal.filter(function (o) { return o.cal < 6; }).length;
          var media = cal.length ? cal.reduce(function (a, o) { return a + o.cal; }, 0) / cal.length : null;
          var hrs = g.reduce(function (a, o) { return a + (o.horas || 0); }, 0);
          return '<b>' + g.length + '</b><i>operadores</i>' +
            '<b>' + (media == null ? '—' : fmt(media, 1)) + '</b><i>cal. media</i>' +
            '<b>' + fmt(hrs, 0) + '</b><i>h</i>' +
            (rep ? '<span class="m4-rep">' + rep + ' reprobados</span>' : '');
        }
      });
    }
  }

  /* Marca como expandibles las cards de esta vista. */
  function expandibles(body) {
    if (!window.UIX) return;
    body.querySelectorAll('[data-graf]').forEach(function (el) { window.UIX.registrarGrafica(el, null); });
  }

  /* --- vista UNIDADES --- */
  function renderUnidades(body, unidades, semanas) {
    var top = unidades.slice(0, 12);
    var maxDano = Math.max.apply(null, unidades.map(function (u) { return u.dano; }).concat([1]));

    var kpi = document.createElement('div');
    kpi.className = 'm4-ukpis';
    var multi = unidades.filter(function (u) { return u.nOps > 1; }).length;
    kpi.innerHTML =
      '<div class="m4-ukpi"><span class="mono">UNIDADES ACTIVAS</span><b class="mono">' + unidades.length + '</b></div>' +
      '<div class="m4-ukpi"><span class="mono">CON &gt;1 OPERADOR</span><b class="mono">' + multi + '</b></div>' +
      '<div class="m4-ukpi"><span class="mono">UNIDAD MÁS DAÑADA</span><b class="mono">' + (top[0] ? esc(top[0].placa) : '—') + '</b></div>' +
      '<div class="m4-ukpi"><span class="mono">DTC TOTALES</span><b class="mono">' + unidades.reduce(function (t, u) { return t + u.dtcN; }, 0) + '</b></div>';
    body.appendChild(kpi);

    var note = document.createElement('p');
    note.className = 'm4-nota mono';
    note.textContent = 'ÍNDICE DE DAÑO = DTC×10 + eventos nivel alto×5 + clutch/apagado/rpm×2 + Mechanic×1 · correlación = % del daño de la unidad atribuible a cada operador';
    body.appendChild(note);

    var grid = document.createElement('div');
    grid.className = 'm4-ugrid';
    grid.setAttribute('data-graf', 'Unidades por índice de daño');
    grid.innerHTML = top.map(function (u) {
      var opsSem = semanas.map(function (s) {
        var n = u.opsSemana[s] || 0;
        return '<div class="m4-usem"><span class="mono">' + s.slice(5) + '</span><b class="mono ' + (n > 3 ? 'bad' : n > 1 ? 'warn' : '') + '">' + (n || '·') + '</b></div>';
      }).join('');
      var correl = u.correl.slice(0, 4).map(function (c) {
        var pct = u.dano > 0 ? c.dano / u.dano * 100 : 0;
        return '<div class="m4-ucor"><span title="' + esc(c.conductor) + '">' + esc(nombreCorto(c.conductor)) + '</span>' +
          svgBarraH(pct, 100, 90, 5, pct > 50 ? 'bad' : pct > 25 ? 'warn' : 'ok') +
          '<b class="mono">' + fmt(pct, 0) + '%</b></div>';
      }).join('');
      return '<article class="m4-unidad">' +
        '<header><b class="mono">' + esc(u.placa || u.vehicle_id) + '</b><span class="mono">' + esc(u.udn) + '</span>' +
        '<span class="m4-dano mono ' + (u.dano / maxDano > 0.6 ? 'bad' : u.dano / maxDano > 0.3 ? 'warn' : 'ok') + '">DAÑO ' + u.dano + '</span></header>' +
        svgBarraH(u.dano, maxDano, 250, 6, u.dano / maxDano > 0.6 ? 'bad' : u.dano / maxDano > 0.3 ? 'warn' : 'ok') +
        '<div class="m4-ustats mono">' + u.nOps + ' ops · ' + u.eventos + ' ev · ' + u.dtcN + ' dtc · ' + fmt(u.horas, 0) + ' h</div>' +
        '<div class="m4-usems">' + opsSem + '<span class="m4-usems-t mono">OPS/SEM</span></div>' +
        '<div class="m4-ucors">' + correl + '</div></article>';
    }).join('');
    body.appendChild(grid);
  }

  /* --- vista TENDENCIAS --- */
  function renderTendencias(body, tendUdn, tendCli, semanas) {
    function bloque(titulo, lista) {
      var maxH = Math.max.apply(null, lista.map(function (t) { return t.horas; }).concat([1]));
      return '<section class="m4-tsec" data-graf="' + esc(titulo) + '"><h3 class="mono">' + ico('tendencia') + titulo + '</h3><div class="m4-tgrid">' +
        lista.map(function (t) {
          var ult = null; for (var i = t.serie.length - 1; i >= 0; i--) if (t.serie[i].score != null) { ult = t.serie[i].score; break; }
          var dCls = t.delta == null ? 'na' : t.delta > 0 ? 'up' : t.delta < 0 ? 'down' : 'flat';
          var dTxt = t.delta == null ? '—' : (t.delta > 0 ? '+' : '') + t.delta;
          return '<article class="m4-trend">' +
            '<header><b>' + esc(t.grupo) + '</b>' +
            '<span class="m4-delta mono ' + dCls + '">' + dTxt + ' <small>sem vs sem</small></span></header>' +
            '<div class="m4-trow">' + svgSpark(t.serie, 150, 44) +
            '<div class="m4-tscore mono"><b class="' + (ult == null ? 'na' : ult < 70 ? 'bad' : ult < 85 ? 'warn' : 'ok') + '">' + (ult == null ? '—' : ult) + '</b><span>score</span></div></div>' +
            '<div class="m4-tsems mono">' + t.serie.map(function (p) {
              return '<span title="' + p.semana + ': ' + (p.score == null ? 'sin datos' : 'score ' + p.score + ' · ' + fmt(p.evXh, 2) + ' ev/h') + '">' + p.semana.slice(6) + '<b>' + (p.score == null ? '·' : p.score) + '</b></span>';
            }).join('') + '</div>' +
            '<div class="m4-thoras">' + svgBarraH(t.horas, maxH, 150, 4, 'ok') + '<span class="mono">' + fmt(t.horas, 0) + ' h (' + fmt(t.horas / maxH * 100, 0) + '%)</span></div>' +
            '</article>';
        }).join('') + '</div></section>';
    }
    body.innerHTML = bloque('SCORE SEGURIDAD POR UDN × SEMANA', tendUdn) + bloque('POR CLIENTE × SEMANA', tendCli);
  }

  window.MODULOS.rankings = {
    id: 'rankings',
    titulo: 'Rankings & Calificaciones',
    render: render
  };
})();
