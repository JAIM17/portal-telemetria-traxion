# Portal KPI de Conductores — Traffilog

Panel web para graficar KPIs por conductor a partir de dos reportes de Traffilog:
**Resumen de Viajes de Conductores** y **Resumen de Eventos de Conductores**.

Pensado como **tablero en tiempo real**: se auto-conecta al abrir y se refresca solo
mientras está abierto. Incluye un modo de carga por exportación (Excel/CSV) y datos de
ejemplo para explorar el diseño sin conexión.

![vistas](docs-preview.png)

## Qué grafica

- **Utilización de flota** — % de utilización (conducción ÷ tiempo activo), conducción vs. inactividad.
- **Eficiencia / distancia** — km recorridos y km por viaje por conductor.
- **Eventos de conducción** — eventos por conductor (apilados por tipo) y distribución por tipo.
- **Índice de seguridad** — eventos por 100 km, mapa riesgo-vs-exposición y tabla de desempeño.
- **Detalle por conductor** — perfil individual con desglose de eventos.

Panel lateral: **preselección** de qué KPIs mostrar, filtro por grupo, Top N y conductor.

## Estructura

```
index.html                 Panel (autónomo, librerías locales en vendor/)
config.js                  LIVE_URL, refresco y auto-conexión (editar sin tocar el HTML)
data.json                  Feed que lee el panel (arranca con muestra)
data.sample.json           Ejemplo del formato del feed
vendor/                    echarts + xlsx (sin depender de CDN)
netlify.toml               Despliegue Netlify (estático + funciones)
netlify/functions/data.js  Sirve el feed en vivo (/api/data)
connector/                 Conector Node que genera data.json desde Traffilog
API-TECNICA.md             Hallazgos de la API (base para el tablero en vivo)
```

## Uso rápido (local)

Como usa `fetch`, sírvelo por HTTP (no `file://`):

```bash
cd traffilog-kpi-portal
python3 -m http.server 8080
# abre http://localhost:8080
```

Botones: **Conectar en vivo** (lee el feed), arrastrar las **exportaciones** Excel/CSV, o
**Ver con datos de ejemplo**.

## Despliegue en Netlify

1. Sube este repo a GitHub.
2. En Netlify: *Add new site → Import from GitHub* y elige el repo. No requiere build
   (`publish = "."`). Las funciones se detectan en `netlify/functions`.
3. Para leer el feed desde la función, en `config.js` pon
   `LIVE_URL: '/.netlify/functions/data'` (o `/api/data`).

## Tiempo real

El panel se mantiene conectado así:

- **Auto-conexión** al abrir (`AUTOCONNECT`) y **refresco** cada `REFRESH_MS` (config.js).
- Al volver a la pestaña, vuelve a pedir el feed.

Para que el feed traiga datos frescos de Traffilog hay dos caminos (ver `API-TECNICA.md`):

- **Vía A (recomendada):** pedir a Traffilog que habilite la **API REST** y completar el conector.
  Ideal: mover `restPull()` a la función Netlify para datos frescos en cada carga, o correr el
  conector como **tarea programada** que actualice el feed.
- **Vía B:** completar el handshake del **WebSocket** propietario (esqueleto incluido).

## Conector

```bash
cd connector
cp .env.example .env    # completa credenciales (NO subir .env)
npm install
npm run once            # una corrida -> escribe ../data.json
npm start               # bucle continuo (panel en vivo)
```

## Seguir en Claude Code

Para construir el **tablero en vivo** definitivo:

1. Abre este repo en Claude Code.
2. Objetivo: completar la conexión en vivo — preferentemente **Vía A** (API REST) una vez que
   Traffilog la habilite; si no, afinar el **handshake WebSocket** de `API-TECNICA.md` (Vía B).
3. Mueve la obtención de datos a `netlify/functions/data.js` (o a una función programada) para que
   el panel reciba datos frescos en cada carga y quede 100% en vivo.
4. Mapea las respuestas al formato de `data.json` documentado. El front ya está listo.

## Seguridad

- **Nunca** subas `.env` ni credenciales (ya está en `.gitignore`).
- Los tokens de sesión son efímeros; que vivan en el backend/función, no en el HTML.

## Despliegue rápido (proyecto Netlify ya creado)

Ya se creó el proyecto **traffilog-kpi-portal** en tu cuenta Netlify (JAIM17).

- URL: https://traffilog-kpi-portal.netlify.app
- Site ID: `bd5e2ab6-a319-475c-8265-1069cd325dec`

Desde tu máquina (o Claude Code), dentro de esta carpeta:

```bash
# opción CLI directa
npx netlify-cli deploy --prod --dir . --site bd5e2ab6-a319-475c-8265-1069cd325dec

# o arrastrando la carpeta en https://app.netlify.com/projects/traffilog-kpi-portal/deploys
```

Para GitHub, crea el repo y sube:

```bash
git init && git add . && git commit -m "Portal KPI de Conductores (Traffilog)"
git branch -M main
git remote add origin https://github.com/<tu-usuario>/traffilog-kpi-portal.git
git push -u origin main
```

Luego en Netlify puedes conectar el repo para auto-deploy en cada push.
