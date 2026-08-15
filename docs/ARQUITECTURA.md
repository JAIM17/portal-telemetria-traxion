# Arquitectura

Cómo funciona el Portal de Telemetría de punta a punta: de dónde sale el dato,
qué le pasa en el camino y cómo llega a la pantalla.

Para las fórmulas y umbrales de cada indicador, ver [`METRICAS.md`](METRICAS.md).

---

## 1. Qué es

Un portal web que convierte la telemetría cruda de la flota —la que genera el
proveedor **Traffilog**— en indicadores operativos accionables: score de
seguridad por operador, cargas de trabajo y fatiga, hábitos de conducción,
sospecha de sustracción de combustible, puntos negros de ruta y fichas
descargables por operador y por unidad.

**Alcance de la cuenta:** 945 unidades · 55 grupos · UDN Guadalajara, Colima y
Lázaro Cárdenas.

**Volumen:** ~7,900 registros y ~550,000 eventos por semana. 33 semanas de
histórico cargadas.

### La decisión de diseño que explica todo lo demás

La API de Traffilog es **lenta y tiene una ventana de retención de 30 días**
sobre la atribución de eventos a operadores. Descargar en vivo lo que el portal
necesita es inviable (una semana tarda ~70 minutos) y esperar es destructivo
(pasados 30 días el chofer del evento desaparece para siempre).

De ahí la arquitectura: **un archivo histórico propio, construido una vez y
mantenido a diario.** El portal no consulta la API; lee archivos estáticos. La
API sólo la toca el pipeline de ingesta, en horario controlado y con una sola
sesión a la vez.

Esto tiene tres consecuencias que se ven por todas partes en el código:

1. **El dato es "a día vencido".** El portal muestra hasta ayer, no hasta ahora.
2. **El pipeline diario no es opcional.** Cada día que no corre acerca una semana
   al borde de la ventana de retención.
3. **El histórico sólo crece.** Ninguna corrida puede reemplazar el archivo
   entero, sólo fusionar sobre él.

---

## 2. Vista general

```
   ┌──────────────────────────┐
   │  API REST Traffilog v4.3 │   api.traffilog.mx/clients/json
   └────────────┬─────────────┘
                │
      ┌─────────┴─────────┐
      │                   │
      ▼                   ▼
┌───────────────┐   ┌──────────────────────┐
│  PIPELINE     │   │  COLECTOR EN NUBE    │
│  (Mac local,  │   │  traffilog-cron      │
│   launchd)    │   │  cada hora           │
│               │   │                      │
│ 09:00 diario  │   │  → Netlify Blobs     │
└───────┬───────┘   └──────────┬───────────┘
        │                      │
        ▼                      ▼
┌────────────────┐      ┌──────────────┐
│ datos/historico│      │ /api/traffilog│
│ 33 × semana.json│     │ (snapshot v3) │
│ + rollups/     │      └──────────────┘
└───────┬────────┘             │
        │                      │ (hoy sólo lo usa
        │ publicar_semanas.sh  │  el monitor vivo)
        ▼                      │
┌─────────────────────────────────────────┐
│           NETLIFY (producción)          │
│  estático + funciones serverless        │
└────────────────┬────────────────────────┘
                 ▼
        ┌──────────────────┐
        │  PORTAL (navegador)│
        │  11 módulos        │
        └──────────────────┘
```

Hay **dos caminos** desde la API, y conviene no confundirlos:

| | Pipeline local | Colector en nube |
|---|---|---|
| Corre en | Mac de operación, vía `launchd` | Netlify Scheduled Function |
| Cadencia | Diaria, 09:00 | Horaria (`13 * * * *`) |
| Salida | `datos/historico/*.json` en el repo | Netlify Blobs |
| Enriquecido | Sí: ralentí, combustible, re-atribución | No: dato crudo |
| Lo consume | **El portal, para todo** | El monitor de alertas vivas |

El portal se alimenta hoy **sólo del archivo histórico**. El colector en nube
mantiene un snapshot fresco que hoy alimenta el monitor de alertas; conectarlo al
portal para tener rezago ≤1 h está diseñado en [`MEJORAS.md`](MEJORAS.md) pero no
implementado.

---

## 3. Ingesta: la capa `core.mjs`

`netlify/functions/lib/core.mjs` es el **núcleo compartido**: lo importan tanto
las funciones serverless de Node como el portal en el navegador. Una sola
implementación de la taxonomía, la agregación y las fórmulas — no una copia por
consumidor.

Contiene:

- **Cliente REST** (`apiCall`, `login`, `fetchFleet`, `fetchVehicleTrips`,
  `fetchTripEvents`, `fetchIncrementalEvents`).
- **Catálogo y clasificación de eventos** (`classifyEvent`).
- **Agregación** a grano operador × unidad × día (`aggregate`, `indexRegistros`).
- **Fórmula del Score de Seguridad** (`safetyScore`).
- **Taxonomía UDN / cliente** (`splitGrupo`, `setUdnMap`).
- **Construcción del snapshot** (`buildSnapshot`).

### Particularidades de la API que el cliente absorbe

Documentadas en el propio código porque son trampas reales, no folclore:

| Comportamiento | Cómo se maneja |
|---|---|
| Deja de responder **sin cerrar el socket** | Timeout duro de 90 s con `AbortSignal`. Sin él, el pool de concurrencia se agota y el proceso queda vivo al 0% de CPU, imposible de relanzar |
| Devuelve `action_value ≠ 0` con **HTTP 200** y `data` vacío | Se trata como error. Si no, un fallo de permisos es indistinguible de "no hay datos" y se propaga como un cero legítimo hasta los KPIs |
| **401 transitorios** con credencial válida | No se aborta al primer 401: sólo se concluye credencial inválida si persiste en todos los intentos con espera |
| **HTTP 500** al login = bloqueo por exceso de peticiones | Retroceso exponencial (0 · 30 s · 120 s · 300 s). Insistir prolonga el bloqueo |
| Espera los strings **URL-encoded** | Se intentan ambas formas: una contraseña con `$ & % +` en crudo devuelve 401 |
| Tope no documentado de 10 placas en `get_vehicle_trips_extended` | Se respeta en los lotes |

---

## 4. El pipeline diario

Lo dispara `launchd` a las 09:00 (`com.traxion.refresco-diario`) ejecutando
`connector/refresco_diario.sh`. También lo puede lanzar el botón "Día vencido"
del portal local.

### Secuencia

```
1. archivo_historico.mjs     --semana <actual> --force
      descarga viajes + eventos de la semana en curso

2. enriquecer_extendido.mjs  --semana <actual> --force --pausa 2
      sidecar de ralentí real (idle_time) → *.ralenti.json

3. reatribuir_eventos.mjs    --semana <actual> --force
      devuelve a cada operador los eventos huérfanos → *.reatrib.json

4. [lunes y martes] sella la semana ANTERIOR repitiendo 1-3

5. censo_actividad.mjs
      padrón de operadores y unidades activas

6. enriquecer_combustible.mjs --max 30
      magnitud (Δ%) de las caídas de nivel detectadas
```

### Dos candados de concurrencia

El script se protege dos veces, y ambas importan:

1. **Lock de proceso** (`/tmp/refresco_diario.lock`): impide dos refrescos
   simultáneos.
2. **Sesión única contra Traffilog**: antes de arrancar comprueba con `pgrep` que
   no haya otro proceso usando la API (`archivo_historico`,
   `enriquecer_extendido`, `enriquecer_combustible`). Si lo hay, **sale sin
   hacer nada**.

> ⚠️ El segundo candado sale con código 0 y **no reintenta**: si la API estaba
> ocupada a las 09:00, ese día no hay refresco hasta la corrida siguiente. Es una
> limitación conocida; ver [`OPERACION.md`](OPERACION.md) § Cuando el portal no
> actualiza.

### El sello de la semana anterior

El corte a día vencido del domingo alcanza hasta el sábado, y cuando corre el
lunes la semana ISO ya cambió. Sin un paso extra, **el domingo de cada semana
nunca recibiría su bajada final**. Por eso lunes y martes se re-baja la semana
anterior completa, ya con los datos asentados y todavía dentro de la ventana de
atribución.

### Qué NO hace

El pipeline **no publica**. Termina dejando el archivo actualizado en disco y lo
dice explícitamente en el log. La publicación es un proceso aparte, para que
alguien pueda validar antes de que el dato llegue al cliente.

---

## 5. El archivo histórico

### Estructura

```
datos/
├── historico/
│   ├── indice.json              ← manifiesto: cobertura y metadatos por semana
│   ├── 2026-W01.json            ← semana en formato compacto v3
│   ├── 2026-W01.ralenti.json    ← sidecar de ralentí (opcional)
│   ├── 2026-W01.reatrib.json    ← sidecar de re-atribución (opcional)
│   ├── …
│   ├── flota.json               ← padrón de unidades
│   ├── geo.json                 ← rejilla para puntos negros
│   └── alertas_monitor.json     ← acumulado del monitor vivo
└── rollups/
    ├── 2026-W01.json            ← agregados precalculados (~6 KB)
    └── 2026-W01.operadores.json ← detalle por operador, bajo demanda
```

`indice.json` es lo primero que lee el portal: trae la cobertura global
(`desde` → `hasta`) y, por semana, su rango de fechas, si es parcial, cuántos
registros y eventos tiene y cuánto pesa.

### Formato compacto v3

Un snapshot semanal en JSON plano pesa decenas de MB. El códec
(`netlify/functions/lib/codec.mjs`) lo reduce ~14.6× sin pérdida, y ~84× sumando
la compresión Brotli del transporte.

La técnica es **columnar con diccionarios**: los nombres de conductor, placas,
grupos y categorías se extraen a tablas de referencia (`ref`) y cada registro
guarda **índices**, no cadenas. La fecha se guarda como **offset de días** contra
el `from` del archivo.

```jsonc
{
  "v": 3,
  "from": "2026-08-10",
  "to": "2026-08-16",
  "parcial": true,
  "meta": { "operadores": 1267, "unidades": 945, "eventos": 270882 },
  "ref": {
    "conductores": [{ "n": "PEREZ JUAN", "id": "…", "wid": "…" }],
    "unidades":    [{ "p": "ABC-123", "id": "…", "g": 0 }],
    "grupos":      ["YAZAKI COLIMA"],
    "ext": [], "cat": [], "sev": []
  },
  "regs": [
    // [díaOffset, iCond, iUnidad, viajes, horas, km, [12 llaves],
    //  extendido, categorías, severidades, dtc, iGrupo]
    [0, 0, 0, 1, 1.0006, 34.23, [0,0,0,0,0,0,0,0,0,0,0,0], [], [], [], 0, 0]
  ]
}
```

**El grupo va por registro** (último campo), no sólo en la unidad: una unidad
puede cambiar de cliente dentro del periodo. El campo `g` de la unidad se
conserva para lectores anteriores a este formato.

### Rollups

`generar_rollups.mjs` precalcula por semana el total y el desglose por UDN y por
cliente en un archivo de ~6 KB — 128× más chico que la semana completa. Las 33
semanas de panel pesan 210 KB en total.

Existen y están al día, pero **la interfaz todavía lee `datos/historico/`**.
Engancharlos es un paso pendiente y deliberado (ver [`MEJORAS.md`](MEJORAS.md)).

---

## 6. Publicación

`connector/publicar_semanas.sh` corre en bucle bajo `launchd`
(`com.traxion.publicar-semanas`, `KeepAlive`), vigila `datos/historico/` y
despliega a Netlify cuando detecta un cambio.

```
cada 5 min:
  ¿cambió el listado de datos/historico/*.json?
    → espera 30 s (deja cerrar escrituras en curso)
    → netlify deploy --prod --no-build
    → registra resultado
```

Dos requisitos del script que **no son cosméticos**:

- **`PATH` explícito.** `launchd` arranca con un PATH mínimo que no incluye
  `~/.local/bin`, donde viven `node` y `npx`. Sin la línea, el deploy muere con
  `npx: command not found` de forma silenciosa e indefinida.
- **Redacción de tokens.** El volcado de error de `netlify-cli` incluye el header
  `Authorization` en claro, y los logs viven en `/tmp`, legible por cualquier
  usuario. Doble candado obligatorio: archivos en modo `600` y todo lo que sale
  del CLI pasa por `redactar()`.

Para publicar a mano, con validación previa: `connector/publicar_manual.sh`.

---

## 7. Capa serverless

Funciones en `netlify/functions/`, enrutadas desde `netlify.toml`:

| Ruta pública | Función | Qué hace |
|---|---|---|
| `/api/traffilog` | `traffilog.mjs` | Sirve el snapshot del colector desde Blobs. `?formato=completo` rehidrata; `?mode=live` construye un rango corto (máx 7 días) directo de la API |
| `/api/monitor-alertas` | `monitor-alertas.mjs` | Alertas vivas: la Mac empuja por POST con secreto, el portal lee por GET |
| `/api/auth/:accion` | `auth-*.mjs` | `login`, `logout`, `me`, `usuarios` |
| `/api/data` | `data.js` | Endpoint heredado |
| *(sin ruta)* | `traffilog-cron.mjs` | Scheduled Function horaria: recolector acumulativo |

### El colector acumulativo

`traffilog-cron.mjs` es la pieza que mantiene fresco el snapshot en Blobs. Su
principio rector: **merge por fecha, nunca reemplazo total.**

```
1. get_incremental_events  → unión por event_id en blobs "events/<fecha>"
                             (dedupe natural: nunca pisa lo ya visto)
2. get_vehicle_trips (3 días, sólo unidades con comunicación < 72 h)
                           → pisa por drive_id en "trips/<fecha>"
                             (re-fetch del mismo día = misma llave, idempotente)
3. Re-agrega SÓLO los días tocados (tope 14 por corrida) y los fusiona
   en el blob "registros"
4. Reconstruye el snapshot completo → blob "snapshot"
```

Los blobs crudos por fecha se podan a los 120 días; el blob `registros` **no
caduca**.

### Autenticación

Sesión por cookie firmada, 12 h de vigencia. Tres roles:

| Rol | Puede |
|---|---|
| `super` | Todo, incluido editar el mapa UDN y administrar usuarios |
| `admin` | Administrar usuarios |
| `lector` | Consultar, acotado a sus `udn_permitidas` |

El rol se re-lee del almacén en cada verificación: si cambió después de emitir el
token, manda el almacén. Con `AUTH_PROTEGER_DATOS=1`, el endpoint de datos
también exige sesión válida.

Detalle completo en [`AUTH.md`](AUTH.md).

---

## 8. El portal

Sin framework, sin paso de build: **JavaScript de navegador servido tal cual**.
Las únicas librerías son locales (`vendor/`): ECharts para gráficas, Leaflet +
OpenStreetMap para el mapa, SheetJS para Excel y jsPDF para PDF. Ninguna requiere
API key ni conexión a un CDN.

### Carga del dato

`aplicacion/archivo.js` es el lector del archivo histórico:

1. Lee `indice.json` y el mapa UDN.
2. Trae **sólo las últimas 4 semanas con datos** (`SEMANAS_INICIALES`). Con
   semanas de 0.5–1 MB y 33 en el archivo, la carga ansiosa costaría decenas de
   MB para datos que la mayoría de las sesiones nunca consulta.
3. Trae el resto **bajo demanda**, cuando un filtro de periodo las necesita.
4. Descomprime cada semana con `desempacar()`, aplica la taxonomía UDN/cliente
   con el mismo `splitGrupo()` del pipeline, fusiona los sidecars de ralentí y
   re-atribución, y marca `sinIdentificar` y `rol` una sola vez.
5. Construye el snapshot v2 que consumen todos los módulos.

Una semana que falta o no se puede leer se marca como fallida y **no se reintenta
en bucle**: el portal sigue con lo que tenga.

### Módulos

Cada uno es un archivo autónomo en `aplicacion/modulos/` que se registra en
`window.MODULOS` y expone `render(container, state)`, con su propio CSS
versionado. `index.html` es el dueño de la versión de cada hoja.

| Módulo | Qué responde |
|---|---|
| `panorama` | KPIs por UDN y cliente, tendencias, comparativas |
| `score-seguridad` | Score por operador y su desglose de eventos |
| `cargas-fatiga` | Días sin descanso, jornadas, calendario de carga |
| `m3operacion` | Hábitos de conducción y score de operación |
| `rankings` | Rankings y calificaciones |
| `habitos` | Distribución de eventos por conductor |
| `escuela` | Aspirantes y no-plantilla; evaluación para liberar |
| `combustible` | Caídas de nivel y sospecha de sustracción |
| `mapa` | Puntos negros de ruta |
| `alertas` | Monitor vivo: temperatura, pánico, robo |
| `cerebro` | Motor de reglas, alertas priorizadas y fichas descargables |
| `usuarios` | Administración de accesos |

Todos comparten el panel de **8 filtros jerárquicos** (UDN, cliente, operador,
unidad, eventos, periodo…). El periodo lo define un solo control global: los
módulos no tienen filtros temporales propios, para que no existan dos verdades
sobre la misma pregunta.

---

## 9. Puesta en marcha

### Requisitos

- Node.js 18 o superior
- Credenciales de la cuenta **regional** de Traffilog
- Cuenta de Netlify (sólo para desplegar)

### Local

```bash
cp connector/.env.example connector/.env   # y completar
npm install
npm run serve                              # http://localhost:4180
```

El portal arranca leyendo `datos/historico/`, que ya viene poblado con 33
semanas: **se puede ver funcionando sin credenciales**. Las credenciales sólo
hacen falta para traer datos nuevos.

Para sembrar el primer usuario administrador:

```bash
SEED_PASS='…' npm run seed:admin
```

### Traer datos nuevos

```bash
npm run refresco        # ciclo completo a día vencido
```

### Producción

```bash
npm run publicar        # despliegue manual, con validación
```

Las variables marcadas `[nube]` en `.env.example` deben cargarse además en
Netlify → Site settings → Environment variables: las funciones serverless no leen
el archivo local.

### Automatización

Los dos agentes `launchd` viven en `launchd/`:

```bash
cp launchd/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.traxion.refresco-diario.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.traxion.publicar-semanas.plist
```

Ajustar las rutas absolutas de los `.plist` a la ubicación real del proyecto.

---

## 10. Mapa del repositorio

```
├── index.html              Portal: shell, carga de módulos, versionado de CSS
├── config.js               Configuración del portal (fuente de datos, carga perezosa)
├── netlify.toml            Rutas, cron y empaquetado de funciones
│
├── aplicacion/
│   ├── archivo.js          Lector del archivo histórico (navegador)
│   ├── ui.js  ui.css       Shell, filtros, tema
│   ├── iconos.js           Registro único de iconos
│   ├── consejos.json       Catálogo de recomendaciones del Cerebro
│   ├── auth/               Pantalla de acceso
│   └── modulos/            Los 12 módulos (js + css)
│
├── connector/              Pipeline de ingesta (Node, contra la API REST)
│   ├── archivo_historico.mjs
│   ├── enriquecer_extendido.mjs
│   ├── enriquecer_combustible.mjs
│   ├── reatribuir_eventos.mjs
│   ├── censo_actividad.mjs
│   ├── generar_rollups.mjs
│   ├── refresco_diario.sh      ← orquestador diario
│   ├── publicar_semanas.sh     ← publicador automático
│   ├── publicar_manual.sh
│   └── servidor_local.mjs      ← servidor de desarrollo
│
├── netlify/functions/
│   ├── lib/core.mjs        NÚCLEO compartido: API, taxonomía, fórmulas
│   ├── lib/codec.mjs       Formato compacto v3
│   ├── lib/auth.mjs        Sesiones y roles
│   ├── traffilog.mjs       Endpoint de datos
│   ├── traffilog-cron.mjs  Colector horario
│   └── auth-*.mjs          Autenticación
│
├── datos/
│   ├── historico/          Archivo semanal + sidecars + índice
│   └── rollups/            Agregados precalculados
│
├── docs/                   Documentación (empieza por METRICAS.md)
├── launchd/                Agentes de automatización
└── vendor/                 Librerías locales (ECharts, Leaflet, SheetJS, jsPDF)
```

---

## 11. Dónde seguir

| Documento | Para qué |
|---|---|
| [`METRICAS.md`](METRICAS.md) | Fórmulas y umbrales exactos de cada indicador |
| [`OPERACION.md`](OPERACION.md) | Runbook diario y diagnóstico de fallas |
| [`MEJORAS.md`](MEJORAS.md) | Trabajo propuesto y decisiones pendientes |
| [`DATA_CONTRACT.md`](DATA_CONTRACT.md) | Estructura del snapshot v2 |
| [`AUTH.md`](AUTH.md) | Modelo de autenticación |
| [`PLAN_MAESTRO.md`](PLAN_MAESTRO.md) | Especificación funcional original |
| [`SOLICITUD-TRAFFILOG.md`](SOLICITUD-TRAFFILOG.md) | Permisos de API pendientes con el proveedor |
