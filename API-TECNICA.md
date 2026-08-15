# Guía técnica — API de Traffilog (cuenta regional RMOccidente)

Documento de lo descubierto al analizar la aplicación web **traffilink / Questar**
(`https://app.traffilog.com/traffilink/index.htm`). Sirve como base para construir el
tablero en vivo. Ninguna credencial ni token se incluye aquí.

## Resumen ejecutivo

- La app web **no expone una API REST pública lista para usar** en esta cuenta. Los datos de los
  reportes viajan por un **WebSocket propietario** con un protocolo de "flujos".
- Existe una **API REST oficial documentada** (`login`, `get_vehicle_trips`, `get_trip_events`,
  `api_get_data`) pero **no está habilitada** para la cuenta: el App Engine responde `400 Bad Request`
  con el application code genérico. Hay que **solicitar a Traffilog que habilite la API** y entregue
  la URL base + application code de API.
- Recomendación: pedir la **Vía A (REST)** para producción; mientras tanto usar exportaciones o afinar
  la **Vía B (WebSocket)** para el panel en vivo.

## Arquitectura observada

| Elemento | Valor |
|---|---|
| App web | `https://app.traffilog.com/traffilink/index.htm` |
| Servidor | `ILAPPAZ2` |
| Application code (web) | `F5D8E478-C965-4E5C-B94B-FA5822F76A99` |
| WebSocket de datos | `wss://websocket.traffilog.com:443` |
| Config | `/config/new_web.json`, `/config/t-dashboards.json` |
| Librerías | jQuery, Handlebars, moment, PubSubJS, Google Charts; motor propio `render_engine` |
| Transporte de datos | **WebSocket** (no HTTP/XHR). Mensajes **JSON URL-encoded** |

## Vía A — API REST oficial (recomendada)

Documentación: <https://traffilog.gitbooks.io/api/>

- **Base:** `https://<servidor>/appengine_3/<APPLICATION_CODE>/1/json`
- **Headers:** `Content-Type: application/x-www-form-urlencoded`; cuerpo `data=<JSON URL-encoded>`
- **Fechas:** `yyyy-mm-ddThh:mi:ss.mmm` (UTC+DST sin offset)
- **Respuesta:** JSON con `response.properties` → `action_value` (0 = OK), `description`, `data[]`, `session_token`

Métodos relevantes:

| Método | Para qué | Parámetros clave |
|---|---|---|
| `login` | Obtener `session_token` | `user_name`, `password` |
| `login_data` | Datos del usuario/unidades | `session_token` |
| `get_vehicle_trips` | Viajes (por vehículo/conductor) | `vehicle_id`/`license_number`/`driver_id`, `from_date`, `to_date` → devuelve `drive_id`, `distance`, `start_time`, `end_time`, … |
| `get_trip_events` | Eventos de un viaje | `drive_id`, `version` |
| `api_get_data` | Estado actual de vehículos | `last_time`, `license_nmbr` |

**Estado actual:** el endpoint responde `400` con el application code genérico del gitbook y con el
de la web. Se necesita el **application code de API** provisto por Traffilog.

### Qué pedirle a Traffilog (texto sugerido)

> Solicito habilitar el acceso a la API (App Engine v3) para la cuenta regional **RMOccidente**. Requiero la
> **URL base** y el **application code de API**, con permisos para `login`, `get_vehicle_trips`
> y `get_trip_events`, para una integración de lectura de KPIs por conductor.

## Vía B — WebSocket (reverse-engineered)

El panel web pide cada reporte por el socket. Secuencia observada por reporte:

1. `get_template_flow` — carga el "flujo" del reporte
   (`flow_name:"Drivers Trips Summary"` / `"Drivers Events Summary"`, `flow_id:"183"`, `version:"2"`).
2. Acción de datos (**data source**):

**Resumen de Viajes de Conductores**
```json
{"action":{"name":"ds_trips_summary_report","parameters":{
  "object_type":"2","input_id":"1884",
  "start_date":"2026-07-07T00:00:00.000Z","end_date":"2026-07-21T23:59:00.000Z",
  "is_report":"","last_object_id":"","first_object_id":"",
  "_action_name":"ds_trips_summary_report","mtkn":"<token-mensaje>"},
  "session_token":"<token-sesión>","mtkn":"<token-mensaje>"}}
```

**Resumen de Eventos de Conductores** — idéntico con `name:"ds_events_summary"` e `input_id:"1873"`.

Notas del protocolo:
- Los mensajes se envían **URL-encoded** (`encodeURIComponent(JSON)`), no JSON crudo.
- `object_type:"2"` = conductores. `mtkn` es un token por mensaje (correlación).
- **Pendiente:** el servidor rechaza (`action_value 400`) acciones enviadas por un socket nuevo sin el
  **handshake de conexión** inicial (el token también viaja en la apertura de la conexión y el "flow"
  queda ligado a esa conexión). Para completarlo: capturar los primeros mensajes tras abrir el socket
  (forzando una reconexión con las herramientas de desarrollador) y replicar ese handshake + `login`.
- Keep-alive: acción `q-ws-ka` con `session_token` + `mtkn` cada ~30 s.

## Modelo de datos (columnas confirmadas)

**Resumen de Viajes de Conductores**

| Columna | Campo sugerido |
|---|---|
| Nombre del conductor | `conductor` |
| Nombre del grupo | `grupo` |
| Recuento de viajes | `recuento_de_viajes` |
| Tiempo de inactividad | `tiempo_de_inactividad` (HH:MM:SS) |
| Tiempo neto de conducción | `tiempo_neto_de_conduccion` (HH:MM:SS) |
| Distancia conducida (km) | `distancia_km` |
| km/kg, km/kWh, kWh/km, Gas Used, Charging Time | eficiencia / EV (vacías en flota de combustión) |

**Resumen de Eventos de Conductores** — una fila por conductor × tipo de evento:

| Columna | Campo sugerido |
|---|---|
| Nombre del conductor | `conductor` |
| Nombre del grupo | `grupo` |
| Nombre del evento | `evento` |
| Recuento / cantidad | `cantidad` |

## Formato que consume el panel (`data.json`)

```json
{
  "updated_at": "ISO-8601",
  "range": "dd/mm/aaaa – dd/mm/aaaa",
  "trips":  [{ "conductor","grupo","recuento_de_viajes","tiempo_de_inactividad","tiempo_neto_de_conduccion","distancia_km" }],
  "events": [{ "conductor","grupo","evento","cantidad" }]
}
```

El panel también acepta las exportaciones **Excel/CSV** de ambos reportes (encabezados flexibles).
