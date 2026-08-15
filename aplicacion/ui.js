/* ============================================================================
 * UIX — piezas de interfaz compartidas por index.html y por todos los módulos.
 *
 *  1. Acordeón jerárquico  UDN → Cliente → Operador
 *     · UIX.acordeon(opts)        → bloques de tarjetas/listas (altura real,
 *                                   grid-template-rows 0fr→1fr, sin saltos)
 *     · UIX.agruparTabla(tabla,…) → inyecta cabeceras de grupo colapsables en
 *                                   una <table> YA renderizada por un módulo,
 *                                   leyendo data-udn / data-cliente de cada fila.
 *     TODO grupo arranca COLAPSADO (petición del cliente): el usuario decide
 *     qué abrir primero. El estado de expansión se recuerda SÓLO en memoria,
 *     por (id, ruta): sobrevive re-renders y cambios de pestaña, y se pierde
 *     al recargar — que es justo lo que significa "colapsado al inicio".
 *     El orden por defecto de los grupos es del MÁS CRÍTICO al MEJOR.
 *
 *  2. UIX.stagger(el)  → reinicia la entrada escalonada de las cards.
 *  3. UIX.reducido()   → prefers-reduced-motion, consultado en cada llamada
 *                        (el usuario puede cambiarlo sin recargar).
 *  4. Gráficas expandibles a primer plano
 *     · UIX.registrarGrafica(host, redibujar)  → marca `host` como expandible.
 *       `redibujar(ancho, alto, expandido)` se llama con el tamaño REAL en px
 *       del lienzo cada vez que cambia (al expandir, al restaurar, al
 *       redimensionar la ventana): la gráfica se vuelve a generar, no se
 *       escala con CSS.
 *     · UIX.graficas(raiz) → inyecta el botón de expandir en todo
 *       [data-graf] que aún no lo tenga.
 * ========================================================================== */
(function (global, doc) {
  'use strict';

  var mqReduce = global.matchMedia ? global.matchMedia('(prefers-reduced-motion:reduce)') : null;
  function reducido() { return !!(mqReduce && mqReduce.matches); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------------ estado
   * SÓLO en memoria, a propósito. El cliente pidió que los listados de
   * operadores y el Cerebro Operativo aparezcan SIEMPRE colapsados al inicio;
   * si esto viviera en localStorage, la sesión anterior reabriría medio portal.
   * Dentro de la misma carga sí se recuerda: cambiar de pestaña, re-filtrar o
   * re-renderizar no pierde lo que el usuario abrió. */
  var memoria = {};
  function leerMem() { return memoria; }
  function abierto(id, ruta, pordefecto) {
    var m = memoria[id];
    if (m && Object.prototype.hasOwnProperty.call(m, ruta)) return !!m[ruta];
    return !!pordefecto;
  }
  function recordar(id, ruta, valor) {
    (memoria[id] || (memoria[id] = {}))[ruta] = !!valor;
  }
  function olvidar(id) { if (id) delete memoria[id]; else memoria = {}; }

  /* ------------------------------------------------------------------ iconos */
  function chevron() {
    return global.ICONOS
      ? '<span class="acc-cv">' + global.ICONOS.svg('chevron') + '</span>'
      : '<span class="acc-cv"></span>';
  }

  /* =========================================================================
   * 1a. Acordeón de bloques (no tabla). Devuelve HTML; enlazar con UIX.enlazar.
   *
   *   UIX.acordeon({
   *     id: 'eval-operadores',
   *     filas: [...],                        // objetos planos
   *     niveles: ['udn','cliente'],          // claves de agrupación, en orden
   *     etiquetas: ['UDN','Cliente'],
   *     resumen: function(nivel, clave, filas){ return '<span>…</span>'; },
   *     hoja:    function(filas, ruta){ return '<div>…</div>'; },
   *     abrir:   function(nivel, clave, filas){ return false; },   // ← por defecto
   *     riesgo:  function(filas, nivel, clave){ return 42; }       // ↑ mayor = peor
   *   })
   *
   * `riesgo` ordena los grupos del MÁS CRÍTICO al MEJOR (petición del cliente).
   * Sin `riesgo` se cae al orden alfabético de siempre.
   * ======================================================================= */
  function agrupar(filas, clave, riesgo, nivel) {
    var mapa = new Map();
    filas.forEach(function (f) {
      var k = f[clave];
      k = (k == null || k === '') ? '— sin asignar —' : String(k);
      if (!mapa.has(k)) mapa.set(k, []);
      mapa.get(k).push(f);
    });
    var lista = Array.from(mapa.entries());
    if (typeof riesgo === 'function') {
      lista.forEach(function (g) { g[2] = riesgo(g[1], nivel, g[0]); });
      lista.sort(function (a, b) {
        var ra = a[2] == null ? -Infinity : a[2], rb = b[2] == null ? -Infinity : b[2];
        if (rb !== ra) return rb - ra;                       // peor primero
        return a[0].localeCompare(b[0], 'es', { numeric: true });
      });
      return lista;
    }
    return lista.sort(function (a, b) { return a[0].localeCompare(b[0], 'es', { numeric: true }); });
  }

  function acordeon(o) {
    var niveles = o.niveles || [];
    var etiquetas = o.etiquetas || niveles;
    /* COLAPSADO por defecto — sin excepciones (petición 2 del cliente). */
    var abrirDef = o.abrir || function () { return false; };

    function nodo(filas, nivel, rutaPadre) {
      if (nivel >= niveles.length) return o.hoja(filas, rutaPadre);
      var grupos = agrupar(filas, niveles[nivel], o.riesgo, nivel);
      return '<div class="acc acc-n' + nivel + '">' + grupos.map(function (g) {
        var clave = g[0], sub = g[1];
        var ruta = rutaPadre ? rutaPadre + ' ⟩ ' + clave : clave;
        var ab = abierto(o.id, ruta, abrirDef(nivel, clave, sub));
        return '<section class="acc-g" data-acc-ruta="' + esc(ruta) + '"' + (ab ? ' data-abierto="1"' : '') + '>' +
          '<h4 class="acc-h">' +
            '<button type="button" class="acc-t" aria-expanded="' + (ab ? 'true' : 'false') + '">' +
              chevron() +
              '<span class="acc-lv">' + esc(etiquetas[nivel] || niveles[nivel]) + '</span>' +
              '<span class="acc-k">' + esc(clave) + '</span>' +
              '<span class="acc-meta">' + (o.resumen ? o.resumen(nivel, clave, sub) : sub.length) + '</span>' +
            '</button>' +
          '</h4>' +
          '<div class="acc-b"><div class="acc-in">' + nodo(sub, nivel + 1, ruta) + '</div></div>' +
        '</section>';
      }).join('') + '</div>';
    }

    return '<div class="acc-root" data-acc-id="' + esc(o.id) + '">' +
      barraAcc(o) + nodo(o.filas || [], 0, '') + '</div>';
  }

  function barraAcc(o) {
    if (o.barra === false) return '';
    return '<div class="acc-bar">' +
      '<button type="button" class="acc-all" data-acc-all="1">Expandir todo</button>' +
      '<button type="button" class="acc-all" data-acc-all="0">Colapsar todo</button>' +
      (o.nota ? '<span class="acc-nota">' + o.nota + '</span>' : '') +
    '</div>';
  }

  /* Delegación de eventos: una sola vez por raíz. */
  function enlazar(root) {
    if (!root) return;
    root.querySelectorAll('.acc-root').forEach(function (r) {
      if (r.__accOk) return;
      r.__accOk = true;
      var id = r.getAttribute('data-acc-id');
      r.addEventListener('click', function (ev) {
        var todo = ev.target.closest('[data-acc-all]');
        if (todo) {
          var v = todo.getAttribute('data-acc-all') === '1';
          r.querySelectorAll('.acc-g').forEach(function (g) { fijar(id, g, v); });
          return;
        }
        var t = ev.target.closest('.acc-t');
        if (!t || !r.contains(t)) return;
        var g = t.closest('.acc-g');
        fijar(id, g, g.getAttribute('data-abierto') !== '1');
      });
    });
  }

  function fijar(id, g, v) {
    if (!g) return;
    if (v) g.setAttribute('data-abierto', '1'); else g.removeAttribute('data-abierto');
    var b = g.querySelector(':scope > .acc-h > .acc-t');
    if (b) b.setAttribute('aria-expanded', v ? 'true' : 'false');
    recordar(id, g.getAttribute('data-acc-ruta'), v);
  }

  /* =========================================================================
   * 1b. Agrupación de una <table> ya renderizada.
   *
   *   UIX.agruparTabla(tabla, {
   *     id: 'm4-ranking',
   *     niveles: ['udn','cliente'],       // lee data-udn / data-cliente en cada <tr>
   *     etiquetas: ['UDN','Cliente'],
   *     resumen: function(nivel, clave, trs){ return '…'; }
   *   })
   *
   * Las filas se ocultan/muestran con [hidden]; al abrir entran escalonadas
   * (opacidad + 4px), que en una tabla lee mejor que animar alturas de <tr>.
   * ======================================================================= */
  function agruparTabla(tabla, o) {
    if (!tabla) return;
    var tbody = tabla.tBodies[0];
    /* El testigo va en el <tbody>, no en la <table>: al re-renderizar el módulo
       reemplaza el tbody, así que un tbody nuevo vuelve a agruparse solo. */
    if (!tbody || tbody.__accOk) return;
    var niveles = o.niveles || [];
    if (!niveles.length) return;
    var etiquetas = o.etiquetas || niveles;
    var filas = Array.prototype.filter.call(tbody.rows, function (tr) {
      return !tr.hasAttribute('data-acc-fija');
    });
    if (filas.length < 2) return;
    var nCols = (tabla.tHead && tabla.tHead.rows[0]) ? tabla.tHead.rows[0].cells.length : (filas[0] ? filas[0].cells.length : 1);

    /* ¿la tabla trae de verdad los datos de agrupación? */
    var utiles = niveles.filter(function (n) {
      var vistos = {};
      filas.forEach(function (tr) { vistos[tr.getAttribute('data-' + n) || ''] = 1; });
      return !vistos[''] || Object.keys(vistos).length > 1;
    });
    if (!utiles.length) return;

    tbody.__accOk = true;
    tabla.classList.add('acc-tabla');
    var id = o.id || 'tabla';

    function pinta(lista, nivel, rutaPadre, frag) {
      if (nivel >= utiles.length) { lista.forEach(function (tr) { frag.appendChild(tr); }); return; }
      var clave = utiles[nivel];
      var mapa = new Map();
      lista.forEach(function (tr) {
        var k = tr.getAttribute('data-' + clave) || '— sin asignar —';
        if (!mapa.has(k)) mapa.set(k, []);
        mapa.get(k).push(tr);
      });
      var grupos = Array.from(mapa.entries());
      if (typeof o.riesgo === 'function') {
        grupos.forEach(function (g) { g[2] = o.riesgo(g[1], nivel, g[0]); });
        grupos.sort(function (a, b) {
          var ra = a[2] == null ? -Infinity : a[2], rb = b[2] == null ? -Infinity : b[2];
          if (rb !== ra) return rb - ra;                     // peor primero
          return a[0].localeCompare(b[0], 'es', { numeric: true });
        });
      } else {
        grupos.sort(function (a, b) { return a[0].localeCompare(b[0], 'es', { numeric: true }); });
      }
      grupos.forEach(function (g) {
          var ruta = rutaPadre ? rutaPadre + ' ⟩ ' + g[0] : g[0];
          /* COLAPSADO por defecto, en todos los niveles. */
          var ab = abierto(id, ruta, false);
          var trh = doc.createElement('tr');
          trh.className = 'acc-tr acc-tr-n' + nivel;
          trh.setAttribute('data-acc-ruta', ruta);
          trh.setAttribute('data-acc-nivel', String(nivel));
          if (ab) trh.setAttribute('data-abierto', '1');
          trh.innerHTML = '<th colspan="' + nCols + '" scope="colgroup">' +
            '<button type="button" class="acc-t" aria-expanded="' + (ab ? 'true' : 'false') + '">' +
              chevron() +
              '<span class="acc-lv">' + esc(etiquetas[nivel] || clave) + '</span>' +
              '<span class="acc-k">' + esc(g[0]) + '</span>' +
              '<span class="acc-meta">' + (o.resumen ? o.resumen(nivel, g[0], g[1]) : (g[1].length + ' filas')) + '</span>' +
            '</button></th>';
          frag.appendChild(trh);
          pinta(g[1], nivel + 1, ruta, frag);
        });
    }

    var frag = doc.createDocumentFragment();
    var fijas = Array.prototype.filter.call(tbody.rows, function (tr) { return tr.hasAttribute('data-acc-fija'); });
    pinta(filas, 0, '', frag);
    fijas.forEach(function (tr) { frag.appendChild(tr); });
    tbody.innerHTML = '';
    tbody.appendChild(frag);

    function aplica() {
      var pila = [];   // [{nivel, abierto}]
      Array.prototype.forEach.call(tbody.rows, function (tr) {
        if (tr.hasAttribute('data-acc-fija')) { tr.hidden = false; return; }
        var esCab = tr.classList.contains('acc-tr');
        if (esCab) {
          var n = +tr.getAttribute('data-acc-nivel');
          while (pila.length && pila[pila.length - 1].nivel >= n) pila.pop();
          var padreVisible = pila.every(function (p) { return p.abierto; });
          tr.hidden = !padreVisible;
          pila.push({ nivel: n, abierto: tr.getAttribute('data-abierto') === '1' });
        } else {
          tr.hidden = !pila.every(function (p) { return p.abierto; });
        }
      });
      /* entrada escalonada sólo de lo que acaba de aparecer */
      if (reducido()) return;
      var i = 0;
      Array.prototype.forEach.call(tbody.rows, function (tr) {
        if (tr.hidden || tr.__vista) return;
        tr.__vista = true;
        tr.style.setProperty('--acc-i', String(Math.min(i++, 14)));
        tr.classList.add('acc-entra');
        tr.addEventListener('animationend', function () {
          tr.classList.remove('acc-entra'); tr.style.removeProperty('--acc-i');
        }, { once: true });
      });
    }

    tbody.addEventListener('click', function (ev) {
      var t = ev.target.closest('.acc-t');
      if (!t) return;
      var tr = t.closest('.acc-tr');
      var v = tr.getAttribute('data-abierto') !== '1';
      if (v) tr.setAttribute('data-abierto', '1'); else tr.removeAttribute('data-abierto');
      t.setAttribute('aria-expanded', v ? 'true' : 'false');
      recordar(id, tr.getAttribute('data-acc-ruta'), v);
      if (!v) {  /* al cerrar, olvidar el "ya visto" para que reaparezca escalonado */
        Array.prototype.forEach.call(tbody.rows, function (r) { r.__vista = r.hidden ? r.__vista : r.__vista; });
      }
      aplica();
    });

    Array.prototype.forEach.call(tbody.rows, function (tr) { tr.__vista = true; });
    aplica();
  }

  /* ============================================================ 2. movimiento */
  /* Reinicia la animación escalonada de entrada de un contenedor de cards. */
  function stagger(el) {
    if (!el || reducido()) return;
    el.classList.remove('stagger');
    void el.offsetWidth;          // fuerza reflow para reiniciar la animación
    el.classList.add('stagger');
  }

  /* Entrada escalonada de los BLOQUES de un módulo (paneles, rejillas,
   * tablas). Se llama tras cada render — cambio de pestaña y cambio de
   * filtro pasan los dos por ahí. Además siembra la cascada corta en toda
   * rejilla de KPIs que el módulo haya pintado dentro, para que las cards
   * no aparezcan de golpe mientras su bloque contenedor sí se escalona.
   *
   * Decorativa por contrato: el contenido ya está en el DOM y es clicable
   * desde el primer fotograma; los delays sólo retrasan opacidad/transform. */
  function entrada(el) {
    if (!el || reducido()) return;
    el.classList.remove('uix-entra');
    void el.offsetWidth;
    el.classList.add('uix-entra');
    var rejillas = el.querySelectorAll('.pn-kpis,.cf-kpis,.m3op-kpis,.m4-ukpis,.cb-tiles,.m1-kpis,.tiles');
    for (var i = 0; i < rejillas.length; i++) stagger(rejillas[i]);
  }

  /* =========================================================================
   * 4. GRÁFICAS EXPANDIBLES  (petición 1 del cliente)
   *
   *   <section class="pn-card" data-graf="Tendencia por semana">
   *     <header …>…</header>
   *     <div data-graf-lienzo> …svg… </div>
   *   </section>
   *
   *   UIX.registrarGrafica(section, function (w, h, expandido) {
   *     lienzo.innerHTML = svgTendencia(…, w, h);       // se REGENERA
   *   });
   *
   * Al expandir, el <section> se MUEVE (no se clona) a un diálogo a pantalla
   * casi completa dejando un hueco de la misma altura en su sitio: los
   * listeners, el estado interno del módulo y los filtros siguen intactos.
   * Al cerrar vuelve exactamente a donde estaba. Esc y clic fuera cierran,
   * el foco queda atrapado dentro mientras está abierto y regresa al botón.
   * ======================================================================= */
  var SVG_EXPANDIR =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path class="dash-icon-main" d="M4 9V4h5M20 15v5h-5" stroke-width="2.1"/>' +
    '<path class="dash-icon-accent" d="M15 4h5v5M9 20H4v-5" stroke-width="2.1"/></svg>';
  var SVG_CONTRAER =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path class="dash-icon-main" d="M9 4v5H4M15 20v-5h5" stroke-width="2.1"/>' +
    '<path class="dash-icon-accent" d="M20 9h-5V4M4 15h5v5" stroke-width="2.1"/></svg>';

  var gx = { abierto: null, hueco: null, ctx: null, foco: null, capa: null, cuerpo: null, titulo: null };

  function lienzoDe(host) { return host.querySelector('[data-graf-lienzo]') || host; }

  /* Mide el lienzo y avisa al módulo para que REGENERE su SVG a ese tamaño. */
  function redibujar(host) {
    if (!host) return;
    var l = lienzoDe(host);
    var exp = host === gx.abierto;
    var w = Math.max(240, Math.round(l.clientWidth || host.clientWidth || 0));
    /* En reposo NO se impone alto: el lienzo no tiene altura propia y medirla
       realimentaría la proporción del dibujo anterior (una gráfica que crece
       un poco cada vez que la expandes y la cierras). Se manda 0 y cada módulo
       cae a su alto de diseño; el ancho sí es el real de la columna. */
    var h = exp ? Math.max(140, Math.round(l.clientHeight || 0)) : 0;
    if (typeof host.__redibujar === 'function') {
      try { host.__redibujar(w, h, exp); } catch (e) { console.error('[UIX] redibujar', e); }
    }
    try {
      host.dispatchEvent(new CustomEvent('uix:redibujar', { detail: { ancho: w, alto: h, expandido: exp } }));
    } catch (e) { /* navegadores muy viejos */ }
  }

  function registrarGrafica(host, fn) {
    if (!host) return;
    if (typeof fn === 'function') host.__redibujar = fn;
    if (!host.hasAttribute('data-graf')) host.setAttribute('data-graf', host.getAttribute('aria-label') || 'Gráfica');
    inyectarBoton(host);
  }

  function tituloDe(host) {
    var t = host.getAttribute('data-graf');
    if (t && t !== '1' && t !== 'true') return t;
    var h = host.querySelector('h2,h3,h4,.pn-tag,.cb-tag,.m4-tag');
    return h ? h.textContent.trim() : 'Gráfica';
  }

  function inyectarBoton(host) {
    if (!host || host.__gxBtn) return;
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'gx-btn';
    b.innerHTML = SVG_EXPANDIR;
    b.title = 'Expandir a primer plano';
    b.setAttribute('aria-label', 'Expandir «' + tituloDe(host) + '» a primer plano');
    b.addEventListener('click', function (ev) { ev.stopPropagation(); expandir(host); });
    host.classList.add('gx-host');
    host.appendChild(b);
    host.__gxBtn = b;
  }

  /* Inyecta el botón en todo [data-graf] del subárbol. Idempotente. */
  function graficas(raiz) {
    if (!raiz) return;
    if (raiz.nodeType === 1 && raiz.hasAttribute && raiz.hasAttribute('data-graf')) inyectarBoton(raiz);
    raiz.querySelectorAll('[data-graf]').forEach(inyectarBoton);
  }

  function capa() {
    if (gx.capa) return gx.capa;
    var c = doc.createElement('div');
    c.className = 'gx-scrim';
    c.setAttribute('role', 'dialog');
    c.setAttribute('aria-modal', 'true');
    c.hidden = true;
    c.innerHTML =
      '<div class="gx-win">' +
        '<header class="gx-win-h">' +
          '<h2 class="gx-win-t" id="gx-win-t"></h2>' +
          '<button type="button" class="gx-close" aria-label="Cerrar y volver al tamaño normal · Esc">' +
            SVG_CONTRAER + '<span>Cerrar</span></button>' +
        '</header>' +
        '<div class="gx-win-b"></div>' +
      '</div>';
    c.setAttribute('aria-labelledby', 'gx-win-t');
    doc.body.appendChild(c);
    gx.capa = c;
    gx.cuerpo = c.querySelector('.gx-win-b');
    gx.titulo = c.querySelector('.gx-win-t');
    c.addEventListener('mousedown', function (ev) { if (ev.target === c) cerrar(); });
    c.querySelector('.gx-close').addEventListener('click', cerrar);
    return c;
  }

  function focoables(raiz) {
    return Array.prototype.filter.call(
      raiz.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null || el === doc.activeElement; });
  }

  function alTeclado(ev) {
    if (!gx.abierto) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cerrar(); return; }
    if (ev.key !== 'Tab') return;
    var f = focoables(gx.capa);
    if (!f.length) { ev.preventDefault(); return; }
    var pri = f[0], ult = f[f.length - 1];
    if (ev.shiftKey && doc.activeElement === pri) { ev.preventDefault(); ult.focus(); }
    else if (!ev.shiftKey && doc.activeElement === ult) { ev.preventDefault(); pri.focus(); }
    else if (!gx.capa.contains(doc.activeElement)) { ev.preventDefault(); pri.focus(); }
  }

  /* Réplica de la cadena de ancestros (clases + data-*) dentro del diálogo.
   * Sin esto, mover la card fuera de `.pn-mod` / `[data-modulo]` le quita de
   * golpe todas las custom properties y los selectores descendientes del
   * módulo: las barras salen negras y los tokens de color se pierden.
   * Las réplicas llevan display:contents, así que no añaden ninguna caja. */
  function replicarContexto(host) {
    var cadena = [], p = host.parentNode;
    while (p && p.nodeType === 1 && p !== doc.body) { cadena.unshift(p); p = p.parentNode; }
    var raiz = null, actual = null;
    cadena.forEach(function (el) {
      var d = doc.createElement('div');
      if (el.className && typeof el.className === 'string') d.className = el.className;
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        if (a.name.indexOf('data-') === 0) d.setAttribute(a.name, a.value);
      }
      d.classList.add('gx-ctx');
      if (actual) actual.appendChild(d); else raiz = d;
      actual = d;
    });
    return { raiz: raiz, hoja: actual };
  }

  function expandir(host) {
    if (!host || gx.abierto) return;
    capa();
    gx.foco = doc.activeElement;
    gx.abierto = host;

    /* hueco de la MISMA altura: la página de atrás no salta ni pierde el scroll */
    var hueco = doc.createElement('div');
    hueco.className = 'gx-hueco';
    hueco.style.height = host.offsetHeight + 'px';
    var ctx = replicarContexto(host);
    host.parentNode.insertBefore(hueco, host);
    gx.hueco = hueco;
    gx.ctx = ctx.raiz;

    gx.titulo.textContent = tituloDe(host);
    if (ctx.raiz) { gx.cuerpo.appendChild(ctx.raiz); ctx.hoja.appendChild(host); }
    else gx.cuerpo.appendChild(host);
    host.classList.add('gx-abierto');
    if (host.__gxBtn) {
      host.__gxBtn.innerHTML = SVG_CONTRAER;
      host.__gxBtn.title = 'Volver al tamaño normal · Esc';
      host.__gxBtn.setAttribute('aria-label', 'Volver «' + tituloDe(host) + '» al tamaño normal');
      host.__gxBtn.onclick = null;
    }
    gx.capa.hidden = false;
    doc.body.classList.add('gx-lock');
    doc.addEventListener('keydown', alTeclado, true);
    global.addEventListener('resize', alRedimensionar);

    /* dos frames: el primero aplica el layout del diálogo, el segundo ya mide bien */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        redibujar(host);
        var f = focoables(gx.capa);
        (gx.capa.querySelector('.gx-close') || f[0]).focus();
      });
    });
  }

  function cerrar() {
    var host = gx.abierto;
    if (!host) return;
    gx.abierto = null;
    doc.removeEventListener('keydown', alTeclado, true);
    global.removeEventListener('resize', alRedimensionar);
    host.classList.remove('gx-abierto');
    if (gx.hueco && gx.hueco.parentNode) {
      gx.hueco.parentNode.insertBefore(host, gx.hueco);
      gx.hueco.parentNode.removeChild(gx.hueco);
    }
    if (gx.ctx && gx.ctx.parentNode) gx.ctx.parentNode.removeChild(gx.ctx);
    gx.hueco = null; gx.ctx = null;
    gx.capa.hidden = true;
    doc.body.classList.remove('gx-lock');
    if (host.__gxBtn) {
      host.__gxBtn.innerHTML = SVG_EXPANDIR;
      host.__gxBtn.title = 'Expandir a primer plano';
      host.__gxBtn.setAttribute('aria-label', 'Expandir «' + tituloDe(host) + '» a primer plano');
      host.__gxBtn.onclick = function (ev) { ev.stopPropagation(); expandir(host); };
    }
    requestAnimationFrame(function () { redibujar(host); });
    var volver = gx.foco && gx.foco.isConnected ? gx.foco : host.__gxBtn;
    if (volver && volver.focus) volver.focus();
    gx.foco = null;
  }

  var tRz;
  function alRedimensionar() {
    clearTimeout(tRz);
    tRz = setTimeout(function () { if (gx.abierto) redibujar(gx.abierto); }, 120);
  }

  /* Si el módulo se re-renderiza mientras hay una gráfica expandida, el nodo
     expandido deja de estar en el documento: hay que cerrar para no dejar el
     diálogo huérfano. */
  function comprobarHuerfano() {
    if (gx.abierto && gx.hueco && !gx.hueco.isConnected) {
      var h = gx.abierto;
      gx.abierto = null; gx.hueco = null;
      doc.removeEventListener('keydown', alTeclado, true);
      global.removeEventListener('resize', alRedimensionar);
      h.classList.remove('gx-abierto');
      if (gx.ctx && gx.ctx.parentNode) gx.ctx.parentNode.removeChild(gx.ctx);
      else if (h.parentNode) h.parentNode.removeChild(h);
      gx.ctx = null;
      gx.capa.hidden = true;
      doc.body.classList.remove('gx-lock');
    }
  }

  global.UIX = {
    acordeon: acordeon,
    enlazar: enlazar,
    agruparTabla: agruparTabla,
    abierto: abierto,
    recordar: recordar,
    olvidar: olvidar,
    stagger: stagger,
    entrada: entrada,
    reducido: reducido,
    esc: esc,
    /* gráficas expandibles */
    graficas: graficas,
    registrarGrafica: registrarGrafica,
    redibujar: redibujar,
    expandir: expandir,
    cerrarExpandida: cerrar,
    _comprobarHuerfano: comprobarHuerfano
  };
})(window, document);
