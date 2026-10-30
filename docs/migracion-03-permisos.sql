-- NovaDesk · migración 3 (ejecutar DESPUÉS de schema.sql y migracion-02-app.sql): permisos reforzados en la base.
--
-- Hasta ahora los permisos por rol solo se aplicaban en la pantalla; en la base, cualquiera que viera un ticket podía
-- modificarlo entero con una llamada directa a la API (cambiar prioridad, reasignarlo, cerrarlo, aprobar un cambio…).
-- Ahora las reglas viven en el servidor (RLS + disparadores) y calcan lo que ya muestra la app: la matriz de la pantalla
-- Usuarios y el flujo de estados de transitions() en js/novadesk.js. Lo que la pantalla permitía sigue funcionando igual.
--
-- Es seguro ejecutarla más de una vez. Para deshacerla, ver «Deshacer» al final. Para probarla, docs/pruebas-permisos.sql.
--
-- Qué cambia:
--   · Un usuario inactivo deja de ver (y tocar) incluso los tickets que tenía asignados, los clientes y a los demás usuarios.
--   · Técnico: solo puede mover el estado dentro del flujo que le corresponde, tomar un ticket sin asignar y, mientras un
--     cambio está en Borrador, editar su plan. No cambia prioridad, categoría, asunto, descripción ni reasigna; no cierra
--     tickets ni aprueba, programa o cierra cambios (eso es de analista/administrador).
--   · Analista y administrador: todo lo anterior más prioridad, categoría, reasignación, aprobación (CAB) y cierre.
--   · Nadie cambia el número, el tipo, el cliente ni el autor de un ticket (el administrador puede hacerlo desde el SQL Editor).
--   · Un ticket nuevo solo puede nacer en su estado inicial (Nuevo/Asignado, o Borrador si es un cambio); un técnico solo
--     puede crearlo asignado a sí mismo o sin asignar.
--   · Las fechas (creación, actualización, resolución, comentarios, historial, aprobaciones y registro de seguridad) las pone
--     el servidor: ya no se pueden falsear desde el navegador, y con ellas los tiempos de SLA y el Power BI son confiables.

-- ───────────── 1) Un usuario inactivo no ve tickets ─────────────
-- Antes, un técnico desactivado seguía viendo los tickets asignados a él (null or true = true).
create or replace function public.can_see_ticket(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_role() is not null
     and (app_role() in ('admin','analista')
          or exists (select 1 from tickets t
                     where t.id = p_id and (t.assignee_id = auth.uid() or t.created_by = auth.uid())))
$$;

-- ───────────── 2) Políticas de fila (RLS) ─────────────
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated using (app_role() is not null);

-- Un usuario inactivo solo puede leer su propio perfil (la app lo necesita para avisarle que su cuenta está inactiva).
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (app_role() is not null or id = auth.uid());

drop policy if exists tickets_insert on public.tickets;
create policy tickets_insert on public.tickets for insert to authenticated with check (
  created_by = auth.uid() and app_role() is not null
  and ((type = 'C' and status = 'Borrador') or (type <> 'C' and status in ('Nuevo','Asignado')))
  and (app_role() in ('admin','analista') or assignee_id is null or assignee_id = auth.uid())
  and resolved_at is null);

drop policy if exists audit_insert on public.audit_log;
create policy audit_insert on public.audit_log for insert to authenticated
  with check (actor_id = auth.uid() and app_role() is not null);

-- ───────────── 3) Disparadores sobre tickets ─────────────
-- Dentro de estas funciones, auth.uid() es null cuando no hay un usuario de la app detrás: el SQL Editor del dashboard o la
-- Edge Function con la clave secreta. En ese caso no se aplica ninguna restricción (para arreglos manuales y migraciones).

-- Al crear: las fechas las pone el servidor.
create or replace function public.tickets_before_insert() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then new.created_at := now(); new.updated_at := now(); end if;
  return new;
end $$;

drop trigger if exists tickets_before_insert on public.tickets;
create trigger tickets_before_insert before insert on public.tickets
for each row execute function public.tickets_before_insert();

-- Al modificar: quién puede cambiar qué, y qué cambios de estado son válidos.
-- La app envía la fila completa en cada guardado, así que solo se miran los valores que de verdad cambian
-- (los campos opcionales del cambio se comparan con sus valores por defecto y las fechas al milisegundo).
create or replace function public.tickets_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  r     text    := app_role();
  staff boolean := coalesce(r in ('admin', 'analista'), false);
  ok    boolean;
begin
  if auth.uid() is null then return new; end if;
  if r is null then raise exception 'Tu cuenta está inactiva.' using errcode = '42501'; end if;

  if new.id is distinct from old.id or new.type is distinct from old.type
     or new.client_id is distinct from old.client_id or new.created_by is distinct from old.created_by then
    raise exception 'No se puede cambiar el número, el tipo, el cliente ni el autor de un ticket.' using errcode = '42501';
  end if;

  if not staff then
    if new.title is distinct from old.title or new.description is distinct from old.description
       or new.requester is distinct from old.requester or new.priority is distinct from old.priority
       or new.category is distinct from old.category or new.ai_confidence is distinct from old.ai_confidence then
      raise exception 'Tu rol no puede cambiar el asunto, la descripción, la prioridad ni la categoría.' using errcode = '42501';
    end if;
    if new.assignee_id is distinct from old.assignee_id
       and not (old.assignee_id is null and new.assignee_id = auth.uid()) then
      raise exception 'Tu rol solo puede tomar un ticket sin asignar; reasignar lo hace un analista o el administrador.' using errcode = '42501';
    end if;
    if old.status <> 'Borrador' and (
          coalesce(new.change_impact, 2)     is distinct from coalesce(old.change_impact, 2)
       or coalesce(new.change_complexity, 2) is distinct from coalesce(old.change_complexity, 2)
       or coalesce(new.change_hours, 2)      is distinct from coalesce(old.change_hours, 2)
       or coalesce(new.change_rollback, '')  is distinct from coalesce(old.change_rollback, '')
       or date_trunc('milliseconds', new.change_start) is distinct from date_trunc('milliseconds', old.change_start)) then
      raise exception 'El plan del cambio solo se edita en Borrador; después lo gestiona un analista.' using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status then
    -- Mismo flujo que transitions() en js/novadesk.js; «staff» = administrador o analista.
    ok := case when new.type = 'C' then
             (old.status = 'Borrador'      and new.status = 'En evaluación')
          or (old.status = 'En evaluación' and new.status in ('Aprobado', 'Rechazado') and staff)
          or (old.status = 'Aprobado'      and new.status = 'Programado' and staff)
          or (old.status = 'Programado'    and new.status = 'Implementando')
          or (old.status = 'Implementando' and new.status in ('Implementado', 'Programado'))
          or (old.status = 'Implementado'  and new.status = 'Cerrado' and staff)
          or (old.status = 'Rechazado'     and new.status = 'Borrador' and staff)
        else
             (old.status = 'Nuevo'     and new.status = 'Asignado' and staff)
          or (old.status = 'Nuevo'     and new.status = 'En curso' and not staff)
          or (old.status = 'Asignado'  and new.status = 'En curso')
          or (old.status = 'En curso'  and new.status in ('En espera', 'Resuelto'))
          or (old.status = 'En espera' and new.status = 'En curso')
          or (old.status = 'Resuelto'  and new.status = 'Cerrado' and staff)
          or (old.status = 'Resuelto'  and new.status = 'En curso')
          or (old.status = 'Cerrado'   and new.status = 'En curso' and staff)
        end;
    if not coalesce(ok, false) then
      raise exception 'Ese cambio de estado (% → %) no está permitido para tu rol o por el flujo.', old.status, new.status using errcode = '42501';
    end if;
    if new.status in ('Resuelto', 'Implementado') then new.resolved_at := now();
    elsif new.status in ('En curso', 'Implementando') then new.resolved_at := null;
    else new.resolved_at := old.resolved_at;
    end if;
  else
    new.resolved_at := old.resolved_at;
  end if;

  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists tickets_guard on public.tickets;
create trigger tickets_guard before update on public.tickets
for each row execute function public.tickets_guard();

-- ───────────── 4) Registros que solo se agregan: la fecha la pone el servidor ─────────────
-- clock_timestamp() (y no now()) para que varias filas de un mismo guardado conserven su orden.
create or replace function public.stamp_created_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then new.created_at := clock_timestamp(); end if;
  return new;
end $$;

drop trigger if exists stamp_created_at on public.ticket_comments;
create trigger stamp_created_at before insert on public.ticket_comments for each row execute function public.stamp_created_at();
drop trigger if exists stamp_created_at on public.ticket_history;
create trigger stamp_created_at before insert on public.ticket_history  for each row execute function public.stamp_created_at();
drop trigger if exists stamp_created_at on public.change_approvals;
create trigger stamp_created_at before insert on public.change_approvals for each row execute function public.stamp_created_at();
drop trigger if exists stamp_created_at on public.audit_log;
create trigger stamp_created_at before insert on public.audit_log        for each row execute function public.stamp_created_at();

-- Las funciones de disparador no se llaman a mano (y tampoco quedan expuestas como API).
revoke execute on function public.tickets_before_insert(), public.tickets_guard(), public.stamp_created_at()
  from public, anon, authenticated;

-- ───────────── Deshacer (volver a las reglas de schema.sql) ─────────────
-- drop trigger if exists tickets_guard on public.tickets;
-- drop trigger if exists tickets_before_insert on public.tickets;
-- drop trigger if exists stamp_created_at on public.ticket_comments;
-- drop trigger if exists stamp_created_at on public.ticket_history;
-- drop trigger if exists stamp_created_at on public.change_approvals;
-- drop trigger if exists stamp_created_at on public.audit_log;
-- drop function if exists public.tickets_guard(), public.tickets_before_insert(), public.stamp_created_at();
-- create or replace function public.can_see_ticket(p_id text) returns boolean
-- language sql stable security definer set search_path = public as $$
--   select app_role() in ('admin','analista')
--       or exists (select 1 from tickets t where t.id = p_id and (t.assignee_id = auth.uid() or t.created_by = auth.uid()))
-- $$;
-- drop policy if exists clients_read on public.clients;
-- create policy clients_read on public.clients for select to authenticated using (true);
-- drop policy if exists profiles_read on public.profiles;
-- create policy profiles_read on public.profiles for select to authenticated using (true);
-- drop policy if exists tickets_insert on public.tickets;
-- create policy tickets_insert on public.tickets for insert to authenticated with check (created_by = auth.uid() and app_role() is not null);
-- drop policy if exists audit_insert on public.audit_log;
-- create policy audit_insert on public.audit_log for insert to authenticated with check (actor_id = auth.uid());
