# AUTH — Login y gestión de usuarios del portal

Autenticación del portal *Evaluación de Conductores* (TRAXION / LIPU).
Sesión por cookie firmada, usuarios en **Netlify Blobs**, alta/baja **desde el propio portal**
(no hace falta tocar el servidor).

| Pieza | Archivo |
|---|---|
| Núcleo (scrypt, JWT, cookies, store, rate limit) | `netlify/functions/lib/auth.mjs` |
| Login | `netlify/functions/auth-login.mjs` |
| Logout | `netlify/functions/auth-logout.mjs` |
| Sesión actual | `netlify/functions/auth-me.mjs` |
| CRUD de usuarios | `netlify/functions/auth-usuarios.mjs` |
| Pantalla de acceso + chip de sesión | `aplicacion/auth/auth.js` · `aplicacion/auth/auth.css` |
| Pantalla “Usuarios” (pestaña del portal) | `aplicacion/modulos/usuarios.js` · `.css` |
| Siembra del superusuario | `connector/seed_admin.mjs` |
| Pruebas (sin red) | `connector/test_auth.mjs` → `npm run test:auth` |

Rutas públicas (alias en `netlify.toml`):
`/api/auth/login` · `/api/auth/logout` · `/api/auth/me` · `/api/auth/usuarios`
(el portal llama directamente a `/.netlify/functions/auth-*`).

---

## 1. Puesta en marcha (una sola vez)

### 1.1 Generar y configurar el secreto de sesión

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Netlify → **Site settings → Environment variables** → nueva variable:

| Variable | Valor |
|---|---|
| `AUTH_SESSION_SECRET` | la cadena generada (**mínimo 32 caracteres**) |

> Si la variable falta o es corta, **todas** las funciones de auth responden
> `500 auth_no_configurada` con un mensaje explícito. **Nunca** hay un secreto por
> defecto: un portal mal configurado se queda cerrado, no abierto.

Vuelve a desplegar para que las funciones vean la variable.

### 1.2 Sembrar el superusuario

Necesitas un **Personal access token** de Netlify
(Netlify → *User settings → Applications → Personal access tokens*).

```bash
# el espacio inicial evita que el comando quede en el historial del shell
  SEED_PASS='<contraseña-inicial>' \
  NETLIFY_AUTH_TOKEN='<token>' \
  node connector/seed_admin.mjs --user jorge.interiano --nombre "Jorge Interiano" --rol super
```

* La contraseña se lee **solo** de `SEED_PASS`. Nunca va en el código, nunca en un
  flag (`--pass` quedaría visible en `ps` y en el historial), nunca se imprime.
* Si el usuario **ya existe**, conserva sus datos y **rota la contraseña**
  (es también el procedimiento de rescate si alguien pierde su acceso de super).
* `NETLIFY_SITE_ID` es opcional: se lee de `.netlify/state.json`.

Flags: `--user` (obligatorio) · `--nombre` · `--rol super|admin|lector` (por defecto `super`)
· `--udn "LIPU COLIMA,YAZAKI"` (vacío = todas las UDN).

A partir de aquí, **todo lo demás se hace desde el portal** (pestaña *Usuarios*).

---

## 2. Modelo de roles

| Rol | Ve el dashboard | Pestaña *Usuarios* | Crea / edita | Restricción |
|---|---|---|---|---|
| `super` | sí | sí | `super`, `admin`, `lector` | único rol que puede crear o tocar otros `super` |
| `admin` | sí | sí | `admin`, `lector` | no ve ni edita usuarios `super` |
| `lector` | sí | no | — | solo consulta |

Reglas de integridad que aplica el backend (no la UI):

* Nadie puede **cambiar su propio rol** ni **desactivarse a sí mismo** (anti-bloqueo).
* Siempre debe quedar **al menos un `super` activo**.
* `DELETE` es **baja lógica** (`activo:false`): el registro nunca se destruye, queda para auditoría.
* Desactivar a alguien **invalida su sesión al instante** — `auth-me` relee el store en cada
  petición, así que un JWT emitido antes deja de servir sin esperar a que expire.
* Cualquier rol puede cambiar **su propia** contraseña (exige la actual).

### `udn_permitidas`

Lista de UDN visibles para ese usuario; **vacía = todas**.
El portal recorta el snapshot con `recortarPorPermisos()` (`index.html`) antes de
alimentar los módulos. **Es un recorte de experiencia, no una frontera de seguridad**:
el feed `/api/traffilog` sigue siendo el mismo. Para blindarlo, ver §6.

---

## 3. Cómo funciona la sesión

```
POST /api/auth/login  {username, password}
     └─ scrypt(N=16384, r=8, p=1, keylen=64) contra password_hash + password_salt
     └─ éxito → Set-Cookie: rc_sesion=<JWT HS256>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200
GET  /api/auth/me     → 200 {usuario} · 401 sin sesión · 500 sin secreto
POST /api/auth/logout → Set-Cookie con Max-Age=0
```

* **JWT HS256** firmado con `AUTH_SESSION_SECRET`, expiración **12 h**.
  El payload lleva `sub`, `rol`, `nombre`, `iat`, `exp`; el `rol` efectivo **se relee
  del store** en cada petición, así que un cambio de rol surte efecto de inmediato.
* La cookie es **HttpOnly**: el JavaScript del portal nunca ve el token y **no se guarda
  nada en `localStorage`**.
* `Secure` se omite **únicamente** cuando la petición llega por `http://localhost`
  (necesario para `netlify dev`; el navegador descarta cookies `Secure` en orígenes no seguros).

### Rate limit

5 intentos fallidos por usuario → **bloqueo de 15 minutos** (HTTP `429` + `Retry-After`),
incluso si después se acierta la contraseña. El contador se guarda en el mismo store
(`rl/<usuario>`) y se limpia con cada login correcto. Las respuestas de error son
**genéricas** (`Usuario o contraseña incorrectos`) y el servidor hace trabajo scrypt
equivalente cuando el usuario no existe, para no filtrar qué cuentas existen ni por
mensaje ni por tiempo de respuesta.

---

## 4. Store de usuarios (Netlify Blobs, store `usuarios`)

| Key | Contenido |
|---|---|
| `u/<username>` | registro del usuario |
| `rl/<username>` | contador de intentos fallidos / bloqueo |

```jsonc
{
  "username": "jorge.interiano",        // minúsculas, 3–40, [a-z0-9._-]
  "nombre": "Jorge Interiano",
  "rol": "super",                       // super | admin | lector
  "udn_permitidas": [],                 // [] = todas
  "activo": true,
  "password_hash": "…",                 // scrypt hex (64 bytes)
  "password_salt": "…",                 // 16 bytes hex
  "creado": "2026-07-23T18:00:00.000Z",
  "creado_por": "seed_admin.mjs",
  "actualizado": "2026-07-23T18:00:00.000Z",
  "ultimo_acceso": "2026-07-23T19:12:00.000Z"
}
```

`usuarioPublico()` es la **única** proyección que sale hacia el cliente y jamás
incluye `password_hash` ni `password_salt`.
Política de contraseña: **≥10 caracteres, con letras y números**.

---

## 5. Modo desarrollo local (bypass)

Sirviendo el portal como estático no existen las Netlify Functions:

```bash
npm run serve            # python3 -m http.server 4180
open http://localhost:4180/?v=1
```

`/.netlify/functions/auth-me` devuelve **404** → `aplicacion/auth/auth.js` activa un
**bypass** y abre el dashboard con el usuario ficticio `dev-local` (rol `super`).

Condiciones, deliberadamente estrechas:

* Solo si `location.hostname` es `localhost`, `127.0.0.1`, `::1` (o protocolo `file:`).
* Solo ante **404 / caída de red**. Un `401` siempre muestra el login; un `500`
  muestra el login con el mensaje del servidor.
* En cualquier otro host un 404 se trata como fallo → login obligatorio.

Es **visible**: chip ámbar **DEV LOCAL** en el encabezado, aviso en consola, y la
pantalla *Usuarios* muestra un banner “Modo desarrollo local” con datos de DEMO que
no se guardan. El bypass no concede acceso a nada del servidor: no hay sesión emitida,
así que si activas §6 el feed real seguirá cerrado.

Con `netlify dev` (funciones reales en `http://localhost:8888`) **no** hay bypass:
`auth-me` responde 401 y el login funciona de verdad.

---

## 6. Blindar los datos (opcional, recomendado)

El portal es un sitio estático: la pantalla de login protege la **interfaz**, pero
`/api/traffilog` y `/data.json` son alcanzables sin sesión. Para cerrar el feed:

```
AUTH_PROTEGER_DATOS = 1     # variable de entorno en Netlify
```

`netlify/functions/traffilog.mjs` exigirá entonces una sesión válida y devolverá `401`
sin ella. Actívalo **después** de sembrar usuarios y comprobar que el login funciona
(si no, el portal se queda sin datos). `data.json` estático seguiría siendo público:
para cerrarlo del todo hay que dejar de publicarlo y servir siempre por la función.

---

## 7. Rotar el secreto de sesión

Rotar `AUTH_SESSION_SECRET` **invalida todas las sesiones activas** (todo el mundo
tendrá que volver a entrar). No afecta a las contraseñas, que son independientes.

1. Genera un valor nuevo (`randomBytes(48).toString('base64url')`).
2. Netlify → Environment variables → sustituye `AUTH_SESSION_SECRET`.
3. **Redespliega** (las funciones leen las variables al arrancar).
4. Avisa: al recargar, todos verán la pantalla de acceso.

Rota si sospechas filtración del valor, al salir alguien con acceso al panel de
Netlify, o de forma periódica (p. ej. cada 6 meses).

**Rotar una contraseña**: desde el portal (*Usuarios → icono de candado*) o, si nadie
puede entrar, volviendo a correr `seed_admin.mjs` con el mismo `--user` y un `SEED_PASS`
nuevo.

---

## 8. Reglas de oro del código

1. Ninguna contraseña se persiste, se imprime, se registra ni se devuelve — solo
   `scrypt` hash + salt. `SEED_PASS` únicamente por variable de entorno.
2. La UI **no** es la frontera de seguridad: ocultar la pestaña *Usuarios* es
   cosmética; `auth-usuarios.mjs` revalida rol y permisos en **cada** llamada.
3. Sin `AUTH_SESSION_SECRET` la respuesta es `500`, nunca un default inseguro.
4. `connector/.env` y los tokens de Netlify están en `.gitignore` — no los subas.

## 9. Comprobación

```bash
npm run test:auth      # 32 pruebas: scrypt, JWT, cookie, rate limit, matriz de permisos
```

Cubre, entre otras: rechazo de escalada de rol manipulando el payload del JWT,
bloqueo tras 5 fallos, `admin` que no puede tocar a un `super`, imposibilidad de
quedarse sin superusuarios, y que ninguna respuesta expone hashes.
