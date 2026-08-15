/* ============================================================================
 * MÓDULO — ALERTAS DEL MONITOR VIVO (temperatura · pánico/robo)
 * ----------------------------------------------------------------------------
 * El concentrado histórico para tomar decisiones (petición del cliente
 * 2026-07-28). Dos fuentes fusionadas por event_id:
 *   · datos/historico/alertas_monitor.json — acumulado persistente que escribe
 *     el agente local (en producción se refresca con cada publicación).
 *   · /api/monitor-alertas — lo vivo (últimos ~200), local y producción.
 * Horas de Traffilog en UTC → se muestran en hora LOCAL del navegador.
 * Exporta el concentrado a Excel/CSV (SheetJS ya cargado en index.html).
 * ========================================================================== */
(function () {
  'use strict';
  window.MODULOS = window.MODULOS || {};
  var ID = 'alertas';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) { return (n == null || !isFinite(n)) ? '—' : Number(n).toLocaleString('es-MX'); }
  function ico(kind) {
    return window.ICONOS ? window.ICONOS.ic(kind, { cls: 'al-ic' }) : '<span class="ic al-ic"></span>';
  }
  function aLocal(s) {
    if (!s) return null;
    var d = new Date(/[Zz]$|[+\-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
    return isNaN(d) ? null : d;
  }
  function soloHora(s) {
    var d = aLocal(s);
    return d ? d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : (s || '—');
  }
  function horaLocal(s) {
    var d = aLocal(s);
    return d ? d.toLocaleString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : (s || '—');
  }

  var ui = { tipo: '', abiertos: null };   // filtro por tipo ('' = todas) · días desplegados

  /* Día LOCAL de una alerta (Traffilog manda UTC). Es la llave de agrupación. */
  function diaDe(s) {
    var d = aLocal(s);
    return d ? d.toLocaleDateString('en-CA') : 'sin fecha';
  }
  function diaLargo(ymd) {
    var p = String(ymd).split('-');
    if (p.length !== 3) return ymd;
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var t = d.toLocaleDateString('es-MX', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  var CACHE = null;               // alertas fusionadas de la última carga

  function clave(a) { return a.id || (a.time + '|' + a.vehicle_id + '|' + a.evento); }

  async function cargar() {
    var porId = new Map();
    try {
      var r = await fetch('datos/historico/alertas_monitor.json?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) { var j = await r.json(); (j.alertas || []).forEach(function (a) { porId.set(clave(a), a); }); }
    } catch (e) {}
    try {
      var r2 = await fetch('/api/monitor-alertas', { cache: 'no-store' });
      if (r2.ok) { var m = await r2.json(); (m.alertas || []).forEach(function (a) { porId.set(clave(a), a); }); }
    } catch (e) {}
    var lista = [...porId.values()];
    lista.sort(function (x, y) { return (y.time || '') < (x.time || '') ? -1 : 1; });
    return lista;
  }

  function exportar(formato) {
    if (!CACHE || !CACHE.length) return alert('Sin alertas que exportar.');
    var filas = CACHE.map(function (a) {
      var d = aLocal(a.time);
      return {
        fecha_hora_local: d ? d.toLocaleString('es-MX', { hour12: false }) : a.time,
        fecha_hora_utc: a.time || '', tipo: a.tipo || '', evento: a.evento || '',
        severidad: a.severidad || '', unidad: a.placa || a.vehicle_id || '',
        conductor: a.conductor || '', spn: a.spn || '', fmi: a.fmi || '',
        latitud: a.lat || '', longitud: a.lng || '',
      };
    });
    var hoy = new Date().toISOString().slice(0, 10);
    if (formato === 'csv') {
      var cols = Object.keys(filas[0]);
      var csv = cols.join(',') + '\n' + filas.map(function (f) {
        return cols.map(function (c) { var v = String(f[c] == null ? '' : f[c]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
      }).join('\n');
      var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'alertas-monitor-' + hoy + '.csv'; a.click();
      URL.revokeObjectURL(a.href);
    } else {
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), 'Alertas');
      XLSX.writeFile(wb, 'alertas-monitor-' + hoy + '.xlsx');
    }
  }

  async function render(container) {
    container.innerHTML = '<div class="al-vacio">Cargando alertas…</div>';
    var todas = await cargar();
    CACHE = todas;
    var lista = ui.tipo ? todas.filter(function (a) { return a.tipo === ui.tipo; }) : todas;

    /* agregados para decidir */
    var porUnidad = {}, porOperador = {}, temp = 0, panico = 0;
    todas.forEach(function (a) {
      if (a.tipo === 'panico') panico++; else temp++;
      var u = a.placa || a.vehicle_id || '?';
      porUnidad[u] = (porUnidad[u] || 0) + 1;
      if (a.conductor) porOperador[a.conductor] = (porOperador[a.conductor] || 0) + 1;
    });
    var topU = Object.keys(porUnidad).sort(function (x, y) { return porUnidad[y] - porUnidad[x]; }).slice(0, 5);
    var topO = Object.keys(porOperador).sort(function (x, y) { return porOperador[y] - porOperador[x]; }).slice(0, 5);

    var h = '<section class="al-mod">';
    h += '<header class="al-head"><div class="al-title">' + ico('aviso') +
      '<h2>Alertas del monitor</h2>' +
      '<span class="al-sub mono">' + fmt(todas.length) + ' acumuladas · ' + fmt(temp) + ' temperatura · ' + fmt(panico) + ' pánico/robo</span></div>' +
      '<div class="al-acciones">' +
      '<button class="al-chip mono' + (ui.tipo === '' ? ' on' : '') + '" data-tipo="">Todas</button>' +
      '<button class="al-chip mono' + (ui.tipo === 'temperatura' ? ' on' : '') + '" data-tipo="temperatura">Temperatura</button>' +
      '<button class="al-chip mono' + (ui.tipo === 'panico' ? ' on' : '') + '" data-tipo="panico">Pánico</button>' +
      '<button class="al-btn mono" data-exp="xlsx">' + ico('descarga') + 'Excel</button>' +
      '<button class="al-btn mono ghost" data-exp="csv">CSV</button>' +
      '</div></header>';

    /* tarjetas de concentración: dónde repetir es señal de decisión */
    h += '<div class="al-tops">';
    h += '<div class="al-top"><div class="al-top-t">' + ico('camion') + 'Unidades más alertadas</div>' +
      (topU.length ? '<ol>' + topU.map(function (u) {
        return '<li><span>' + esc(u) + '</span><b class="mono">' + fmt(porUnidad[u]) + '</b></li>';
      }).join('') + '</ol>' : '<div class="al-vacio-mini">Sin datos.</div>') + '</div>';
    h += '<div class="al-top"><div class="al-top-t">' + ico('operadores') + 'Operadores más alertados</div>' +
      (topO.length ? '<ol>' + topO.map(function (o) {
        return '<li><span>' + esc(o) + '</span><b class="mono">' + fmt(porOperador[o]) + '</b></li>';
      }).join('') + '</ol>' : '<div class="al-vacio-mini">Sin datos.</div>') + '</div>';
    h += '</div>';

    if (!lista.length) h += '<div class="al-vacio">Sin alertas ' + (ui.tipo ? 'de ' + ui.tipo : 'acumuladas') +
      ' todavía.<small>El agente local guarda cada una en cuanto entra; el histórico crece solo.</small></div>';
    else {
      /* AGRUPADO POR DÍA (2026-08-08). Antes era una sola tabla de miles de filas
         con scroll infinito: imposible situarse. Ahora cada día es un panel
         plegable y solo el más reciente arranca abierto. */
      var porDia = {}, ordenDias = [];
      lista.forEach(function (a) {
        var d = diaDe(a.time);
        if (!porDia[d]) { porDia[d] = []; ordenDias.push(d); }
        porDia[d].push(a);
      });
      ordenDias.sort().reverse();
      if (ui.abiertos === null) ui.abiertos = ordenDias.length ? [ordenDias[0]] : [];

      h += '<div class="al-dias-barra mono">' +
        '<span>' + ordenDias.length + ' día(s) con alertas</span>' +
        '<button class="al-dia-todo" data-todo="abrir">Desplegar todo</button>' +
        '<button class="al-dia-todo" data-todo="cerrar">Plegar todo</button>' +
        '</div>';

      h += ordenDias.map(function (d) {
        var filas = porDia[d];
        var abierto = ui.abiertos.indexOf(d) >= 0;
        var nT = 0, nP = 0;
        filas.forEach(function (a) { if (a.tipo === 'panico') nP++; else nT++; });
        return '<section class="al-dia' + (abierto ? ' abierto' : '') + '">' +
          '<button type="button" class="al-dia-h" data-dia="' + esc(d) + '" aria-expanded="' + abierto + '">' +
            '<span class="al-dia-caret" aria-hidden="true">▸</span>' +
            '<b>' + esc(diaLargo(d)) + '</b>' +
            '<span class="al-dia-n mono">' + fmt(filas.length) + '</span>' +
            '<span class="al-dia-mix mono">' + fmt(nT) + ' temp · ' + fmt(nP) + ' pánico</span>' +
          '</button>' +
          (abierto ?
          '<div class="al-tabla-wrap"><table class="al-tabla"><thead><tr>' +
            '<th>Tipo</th><th>Hora (local)</th><th>Evento</th><th>Unidad</th><th>Conductor</th><th>Severidad</th><th>Ubicación</th>' +
            '</tr></thead><tbody>' +
            filas.map(function (a) {
              return '<tr>' +
                '<td><span class="al-tipo ' + (a.tipo === 'panico' ? 'panico' : 'temp') + '">' + (a.tipo === 'panico' ? 'PÁNICO' : 'TEMP') + '</span></td>' +
                '<td class="mono">' + esc(soloHora(a.time)) + '</td>' +
                '<td class="al-ev"><b>' + esc(a.evento) + '</b>' + (a.spn ? '<small>SPN ' + esc(a.spn) + (a.fmi ? ' · ' + esc(a.fmi) : '') + '</small>' : '') + '</td>' +
                '<td class="mono">' + esc(a.placa || a.vehicle_id || '—') + '</td>' +
                '<td>' + esc(a.conductor || '—') + '</td>' +
                '<td><span class="al-sev ' + esc(a.severidad || 'na') + '">' + esc(a.severidad || '—') + '</span></td>' +
                '<td>' + (a.lat && a.lng ? '<a href="https://maps.google.com/?q=' + esc(a.lat) + ',' + esc(a.lng) + '" target="_blank" rel="noopener">mapa</a>' : '—') + '</td>' +
                '</tr>';
            }).join('') + '</tbody></table></div>' : '') +
          '</section>';
      }).join('');
    }
    h += '<p class="al-nota mono">Fuente: monitor vivo (Traffilog, consulta cada 2 min desde el agente local). ' +
      'En producción el acumulado se refresca con cada publicación; lo más reciente llega en vivo vía el puente de nube.</p>';
    h += '</section>';
    container.innerHTML = h;

    container.querySelectorAll('.al-chip').forEach(function (b) {
      b.addEventListener('click', function () { ui.tipo = b.dataset.tipo; render(container); });
    });
    container.querySelectorAll('.al-dia-h').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = b.dataset.dia, i = ui.abiertos.indexOf(d);
        if (i >= 0) ui.abiertos.splice(i, 1); else ui.abiertos.push(d);
        render(container);
      });
    });
    container.querySelectorAll('.al-dia-todo').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.abiertos = b.dataset.todo === 'abrir'
          ? Array.prototype.map.call(container.querySelectorAll('.al-dia-h'), function (x) { return x.dataset.dia; })
          : [];
        render(container);
      });
    });
    container.querySelectorAll('.al-btn').forEach(function (b) {
      b.addEventListener('click', function () { exportar(b.dataset.exp); });
    });
  }

  window.MODULOS[ID] = { id: ID, titulo: 'Alertas', render: function (c) { render(c); } };
})();
