# NovaDesk · Plan de base de datos y Power BI (costo $0)

Estado: **diseño**. No se ha cambiado código ni creado nada en Supabase. El esquema está en [`schema.sql`](schema.sql).

## Arquitectura

```
Navegador (index.html, JS puro)  ──►  Supabase (PostgreSQL + Auth + API)  ◄──  Power BI Desktop
   GitHub Pages / Netlify / Cloudflare Pages              esquema `bi` (solo lectura)
```

Todo en planes gratuitos. Verifica los límites vigentes de Supabase antes de depender de ellos: proyecto que se pausa tras ~1 semana sin uso, ~500 MB de base, sin respaldos automáticos.

## Qué reemplaza a qué

| Hoy (localStorage) | Con Supabase |
|---|---|
| `S.tickets` | tabla `tickets` |
| `t.comments` / `t.history` | `ticket_comments` / `ticket_history` |
| `t.change` + `approvals` | columnas `change_*` en `tickets` + `change_approvals` |
| `S.users` + hash PBKDF2 casero | `profiles` + **Supabase Auth** (el hash lo maneja Supabase) |
| `S.clients` | `clients` |
| `S.audit` (últimos 200) | `audit_log` (sin límite) |
| `S.seq` | `next_ticket_id()` atómico (no se repiten IDs entre usuarios) |
| permisos del técnico en JS | **RLS** en la base: el filtro ya no depende del navegador |

## Puntos a decidir / cuidar

1. **Login por usuario, no por correo.** Supabase Auth usa correo. Opción simple: guardar `usuario@novadesk.local` como correo interno y que la pantalla siga pidiendo "usuario". Los correos reales pueden agregarse después para recuperación y notificaciones.
2. **Crear usuarios y contraseñas temporales** requiere la clave `service_role`, que nunca puede ir en el navegador. Se resuelve con una *Edge Function* de Supabase (gratis en el plan Free) que solo el administrador puede invocar.
3. **Bloqueo tras 5 intentos fallidos:** Supabase limita intentos por su cuenta, pero no con la misma regla de 5 min. Se mantiene el registro de intentos en `audit_log`; el bloqueo exacto sería una mejora posterior.
4. **Nova (`classify()`)** sigue corriendo en el navegador; solo cambia dónde se leen los tickets similares y la carga de técnicos.
5. **Datos reales:** para la demo, solo datos ficticios. Con datos de clientes reales hay que pasar por TI (Ley 21.719) y pensar en respaldos.

## Power BI

- **Power BI Desktop (gratis)** → Obtener datos → *Base de datos PostgreSQL*. Conectar con el *connection pooler* de Supabase (modo session), porque la conexión directa es solo IPv6.
- Usuario `powerbi_reader`, que solo lee el esquema `bi` (vistas `bi.tickets`, `bi.ticket_estado_historial`, `bi.comentarios`). Nunca se usa la clave `service_role` ni un usuario administrador.
- Medidas que salen directo de `bi.tickets`: tickets por cliente/tipo/prioridad, abiertos vs. cerrados, tiempo de resolución, **cumplimiento de SLA** (`horas_transcurridas <= sla_horas`), carga por técnico, evolución semanal.
- Publicar en línea (Power BI Service) requiere licencia Pro. Preguntar a TI si la empresa ya la tiene; si no, la demo se hace desde Desktop o con un resumen dentro de la propia NovaDesk.

## Etapas

1. **Crear proyecto en Supabase** (cuenta gratuita) y correr `schema.sql`. Cargar clientes y usuarios de prueba.
2. **Migrar el front-end**: reemplazar `load()/save()` y las acciones por llamadas a Supabase (`supabase-js`, cargado por CDN, sin build). Es el cambio grande: ~1 archivo.
3. **Login con Supabase Auth** + Edge Function para crear usuarios.
4. **Publicar la página** en GitHub Pages / Netlify / Cloudflare Pages.
5. **Dashboard en Power BI Desktop** sobre `bi.*`.
6. Pruebas con 2–3 usuarios simultáneos (analista, técnico, admin) para validar permisos.

## Qué necesito de ti para la etapa 1

- Crear tú la cuenta en supabase.com y el proyecto (no tengo acceso a tu cuenta ni debo crearla yo). Región más cercana: São Paulo.
- Pasarme la **URL del proyecto** y la clave **anon** (esa sí es pública). **No** me compartas la `service_role` ni la clave del usuario `powerbi_reader`.
