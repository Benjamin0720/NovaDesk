# NovaDesk

Mesa de ayuda con Requerimientos (R), Incidentes (I) y Control de cambios (C).

- Abrir `index.html` en el navegador (o servir la carpeta con cualquier servidor estático).
- Primer uso: la app pide crear la cuenta de administrador (no hay contraseñas por defecto).
  El admin crea los demás usuarios en Usuarios; cada uno recibe una contraseña temporal que debe cambiar al ingresar.
- Seguridad: contraseñas con PBKDF2-SHA256 + sal (nunca en texto plano), política de 10+ caracteres,
  bloqueo de 5 min tras 5 intentos fallidos, cierre de sesión a los 15 min de inactividad,
  registro de seguridad y permisos por rol. Es seguridad del lado del navegador: no reemplaza a un servidor.
- Los datos viven en `localStorage`; "Restablecer tickets de demo" está en Usuarios (admin).
- Clientes iniciales: Bupa, Curico, HAH. Se agregan más desde Clientes (admin).
- Roles: Administrador, Analista, Técnico (el técnico solo ve lo asignado a él o creado por él).
- **Nova** (`classify()` en `js/novadesk.js`): clasifica tipo, categoría, prioridad, impacto y técnico sugerido
  con reglas de lenguaje y habilidades/carga; detecta incidentes mayores y tickets similares.
  Es un motor local sin API externa; puede reemplazarse por una llamada a un modelo de lenguaje.

Pendiente para producción: backend + base de datos, autenticación real y notificaciones por correo.
