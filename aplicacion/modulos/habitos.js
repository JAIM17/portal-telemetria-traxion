/* ============================================================================
 * MÓDULO — HÁBITOS DE CONDUCCIÓN (tab "Evaluación")
 * ----------------------------------------------------------------------------
 * Reemplaza a la vista legacy inline de index.html (renderFleet/renderOperator
 * sobre el feed crudo). Consume el snapshot v2: registros operador×unidad×día
 * con las 12 llaves de seguridad + telemetría extendida + udn POR FILA.
 *
 * Pedidos del cliente (2026-07-28):
 *  1. KPIs de distribución de eventos y hábitos de conducción BIEN visualizados.
 *  2. Eventos por conductor SIN importar la UDN: aquí se agrupa SOLO por
 *     conductor y se coleccionan TODAS sus UDN (Map udn→horas). Con el filtro
 *     UDN en "Todas", una sola fila por conductor con su total transversal.
 *  3. Los chips del filtro de eventos (sección 5) por fin se VEN: recortan
 *     conteos, gráficas y matriz, con aviso visible de filtro parcial.
 *
 * 2026-08-08 — Un solo lugar para el tiempo:
 *  · Se retiraron los filtros locales del módulo (semanas/meses/limpiar). Tenían
 *    su propio estado y competían con el panel global: dos verdades para la
 *    misma pregunta. El universo temporal lo define AHORA sólo el filtro 7
 *    (Periodo) del panel lateral, que admite varias semanas → acumulado.
 *  · Badge de rango de fechas SIEMPRE visible (incluso con panel oculto).
 *
 * REGLA DURA: la fórmula del Score de Seguridad es INTOCABLE y vive en M1.
 * Este módulo CUENTA y PONDERA para visualizar (mismos pesos 50/25/5 y los
 * de hábitos de m3), pero no re-scorea a nadie.
 *
 * El desglose familia×severidad reutiliza las clases .fam-* de
 * score-seguridad.css (hoja global del portal) — mismo lenguaje visual que M1.
 * ========================================================================== */
(function () {
  'use strict';
  window.MODULOS = window.MODULOS || {};

  var ID = 'habitos';

  /* ---------- seguridad: 12 llaves (pesos solo para visualizar) ---------- */
  var LLAVES = ['AcAlto', 'AcMed', 'AcBajo', 'FrAlto', 'FrMed', 'FrBajo',
    'GirAlto', 'GirMed', 'GirBajo', 'VelAlto', 'VelMed', 'VelBajo'];
  var FAMILIAS = [
    { id: 'Ac', nombre: 'Aceleración', icono: 'aceleracion', pal: 1 },
    { id: 'Fr', nombre: 'Freno', icono: 'freno', pal: 2 },
    { id: 'Gir', nombre: 'Giro', icono: 'giro', pal: 3 },
    { id: 'Vel', nombre: 'Velocidad', icono: 'velocidad', pal: 4 },
  ];
  var NIVELES = [
    { id: 'Alto', nombre: 'Alto', peso: 50, op: 1 },
    { id: 'Med', nombre: 'Medio', peso: 25, op: 0.7 },
    { id: 'Bajo', nombre: 'Bajo', peso: 5, op: 0.45 },
  ];

  /* ---------- hábitos extendidos: mismos pesos que M3 Operación ---------- */
  var FAM_EXT = [
    { id: 'motor', label: 'Eficiencia motor', icono: 'operacion',
      pesos: { rpm_fuera_banda: 6, alto_consumo: 6, torque_bajo_rpm: 5, apagado_brusco: 8 } },
    { id: 'ralenti', label: 'Ralentí / Neutral', icono: 'reloj',
      pesos: { ralenti_5min: 2, ralenti_15min: 5, neutral: 8 } },
    { id: 'clutch', label: 'Clutch', icono: 'ajustes',
      pesos: { clutch_arranque_alto: 3, clutch_parado: 4, clutch_movimiento: 6 } },
    { id: 'pedales', label: 'Pedales', icono: 'velocidad',
      pesos: { freno_prolongado: 4, acelerador_brusco: 3, acelerador_detenido: 2 } },
  ];
  var PESOS_EXT = {}, FAM_DE_EXT = {};
  FAM_EXT.forEach(function (f) {
    Object.keys(f.pesos).forEach(function (k) { PESOS_EXT[k] = f.pesos[k]; FAM_DE_EXT[k] = f.id; });
  });
  var ETIQ_EXT = {
    rpm_fuera_banda: 'RPM fuera de banda', alto_consumo: 'Alto consumo', torque_bajo_rpm: 'Torque a RPM baja',
    apagado_brusco: 'Apagado brusco', ralenti_5min: 'Ralentí ≥5 min', ralenti_15min: 'Ralentí ≥15 min',
    neutral: 'Conducción en neutral', clutch_arranque_alto: 'Clutch: arranque en marcha alta',
    clutch_parado: 'Clutch pisado detenido', clutch_movimiento: 'Clutch pisado en movimiento',
    freno_prolongado: 'Freno pisado prolongado', acelerador_brusco: 'Acelerador brusco',
    acelerador_detenido: 'Acelerador detenido',
    adas: 'ADAS (proximidad/colisión)', dtc: 'Diagnóstico DTC', cinturon: 'Cinturón',
    motor_temp: 'Temperatura de motor', motor_fluidos: 'Fluidos de motor', bateria: 'Batería',
    energia: 'Energía/corte', seguridad_robo: 'Pánico / posible robo', exceso_40kmh: 'Exceso >40 km/h (zona)',
    ralenti_20min: 'Ralentí ≥20 min', ralenti_30min: 'Ralentí ≥30 min', rpm_alto_pedal: 'RPM alta con pedal',
    fuel_caida: 'Caída de combustible', fuel_carga: 'Carga de combustible', fuel_sensor: 'Sensor de combustible',
    falla_sensor: 'Falla de sensor', motor_hito: 'Hito de motor', odometro_hito: 'Hito de odómetro', otros: 'Otros',
  };

  /* ---------- utilidades ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n, d) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString('es-MX', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function ico(kind, accent) {
    return window.ICONOS ? window.ICONOS.ic(kind, { cls: 'hb-ic', accent: accent }) : '<span class="ic hb-ic"></span>';
  }
  /* semáforo EV/H (mismos umbrales que la vista legacy: 3 / 8 / 15) */
  function claseEvh(v) {
    if (v == null) return 'na';
    return v <= 3 ? 'ok' : v <= 8 ? 'warn' : v <= 15 ? 'high' : 'bad';
  }
  function pal(i) {
    var cs = getComputedStyle(document.documentElement);
    return (cs.getPropertyValue('--pal-' + i) || '').trim() || '#63666A';
  }

  /* estado de actividad — mismo patrón que M4 rankings */
  var ESTADOS = {};
  function estadoOp(n) { var e = ESTADOS[n]; return e ? e.estado : 'activo'; }
  function badgeEstado(n) {
    var e = ESTADOS[n];
    if (!e || e.estado === 'activo') return '';
    var lbl = e.estado === 'inactivo' ? 'INACTIVO' : 'POSIBLE BAJA';
    return '<span class="op-est ' + e.estado + '" title="Última actividad: ' + esc(e.ultimaSemana || '—') +
      ' · ' + e.semanasSin + ' sem sin señal">' + lbl + '</span>';
  }

  /* ---------- consejos (catálogo inyectado por index.html) ---------- */
  var CONSEJOS = null;

  /* ---------- estado UI (sobrevive re-render) ---------- */
  /* vista por defecto = telemetría EXTENDIDA */
  /* 2026-08-08: el módulo ya NO tiene filtros propios. El universo temporal lo
     define exclusivamente el filtro 7 (Periodo) del panel global, que ahora
     admite varias semanas (acumulado). */
  var ui = { verBajas: false, orden: 'ptsExt', sel: null, vista: 'ext' };
  var charts = {};
  function mk(id, host) {
    if (!window.echarts) return null;
    if (charts[id]) { charts[id].dispose(); }
    charts[id] = echarts.init(host, null, { renderer: 'canvas' });
    return charts[id];
  }

  /* =====================================================================
     UNIVERSO TEMPORAL (derivado del panel global)
     ===================================================================== */

  /**
   * Universo temporal efectivo, 100 % derivado de los filtros GLOBALES:
   *  - f.semanasComparar[] (filtro 7 en modo semana, multiselección) acota al
   *    conjunto EXACTO de semanas, para que un acumulado no contiguo
   *    (p. ej. W28 + W32) no arrastre las semanas de en medio.
   *  - f.desde / f.hasta se aplican SIEMPRE encima: son los que imponen el
   *    corte "a día vencido" dentro de la semana en curso.
   * Retorna { semanas:Set|null, desde:string|null, hasta:string|null }
   */
  function calcEfectivo(f) {
    f = f || {};
    var sems = f.semanasComparar || [];
    if (f.semanaActual && sems.indexOf(f.semanaActual) < 0) sems = sems.concat([f.semanaActual]);
    return {
      semanas: sems.length ? new Set(sems) : null,
      desde: f.desde || null,
      hasta: f.hasta || null
    };
  }

  /* ---------- filtrado (contrato DATA_CONTRACT §filtros) ---------- */
  function filtrar(regs, f, efectivo) {
    f = f || {};
    efectivo = efectivo || { semanas: null, desde: null, hasta: null };
    return regs.filter(function (r) {
      if (f.udn && r.udn !== f.udn) return false;
      if (f.cliente && r.cliente !== f.cliente) return false;
      if (f.operador && r.conductor !== f.operador) return false;
      if (f.vehiculo && r.vehicle_id !== f.vehiculo && r.placa !== f.vehiculo) return false;
      // Filtro temporal: conjunto de semanas Y rango (el rango impone el día vencido)
      if (efectivo.semanas && !efectivo.semanas.has(r.semana)) return false;
      if (efectivo.desde && r.fecha < efectivo.desde) return false;
      if (efectivo.hasta && r.fecha > efectivo.hasta) return false;
      return true;
    });
  }

  /* Descripción legible del rango efectivo para el badge */
  function rangoDesc(f, efectivo, regs) {
    if (efectivo.semanas && efectivo.semanas.size > 0) {
      var sems = Array.from(efectivo.semanas).sort();
      if (sems.length === 1) return { tipo: 'semana', texto: sems[0] };
      return { tipo: 'semanas', texto: sems.join(' + ') };
    }
    if (efectivo.desde || efectivo.hasta) {
      var d = efectivo.desde || '—', h = efectivo.hasta || '—';
      return { tipo: 'rango', texto: d + ' → ' + h };
    }
    // Sin ningún filtro: todo el histórico disponible en memoria
    if (regs && regs.length) {
      var fechas = regs.map(function(r){ return r.fecha; }).filter(Boolean).sort();
      if (fechas.length) return { tipo: 'todo', texto: fechas[0] + ' → ' + fechas[fechas.length-1] };
    }
    return { tipo: 'todo', texto: 'Todo el histórico' };
  }

  /* llaves activas de los chips: seguridad y extendido viajan juntos en f.eventos */
  function llavesActivas(f) {
    var sel = (f && f.eventos && f.eventos.length) ? f.eventos : null;
    if (!sel) return { seg: null, ext: null, n: 0 };
    var seg = sel.filter(function (k) { return LLAVES.indexOf(k) >= 0; });
    var ext = sel.filter(function (k) { return LLAVES.indexOf(k) < 0; });
    return { seg: seg.length ? seg : null, ext: ext.length ? ext : null, n: sel.length };
  }

  /* ---------- agregación por conductor, MULTI-UDN ---------- */
  function agregar(regs, act) {
    var por = {};
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i];
      if (r.sinIdentificar || r.esOperador === false) continue;
      var a = por[r.conductor];
      if (!a) {
        a = por[r.conductor] = {
          conductor: r.conductor, udns: {}, horas: 0, km: 0, viajes: 0,
          dias: {}, sem: {}, ev: {}, ext: {}, evTot: 0, extTot: 0, ptsSeg: 0, ptsExt: 0,
        };
      }
      a.horas += r.horas || 0; a.km += r.km || 0; a.viajes += r.viajes || 0;
      if (r.fecha) a.dias[r.fecha] = 1;
      if (r.udn) a.udns[r.udn] = (a.udns[r.udn] || 0) + (r.horas || 0);
      var w = r.semana || '';
      var sw = a.sem[w] || (a.sem[w] = { ev: 0, horas: 0 });
      sw.horas += r.horas || 0;
      for (var j = 0; j < LLAVES.length; j++) {
        var k = LLAVES[j];
        if (act.seg && act.seg.indexOf(k) < 0) continue;
        var n = (r.eventos && +r.eventos[k]) || 0;
        if (!n) continue;
        a.ev[k] = (a.ev[k] || 0) + n;
        a.evTot += n; sw.ev += n;
        a.ptsSeg += n * (k.indexOf('Alto') > 0 ? 50 : k.indexOf('Med') > 0 ? 25 : 5);
      }
      for (var e in (r.extendido || {})) {
        if (act.ext && act.ext.indexOf(e) < 0) continue;
        var ne = +r.extendido[e] || 0;
        if (!ne) continue;
        a.ext[e] = (a.ext[e] || 0) + ne;
        a.extTot += ne; sw.ev += 0;
        if (PESOS_EXT[e]) a.ptsExt += ne * PESOS_EXT[e];
      }
    }
    return Object.keys(por).map(function (nom) {
      var a = por[nom];
      a.diasN = Object.keys(a.dias).length;
      a.udnLista = Object.keys(a.udns).sort(function (x, y) { return a.udns[y] - a.udns[x]; });
      a.evXh = a.horas > 0 ? a.evTot / a.horas : null;
      a.ev100km = a.km > 0 ? a.evTot / a.km * 100 : null;
      a.extXh = a.horas > 0 ? a.extTot / a.horas : null;
      a.ptsSegX100h = a.horas > 0 ? a.ptsSeg / a.horas * 100 : null;
      a.ptsExtX100h = a.horas > 0 ? a.ptsExt / a.horas * 100 : null;
      var dom = null;
      for (var hk in a.ext) if (PESOS_EXT[hk]) {
        var pp = a.ext[hk] * PESOS_EXT[hk];
        if (!dom || pp > dom.pts) dom = { k: hk, pts: pp };
      }
      a.habitoDom = dom;
      return a;
    });
  }

  /* ---------- matriz familia × severidad (patrón desgloseHTML de M1) ---------- */
  function matrizHTML(evs, act) {
    var soloAct = act.seg;
    var maxPts = 1;
    var filas = FAMILIAS.map(function (f) {
      var celdas = NIVELES.map(function (nv) {
        var k = f.id + nv.id;
        var off = soloAct && soloAct.indexOf(k) < 0;
        var n = off ? 0 : ((evs && +evs[k]) || 0);
        var p = n * nv.peso;
        if (p > maxPts) maxPts = p;
        return { llave: k, n: n, pts: p, nivel: nv, off: off };
      });
      return { fam: f, celdas: celdas, totPts: celdas.reduce(function (s, c) { return s + c.pts; }, 0) };
    });
    var html = '<div class="fam-grid">' +
      '<div class="fam-head"><span></span>' +
      NIVELES.map(function (nv) { return '<span class="fam-nv">' + nv.nombre + ' <em>×' + nv.peso + '</em></span>'; }).join('') +
      '<span class="fam-nv fam-tot-h">Puntos</span></div>';
    filas.forEach(function (fila) {
      html += '<div class="fam-fila">' +
        '<span class="fam-nom">' + ico(fila.fam.icono) + esc(fila.fam.nombre) + '</span>' +
        fila.celdas.map(function (c) {
          var w = Math.max(c.pts / maxPts * 100, c.n > 0 ? 6 : 0);
          var sev = c.nivel.id === 'Alto' ? 'bad' : c.nivel.id === 'Med' ? 'high' : 'warn';
          return '<span class="fam-celda' + (c.off ? ' fam-off' : '') + '" title="' + c.llave + ': ' + c.n + ' evento(s) → ' + c.pts + ' pts' + (c.off ? ' (fuera del filtro)' : '') + '">' +
            '<i class="fam-barra fam-b-' + sev + '" style="width:' + w.toFixed(1) + '%"></i>' +
            '<b>' + fmt(c.n) + '</b>' +
            (c.pts > 0 ? '<em>+' + fmt(c.pts) + '</em>' : '<em class="cero">·</em>') +
            '</span>';
        }).join('') +
        '<span class="fam-tot">' + fmt(fila.totPts) + '</span></div>';
    });
    html += '<div class="fam-pie"><span>TOTAL PUNTOS PENALIZACIÓN</span><b>' +
      fmt(filas.reduce(function (s, f) { return s + f.totPts; }, 0)) + '</b></div></div>';
    return html;
  }

  /* ---------- detalle del conductor (fila expandida) ---------- */
  function detalleHTML(a, act) {
    var h = '<div class="hb-det">';
    h += '<div class="hb-det-udns">' + ico('panorama') + 'Operó en: ' +
      a.udnLista.map(function (u) {
        return '<span class="hb-udn-chip">' + esc(u) + ' <b>' + fmt(a.udns[u], 1) + ' h</b></span>';
      }).join('') + '</div>';
    h += '<div class="hb-det-grid">';
    h += '<div class="hb-det-col"><div class="hb-det-t">' + ico('seguridad') + 'Eventos de seguridad · familia × severidad</div>' +
      matrizHTML(a.ev, act) + '</div>';
    var habs = Object.keys(a.ext).map(function (k) {
      return { k: k, n: a.ext[k], pts: a.ext[k] * (PESOS_EXT[k] || 0), pond: !!PESOS_EXT[k] };
    }).sort(function (x, y) { return (y.pond - x.pond) || (y.pts - x.pts) || (y.n - x.n); });
    h += '<div class="hb-det-col"><div class="hb-det-t">' + ico('operacion') + 'Telemetría extendida (' + habs.length + ' categorías)</div>';
    if (!habs.length) h += '<div class="hb-vacio-mini">Sin telemetría extendida en el periodo.</div>';
    else {
      var maxP = Math.max(habs[0].pts, 1), maxN = habs.reduce(function (m, x) { return Math.max(m, x.n); }, 1);
      h += '<div class="hb-habitos">' + habs.slice(0, 14).map(function (x) {
        var consejo = CONSEJOS && CONSEJOS[x.k];
        var w = x.pond ? Math.max(4, x.pts / maxP * 100) : Math.max(4, x.n / maxN * 100);
        return '<div class="hb-hab' + (x.pond ? '' : ' hb-hab-info') + '"' +
          (consejo ? ' title="' + esc(typeof consejo === 'string' ? consejo : consejo.consejo || '') + '"' : '') + '>' +
          '<span class="hb-hab-n">' + esc(ETIQ_EXT[x.k] || x.k) + (x.pond ? '' : ' <em>info</em>') + '</span>' +
          '<span class="hb-hab-b"><i style="width:' + w.toFixed(0) + '%"></i></span>' +
          '<span class="hb-hab-v mono">' + fmt(x.n) + ' ev' + (x.pond ? ' · ' + fmt(x.pts) + ' pts' : '') + '</span></div>';
      }).join('') + (habs.length > 14 ? '<div class="hb-vacio-mini">+' + (habs.length - 14) + ' categorías más con menos eventos.</div>' : '') + '</div>';
    }
    var sems = Object.keys(a.sem).sort();
    if (sems.length > 1) {
      var maxEv = 1;
      sems.forEach(function (w) { if (a.sem[w].ev > maxEv) maxEv = a.sem[w].ev; });
      h += '<div class="hb-det-t" style="margin-top:12px">' + ico('tendencia') + 'Eventos por semana</div><div class="hb-sems">' +
        sems.map(function (w) {
          var s = a.sem[w];
          var evh = s.horas > 0 ? s.ev / s.horas : null;
          return '<div class="hb-sem" title="' + w + ': ' + s.ev + ' eventos · ' + fmt(s.horas, 1) + ' h">' +
            '<i class="hb-sem-b ' + claseEvh(evh) + '" style="height:' + Math.max(6, s.ev / maxEv * 100).toFixed(0) + '%"></i>' +
            '<span>' + w.slice(6) + '</span></div>';
        }).join('') + '</div>';
    }
    h += '</div></div>';
    return h;
  }

  /* ---------- render ---------- */
  var ORDENES = {
    ptsExt: { label: 'Penalización hábitos', get: function (a) { return a.ptsExt; } },
    extTot: { label: 'Ev. extendidos', get: function (a) { return a.extTot; } },
    evXh: { label: 'Eventos seg / hora', get: function (a) { return a.evXh; } },
    evTot: { label: 'Eventos seguridad', get: function (a) { return a.evTot; } },
    ptsSeg: { label: 'Penalización seguridad', get: function (a) { return a.ptsSeg; } },
    horas: { label: 'Horas', get: function (a) { return a.horas; } },
  };

  function render(container, state) {
    var data = (state && state.data) || {};
    var filtrosGlobales = (state && state.filtros) || {};
    ESTADOS = data.estadoOperador || {};
    var act = llavesActivas(filtrosGlobales);

    var todosRegistros = data.registros || [];

    // Universo temporal: sólo los filtros globales (filtro 7 · Periodo)
    var efectivo = calcEfectivo(filtrosGlobales);
    var regs = filtrar(todosRegistros, filtrosGlobales, efectivo);

    var root = document.createElement('section');
    root.className = 'hb-mod';
    container.innerHTML = '';
    container.appendChild(root);

    /* --- descripción del rango seleccionado (siempre visible) --- */
    var rDesc = rangoDesc(filtrosGlobales, efectivo, regs);
    var badgeDiv = document.createElement('div');
    badgeDiv.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap';
    badgeDiv.innerHTML = '<span class="hb-rango-badge">' +
      '<span class="hb-rb-ico">📅</span>' +
      '<b>' + esc(rDesc.tipo === 'semana' ? 'Semana' :
                  rDesc.tipo === 'semanas' ? 'Semanas' :
                  rDesc.tipo === 'mes' ? 'Mes' : 'Período') + '</b>' +
      '<em>' + esc(rDesc.texto) + '</em>' +
      (regs.length ? '<em>· ' + regs.length + ' registros</em>' : '') +
      '</span>' +
      (rDesc.tipo === 'todo' ?
        '<span style="font:400 9.5px var(--mono);color:var(--faint)">Usa el filtro 7 · Periodo del panel lateral para acotar</span>' : '');
    root.appendChild(badgeDiv);

    if (!regs.length) {
      root.innerHTML += '<div class="hb-vacio">Sin registros para los filtros seleccionados.' +
        '<small>Ajusta UDN o el filtro 7 · Periodo del panel lateral.</small></div>';
      return;
    }

    var ops = agregar(regs, act);
    var noActivos = ops.filter(function (a) { return estadoOp(a.conductor) !== 'activo'; });
    if (!ui.verBajas) ops = ops.filter(function (a) { return estadoOp(a.conductor) === 'activo'; });

    /* totales de flota */
    var tot = { ev: 0, horas: 0, ptsExt: 0, fam: {} };
    FAMILIAS.forEach(function (f) { tot.fam[f.id] = 0; });
    ops.forEach(function (a) {
      tot.ev += a.evTot; tot.horas += a.horas; tot.ptsExt += a.ptsExt;
      FAMILIAS.forEach(function (f) {
        NIVELES.forEach(function (nv) { tot.fam[f.id] += (a.ev[f.id + nv.id] || 0); });
      });
    });
    var famDom = FAMILIAS.slice().sort(function (x, y) { return tot.fam[y.id] - tot.fam[x.id]; })[0];
    var evhFlota = tot.horas > 0 ? tot.ev / tot.horas : null;
    var multiUdn = ops.filter(function (a) { return a.udnLista.length > 1; }).length;

    /* --- cabecera --- */
    var extFlota = 0;
    ops.forEach(function (a) { extFlota += a.extTot; });

    var head = document.createElement('header');
    head.className = 'hb-head';
    head.innerHTML =
      '<div class="hb-title">' + ico('evaluacion') + '<h2>Hábitos de conducción</h2>' +
      '<nav class="hb-vistas" role="tablist">' +
      '<button role="tab" data-v="ext" class="hb-vista' + (ui.vista === 'ext' ? ' on' : '') + '">Telemetría extendida</button>' +
      '<button role="tab" data-v="seg" class="hb-vista' + (ui.vista === 'seg' ? ' on' : '') + '">Seguridad (12 llaves)</button>' +
      '</nav>' +
      '<span class="hb-sub mono">' + ops.length + ' operadores' + (ui.verBajas ? '' : ' activos') +
      ' · ' + fmt(tot.ev) + ' eventos' +
      (multiUdn ? ' · ' + multiUdn + ' con más de una UDN' : '') + '</span>' +
      (act.n ? '<span class="hb-parcial mono" title="Los conteos, gráficas y la matriz solo incluyen los eventos seleccionados en el filtro 5">' +
        act.n + ' filtro' + (act.n === 1 ? '' : 's') + ' de evento ACTIVO' + (act.n === 1 ? '' : 'S') + ' · vista parcial</span>' : '') +
      (noActivos.length ?
        '<button type="button" class="hb-bajas mono' + (ui.verBajas ? ' on' : '') + '">' +
        (ui.verBajas ? noActivos.length + ' inactivos/bajas VISIBLES · ocultar'
          : '+' + noActivos.length + ' bajas ocultas · ver') + '</button>' : '') +
      '</div>';
    root.appendChild(head);
    var bBajas = head.querySelector('.hb-bajas');
    if (bBajas) bBajas.addEventListener('click', function () { ui.verBajas = !ui.verBajas; render(container, state); });
    head.querySelectorAll('.hb-vista').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.vista = b.dataset.v;
        ui.orden = ui.vista === 'ext' ? 'ptsExt' : 'evXh';
        render(container, state);
      });
    });

    /* --- KPIs --- */
    var kpis = document.createElement('div');
    kpis.className = 'hb-kpis stagger';
    function kpi(icon, label, val, sub, t) {
      return '<div class="hb-kpi' + (t ? ' ' + t : '') + '"><div class="hb-kpi-top">' + ico(icon) +
        '<span>' + esc(label) + '</span></div><div class="v">' + val + '</div>' +
        (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
    }
    var tempTot = 0, tempOps = [];
    ops.forEach(function (a) {
      var t = (a.ext.motor_temp || 0) + (a.ext.motor_fluidos || 0);
      if (t > 0) { tempTot += t; tempOps.push({ n: a.conductor, t: t }); }
    });
    tempOps.sort(function (x, y) { return y.t - x.t; });
    kpis.innerHTML =
      kpi('aviso', 'Temperatura / fluidos', fmt(tempTot),
        tempTot ? 'peor: ' + tempOps[0].n.split(/\s+/).slice(0, 2).join(' ') + ' (' + tempOps[0].t + ' ev)'
          : 'sin eventos de temperatura en el periodo', tempTot ? 'bad' : 'ok') +
      kpi('operacion', 'Telemetría extendida', fmt(extFlota),
        'eventos de hábitos y salud en el periodo', '') +
      kpi('ajustes', 'Penalización de hábitos /100 h', tot.horas > 0 ? fmt(tot.ptsExt / tot.horas * 100, 0) : '—',
        'MÁS ES PEOR · clutch · ralentí · pedales · motor', '') +
      kpi('aviso', 'Eventos de seguridad', fmt(tot.ev),
        (evhFlota == null ? '—' : fmt(evhFlota, 2)) + ' por hora (≤3 óptimo)', claseEvh(evhFlota)) +
      kpi(famDom.icono, 'Familia seg. dominante', esc(famDom.nombre),
        tot.ev ? Math.round(tot.fam[famDom.id] / tot.ev * 100) + '% del total' : 'sin eventos', '') +
      kpi('operadores', 'Operadores con datos', fmt(ops.length),
        multiUdn ? multiUdn + ' operaron en varias UDN' : 'todos en una sola UDN', '');
    root.appendChild(kpis);

    /* --- gráficas: dona familia×severidad + top-15 apilado --- */
    var esExt = ui.vista === 'ext';
    var gr = document.createElement('div');
    gr.className = 'hb-graficas';
    gr.innerHTML = esExt
      ? '<div class="hb-card" data-graf="Distribución de telemetría extendida por categoría">' +
        '<h3>' + ico('operacion') + 'Distribución de telemetría extendida</h3>' +
        '<p class="hb-hint">Todas las categorías extendidas: hábitos ponderados + señales informativas (ADAS, DTC, temperatura…). Reacciona al filtro de eventos.</p>' +
        '<div class="hb-lienzo" data-graf-lienzo><div id="hbDona" class="hb-chart"></div></div></div>' +
        '<div class="hb-card" data-graf="Top 15 operadores por puntos de hábitos, apilado por familia">' +
        '<h3>' + ico('ranking') + 'Top 15 por puntos de hábitos · por familia</h3>' +
        '<p class="hb-hint">Quién acumula más penalización de hábitos y de qué familia viene. Sin importar la UDN.</p>' +
        '<div class="hb-lienzo" data-graf-lienzo><div id="hbTop" class="hb-chart alto"></div></div></div>'
      : '<div class="hb-card" data-graf="Distribución de eventos por familia y severidad">' +
        '<h3>' + ico('seguridad') + 'Distribución por familia y severidad</h3>' +
        '<p class="hb-hint">Participación de cada familia (color) y severidad (intensidad) en el total. Reacciona al filtro de eventos.</p>' +
        '<div class="hb-lienzo" data-graf-lienzo><div id="hbDona" class="hb-chart"></div></div></div>' +
        '<div class="hb-card" data-graf="Top 15 operadores por eventos, apilado por familia">' +
        '<h3>' + ico('ranking') + 'Top 15 por eventos · desglose por familia</h3>' +
        '<p class="hb-hint">Los que más eventos generan y de qué familia vienen. Sin importar la UDN.</p>' +
        '<div class="hb-lienzo" data-graf-lienzo><div id="hbTop" class="hb-chart alto"></div></div></div>';
    root.appendChild(gr);

    /* --- tarjetas de hábitos extendidos --- */
    var famTot = {};
    FAM_EXT.forEach(function (f) { famTot[f.id] = { pts: 0, peores: [] }; });
    ops.forEach(function (a) {
      FAM_EXT.forEach(function (f) {
        var p = 0;
        Object.keys(f.pesos).forEach(function (k) { p += (a.ext[k] || 0) * f.pesos[k]; });
        if (p > 0) { famTot[f.id].pts += p; famTot[f.id].peores.push({ n: a.conductor, p: p }); }
      });
    });
    var tarj = document.createElement('div');
    tarj.className = 'hb-fams stagger';
    tarj.innerHTML = FAM_EXT.map(function (f) {
      var t = famTot[f.id];
      t.peores.sort(function (x, y) { return y.p - x.p; });
      return '<div class="hb-fam"><div class="hb-fam-h">' + ico(f.icono) + '<b>' + esc(f.label) + '</b>' +
        '<span class="mono">' + fmt(t.pts) + ' pts · ' + (tot.horas > 0 ? fmt(t.pts / tot.horas * 100, 0) : '—') + '/100h</span></div>' +
        (t.peores.length ? '<ol class="hb-fam-top">' + t.peores.slice(0, 3).map(function (x) {
          return '<li><span>' + esc(x.n.split(/\s+/).slice(0, 2).join(' ')) + '</span><b class="mono">' + fmt(x.p) + ' pts</b></li>';
        }).join('') + '</ol>' : '<div class="hb-vacio-mini">Sin penalizaciones.</div>') +
        '</div>';
    }).join('');
    root.appendChild(tarj);

    /* --- selector de orden + tabla de conductores --- */
    var ord = document.createElement('div');
    ord.className = 'hb-orden';
    ord.innerHTML = '<span class="mono">ORDENAR POR</span>' + Object.keys(ORDENES).map(function (k) {
      return '<button class="hb-chip mono' + (ui.orden === k ? ' on' : '') + '" data-k="' + k + '">' + ORDENES[k].label + '</button>';
    }).join('');
    root.appendChild(ord);
    ord.querySelectorAll('.hb-chip').forEach(function (b) {
      b.addEventListener('click', function () { ui.orden = b.dataset.k; render(container, state); });
    });

    var getOrden = ORDENES[ui.orden] || ORDENES.evXh;
    var lista = ops.slice().sort(function (x, y) {
      var vx = getOrden.get(x), vy = getOrden.get(y);
      if (vx == null && vy == null) return x.conductor.localeCompare(y.conductor, 'es');
      if (vx == null) return 1; if (vy == null) return -1;
      return vy - vx;
    });

    var tw = document.createElement('div');
    tw.className = 'hb-tabla-wrap';
    var filas = lista.map(function (a, i) {
      var abierto = ui.sel === a.conductor;
      var nom = '<td class="hb-nom"><strong>' + esc(a.conductor) + '</strong>' + badgeEstado(a.conductor) +
        '<small>' + a.udnLista.map(function (u) {
          return esc(u) + ' ' + fmt(a.udns[u], 0) + 'h';
        }).join(' · ') + (a.udnLista.length > 1 ? ' <b class="hb-multi">×' + a.udnLista.length + ' UDN</b>' : '') + '</small></td>';
      var h = '<tr class="hb-f' + (abierto ? ' on' : '') + '" data-op="' + esc(a.conductor) + '">' +
        '<td class="mono hb-pos">' + (i + 1) + '</td>' + nom;
      if (esExt) {
        h += '<td class="mono num">' + fmt(a.extTot) + '</td>' +
          '<td class="mono num"><b>' + fmt(a.ptsExt) + '</b></td>' +
          '<td class="hb-dom">' + (a.habitoDom ? esc(ETIQ_EXT[a.habitoDom.k] || a.habitoDom.k) +
            ' <span class="mono">' + fmt(a.habitoDom.pts) + ' pts</span>' : '—') + '</td>' +
          '<td class="mono num">' + fmt(a.evTot) + '</td>' +
          '<td class="mono num"><span class="hb-evh ' + claseEvh(a.evXh) + '">' + (a.evXh == null ? '—' : fmt(a.evXh, 2)) + '</span></td>';
      } else {
        h += '<td class="mono num">' + fmt(a.evTot) + '</td>' +
          '<td class="mono num"><span class="hb-evh ' + claseEvh(a.evXh) + '">' + (a.evXh == null ? '—' : fmt(a.evXh, 2)) + '</span></td>' +
          '<td class="mono num">' + (a.ev100km == null ? '—' : fmt(a.ev100km, 1)) + '</td>' +
          '<td class="mono num">' + fmt(a.ptsSeg) + '</td>' +
          '<td class="mono num">' + fmt(a.ptsExt) + '</td>';
      }
      h += '<td class="mono num">' + fmt(a.horas, 1) + '</td>' +
        '<td class="mono num">' + fmt(a.km, 0) + '</td>' +
        '<td class="mono num">' + a.diasN + '</td></tr>';
      if (abierto) h += '<tr class="hb-det-row"><td colspan="10">' + detalleHTML(a, act) + '</td></tr>';
      return h;
    }).join('');
    tw.innerHTML = '<p class="hb-nota mono">Eventos POR CONDUCTOR sumando TODAS sus UDN. Clic en una fila para el desglose completo.</p>' +
      '<table class="hb-tabla"><thead><tr>' +
      (esExt
        ? '<th>#</th><th>Operador · UDNs donde operó</th><th>Ev. extendidos</th><th>Pts hábitos</th><th>Hábito dominante</th><th>Ev. seg</th><th>Ev seg/h</th>'
        : '<th>#</th><th>Operador · UDNs donde operó</th><th>Eventos</th><th>Ev/h</th><th>Ev/100km</th><th>Pts seg</th><th>Pts hábitos</th>') +
      '<th>Horas</th><th>Km</th><th>Días</th>' +
      '</tr></thead><tbody>' + filas + '</tbody></table>';
    root.appendChild(tw);
    tw.querySelectorAll('tr[data-op]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        ui.sel = (ui.sel === tr.dataset.op) ? null : tr.dataset.op;
        render(container, state);
      });
    });

    /* --- pintar gráficas --- */
    pintarDona(ops, act);
    pintarTop(lista.slice(0, 15));
    if (window.UIX) {
      var dHost = gr.querySelector('#hbDona'), tHost = gr.querySelector('#hbTop');
      UIX.registrarGrafica(dHost.closest('[data-graf]'), function () { pintarDona(ops, act); });
      UIX.registrarGrafica(tHost.closest('[data-graf]'), function () { pintarTop(lista.slice(0, 15)); });
    }
  }

  function pintarDona(ops, act) {
    var host = document.getElementById('hbDona');
    if (!host || !window.echarts) return;
    var datos = [];
    if (ui.vista === 'ext') {
      var porCat = {};
      ops.forEach(function (a) { for (var k in a.ext) porCat[k] = (porCat[k] || 0) + a.ext[k]; });
      var cats = Object.keys(porCat).sort(function (x, y) { return porCat[y] - porCat[x]; });
      var FIJAS = ['motor_temp', 'motor_fluidos'];
      var top = cats.filter(function (k) { return FIJAS.indexOf(k) < 0; }).slice(0, 8);
      top.forEach(function (k, i) {
        datos.push({ name: ETIQ_EXT[k] || k, value: porCat[k],
          itemStyle: { color: pal((i % 8) + 1), opacity: PESOS_EXT[k] ? 1 : 0.55 } });
      });
      FIJAS.forEach(function (k) {
        if (porCat[k] > 0) datos.push({ name: ETIQ_EXT[k] || k, value: porCat[k],
          itemStyle: { color: (getComputedStyle(document.documentElement).getPropertyValue('--sem-bad') || '#D93F37').trim() } });
      });
      var resto = cats.filter(function (k) { return FIJAS.indexOf(k) < 0; }).slice(8)
        .reduce(function (s, k) { return s + porCat[k]; }, 0);
      if (resto > 0) datos.push({ name: 'Resto', value: resto, itemStyle: { color: '#9a9da1' } });
    } else {
      FAMILIAS.forEach(function (f) {
        NIVELES.forEach(function (nv) {
          var k = f.id + nv.id;
          var n = 0;
          ops.forEach(function (a) { n += a.ev[k] || 0; });
          if (n > 0) datos.push({ name: f.nombre + ' ' + nv.nombre.toLowerCase(), value: n,
            itemStyle: { color: pal(f.pal), opacity: nv.op } });
        });
      });
    }
    var ch = mk('dona', host);
    if (!ch) return;
    ch.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [{ type: 'pie', radius: ['42%', '72%'], data: datos,
        label: { fontSize: 10, color: getComputedStyle(document.body).color },
        emphasis: { scale: true } }],
    });
  }

  function pintarTop(top) {
    var host = document.getElementById('hbTop');
    if (!host || !window.echarts) return;
    var nombres = top.map(function (a) { return a.conductor.split(/\s+/).slice(0, 2).join(' '); }).reverse();
    var series;
    if (ui.vista === 'ext') {
      series = FAM_EXT.map(function (f, i) {
        return { name: f.label, type: 'bar', stack: 'ev',
          itemStyle: { color: pal(i + 1) },
          data: top.map(function (a) {
            var p = 0;
            Object.keys(f.pesos).forEach(function (k) { p += (a.ext[k] || 0) * f.pesos[k]; });
            return p;
          }).reverse() };
      });
    } else {
      series = FAMILIAS.map(function (f) {
        return { name: f.nombre, type: 'bar', stack: 'ev',
          itemStyle: { color: pal(f.pal) },
          data: top.map(function (a) {
            var n = 0; NIVELES.forEach(function (nv) { n += a.ev[f.id + nv.id] || 0; });
            return n;
          }).reverse() };
      });
    }
    var ch = mk('top', host);
    if (!ch) return;
    ch.setOption({
      grid: { left: 8, right: 24, top: 28, bottom: 8, containLabel: true },
      legend: { top: 0, textStyle: { fontSize: 10 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: nombres, axisLabel: { fontSize: 10 } },
      series: series,
    });
  }

  /* ---------- API pública ---------- */
  window.MODULOS[ID] = {
    id: ID,
    titulo: 'Hábitos de conducción',
    setConsejos: function (j) { CONSEJOS = j || null; },
    render: render,
  };
})();
