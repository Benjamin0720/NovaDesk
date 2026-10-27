-- NovaDesk · migración 2 (ejecutar DESPUÉS de schema.sql): lo que necesita la app conectada a Supabase.

-- 1) Al crear un usuario en Supabase → Authentication → Users se crea su perfil en NovaDesk.
--    El "usuario" de NovaDesk es lo anterior a la @ del correo (p. ej. benjamin@novadesk.local → benjamin).
--    Nace INACTIVO y sin rol privilegiado: un administrador lo activa y le asigna rol desde la pantalla Usuarios.
--    Así, aunque alguien lograra registrarse con la clave pública, no tendría acceso a ningún dato.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare u text := lower(split_part(new.email, '@', 1));
begin
  insert into public.profiles (id, username, name, role, active, must_change)
  values (new.id, u,
          coalesce(nullif(new.raw_user_meta_data->>'name', ''), initcap(replace(replace(u, '.', ' '), '_', ' '))),
          'tecnico', false, true);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- 2) Acciones que un usuario normal hace sobre su propio perfil (sin poder cambiar su rol).
create function public.touch_login() returns void
language sql security definer set search_path = public as
$$ update profiles set last_login = now() where id = auth.uid() $$;

create function public.clear_must_change() returns void
language sql security definer set search_path = public as
$$ update profiles set must_change = false where id = auth.uid() $$;

-- 3) El número de ticket solo lo pide un usuario activo.
create or replace function public.next_ticket_id(p_type text) returns text
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if app_role() is null then raise exception 'usuario no autorizado'; end if;
  update ticket_counters set last = last + 1 where type = p_type returning last into n;
  if n is null then raise exception 'tipo de ticket inválido'; end if;
  return p_type || '-' || lpad(n::text, 4, '0');
end $$;

-- 4) Las funciones no deben ser invocables sin iniciar sesión.
revoke execute on function public.next_ticket_id(text), public.touch_login(), public.clear_must_change(),
  public.app_role(), public.can_see_ticket(text) from public, anon;
grant execute on function public.next_ticket_id(text), public.touch_login(), public.clear_must_change(),
  public.app_role(), public.can_see_ticket(text) to authenticated;

-- 5) Clientes iniciales.
insert into public.clients (name, code, color, contact, sla_factor) values
  ('Bupa',   'BUPA', '#4da3ff', 'soporte@bupa.example',      0.75),
  ('Curico', 'CUR',  '#ff8a4d', 'ti@curico.example',         1),
  ('HAH',    'HAH',  '#2de2a6', 'informatica@hah.example',   1);
