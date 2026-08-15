// reatribuir_eventos.mjs — Devuelve a cada OPERADOR los eventos que Traffilog dejó huérfanos.
//
// EL PROBLEMA — ASIMETRÍA DE RETENCIÓN EN LA API
// ----------------------------------------------
// Traffilog conserva el chofer en los VIAJES de forma indefinida, pero lo borra
// de los EVENTOS pasados ~30 días. Toda semana descargada fuera de esa ventana
// llega con sus eventos ya huérfanos: caen en "SIN OPERADOR" y, al no colgar de
// nadie, cualquier operador con horas y cero eventos imputados califica 95 por
// defecto. Los scores planos de 95 en semanas antiguas son ARTEFACTO de la
// retención, no conducta observada.
//
// El gradiente lo confirma: W01–W25, bajadas muy fuera de ventana, llegaron con
// el 100% de sus eventos de score huérfanos; W26, descargada justo a caballo del
// corte, quedó al 64%. Es la firma de una ventana de retención, no de un defecto
// de este pipeline.
//
// LA RECUPERACIÓN (inferencia, misma filosofía que el responsable de combustible)
// -----------------------------------------------------------------------------
// El evento huérfano trae fecha y unidad. Los viajes dicen QUIÉN manejó esa
// unidad ese día:
//   · 1 solo chofer ese unidad-día → atribución EXACTA        (76.4% de los eventos)
//   · varios choferes             → proporcional a sus horas  (17.8%)
//   · nadie con horas             → se queda en la unidad     ( 5.9%)
// Se re-atribuyen las 12 llaves del score Y las categorías extendidas (el Score
// de Operación sufría el mismo artefacto).
//
// DISEÑO: SIDECAR, como el de ralentí. No toca los semanales v3; escribe
// datos/historico/<semana>.reatrib.json y el portal lo fusiona al cargar
// (suma al operador, resta del "SIN OPERADOR" del mismo unidad-día).
// Borrar el sidecar deshace todo. Cada registro receptor queda marcado como
// inferido — esto mueve scores personales y no puede pasar por dato observado.
//
// Uso:  node connector/reatribuir_eventos.mjs            # todas las semanas
//       node connector/reatribuir_eventos.mjs --semana 2026-W20 --force

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { desempacar } from '../netlify/functions/lib/codec.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', 'datos', 'historico');
const K12 = ['AcAlto', 'AcMed', 'AcBajo', 'FrAlto', 'FrMed', 'FrBajo',
  'GirAlto', 'GirMed', 'GirBajo', 'VelAlto', 'VelMed', 'VelBajo'];
const MIN_H = 0.05;            // horas mínimas para contar como "manejó la unidad"

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const FORCE = args.includes('--force');
const solo = arg('semana');

const esSinOp = (r) => !r.driver_id || /^SIN OPERADOR/.test(r.conductor || '');

/** Reparte `n` enteros entre pesos, conservando el total (mayor residuo). */
function repartir(n, pesos) {
  const total = pesos.reduce((a, b) => a + b, 0) || 1;
  const crudos = pesos.map(p => n * p / total);
  const bases = crudos.map(Math.floor);
  let falta = n - bases.reduce((a, b) => a + b, 0);
  const orden = crudos.map((c, i) => [c - bases[i], i]).sort((a, b) => b[0] - a[0]);
  for (let j = 0; j < falta; j++) bases[orden[j % orden.length][1]]++;
  return bases;
}

let semanas = readdirSync(DIR).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).map(f => f.slice(0, 8)).sort();
if (solo) semanas = semanas.filter(s => s === solo);

let totalMovidos = 0;
for (const sem of semanas) {
  const destino = join(DIR, sem + '.reatrib.json');
  if (existsSync(destino) && !FORCE) { console.log(sem + ' · ya re-atribuida'); continue; }
  const regs = desempacar(JSON.parse(readFileSync(join(DIR, sem + '.json'), 'utf8')));

  /* choferes con horas por unidad-día */
  const ud = new Map();   // fecha|vehicle -> [{driver_id, horas}]
  for (const r of regs) {
    if (esSinOp(r) || (r.horas || 0) < MIN_H) continue;
    const k = r.fecha + '|' + r.vehicle_id;
    (ud.get(k) || ud.set(k, []).get(k)).push({ driver_id: r.driver_id, horas: r.horas });
  }

  /* huérfanos → deltas por receptor */
  const deltas = new Map();  // fecha|driver|vehicle -> {ev:{}, ext:{}}
  let movidos = 0, imposibles = 0, exactos = 0, proporcionales = 0;
  const suma = (key, tipo, nombre, n) => {
    if (!n) return;
    let d = deltas.get(key);
    if (!d) deltas.set(key, d = { ev: {}, ext: {} });
    d[tipo][nombre] = (d[tipo][nombre] || 0) + n;
  };
  for (const r of regs) {
    if (!esSinOp(r)) continue;
    const choferes = ud.get(r.fecha + '|' + r.vehicle_id);
    const pares = [];
    for (const k of K12) if (r.eventos?.[k]) pares.push(['ev', k, r.eventos[k]]);
    for (const k in (r.extendido || {})) if (r.extendido[k]) pares.push(['ext', k, r.extendido[k]]);
    if (!pares.length) continue;
    if (!choferes || !choferes.length) { imposibles += pares.reduce((a, p) => a + p[2], 0); continue; }
    if (choferes.length === 1) {
      const key = r.fecha + '|' + choferes[0].driver_id + '|' + r.vehicle_id;
      for (const [tipo, nombre, n] of pares) suma(key, tipo, nombre, n);
      const n = pares.reduce((a, p) => a + p[2], 0); movidos += n; exactos += n;
    } else {
      const pesos = choferes.map(c => c.horas);
      for (const [tipo, nombre, n] of pares) {
        const partes = repartir(n, pesos);
        choferes.forEach((c, i) => suma(r.fecha + '|' + c.driver_id + '|' + r.vehicle_id, tipo, nombre, partes[i]));
        movidos += n; proporcionales += n;
      }
    }
  }

  const filas = [...deltas.entries()].map(([k, d]) => [k, d.ev, d.ext]);
  writeFileSync(destino, JSON.stringify({
    _doc: 'Eventos re-atribuidos por inferencia unidad-día (la API borra el chofer de los eventos ' +
          '~30 días atrás; los viajes sí lo conservan). El portal SUMA al operador y RESTA del ' +
          '"SIN OPERADOR" del mismo unidad-día. Todo receptor queda marcado como inferido.',
    semana: sem, generado: new Date().toISOString(),
    metodo: { exactos, proporcionales, imposibles },
    filas,
  }));
  totalMovidos += movidos;
  console.log(sem + ' · ' + movidos.toLocaleString('es-MX') + ' eventos re-atribuidos (' +
    exactos.toLocaleString('es-MX') + ' exactos · ' + proporcionales.toLocaleString('es-MX') +
    ' proporcionales · ' + imposibles.toLocaleString('es-MX') + ' imposibles) → ' + filas.length + ' receptores');
}
console.log('\n✓ total re-atribuido: ' + totalMovidos.toLocaleString('es-MX') + ' eventos');
