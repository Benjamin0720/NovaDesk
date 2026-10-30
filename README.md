# NovaDesk

Mesa de ayuda con Requerimientos (R), Incidentes (I) y Control de cambios (C).

- Front-end estático (HTML/CSS/JS, sin build). Los datos y el login viven en **Supabase** (PostgreSQL + Auth, plan gratuito).
- Para probar en local sirve la carpeta con cualquier servidor estático (`.claude/serve.ps1` levanta uno en el puerto 8123).
  Para publicarla sirve GitHub Pages, Netlify o Cloudflare Pages.
- Configuración: `js/config.js` (URL del proyecto y clave *publishable*; es pública por diseño). Nunca pongas ahí la clave *secret*.
- Base de datos: `docs/schema.sql`, luego `docs/migracion-02-app.sql` y `docs/migracion-03-permisos.sql`. Detalle y plan de Power BI en `docs/plan-base-de-datos.md`.
- Roles: Administrador, Analista, Técnico. Los permisos de cada rol los aplica la **base** (RLS + disparadores), no solo la pantalla:
  el técnico solo ve lo asignado a él o creado por él, mueve el estado dentro de su flujo y no cambia prioridad, categoría ni reasigna;
  aprobar, programar y cerrar es de analista/administrador; un usuario inactivo no ve nada; las fechas las pone el servidor.
  `docs/pruebas-permisos.sql` verifica todo esto con usuarios falsos (no deja nada guardado): ejecutarlo después de cualquier cambio en las reglas.
- Clientes iniciales: Bupa, Curico, HAH. El administrador agrega más desde Clientes.
- **Usuarios:** el administrador los crea desde la pantalla Usuarios (＋ Nuevo usuario): elige nombre, usuario o correo, rol y habilidades,
  y la app le muestra una contraseña temporal una sola vez. También puede restablecer claves. Lo hace la Edge Function `admin-users`
  (`supabase/functions/admin-users/index.ts`), que usa la clave secreta en el servidor y exige que quien llama sea administrador.
  La primera vez que ingresa, la persona debe cambiar la clave temporal. Se ingresa con el usuario o con el correo completo.
- El primer administrador se crea a mano en Supabase (Authentication → Users) y se promueve con
  `update public.profiles set role='admin', active=true where username='...';`
- Seguridad: las contraseñas las guarda Supabase Auth (nunca la app), política de 10+ caracteres con mayúscula, minúscula, número y símbolo,
  cierre de sesión a los 15 min de inactividad, registro de seguridad, permisos por rol y RLS en todas las tablas.
- **Nova** (`classify()` en `js/novadesk.js`): clasifica tipo, categoría, prioridad, impacto y técnico sugerido
  con reglas de lenguaje y habilidades/carga; detecta incidentes mayores y tickets similares.
  Es un motor local sin API externa; puede reemplazarse por una llamada a un modelo de lenguaje.
- Los cambios de otros usuarios se ven al recargar o dentro de ~45 s (la app relee la base sola).

Pendiente: Edge Function para crear usuarios/restablecer claves desde la app, notificaciones por correo, bloqueo por intentos fallidos propio.
