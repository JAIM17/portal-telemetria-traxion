# Catálogo de telemetría disponible (API Traffilog v4.3) — más allá del Excel

Fuente: `https://api.traffilog.mx/clients/json` (login de la cuenta regional RMOccidente). Confirmado en vivo 2026-07-22.

## Lo que el Excel tenía (base)
Eventos agrupados en 5 categorías caseras (Clutch, Frenos, Fuel, Motor, Salud) + km + horas + EV/Hora + EV/10KM.

## Lo que la API da REALMENTE (mucho más)

### Eventos (`get_incremental_events` v3 / `get_trip_events`)
- **Categorías oficiales:** 1-Safety · 2-Geographic · 3-Mechanic · 10-DTC (diagnóstico motor).
- **Severidad** por evento (low/1/2/3…).
- **Tipos específicos** (reales de tu flota, ejemplos):
  - Start drive with high clutch load · Clutch press >30s parado · Clutch >20s en movimiento >30km/h
  - High acceleration with Acc pedal · Brake pedal >10s a >30km/h
  - Speed above 40 km/h · Highway speed · Right/Left level alerts
  - High engine speed in low torque · High fuel consumption drive (rpm fuera de banda verde) · Driving while gear in neutral
- **Diagnóstico motor:** `spn`, `fmi`, `fmi_description` (códigos de falla DTC).
- **Geo por evento:** start/end lat-lng, `speed`, `direction`, `time`, `end_time`.
- **Identidad:** `driver_id`, `driver_name`, `driver_code`, `worker_id`, `vehicle_id`, `license_number`, `vin`.

### Viajes (`get_vehicle_trips`)
- `drive_id`, `distance`, `start_time`/`end_time` (→ **horas de manejo reales**), start/end location + lat-lng.
- Por `vehicle_id` / `license_number` / `driver_id`, rango de fechas.

### Recorrido (`get_trip_locations`)
- Breadcrumb GPS: `time`, `lat`, `lng`, `speed`, `mileage` (odómetro), `direction`, `vehicle_status` (apagado/encendido/ralentí).

### Flota / estado (`api_get_data` v4) — 111 unidades, toda la región
- Grupos: LIPU COLIMA, YAZAKI COLIMA/TECOMAN, TERNIUM, HOLCIM, FOUR SEASON, ESCUELA…
- Por unidad: placa, VIN, chofer actual, odómetro, viaje actual, GPS, velocidad, `status` (apagado/on/ralentí), última comunicación.

### Parámetros de motor (`get_parameters` / `api_get_vehicle_parameter_values`)
- Ej.: OBD MIL (testigo motor), Unit Time, BMU SOC (batería EV)… combustible/RPM/temperatura según unidad.

### Otros
- Geocercas (`api_get_layers` / `api_get_geometry`).
- Conductores (`get_drivers` / `get_user_drivers`): id, código, grupo, email, teléfono, last_trip.

## Métricas NUEVAS que podemos construir (nivel pro, no en el Excel)
- **Seguridad:** eventos por severidad, índice de riesgo ponderado por severidad, mapa de calor GPS de eventos.
- **Eficiencia motor:** % conducción fuera de banda verde (rpm), alto consumo, ralentí, neutral coasting.
- **Salud mecánica:** DTC/SPN-FMI activos por unidad, testigo MIL, tendencia de fallas.
- **Utilización real:** horas motor vs ralentí vs movimiento (de trip_locations `vehicle_status`), km/viaje, aprovechamiento.
- **Recorridos:** rutas, velocidad por tramo, excesos de velocidad geolocalizados.
- **Por operador Y por unidad**, cualquier periodo, toda la región/UDN.

## Notas de implementación
- `get_incremental_events` es **incremental** (nuevos desde la última llamada, tope 10k). Para histórico completo: `get_vehicle_trips` + `get_trip_events` por unidad/periodo, o polling incremental acumulado a un store.
- Strings vienen URL-encoded → decodificar.
- Cadena típica: `api_get_data` (unidades) → `get_vehicle_trips` (viajes+horas+km) → `get_trip_events` (eventos) → agregación por operador/día.
