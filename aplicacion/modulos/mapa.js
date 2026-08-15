/* ============================================================================
 * MÓDULO — MAPA DE CALOR / PUNTOS NEGROS DE RUTA  (v2 — mapa real)
 * ----------------------------------------------------------------------------
 * PARA QUÉ SIRVE (la pregunta directa del cliente)
 * Para separar dos cosas que hoy se confunden en una sola:
 *   · el MAL HÁBITO de un operador (pocas unidades disparan el evento ahí)
 *   · el PUNTO NEGRO de la ruta (muchas unidades distintas lo disparan ahí:
 *     una curva sin peralte, un tope sin pintar, un límite mal señalizado)
 * El portal cuelga todos los eventos del conductor; este módulo mira el LUGAR.
 * Si 77 unidades exceden velocidad en el mismo kilómetro, corregir ahí la ruta
 * borra más eventos que regañar a 77 personas.
 *
 * v2 tras la crítica del cliente (2026-07-24):
 *   · Mapa REAL (Leaflet + OpenStreetMap, vendoreado — sin API key ni costo),
 *     no la nube de puntos sobre cuadrícula gris.
 *   · La tabla responde a la capa activa: si miras Ralentí ya no te lista
 *     giros y frenados — muestra la capa elegida y su peso en la zona.
 *   · Filtro por UDN. La rejilla no guarda UDN (viene de la posición cruda),
 *     así que se deriva de la GEOGRAFÍA: GDL / Colima / Lázaro Cárdenas están
 *     en cajas lat/lng disjuntas. Se etiqueta como derivado, no como dato.
 *
 * Fuente: datos/historico/geo.json (connector/extraer_geo.mjs, corre solo al
 * consolidar cada semana). Rejilla de 0.01° ≈ 1.1 km: señala el tramo, no el carril.
 * ========================================================================== */
(function () {
  'use strict';
  window.MODULOS = window.MODULOS || {};

  var ID = 'mapa';
  var CSS_HREF = 'aplicacion/modulos/mapa.css?v=8';
  var FUENTE = 'datos/historico/geo.json';

  var DATOS = null, CARGANDO = false, ERROR = null;
  var CONT = null;
  var CAPA = 'todo';
  var UDN = '';
  var MIN_UNIDADES = 5;
  var MAPA = null, CAPA_PUNTOS = null;   // instancia Leaflet + layerGroup

  var CAPAS = [
    { id: 'todo', label: 'Todo', desc: 'todos los eventos con posición' },
    { id: 'fr',   label: 'Frenado', desc: 'frenados bruscos' },
    { id: 'ac',   label: 'Aceleración', desc: 'aceleraciones bruscas' },
    { id: 'gir',  label: 'Giro', desc: 'giros bruscos' },
    { id: 'vel',  label: 'Velocidad', desc: 'excesos de velocidad' },
    { id: 'ral',  label: 'Ralentí', desc: 'motor encendido y parado' },
    { id: 'robo', label: 'Robo / pánico', desc: 'alertas de robo y botón de pánico' },
    { id: 'fuel', label: 'Combustible', desc: 'cargas y caídas de nivel' },
  ];
  var NOMBRE_CAPA = { todo: 'eventos', fr: 'frenados', ac: 'aceleraciones', gir: 'giros',
    vel: 'excesos de velocidad', ral: 'eventos de ralentí', robo: 'alertas de robo/pánico', fuel: 'eventos de combustible' };

  /* UDN por geografía. Cajas generosas y disjuntas; lo que caiga fuera = "Otra zona".
     Es DERIVADO de la posición, no un dato de Traffilog — la UI lo dice. */
  var ZONAS = [
    { id: 'Guadalajara',     la0: 20.0, la1: 21.4, ln0: -104.4, ln1: -102.6 },
    { id: 'Colima',          la0: 18.5, la1: 19.9, ln0: -104.9, ln1: -103.2 },
    { id: 'Lázaro Cárdenas', la0: 17.4, la1: 18.5, ln0: -103.1, ln1: -101.5 },
  ];
  function zonaDe(c) {
    for (var i = 0; i < ZONAS.length; i++) {
      var z = ZONAS[i];
      if (c.lat >= z.la0 && c.lat <= z.la1 && c.lng >= z.ln0 && c.lng <= z.ln1) return z.id;
    }
    return 'Otra zona';
  }

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
      ? '<span class="mp-ic">' + ICONOS.svg(n) + '</span>' : '';
  }
  function valor(c, capa) {
    if (capa === 'todo') return c.n || 0;
    if (capa === 'ral') return (c.ext && c.ext.ral) || 0;
    if (capa === 'robo') return (c.ext && c.ext.robo) || 0;
    if (capa === 'fuel') return ((c.ext && c.ext.fuel_caida) || 0) + ((c.ext && c.ext.fuel_carga) || 0);
    return (c.fam && c.fam[capa]) || 0;
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  /* ------------------------------------------------------ carga del archivo */
  function cargar() {
    if (DATOS || CARGANDO) return;
    CARGANDO = true;
    fetch(FUENTE, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        (j.celdas || []).forEach(function (c) { c.zona = zonaDe(c); });
        DATOS = j; CARGANDO = false; pintar();
      })
      .catch(function (e) { ERROR = e.message; CARGANDO = false; pintar(); });
  }

  /* ------------------------------------------------------------ mapa Leaflet */
  function colorPaso(v, max) {
    var r = v / (max || 1);
    if (r > .62) return cssVar('--sem-bad') || '#D93F37';
    if (r > .38) return cssVar('--sem-high') || '#EE8B36';
    if (r > .18) return cssVar('--sem-warn') || '#EDC531';
    return cssVar('--gray') || '#63666A';
  }

  function montarMapa(cont, celdas) {
    var div = cont.querySelector('#mpLeaflet');
    if (!div || !window.L) return;
    /* Leaflet no sobrevive a innerHTML del contenedor: se destruye y recrea. */
    if (MAPA) { try { MAPA.remove(); } catch (e) {} MAPA = null; }
    MAPA = L.map(div, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap',
    }).addTo(MAPA);
    CAPA_PUNTOS = L.layerGroup().addTo(MAPA);

    var pts = celdas.filter(function (c) { return valor(c, CAPA) > 0; });
    if (!pts.length) { MAPA.setView([20.6, -103.3], 9); return; }
    var max = pts.reduce(function (m, c) { return Math.max(m, valor(c, CAPA)); }, 1);
    var bounds = [];
    pts.sort(function (a, b) { return valor(a, CAPA) - valor(b, CAPA); });
    pts.forEach(function (c) {
      var v = valor(c, CAPA);
      var ruta = (c.u || 0) >= MIN_UNIDADES;
      var m = L.circleMarker([c.lat, c.lng], {
        radius: 4 + Math.sqrt(v / max) * 14,
        color: colorPaso(v, max),
        weight: ruta ? 2.5 : 1.2,
        dashArray: ruta ? '4 3' : null,
        fillColor: colorPaso(v, max),
        fillOpacity: .38,
      });
      m.bindPopup(
        '<div class="mp-pop">' +
        '<b>' + num(v) + ' ' + (NOMBRE_CAPA[CAPA] || 'eventos') + '</b>' +
        '<span>' + num(c.u || 0) + ' unidades distintas · ' + num(c.n) + ' eventos en total</span>' +
        (ruta ? '<em class="mp-pop-ruta">⚠ punto de RUTA: lo disparan muchas unidades — el problema es del lugar</em>'
              : '<em>pocas unidades: aquí sí revisa a los operadores</em>') +
        '<span>' + esc(c.zona) + ' · celda de ~1.1 km</span>' +
        '<a href="https://www.google.com/maps?q=' + c.lat + ',' + c.lng + '" target="_blank" rel="noopener noreferrer">Abrir en Google Maps →</a>' +
        '</div>', { maxWidth: 260 });
      m.addTo(CAPA_PUNTOS);
      c._marker = m;
      bounds.push([c.lat, c.lng]);
    });
    MAPA.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
  }

  /* ------------------------------------------------------------------ tabla */
  function tabla(celdas) {
    var top = celdas.filter(function (c) { return valor(c, CAPA) > 0; })
      .sort(function (a, b) { return valor(b, CAPA) - valor(a, CAPA); }).slice(0, 25);
    if (!top.length) return '<div class="mp-vacio-mini">Sin zonas con ' + (NOMBRE_CAPA[CAPA] || 'eventos') + ' en este filtro.</div>';
    var capaDef = CAPAS.filter(function (c) { return c.id === CAPA; })[0];
    var h = '<div class="mp-tabla-wrap"><table class="mp-tabla"><thead><tr>' +
      '<th class="c">#</th><th>Zona</th><th class="n">' + esc(capaDef.label) + '</th>' +
      '<th class="n">Unidades</th><th>Lectura</th>' +
      '<th class="n">' + (CAPA === 'todo' ? 'Desglose' : '% del total de la zona') + '</th>' +
      '<th class="c">Ver</th></tr></thead><tbody>';
    top.forEach(function (c, i) {
      var v = valor(c, CAPA), u = c.u || 0, ruta = u >= MIN_UNIDADES;
      var contexto;
      if (CAPA === 'todo') {
        /* sólo en "Todo" tiene sentido desglosar por familia */
        var fam = Object.keys(c.fam || {}).sort(function (a, b) { return c.fam[b] - c.fam[a]; });
        contexto = fam.slice(0, 3).map(function (f) {
          return ({ ac: 'acel', fr: 'freno', gir: 'giro', vel: 'vel' }[f] || f) + ' ' + c.fam[f];
        }).join(' · ') || '—';
      } else {
        /* en una capa específica: cuánto pesa ESA capa dentro de la zona */
        contexto = c.n ? num(v / c.n * 100, 0) + '% de ' + num(c.n) + ' ev' : '—';
      }
      h += '<tr data-c="' + c.lat + ',' + c.lng + '">' +
        '<td class="c mp-pos">' + (i + 1) + '</td>' +
        '<td class="mp-coord">' + esc(c.zona) + '<small>' + c.lat.toFixed(2) + ', ' + c.lng.toFixed(2) + '</small></td>' +
        '<td class="n"><b>' + num(v) + '</b></td>' +
        '<td class="n">' + num(u) + '</td>' +
        '<td>' + (ruta ? '<span class="mp-tag mp-t-ruta">punto de ruta</span>'
                       : '<span class="mp-tag mp-t-op">pocas unidades</span>') + '</td>' +
        '<td class="n mp-rep">' + esc(contexto) + '</td>' +
        '<td class="c"><button class="mp-ir" data-ir="' + c.lat + ',' + c.lng + '" title="Centrar en el mapa">mapa</button></td>' +
        '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  /* ----------------------------------------------------------------- pintar */
  function kpi(icon, label, val, sub, t) {
    return '<div class="mp-kpi' + (t ? ' ' + t : '') + '">' +
      '<div class="mp-kpi-top">' + ico(icon) + '<span class="l">' + esc(label) + '</span></div>' +
      '<div class="v">' + val + '</div>' +
      (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function pintar() {
    if (!CONT) return;
    if (CARGANDO) { CONT.innerHTML = '<div class="mp-vacio">Cargando rejilla geográfica…</div>'; return; }
    if (ERROR || !DATOS) {
      CONT.innerHTML = '<div class="mp-vacio">Todavía no hay rejilla geográfica.' +
        '<small>Se genera sola al consolidar cada semana descargada.' + (ERROR ? '<br>Detalle: ' + esc(ERROR) : '') + '</small></div>';
      return;
    }
    var todas = DATOS.celdas || [];
    var celdas = UDN ? todas.filter(function (c) { return c.zona === UDN; }) : todas;
    var conDato = celdas.filter(function (c) { return valor(c, CAPA) > 0; });
    var puntosRuta = conDato.filter(function (c) { return (c.u || 0) >= MIN_UNIDADES; });
    var evCapa = conDato.reduce(function (s, c) { return s + valor(c, CAPA); }, 0);
    var evRuta = puntosRuta.reduce(function (s, c) { return s + valor(c, CAPA); }, 0);
    var capaDef = CAPAS.filter(function (c) { return c.id === CAPA; })[0] || CAPAS[0];
    var zonas = {};
    todas.forEach(function (c) { zonas[c.zona] = 1; });

    var h = '<section class="mp-mod" aria-label="Mapa de calor de eventos">';
    h += '<header class="mp-head"><div class="mp-head-l">' +
      '<h2 class="mp-title">Mapa de calor <em>/ puntos negros de ruta</em></h2>' +
      '<div class="mp-sub">' + num(celdas.length) + ' celdas de ~1.1 km · ' +
      num(DATOS.eventos_totales || 0) + ' eventos con posición · cobertura: semanas descargadas con el extractor activo</div>' +
      '</div><div class="mp-head-r">' +
      '<label class="mp-filtro"><span>Unidad de negocio <i title="Derivada de la posición GPS, no de Traffilog">geo</i></span>' +
      '<select id="mpUdn"><option value="">Todas</option>' +
      Object.keys(zonas).sort().map(function (z) {
        return '<option value="' + esc(z) + '"' + (UDN === z ? ' selected' : '') + '>' + esc(z) + '</option>';
      }).join('') + '</select></label></div></header>';

    h += '<div class="mp-capas" role="tablist">' + CAPAS.map(function (c) {
      return '<button class="mp-capa' + (CAPA === c.id ? ' on' : '') + '" data-capa="' + c.id +
        '" title="' + esc(c.desc) + '" role="tab">' + esc(c.label) + '</button>';
    }).join('') + '</div>';

    h += '<div class="mp-kpis">';
    h += kpi('panorama', 'Zonas con ' + capaDef.label.toLowerCase(), num(conDato.length),
      num(evCapa) + ' ' + (NOMBRE_CAPA[CAPA] || 'eventos'), '');
    h += kpi('aviso', 'Puntos de ruta', num(puntosRuta.length),
      '≥' + MIN_UNIDADES + ' unidades distintas · el problema es del lugar',
      puntosRuta.length ? 'bad' : '');
    h += kpi('unidades', 'Achacable al lugar', num(evRuta),
      evCapa ? num(evRuta / evCapa * 100, 0) + '% de ' + (NOMBRE_CAPA[CAPA] || 'esta capa') : '', evRuta ? 'high' : '');
    h += kpi('operadores', 'Achacable a operadores', num(evCapa - evRuta),
      'zonas de pocas unidades — ahí sí revisa personas', '');
    h += '</div>';

    h += '<div class="mp-bloque"><div class="mp-bloque-t">' + ico('panorama') +
      esc(capaDef.label) + ' · ' + esc(capaDef.desc) +
      '<span class="mp-bloque-n">punto discontinuo = punto de ruta · clic en un punto para el detalle</span></div>' +
      '<div id="mpLeaflet" class="mp-leaflet"></div>' +
      '<div class="mp-leyenda">' +
      '<span class="mp-k"><i class="mp-p1"></i><i class="mp-p2"></i><i class="mp-p3"></i><i class="mp-p4"></i> menos → más ' + esc(NOMBRE_CAPA[CAPA] || 'eventos') + '</span>' +
      '<span class="mp-k"><i class="mp-ruta-k"></i> punto de ruta (≥' + MIN_UNIDADES + ' unidades)</span>' +
      '<span class="mp-k-n">Mapa © OpenStreetMap · rejilla de ~1.1 km: señala el tramo, no el carril</span>' +
      '</div></div>';

    h += '<div class="mp-bloque"><div class="mp-bloque-t">' + ico('tabla') +
      'Zonas con más ' + esc(NOMBRE_CAPA[CAPA] || 'eventos') + '</div>' + tabla(celdas) + '</div>';
    h += '</section>';
    CONT.innerHTML = h;

    montarMapa(CONT, celdas);

    CONT.querySelectorAll('.mp-capa').forEach(function (b) {
      b.addEventListener('click', function () { CAPA = b.dataset.capa; pintar(); });
    });
    var sel = CONT.querySelector('#mpUdn');
    if (sel) sel.addEventListener('change', function () { UDN = sel.value; pintar(); });
    CONT.querySelectorAll('[data-ir]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = b.dataset.ir.split(',');
        var c = celdas.filter(function (x) { return x.lat === +p[0] && x.lng === +p[1]; })[0];
        if (MAPA) MAPA.flyTo([+p[0], +p[1]], 14, { duration: .8 });
        if (c && c._marker) setTimeout(function () { c._marker.openPopup(); }, 900);
        var bloque = CONT.querySelector('#mpLeaflet');
        if (bloque) bloque.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
  }

  /* ----------------------------------------------------------------- export */
  window.MODULOS[ID] = {
    id: ID,
    titulo: 'Mapa',
    render: function (container, state) {
      if (!document.querySelector('link[data-modulo="mapa"]')) {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = CSS_HREF; l.dataset.modulo = 'mapa';
        document.head.appendChild(l);
      }
      CONT = container;
      if (!DATOS && !ERROR) { cargar(); pintar(); } else pintar();
    },
  };
})();
