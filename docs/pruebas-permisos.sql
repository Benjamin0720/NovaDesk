-- NovaDesk · pruebas de los permisos de docs/migracion-03-permisos.sql.
--
-- SON SEGURAS: crean usuarios y tickets de mentira dentro de una transacción que termina con un error a propósito, así que
-- no queda nada guardado. El informe aparece en ese mensaje de error («RESULTADO»): cada línea es ✔ (salió lo esperado) o
-- ✘ (algo no cumple). Cómo usarlo: pegar completo en Supabase > SQL Editor y ejecutar (se puede repetir cuando se quiera).
-- Las pruebas simulan a cada rol con una sesión falsa (como hace la API) y repiten lo que hace la app al guardar.

create temp table res (id serial, ok boolean, lbl text, detail text);

-- Ejecuta una sentencia como el usuario p_u y anota si coincidió con lo esperado.
-- Si no hay error pero afecta 0 filas, cuenta como «bloqueado» (así actúa RLS en select/update/delete).
create function pg_temp.attempt(p_lbl text, p_u uuid, p_stmt text, p_expect_ok boolean) returns void
language plpgsql as $f$
declare n bigint := 0; allowed boolean := true; err text := 'permitido';
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', p_u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_u::text, true);
  set local role authenticated;
  begin
    execute p_stmt;
    get diagnostics n = row_count;
    if n = 0 then allowed := false; err := '0 filas (RLS lo oculta o lo bloquea)'; end if;
  exception when others then
    allowed := false; err := sqlerrm;
  end;
  reset role;
  insert into pg_temp.res (ok, lbl, detail) values (allowed = p_expect_ok, p_lbl, err);
end $f$;

-- Comprueba una condición sobre los datos (se evalúa como administrador de la base, sin RLS).
create function pg_temp.verify(p_lbl text, p_cond boolean) returns void
language sql as $f$
  insert into pg_temp.res (ok, lbl, detail) values (coalesce(p_cond, false), p_lbl, case when p_cond then 'cumple' else 'NO cumple' end)
$f$;

do $t$
declare
  c    uuid := (select id from public.clients order by name limit 1);
  adm  uuid := '00000000-0000-0000-0000-00000000a001';
  ana  uuid := '00000000-0000-0000-0000-00000000a002';
  tec1 uuid := '00000000-0000-0000-0000-00000000a003';
  tec2 uuid := '00000000-0000-0000-0000-00000000a004';
  ina  uuid := '00000000-0000-0000-0000-00000000a005';
  s text; bad int;
begin
  -- Usuarios de prueba (el disparador de auth.users les crea el perfil como técnico inactivo; aquí se les da su rol).
  insert into auth.users (id, email) values
    (adm,  'zz.test.admin@novadesk.local'), (ana,  'zz.test.analista@novadesk.local'), (tec1, 'zz.test.tecnico1@novadesk.local'),
    (tec2, 'zz.test.tecnico2@novadesk.local'), (ina,  'zz.test.inactivo@novadesk.local');
  update public.profiles set role = 'admin',    active = true  where id = adm;
  update public.profiles set role = 'analista', active = true  where id = ana;
  update public.profiles set role = 'tecnico',  active = true  where id in (tec1, tec2);
  update public.profiles set role = 'tecnico',  active = false where id = ina;

  insert into public.tickets (id, type, title, description, client_id, requester, priority, status, category, assignee_id, created_by) values
    ('ZT-1', 'I', 'Impresora no imprime',  '', c, 'Prueba', 3, 'Asignado', 'Impresión',              tec1, ana),
    ('ZT-2', 'I', 'Correo caído',          '', c, 'Prueba', 2, 'Nuevo',    'Correo y colaboración',  tec2, ana),
    ('ZT-3', 'I', 'Ticket de un inactivo', '', c, 'Prueba', 3, 'En curso', 'General',                ina,  ana),
    ('ZT-4', 'I', 'Para tomar',            '', c, 'Prueba', 3, 'Nuevo',    'General',                tec1, ana);
  insert into public.tickets (id, type, title, description, client_id, requester, priority, status, category, assignee_id, created_by,
                              change_impact, change_complexity, change_hours, change_rollback, change_start) values
    ('ZC-1', 'C', 'Cambio en borrador', '', c, 'Prueba', 3, 'Borrador',       'General', null, tec1, 2, 2, 2, '', null),
    ('ZC-2', 'C', 'Cambio a evaluar',   '', c, 'Prueba', 3, 'En evaluación',  'General', tec1, ana,  2, 2, 2, 'Volver a la imagen anterior', '2030-01-01 10:00:00.123456+00');
  insert into public.audit_log (actor_id, text) values (adm, 'prueba');

  -- ───── Lectura ─────
  perform pg_temp.attempt('técnico ve el ticket que tiene asignado',                 tec1, $q$select 1 from public.tickets where id = 'ZT-1'$q$, true);
  perform pg_temp.attempt('técnico NO ve tickets ajenos',                            tec1, $q$select 1 from public.tickets where id = 'ZT-2'$q$, false);
  perform pg_temp.attempt('analista ve todos los tickets',                           ana,  $q$select 1 from public.tickets where id = 'ZT-2'$q$, true);
  perform pg_temp.attempt('usuario inactivo NO ve ni su propio ticket asignado',     ina,  $q$select 1 from public.tickets where id = 'ZT-3'$q$, false);
  perform pg_temp.attempt('usuario inactivo NO puede modificar su ticket asignado',  ina,  $q$update public.tickets set status = 'Resuelto' where id = 'ZT-3'$q$, false);
  perform pg_temp.attempt('usuario inactivo NO ve los clientes',                     ina,  $q$select 1 from public.clients$q$, false);
  perform pg_temp.attempt('usuario inactivo NO ve a los demás usuarios',             ina,  format($q$select 1 from public.profiles where id <> %L$q$, ina), false);
  perform pg_temp.attempt('usuario inactivo sí ve su propio perfil',                 ina,  format($q$select 1 from public.profiles where id = %L$q$, ina), true);
  perform pg_temp.attempt('usuario activo ve los clientes',                          tec1, $q$select 1 from public.clients$q$, true);

  -- ───── Técnico: lo que sí puede ─────
  perform pg_temp.attempt('técnico toma un ticket (Nuevo → En curso)',               tec1, $q$update public.tickets set status = 'En curso', updated_at = now() where id = 'ZT-4'$q$, true);
  perform pg_temp.attempt('guardado completo sin cambios reales (como lo envía la app)', tec1,
    $q$update public.tickets set id = id, type = type, title = title, description = description, client_id = client_id, requester = requester,
       priority = priority, status = status, category = category, assignee_id = assignee_id, created_by = created_by, ai_confidence = ai_confidence,
       created_at = created_at, updated_at = now(), resolved_at = resolved_at, change_impact = change_impact, change_complexity = change_complexity,
       change_start = change_start, change_hours = change_hours, change_rollback = change_rollback where id = 'ZT-4'$q$, true);
  perform pg_temp.attempt('técnico inicia el trabajo (Asignado → En curso)',         tec1, $q$update public.tickets set status = 'En curso' where id = 'ZT-1'$q$, true);
  perform pg_temp.attempt('técnico pone en espera',                                  tec1, $q$update public.tickets set status = 'En espera' where id = 'ZT-1'$q$, true);
  perform pg_temp.attempt('técnico reanuda',                                         tec1, $q$update public.tickets set status = 'En curso' where id = 'ZT-1'$q$, true);
  perform pg_temp.attempt('técnico resuelve',                                        tec1, $q$update public.tickets set status = 'Resuelto' where id = 'ZT-1'$q$, true);
  perform pg_temp.verify('el servidor fija resolved_at al resolver',                 (select resolved_at is not null from public.tickets where id = 'ZT-1'));
  perform pg_temp.attempt('técnico reabre un ticket resuelto',                       tec1, $q$update public.tickets set status = 'En curso' where id = 'ZT-1'$q$, true);
  perform pg_temp.verify('el servidor borra resolved_at al reabrir',                 (select resolved_at is null from public.tickets where id = 'ZT-1'));
  perform pg_temp.attempt('técnico vuelve a resolver',                               tec1, $q$update public.tickets set status = 'Resuelto' where id = 'ZT-1'$q$, true);
  perform pg_temp.attempt('guardado de un cambio con fecha de microsegundos (no es un cambio real)', tec1,
    $q$update public.tickets set change_start = date_trunc('milliseconds', change_start), change_rollback = change_rollback where id = 'ZC-2'$q$, true);

  -- ───── Técnico: lo que no puede ─────
  perform pg_temp.attempt('técnico NO cierra tickets',                               tec1, $q$update public.tickets set status = 'Cerrado' where id = 'ZT-1'$q$, false);
  perform pg_temp.attempt('técnico NO cambia la prioridad',                          tec1, $q$update public.tickets set priority = 1 where id = 'ZT-1'$q$, false);
  perform pg_temp.attempt('técnico NO cambia la categoría',                          tec1, $q$update public.tickets set category = 'Seguridad' where id = 'ZT-1'$q$, false);
  perform pg_temp.attempt('técnico NO reasigna a otra persona',                      tec1, format($q$update public.tickets set assignee_id = %L where id = 'ZT-1'$q$, tec2), false);
  perform pg_temp.attempt('técnico NO se quita el ticket (lo deja sin asignar)',     tec1, $q$update public.tickets set assignee_id = null where id = 'ZT-1'$q$, false);
  perform pg_temp.attempt('técnico NO cambia el asunto',                             tec1, $q$update public.tickets set title = 'otro' where id = 'ZT-1'$q$, false);
  perform pg_temp.attempt('técnico NO cambia el tipo',                               tec1, $q$update public.tickets set type = 'C' where id = 'ZT-1'$q$, false);
  perform pg_temp.attempt('técnico NO cambia el autor',                              tec1, format($q$update public.tickets set created_by = %L where id = 'ZT-1'$q$, tec1), false);
  perform pg_temp.attempt('técnico NO salta pasos (Resuelto → En espera)',           tec1, $q$update public.tickets set status = 'En espera' where id = 'ZT-1'$q$, false);
  perform pg_temp.attempt('técnico NO toca tickets ajenos',                          tec1, $q$update public.tickets set status = 'En curso' where id = 'ZT-2'$q$, false);
  perform pg_temp.attempt('técnico NO borra tickets',                                tec1, $q$delete from public.tickets where id = 'ZT-1'$q$, false);
  perform pg_temp.attempt('técnico intenta falsear resolved_at (se ignora)',         tec1, $q$update public.tickets set resolved_at = '2000-01-01' where id = 'ZT-1'$q$, true);
  perform pg_temp.verify('resolved_at no se pudo falsear',                           (select resolved_at > '2001-01-01' from public.tickets where id = 'ZT-1'));
  perform pg_temp.attempt('técnico intenta falsear created_at (se ignora)',          tec1, $q$update public.tickets set created_at = '2000-01-01' where id = 'ZT-1'$q$, true);
  perform pg_temp.verify('created_at no se pudo falsear',                            (select created_at > '2001-01-01' from public.tickets where id = 'ZT-1'));

  -- ───── Técnico: crear ─────
  perform pg_temp.attempt('técnico crea un ticket asignado a sí mismo',              tec1, format($q$insert into public.tickets (id, type, title, client_id, requester, priority, status, category, assignee_id, created_by)
    values ('ZT-5', 'I', 'Mío', %L, 'Yo', 3, 'Asignado', 'General', %L, %L)$q$, c, tec1, tec1), true);
  perform pg_temp.attempt('técnico NO crea un ticket asignado a otra persona',       tec1, format($q$insert into public.tickets (id, type, title, client_id, requester, priority, status, category, assignee_id, created_by)
    values ('ZT-6', 'I', 'Ajeno', %L, 'Yo', 3, 'Asignado', 'General', %L, %L)$q$, c, tec2, tec1), false);
  perform pg_temp.attempt('técnico NO crea un ticket a nombre de otra persona',      tec1, format($q$insert into public.tickets (id, type, title, client_id, requester, priority, status, category, created_by)
    values ('ZT-7', 'I', 'Falso', %L, 'Yo', 3, 'Nuevo', 'General', %L)$q$, c, ana), false);
  perform pg_temp.attempt('técnico NO crea un ticket que ya nace cerrado',           tec1, format($q$insert into public.tickets (id, type, title, client_id, requester, priority, status, category, created_by)
    values ('ZT-8', 'I', 'Cerrado', %L, 'Yo', 3, 'Cerrado', 'General', %L)$q$, c, tec1), false);
  perform pg_temp.attempt('técnico crea un cambio en Borrador',                      tec1, format($q$insert into public.tickets (id, type, title, client_id, requester, priority, status, category, created_by, change_impact, change_complexity, change_hours, change_rollback)
    values ('ZC-3', 'C', 'Mi cambio', %L, 'Yo', 3, 'Borrador', 'General', %L, 2, 2, 2, '')$q$, c, tec1), true);
  perform pg_temp.attempt('técnico NO crea un cambio ya aprobado',                   tec1, format($q$insert into public.tickets (id, type, title, client_id, requester, priority, status, category, created_by, change_impact, change_complexity, change_hours, change_rollback)
    values ('ZC-4', 'C', 'Cambio aprobado', %L, 'Yo', 3, 'Aprobado', 'General', %L, 2, 2, 2, '')$q$, c, tec1), false);

  -- ───── Comentarios, historial, aprobaciones y registro de seguridad ─────
  perform pg_temp.attempt('técnico comenta su ticket',                               tec1, format($q$insert into public.ticket_comments (ticket_id, author_id, body) values ('ZT-1', %L, 'hola')$q$, tec1), true);
  perform pg_temp.attempt('técnico NO comenta un ticket ajeno',                      tec1, format($q$insert into public.ticket_comments (ticket_id, author_id, body) values ('ZT-2', %L, 'hola')$q$, tec1), false);
  perform pg_temp.attempt('técnico NO comenta a nombre de otra persona',             tec1, format($q$insert into public.ticket_comments (ticket_id, author_id, body) values ('ZT-1', %L, 'hola')$q$, ana), false);
  perform pg_temp.attempt('técnico comenta con fecha falsa (se ignora)',             tec1, format($q$insert into public.ticket_comments (ticket_id, author_id, body, created_at) values ('ZT-1', %L, 'viejo', '2000-01-01')$q$, tec1), true);
  perform pg_temp.verify('la fecha del comentario la puso el servidor',              (select created_at > '2001-01-01' from public.ticket_comments where body = 'viejo'));
  perform pg_temp.attempt('técnico agrega historial a su ticket',                    tec1, format($q$insert into public.ticket_history (ticket_id, actor_id, text) values ('ZT-1', %L, 'x')$q$, tec1), true);
  perform pg_temp.attempt('técnico NO agrega historial a nombre de otra persona',    tec1, format($q$insert into public.ticket_history (ticket_id, actor_id, text) values ('ZT-1', %L, 'x')$q$, ana), false);
  perform pg_temp.attempt('técnico NO registra aprobaciones de cambios',             tec1, format($q$insert into public.change_approvals (ticket_id, approver_id, decision) values ('ZC-2', %L, 'Aprobado')$q$, tec1), false);
  perform pg_temp.attempt('usuario activo escribe en el registro de seguridad',      tec1, format($q$insert into public.audit_log (actor_id, text) values (%L, 'ok')$q$, tec1), true);
  perform pg_temp.attempt('usuario inactivo NO escribe en el registro de seguridad', ina,  format($q$insert into public.audit_log (actor_id, text) values (%L, 'ok')$q$, ina), false);
  perform pg_temp.attempt('técnico NO lee el registro de seguridad',                 tec1, $q$select 1 from public.audit_log$q$, false);

  -- ───── Cambios (técnico) ─────
  perform pg_temp.attempt('técnico edita el plan de su cambio en Borrador',          tec1, $q$update public.tickets set change_rollback = 'Restaurar respaldo' where id = 'ZC-1'$q$, true);
  perform pg_temp.attempt('técnico envía su cambio a evaluación',                    tec1, $q$update public.tickets set status = 'En evaluación' where id = 'ZC-1'$q$, true);
  perform pg_temp.attempt('técnico NO edita el plan después de enviarlo',            tec1, $q$update public.tickets set change_rollback = 'otro plan' where id = 'ZC-1'$q$, false);
  perform pg_temp.attempt('técnico NO aprueba un cambio',                            tec1, $q$update public.tickets set status = 'Aprobado' where id = 'ZC-2'$q$, false);
  perform pg_temp.attempt('técnico NO rechaza un cambio',                            tec1, $q$update public.tickets set status = 'Rechazado' where id = 'ZC-2'$q$, false);

  -- ───── Analista ─────
  perform pg_temp.attempt('analista aprueba un cambio',                              ana,  $q$update public.tickets set status = 'Aprobado' where id = 'ZC-2'$q$, true);
  perform pg_temp.attempt('analista registra la aprobación',                         ana,  format($q$insert into public.change_approvals (ticket_id, approver_id, decision) values ('ZC-2', %L, 'Aprobado')$q$, ana), true);
  perform pg_temp.attempt('analista programa el cambio',                             ana,  $q$update public.tickets set status = 'Programado' where id = 'ZC-2'$q$, true);
  perform pg_temp.attempt('técnico inicia la implementación',                        tec1, $q$update public.tickets set status = 'Implementando' where id = 'ZC-2'$q$, true);
  perform pg_temp.attempt('técnico marca el cambio como implementado',               tec1, $q$update public.tickets set status = 'Implementado' where id = 'ZC-2'$q$, true);
  perform pg_temp.attempt('técnico NO cierra el cambio',                             tec1, $q$update public.tickets set status = 'Cerrado' where id = 'ZC-2'$q$, false);
  perform pg_temp.attempt('analista cierra el cambio',                               ana,  $q$update public.tickets set status = 'Cerrado' where id = 'ZC-2'$q$, true);
  perform pg_temp.attempt('analista cambia prioridad, categoría y reasigna',         ana,  format($q$update public.tickets set priority = 1, category = 'Seguridad', assignee_id = %L where id = 'ZT-2'$q$, tec1), true);
  perform pg_temp.attempt('analista asigna un ticket nuevo (Nuevo → Asignado)',      ana,  $q$update public.tickets set status = 'Asignado' where id = 'ZT-2'$q$, true);
  perform pg_temp.attempt('analista cierra un ticket resuelto',                      ana,  $q$update public.tickets set status = 'Cerrado' where id = 'ZT-1'$q$, true);
  perform pg_temp.attempt('analista reabre un ticket cerrado',                       ana,  $q$update public.tickets set status = 'En curso' where id = 'ZT-1'$q$, true);
  perform pg_temp.attempt('analista NO salta pasos (En curso → Cerrado)',            ana,  $q$update public.tickets set status = 'Cerrado' where id = 'ZT-1'$q$, false);
  perform pg_temp.attempt('analista NO cambia el tipo',                              ana,  $q$update public.tickets set type = 'R' where id = 'ZT-2'$q$, false);
  perform pg_temp.attempt('analista crea un ticket asignado a un técnico',           ana,  format($q$insert into public.tickets (id, type, title, client_id, requester, priority, status, category, assignee_id, created_by)
    values ('ZT-9', 'I', 'Asignado por analista', %L, 'Yo', 2, 'Asignado', 'General', %L, %L)$q$, c, tec2, ana), true);
  perform pg_temp.attempt('analista NO crea un ticket ya resuelto',                  ana,  format($q$insert into public.tickets (id, type, title, client_id, requester, priority, status, category, created_by)
    values ('ZT-10', 'I', 'Resuelto', %L, 'Yo', 3, 'Resuelto', 'General', %L)$q$, c, ana), false);

  -- ───── Administración (clientes, usuarios, borrado) ─────
  perform pg_temp.attempt('analista NO borra tickets',                               ana,  $q$delete from public.tickets where id = 'ZT-9'$q$, false);
  perform pg_temp.attempt('administrador borra un ticket',                           adm,  $q$delete from public.tickets where id = 'ZT-9'$q$, true);
  perform pg_temp.attempt('analista NO edita clientes',                              ana,  format($q$update public.clients set contact = 'x' where id = %L$q$, c), false);
  perform pg_temp.attempt('administrador edita clientes',                            adm,  format($q$update public.clients set contact = contact where id = %L$q$, c), true);
  perform pg_temp.attempt('analista NO cambia roles',                                ana,  format($q$update public.profiles set role = 'admin' where id = %L$q$, tec2), false);
  perform pg_temp.attempt('técnico NO se sube a administrador',                      tec1, format($q$update public.profiles set role = 'admin' where id = %L$q$, tec1), false);
  perform pg_temp.attempt('administrador edita usuarios',                            adm,  format($q$update public.profiles set skills = '{Impresión}' where id = %L$q$, tec2), true);
  perform pg_temp.attempt('analista NO lee el registro de seguridad',                ana,  $q$select 1 from public.audit_log$q$, false);
  perform pg_temp.attempt('administrador lee el registro de seguridad',              adm,  $q$select 1 from public.audit_log$q$, true);

  select string_agg((case when ok then '✔ ' else '✘ ' end) || lbl || '  [' || detail || ']', E'\n' order by id), count(*) filter (where not ok)
    into s, bad from pg_temp.res;
  raise exception E'RESULTADO: % prueba(s) con problema\n%', bad, s;
end $t$;
