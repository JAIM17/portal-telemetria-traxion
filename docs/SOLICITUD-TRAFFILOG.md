# Solicitud a Traffilog — cuenta RMOccidente

Redactado 2026-07-24 tras verificar contra la API productiva. Enviar al ejecutivo de cuenta.

---

**Asunto: habilitación de campos de combustible y ajuste de política de consumo — usuario de API RMOccidente**

Buen día.

Operamos una integración de lectura sobre la API v4.3 (`https://api.traffilog.mx/clients/json`) con el
usuario **RMOccidente**, para un tablero de evaluación de operadores sobre ~945 unidades.
Tenemos cuatro puntos.

## 1. Campos de combustible que regresan vacíos

El método `get_vehicle_trips_extended` responde correctamente (`action_value = 0`) y ya nos entrega
con dato: `idle_time`, `drive_duration`, `engine_hours`, `total_mileage`, `safety_score` y `distance`.

Estos otros llegan en la respuesta pero **sin valor**, lo que según el manual (pág. 15, nota sobre
campos que "regresarán sin valor" si falta permiso) indica falta de autorización:

| Campo | Estado observado |
|---|---|
| `start_fuel_level_percent` | vacío |
| `end_fuel_level_percent` | vacío |
| `liter_Per_100_km` | vacío |
| `km_per_1_Liter` | vacío |
| `CO2` | vacío |
| `start_mileage` | vacío |
| `fuel_used` | **llega en `0.00`** (no vacío) en el 100% de los viajes |

**Solicitamos habilitar los permisos sobre esos campos.** El caso de `fuel_used` es distinto y nos
gustaría entenderlo: al no venir vacío sino en cero, parece un problema de cálculo o de calibración
del sensor, no de permiso.

Que el dato existe en la unidad lo confirmamos con `get_parameters` sobre el `vehicle_id` 229485
(placa 4487), que sí devuelve lecturas reales:

```
28929  TFL Processed Sys Param Fuel Level                      = 69.0
28932  TFL Calc Fuel Drop From Processed Sys Param Fuel Level  = 16.0
28931  TFL Calc Fuel Fill From Processed Sys Param Fuel Level  =  0.0
10007  Sys Param Fuel Level
10008  Sys Param Fuel Rate
10009  Sys Param Total Fuel Used
60     J1939 Engine Fuel Rate
631    #Calc Total Fuel Used From Sys Fuel Rate
28879  Sys Param Engine Total Hours of Operation               = 2016.0
```

## 2. Catálogo de sensores por unidad

Solicitamos el **catálogo de `parameter_type`** (IDs y descripciones) disponible para nuestra flota, y
la confirmación de **qué unidades tienen sensor de nivel de combustible calibrado**, indicando si la
lectura es por CAN (J1939) o por entrada analógica de la ITU.

Como referencia de lo que observamos en 48 horas de eventos: `Send Fuel Data during Trip` aparece en
**611 de 719 unidades**, y `New Version Fuel fill` en **320**. Es decir, el hardware está.

## 3. Límite no documentado en `get_vehicle_trips_extended`

El parámetro `license_number` acepta varias placas separadas por coma, pero **atiende un máximo de 10
y descarta el resto en silencio**: la respuesta regresa `action_value = 0`, sin error ni advertencia.

Medido el 2026-07-24 sobre el mismo rango de fechas:

| Placas solicitadas | Placas en la respuesta |
|---|---|
| 5 | 5 |
| 10 | 10 |
| 15 | 10 |
| 20 | 10 |
| 30 | 10 |

Esto es riesgoso: una integración que pida 40 placas recibe datos aparentemente válidos pero
**incompletos**, sin forma de detectarlo salvo comparando contra lo solicitado. Pedimos que se
**documente el límite** y, de ser posible, que la API **devuelva una advertencia** cuando trunque.
Si el tope puede ampliarse para nuestra cuenta, nos ayudaría a reducir el número de llamadas.

## 4. Política de consumo para carga histórica

La sección *Políticas de uso* (pág. 32) indica que los servicios no deben consumirse con frecuencia
mayor a **una llamada cada 30 segundos**, contando todos los métodos del mismo usuario, y sugiere
usar "repositorios online o reportes calendarizados" para históricos extensos.

Necesitamos cargar **~30 semanas de historia** (viajes y eventos por viaje) para ~945 unidades.
Con `get_trip_events`, que exige una llamada por viaje, eso son decenas de miles de llamadas.

Solicitamos:

- **Confirmar la política de tasa aplicable a nuestra cuenta** para una carga histórica única.
- Conocer las **opciones de repositorio o reporte calendarizado** que menciona el manual, que serían
  la vía correcta para este volumen.
- Confirmar si existe un método de **eventos por lote y rango de fechas** (equivalente a
  `get_incremental_events` pero histórico), que evitaría la llamada por viaje.

## 5. Reporte diario de horas por operador ("Uso DMAS seguimiento diario")

Cruzamos ese reporte contra los viajes de la API (misma fuente) con 97.6% de coincidencia
día a día. Para poder conciliarlo al 100% pedimos dos ajustes de formato:

- **Agregar la columna `driver_id`** (y de ser posible el nombre completo sin truncar):
  hoy el nombre viene recortado a ~28 caracteres y ~2 de cada 10 operadores no se pueden
  cruzar de forma inequívoca contra la API.
- **Documentar el cálculo exacto de las horas del reporte**: cómo se redondean o truncan
  los decimales y cómo se asignan los viajes que cruzan la medianoche. Observamos
  diferencias de minutos que, en operadores al filo del umbral de 3 h, cambian el conteo
  de días trabajados. También confirmar la convención de fecha: verificamos que la columna
  del día D contiene lo trabajado el día D−1.

Quedamos atentos. Gracias.

---

## Notas internas (no enviar)

- **Punto 5**: si el reporte "Uso DMAS" no lo genera Traffilog sino el corporativo (BI de
  Traxión), estas dos peticiones (driver_id + criterio de horas) van a quien lo genera —
  el texto sirve igual. Evidencia: connector/comparar_dmas.sh + docs/ESTADO_SESION.md
  (validación 2026-07-27/28: corrimiento −1 día, brutas, 97.6% acuerdo).

- Verificado con `connector/rest_test.mjs` y el diagnóstico de lotes. El tope de 10 está fijado como
  `MAX_PLACAS` en `connector/enriquecer_extendido.mjs`, con validación de lo pedido contra lo recibido.
- Si Traffilog no libera los campos de combustible, la vía alterna **no depende de ellos**:
  `api_get_vehicle_parameter_values` sobre el `parameter_type` **28929** entrega la serie del nivel de
  tanque en ventanas de 72 h. Con eso se reconstruyen consumo, cargas y caídas de nivel.
- Pendiente de seguridad no relacionado con esta solicitud: **rotar la contraseña de RMOccidente**
  (estuvo hardcodeada en `connector/rest_test.mjs` y circuló en chat).
