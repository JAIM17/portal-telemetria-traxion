/* ============================================================================
 * MÓDULO — COMBUSTIBLE · detección de caídas de nivel (sospecha de robo)
 * ----------------------------------------------------------------------------
 * QUÉ DA Y QUÉ NO DA LA API (medido contra producción el 2026-07-24)
 *
 *   · `fuel_used`, `km_per_1_Liter`, `liter_Per_100_km` de get_vehicle_trips_extended
 *     vuelven VACÍOS o en 0.00 → faltan permisos de Traffilog (ver docs/SOLICITUD-TRAFFILOG.md).
 *   · `api_get_vehicle_parameter_values` (la serie del tanque) devuelve 0 lecturas
 *     para CUALQUIER parámetro, incluido un control → no está habilitado.
 *   · El nivel de tanque por get_parameters sólo expone el ÚLTIMO valor, y en la
 *     mitad de la flota lleva meses congelado (sensor muerto).
 *
 * LO QUE SÍ HAY, Y ES LO QUE IMPORTA: Traffilog **ya detecta la caída** y emite el
 * evento "New Version fuel Drop" con FECHA, HORA, UNIDAD y GPS. El % caído no
 * viaja en el evento, pero desde 2026-07-27 se ENRIQUECE aparte: el refresco
 * diario corre connector/enriquecer_combustible.mjs, que pide la serie del
 * tanque (api_get_vehicle_parameter_values, param 28929/28932) alrededor de
 * cada caída y guarda `delta_pct` en el propio evento.
 *
 * UMBRALES (recalibrados 2026-08-12 contra los 340 eventos ya medidos)
 * -------------------------------------------------------------------
 *   Δ ≥ 20% = sospecha fuerte   ·   Δ ≥ 40% = media carga o más
 * El umbral era 10%, pero la MEDIANA real de caída es 25%: a 10% entraban 70
 * eventos de consumo y ruido. Se descuentan tres artefactos del sensor:
 *   · carga en la hora SIGUIENTE  → recalibración
 *   · carga en la hora ANTERIOR   → lectura saturada al tope que baja al nivel
 *                                   real al estabilizarse (25 falsos positivos)
 *   · `nivel_lejana`              → la bajada de la serie no casa con el evento
 *
 * LÍMITE QUE NO HAY QUE OLVIDAR: los eventos NO son un censo de cambios de nivel.
 * La unidad 16004 el 15/07/2026 muestra en la gráfica de Traffilog una carga y
 * una bajada y no emitió NINGÚN evento. Lo que cuenta este módulo es un piso.
 *
 * ATRIBUCIÓN DEL RESPONSABLE
 * --------------------------
 * 31 de 32 caídas llegan SIN operador logueado — normal: el robo pasa con la unidad
 * detenida y nadie identificado. Así que el responsable no se lee del evento: se
 * DEDUCE de quién traía esa unidad ese día, según los registros de telemetría.
 * Se marca siempre el grado de certeza; esto señala a una persona y no puede
 * presentarse como un hecho cuando es una inferencia.
 *
 * Fuente: datos/historico/combustible.json (connector/extraer_combustible.mjs)
 * ========================================================================== */
(function () {
  'use strict';
  window.MODULOS = window.MODULOS || {};

  var ID = 'combustible';
  var CSS_HREF = 'aplicacion/modulos/combustible.css?v=16';
  /* Δ% desde el cual la caída es sospecha fuerte. Estaba en 10, medido contra los
     340 eventos ya enriquecidos (2026-08-12): la MEDIANA de caída es 25%, así que
     el 10% marcaba como "sospecha fuerte" 70 eventos que son consumo y ruido del
     sensor. A 20% quedan los 215 que de verdad tienen magnitud de sustracción. */
  var UMBRAL_FUERTE = 20;
  var UMBRAL_GRAVE = 40;      // Δ% desde el cual la caída es media carga o más
  var VENTANA_RECAL = 3600e3; // caída + carga en <1 h DESPUÉS = probable recalibración
  /* Carga en <1 h ANTES de la caída = artefacto del sensor, no robo: tras llenar,
     la lectura se satura al tope y luego "cae" de golpe al nivel real cuando se
     estabiliza. Es el patrón de la unidad 16004 el 15/07/2026 (que ni evento
     generó). Sin esta regla, 25 de los eventos enriquecidos son falsos positivos. */
  var VENTANA_CLIPEO = 3600e3;
  /* Nivel desde el que ya NO se puede afirmar que la bajada sea sustracción: el
     sensor se satura al tope tras una carga y se queda clavado en 99–100% HORAS
     antes de caer de golpe al nivel real. Eso NO es la baja negativa del evento,
     es la carga asentándose. Medido 2026-08-12 en los 215 eventos fuertes: hay
     una pila anómala de 19 eventos arrancando en 99–100% y 13 en 97–98%, contra
     4–7 por valor en el rango 88–96%. La pila contra el techo es el artefacto.
     Ninguno de esos 32 tenía evento de carga <1 h antes (la carga suele NO emitir
     evento), así que la regla de VENTANA_CLIPEO no los alcanza. */
  var UMBRAL_TOPE = 97;
  var FUENTE = 'datos/historico/combustible.json';

  var DATOS = null, CARGANDO = false, ERROR = null;
  var CONT = null, DATA = null, FILTROS = null, RECARGAR = null, PIDIENDO = false;
  var VENTANA_ATRIB = 2;     // días a cada lado para atribuir responsable
  var SEL = null;
  var FILTRO_RESP = null;    // clic en una card de responsable → la tabla y el mapa se acotan a él
  var MAPA_CB = null;        // instancia Leaflet

  /* ------------------------------------------------------------------ utils */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n, d) {
    return (n == null || !isFinite(n)) ? '—'
      : n.toLocaleString('es-MX', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function ico(n) {
    return (window.ICONOS && typeof ICONOS.svg === 'function')
      ? '<span class="cb2-ic">' + ICONOS.svg(n) + '</span>' : '';
  }
  /* ZONA HORARIA — Traffilog emite `time` en UTC SIN sufijo (verificado 2026-07-27:
     el enriquecido casa las caídas al minuto con offset 0). Antes el módulo cortaba
     la cadena y pintaba la hora UTC como si fuera local: una caída a las 02:42 UTC
     se mostraba de madrugada cuando en realidad fue a las 20:42 del día anterior.
     Eso invertía la firma "nocturna", que es justo el eje de este módulo. Todo lo
     que se MUESTRA o se clasifica por hora pasa por aquí. Ojo: `ev.fecha` sigue
     siendo la fecha UTC porque la atribución del responsable indexa por ella
     (su ventana de ±2 días absorbe el desfase). */
  var TZ_OFF_H = -6;   // CDMX = UTC−6
  function tMs(t) {
    var s = String(t || '');
    return Date.parse(/[Zz+]/.test(s.slice(10)) ? s : s + 'Z');
  }
  function local(t) {
    var ms = tMs(t);
    return isFinite(ms) ? new Date(ms + TZ_OFF_H * 3600e3) : null;
  }
  var dos = function (n) { return (n < 10 ? '0' : '') + n; };
  function hora(t) {
    var d = local(t);
    return d ? dos(d.getUTCHours()) + ':' + dos(d.getUTCMinutes()) : '';
  }
  /* Fecha en hora local — la que hay que usar para agrupar por día y para mostrar. */
  function fechaLocal(t, fallback) {
    var d = local(t);
    return d ? d.toISOString().slice(0, 10) : (fallback || '');
  }
  function fechaCorta(f) { var p = String(f || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] : f; }
  function diaSem(f) {
    var d = new Date(f + 'T12:00:00');
    return isNaN(d) ? '' : ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][d.getDay()];
  }
  function shiftYmd(f, n) {
    var d = new Date(f + 'T12:00:00'); d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function franja(t) {
    var d = local(t);
    if (!d) return 'mañana';
    var h = d.getUTCHours();   // getUTC* sobre la fecha ya corrida = hora LOCAL
    return h < 6 ? 'madrugada' : h < 12 ? 'mañana' : h < 18 ? 'tarde' : 'noche';
  }

  /* ------------------------------------------------------ carga del archivo */
  function cargar() {
    if (DATOS || CARGANDO) return;
    CARGANDO = true;
    fetch(FUENTE, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { DATOS = j; CARGANDO = false; pintar(); })
      .catch(function (e) { ERROR = e.message; CARGANDO = false; pintar(); });
  }

  /* ------------------------------------------------------------- atribución */
  /* Quién traía la unidad cuando cayó el nivel. Se busca primero el MISMO día;
     si nadie manejó esa unidad ese día, se abre la ventana. Devuelve también el
     grado de certeza para que la UI no presente una inferencia como un hecho. */
  function atribuir(ev, porUnidadFecha, cobertura) {
    var vid = ev.vehicle_id;
    /* Distinguir "nadie manejó esa unidad" de "esa fecha no está cargada" es
       obligatorio: lo segundo NO es un dato sobre la unidad ni sobre nadie, y
       presentarlo como "sin atribuir" haría parecer vacía una casilla que en
       realidad no se ha podido consultar. */
    if (cobertura && (ev.fecha < cobertura.desde || ev.fecha > cobertura.hasta)) {
      return { fueraDeRango: true };
    }
    for (var d = 0; d <= VENTANA_ATRIB; d++) {
      var fechas = d === 0 ? [ev.fecha] : [shiftYmd(ev.fecha, -d), shiftYmd(ev.fecha, d)];
      var cand = {};
      fechas.forEach(function (f) {
        var lista = porUnidadFecha[vid + '|' + f];
        if (!lista) return;
        lista.forEach(function (r) {
          if (!r.conductor || r.sinIdentificar) return;
          cand[r.conductor] = (cand[r.conductor] || 0) + (r.horas || 0);
        });
      });
      var orden = Object.keys(cand).sort(function (a, b) { return cand[b] - cand[a]; });
      if (orden.length) {
        return {
          conductor: orden[0], horas: cand[orden[0]],
          certeza: d === 0 ? (orden.length === 1 ? 'alta' : 'media') : 'baja',
          dias: d, otros: orden.length - 1,
        };
      }
    }
    return null;
  }

  /* --------------------------------------------------------------- análisis */
  function analizar() {
    var evs = (DATOS && DATOS.eventos) || [];
    var regs = (DATA && DATA.registros) || [];
    var f = FILTROS || {};

    /* índice unidad|fecha → registros, para atribuir sin recorrer todo cada vez */
    var idx = {};
    var udnDe = {}, placaDe = {};
    regs.forEach(function (r) {
      var k = r.vehicle_id + '|' + r.fecha;
      (idx[k] = idx[k] || []).push(r);
      if (r.vehicle_id) { udnDe[r.vehicle_id] = r.udn || ''; placaDe[r.vehicle_id] = r.placa || ''; }
    });

    /* Rango de fechas realmente presente en el snapshot cargado. */
    var fs = regs.map(function (r) { return r.fecha; }).filter(Boolean).sort();
    var cobertura = fs.length ? { desde: fs[0], hasta: fs[fs.length - 1] } : null;

    /* Cargas por unidad SIN filtrar: la recalibración se detecta contra la carga
       que sigue a la caída aunque el filtro de fechas la deje justo fuera. */
    var cargasPorUnidad = {};
    evs.forEach(function (e) {
      if (e.tipo === 'fuel_carga' && e.vehicle_id && e.time) {
        (cargasPorUnidad[e.vehicle_id] = cargasPorUnidad[e.vehicle_id] || []).push(tMs(e.time));
      }
    });
    function esRecalibracion(e) {
      var ts = cargasPorUnidad[e.vehicle_id];
      if (!ts) return false;
      var t = tMs(e.time);
      for (var i = 0; i < ts.length; i++) {
        var d = ts[i] - t;
        if (d >= 0 && d <= VENTANA_RECAL) return true;
      }
      return false;
    }
    /* Carga en la hora ANTERIOR: la lectura venía saturada al tope y la "caída"
       es el sensor asentándose al nivel real. No es sustracción. */
    function esClipeo(e) {
      var ts = cargasPorUnidad[e.vehicle_id];
      if (!ts) return false;
      var t = tMs(e.time);
      for (var i = 0; i < ts.length; i++) {
        var d = t - ts[i];
        if (d > 0 && d <= VENTANA_CLIPEO) return true;
      }
      return false;
    }

    var caidas = [], cargas = [];
    evs.forEach(function (e) {
      if (f.desde && e.fecha < f.desde) return;
      if (f.hasta && e.fecha > f.hasta) return;
      var udn = udnDe[e.vehicle_id] || '';
      if (f.udn && udn !== f.udn) return;
      if (f.vehiculo && e.vehicle_id !== f.vehiculo && e.placa !== f.vehiculo) return;
      var o = {
        ev: e, udn: udn,
        placa: e.placa || placaDe[e.vehicle_id] || e.vehicle_id,
        franja: franja(e.time),
        fechaL: fechaLocal(e.time, e.fecha),
      };
      if (e.tipo === 'fuel_caida') {
        o.resp = e.conductor ? { conductor: e.conductor, certeza: 'confirmada', horas: null, dias: 0, otros: 0 }
          : atribuir(e, idx, cobertura);
        o.recal = esRecalibracion(e);
        o.clip = !o.recal && esClipeo(e);
        /* Arranca con el tanque en el techo del sensor: la bajada mide la carga
           asentándose, no una sustracción. Es el patrón de la 16004 el 15/07. */
        o.tope = !o.recal && !o.clip && e.nivel_antes != null && e.nivel_antes >= UMBRAL_TOPE;
        o.lejana = !!e.nivel_lejana;   // el detector no pudo casar la caída con el evento
        /* Sospecha fuerte = magnitud real y ningún artefacto que la explique. */
        o.fuerte = e.delta_pct != null && e.delta_pct >= UMBRAL_FUERTE &&
          !o.recal && !o.clip && !o.tope && !o.lejana;
        o.grave = o.fuerte && e.delta_pct >= UMBRAL_GRAVE;
        caidas.push(o);
      } else if (e.tipo === 'fuel_carga') cargas.push(o);
    });
    caidas.sort(function (a, b) { return a.ev.time < b.ev.time ? 1 : -1; });
    return { caidas: caidas, cargas: cargas, cobertura: cobertura };
  }

  /* ----------------------------------------------------------- gráficas SVG */
  /* Sin dependencias: el portal ya carga ECharts, pero para 2 series pequeñas
     un SVG inline es más liviano y no pelea con el re-render del módulo. */
  /* v3: mezclar caídas y cargas en un eje con DOS escalas no llevaba a ninguna
     conclusión (crítica textual del cliente). Las cargas salen de la gráfica —
     son ~100/día constantes, puro ruido. Lo que sí concluye: cuántas caídas
     hubo cada día y CUÁNTAS fueron nocturnas (18–06 h), que es la firma del
     robo. Barra apilada: rojo sólido = nocturna, naranja = diurna. */
  function serieDiaria(caidas) {
    var dias = {};
    caidas.forEach(function (o) {
      var k = o.fechaL || o.ev.fecha;   // día LOCAL: agrupar por fecha UTC partía las noches
      var d = dias[k] || (dias[k] = { fecha: k, noct: 0, diur: 0 });
      if (o.franja === 'madrugada' || o.franja === 'noche') d.noct++; else d.diur++;
    });
    return Object.keys(dias).sort().map(function (k) { return dias[k]; });
  }

  function graficaDias(serie) {
    if (!serie.length) return '<div class="cb2-vacio-mini">Sin caídas en el rango.</div>';
    var max = serie.reduce(function (m, d) { return Math.max(m, d.noct + d.diur); }, 1);
    var W = 100 / serie.length;
    var h = '<div class="cb2-graf" data-graf><div class="cb2-graf-y"><span>' + max + '</span><span>0</span></div>';
    h += '<div class="cb2-barras">';
    serie.forEach(function (d) {
      var tot = d.noct + d.diur;
      h += '<div class="cb2-col" style="width:' + W + '%" title="' + esc(d.fecha) + ' · ' +
        tot + ' caída(s): ' + d.noct + ' nocturna(s), ' + d.diur + ' diurna(s)">' +
        '<span class="cb2-apilada" style="height:' + (tot / max * 100) + '%">' +
          '<u>' + tot + '</u>' +
          (d.diur ? '<i class="cb2-s-diur" style="flex-grow:' + d.diur + '"></i>' : '') +
          (d.noct ? '<i class="cb2-s-noct" style="flex-grow:' + d.noct + '"></i>' : '') +
        '</span>' +
        '<em>' + fechaCorta(d.fecha) + '</em></div>';
    });
    h += '</div></div>';
    h += '<div class="cb2-leyenda"><span class="cb2-k"><i class="k-noct"></i> nocturna (18–06 h) — la firma del robo</span>' +
      '<span class="cb2-k"><i class="k-diur"></i> diurna</span>' +
      '<span class="cb2-k-n">Un día alto y rojo = revisar esa noche en la tabla de abajo</span></div>';
    return h;
  }

  /* Mapa REAL (Leaflet + OSM vendoreado). Cada caída es un marcador con su
     fecha, hora, unidad y responsable; clic en una fila de la tabla vuela a él. */
  function montarMapaCb(cont, caidas) {
    var div = cont.querySelector('#cb2Leaflet');
    if (!div) return;
    if (!window.L) { div.outerHTML = '<div class="cb2-vacio-mini">No cargó la librería de mapas (vendor/leaflet).</div>'; return; }
    if (MAPA_CB) { try { MAPA_CB.remove(); } catch (e) {} MAPA_CB = null; }
    var pts = caidas.filter(function (o) { return o.ev.lat != null && o.ev.lng != null; });
    MAPA_CB = L.map(div, { scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(MAPA_CB);
    if (!pts.length) { MAPA_CB.setView([20.6, -103.3], 9); return; }
    var bounds = [];
    pts.forEach(function (o) {
      var e = o.ev;
      var m = L.circleMarker([e.lat, e.lng], {
        radius: 8, color: '#C42B23', weight: 2.4, fillColor: '#D93F37', fillOpacity: .55,
      }).addTo(MAPA_CB);
      var resp = o.resp && !o.resp.fueraDeRango && o.resp.conductor
        ? esc(o.resp.conductor) + ' <em>(' + (o.resp.certeza === 'confirmada' ? 'confirmado' : 'atribuido') + ')</em>'
        : '<em>sin responsable todavía</em>';
      m.bindPopup('<div class="mp-pop">' +
        '<b>Caída de nivel · unidad ' + esc(o.placa) + '</b>' +
        '<span>' + diaSem(e.fecha) + ' ' + fechaCorta(e.fecha) + ' · ' + hora(e.time) + ' h · ' + esc(o.franja) + '</span>' +
        (e.delta_pct != null
          ? '<span>Δ ' + num(e.delta_pct, 1) + '% del tanque' + (o.fuerte ? ' · <b>sospecha fuerte</b>' : '') +
            (o.recal ? ' · probable recalibración' : '') + '</span>'
          : '') +
        '<span>' + resp + '</span>' +
        '<span>' + esc(o.udn || '—') + '</span>' +
        '<a href="https://www.google.com/maps?q=' + e.lat + ',' + e.lng + '" target="_blank" rel="noopener noreferrer">Abrir en Google Maps →</a>' +
        '</div>', { maxWidth: 270 });
      o._marker = m;
      bounds.push([e.lat, e.lng]);
    });
    MAPA_CB.fitBounds(bounds, { padding: [26, 26], maxZoom: 13 });
  }

  /* ------------------------------------------------------------------ tabla */
  function filaResp(o) {
    if (!o.resp) return '<span class="cb2-sin">nadie manejó la unidad esos días</span>';
    var r = o.resp;
    if (r.fueraDeRango) return '<span class="cb2-fuera" title="El evento es anterior a las semanas cargadas en el portal: no hay telemetría para cruzar">telemetría no cargada</span>';
    var et = r.certeza === 'confirmada' ? 'Confirmado'
      : r.certeza === 'alta' ? 'Probable' : r.certeza === 'media' ? 'Probable' : 'Posible';
    var tip = r.certeza === 'confirmada' ? 'El operador estaba logueado en el evento'
      : r.certeza === 'alta' ? 'Único operador de la unidad ese día'
      : r.certeza === 'media' ? 'Operador con más horas en la unidad ese día (había ' + r.otros + ' más)'
      : 'Nadie manejó la unidad ese día; operador más cercano a ±' + r.dias + ' día(s)';
    return '<span class="cb2-resp"><b>' + esc(r.conductor) + '</b>' +
      '<i class="cb2-cert c-' + r.certeza + '" title="' + esc(tip) + '">' + et + '</i></span>';
  }

  /* Magnitud de la caída. Tres estados: con Δ% (chip, rojo si ≥umbral), sin
     lecturas (la API no dio serie para esa unidad/hora), o pendiente (el
     enriquecido diario aún no llega a ese evento — va de reciente a antiguo). */
  function celdaDelta(o) {
    var e = o.ev;
    var marca = o.recal
      ? ' <i class="cb2-recal" title="Carga de combustible en la hora siguiente: probable recalibración del sensor, no robo">recal.</i>'
      : o.clip
        ? ' <i class="cb2-recal" title="Carga en la hora ANTERIOR: la lectura venía saturada al tope y bajó al nivel real al estabilizarse. Artefacto del sensor, no sustracción.">post-carga</i>'
        : o.tope
          ? ' <i class="cb2-recal" title="La bajada arranca con el tanque en el techo del sensor (≥' + UMBRAL_TOPE + '%): mide la carga asentándose, no la baja negativa. No cuenta como sustracción.">tope</i>'
          : o.lejana
            ? ' <i class="cb2-recal" title="La bajada encontrada en la serie no casa con la hora del evento: no se puede afirmar la magnitud">no casa</i>'
            : '';
    if (e.delta_pct != null) {
      var cls = o.grave ? ' fuerte grave' : o.fuerte ? ' fuerte' : (o.recal || o.clip || o.tope || o.lejana ? ' recal' : '');
      var tip = 'Nivel ' + (e.nivel_antes != null ? e.nivel_antes + '% → ' + e.nivel_despues + '%' : 'según serie del sensor') +
        (o.grave ? ' · ≥' + UMBRAL_GRAVE + '%: media carga o más' : o.fuerte ? ' · ≥' + UMBRAL_FUERTE + '%: sospecha fuerte' : '');
      return '<span class="cb2-delta' + cls + '" title="' + esc(tip) + '">' +
        (e.delta_pct > 0 ? '−' : '') + num(e.delta_pct, 1) + '%</span>' + marca;
    }
    if (e.nivel_sin_datos) {
      return '<span class="cb2-delta na" title="La serie de nivel no devolvió lecturas para esta unidad en esa ventana">s/d</span>' + marca;
    }
    return '<span class="cb2-delta pend" title="Pendiente: el enriquecido diario procesa las caídas de la más reciente a la más antigua">…</span>' + marca;
  }

  function tabla(caidas) {
    if (!caidas.length) {
      return '<div class="cb2-vacio">Sin caídas de nivel en el rango filtrado.' +
        '<small>Es una buena noticia, pero revisa la cobertura: sólo hay eventos de los días rescatados.</small></div>';
    }
    var h = '<div class="cb2-tabla-wrap"><table class="cb2-tabla"><thead><tr>' +
      '<th>Cuándo</th><th class="c">Franja</th><th class="c" title="Nivel de tanque antes menos después, de la serie del sensor. ≥' +
      UMBRAL_FUERTE + '% = sospecha fuerte">Δ%</th><th>Unidad</th><th>UDN</th>' +
      '<th>Responsable atribuido</th><th>Dónde</th><th class="c">Mapa</th>' +
      '</tr></thead><tbody>';
    caidas.forEach(function (o) {
      var e = o.ev;
      var maps = (e.lat != null)
        ? 'https://www.google.com/maps?q=' + e.lat + ',' + e.lng
        : null;
      h += '<tr class="cb2-f' + (SEL === e.id ? ' on' : '') + '" data-ev="' + esc(e.id) + '">' +
        '<td class="cb2-cuando"><b>' + diaSem(e.fecha) + ' ' + fechaCorta(e.fecha) + '</b><small>' + hora(e.time) + '</small></td>' +
        '<td class="c"><span class="cb2-franja f-' + o.franja + '">' + o.franja + '</span></td>' +
        '<td class="c">' + celdaDelta(o) + '</td>' +
        '<td class="cb2-placa">' + esc(o.placa) + '</td>' +
        '<td class="cb2-udn">' + esc(o.udn || '—') + '</td>' +
        '<td>' + filaResp(o) + '</td>' +
        '<td class="cb2-geo">' + (e.lat != null ? e.lat.toFixed(4) + ', ' + e.lng.toFixed(4) : '<span class="cb2-sin">sin GPS</span>') + '</td>' +
        '<td class="c">' + (maps ? '<a class="cb2-maps" href="' + maps + '" target="_blank" rel="noopener noreferrer" title="Abrir en Google Maps">ver</a>' : '—') + '</td>' +
        '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  /* Semanas del archivo que contienen caídas y aún NO están cargadas en memoria.
     El portal arranca con las 4 más recientes; las caídas suelen ser anteriores,
     y sin la telemetría de esa semana no hay a quién atribuirlas. */
  function semanasQueFaltan(caidas) {
    var A = window.ARCHIVO;
    if (!A || !A.disponibles) return [];
    var cargadas = {};
    (A.cargadas || []).forEach(function (s) { cargadas[s] = 1; });
    var disp = A.disponibles || [];
    var necesito = {};
    caidas.forEach(function (o) {
      if (!o.resp || !o.resp.fueraDeRango) return;
      disp.forEach(function (s) {
        if (o.ev.fecha >= s.from && o.ev.fecha <= s.to && !cargadas[s.semana]) necesito[s.semana] = 1;
      });
    });
    return Object.keys(necesito).sort();
  }

  function pedirSemanas(lista) {
    if (PIDIENDO || !window.ARCHIVO || !lista.length) return;
    PIDIENDO = true;
    var b = CONT.querySelector('[data-pedir]');
    if (b) { b.disabled = true; b.textContent = 'Cargando ' + lista.length + ' semana(s)…'; }
    window.ARCHIVO.asegurar(lista).then(function () {
      PIDIENDO = false;
      if (typeof RECARGAR === 'function') RECARGAR(); else pintar();
    }).catch(function () { PIDIENDO = false; pintar(); });
  }

  /* ----------------------------------------------------------------- pintar */
  function kpi(icon, label, val, sub, t) {
    return '<div class="cb2-kpi' + (t ? ' ' + t : '') + '">' +
      '<div class="cb2-kpi-top">' + ico(icon) + '<span class="l">' + esc(label) + '</span></div>' +
      '<div class="v">' + val + '</div>' +
      (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function pintar() {
    if (!CONT) return;
    if (CARGANDO) { CONT.innerHTML = '<div class="cb2-vacio">Cargando eventos de combustible…</div>'; return; }
    if (ERROR || !DATOS) {
      CONT.innerHTML = '<div class="cb2-vacio">No hay archivo de eventos de combustible.' +
        '<small>Genéralo con <code>node connector/extraer_combustible.mjs</code>. ' +
        (ERROR ? 'Detalle: ' + esc(ERROR) : '') + '</small></div>';
      return;
    }
    var a = analizar();
    var caidas = a.caidas, cargas = a.cargas;
    var unidades = {}; caidas.forEach(function (o) { unidades[o.placa] = (unidades[o.placa] || 0) + 1; });
    var reinc = Object.keys(unidades).filter(function (k) { return unidades[k] > 1; })
      .sort(function (x, y) { return unidades[y] - unidades[x]; });
    var nocturnas = caidas.filter(function (o) { return o.franja === 'madrugada' || o.franja === 'noche'; }).length;
    var conDelta = caidas.filter(function (o) { return o.ev.delta_pct != null; }).length;
    var fuertes = caidas.filter(function (o) { return o.fuerte; }).length;
    var recals = caidas.filter(function (o) { return o.recal; }).length;
    var clips = caidas.filter(function (o) { return o.clip; }).length;
    var topes = caidas.filter(function (o) { return o.tope; }).length;
    var graves = caidas.filter(function (o) { return o.grave; }).length;
    var pendientes = caidas.filter(function (o) { return o.ev.delta_pct == null && !o.ev.nivel_sin_datos; }).length;
    var tanque = caidas.reduce(function (s, o) { return s + (o.fuerte ? o.ev.delta_pct : 0); }, 0);
    var fuera = caidas.filter(function (o) { return o.resp && o.resp.fueraDeRango; }).length;
    var atribuidas = caidas.filter(function (o) { return o.resp && !o.resp.fueraDeRango; }).length;
    var atribuibles = caidas.length - fuera;
    var serie = serieDiaria(caidas);
    var dias = (DATOS && DATOS.dias) || serie.length;

    var h = '<section class="cb2-mod" aria-label="Combustible y caídas de nivel">';

    h += '<header class="cb2-head"><div class="cb2-head-l">' +
      '<h2 class="cb2-title">Combustible <em>/ caídas de nivel</em></h2>' +
      '<div class="cb2-sub">' + dias + ' días con eventos rescatados' +
      (DATOS.cobertura ? ' · ' + DATOS.cobertura.desde + ' → ' + DATOS.cobertura.hasta : '') +
      ' · ' + caidas.length + ' caídas · ' + cargas.length + ' cargas</div>' +
      '</div></header>';

    h += '<div class="cb2-kpis">';
    /* El KPI de cabecera es la SOSPECHA FUERTE, no el conteo bruto de caídas: el
       bruto mezcla recalibraciones y artefactos del sensor y no acciona nada. */
    h += kpi('aviso', 'Sospecha fuerte', num(fuertes),
      conDelta
        ? 'de ' + caidas.length + ' caídas · Δ ≥' + UMBRAL_FUERTE + '% sin artefacto' +
          (graves ? ' · ' + graves + ' de media carga o más' : '') +
          (topes ? ' · ' + topes + ' descartadas por arrancar en tope' : '')
        : (dias ? num(caidas.length / dias, 1) + ' caídas por día · magnitud sin medir' : ''),
      fuertes ? 'bad' : 'ok');
    h += kpi('combustible', 'Tanque sustraído', num(tanque, 0) + '<small>%</small>',
      'suma del % de tanque de las caídas fuertes' + (pendientes ? ' · ' + pendientes + ' aún sin medir' : ''),
      tanque ? 'bad' : '');
    h += kpi('unidades', 'Unidades afectadas', num(Object.keys(unidades).length),
      reinc.length ? reinc.length + ' con más de una caída' : 'ninguna reincidente', reinc.length ? 'high' : '');
    h += kpi('reloj', 'Fuera de horario', num(nocturnas),
      caidas.length ? num(nocturnas / caidas.length * 100, 0) + '% en noche o madrugada (hora local)' : '', nocturnas ? 'warn' : '');
    h += kpi('operadores', 'Con responsable', num(atribuidas) + '<small>/' + num(atribuibles) + '</small>',
      fuera ? fuera + ' caídas fuera del histórico cargado' : 'atribuido por quién traía la unidad',
      fuera ? 'warn' : '');
    h += '</div>';

    h += '<div class="cb2-aviso">' + ico('aviso') +
      '<div><b>Cómo leer el responsable.</b> El evento casi nunca trae operador logueado: el nivel cae con la ' +
      'unidad detenida. El nombre que aparece es <b>quién traía esa unidad</b> según la telemetría, no quien ' +
      'fue visto haciéndolo. «Probable» = único o principal operador de la unidad ese día. «Posible» = nadie ' +
      'la manejó ese día y es el más cercano en ±' + VENTANA_ATRIB + ' días. Sirve para <b>abrir la ' +
      'investigación</b>, no para cerrarla.</div></div>';

    var faltan = semanasQueFaltan(caidas);
    if (fuera) {
      h += '<div class="cb2-limite">' + ico('aviso') +
        '<div><b>' + fuera + ' de ' + caidas.length + ' caídas no se pueden atribuir todavía.</b> Son anteriores a ' +
        'las semanas cargadas' + (a.cobertura ? ' (' + a.cobertura.desde + ' → ' + a.cobertura.hasta + ')' : '') +
        ', así que no hay telemetría para cruzar quién traía la unidad.' +
        (faltan.length
          ? ' Esas semanas <b>ya están en disco</b> (' + faltan.join(', ') + '); el portal sólo carga las 4 más ' +
            'recientes de arranque.<br><button class="cb2-btn" data-pedir>Cargar ' + faltan.length +
            ' semana' + (faltan.length === 1 ? '' : 's') + ' y atribuir</button>'
          : ' En cuanto el histórico llegue a esas fechas, el responsable aparece solo — no hay que reprocesar nada.') +
        '</div></div>';
    }
    /* PERSONAS reincidentes: el cruce que de verdad acciona. Que una misma
       persona repita caídas en LA MISMA unidad es lo que separa un sensor con
       ruido de un patrón que hay que ir a ver. */
    var porPersona = {};
    caidas.forEach(function (o) {
      if (!o.resp || o.resp.fueraDeRango || !o.resp.conductor) return;
      var p = porPersona[o.resp.conductor] ||
        (porPersona[o.resp.conductor] = { n: 0, placas: {}, franjas: {}, certezas: {}, fechas: [] });
      p.n++; p.placas[o.placa] = 1; p.franjas[o.franja] = (p.franjas[o.franja] || 0) + 1;
      p.certezas[o.resp.certeza] = 1;
      p.fechas.push({ f: o.ev.fecha, t: hora(o.ev.time), fr: o.franja });
    });
    var personas = Object.keys(porPersona).filter(function (k) { return porPersona[k].n > 1; })
      .sort(function (a, b) { return porPersona[b].n - porPersona[a].n; });
    if (personas.length) {
      /* v3: el muro de cards con pastillas rojas fue calificado de "horrible y
         genérico". La referencia es el RANKING del módulo Seguridad, que el
         cliente aprobó: tabla con posición, nombre condensado, barra y chips
         sólidos SOLO donde hay señal (conteo, nocturnas, confirmada). */
      var maxN = porPersona[personas[0]].n;
      h += '<div class="cb2-bloque cb2-focos"><div class="cb2-bloque-t">' + ico('operadores') +
        'Responsables con caídas repetidas — por dónde empezar' +
        '<span class="cb2-bloque-n">clic en una fila: acota tabla y mapa a esa persona</span></div>';
      h += '<div class="cb2-rank-scroll"><table class="cb2-tabla cb2-rank"><thead><tr>' +
        '<th class="c">#</th><th>Responsable</th><th class="n">Caídas</th><th class="cb2-th-b"></th>' +
        '<th>Unidad</th><th>Cuándo (día · hora)</th></tr></thead><tbody>';
      personas.forEach(function (k, i) {
        var p = porPersona[k];
        var placas = Object.keys(p.placas);
        var noct = p.fechas.filter(function (x) { return x.fr === 'madrugada' || x.fr === 'noche'; }).length;
        /* Mismo tope que el ranking de unidades: con el año entero un operador
           acumula 48 fechas y el renglón se vuelve un muro. Las 5 más recientes. */
        var ordP = p.fechas.slice().sort(function (a, b) { return a.f < b.f ? 1 : -1; });
        var fechas = ordP.slice(0, 5)
          .map(function (x) {
            return '<u' + (x.fr === 'madrugada' || x.fr === 'noche' ? ' class="noct"' : '') + '>' +
              fechaCorta(x.f) + ' ' + x.t + '</u>';
          }).join(' · ') +
          (ordP.length > 5 ? ' <span class="cb2-mas">+' + (ordP.length - 5) + ' antes</span>' : '');
        h += '<tr class="cb2-r-fila' + (FILTRO_RESP === k ? ' on' : '') + '" data-resp="' + esc(k) + '">' +
          '<td class="c cb2-pos">' + (i + 1) + '</td>' +
          '<td class="cb2-r-nom"><span>' + esc(k) + '</span>' +
          '<small>' + (p.certezas.confirmada ? '<i class="cb2-cert c-confirmada">confirmada</i>' : 'atribuido por telemetría') + '</small></td>' +
          '<td class="n"><span class="cb2-nchip">' + p.n + '</span></td>' +
          '<td class="cb2-r-barra"><i style="width:' + Math.round(p.n / maxN * 100) + '%"></i></td>' +
          '<td class="cb2-r-uni"><b>' + esc(placas.join(', ')) + '</b>' +
          (placas.length === 1 ? '<small>siempre la misma</small>' : '<small>' + placas.length + ' unidades</small>') + '</td>' +
          '<td class="cb2-r-fechas">' + fechas +
          (noct ? ' <span class="cb2-noct">' + noct + ' nocturna' + (noct === 1 ? '' : 's') + '</span>' : '') + '</td>' +
          '</tr>';
      });
      h += '</tbody></table></div>' +
        '<div class="cb2-nota-mini">Repetir caídas <b>en la misma unidad</b> es el patrón fuerte: esa unidad es la suya. ' +
        'Sigue siendo atribución, no prueba — ver el aviso de arriba.</div></div>';
    }

    /* UNIDADES por tanque acumulado. La reincidencia con magnitud es la conclusión
       más fuerte del módulo: un evento aislado de 25% puede ser cualquier cosa, pero
       una unidad que repite caídas grandes es un patrón. Se ordena por % de tanque
       ACUMULADO, no por número de eventos: 18 caídas de 3% no son un robo y una sola
       de 80% sí importa. Solo entran las caídas de sospecha fuerte (ya sin
       recalibraciones ni artefactos post-carga). */
    var porUnidad = {};
    caidas.forEach(function (o) {
      if (!o.fuerte) return;
      var u = porUnidad[o.placa] || (porUnidad[o.placa] = {
        n: 0, acum: 0, peor: 0, udn: o.udn, noct: 0, graves: 0, resp: {}, fechas: [],
      });
      u.n++; u.acum += o.ev.delta_pct; u.peor = Math.max(u.peor, o.ev.delta_pct);
      if (o.grave) u.graves++;
      if (o.franja === 'madrugada' || o.franja === 'noche') u.noct++;
      if (o.resp && o.resp.conductor && !o.resp.fueraDeRango) u.resp[o.resp.conductor] = 1;
      u.fechas.push({ f: o.fechaL || o.ev.fecha, t: hora(o.ev.time), noct: o.franja === 'madrugada' || o.franja === 'noche' });
    });
    var uOrden = Object.keys(porUnidad).sort(function (x, y) { return porUnidad[y].acum - porUnidad[x].acum; });
    if (uOrden.length) {
      var maxAcum = porUnidad[uOrden[0]].acum;
      h += '<div class="cb2-bloque cb2-focos"><div class="cb2-bloque-t">' + ico('aviso') +
        'Unidades por tanque sustraído — el orden de ataque' +
        '<span class="cb2-bloque-n">solo caídas de sospecha fuerte (Δ ≥' + UMBRAL_FUERTE +
        '%, sin recalibración ni artefacto post-carga)</span></div>';
      h += '<div class="cb2-rank-scroll"><table class="cb2-tabla cb2-rank"><thead><tr>' +
        '<th class="c">#</th><th>Unidad</th><th>UDN</th><th class="n" title="Caídas de sospecha fuerte">Ev.</th>' +
        '<th class="n" title="Suma del % de tanque de todas sus caídas fuertes">% tanque acum.</th>' +
        '<th class="cb2-th-b"></th><th class="n" title="La caída más grande">Peor</th>' +
        '<th>Responsables atribuidos</th><th>Cuándo (día · hora local)</th></tr></thead><tbody>';
      uOrden.forEach(function (pl, i) {
        var u = porUnidad[pl];
        var resps = Object.keys(u.resp);
        /* Solo las 5 MÁS RECIENTES. Con 18 caídas la lista completa infla el
           renglón a media pantalla y deja el centro vacío — patrón prohibido. Lo
           que acciona es "cuándo fue la última", no el listado íntegro. */
        var ord = u.fechas.slice().sort(function (a, b) { return a.f < b.f ? 1 : -1; });
        var fechas = ord.slice(0, 5)
          .map(function (x) { return '<u' + (x.noct ? ' class="noct"' : '') + '>' + fechaCorta(x.f) + ' ' + x.t + '</u>'; })
          .join(' · ') +
          (ord.length > 5 ? ' <span class="cb2-mas">+' + (ord.length - 5) + ' antes</span>' : '');
        h += '<tr class="cb2-r-fila" data-unidad="' + esc(pl) + '">' +
          '<td class="c cb2-pos">' + (i + 1) + '</td>' +
          '<td class="cb2-r-nom"><span>' + esc(pl) + '</span>' +
          (u.graves ? '<small><i class="cb2-cert c-confirmada">' + u.graves + ' de media carga o más</i></small>' : '') + '</td>' +
          '<td class="cb2-udn">' + esc(u.udn || '—') + '</td>' +
          '<td class="n"><span class="cb2-nchip">' + u.n + '</span></td>' +
          '<td class="n"><b>' + num(u.acum, 0) + '%</b></td>' +
          '<td class="cb2-r-barra"><i style="width:' + Math.round(u.acum / maxAcum * 100) + '%"></i></td>' +
          '<td class="n">' + num(u.peor, 0) + '%</td>' +
          '<td class="cb2-r-uni">' + (resps.length
            ? '<b>' + esc(resps.slice(0, 3).join(', ')) + '</b>' +
              (resps.length > 3 ? '<small>y ' + (resps.length - 3) + ' más</small>'
                : '<small>' + (resps.length === 1 ? 'siempre el mismo' : resps.length + ' operadores') + '</small>')
            : '<span class="cb2-sin">sin atribuir</span>') + '</td>' +
          '<td class="cb2-r-fechas">' + fechas +
          (u.noct ? ' <span class="cb2-noct">' + u.noct + ' nocturna' + (u.noct === 1 ? '' : 's') + '</span>' : '') + '</td>' +
          '</tr>';
      });
      h += '</tbody></table></div>' +
        '<div class="cb2-nota-mini">Se ordena por <b>% de tanque acumulado</b>, no por número de caídas: ' +
        'una sola de 80% pesa más que seis de 20%. Empieza por el primer renglón.</div></div>';
    }

    var visibles = FILTRO_RESP
      ? caidas.filter(function (o) { return o.resp && o.resp.conductor === FILTRO_RESP; })
      : caidas;
    var chipFiltro = FILTRO_RESP
      ? '<span class="cb2-filtro-chip">' + esc(FILTRO_RESP) + ' · ' + visibles.length +
        ' caídas <button data-quitar aria-label="Quitar filtro">✕</button></span>' : '';

    h += '<div class="cb2-row2">';
    h += '<div class="cb2-bloque"><div class="cb2-bloque-t">' + ico('tendencia') + 'Caídas por día · nocturnas vs diurnas</div>' + graficaDias(serie) + '</div>';
    h += '<div class="cb2-bloque"><div class="cb2-bloque-t">' + ico('panorama') + 'Dónde ocurren' + chipFiltro +
      '</div><div id="cb2Leaflet" class="cb2-leaflet"></div>' +
      '<div class="cb2-nota-mini">Clic en un marcador o en una fila de la tabla: fecha, hora, unidad y responsable. © OpenStreetMap.</div></div>';
    h += '</div>';

    h += '<div class="cb2-bloque"><div class="cb2-bloque-t">' + ico('tabla') + 'Cada caída de nivel' + chipFiltro + '</div>' +
      tabla(visibles) + '</div>';

    h += '<div class="cb2-limite">' + ico('regla') +
      '<div><b>Cómo leer el Δ%.</b> Es el nivel del tanque antes menos después, leído de la serie del sensor ' +
      '(<code>api_get_vehicle_parameter_values</code>); el refresco diario lo va completando de la caída más ' +
      'reciente a la más antigua («…» = pendiente, «s/d» = el sensor no dio lecturas). Una caída <b>≥' +
      UMBRAL_FUERTE + '%</b> es sospecha fuerte y <b>≥' + UMBRAL_GRAVE + '%</b> es media carga o más. ' +
      'Lo que cuenta es <b>solo la baja negativa</b>, nunca la carga. Se descuentan cuatro artefactos: ' +
      '<b>carga en la hora siguiente</b> = recalibración; <b>carga en la hora anterior</b> («post-carga»); ' +
      '<b>«tope»</b> = la bajada arranca con el tanque en el techo del sensor (≥' + UMBRAL_TOPE + '%), así que ' +
      'mide la carga asentándose y no una sustracción; <b>«no casa»</b> = la bajada de la serie no coincide ' +
      'con la hora del evento. ' +
      'Litros exactos siguen sin permisos (<code>fuel_used</code> vacío): ver <code>docs/SOLICITUD-TRAFFILOG.md</code>. ' +
      'Y ojo: <b>los eventos no son un censo completo</b> — hay cargas y caídas visibles en la gráfica de ' +
      'Traffilog que no emiten evento, así que esto es un piso, no el total.</div></div>';

    h += '</section>';
    CONT.innerHTML = h;
    var btn = CONT.querySelector('[data-pedir]');
    if (btn) btn.addEventListener('click', function () { pedirSemanas(faltan); });
    montarMapaCb(CONT, visibles);
    CONT.querySelectorAll('[data-resp]').forEach(function (b) {
      b.addEventListener('click', function () {
        FILTRO_RESP = FILTRO_RESP === b.dataset.resp ? null : b.dataset.resp;
        pintar();
      });
    });
    CONT.querySelectorAll('[data-quitar]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); FILTRO_RESP = null; pintar(); });
    });
    CONT.querySelectorAll('tr[data-ev]').forEach(function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;         // el enlace a Maps no selecciona
        var o = visibles.filter(function (x) { return x.ev.id === tr.dataset.ev; })[0];
        if (o && o._marker && MAPA_CB) {
          MAPA_CB.flyTo([o.ev.lat, o.ev.lng], 14, { duration: .7 });
          setTimeout(function () { o._marker.openPopup(); }, 800);
          var mapaDiv = CONT.querySelector('#cb2Leaflet');
          if (mapaDiv) mapaDiv.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    });
  }

  /* ----------------------------------------------------------------- export */
  window.MODULOS[ID] = {
    id: ID,
    titulo: 'Combustible',
    render: function (container, state) {
      if (!document.querySelector('link[data-modulo="combustible"]')) {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = CSS_HREF; l.dataset.modulo = 'combustible';
        document.head.appendChild(l);
      }
      CONT = container;
      DATA = (state && state.data) || null;
      FILTROS = (state && state.filtros) || {};
      RECARGAR = (state && state.recargar) || null;
      if (!DATOS && !ERROR) { cargar(); pintar(); } else pintar();
    },
  };
})();
