// NovaDesk · Edge Function «admin-users»
// Permite que un ADMINISTRADOR cree usuarios y restablezca contraseñas desde la app, sin entrar a Supabase.
// Corre en el servidor: usa la clave secreta (SUPABASE_SERVICE_ROLE_KEY, inyectada por Supabase), que nunca llega al navegador.
// El token se valida aquí mismo (admin.auth.getUser) y además se exige rol admin.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const ROLES = ['admin', 'analista', 'tecnico'];
const DOMAIN = '@novadesk.local';

function tempPassword(): string {
  const set = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', sym = '!@#$%&*?';
  const r = crypto.getRandomValues(new Uint32Array(14));
  const s = [...r.slice(0, 12)].map((n) => set[n % set.length]).join('') + sym[r[12] % sym.length] + (r[13] % 10);
  return /[a-z]/.test(s) && /[A-Z]/.test(s) ? s : tempPassword();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: caller, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !caller?.user) return json({ error: 'Sesión inválida. Vuelve a iniciar sesión.' }, 401);
  const { data: me } = await admin.from('profiles').select('role, active').eq('id', caller.user.id).maybeSingle();
  if (!me?.active || me.role !== 'admin') return json({ error: 'Solo un administrador puede hacer esto.' }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Solicitud inválida.' }, 400); }
  const audit = (text: string) => admin.from('audit_log').insert({ actor_id: caller.user.id, text });

  if (body.action === 'create') {
    const name = String(body.name || '').trim().slice(0, 100);
    const login = String(body.login || '').trim().toLowerCase();
    const email = login.includes('@') ? login : login + DOMAIN;
    const username = email.split('@')[0];
    const role = String(body.role || '');
    const skills = Array.isArray(body.skills) ? body.skills.filter((s) => typeof s === 'string').slice(0, 20) : [];
    if (!name) return json({ error: 'Falta el nombre.' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'El correo no es válido.' }, 400);
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json({ error: 'Usuario inválido (minúsculas, números, punto o guion; 3 a 30 caracteres).' }, 400);
    if (!ROLES.includes(role)) return json({ error: 'Rol inválido.' }, 400);

    const { data: dup } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
    if (dup) return json({ error: 'Ya existe un usuario con ese nombre.' }, 409);

    const password = tempPassword();
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { name },
    });
    if (cErr || !created?.user) {
      const msg = /already|registered|exists/i.test(cErr?.message || '') ? 'Ya existe una cuenta con ese correo.' : 'No se pudo crear el usuario: ' + (cErr?.message || 'error desconocido');
      return json({ error: msg }, 400);
    }
    const { error: pErr } = await admin.from('profiles').update({
      name, role, active: true, skills: role === 'tecnico' ? skills : [], must_change: true,
    }).eq('id', created.user.id);
    if (pErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      return json({ error: 'No se pudo guardar el perfil: ' + pErr.message }, 500);
    }
    await audit('Creó al usuario ' + name + ' (' + role + ')');
    return json({ id: created.user.id, username, login: email.endsWith(DOMAIN) ? username : email, password });
  }

  if (body.action === 'reset') {
    const id = String(body.id || '');
    const { data: target } = await admin.from('profiles').select('id, name, username').eq('id', id).maybeSingle();
    if (!target) return json({ error: 'Usuario no encontrado.' }, 404);
    const { data: au } = await admin.auth.admin.getUserById(id);
    if (!au?.user) return json({ error: 'Cuenta de acceso no encontrada.' }, 404);
    const password = tempPassword();
    const { error: uErr } = await admin.auth.admin.updateUserById(id, { password });
    if (uErr) return json({ error: 'No se pudo restablecer: ' + uErr.message }, 500);
    await admin.from('profiles').update({ must_change: true }).eq('id', id);
    await audit('Restableció la contraseña de ' + target.name);
    const email = au.user.email || '';
    return json({ login: email.endsWith(DOMAIN) ? target.username : email, password });
  }

  return json({ error: 'Acción desconocida.' }, 400);
});
