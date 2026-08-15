/* ============================================================================
 * MÓDULO 2 — CARGAS DE TRABAJO / FATIGA  (PLAN_MAESTRO §4.2)
 * ----------------------------------------------------------------------------
 * Mide exposición a fatiga por días consecutivos trabajados. Las cuatro reglas
 * que siguen son el criterio acordado con operaciones y definen todo el módulo;
 * cambiarlas mueve KPIs publicados. Ver docs/METRICAS.md § Jornada y fatiga.
 *
 *   1. DÍA TRABAJADO ⇔ horas BRUTAS ≥ UMBRAL_JORNADA_H. Por debajo del umbral
 *      el día es DESCANSO y ROMPE la racha. Un `registro` existe con que la
 *      unidad se mueva un minuto en el patio (maniobra, prueba de motor), así
 *      que "existe registro" no basta: sin umbral, la racha de todo el mundo
 *      degenera al número de días del periodo.
 *
 *   2. RACHA VIGENTE = racha viva EXACTAMENTE al último día del periodo. Si ese
 *      día no se trabajó, es 0. Una racha que terminó hace dos semanas no es
 *      exposición presente. Se reportan aparte `rachaMax` (la mayor del
 *      periodo) y `rachaAlUltimo` (la que cerró en el último día activo).
 *
 *   3. HUECO DE TELEMETRÍA ≠ DESCANSO. Los días sin cobertura de datos se
 *      marcan `sin_datos`: rompen la racha igual, pero se pintan distinto y
 *      marcan la racha como `incierta`. Un hueco del GPS no es evidencia de
 *      que el operador descansó.
 *
 *   4. HORAS PROMEDIO/DÍA = horas de días trabajados ÷ días trabajados. Nunca
 *      se divide entre días con cualquier registro: diluye la carga real.
 *
 * Semáforo (PLAN_MAESTRO, sobre la RACHA VIGENTE): ≤6 verde · 7 amarillo ·
 * 10 naranja · ≥15 rojo.
 *
 * Consume: snapshot v2 (DATA_CONTRACT.md) → data.registros (operador×unidad×día)
 * API:     window.MODULOS.cargas = { id, titulo, render(container, state), core }
 *          `core` expone la lógica pura, sin DOM, para poder verificarse aparte.
 * Vanilla JS + SVG custom, sin librerías. Lenguaje visual DASHTRAX.
 * ========================================================================== */
(function () {
  'use strict';

  var ID = 'cargas';
  var CSS_HREF = 'aplicacion/modulos/cargas-fatiga.css?v=61';

  /* ============================== CONSTANTES ============================== */

  /* Jornada mínima para contar un día como TRABAJADO: 3 horas BRUTAS de viaje.
   * Por debajo, el día equivale a descanso y REINICIA la racha de días
   * consecutivos. El corte es puramente por horas (km = 0, sin condición de
   * desplazamiento), coherente con las bandas del heatmap del calendario
   * (3 · 6 · 9 · 12 h → verde · amarillo · naranja · rojo) y con el criterio
   * corporativo DMAS contra el que concilia operaciones.
   *
   * Es un umbral DISTINTO del `esJornada()` del pipeline (core.mjs: ≥15 min y
   * ≥5 km), que responde a otra pregunta —actividad de la unidad, no jornada
   * laboral— y alimenta campos del snapshot que este módulo no consume.
   *
   * `PERFILES`/`PERFIL_DEFAULT` son la forma en que panorama.js y cerebro.js
   * heredan este mismo umbral (vía core.PERFILES[core.PERFIL_DEFAULT]): un solo
   * lugar donde cambiarlo para los tres módulos. */
  var UMBRAL_JORNADA_H = 3;   // horas BRUTAS mínimas para contar un día como TRABAJADO
  var PERFILES = {
    jornada: { id: 'jornada', label: '≥3 h', h: UMBRAL_JORNADA_H, km: 0 }
  };
  var PERFIL_DEFAULT = 'jornada';

  /* Un día se considera SIN DATOS (hueco de telemetría, no descanso) si en el
   * snapshot completo ese día reportó menos del 40% de la mediana de operadores. */
  var COBERTURA_MIN = 0.40;

  var DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var DOW_1 = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var MAX_COLS = 120;   // tope de columnas del calendario

  /* ============================== UTILIDADES ============================== */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureCss() {
    var prev = document.querySelector('link[data-modulo="' + ID + '"]');
    if (prev) return;  /* INVARIANTE: index.html es el DUEÑO de la versión de la
       hoja. Si este módulo reescribe el href, degrada la hoja ya cargada a la
       versión que traiga CSS_HREF en cada render y las reglas nuevas dejan de
       aplicarse. Sólo se inserta el <link> cuando aún no existe. */
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = CSS_HREF; l.setAttribute('data-modulo', ID);
    document.head.appendChild(l);
  }

  // 'YYYY-MM-DD' → número de día (época en días, UTC estable, sin DST)
  function dayNum(fecha) {
    var p = String(fecha).split('-');
    return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }
  function fechaDe(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  /* Hoy en hora local de la operación (UTC-6 fijo, Colima/GDL/LZC sin DST). */
  function hoyYmd() { return new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); }
  function dowDe(n) { return ((n + 4) % 7 + 7) % 7; }          // 1970-01-01 = jueves (4)

  function fmtH(h) {
    if (h == null || !isFinite(h)) return '—';
    var hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    if (mm === 60) { hh++; mm = 0; }
    return hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function fmtNum(n, d) { return (n == null || !isFinite(n)) ? '—' : n.toFixed(d == null ? 1 : d); }
  /* Miles con separador. Las cifras de ralentí llegan a 5 dígitos ("13302 L") y sin
     separador se leen mal; fmtNum se deja intacto porque lo usan las columnas
     tabulares, donde el separador rompe la alineación monoespaciada. */
  function fmtMiles(n, d) {
    return (n == null || !isFinite(n)) ? '—'
      : n.toLocaleString('es-MX', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  // un operador puede aparecer en varias UDN: se muestra la primera + contador
  function udnCorto(s) {
    var a = String(s || '').split(' · ').filter(Boolean);
    return a.length > 1 ? a[0] + ' +' + (a.length - 1) : (a[0] || '—');
  }
  function fmtFechaCorta(f) { if (!f) return '—'; var p = String(f).split('-'); return p[2] + '/' + p[1]; }
  function fmtFechaLarga(f) {
    if (!f) return '—';
    var p = String(f).split('-'); var n = dayNum(f);
    return DOW[dowDe(n)] + ' ' + p[2] + ' ' + MESES[+p[1] - 1];
  }

  /* ---------- semáforo (umbrales PLAN_MAESTRO §4.2 — no alterar) ----------
   * ≤6 verde · 7–9 amarillo · 10–14 naranja · ≥15 rojo   (sobre racha VIGENTE) */
  function semaforo(dias) {
    if (dias >= 15) return { nivel: 'rojo',     label: 'CRÍTICO', css: 'sem-rojo' };
    if (dias >= 10) return { nivel: 'naranja',  label: 'ALTO',    css: 'sem-naranja' };
    if (dias >= 7)  return { nivel: 'amarillo', label: 'VIGILAR', css: 'sem-amarillo' };
    return              { nivel: 'verde',    label: 'OK',      css: 'sem-verde' };
  }

  /* Texto del badge de racha vigente:
   *   · agotada → "≥N?"  (es al menos N; faltan datos previos para saber cuánto más)
   *   · incierta (hueco) → "N?"
   *   · cierta → "N"                                                          */
  function badgeRacha(o) {
    return (o.rachaAgotada ? '≥' : '') + o.racha + (o.rachaIncierta ? '?' : '');
  }
  function tipRacha(o) {
    if (o.rachaAgotada) return o.sem.label + ' — ≥' + o.racha + ' días sin descanso; el conteo llega al inicio de los datos cargados (faltan semanas previas)';
    if (o.rachaIncierta) return o.sem.label + ' — hay un hueco de telemetría en el tramo, la racha es incierta';
    return o.sem.label + ' — ' + o.racha + ' día' + (o.racha === 1 ? '' : 's') + ' consecutivos desde su último descanso';
  }

  /* ====================== LÓGICA PURA (testeable) ========================= */

  /* Filtrado sobre registros (DATA_CONTRACT §filtros) */
  function filtrarRegistros(data, f) {
    var regs = (data && data.registros) || [];
    f = f || {};
    var semanas = null;
    if (f.semanasComparar && f.semanasComparar.length) semanas = f.semanasComparar.slice();
    if (f.semanaActual) { semanas = semanas || []; if (semanas.indexOf(f.semanaActual) < 0) semanas.push(f.semanaActual); }
    return regs.filter(function (r) {
      /* criterio central: cargas/fatiga mide PERSONAS — un "SIN OPERADOR (unidad)"
         no tiene rachas ni descansos; su telemetría vive agregada por unidad. */
      if (r.sinIdentificar || r.esOperador === false) return false;
      if (f.udn && r.udn !== f.udn) return false;
      if (f.cliente && r.cliente !== f.cliente) return false;
      if (f.operador && r.conductor !== f.operador) return false;
      if (f.vehiculo && r.vehicle_id !== f.vehiculo && r.placa !== f.vehiculo) return false;
      if (f.desde && r.fecha < f.desde) return false;
      if (f.hasta && r.fecha > f.hasta) return false;
      if (semanas && semanas.indexOf(r.semana) < 0) return false;
      return true;
    });
  }

  /* Cobertura de datos del snapshot COMPLETO (no del filtrado): un hueco de
   * telemetría es una propiedad del pipeline, no del filtro que aplique el user.
   * → { 'YYYY-MM-DD': 'sin-registro' | 'parcial' } */
  function coberturaGlobal(registrosTodos, desde, hasta) {
    var porFecha = {};
    (registrosTodos || []).forEach(function (r) {
      if (r.sinIdentificar || r.esOperador === false) return;   // cobertura = plantilla
      (porFecha[r.fecha] = porFecha[r.fecha] || {})[r.conductor] = 1;
    });
    var counts = Object.keys(porFecha).map(function (f) { return Object.keys(porFecha[f]).length; })
      .sort(function (a, b) { return a - b; });
    var med = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    var minOk = med * COBERTURA_MIN;
    var out = {};
    if (!desde || !hasta) return out;
    for (var n = dayNum(desde), n1 = dayNum(hasta); n <= n1; n++) {
      var f = fechaDe(n);
      var c = porFecha[f] ? Object.keys(porFecha[f]).length : 0;
      if (c === 0) out[f] = 'sin-registro';
      else if (med > 0 && c < minOk) out[f] = 'parcial';
    }
    return out;
  }

  /* registros → { conductor: { dias:{fecha:{h,km,viajes,ev}}, udns, unidades } } */
  function agruparOperadores(regs) {
    var porOp = {};
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i];
      var o = porOp[r.conductor];
      if (!o) o = porOp[r.conductor] = { conductor: r.conductor, udns: {}, clientes: {}, unidades: {}, dias: {} };
      if (r.udn) o.udns[r.udn] = 1;
      if (r.cliente) o.clientes[r.cliente] = 1;
      if (r.placa) o.unidades[r.placa] = 1;
      var d = o.dias[r.fecha] || (o.dias[r.fecha] = { h: 0, km: 0, viajes: 0, ev: 0 });
      /* HORAS DE TRABAJO = horas BRUTAS de viaje (`r.horas`), con el ralentí
         DENTRO. Es deliberado: empata con el reporte corporativo "Uso DMAS",
         que es la cifra contra la que operaciones concilia. Usar las netas
         (`r.horasNetas`, que descuentan ralentí) produce un conteo de descansos
         mayor que el corporativo para el mismo periodo.
         La jornada (≥3 h) y las rachas de días sin descanso se evalúan sobre
         este valor bruto. */
      d.h += r.horas || 0;
      d.km += r.km || 0;
      d.viajes += r.viajes || 0;
      var ev = r.eventos || {};
      for (var k in ev) if (Object.prototype.hasOwnProperty.call(ev, k)) d.ev += ev[k] || 0;
    }
    return porOp;
  }

  /* Serie día a día del operador dentro de [desde, hasta].
   * estados: trabajado | minima | descanso | sin_datos | previo */
  function serieOperador(o, desde, hasta, umbral, sinDatos) {
    var d0 = dayNum(desde), d1 = dayNum(hasta);
    var fechasOp = Object.keys(o.dias).sort();
    var primer = fechasOp.length ? dayNum(fechasOp[0]) : null;
    var serie = [];
    for (var n = d0; n <= d1; n++) {
      var f = fechaDe(n);
      var dd = o.dias[f];
      var estado;
      if (dd && dd.h >= umbral.h && dd.km >= umbral.km) estado = 'trabajado';
      else if (dd && (dd.h > 0 || dd.viajes > 0 || dd.km > 0)) estado = 'minima';
      else if (sinDatos && sinDatos[f]) estado = 'sin_datos';
      else if (primer != null && n < primer) estado = 'previo';
      else estado = 'descanso';
      serie.push({
        fecha: f, dn: n, dow: dowDe(n), estado: estado,
        horas: dd ? dd.h : 0, km: dd ? dd.km : 0, viajes: dd ? dd.viajes : 0, eventos: dd ? dd.ev : 0,
        gap: !!(sinDatos && sinDatos[f])
      });
    }
    return serie;
  }

  /* Rachas = corridas de días consecutivos con estado 'trabajado'.
   * Cualquier otro estado (descanso, actividad mínima, hueco de datos) la corta. */
  function rachasDe(serie) {
    var out = [], cur = null;
    for (var i = 0; i < serie.length; i++) {
      var s = serie[i];
      if (s.estado === 'trabajado') {
        if (!cur) { cur = { ini: s.fecha, fin: s.fecha, i0: i, i1: i, dias: 0, horas: 0, km: 0, incierta: false }; out.push(cur); }
        cur.fin = s.fecha; cur.i1 = i; cur.dias++; cur.horas += s.horas; cur.km += s.km;
      } else {
        if (cur && s.estado === 'sin_datos') cur.incierta = true;   // la cortó un hueco, no un descanso probado
        cur = null;
      }
    }
    // una racha que arranca justo después de un hueco también es incierta por su borde izquierdo
    for (var j = 0; j < out.length; j++) {
      var r = out[j];
      if (r.i0 > 0 && serie[r.i0 - 1].estado === 'sin_datos') r.incierta = true;
    }
    return out;
  }

  /* ------------------------------------------------------------------------
   * RACHA VIGENTE (carga de trabajo). Criterio: el conteo se toma desde el
   * último día de inactividad del operador — ahí se reinicia.
   *
   * `serieFull` es la serie del operador desde el PRIMER día con datos cargados
   * hasta el día ANCLA (el cierre del periodo que se está mirando). NO se acota a
   * la semana filtrada: contamos hacia atrás sobre TODO el histórico disponible.
   *
   *   · día trabajado         → +1 y seguimos hacia atrás
   *   · descanso / act. mínima → el día de inactividad: PARA y REINICIA (racha cierta)
   *   · hueco de telemetría    → PARA, pero no es descanso probado → incierta
   *   · se acaban los datos    → PARA con la racha viva tocando el borde izquierdo
   *                              → `agotada`: es ≥N, faltan datos previos (incierta)
   * ---------------------------------------------------------------------- */
  function rachaVigenteDeSerie(serieFull) {
    var n = serieFull.length;
    if (!n) return { dias: 0, incierta: false, agotada: false, ini: null, i0: -1 };
    /* CORTE VENCIDO: los días colgantes del final SIN telemetría confirmada
     * (hueco de datos o día parcial aún abierto) NO anclan la racha — se saltan
     * y la vigente se evalúa en el último día con información completa. Solo un
     * descanso/actividad-mínima PROBADOS reinician a 0. */
    while (n > 0 && (serieFull[n - 1].estado === 'sin_datos' || serieFull[n - 1].estado === 'previo')) n--;
    if (!n) return { dias: 0, incierta: true, agotada: false, ini: null, i0: -1 };
    serieFull = serieFull.slice(0, n);
    var last = serieFull[n - 1];
    if (last.estado !== 'trabajado') {
      // el día ancla no fue jornada → la racha está reiniciada a 0.
      // sólo se marca incierta si ese último día es un hueco (no sabemos si trabajó).
      return { dias: 0, incierta: last.estado === 'sin_datos', agotada: false, ini: null, i0: -1 };
    }
    var i = n - 1, dias = 0, horas = 0, km = 0;
    while (i >= 0 && serieFull[i].estado === 'trabajado') {
      dias++; horas += serieFull[i].horas; km += serieFull[i].km; i--;
    }
    var i0 = i + 1;                       // primer día de la racha viva
    var agotada = (i < 0);               // se consumieron todos los datos aún trabajando
    var incierta = agotada || (i >= 0 && serieFull[i].estado === 'sin_datos');
    return {
      dias: dias, incierta: incierta, agotada: agotada,
      ini: serieFull[i0].fecha, i0: i0, horas: horas, km: km
    };
  }

  /* Corrida más larga de la serie (racha máxima "en el expediente cargado"). */
  function rachaMaxDeSerie(serieFull) {
    var rs = rachasDe(serieFull), max = 0, obj = null;
    for (var i = 0; i < rs.length; i++) if (rs[i].dias > max) { max = rs[i].dias; obj = rs[i]; }
    return { dias: max, obj: obj };
  }

  /* Métricas de fatiga de un operador.
   *   `serie`     — serie del PERIODO visible [desde,hasta] (calendario, agregados).
   *   `serieFull` — serie desde el primer día con datos cargados hasta el ANCLA
   *                 (cierre del periodo). Es la que manda para la RACHA VIGENTE:
   *                 mira hacia atrás cruzando el borde de la semana filtrada.
   *   Si no se pasa `serieFull`, la racha se calcula sobre el periodo (modo legacy). */
  function metricasOperador(o, serie, rachas, umbral, serieFull) {
    var n = serie.length;
    var diasTrabajados = 0, diasMinima = 0, diasDescanso = 0, diasSinDatos = 0;
    var horasTrabajo = 0, horasTotal = 0, kmTotal = 0, viajes = 0, eventos = 0;
    for (var i = 0; i < n; i++) {
      var s = serie[i];
      horasTotal += s.horas; kmTotal += s.km; viajes += s.viajes; eventos += s.eventos;
      if (s.estado === 'trabajado') { diasTrabajados++; horasTrabajo += s.horas; }
      else if (s.estado === 'minima') diasMinima++;
      else if (s.estado === 'sin_datos') diasSinDatos++;
      else if (s.estado === 'descanso') diasDescanso++;
    }

    var full = serieFull && serieFull.length ? serieFull : serie;

    // RACHA VIGENTE — sobre TODO el histórico cargado, anclada al cierre del periodo.
    var vig = rachaVigenteDeSerie(full);
    var vigente = vig.dias, vigenteIncierta = vig.incierta, vigenteAgotada = vig.agotada;

    // racha máxima "en el expediente cargado" (no sólo del periodo)
    var maxFull = rachaMaxDeSerie(full);
    var rachaMax = maxFull.dias, rachaMaxObj = maxFull.obj;

    // último día trabajado sobre TODO el histórico (para "descansando vs inactivo")
    var ultimo = null, ultimoIdx = -1;
    for (var k = 0; k < full.length; k++) if (full[k].estado === 'trabajado') { ultimo = full[k].fecha; ultimoIdx = k; }
    var diasDesdeUltimo = ultimoIdx >= 0 ? (full.length - 1 - ultimoIdx) : null;

    // corrida visible que termina en el borde derecho del periodo: es el tramo de la
    // racha vigente que cae DENTRO del calendario (puede ser menor que `vigente` si la
    // racha nació antes del periodo). Sólo se usa para resaltar la cinta.
    var ultimaCelda = serie[n - 1];
    var rachaObjVisible = (ultimaCelda && ultimaCelda.estado === 'trabajado' && rachas.length)
      ? rachas[rachas.length - 1] : null;

    return {
      conductor: o.conductor,
      udn: Object.keys(o.udns).sort().join(' · '),
      cliente: Object.keys(o.clientes).sort().join(' · '),
      unidades: Object.keys(o.unidades).length,
      serie: serie, rachas: rachas,
      diasTrabajados: diasTrabajados, diasMinima: diasMinima,
      diasDescanso: diasDescanso, diasSinDatos: diasSinDatos, diasPeriodo: n,
      horas: horasTrabajo, horasTotal: horasTotal, km: kmTotal, viajes: viajes, eventos: eventos,
      promHdia: diasTrabajados ? horasTrabajo / diasTrabajados : 0,
      promKmDia: diasTrabajados ? kmTotal / diasTrabajados : 0,
      racha: vigente,                    // ← la que manda en el semáforo (histórica)
      rachaIncierta: vigenteIncierta,
      rachaAgotada: vigenteAgotada,      // ≥N: se acabaron los datos previos sin ver descanso
      rachaInicio: vig.ini,              // primer día de la racha viva (puede ser < desde)
      rachaObj: rachaObjVisible,         // tramo visible de la racha vigente (cinta)
      rachaMax: rachaMax, rachaMaxObj: rachaMaxObj,
      rachaAlUltimo: vigente,
      ultimoDia: ultimo, diasDesdeUltimo: diasDesdeUltimo,
      sem: semaforo(vigente),
      semMax: semaforo(rachaMax),
      umbral: umbral
    };
  }

  /* Entrada única: registros filtrados → lista de operadores con métricas.
   *
   * opts.regsHist  — registros del operador SIN acotar por fecha/semana (mismos
   *                  filtros de entidad: udn/cliente/operador/unidad). De aquí sale
   *                  la RACHA VIGENTE, que mira hacia atrás cruzando semanas. Si no
   *                  se pasa, se usa `regs` (modo legacy: racha acotada al periodo).
   * opts.desdeHist — primer día con datos cargados (ancla izquierda del look-back).
   * opts.sinDatosHist — cobertura sobre [desdeHist, hasta] (huecos en el look-back). */
  function calcularCargas(regs, opts) {
    opts = opts || {};
    var umbral = opts.umbral || PERFILES[PERFIL_DEFAULT];
    var desde = opts.desde, hasta = opts.hasta;
    if (!desde || !hasta) {
      var fs = regs.map(function (r) { return r.fecha; }).sort();
      desde = desde || fs[0]; hasta = hasta || fs[fs.length - 1];
    }
    if (!desde || !hasta) return [];
    var sinDatos = opts.sinDatos || {};

    // Histórico para el look-back de la racha vigente (opcional).
    var porOpHist = null, desdeHist = null, sinDatosHist = null;
    if (opts.regsHist && opts.regsHist.length) {
      porOpHist = agruparOperadores(opts.regsHist);
      var fh = opts.regsHist.map(function (r) { return r.fecha; }).sort();
      desdeHist = opts.desdeHist || fh[0] || desde;
      if (desdeHist > desde) desdeHist = desde;           // nunca más tarde que el periodo
      sinDatosHist = opts.sinDatosHist || sinDatos;
    }

    var porOp = agruparOperadores(regs);
    var out = [];
    Object.keys(porOp).forEach(function (k) {
      var o = porOp[k];
      var serie = serieOperador(o, desde, hasta, umbral, sinDatos);
      var serieFull = null;
      if (porOpHist && porOpHist[k]) {
        // serie completa: del primer día cargado hasta el cierre del periodo (ancla).
        serieFull = serieOperador(porOpHist[k], desdeHist, hasta, umbral, sinDatosHist);
      }
      out.push(metricasOperador(o, serie, rachasDe(serie), umbral, serieFull));
    });
    return out;
  }

  /* Distribución de horas por día de la semana (sobre días trabajados) */
  function distribucionSemanal(ops) {
    var acc = [];
    for (var i = 0; i < 7; i++) acc.push({ dow: i, horas: 0, dias: 0, oportunidades: 0, km: 0 });
    ops.forEach(function (o) {
      o.serie.forEach(function (s) {
        if (s.estado === 'previo' || s.estado === 'sin_datos') return;
        var a = acc[s.dow];
        a.oportunidades++;
        if (s.estado === 'trabajado') { a.dias++; a.horas += s.horas; a.km += s.km; }
      });
    });
    // Orden de despliegue lunes→domingo (el modelo usa dow 0=domingo).
    var ORDEN_LUN = [1, 2, 3, 4, 5, 6, 0];
    return ORDEN_LUN.map(function (i) {
      var a = acc[i];
      return {
        dow: a.dow, label: DOW[a.dow], inicial: DOW_1[a.dow],
        dias: a.dias, oportunidades: a.oportunidades,
        promH: a.dias ? a.horas / a.dias : 0,
        promKm: a.dias ? a.km / a.dias : 0,
        pctActividad: a.oportunidades ? (a.dias / a.oportunidades) * 100 : 0
      };
    });
  }

  /* Tendencia por semana ISO: % de operadores que cerraron la semana con racha
   * vigente ≥10 días, y promedio de horas por día trabajado. */
  function tendenciaSemanal(ops, desde, hasta) {
    if (!ops.length) return [];
    var porSem = {};
    ops.forEach(function (o) {
      // recorremos la serie acumulando la racha viva día a día
      var run = 0;
      o.serie.forEach(function (s) {
        if (s.estado === 'trabajado') run++; else run = 0;
        var sem = isoWeek(s.fecha);
        var b = porSem[sem] || (porSem[sem] = { semana: sem, horas: 0, dias: 0, ops: {}, riesgo: {}, finRun: {} });
        if (s.estado === 'trabajado') { b.horas += s.horas; b.dias++; b.ops[o.conductor] = 1; }
        b.finRun[o.conductor] = run;                       // se queda con el último día de la semana
        if (run >= 10) b.riesgo[o.conductor] = 1;
      });
    });
    return Object.keys(porSem).sort().map(function (k) {
      var b = porSem[k];
      var activos = Object.keys(b.ops).length;
      return {
        semana: k,
        operadores: activos,
        diasTrabajados: b.dias,
        promHdia: b.dias ? b.horas / b.dias : 0,
        enRiesgo: Object.keys(b.riesgo).length,
        pctRiesgo: activos ? (Object.keys(b.riesgo).length / activos) * 100 : 0
      };
    });
  }

  /* '2026-W29' → { ini:'2026-07-13', fin:'2026-07-19' } (lunes→domingo ISO).
   * Se calcula del identificador, NO de las fechas observadas: si nadie manejó
   * el domingo, ese domingo TIENE que aparecer como descanso en el calendario. */
  function semanaRango(iso) {
    var m = /^(\d{4})-W(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    var jan4 = Date.UTC(+m[1], 0, 4) / 86400000;
    var lunesW1 = jan4 - ((dowDe(jan4) + 6) % 7);
    var ini = lunesW1 + (+m[2] - 1) * 7;
    return { ini: fechaDe(ini), fin: fechaDe(ini + 6) };
  }

  function isoWeek(fecha) {
    var p = String(fecha).split('-');
    var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    var day = (dt.getUTCDay() + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - day + 3);
    var jan4 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
    var wk = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return dt.getUTCFullYear() + '-W' + (wk < 10 ? '0' : '') + wk;
  }

  /* ================= ICONOS DASHTRAX (2 tonos) =====================
   * Registro único del portal: aplicacion/iconos.js. */
  function ico(kind, accent) {
    return window.ICONOS
      ? window.ICONOS.ic(kind, { cls: 'cf-ic', accent: accent })
      : '<span class="ic cf-ic"></span>';
  }

  /* ============================== VISUALES =============================== */

  /* Panel: distribución de horas por día de la semana */
  function svgSemana(dist, W0, H0, exp) {
    /* W/H reales del lienzo — al expandir se regenera a esa medida. */
    var W = Math.max(320, Math.round(W0 || 520));
    var H = Math.max(150, Math.round(H0 || 168));
    var padL = 30, padR = 12, padT = 12, padB = 34;
    var iw = W - padL - padR, ih = H - padT - padB;
    var maxH = Math.max(1, Math.ceil(Math.max.apply(null, dist.map(function (d) { return d.promH; })) * 1.15));
    var cw = iw / 7;
    var bw = Math.max(5, Math.min(cw * 0.46, 72));
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="cf-svg" role="img" aria-label="Horas promedio por día de la semana">';
    var nG = Math.max(3, Math.min(8, Math.round(ih / 46)));
    for (var g = 0; g <= nG; g++) {
      var gy = padT + ih * g / nG;
      out += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '" class="cf-grid"/>';
      out += '<text x="' + (padL - 6) + '" y="' + (gy + 3.2).toFixed(1) + '" class="cf-ax cf-ax-l">' + (maxH * (nG - g) / nG).toFixed(1) + '</text>';
    }
    dist.forEach(function (d, i) {
      var xc = padL + cw * (i + 0.5);
      // barra fantasma: % de actividad (qué tanto se trabaja ese día)
      var ha = ih * (d.pctActividad / 100);
      out += '<rect x="' + (xc - bw / 2 - 5).toFixed(1) + '" y="' + (padT + ih - ha).toFixed(1) + '" width="' + (bw + 10).toFixed(1) +
        '" height="' + Math.max(0.5, ha).toFixed(1) + '" rx="2" class="cf-bar-ghost"><title>' + d.label + ' — ' +
        d.pctActividad.toFixed(0) + '% de los días se trabajó (' + d.dias + '/' + d.oportunidades + ')</title></rect>';
      // barra principal: horas promedio del día trabajado
      var hh = ih * (d.promH / maxH);
      var y = padT + ih - hh;
      var cls = d.promH >= 10 ? ' hot' : (d.promH >= 8 ? ' warm' : '');
      out += '<rect x="' + (xc - bw / 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1.5, hh).toFixed(1) + '" rx="2" class="cf-bar' + cls + '"><title>' + d.label + ' — ' +
        fmtNum(d.promH, 2) + ' h promedio · ' + fmtNum(d.promKm, 0) + ' km · ' + d.dias + ' jornadas</title></rect>';
      out += '<text x="' + xc.toFixed(1) + '" y="' + (y - 5).toFixed(1) + '" class="cf-ax cf-ax-c cf-ax-strong">' + fmtNum(d.promH, 1) +
        (exp ? ' h' : '') + '</text>';
      out += '<text x="' + xc.toFixed(1) + '" y="' + (H - 17) + '" class="cf-ax cf-ax-c">' + d.label + '</text>';
      out += '<text x="' + xc.toFixed(1) + '" y="' + (H - 5) + '" class="cf-ax cf-ax-c cf-ax-dim">' + d.pctActividad.toFixed(0) + '%' +
        (exp ? ' · ' + fmtNum(d.promKm, 0) + ' km · ' + d.dias + ' jornadas' : '') + '</text>';
    });
    out += '</svg>';
    return out;
  }

  /* Panel: tendencia semanal (barras % ≥10d + línea h/día) */
  function svgTendencia(tend, W0, H0, exp) {
    if (!tend.length) return '<div class="cf-empty">Sin datos para la tendencia</div>';
    var W = Math.max(320, Math.round(W0 || 520));
    var H = Math.max(150, Math.round(H0 || 168));
    var padL = 32, padR = 32, padT = 16, padB = 30;
    var iw = W - padL - padR, ih = H - padT - padB, n = tend.length;
    var maxPct = Math.max(10, Math.ceil(Math.max.apply(null, tend.map(function (t) { return t.pctRiesgo; })) / 10) * 10);
    var maxH = Math.max(1, Math.ceil(Math.max.apply(null, tend.map(function (t) { return t.promHdia; }))));
    var bw = Math.max(4, Math.min(iw / n * 0.48, 76));
    var xC = function (i) { return padL + iw * (n === 1 ? 0.5 : (i + 0.5) / n); };
    var yPct = function (v) { return padT + ih * (1 - v / maxPct); };
    var yH = function (v) { return padT + ih * (1 - v / maxH); };

    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="cf-svg" role="img" aria-label="Tendencia semanal de fatiga">';
    for (var g = 0; g <= 2; g++) {
      var gy = padT + ih * g / 2;
      out += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" class="cf-grid"/>';
    }
    out += '<text x="' + (padL - 6) + '" y="' + (padT + 4) + '" class="cf-ax cf-ax-l">' + maxPct + '%</text>';
    out += '<text x="' + (padL - 6) + '" y="' + (padT + ih + 4) + '" class="cf-ax cf-ax-l">0%</text>';
    out += '<text x="' + (W - padR + 6) + '" y="' + (padT + 4) + '" class="cf-ax cf-ax-r">' + maxH + 'h</text>';
    out += '<text x="' + (W - padR + 6) + '" y="' + (padT + ih + 4) + '" class="cf-ax cf-ax-r">0h</text>';

    tend.forEach(function (t, i) {
      var x = xC(i) - bw / 2, y = yPct(t.pctRiesgo);
      out += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1.5, (padT + ih - y)).toFixed(1) + '" rx="2" class="cf-bar' + (t.pctRiesgo >= 20 ? ' hot' : ' warm') + '">' +
        '<title>' + esc(t.semana) + ' — ' + t.pctRiesgo.toFixed(0) + '% con racha ≥10d (' + t.enRiesgo + ' de ' + t.operadores + ')</title></rect>';
      out += '<text x="' + xC(i).toFixed(1) + '" y="' + (H - 8) + '" class="cf-ax cf-ax-c">' + esc(t.semana.replace(/^\d{4}-/, '')) + '</text>';
      if (t.pctRiesgo > 0) out += '<text x="' + xC(i).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" class="cf-ax cf-ax-c cf-ax-strong">' + t.pctRiesgo.toFixed(0) + '%' +
        (exp ? ' (' + t.enRiesgo + '/' + t.operadores + ')' : '') + '</text>';
    });
    var pts = tend.map(function (t, i) { return xC(i).toFixed(1) + ',' + yH(t.promHdia).toFixed(1); }).join(' ');
    out += '<polyline points="' + pts + '" class="cf-line"/>';
    tend.forEach(function (t, i) {
      out += '<circle cx="' + xC(i).toFixed(1) + '" cy="' + yH(t.promHdia).toFixed(1) + '" r="3.2" class="cf-dot">' +
        '<title>' + esc(t.semana) + ' — ' + fmtNum(t.promHdia, 2) + ' h por jornada · ' + t.diasTrabajados + ' jornadas</title></circle>';
      /* expandido: la línea de h/jornada también lleva su cifra */
      if (exp) out += '<text x="' + xC(i).toFixed(1) + '" y="' + (yH(t.promHdia) - 7).toFixed(1) + '" class="cf-ax cf-ax-c cf-ax-strong">' +
        fmtNum(t.promHdia, 1) + 'h</text>';
    });
    out += '</svg>';
    return out;
  }

  /* Panel: histograma de rachas vigentes con marcas 7/10/15 */
  function svgHistograma(ops) {
    var bins = [
      { k: '0',     min: 0,  max: 0,  css: 'sem-verde' },
      { k: '1–3',   min: 1,  max: 3,  css: 'sem-verde' },
      { k: '4–6',   min: 4,  max: 6,  css: 'sem-verde' },
      { k: '7–9',   min: 7,  max: 9,  css: 'sem-amarillo' },
      { k: '10–14', min: 10, max: 14, css: 'sem-naranja' },
      { k: '≥15',   min: 15, max: 999, css: 'sem-rojo' }
    ];
    bins.forEach(function (b) { b.n = 0; });
    ops.forEach(function (o) { for (var i = 0; i < bins.length; i++) if (o.racha >= bins[i].min && o.racha <= bins[i].max) { bins[i].n++; break; } });
    var max = Math.max.apply(null, bins.map(function (b) { return b.n; })) || 1;
    var out = '<div class="cf-hist">';
    bins.forEach(function (b) {
      out += '<div class="cf-hist-col" title="' + b.n + ' operadores con racha vigente de ' + b.k + ' días">' +
        '<div class="cf-hist-n">' + b.n + '</div>' +
        '<div class="cf-hist-bar-wrap"><div class="cf-hist-bar ' + b.css + '" style="height:' + Math.max(3, (b.n / max) * 100).toFixed(1) + '%"></div></div>' +
        '<div class="cf-hist-k">' + b.k + '</div></div>';
    });
    out += '</div>';
    return out;
  }

  /* Calendario/heatmap: encabezado de columnas */
  function calHeader(d0, d1, sinDatos) {
    var out = '<div class="cf-cal-head"><div class="cf-cal-name">Operador</div><div class="cf-cal-grid" style="--cols:' + (d1 - d0 + 1) + '">';
    for (var n = d0; n <= d1; n++) {
      var f = fechaDe(n), w = dowDe(n), dia = f.slice(8);
      var cls = 'cf-hcell' + (w === 0 || w === 6 ? ' wknd' : '') + (sinDatos[f] ? ' gap' : '') + (dia === '01' ? ' mes' : '');
      out += '<div class="' + cls + '" title="' + esc(fmtFechaLarga(f)) + (sinDatos[f] ? ' — sin cobertura de datos' : '') + '">' +
        '<span class="d">' + DOW_1[w] + '</span><span class="n">' + dia + '</span></div>';
    }
    out += '</div><div class="cf-cal-tail" title="Racha vigente al cierre del periodo · racha máxima del periodo">Racha<br>vig · máx</div></div>';
    return out;
  }

  /* Calendario/heatmap: una fila operador (celdas + cinta de rachas) */
  function calRow(o, d0, d1) {
    var cols = d1 - d0 + 1;
    var out = '<div class="cf-cal-row" data-op="' + esc(o.conductor) + '">';
    out += '<div class="cf-cal-name" title="' + esc(o.conductor + ' — ' + (o.udn || '')) + '">' +
      '<span class="nom">' + esc(o.conductor) + badgeEstado(o.conductor) + '</span>' +
      '<span class="udn">' + esc(udnCorto(o.udn)) + '</span></div>';
    out += '<div class="cf-cal-grid" style="--cols:' + cols + '">';
    o.serie.forEach(function (s) {
      var cls = 'cf-cell est-' + s.estado;
      // Día trabajado (≥3 h) → color de SEMÁFORO por horas de ESE día (no lime):
      //   3–6 verde · 6–9 amarillo · 9–12 naranja · ≥12 rojo. Un día <3 h no es
      //   'trabajado' (cae en 'minima'/'descanso') y se pinta neutro.
      if (s.estado === 'trabajado') cls += ' ' + (s.horas >= 12 ? 'hb-bad' : s.horas >= 9 ? 'hb-high' : s.horas >= 6 ? 'hb-warn' : 'hb-ok');
      if (s.dow === 0 || s.dow === 6) cls += ' wknd';
      var tip = fmtFechaLarga(s.fecha) + ' — ';
      if (s.estado === 'trabajado') tip += fmtH(s.horas) + ' h · ' + fmtNum(s.km, 0) + ' km · ' + s.viajes + ' viajes';
      else if (s.estado === 'minima') tip += 'actividad mínima (' + Math.round(s.horas * 60) + ' min · ' + fmtNum(s.km, 1) + ' km) → no cuenta como jornada';
      else if (s.estado === 'sin_datos') tip += 'sin cobertura de telemetría (no es descanso comprobado)';
      else if (s.estado === 'previo') tip += 'sin registros previos del operador';
      else tip += 'descanso';
      out += '<div class="' + cls + '" title="' + esc(tip) + '"></div>';
    });
    // cinta de rachas: cada corrida como una barra continua
    out += '<div class="cf-ribbon">';
    o.rachas.forEach(function (r) {
      var esVigente = o.racha > 0 && r === o.rachaObj;
      var sem = semaforo(r.dias);
      out += '<div class="cf-run ' + sem.css + (esVigente ? ' vigente' : '') + (r.incierta ? ' incierta' : '') + '"' +
        ' style="grid-column:' + (r.i0 + 1) + ' / span ' + (r.i1 - r.i0 + 1) + '"' +
        ' title="' + esc('Racha de ' + r.dias + ' día' + (r.dias === 1 ? '' : 's') + ': ' + fmtFechaCorta(r.ini) + ' → ' + fmtFechaCorta(r.fin) +
          ' · ' + fmtH(r.horas) + ' h' + (esVigente ? ' · VIGENTE al cierre' : '') + (r.incierta ? ' · borde con hueco de datos' : '')) + '"></div>';
    });
    out += '</div>';
    out += '</div>';
    out += '<div class="cf-cal-tail">' +
      '<span class="cf-badge ' + o.sem.css + (o.rachaIncierta ? ' dudosa' : '') + '" title="' + esc(tipRacha(o)) + '">' + badgeRacha(o) + '</span>' +
      '<span class="cf-badge ghost ' + o.semMax.css + '" title="Racha más larga en el expediente cargado">' + o.rachaMax + '</span>' +
      '</div>';
    out += '</div>';
    return out;
  }

  /* ============================ RENDER PRINCIPAL ========================== */

  /* verBajas: false = calendario/detalle SOLO con operadores activos (actividad
   * ≤1 semana de gap según snapshot.estadoOperador de archivo.js); las bajas
   * nunca se ocultan en silencio — hay chip visible (mismo patrón que M4). */
  var UI = { busca: '', soloRiesgo: false, orden: { col: 'racha', dir: -1 }, grupos: {}, gruposCal: {}, verBajas: false };

  /* Estado de actividad (snapshot.estadoOperador, ver aplicacion/archivo.js).
     Se refresca en cada render; helpers a nivel módulo para usarlos en calRow
     y filas de detalle sin arrastrar el snapshot por parámetros. */
  var ESTADOS = {};
  function estadoOp(n) { var e = ESTADOS[n]; return e ? e.estado : 'activo'; }
  function badgeEstado(n) {
    var e = ESTADOS[n];
    if (!e || e.estado === 'activo') return '';
    var lbl = e.estado === 'inactivo' ? 'INACTIVO' : 'POSIBLE BAJA';
    return '<span class="op-est ' + e.estado + '" title="Última actividad: ' + esc(e.ultimaSemana || '—') +
      ' · ' + e.semanasSin + ' sem sin señal">' + lbl + '</span>';
  }
  /* UDN oficiales del portal (docs/udn-map.json) + "Sin asignar". Sólo para el
     desempate del orden de grupos cuando dos UDN empatan en riesgo. */
  var UDN_CANON = ['Guadalajara', 'Colima', 'Lázaro Cárdenas', 'Sin asignar'];
  /* Columnas del detalle (una sola definición: alimenta cabecera, colgroup y filas).
     La columna UDN se elimina: el acordeón YA agrupa por UDN. */
  var COLS_DET = [
    { k: 'conductor',      lbl: 'Operador',       cls: '',    w: '17%', dir: 1 },
    { k: 'racha',          lbl: 'Racha vig.',     cls: 'num', w: '9%',  dir: -1 },
    { k: 'rachaMax',       lbl: 'Racha máx',      cls: 'num', w: '8%',  dir: -1 },
    { k: 'diasTrabajados', lbl: 'Jornadas',       cls: 'num', w: '8%',  dir: -1 },
    { k: 'diasDescanso',   lbl: 'Descanso',       cls: 'num', w: '8%',  dir: -1 },
    { k: 'diasMinima',     lbl: 'Act. mín.',      cls: 'num', w: '8%',  dir: -1 },
    { k: 'diasSinDatos',   lbl: 'Sin datos',      cls: 'num', w: '8%',  dir: -1 },
    { k: 'promHdia',       lbl: 'h / jornada',    cls: 'num', w: '9%',  dir: -1 },
    { k: 'horas',          lbl: 'Horas',          cls: 'num', w: '7%',  dir: -1 },
    { k: 'km',             lbl: 'Km',             cls: 'num', w: '7%',  dir: -1 },
    { k: 'ultimoDia',      lbl: 'Última jornada', cls: 'fecha', w: '11%', dir: 1 }
  ];
  function udnPrimaria(o) {
    var us = String(o.udn || '').split(' · ').filter(Boolean);
    return us[0] || 'Sin asignar';
  }
  function udnSlug(s) { return 'cfg-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  /* ---- Acordeón por UDN, compartido por AMBAS tablas (detalle y calendario) ----
     Agrupa una lista de operadores por su UDN primaria y ordena los grupos del más
     crítico (más operadores en riesgo ≥10d) al mejor. Cada llamador ordena luego
     los operadores DENTRO de su grupo como le convenga. */
  function gruposUDN(lista) {
    var mapa = {};
    lista.forEach(function (o) { var g = udnPrimaria(o); (mapa[g] = mapa[g] || []).push(o); });
    var grupos = Object.keys(mapa).map(function (g) {
      var arr = mapa[g];
      var enRiesgo = 0, criticos = 0, maxR = 0;
      arr.forEach(function (o) { if (o.racha >= 10) enRiesgo++; if (o.racha >= 15) criticos++; if (o.racha > maxR) maxR = o.racha; });
      return { udn: g, ops: arr, total: arr.length, enRiesgo: enRiesgo, criticos: criticos, maxRacha: maxR, pct: arr.length ? enRiesgo / arr.length : 0 };
    });
    grupos.sort(function (a, b) {
      return (b.enRiesgo - a.enRiesgo) || (b.pct - a.pct) || (b.criticos - a.criticos) ||
        (b.total - a.total) || (UDN_CANON.indexOf(a.udn) - UDN_CANON.indexOf(b.udn) < 0 ? 1 : -1);
    });
    return grupos;
  }

  /* Cabecera (botón) del grupo acordeón — mismo marcado/clases en ambas tablas:
     chevron + icono UDN + nombre (lima) + contador + resumen de riesgo. */
  function accHeadHTML(gr, abierto, bid) {
    var sum = '';
    if (gr.criticos) sum += '<span class="cf-acc-chip sem-rojo" title="' + gr.criticos + ' con racha vigente ≥15 días">' + gr.criticos + ' crítico' + (gr.criticos === 1 ? '' : 's') + '</span>';
    if (gr.enRiesgo) sum += '<span class="cf-acc-chip sem-naranja" title="' + gr.enRiesgo + ' con racha vigente ≥10 días">' + gr.enRiesgo + ' en riesgo</span>';
    if (!gr.enRiesgo) sum += '<span class="cf-acc-chip sem-verde">sin rachas ≥10d</span>';
    return '<button type="button" class="cf-acc-head" aria-expanded="' + abierto + '" aria-controls="' + bid + '">' +
      '<span class="cf-acc-chev">' + ico('chevron') + '</span>' +
      '<span class="cf-acc-ico">' + ico('udn') + '</span>' +
      '<span class="cf-acc-name">' + esc(gr.udn) + '</span>' +
      '<span class="cf-acc-count">' + gr.total + ' op' + (gr.total === 1 ? '' : 's') + '</span>' +
      '<span class="cf-acc-sum">' + sum +
        '<span class="cf-acc-max" title="Racha vigente máxima del grupo">máx <b>' + gr.maxRacha + 'd</b></span>' +
      '</span>' +
    '</button>';
  }
  /* semanas anteriores ya solicitadas al archivo (evita pedir dos veces en el mismo ciclo) */
  var RACHA_PENDIENTES = new Set();

  function render(container, state) {
    ensureCss();
    var data = (state && state.data) || {};
    var filtros = (state && state.filtros) || {};
    var regs = filtrarRegistros(data, filtros);

    // rango efectivo, acotado a la cobertura real del snapshot
    var desde = filtros.desde || data.from || null;
    var hasta = filtros.hasta || data.to || null;
    // los filtros de semana ISO son filtros de PERIODO: recortan el calendario
    var semanasSel = (filtros.semanasComparar || []).slice();
    if (filtros.semanaActual && semanasSel.indexOf(filtros.semanaActual) < 0) semanasSel.push(filtros.semanaActual);
    if (semanasSel.length) {
      var rangos = semanasSel.map(semanaRango).filter(Boolean);
      if (rangos.length) {
        var wIni = rangos.map(function (r) { return r.ini; }).sort()[0];
        var wFin = rangos.map(function (r) { return r.fin; }).sort().pop();
        if (!desde || wIni > desde) desde = wIni;
        if (!hasta || wFin < hasta) hasta = wFin;
      }
    }
    if (data.from && desde && desde < data.from) desde = data.from;
    if (data.to && hasta && hasta > data.to) hasta = data.to;
    /* CORTE VENCIDO (petición del cliente): la racha se evalúa al último día
     * COMPLETO. Ni "hoy" (aunque ya traiga viajes de la mañana) ni los días
     * colgantes sin telemetría cuentan como descanso ni rompen la racha:
     * corte = min(último día con datos de flota, AYER). */
    var ultimoConDatos = null;
    for (var ri = 0; ri < (data.registros || []).length; ri++) {
      var fx = data.registros[ri].fecha;
      if (fx && (!ultimoConDatos || fx > ultimoConDatos)) ultimoConDatos = fx;
    }
    var ayer = fechaDe(dayNum(hoyYmd()) - 1);
    var corte = ultimoConDatos && ultimoConDatos < ayer ? ultimoConDatos : ayer;
    if (hasta && hasta > corte) hasta = corte;
    if ((!desde || !hasta) && regs.length) {
      var fs = regs.map(function (r) { return r.fecha; }).sort();
      desde = desde || fs[0]; hasta = hasta || fs[fs.length - 1];
    }

    if (!regs.length || !desde || !hasta) {
      container.innerHTML = '<section class="cf-mod"><div class="cf-empty grande">' + ico('sinDatos') +
        '<div>Sin registros con los filtros actuales</div></section>';
      return;
    }

    var d0 = dayNum(desde), d1 = dayNum(hasta);
    if (d1 - d0 + 1 > MAX_COLS) { d0 = d1 - MAX_COLS + 1; desde = fechaDe(d0); }

    var umbral = PERFILES[PERFIL_DEFAULT];
    var sinDatos = coberturaGlobal(data.registros || [], desde, hasta);
    var nGaps = Object.keys(sinDatos).length;

    /* HISTÓRICO para la racha vigente: mismos filtros de ENTIDAD pero SIN acotar por
     * fecha/semana. Aunque el usuario mire "semana actual", la racha cuenta hacia atrás
     * sobre todas las semanas cargadas hasta topar con el último día de inactividad. */
    var regsHist = filtrarRegistros(data, {
      udn: filtros.udn, cliente: filtros.cliente, operador: filtros.operador, vehiculo: filtros.vehiculo
    });
    var desdeHist = (data.from && data.from < desde) ? data.from : desde;
    if (regsHist.length) {
      var fmin = regsHist.reduce(function (m, r) { return (m == null || r.fecha < m) ? r.fecha : m; }, null);
      if (fmin && fmin < desdeHist) desdeHist = fmin;
    }
    var sinDatosHist = (desdeHist < desde)
      ? coberturaGlobal(data.registros || [], desdeHist, hasta)
      : sinDatos;

    var ops = calcularCargas(regs, {
      desde: desde, hasta: hasta, umbral: umbral, sinDatos: sinDatos,
      regsHist: regsHist, desdeHist: desdeHist, sinDatosHist: sinDatosHist
    });

    /* ---- SOLO ACTIVOS POR DEFECTO (petición del cliente 2026-07-27) ----
     * Con el año entero cargado, calendario y detalle mezclan cientos de bajas
     * con la plantilla viva. Por defecto solo se listan ACTIVOS (gap ≤1 semana
     * del archivo); los demás se anuncian en un chip — NUNCA en silencio. */
    ESTADOS = data.estadoOperador || {};
    var noActivos = ops.filter(function (o) { return estadoOp(o.conductor) !== 'activo'; });
    if (!UI.verBajas) ops = ops.filter(function (o) { return estadoOp(o.conductor) === 'activo'; });

    /* Carga PEREZOSA hacia atrás: si algún operador sigue trabajando al toparse con el
     * primer día cargado (racha "agotada"), su racha real podría ser mayor. Pedimos la
     * semana anterior disponible del archivo y re-renderizamos; el ciclo para solo cuando
     * todos hallan su descanso o se agotan las semanas del archivo. */
    (function pedirHistoriaSiHace() {
      if (!window.ARCHIVO || typeof window.ARCHIVO.asegurar !== 'function') return;
      if (!ops.some(function (o) { return o.rachaAgotada; })) return;
      var disp = (window.ARCHIVO.disponibles || []).slice();
      var cargadas = new Set(window.ARCHIVO.cargadas || []);
      // semana disponible, aún no cargada, cuyo rango cae ANTES del primer día cargado
      var candidatas = disp.filter(function (s) { return !cargadas.has(s.semana) && s.to < desdeHist; })
        .sort(function (a, b) { return a.to < b.to ? 1 : -1; });   // la más reciente de las anteriores
      if (!candidatas.length) return;
      var prev = candidatas[0].semana;
      if (RACHA_PENDIENTES.has(prev)) return;                       // ya pedida en este ciclo
      RACHA_PENDIENTES.add(prev);
      window.ARCHIVO.asegurar([prev]).then(function (nuevo) {
        RACHA_PENDIENTES.delete(prev);
        if (nuevo && typeof state.recargar === 'function') state.recargar();
      }).catch(function () { RACHA_PENDIENTES.delete(prev); });
    })();
    var dist = distribucionSemanal(ops);
    var tend = tendenciaSemanal(ops, desde, hasta);

    /* ---- agregados de cabecera ---- */
    var total = ops.length;
    var cuenta = { verde: 0, amarillo: 0, naranja: 0, rojo: 0 };
    ops.forEach(function (o) { cuenta[o.sem.nivel]++; });
    var enRiesgo = cuenta.naranja + cuenta.rojo;
    var pctRiesgo = total ? (enRiesgo / total) * 100 : 0;
    // "descansando" sólo si estuvo activo hace poco; si lleva ≥7 días sin manejar
    // no está descansando, está inactivo (baja, vacaciones, cambio de unidad)
    var descansando = ops.filter(function (o) { return o.racha === 0 && o.diasDesdeUltimo != null && o.diasDesdeUltimo <= 6; }).length;
    var inactivos = ops.filter(function (o) { return o.racha === 0 && (o.diasDesdeUltimo == null || o.diasDesdeUltimo > 6); }).length;
    var maxVigente = ops.reduce(function (m, o) { return Math.max(m, o.racha); }, 0);
    var maxVigenteAgotada = ops.some(function (o) { return o.racha === maxVigente && o.rachaAgotada; });
    var promGlobal = (function () {
      var h = 0, d = 0;
      ops.forEach(function (o) { h += o.horas; d += o.diasTrabajados; });
      return d ? h / d : 0;
    })();
    var opsIncierta = ops.filter(function (o) { return o.rachaIncierta; }).length;

    /* ---- RALENTÍ (sidecar <semana>.ralenti.json vía archivo.js) --------------
     * `horas` del snapshot es tiempo BRUTO: lleva el ralentí DENTRO. Aquí se separa
     * lo que fue conducir de lo que fue estar parado con el motor encendido.
     * `ralenti == null` = semana aún sin enriquecer; NO es cero, y se distingue en la UI.
     * Parámetros de costo en un solo sitio, para que operaciones los ajuste. */
    var COSTO_RAL = { litros_por_hora: 3.0, mxn_por_litro: 26.0 };
    var ral = (function () {
      var r = 0, bruto = 0, n = 0;
      regs.forEach(function (x) {
        if (x.ralenti == null) return;
        r += x.ralenti; bruto += x.horas || 0; n++;
      });
      if (!n) return null;
      return {
        horas: r, netas: Math.max(0, bruto - r),
        pct: bruto ? (r / bruto) * 100 : 0,
        litros: r * COSTO_RAL.litros_por_hora,
        mxn: r * COSTO_RAL.litros_por_hora * COSTO_RAL.mxn_por_litro,
        cobertura: regs.length ? (n / regs.length) * 100 : 0,
      };
    })();

    var alertas = ops.filter(function (o) { return o.racha >= 10; })
      .sort(function (a, b) { return b.racha - a.racha || b.promHdia - a.promHdia; });

    /* ---- HTML ---- */
    var h = '';
    h += '<section class="cf-mod" aria-label="Cargas de trabajo y fatiga">';

    /* cabecera */
    h += '<header class="cf-head">';
    h += '<div class="cf-head-l">';
    h += '<h2 class="cf-title">Cargas de trabajo <em>/ fatiga</em></h2>';
    h += '<div class="cf-sub">' + esc(fmtFechaLarga(desde)) + ' → ' + esc(fmtFechaLarga(hasta)) +
      ' · ' + (d1 - d0 + 1) + ' días · ' + total + ' operadores' + (UI.verBajas ? '' : ' activos') +
      (noActivos.length ?
        ' <button type="button" class="cf-bajas mono' + (UI.verBajas ? ' on' : '') + '" id="cfBajas" ' +
          'title="Operadores sin actividad reciente (inactivos 2–4 sem · posible baja ≥5 sem)">' +
          (UI.verBajas ? noActivos.length + ' inactivos/bajas VISIBLES · ocultar'
                       : '+' + noActivos.length + ' bajas ocultas · ver') + '</button>' : '') +
      '</div>';
    h += '</div>';
    h += '<div class="cf-head-r">';
    // Criterio FIJO de jornada (≥3 h de conducción neta): un día por debajo del umbral
    // no cuenta como trabajado y reinicia la racha. Antes era un selector; el cliente
    // fijó el corte en 3 h, así que ahora es un indicador estático.
    h += '<div class="cf-crit" title="Un día con menos de 3 h de conducción neta no cuenta como jornada y reinicia la racha de días consecutivos">' +
      '<span class="cf-crit-l">Jornada</span><span class="cf-crit-v">≥ 3 h de conducción</span></div>';
    h += '</div>';
    h += '</header>';

    /* KPIs */
    h += '<div class="cf-kpis">';
    h += kpi('racha', 'Racha vigente máx.', (maxVigenteAgotada ? '≥' : '') + maxVigente + '<small>d</small>', 'al ' + fmtFechaCorta(hasta), semaforo(maxVigente).nivel === 'verde' ? 'ok' : (maxVigente >= 15 ? 'bad' : 'warn'));
    h += kpi('fatiga', 'En riesgo ≥10 días', fmtNum(pctRiesgo, 0) + '<small>%</small>',
      enRiesgo + ' de ' + total + ' · ' + cuenta.rojo + (cuenta.rojo === 1 ? ' crítico' : ' críticos'),
      enRiesgo ? (cuenta.rojo ? 'bad' : 'warn') : 'ok');
    h += kpi('horas', 'Horas por jornada', fmtNum(promGlobal, 2) + '<small>h</small>', 'sobre días trabajados', promGlobal >= 10 ? 'bad' : (promGlobal >= 8 ? 'warn' : ''));
    /* Conducción NETA y RALENTÍ: lo que el cliente pidió ver separado. Sin sidecar
       se rotula "sin medir" — un 0 se leería como "no hay ralentí", que es falso. */
    if (ral) {
      h += kpi('horas', 'Horas de conducción', fmtMiles(ral.netas) + '<small>h</small>',
        'netas · ' + fmtMiles(ral.horas + ral.netas) + ' h con motor encendido', '');
      h += kpi('combustible', 'Horas de ralentí', fmtMiles(ral.horas) + '<small>h</small>',
        fmtNum(ral.pct, 1) + '% del motor · ' + fmtMiles(ral.litros) + ' L ≈ $' + fmtMiles(ral.mxn) + ' MXN',
        ral.pct >= 25 ? 'bad' : (ral.pct >= 15 ? 'high' : (ral.pct >= 8 ? 'warn' : 'ok')));
    } else {
      h += kpi('combustible', 'Horas de ralentí', '—', 'sin medir · falta enriquecer estas semanas', '');
    }
    h += kpi('descanso', 'Descansando al cierre', String(descansando),
      fmtNum(total ? descansando / total * 100 : 0, 0) + '% de la plantilla' + (inactivos ? ' · +' + inactivos + ' inactivos ≥7d' : ''), 'ok');
    h += kpi('sinDatos', 'Días sin cobertura', String(nGaps), nGaps ? 'racha incierta en ' + opsIncierta + ' ops' : 'telemetría completa', nGaps ? 'warn' : 'ok');
    h += '</div>';

    /* leyenda */
    h += '<div class="cf-leyenda">';
    h += '<div class="cf-ley-grp"><span class="cf-ley-t">Racha vigente</span>' +
      '<span class="cf-ley sem-verde">≤6 OK</span><span class="cf-ley sem-amarillo">7–9 vigilar</span>' +
      '<span class="cf-ley sem-naranja">10–14 alto</span><span class="cf-ley sem-rojo">≥15 crítico</span></div>';
    h += '<div class="cf-ley-grp"><span class="cf-ley-t">Calendario · horas del día</span>' +
      '<span class="cf-ley-k"><i class="cf-cell est-trabajado hb-ok"></i><i class="cf-cell est-trabajado hb-warn"></i><i class="cf-cell est-trabajado hb-high"></i><i class="cf-cell est-trabajado hb-bad"></i> jornada 3·6·9·12+ h</span>' +
      '<span class="cf-ley-k"><i class="cf-cell est-minima"></i> &lt;3 h (no jornada)</span>' +
      '<span class="cf-ley-k"><i class="cf-cell est-descanso"></i> descanso</span>' +
      '<span class="cf-ley-k"><i class="cf-cell est-sin_datos"></i> sin datos</span></div>';
    h += '<div class="cf-ley-note">Jornada = ≥ 3 h de conducción neta; el color de cada día es el semáforo por horas ' +
      '(verde 3–6 · amarillo 6–9 · naranja 9–12 · rojo ≥12). Un día con menos de 3 h no cuenta como jornada y ' +
      'reinicia la racha. La racha vigente cuenta jornadas consecutivas hacia atrás desde el cierre del periodo, ' +
      'cruzando semanas sobre todo el histórico cargado, hasta el último día de inactividad (descanso o &lt;3 h), ' +
      'que la reinicia a 0. «≥N?» = la racha llega al inicio de los datos y podría ser mayor.</div>';
    h += '</div>';

    /* alertas */
    if (alertas.length) {
      h += '<div class="cf-alertas" role="alert"><div class="cf-alertas-t">' + ico('fatiga') +
        'Fatiga acumulada — programar descanso <span class="cf-count">' + alertas.length + '</span></div><div class="cf-alertas-list">';
      alertas.slice(0, 6).forEach(function (o) {
        h += '<button type="button" class="cf-alerta ' + o.sem.css + '" data-goto="' + esc(o.conductor) + '">' +
          '<span class="cf-alerta-racha">' + (o.rachaAgotada ? '≥' : '') + o.racha + '<small>d</small></span>' +
          '<span class="cf-alerta-txt"><b>' + esc(o.conductor) + '</b>' +
          '<i>' + esc(udnCorto(o.udn)) + ' · ' + fmtNum(o.promHdia, 1) + ' h/jornada · ' + fmtNum(o.km, 0) +
          ' km · sin descanso desde ' + esc(fmtFechaCorta(o.rachaInicio || o.ultimoDia)) + '</i></span></button>';
      });
      if (alertas.length > 6) h += '<div class="cf-alerta-mas">+' + (alertas.length - 6) + ' más en el calendario</div>';
      h += '</div></div>';
    } else {
      h += '<div class="cf-alertas ok"><div class="cf-alertas-t">' + ico('descanso') +
        'Sin rachas ≥10 días vigentes al ' + esc(fmtFechaCorta(hasta)) + '</div></div>';
    }

    /* fila de paneles analíticos */
    h += '<div class="cf-grid3">';
    h += '<div class="cf-panel" id="cf-g-semana" data-graf="Horas por día de la semana"><div class="cf-panel-t">' + ico('calendario') + 'Horas por día de la semana' +
      '<span class="cf-panel-leg"><i class="lg-bar"></i>h/jornada <i class="lg-ghost"></i>% actividad</span></div>' +
      '<div class="cf-lienzo" data-graf-lienzo>' + svgSemana(dist) + '</div></div>';
    h += '<div class="cf-panel" id="cf-g-tend" data-graf="Tendencia semanal de fatiga"><div class="cf-panel-t">' + ico('semana') + 'Tendencia semanal' +
      '<span class="cf-panel-leg"><i class="lg-bar"></i>% ≥10d <i class="lg-line"></i>h/jornada</span></div>' +
      '<div class="cf-lienzo" data-graf-lienzo>' + svgTendencia(tend) + '</div></div>';
    h += '<div class="cf-panel" id="cf-g-hist" data-graf="Distribución de rachas vigentes"><div class="cf-panel-t">' + ico('operadores') + 'Distribución de rachas vigentes</div>' +
      svgHistograma(ops) +
      '<div class="cf-hist-foot">' + cuenta.verde + ' OK · ' + cuenta.amarillo + ' vigilar · ' + cuenta.naranja + ' alto · ' + cuenta.rojo + ' crítico</div></div>';
    h += '</div>';

    /* calendario */
    h += '<div class="cf-panel cf-panel-cal" id="cf-g-cal" data-graf="Calendario de actividad y rachas">';
    h += '<div class="cf-panel-t">' + ico('racha') + 'Calendario de actividad y rachas' +
      '<div class="cf-tools">' +
      '<input type="search" class="cf-buscar" id="cfBuscar" placeholder="Buscar operador…" value="' + esc(UI.busca) + '" aria-label="Buscar operador">' +
      '<label class="cf-check"><input type="checkbox" id="cfSoloRiesgo"' + (UI.soloRiesgo ? ' checked' : '') + '> solo en riesgo</label>' +
      '<button type="button" class="cf-det-toggle" id="cfCalToggle" aria-expanded="false">' +
      '<span class="cf-det-toggle-ic">' + ico('desplegar') + '</span><span class="cf-det-toggle-t">Expandir todo</span></button>' +
      '</div></div>';
    if (nGaps) {
      h += '<div class="cf-gapnote">' + ico('sinDatos') + '<span>' + nGaps + ' día' + (nGaps === 1 ? '' : 's') +
        ' sin cobertura de telemetría en el periodo (' +
        esc(Object.keys(sinDatos).sort().map(fmtFechaCorta).join(', ')) +
        '). Se tratan como descanso pero se marcan aparte: la racha de esos operadores queda como <b>incierta (?)</b>.</span></div>';
    }
    h += '<div class="cf-cal" id="cfCal"></div>';
    h += '</div>';

    /* tabla detalle — agrupada por UDN en acordeones colapsables (queja 2026-07-23:
       «lista sin fin» de 1500+ filas → «colápsalo por UDN») */
    h += '<div class="cf-panel cf-panel-det">';
    h += '<div class="cf-panel-t">' + ico('operadores') + 'Detalle por operador <span class="cf-count" id="cfCount">' + total + '</span>' +
      '<button type="button" class="cf-det-toggle" id="cfDetToggle" aria-expanded="false">' +
      '<span class="cf-det-toggle-ic">' + ico('desplegar') + '</span><span class="cf-det-toggle-t">Expandir todo</span></button></div>';
    h += '<div class="cf-tabla-wrap"><div class="cf-det" id="cfDet"></div></div>';
    h += '</div>';

    h += '</section>';
    container.innerHTML = h;

    /* ---------------------- interacción ---------------------- */
    var elCal = container.querySelector('#cfCal');
    var elDet = container.querySelector('#cfDet');
    var elDetToggle = container.querySelector('#cfDetToggle');
    var elCalToggle = container.querySelector('#cfCalToggle');
    var elCount = container.querySelector('#cfCount');

    /* ---- utilidades del acordeón, compartidas por calendario y detalle ----
       animación por grid-template-rows (definida en CSS), memoria de expansión en
       `memoria`, y sincronización del botón "Expandir/Colapsar todo". */
    function sincronizarToggleGen(rootEl, toggleEl) {
      if (!toggleEl) return;
      var accs = rootEl.querySelectorAll('.cf-acc');
      var hayCerrado = Array.prototype.some.call(accs, function (a) { return !a.classList.contains('is-open'); });
      var t = toggleEl.querySelector('.cf-det-toggle-t');
      var ic = toggleEl.querySelector('.cf-det-toggle-ic');
      toggleEl.setAttribute('aria-expanded', hayCerrado ? 'false' : 'true');
      toggleEl.style.display = accs.length ? '' : 'none';
      if (t) t.textContent = hayCerrado ? 'Expandir todo' : 'Colapsar todo';
      if (ic) ic.innerHTML = ico(hayCerrado ? 'desplegar' : 'plegar');
    }
    function conectarAcordeones(rootEl, memoria, syncFn) {
      rootEl.querySelectorAll('.cf-acc-head').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var acc = btn.parentNode;
          var udn = acc.getAttribute('data-udn');
          var abre = !acc.classList.contains('is-open');
          acc.classList.toggle('is-open', abre);
          btn.setAttribute('aria-expanded', abre ? 'true' : 'false');
          memoria[udn] = abre;
          syncFn();
        });
      });
    }
    function conectarToggleTodo(rootEl, toggleEl, memoria, syncFn) {
      if (!toggleEl) return;
      toggleEl.addEventListener('click', function () {
        var accs = rootEl.querySelectorAll('.cf-acc');
        var abrir = Array.prototype.some.call(accs, function (a) { return !a.classList.contains('is-open'); });
        Array.prototype.forEach.call(accs, function (a) {
          var udn = a.getAttribute('data-udn');
          a.classList.toggle('is-open', abrir);
          var b = a.querySelector('.cf-acc-head'); if (b) b.setAttribute('aria-expanded', abrir ? 'true' : 'false');
          if (udn) memoria[udn] = abrir;
        });
        syncFn();
      });
    }
    function syncCalToggle() { sincronizarToggleGen(elCal, elCalToggle); }
    function syncDetToggle() { sincronizarToggleGen(elDet, elDetToggle); }

    function visibles() {
      var q = UI.busca.trim().toLowerCase();
      return ops.filter(function (o) {
        if (UI.soloRiesgo && o.racha < 10) return false;
        if (q && o.conductor.toLowerCase().indexOf(q) < 0 && (o.udn || '').toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }

    /* ---- CALENDARIO agrupado en acordeones por UDN (queja 2026-07-23: la de
       calendario seguía siendo «lista sin fin» paginada). Mismo patrón, clases y
       comportamiento que el detalle: grupos colapsados al inicio, orden del más
       crítico primero; dentro de cada grupo, operadores por racha vigente ↓. El
       heatmap/cinta de cada operador se conserva intacto en su fila (calRow). */
    function pintarCal() {
      var q = UI.busca.trim();
      var v = visibles();
      var grupos = gruposUDN(v);
      grupos.forEach(function (gr) {
        gr.ops = gr.ops.slice().sort(function (a, b) {
          return b.racha - a.racha || b.rachaMax - a.rachaMax || b.promHdia - a.promHdia || a.conductor.localeCompare(b.conductor, 'es');
        });
      });

      var out = calHeader(d0, d1, sinDatos);
      if (!grupos.length) {
        out += '<div class="cf-empty">Ningún operador coincide con la búsqueda</div>';
        elCal.innerHTML = out;
        if (elCount) elCount.textContent = v.length;
        syncCalToggle();
        return;
      }
      grupos.forEach(function (gr) {
        // buscando → grupos con coincidencias arrancan expandidos; si no, estado recordado.
        var abierto = q ? true : !!UI.gruposCal[gr.udn];
        var bid = 'cfcal-' + udnSlug(gr.udn);
        out += '<div class="cf-acc' + (abierto ? ' is-open' : '') + '" data-udn="' + esc(gr.udn) + '">' +
          accHeadHTML(gr, abierto, bid) +
          '<div class="cf-acc-body" id="' + bid + '" role="region"><div class="cf-acc-inner">' +
            '<div class="cf-cal-body">' +
              gr.ops.map(function (o) { return calRow(o, d0, d1); }).join('') +
            '</div>' +
          '</div></div>' +
        '</div>';
      });
      elCal.innerHTML = out;
      if (elCount) elCount.textContent = v.length;
      conectarAcordeones(elCal, UI.gruposCal, syncCalToggle);
      syncCalToggle();
    }

    /* ---- DETALLE POR OPERADOR agrupado en acordeones por UDN ----
       Cada UDN es un grupo colapsable. Grupos ordenados del más crítico (más
       operadores en riesgo ≥10d) al mejor; dentro de cada grupo, la orden activa
       de columnas (por defecto racha vigente ↓). Estado de expansión recordado en
       UI.grupos entre re-renders. El buscador expande los grupos con coincidencias. */
    function cmpDet(a, b) {
      var va = a[UI.orden.col], vb = b[UI.orden.col];
      if (typeof va === 'string' || typeof vb === 'string')
        return UI.orden.dir * String(va || '').localeCompare(String(vb || ''), 'es');
      return UI.orden.dir * ((va || 0) - (vb || 0)) || a.conductor.localeCompare(b.conductor, 'es');
    }

    function colgroupDet() {
      return '<colgroup>' + COLS_DET.map(function (c) { return '<col style="width:' + c.w + '">'; }).join('') + '</colgroup>';
    }
    function theadDet() {
      return '<thead><tr>' + COLS_DET.map(function (c) {
        var sorted = UI.orden.col === c.k;
        return '<th data-col="' + c.k + '" class="' + (c.cls === 'num' ? 'num' : '') + (sorted ? ' sorted' : '') + '">' +
          esc(c.lbl) + (sorted ? (UI.orden.dir === -1 ? ' ▾' : ' ▴') : '') + '</th>';
      }).join('') + '</tr></thead>';
    }
    function filaDet(o) {
      var multi = String(o.udn || '').split(' · ').filter(Boolean).length > 1;
      return '<tr>' +
        '<td class="nom" title="' + esc(o.conductor + ' — ' + (o.udn || '')) + '">' + esc(o.conductor) + badgeEstado(o.conductor) +
          (multi ? '<span class="cf-nom-multi" title="' + esc('Opera también en: ' + o.udn) + '">+' + (String(o.udn).split(' · ').filter(Boolean).length - 1) + '</span>' : '') + '</td>' +
        '<td class="num"><span class="cf-badge ' + o.sem.css + (o.rachaIncierta ? ' dudosa' : '') + '" title="' + esc(tipRacha(o)) + '">' + badgeRacha(o) + '</span></td>' +
        '<td class="num"><span class="cf-badge ghost ' + o.semMax.css + '">' + o.rachaMax + '</span></td>' +
        '<td class="num">' + o.diasTrabajados + '</td>' +
        '<td class="num muted">' + o.diasDescanso + '</td>' +
        '<td class="num muted">' + o.diasMinima + '</td>' +
        '<td class="num' + (o.diasSinDatos ? ' gap' : ' muted') + '">' + o.diasSinDatos + '</td>' +
        '<td class="num' + (o.promHdia >= 10 ? ' hot' : '') + '">' + fmtNum(o.promHdia, 2) + '</td>' +
        '<td class="num">' + fmtH(o.horas) + '</td>' +
        '<td class="num">' + fmtNum(o.km, 0) + '</td>' +
        '<td class="fecha">' + esc(fmtFechaCorta(o.ultimoDia)) +
        (o.diasDesdeUltimo > 0 ? '<i> · hace ' + o.diasDesdeUltimo + 'd</i>' : (o.ultimoDia ? '<i> · al cierre</i>' : '')) + '</td>' +
        '</tr>';
    }

    function pintarDetalle() {
      var q = UI.busca.trim();
      var grupos = gruposUDN(visibles());
      grupos.forEach(function (gr) { gr.ops = gr.ops.slice().sort(cmpDet); });

      if (!grupos.length) { elDet.innerHTML = '<div class="cf-empty">Ningún operador coincide con la búsqueda</div>'; syncDetToggle(); return; }

      var head = '<table class="cf-tabla cf-tabla-head">' + colgroupDet() + theadDet() + '</table>';
      var cuerpo = '';
      grupos.forEach(function (gr) {
        // buscando → los grupos con coincidencias arrancan expandidos; si no, el estado recordado.
        var abierto = q ? true : !!UI.grupos[gr.udn];
        var bid = udnSlug(gr.udn);
        cuerpo += '<div class="cf-acc' + (abierto ? ' is-open' : '') + '" data-udn="' + esc(gr.udn) + '">' +
          accHeadHTML(gr, abierto, bid) +
          '<div class="cf-acc-body" id="' + bid + '" role="region"><div class="cf-acc-inner">' +
            '<table class="cf-tabla">' + colgroupDet() + '<tbody>' +
              gr.ops.map(filaDet).join('') +
            '</tbody></table>' +
          '</div></div>' +
        '</div>';
      });
      elDet.innerHTML = head + cuerpo;

      // toggle por grupo (anima vía grid-template-rows; recuerda el estado)
      conectarAcordeones(elDet, UI.grupos, syncDetToggle);
      // click en cabecera de columna → reordena dentro de todos los grupos
      elDet.querySelectorAll('.cf-tabla-head th[data-col]').forEach(function (th) {
        th.addEventListener('click', function () {
          var col = th.getAttribute('data-col');
          var def = COLS_DET.filter(function (c) { return c.k === col; })[0];
          if (UI.orden.col === col) UI.orden.dir = -UI.orden.dir;
          else { UI.orden.col = col; UI.orden.dir = def ? def.dir : -1; }
          pintarDetalle();
        });
      });
      syncDetToggle();
    }

    function repintar() { pintarCal(); pintarDetalle(); }
    repintar();

    conectarToggleTodo(elCal, elCalToggle, UI.gruposCal, syncCalToggle);
    conectarToggleTodo(elDet, elDetToggle, UI.grupos, syncDetToggle);

    var elBuscar = container.querySelector('#cfBuscar');
    if (elBuscar) elBuscar.addEventListener('input', function () { UI.busca = elBuscar.value; repintar(); });
    var elRiesgo = container.querySelector('#cfSoloRiesgo');
    if (elRiesgo) elRiesgo.addEventListener('change', function () { UI.soloRiesgo = elRiesgo.checked; repintar(); });
    /* chip de bajas: cambia el universo de `ops`, así que re-render completo */
    var elBajas = container.querySelector('#cfBajas');
    if (elBajas) elBajas.addEventListener('click', function () { UI.verBajas = !UI.verBajas; render(container, state); });
    container.querySelectorAll('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () {
        UI.busca = b.getAttribute('data-goto');
        if (elBuscar) elBuscar.value = UI.busca;
        repintar();
        var row = container.querySelector('.cf-cal-row');
        if (row && row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    /* (el ordenamiento por columna se conecta dentro de pintarDetalle, ya que la
       cabecera se regenera con cada repintado del acordeón) */

    /* ---------- gráficas expandibles a primer plano (UIX) ---------- */
    if (window.UIX) {
      var gS = container.querySelector('#cf-g-semana');
      if (gS) window.UIX.registrarGrafica(gS, function (w, hh, exp) {
        gS.querySelector('[data-graf-lienzo]').innerHTML = svgSemana(dist, w, hh, exp);
      });
      var gT = container.querySelector('#cf-g-tend');
      if (gT) window.UIX.registrarGrafica(gT, function (w, hh, exp) {
        gT.querySelector('[data-graf-lienzo]').innerHTML = svgTendencia(tend, w, hh, exp);
      });
      /* histograma y calendario son rejillas CSS: reflowean solas al expandir */
      ['#cf-g-hist', '#cf-g-cal'].forEach(function (sel) {
        var el = container.querySelector(sel);
        if (el) window.UIX.registrarGrafica(el, null);
      });
    }

    function kpi(icon, label, val, sub, tone) {
      return '<div class="cf-kpi' + (tone ? ' ' + tone : '') + '">' +
        '<div class="cf-kpi-top">' + ico(icon) + '<span class="l">' + label + '</span></div>' +
        '<div class="v">' + val + '</div>' +
        (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
    }
  }

  /* ============================== EXPORT ================================= */
  window.MODULOS = window.MODULOS || {};
  window.MODULOS[ID] = {
    id: ID,
    titulo: 'Cargas de trabajo / Fatiga',
    render: render,
    /* lógica pura — usada por connector/test_cargas.mjs (misma fuente de verdad) */
    core: {
      PERFILES: PERFILES, PERFIL_DEFAULT: PERFIL_DEFAULT, COBERTURA_MIN: COBERTURA_MIN,
      dayNum: dayNum, fechaDe: fechaDe, dowDe: dowDe, isoWeek: isoWeek, semanaRango: semanaRango,
      semaforo: semaforo, filtrarRegistros: filtrarRegistros,
      coberturaGlobal: coberturaGlobal, agruparOperadores: agruparOperadores,
      serieOperador: serieOperador, rachasDe: rachasDe, metricasOperador: metricasOperador,
      calcularCargas: calcularCargas, distribucionSemanal: distribucionSemanal,
      tendenciaSemanal: tendenciaSemanal
    }
  };
})();
