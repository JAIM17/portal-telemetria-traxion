/* ============================================================================
 * ICONOS — registro único de los iconos SVG de dos tonos del portal (DASHTRAX).
 *
 * Lenguaje visual (el que ya vivía disperso en index.html y en los módulos):
 *   .dash-icon-main    trazo estructural  -> var(--muted) / var(--tile-muted)
 *   .dash-icon-accent  trazo de acento    -> var(--ic-accent) (lima por defecto)
 * Ambos se pintan desde CSS, así que el mismo path sirve en claro y en oscuro,
 * dentro de una card KPI gris o sobre el panel.
 *
 * Regla del proyecto: CERO emojis y CERO iconos de librería. Todo icono del
 * portal sale de aquí. Si falta uno, se añade aquí — nunca en el módulo.
 *
 * API
 *   ICONOS.path(nombre)                 -> string con los <path>/<circle> internos
 *   ICONOS.svg(nombre, {size, extra})   -> '<svg …>…</svg>' suelto
 *   ICONOS.ic(nombre, {accent, cls})    -> '<span class="ic"><svg …></span>'  (envoltorio estándar)
 *   ICONOS.tiene(nombre)                -> bool
 *   ICONOS.lista()                      -> nombres disponibles
 *
 * Los módulos que ya tenían su propio objeto ICONOS lo mantienen como alias
 * local, pero resolviendo contra este registro (ver ICONOS.alias).
 * ========================================================================== */
(function (global) {
  'use strict';

  var P = {
    /* ---------- flota y personas ---------- */
    operadores: '<circle class="dash-icon-main" cx="9" cy="8" r="3" stroke-width="2"/><path class="dash-icon-main" d="M4.6 19c.9-3.3 2.3-5 4.4-5s3.5 1.7 4.4 5" stroke-width="2"/><path class="dash-icon-accent" d="M16.5 8H20M16.5 12H20M16.5 16H20" stroke-width="2.2"/>',
    operador: '<circle class="dash-icon-main" cx="12" cy="8" r="3.4" stroke-width="2"/><path class="dash-icon-accent" d="M5.4 20c1.1-3.9 3.2-5.8 6.6-5.8s5.5 1.9 6.6 5.8" stroke-width="2.2"/>',
    unidades: '<path class="dash-icon-main" d="M2.6 15.4V7.6h10.2v7.8" stroke-width="2"/><path class="dash-icon-main" d="M12.8 10.2h3.7l3.6 3.1v2.1" stroke-width="2"/><path class="dash-icon-main" d="M2.6 15.4h1.5M9.4 15.4h4.6M18.9 15.4h2.2" stroke-width="2"/><circle class="dash-icon-accent" cx="6.7" cy="16.6" r="1.9" stroke-width="2.1"/><circle class="dash-icon-accent" cx="16.6" cy="16.6" r="1.9" stroke-width="2.1"/>',
    unidad: '<path class="dash-icon-main" d="M2.8 16.2V7.5h10.4v8.7" stroke-width="2"/><path class="dash-icon-accent" d="M13.2 10.2h3.6l3.4 3.4v2.6h-7z" stroke-width="2"/><circle class="dash-icon-main" cx="7" cy="17.4" r="1.9" stroke-width="2"/><circle class="dash-icon-main" cx="17" cy="17.4" r="1.9" stroke-width="2"/>',

    /* ---------- seguridad y eventos ---------- */
    eventos: '<path class="dash-icon-main" d="M12 4.2l8.4 14.6H3.6L12 4.2z" stroke-width="2"/><path class="dash-icon-accent" d="M12 10v3.4" stroke-width="2.4"/><path class="dash-icon-accent" d="M12 16.3v.02" stroke-width="2.8"/>',
    critico: '<path class="dash-icon-main" d="M12 4.2l8.4 14.6H3.6L12 4.2z" stroke-width="2"/><path class="dash-icon-accent" d="M12 10v3.4" stroke-width="2.4"/><path class="dash-icon-accent" d="M12 16.3v.02" stroke-width="2.8"/>',
    alto: '<circle class="dash-icon-main" cx="12" cy="12" r="8" stroke-width="2"/><path class="dash-icon-accent" d="M12 8v4.6" stroke-width="2.4"/><path class="dash-icon-accent" d="M12 15.6v.02" stroke-width="2.8"/>',
    medio: '<path class="dash-icon-main" d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" stroke-width="2"/><circle class="dash-icon-accent" cx="12" cy="12" r="2.6" stroke-width="2.2"/>',
    escudo: '<path class="dash-icon-main" d="M12 3.2l7 2.6v5.4c0 4.3-3 7.6-7 9.6-4-2-7-5.3-7-9.6V5.8l7-2.6z" stroke-width="2"/><path class="dash-icon-accent" d="M8.8 11.9l2.2 2.2 4.2-4.4" stroke-width="2.3"/>',
    aceleracion: '<path class="dash-icon-main" d="M4.2 18.6a8.4 8.4 0 1115.6 0" stroke-width="2"/><path class="dash-icon-accent" d="M12 14.4l4.4-5" stroke-width="2.4"/><circle class="dash-icon-accent" cx="12" cy="15.2" r="1.3" stroke-width="1.8"/>',
    freno: '<circle class="dash-icon-main" cx="12" cy="12" r="8" stroke-width="2"/><path class="dash-icon-accent" d="M8.6 9.2h2.6a1.9 1.9 0 010 3.8H8.6V9.2zm0 3.8V15" stroke-width="2.1"/><path class="dash-icon-accent" d="M13.4 15V9.2h2.3" stroke-width="2.1"/>',
    giro: '<path class="dash-icon-main" d="M6 19V11a4.4 4.4 0 014.4-4.4h6.2" stroke-width="2"/><path class="dash-icon-accent" d="M14.2 3.8L17.6 6.6 14.2 9.4" stroke-width="2.3"/>',
    velocidad: '<path class="dash-icon-main" d="M3.8 17.4a8.6 8.6 0 1116.4 0" stroke-width="2"/><path class="dash-icon-accent" d="M12 16.2l5-6.6" stroke-width="2.4"/><path class="dash-icon-main" d="M3.8 17.4h3M17.2 17.4h3" stroke-width="2"/>',

    /* ---------- tiempo, carga y fatiga ---------- */
    horas: '<circle class="dash-icon-main" cx="12" cy="13" r="7" stroke-width="2"/><path class="dash-icon-main" d="M9 3.5h6" stroke-width="2"/><path class="dash-icon-accent" d="M12 9.6V13l2.4 1.6" stroke-width="2.2"/>',
    reloj: '<circle class="dash-icon-main" cx="12" cy="12" r="8" stroke-width="2"/><path class="dash-icon-accent" d="M12 7.4V12l3 1.9" stroke-width="2.2"/>',
    evhora: '<circle class="dash-icon-main" cx="12" cy="12" r="8" stroke-width="2"/><path class="dash-icon-accent" d="M12 7.4V12l3 1.9" stroke-width="2.2"/>',
    calendario: '<rect class="dash-icon-main" x="4" y="5.5" width="16" height="14.5" rx="2.2" stroke-width="2"/><path class="dash-icon-main" d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke-width="2"/><path class="dash-icon-accent" d="M8 14h3.4M8 17h6.4" stroke-width="2.4"/>',
    dias: '<rect class="dash-icon-main" x="4" y="5.5" width="16" height="14.5" rx="2.2" stroke-width="2"/><path class="dash-icon-main" d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke-width="2"/><path class="dash-icon-accent" d="M8.5 14h3.5" stroke-width="2.4"/>',
    racha: '<path class="dash-icon-main" d="M3.5 19.5h4v-4h4v-4h4v-4h4.5" stroke-width="2"/><path class="dash-icon-accent" d="M17.4 5.2l2.6 2.3-2.6 2.4" stroke-width="2.2"/>',
    fatiga: '<path class="dash-icon-main" d="M4 17.5v-5.2a2 2 0 012-2h12a2 2 0 012 2v5.2" stroke-width="2"/><path class="dash-icon-main" d="M4 17.5h16" stroke-width="2"/><path class="dash-icon-accent" d="M7.5 10.3V8.2a1.6 1.6 0 011.6-1.6h5.8A1.6 1.6 0 0116.5 8.2v2.1" stroke-width="2.2"/>',
    descanso: '<path class="dash-icon-main" d="M4 17.5v-5.2a2 2 0 012-2h12a2 2 0 012 2v5.2" stroke-width="2"/><path class="dash-icon-main" d="M4 17.5h16" stroke-width="2"/><path class="dash-icon-accent" d="M7.5 10.3V8.2a1.6 1.6 0 011.6-1.6h5.8A1.6 1.6 0 0116.5 8.2v2.1" stroke-width="2.2"/>',

    /* ---------- recorrido ---------- */
    km: '<path class="dash-icon-main" d="M4.5 19.5c3.4 0 3.4-5.4 6.8-5.4s3.4 5.4 6.8 5.4" stroke-width="2"/><path class="dash-icon-accent" d="M12 3.4c2.1 0 3.8 1.7 3.8 3.8 0 2.8-3.8 6.4-3.8 6.4S8.2 10 8.2 7.2C8.2 5.1 9.9 3.4 12 3.4z" stroke-width="2.1"/><circle class="dash-icon-accent" cx="12" cy="7.2" r="1.2" stroke-width="1.8"/>',
    distancia: '<path class="dash-icon-main" d="M4 16a8 8 0 0116 0" stroke-width="2"/><path class="dash-icon-main" d="M4 16h1.4M18.6 16H20M12 7.4v1.2" stroke-width="2"/><path class="dash-icon-accent" d="M12 16l3.4-3.8" stroke-width="2.3"/>',
    ev10km: '<path class="dash-icon-main" d="M7.5 20L9.8 4M16.5 20L14.2 4" stroke-width="2"/><path class="dash-icon-accent" d="M12 8v.02M12 12v.02M12 16v.02" stroke-width="2.6"/>',
    viajes: '<path class="dash-icon-main" d="M6.5 18.5c0-3.2 3-3.2 5.5-5.5s2.5-5.5 5.5-5.5" stroke-width="2"/><circle class="dash-icon-accent" cx="6.5" cy="18.5" r="2" stroke-width="2"/><circle class="dash-icon-accent" cx="17.5" cy="7.5" r="2" stroke-width="2"/>',

    /* ---------- motor y mantenimiento ---------- */
    motor: '<path class="dash-icon-main" d="M4 15.6V9.9h3.1V8.1h4.4v1.8h3l2.4 2.6H20v3.1h-2.5" stroke-width="2"/><path class="dash-icon-main" d="M4 15.6h13.5" stroke-width="2"/><path class="dash-icon-accent" d="M8.6 5.4h4.6M10.9 5.4v2.7" stroke-width="2.2"/>',
    combustible: '<path class="dash-icon-main" d="M5 20.5V5.4a1.9 1.9 0 011.9-1.9h5.4a1.9 1.9 0 011.9 1.9V20.5" stroke-width="2"/><path class="dash-icon-main" d="M3.6 20.5h12.4" stroke-width="2"/><path class="dash-icon-accent" d="M14.2 8.4h2.4a1.8 1.8 0 011.8 1.8v5.4a1.6 1.6 0 003.2 0V9.2l-2.2-2.4" stroke-width="2.1"/>',
    diagnostico: '<path class="dash-icon-main" d="M3.4 12.4h4l2-4.6 3 9.4 2.2-5.4 1.6 2.8h4.4" stroke-width="2"/><circle class="dash-icon-accent" cx="18.6" cy="6" r="2.4" stroke-width="2.1"/>',
    llave: '<path class="dash-icon-main" d="M14.6 3.4a5.4 5.4 0 00-4.2 8.8L3.6 19v2h2l6.8-6.8a5.4 5.4 0 007-6.6l-3 3-2.4-2.4 3-3a5.4 5.4 0 00-2.4-1.8z" stroke-width="2"/><path class="dash-icon-accent" d="M6.2 18.2v.02" stroke-width="2.6"/>',

    /* ---------- analítica y comparación ---------- */
    semana: '<path class="dash-icon-main" d="M4 19V9.5M9.3 19V6M14.7 19v-8M20 19V4" stroke-width="2"/><path class="dash-icon-accent" d="M2.5 21.5h19" stroke-width="2.2"/>',
    tendencia: '<path class="dash-icon-main" d="M3.4 17.6l5.2-5.4 3.6 3.2 4.8-6.2" stroke-width="2"/><path class="dash-icon-accent" d="M13.6 8.4H18v4.4" stroke-width="2.2"/><path class="dash-icon-main" d="M3 21h18" stroke-width="2"/>',
    capas: '<path class="dash-icon-main" d="M12 3.6l8.2 4.2-8.2 4.2L3.8 7.8 12 3.6z" stroke-width="2"/><path class="dash-icon-accent" d="M3.8 12.2L12 16.4l8.2-4.2" stroke-width="2.2"/><path class="dash-icon-accent" d="M3.8 16.3L12 20.5l8.2-4.2" stroke-width="2.2"/>',
    balanza: '<path class="dash-icon-main" d="M12 4.4v15.2M7.4 19.6h9.2" stroke-width="2"/><path class="dash-icon-main" d="M4.2 7.4h15.6" stroke-width="2"/><path class="dash-icon-accent" d="M4.2 7.4L2 13.2h4.4L4.2 7.4zM19.8 7.4L17.6 13.2H22l-2.2-5.8z" stroke-width="2"/>',
    ranking: '<path class="dash-icon-main" d="M4 20.4V13h4.4v7.4M9.8 20.4V6.6h4.4v13.8M15.6 20.4V9.8H20v10.6" stroke-width="2"/><path class="dash-icon-accent" d="M2.6 20.4h18.8" stroke-width="2.3"/>',
    podio: '<path class="dash-icon-main" d="M8 4h8v4.6a4 4 0 01-8 0V4z" stroke-width="2"/><path class="dash-icon-accent" d="M8 5.6H5.6v1.5a3 3 0 003 3M16 5.6h2.4v1.5a3 3 0 01-3 3" stroke-width="2"/><path class="dash-icon-main" d="M9.6 20.4h4.8M12 13.4v7" stroke-width="2"/>',
    reconocer: '<path class="dash-icon-main" d="M8 4h8v5a4 4 0 01-8 0V4z" stroke-width="2"/><path class="dash-icon-accent" d="M8 5.5H5.5V7a3 3 0 003 3M16 5.5h2.5V7a3 3 0 01-3 3" stroke-width="2"/><path class="dash-icon-main" d="M9.5 20h5M12 13.2V20" stroke-width="2"/>',

    /* ---------- cerebro operativo ----------
     * El glifo de `cerebro` vive con los iconos de módulo, más abajo: es un
     * NODO DE DECISIÓN, no un cerebro literal (dibujar un cerebro para "motor
     * de reglas" es el cliché que este portal evita). */
    regla:'<path class="dash-icon-main" d="M4 9.5l5.5-5.5 10.5 10.5-5.5 5.5z" stroke-width="2"/><path class="dash-icon-accent" d="M8.4 8.2l1.6 1.6M11.2 11l1.6 1.6M14 13.8l1.6 1.6" stroke-width="2"/>',

    /* ---------- documentos y estado ---------- */
    ficha: '<path class="dash-icon-main" d="M6 3.2h8.4L19 7.6V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4.2a1 1 0 011-1z" stroke-width="2"/><path class="dash-icon-accent" d="M14 3.4v4.4h4.6M8.4 13h7.2M8.4 16.4h4.8" stroke-width="2"/>',
    exportar: '<path class="dash-icon-main" d="M12 3.4v11.2m0-11.2l-3.6 3.7M12 3.4l3.6 3.7" stroke-width="2"/><path class="dash-icon-accent" d="M4.4 14.6v4.2a1.6 1.6 0 001.6 1.6h12a1.6 1.6 0 001.6-1.6v-4.2" stroke-width="2"/>',
    tabla: '<rect class="dash-icon-main" x="3.4" y="4.6" width="17.2" height="14.8" rx="2" stroke-width="2"/><path class="dash-icon-main" d="M3.4 9.4h17.2" stroke-width="2"/><path class="dash-icon-accent" d="M9.4 9.4v10M15 9.4v10" stroke-width="2.1"/>',
    filtro: '<path class="dash-icon-main" d="M3.6 5.2h16.8l-6.5 7.6v6.4l-3.8 1.8v-8.2z" stroke-width="2"/><path class="dash-icon-accent" d="M8.6 5.2h6.8" stroke-width="2.4"/>',
    sinDatos: '<rect class="dash-icon-main" x="4" y="5" width="16" height="15" rx="2.2" stroke-width="2" stroke-dasharray="3.2 2.6"/><path class="dash-icon-accent" d="M10 10.6a2.1 2.1 0 113.1 1.8c-.7.4-1.1.9-1.1 1.7" stroke-width="2.1"/><path class="dash-icon-accent" d="M12 17.1v.02" stroke-width="2.6"/>',
    aviso: '<path class="dash-icon-main" d="M12 4.2l8.4 14.6H3.6L12 4.2z" stroke-width="2"/><path class="dash-icon-accent" d="M12 10v3.4" stroke-width="2.4"/><path class="dash-icon-accent" d="M12 16.3v.02" stroke-width="2.8"/>',
    reiniciar: '<path class="dash-icon-main" d="M20.4 12a8.4 8.4 0 11-2.8-6.2" stroke-width="2"/><path class="dash-icon-accent" d="M20.4 3.6v4.8h-4.8" stroke-width="2.3"/>',
    verificado: '<circle class="dash-icon-main" cx="12" cy="12" r="8.2" stroke-width="2"/><path class="dash-icon-accent" d="M8.2 12.3l2.7 2.7 4.9-5.4" stroke-width="2.4"/>',

    /* ---------- navegación / cronología ---------- */
    plegar: '<path class="dash-icon-main" d="M4 5.4v13.2" stroke-width="2"/><path class="dash-icon-accent" d="M20 12H9.4M13.4 7.6L9 12l4.4 4.4" stroke-width="2.2"/>',
    desplegar: '<path class="dash-icon-main" d="M20 5.4v13.2" stroke-width="2"/><path class="dash-icon-accent" d="M4 12h10.6M10.6 7.6L15 12l-4.4 4.4" stroke-width="2.2"/>',
    jerarquia: '<rect class="dash-icon-main" x="9" y="3.2" width="6" height="4.4" rx="1.2" stroke-width="2"/><rect class="dash-icon-accent" x="3" y="16.4" width="6" height="4.4" rx="1.2" stroke-width="2"/><rect class="dash-icon-accent" x="15" y="16.4" width="6" height="4.4" rx="1.2" stroke-width="2"/><path class="dash-icon-main" d="M12 7.6v4.8M6 16.4v-2.6h12v2.6" stroke-width="2"/>',

    /* ---------- MÓDULOS DEL PORTAL (pestañas de navegación) ----------------
     * Serie propia, no de librería. Reglas comunes para que se lean como un
     * sistema y no como ocho dibujos sueltos:
     *   · lienzo 24×24, todo dentro del margen 3…21
     *   · trazo 2 en la estructura (.dash-icon-main), 2.2 en el acento
     *   · el ACENTO es siempre "lo que el módulo mide": la lectura, el fallo,
     *     el pico, el primer puesto. La estructura es el contenedor.
     *   · sin relleno, sin curvas decorativas, extremos redondeados
     * -------------------------------------------------------------------- */

    /* PANORAMA — cuadrante de mando: cuatro campos, uno de ellos leído */
    panorama: '<rect class="dash-icon-main" x="3.2" y="4" width="17.6" height="16" rx="2.2" stroke-width="2"/><path class="dash-icon-main" d="M12 4v16M3.2 12h17.6" stroke-width="2"/><path class="dash-icon-accent" d="M6 16.4l2.6-3.1 2.2 1.9" stroke-width="2.2"/><path class="dash-icon-accent" d="M15.2 7.6h3.2v3.2" stroke-width="2.2"/>',

    /* EVALUACIÓN — ficha del operador con la marca de revisado */
    evaluacion: '<path class="dash-icon-main" d="M5.4 3.6h9.2l4 4V20a1.4 1.4 0 01-1.4 1.4H5.4A1.4 1.4 0 014 20V5a1.4 1.4 0 011.4-1.4z" stroke-width="2"/><path class="dash-icon-main" d="M14.2 3.8v4.2h4.4" stroke-width="2"/><path class="dash-icon-accent" d="M7.8 14.6l2.3 2.3 4.4-5" stroke-width="2.2"/>',

    /* SEGURIDAD — escudo con la lectura del score dentro */
    seguridad: '<path class="dash-icon-main" d="M12 3.2l7.2 2.7v5.5c0 4.4-3.1 7.8-7.2 9.8-4.1-2-7.2-5.4-7.2-9.8V5.9L12 3.2z" stroke-width="2"/><path class="dash-icon-accent" d="M8.4 13.2l2.3-2.6 1.9 1.7 2.9-3.4" stroke-width="2.2"/>',

    /* CARGAS · FATIGA — jornada acumulada: tres bloques crecientes y el tope */
    cargasFatiga: '<path class="dash-icon-main" d="M4 20.4V15M9.3 20.4v-8.6M14.7 20.4V8.6M20 20.4v-5" stroke-width="2"/><path class="dash-icon-accent" d="M2.6 5.2h18.8" stroke-width="2.2"/><path class="dash-icon-accent" d="M14.7 8.6V5.2" stroke-width="2.2"/>',

    /* OPERACIÓN — cuadro de instrumentos: arco medido con la aguja en zona */
    operacion: '<path class="dash-icon-main" d="M3.6 18.4a8.8 8.8 0 1116.8 0" stroke-width="2"/><path class="dash-icon-main" d="M3.6 18.4h2.6M17.8 18.4h2.6" stroke-width="2"/><path class="dash-icon-accent" d="M12 15.4l4.6-5.6" stroke-width="2.2"/><circle class="dash-icon-accent" cx="12" cy="16.4" r="1.5" stroke-width="1.9"/>',

    /* RANKINGS — orden de mérito: tres posiciones, la primera destacada */
    rankings: '<path class="dash-icon-main" d="M4 20.4V12.6h4.2v7.8M15.8 20.4v-5.6H20v5.6" stroke-width="2"/><path class="dash-icon-accent" d="M9.9 20.4V6.4h4.2v14" stroke-width="2.2"/><path class="dash-icon-main" d="M2.6 20.4h18.8" stroke-width="2"/>',

    /* CEREBRO OPERATIVO — nodo de decisión: entradas que convergen en un fallo */
    cerebro: '<circle class="dash-icon-main" cx="12" cy="12" r="3.2" stroke-width="2"/><path class="dash-icon-main" d="M12 3.4v5.4M12 15.2v5.4M3.4 12h5.4M15.2 12h5.4" stroke-width="2"/><circle class="dash-icon-accent" cx="12" cy="3.4" r="1.7" stroke-width="2.1"/><circle class="dash-icon-accent" cx="20.6" cy="12" r="1.7" stroke-width="2.1"/><circle class="dash-icon-accent" cx="12" cy="20.6" r="1.7" stroke-width="2.1"/><circle class="dash-icon-accent" cx="3.4" cy="12" r="1.7" stroke-width="2.1"/>',

    /* USUARIOS — cuentas del portal: persona y llave de permiso */
    usuarios: '<circle class="dash-icon-main" cx="9.6" cy="8.2" r="3.4" stroke-width="2"/><path class="dash-icon-main" d="M3.4 20c.9-4 3.2-6 6.2-6s5.3 2 6.2 6" stroke-width="2"/><circle class="dash-icon-accent" cx="17.6" cy="6.4" r="2.6" stroke-width="2.2"/><path class="dash-icon-accent" d="M17.6 9v4.4M17.6 11.4h2.2" stroke-width="2.2"/>',

    /* Afordancia de despliegue del acordeón. Monotono a propósito: es un
       control, no un símbolo — gira 90° con CSS al abrir el grupo. */
    chevron: '<path class="dash-icon-accent" d="M9.4 5.6L16 12l-6.6 6.4" stroke-width="2.4"/>',
    mas: '<path class="dash-icon-main" d="M12 5.4v13.2M5.4 12h13.2" stroke-width="2.2"/>',
    menos: '<path class="dash-icon-main" d="M5.4 12h13.2" stroke-width="2.2"/>'
  };

  /* nombres alternativos que ya usaban los módulos */
  var ALIAS = {
    trofeo: 'reconocer', premio: 'reconocer', cliente: 'capas', udn: 'jerarquia',
    grafica: 'semana', barras: 'semana', score: 'escudo', puntos: 'balanza',
    mantenimiento: 'llave', dtc: 'diagnostico', warning: 'aviso', check: 'verificado',
    reset: 'reiniciar', descargar: 'exportar', doc: 'ficha', flota: 'unidades'
  };

  function resolver(n) {
    if (P[n]) return n;
    if (ALIAS[n] && P[ALIAS[n]]) return ALIAS[n];
    return null;
  }

  var API = {
    path: function (n) { var k = resolver(n); return k ? P[k] : P.eventos; },
    tiene: function (n) { return !!resolver(n); },
    lista: function () { return Object.keys(P).sort(); },
    svg: function (n, o) {
      o = o || {};
      return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"' +
        (o.size ? ' width="' + o.size + '" height="' + o.size + '"' : '') +
        (o.extra ? ' ' + o.extra : '') + '>' + API.path(n) + '</svg>';
    },
    /* Envoltorio estándar. `cls` permite el prefijo del módulo (pn-ic, cf-ic…)
       manteniendo `ic` para que herede el CSS global de dos tonos. */
    ic: function (n, o) {
      o = o || {};
      return '<span class="ic' + (o.cls ? ' ' + o.cls : '') + '"' +
        (o.accent ? ' style="--ic-accent:' + o.accent + '"' : '') +
        (o.title ? ' title="' + o.title + '"' : '') + '>' + API.svg(n) + '</span>';
    },
    /* Devuelve un objeto {nombre: path} compatible con los ICONOS locales
       de los módulos, para que su código existente siga funcionando igual. */
    alias: function (mapa) {
      var out = {};
      Object.keys(mapa).forEach(function (k) { out[k] = API.path(mapa[k]); });
      return out;
    }
  };

  global.ICONOS = API;
})(typeof window !== 'undefined' ? window : this);
