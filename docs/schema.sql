-- NovaDesk · esquema PostgreSQL (pensado para Supabase, plan gratuito)
-- Ejecutar completo en Supabase > SQL Editor. Sin ejecutar ni probar todavía: es el diseño.
-- Mapea 1 a 1 los objetos que hoy viven en localStorage (js/novadesk.js: seed(), createTicket(), log()).

-- ───────────── Catálogos y personas ─────────────
create table public.clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  code        text not null unique,
  color       text not null default '#888888',
  contact     text,
  sla_factor  numeric(4,2) not null default 1,      -- 0.75 = SLA 25 % más exigente (Bupa)
  active      boolean not null default true
);

-- Un perfil por usuario de Supabase Auth. La contraseña vive en auth.users (nunca en esta tabla).
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9._-]{3,30}$'),
  name         text not null,
  role         text not null check (role in ('admin','analista','tecnico')),
  active       boolean not null default true,
  skills       text[] not null default '{}',        -- categorías que atiende (usado por Nova)
  must_change  boolean not null default true,       -- contraseña temporal pendiente de cambio
  last_login   timestamptz,
  created_at   timestamptz not null default now()
);

-- ───────────── Tickets ─────────────
create table public.ticket_counters (
  type  text primary key check (type in ('R','I','C')),
  last  integer not null default 0
);
insert into public.ticket_counters(type) values ('R'),('I'),('C');

-- ID atómico tipo I-0001 (reemplaza S.seq del front-end; evita duplicados con varios usuarios a la vez).
create function public.next_ticket_id(p_type text) returns text
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update ticket_counters set last = last + 1 where type = p_type returning last into n;
  return p_type || '-' || lpad(n::text, 4, '0');
end $$;

create table public.tickets (
  id             text primary key,                  -- 'I-0001'
  type           text not null check (type in ('R','I','C')),
  title          text not null,
  description    text not null default '',
  client_id      uuid not null references public.clients(id),
  requester      text not null,
  priority       smallint not null default 3 check (priority between 1 and 4),  -- 1 Crítica … 4 Baja
  status         text not null,
  category       text not null default 'General',
  assignee_id    uuid references public.profiles(id),
  created_by     uuid not null references public.profiles(id),
  ai_confidence  smallint,                          -- % de confianza de Nova si clasificó
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  -- Solo para tipo C (Control de cambios)
  change_impact      smallint check (change_impact between 1 and 3),
  change_complexity  smallint check (change_complexity between 1 and 3),
  change_start       timestamptz,
  change_hours       numeric(5,1),
  change_rollback    text
);
create index on public.tickets (client_id, created_at);
create index on public.tickets (assignee_id);
create index on public.tickets (status);

create table public.ticket_comments (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   text not null references public.tickets(id) on delete cascade,
  author_id   uuid not null references public.profiles(id),
  body        text not null,
  internal    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on public.ticket_comments (ticket_id, created_at);

-- Historial de estados/acciones: base para medir tiempos en Power BI.
create table public.ticket_history (
  id          bigint generated always as identity primary key,
  ticket_id   text not null references public.tickets(id) on delete cascade,
  actor_id    uuid references public.profiles(id),
  text        text not null,
  to_status   text,                                  -- se llena cuando la acción cambia el estado
  created_at  timestamptz not null default now()
);
create index on public.ticket_history (ticket_id, created_at);

create table public.change_approvals (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   text not null references public.tickets(id) on delete cascade,
  approver_id uuid not null references public.profiles(id),
  decision    text not null check (decision in ('Aprobado','Rechazado')),
  note        text not null default '',
  created_at  timestamptz not null default now()
);

create table public.audit_log (                       -- registro de seguridad (login, contraseñas, usuarios)
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles(id),
  text        text not null,
  created_at  timestamptz not null default now()
);

-- ───────────── Seguridad por fila (RLS) ─────────────
create function public.app_role() returns text
language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() and active $$;

create function public.can_see_ticket(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_role() in ('admin','analista')
      or exists (select 1 from tickets t
                 where t.id = p_id and (t.assignee_id = auth.uid() or t.created_by = auth.uid()))
$$;

alter table public.clients          enable row level security;
alter table public.profiles         enable row level security;
alter table public.tickets          enable row level security;
alter table public.ticket_comments  enable row level security;
alter table public.ticket_history   enable row level security;
alter table public.change_approvals enable row level security;
alter table public.audit_log        enable row level security;
alter table public.ticket_counters  enable row level security;   -- sin políticas: solo next_ticket_id() la toca

create policy clients_read   on public.clients  for select to authenticated using (true);
create policy clients_admin  on public.clients  for all    to authenticated using (app_role() = 'admin') with check (app_role() = 'admin');

create policy profiles_read  on public.profiles for select to authenticated using (true);
create policy profiles_admin on public.profiles for all    to authenticated using (app_role() = 'admin') with check (app_role() = 'admin');

-- El técnico solo ve lo asignado a él o creado por él (igual que hoy en la app).
create policy tickets_read   on public.tickets for select to authenticated using (can_see_ticket(id));
create policy tickets_insert on public.tickets for insert to authenticated with check (created_by = auth.uid() and app_role() is not null);
create policy tickets_update on public.tickets for update to authenticated using (can_see_ticket(id)) with check (can_see_ticket(id));
create policy tickets_delete on public.tickets for delete to authenticated using (app_role() = 'admin');

create policy comments_read   on public.ticket_comments  for select to authenticated using (can_see_ticket(ticket_id));
create policy comments_insert on public.ticket_comments  for insert to authenticated with check (author_id = auth.uid() and can_see_ticket(ticket_id));
create policy history_read    on public.ticket_history   for select to authenticated using (can_see_ticket(ticket_id));
create policy history_insert  on public.ticket_history   for insert to authenticated with check (actor_id = auth.uid() and can_see_ticket(ticket_id));
create policy approvals_read  on public.change_approvals for select to authenticated using (can_see_ticket(ticket_id));
create policy approvals_insert on public.change_approvals for insert to authenticated
  with check (approver_id = auth.uid() and app_role() in ('admin','analista'));

create policy audit_read   on public.audit_log for select to authenticated using (app_role() = 'admin');
create policy audit_insert on public.audit_log for insert to authenticated with check (actor_id = auth.uid());

-- ───────────── Capa para Power BI (esquema aparte: la API de Supabase NO lo expone) ─────────────
create schema bi;

create view bi.tickets as
select t.id, t.type,
       case t.type when 'R' then 'Requerimiento' when 'I' then 'Incidente' else 'Control de cambios' end as tipo,
       t.title, c.name as cliente, t.category as categoria, t.status as estado,
       case t.priority when 1 then 'Crítica' when 2 then 'Alta' when 3 then 'Media' else 'Baja' end as prioridad,
       t.requester as solicitante, a.name as asignado_a, cr.name as creado_por,
       t.created_at, t.resolved_at,
       round((extract(epoch from (coalesce(t.resolved_at, now()) - t.created_at)) / 3600)::numeric, 1) as horas_transcurridas,
       -- SLA objetivo = horas base por prioridad × factor del cliente (mismos valores que SLA_H en la app)
       round(((case t.priority when 1 then 4 when 2 then 8 when 3 then 24 else 72 end) * c.sla_factor)::numeric, 1) as sla_horas,
       (t.resolved_at is null) as abierto,
       t.ai_confidence
from public.tickets t
join public.clients c       on c.id = t.client_id
left join public.profiles a  on a.id = t.assignee_id
left join public.profiles cr on cr.id = t.created_by;

create view bi.ticket_estado_historial as
select h.ticket_id, h.to_status as estado, h.created_at, p.name as actor
from public.ticket_history h left join public.profiles p on p.id = h.actor_id
where h.to_status is not null;

create view bi.comentarios as
select ticket_id, created_at from public.ticket_comments;

-- Usuario de solo lectura para Power BI (cambiar la clave por una larga y guardarla en un gestor de contraseñas).
create role powerbi_reader login password 'CAMBIAR-POR-CLAVE-LARGA';
grant usage on schema bi to powerbi_reader;
grant select on all tables in schema bi to powerbi_reader;
-- Las vistas pertenecen al dueño y saltan el RLS: por eso powerbi_reader solo recibe permiso sobre bi.*,
-- nunca sobre public.*. El filtro por cliente se hace después en Power BI (RLS del modelo) si hace falta.
