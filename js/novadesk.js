/* NovaDesk — mesa de ayuda con Requerimientos, Incidentes y Control de Cambios.
   Front-end estático; datos y login en Supabase (PostgreSQL + Auth). Nova = motor de clasificación local. */
(() => {
'use strict';
const THEME_KEY = 'novadesk.theme';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = 3600e3, D = 24 * H;

/* ───────────── Catálogos ───────────── */
const TYPES = {
  R: { name: 'Requerimiento', plural: 'Requerimientos', icon: '📨' },
  I: { name: 'Incidente', plural: 'Incidentes', icon: '🔥' },
  C: { name: 'Control de cambios', plural: 'Cambios', icon: '🔀' },
};
const PRIO = { 1: 'Crítica', 2: 'Alta', 3: 'Media', 4: 'Baja' };
const SLA_H = { 1: 4, 2: 8, 3: 24, 4: 72 };
const FLOW = {
  RI: ['Nuevo', 'Asignado', 'En curso', 'En espera', 'Resuelto', 'Cerrado'],
  C: ['Borrador', 'En evaluación', 'Aprobado', 'Programado', 'Implementando', 'Implementado', 'Cerrado'],
};
const flowOf = t => (t.type === 'C' ? FLOW.C : FLOW.RI);
const CATS = ['Red y conectividad', 'Impresión', 'Correo y colaboración', 'Accesos y cuentas', 'Hardware / Equipos',
  'Software y aplicaciones', 'Base de datos', 'Seguridad', 'Servidores e infraestructura', 'Telefonía', 'General'];
const ROLES = {
  admin: { name: 'Administrador', icon: '👑', desc: 'Control total: usuarios, clientes, tickets y configuración.' },
  analista: { name: 'Analista', icon: '🧭', desc: 'Clasifica, asigna, aprueba cambios (CAB) y supervisa SLA.' },
  tecnico: { name: 'Técnico', icon: '🛠️', desc: 'Ve sus tickets asignados, los trabaja, comenta y resuelve.' },
};
const OPEN_NOT = ['Resuelto', 'Cerrado', 'Rechazado', 'Implementado'];
const isOpen = t => !OPEN_NOT.includes(t.status);

/* ───────────── Estado y persistencia ───────────── */
let S = { users: [], clients: [], tickets: [], audit: [], session: null };
const ui = { view: 'dashboard', f: { q: '', type: '', status: 'abiertos', client: '', prio: '', assignee: '' }, boardType: 'I', open: null, overlay: null, draft: null, booting: true };
const uid = () => crypto.randomUUID();
const me = () => S.users.find(u => u.id === S.session);
const role = () => me()?.role;
const staff = () => role() !== 'tecnico';
const client = id => S.clients.find(c => c.id === id) || { name: '—', color: '#888', slaFactor: 1 };
const user = id => S.users.find(u => u.id === id);
/* A los tickets se les puede asignar cualquier usuario activo: el administrador actúa también como analista. */
const assignable = () => S.users.filter(u => u.active);
const uLabel = u => u.name + (u.role === 'tecnico' ? '' : ` (${ROLES[u.role].name})`);

/* ───────────── Supabase: datos, sesión y sincronización ─────────────
   El resto de la app trabaja sobre el estado en memoria `S` (como antes). Cada save() sube a la base solo lo que
   cambió (comparando contra `snap`) y cada ~45 s se vuelve a leer lo que otros usuarios hayan hecho. */
const CFG = window.NOVADESK_CONFIG || {};
const sb = window.supabase && CFG.url && CFG.key
  ? window.supabase.createClient(CFG.url, CFG.key, { auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
  : null;
const EMAIL_DOMAIN = '@novadesk.local';
const toIso = t => (t == null ? null : new Date(t).toISOString());
const toMs = s => (s ? new Date(s).getTime() : null);

const clientRow = c => ({ id: c.id, name: c.name, code: c.code, color: c.color, contact: c.contact || null, sla_factor: c.slaFactor, active: true });
const fromClient = r => ({ id: r.id, name: r.name, code: r.code, color: r.color, contact: r.contact || '', slaFactor: Number(r.sla_factor) });
const userRow = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, skills: u.skills, must_change: !!u.mustChange });
const fromUser = r => ({ id: r.id, username: r.username, name: r.name, role: r.role, active: r.active, skills: r.skills || [], mustChange: r.must_change, lastLogin: toMs(r.last_login) });
const ticketRow = t => ({ id: t.id, type: t.type, title: t.title, description: t.desc, client_id: t.clientId, requester: t.requester, priority: t.priority, status: t.status,
  category: t.category, assignee_id: t.assigneeId || null, created_by: t.createdBy, ai_confidence: t.ai ?? null, created_at: toIso(t.createdAt), updated_at: toIso(t.updatedAt),
  resolved_at: toIso(t.resolvedAt), change_impact: t.change?.impact ?? null, change_complexity: t.change?.complexity ?? null, change_start: toIso(t.change?.start),
  change_hours: t.change?.hours ?? null, change_rollback: t.change?.rollback ?? null });
function fromTicket(r) {
  const t = { id: r.id, type: r.type, title: r.title, desc: r.description, clientId: r.client_id, requester: r.requester, priority: r.priority, status: r.status, category: r.category,
    assigneeId: r.assignee_id, createdBy: r.created_by, createdAt: toMs(r.created_at), updatedAt: toMs(r.updated_at), resolvedAt: toMs(r.resolved_at), ai: r.ai_confidence, comments: [], history: [] };
  if (r.type === 'C') t.change = { impact: r.change_impact || 2, complexity: r.change_complexity || 2, start: toMs(r.change_start), hours: r.change_hours == null ? 2 : Number(r.change_hours), rollback: r.change_rollback || '', approvals: [] };
  return t;
}

let snap = { clients: {}, users: {}, tickets: {} }, myRole = null, syncQ = Promise.resolve(), pending = 0, rev = 0;
const failed = e => { console.error(e); toast('No se pudo guardar en el servidor: ' + (e.message || e)); };
async function fetchAll(table, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select('*').range(from, from + 999); order.forEach(o => { q = q.order(o); });
    const { data, error } = await q; if (error) throw error;
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
}
async function fetchData(isAdmin) {
  const audit = isAdmin ? sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200).then(r => { if (r.error) throw r.error; return r.data.reverse(); }) : [];
  const [cl, us, tk, cm, hs, ap, au] = await Promise.all([fetchAll('clients', ['name']), fetchAll('profiles', ['name']), fetchAll('tickets', ['created_at', 'id']),
    fetchAll('ticket_comments', ['created_at', 'id']), fetchAll('ticket_history', ['created_at', 'id']), fetchAll('change_approvals', ['created_at', 'id']), audit]);
  return { cl, us, tk, cm, hs, ap, au };
}
function applyData(d) {
  S.clients = d.cl.map(fromClient); S.users = d.us.map(fromUser); S.tickets = d.tk.map(fromTicket);
  const by = Object.fromEntries(S.tickets.map(t => [t.id, t]));
  d.cm.forEach(c => by[c.ticket_id]?.comments.push({ id: c.id, by: c.author_id, at: toMs(c.created_at), text: c.body, internal: c.internal }));
  d.hs.forEach(h => by[h.ticket_id]?.history.push({ at: toMs(h.created_at), by: h.actor_id, text: h.text }));
  d.ap.forEach(a => by[a.ticket_id]?.change?.approvals.push({ by: a.approver_id, at: toMs(a.created_at), decision: a.decision, note: a.note }));
  S.audit = d.au.map(a => ({ at: toMs(a.created_at), by: a.actor_id, text: a.text, sent: true }));
  snap = { clients: {}, users: {}, tickets: {} };
  S.clients.forEach(c => { snap.clients[c.id] = JSON.stringify(clientRow(c)); });
  S.users.forEach(u => { snap.users[u.id] = JSON.stringify(userRow(u)); });
  S.tickets.forEach(t => { snap.tickets[t.id] = { core: JSON.stringify(ticketRow(t)), cids: new Set(t.comments.map(c => c.id)), nh: t.history.length, na: t.change?.approvals.length || 0 }; });
}
const run = async p => { const { error } = await p; if (error) throw error; };
async function pushChanges() {
  if (!S.session) return;
  if (myRole === 'admin') {
    for (const c of S.clients) { const row = clientRow(c), k = JSON.stringify(row); if (snap.clients[c.id] !== k) { await run(sb.from('clients').upsert(row)); snap.clients[c.id] = k; } }
    for (const u of S.users) { const row = userRow(u), k = JSON.stringify(row); if (snap.users[u.id] && snap.users[u.id] !== k) { await run(sb.from('profiles').update(row).eq('id', u.id)); snap.users[u.id] = k; } }
  }
  for (const t of S.tickets) {
    const row = ticketRow(t), k = JSON.stringify(row); let s = snap.tickets[t.id];
    if (!s) { await run(sb.from('tickets').insert(row)); s = snap.tickets[t.id] = { core: k, cids: new Set(), nh: 0, na: 0 }; }
    else if (s.core !== k) { await run(sb.from('tickets').update(row).eq('id', t.id)); s.core = k; }
    const newH = t.history.slice(s.nh);
    if (newH.length) { await run(sb.from('ticket_history').insert(newH.map(h => ({ ticket_id: t.id, actor_id: h.by, text: h.text, to_status: (/^Estado: .* → (.*)$/.exec(h.text) || [])[1] || null, created_at: toIso(h.at) })))); s.nh = t.history.length; }
    const newC = t.comments.filter(c => !s.cids.has(c.id));
    if (newC.length) { await run(sb.from('ticket_comments').insert(newC.map(c => ({ id: c.id, ticket_id: t.id, author_id: c.by, body: c.text, internal: !!c.internal, created_at: toIso(c.at) })))); newC.forEach(c => s.cids.add(c.id)); }
    const aps = t.change?.approvals || [], newA = aps.slice(s.na);
    if (newA.length) { await run(sb.from('change_approvals').insert(newA.map(a => ({ ticket_id: t.id, approver_id: a.by, decision: a.decision, note: a.note || '', created_at: toIso(a.at) })))); s.na = aps.length; }
  }
  const newAu = S.audit.filter(a => !a.sent && a.by);
  if (newAu.length) { await run(sb.from('audit_log').insert(newAu.map(a => ({ actor_id: a.by, text: a.text, created_at: toIso(a.at) })))); newAu.forEach(a => { a.sent = true; }); }
}
/* Sube los cambios en segundo plano (la pantalla se actualiza al instante); si falla, vuelve a leer del servidor. */
function save() {
  if (!S.session) return;
  rev++; pending++;
  syncQ = syncQ.then(pushChanges).catch(async e => { failed(e); try { applyData(await fetchData(myRole === 'admin')); } catch {} render(); }).finally(() => { pending--; });
}
window.addEventListener('beforeunload', e => { if (pending) { e.preventDefault(); e.returnValue = ''; } });
/* Relee los datos del servidor (cambios de otros usuarios) sin pisar nada que el usuario esté editando. */
async function refresh() {
  if (!S.session || pending || ui.overlay || ui.view === 'new' || document.hidden || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  const r0 = rev;
  try { const d = await fetchData(myRole === 'admin'); if (rev === r0 && !pending && S.session) { applyData(d); render(); } } catch (e) { console.warn('refresh', e); }
}
setInterval(refresh, 45000);

async function enter(uid_, fresh) {
  const { data: p, error } = await sb.from('profiles').select('*').eq('id', uid_).maybeSingle();
  if (error) throw error;
  if (!p || !p.active) { await sb.auth.signOut(); throw new Error('inactive'); }
  myRole = p.role; applyData(await fetchData(p.role === 'admin'));
  S.session = uid_;
  if (fresh) { me().lastLogin = Date.now(); ui.view = 'dashboard'; ui.open = null; ui.overlay = null; audit('Inicio de sesión', uid_); sb.rpc('touch_login').then(() => {}, () => {}); save(); }
  touch();
}
async function boot() {
  try {
    if (!sb) throw new Error('No se pudo cargar la conexión a Supabase (revisa tu internet y js/config.js).');
    const { data: { session } } = await sb.auth.getSession();
    let ss = null; try { ss = JSON.parse(sessionStorage.getItem(SESS_KEY)); } catch {}
    if (session && ss && ss.id === session.user.id && Date.now() - ss.last < IDLE) await enter(session.user.id, false);
    else if (session) await sb.auth.signOut();
  } catch (e) { ui.loginError = e.message === 'inactive' ? 'Tu cuenta está inactiva. Contacta al administrador.' : String(e.message || e); }
  ui.booting = false; render();
}

/* ───────────── Seguridad: contraseñas y sesión ─────────────
   Las contraseñas las maneja Supabase Auth (hash en el servidor, nunca en esta app ni en la tabla profiles). */
const SESS_KEY = 'novadesk.session', IDLE = 15 * 60e3;
function pwProblems(pw) {
  const p = [];
  if (pw.length < 10) p.push('mínimo 10 caracteres'); if (!/[a-z]/.test(pw)) p.push('una minúscula'); if (!/[A-Z]/.test(pw)) p.push('una mayúscula');
  if (!/\d/.test(pw)) p.push('un número'); if (!/[^A-Za-z0-9]/.test(pw)) p.push('un símbolo');
  return p;
}
const audit = (text, by) => { S.audit.push({ at: Date.now(), by: by === undefined ? S.session : by, text }); S.audit = S.audit.slice(-200); };
let lastActive = Date.now();
function touch() { lastActive = Date.now(); if (S.session) try { sessionStorage.setItem(SESS_KEY, JSON.stringify({ id: S.session, last: lastActive })); } catch {} }
function endSession(msg) {
  if (S.session) audit(msg || 'Cierre de sesión');
  save(); S.session = null; ui.open = null; ui.overlay = null; try { sessionStorage.removeItem(SESS_KEY); } catch {}
  syncQ = syncQ.then(() => sb.auth.signOut()).catch(() => {}).then(() => { if (!S.session) { S.users = []; S.clients = []; S.tickets = []; S.audit = []; myRole = null; snap = { clients: {}, users: {}, tickets: {} }; } });
}
setInterval(() => { if (S && S.session && Date.now() - lastActive > IDLE) { endSession('Sesión cerrada por inactividad'); ui.loginError = 'Tu sesión se cerró por inactividad. Ingresa nuevamente.'; render(); } }, 20000);
const theme = () => localStorage.getItem(THEME_KEY) || 'dark';
const applyTheme = () => document.documentElement.setAttribute('data-theme', theme());

/* ───────────── Nova: motor de clasificación ───────────── */
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const has = (text, kw) => new RegExp('(^|[^a-z0-9])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(s|es)?([^a-z0-9]|$)').test(text);
const CAT_KW = {
  'Red y conectividad': ['red', 'internet', 'wifi', 'vpn', 'conexion', 'switch', 'router', 'enlace', 'latencia', 'firewall', 'ping', 'sin conexion'],
  'Impresión': ['impresora', 'imprimir', 'imprime', 'toner', 'impresion', 'etiqueta', 'zebra', 'cola de impresion'],
  'Correo y colaboración': ['correo', 'outlook', 'mail', 'teams', 'calendario', 'buzon', 'spam', 'sincroniza'],
  'Accesos y cuentas': ['contrasena', 'clave', 'usuario', 'acceso', 'cuenta', 'permiso', 'perfil', 'active directory', 'login', 'mfa', 'credencial', 'alta de'],
  'Hardware / Equipos': ['pc', 'notebook', 'computador', 'monitor', 'teclado', 'mouse', 'disco duro', 'pantalla azul', 'equipo', 'ups', 'lector', 'tablet'],
  'Software y aplicaciones': ['aplicacion', 'sistema', 'software', 'instalar', 'instalacion', 'licencia', 'excel', 'office', 'erp', 'his', 'ris', 'pacs', 'agenda', 'ficha'],
  'Base de datos': ['base de datos', 'sql', 'query', 'respaldo', 'backup', 'replica', 'oracle', 'tablespace'],
  'Seguridad': ['virus', 'malware', 'phishing', 'ransomware', 'antivirus', 'intrusion', 'sospechoso', 'vulnerabilidad', 'cifrado', 'hackeo'],
  'Servidores e infraestructura': ['servidor', 'vm', 'vmware', 'storage', 'datacenter', 'cpu', 'memoria', 'cluster', 'hipervisor', 'disco lleno', 'firmware'],
  'Telefonía': ['telefono', 'anexo', 'central telefonica', 'voip', 'llamada', 'ip phone'],
};
const TYPE_KW = {
  I: ['no funciona', 'no anda', 'caido', 'caida', 'error', 'falla', 'fallando', 'lento', 'lentitud', 'intermitente', 'bloqueado', 'no puede', 'no pueden', 'no abre', 'no carga', 'sin conexion', 'sin acceso', 'se cayo', 'se cae', 'se congela', 'pantalla azul', 'no responde', 'no imprime', 'no enciende', 'dejo de', 'no sincroniza', 'sospechoso', 'sin enlace'],
  R: ['solicito', 'solicitud', 'necesito', 'necesitamos', 'requiero', 'alta de', 'crear', 'creacion', 'instalar', 'instalacion', 'habilitar', 'activar', 'entregar', 'nuevo', 'nueva', 'por favor', 'agregar', 'configurar', 'traslado', 'reporte', 'acceso a'],
  C: ['cambio', 'actualizar', 'actualizacion', 'migrar', 'migracion', 'ventana', 'implementar', 'despliegue', 'parche', 'upgrade', 'reemplazo', 'reemplazar', 'decomision', 'mantencion programada', 'rollback', 'produccion', 'firmware', 'nueva version', 'subir de version'],
};
const PLAYBOOK = {
  'Red y conectividad': ['Verificar enlace físico/puertos del switch y estado del equipo de borde', 'Hacer ping/traceroute al gateway y a un servicio externo', 'Revisar si hay otros tickets de red del mismo sitio (¿falla masiva?)'],
  'Impresión': ['Revisar cola de impresión y reiniciar el servicio Spooler', 'Confirmar conexión/IP de la impresora y consumibles', 'Probar reinstalando el driver en un equipo'],
  'Correo y colaboración': ['Revisar estado del servicio de correo en el tenant', 'Recrear el perfil de Outlook / limpiar caché', 'Verificar licencias y cuota del buzón'],
  'Accesos y cuentas': ['Validar identidad y aprobación del jefe directo', 'Revisar el estado de la cuenta en el directorio (bloqueo/expiración)', 'Aplicar perfil/rol estándar y documentar'],
  'Hardware / Equipos': ['Realizar diagnóstico de hardware (disco, RAM, temperatura)', 'Preparar equipo de reemplazo si el daño es físico', 'Registrar el activo y garantía'],
  'Software y aplicaciones': ['Reproducir el error y capturar mensaje/log', 'Confirmar si el fallo es de un usuario o de todos', 'Revisar últimos cambios o despliegues en la aplicación'],
  'Base de datos': ['Revisar espacio, bloqueos y jobs de respaldo', 'Validar réplica/estado del motor', 'Coordinar con el proveedor si impacta producción'],
  'Seguridad': ['Aislar los equipos afectados de la red', 'Forzar cambio de credenciales de usuarios impactados', 'Escalar a seguridad y preservar evidencia (correo/headers)'],
  'Servidores e infraestructura': ['Revisar CPU, memoria y disco del servidor/VM', 'Revisar eventos del hipervisor y snapshots', 'Confirmar respaldo reciente antes de intervenir'],
  'Telefonía': ['Verificar registro del anexo en la central', 'Probar el teléfono en otra boca de red', 'Revisar troncal si es falla general'],
  General: ['Contactar al solicitante para precisar el alcance', 'Definir categoría y prioridad con el cliente'],
};
function tokens(s) { return new Set(norm(s).split(/[^a-z0-9]+/).filter(w => w.length > 3)); }

function classify(text, clientId, opts = {}) {
  const n = norm(text), why = [], kws = [];
  // tipo
  const ts = { R: 0, I: 0, C: 0 };
  for (const k of Object.keys(TYPE_KW)) for (const w of TYPE_KW[k]) if (has(n, w)) { ts[k] += w.length > 7 ? 1.4 : 1; kws.push(w); }
  if (/(^|\W)(cambio|ventana|rollback|parche)/.test(n)) ts.C += 1;
  if (!ts.R && !ts.I && !ts.C) ts.I = 0.3;
  const sorted = Object.entries(ts).sort((a, b) => b[1] - a[1]);
  const type = sorted[0][0], tot = sorted.reduce((a, b) => a + b[1], 0) || 1;
  const typeConf = Math.min(0.97, 0.45 + (sorted[0][1] - sorted[1][1]) / tot * 0.5 + Math.min(sorted[0][1], 4) * 0.04);
  why.push(`Detecté lenguaje de ${TYPES[type].name.toLowerCase()} (${Math.round(typeConf * 100)}%)`);
  // categoría
  let cat = 'General', best = 0;
  for (const [c, list] of Object.entries(CAT_KW)) {
    let sc = 0; for (const w of list) if (has(n, w)) { sc += w.includes(' ') ? 2 : 1; kws.push(w); }
    if (sc > best) { best = sc; cat = c; }
  }
  const catConf = best ? Math.min(0.96, 0.5 + best * 0.14) : 0.3;
  if (best) why.push(`Vocabulario de «${cat}» (${best} coincidencias)`);
  // prioridad
  const CRIT = ['todos', 'toda la', 'caida total', 'paralizad', 'urgente', 'critico', 'ransomware', 'produccion', 'pacientes', 'urgencia', 'pabellon', 'sin sistema', 'masivo', 'no pueden trabajar', 'credenciales', 'hizo clic', 'hicieron clic', 'en todas'];
  const HIGH = ['varios', 'area', 'servicio', 'intermitente', 'bloqueado', 'no puede', 'no pueden', 'gerente', 'jefe', 'medicos', 'sin conexion', 'sin enlace'];
  const LOW = ['cuando pueda', 'sin apuro', 'consulta', 'duda', 'estetico', 'mejora', 'no urgente', 'reporte'];
  let p = type === 'R' ? 3.4 : 3;
  const hitsC = CRIT.filter(w => has(n, w)), hitsH = HIGH.filter(w => has(n, w)), hitsL = LOW.filter(w => has(n, w));
  p -= hitsC.length * 1.1 + hitsH.length * 0.55; p += hitsL.length * 1.2;
  if (type === 'C') p = Math.max(p, 2);
  if (has(n, 'emergencia')) p = 1;
  const priority = Math.max(1, Math.min(4, Math.round(p)));
  if (hitsC.length) why.push(`Señales de criticidad: «${hitsC.slice(0, 3).join('», «')}»`);
  else if (hitsH.length) why.push(`Señales de impacto: «${hitsH.slice(0, 3).join('», «')}»`);
  const impact = hitsC.some(w => ['todos', 'toda la', 'masivo', 'en todas', 'caida total'].includes(w)) ? 'Masivo (toda la sede)' : hitsH.length || hitsC.length ? 'Departamental' : 'Individual';
  // asignación sugerida
  const techs = S.users.filter(u => u.role === 'tecnico' && u.active);
  const load = u => S.tickets.filter(t => t.assigneeId === u.id && isOpen(t)).length;
  let assignee = null, bs = -1e9;
  for (const u of techs) { const sc = (u.skills.includes(cat) ? 3 : 0) - load(u) * 0.6; if (sc > bs) { bs = sc; assignee = u; } }
  if (assignee) why.push(`${assignee.name}: ${assignee.skills.includes(cat) ? 'domina ' + cat : 'menor carga'} (${load(assignee)} tickets activos)`);
  // similares
  const tk = tokens(text);
  const similar = S.tickets.filter(t => t.id !== opts.excludeId).map(t => {
    const o = tokens(t.title + ' ' + t.desc); let inter = 0; tk.forEach(w => o.has(w) && inter++);
    const sim = inter / (tk.size + o.size - inter || 1) + (t.clientId === clientId ? 0.05 : 0);
    return { t, sim };
  }).filter(x => x.sim > 0.14).sort((a, b) => b.sim - a.sim).slice(0, 3);
  // incidente mayor
  let major = null;
  if (type === 'I') {
    const same = S.tickets.filter(t => t.id !== opts.excludeId && t.type === 'I' && isOpen(t) && t.category === cat && t.clientId === clientId && Date.now() - t.createdAt < D);
    if (same.length >= 2) major = `Ya hay ${same.length} incidentes abiertos de «${cat}» para este cliente en 24 h: posible incidente mayor.`;
  }
  const actions = [...(PLAYBOOK[cat] || PLAYBOOK.General)];
  if (priority === 1) actions.unshift('Escalar al analista de guardia y notificar al cliente cada 30 minutos');
  if (type === 'C') actions.unshift('Exigir plan de rollback, ventana y aprobación CAB antes de ejecutar');
  return { type, typeConf, category: cat, catConf, priority, impact, assignee, why, keywords: [...new Set(kws)].slice(0, 8), similar, major, actions: actions.slice(0, 4),
    confidence: Math.round(((typeConf + catConf) / 2) * 100) };
}

/* ───────────── SLA, riesgo y transiciones ───────────── */
function slaInfo(t) {
  if (t.type === 'C') return null;
  const due = t.createdAt + SLA_H[t.priority] * H * (client(t.clientId).slaFactor || 1);
  const end = isOpen(t) ? Date.now() : (t.resolvedAt || t.updatedAt);
  const pct = (end - t.createdAt) / (due - t.createdAt);
  const left = due - Date.now();
  const st = !isOpen(t) ? (end <= due ? 'ok' : 'bad') : pct >= 1 ? 'bad' : pct >= 0.75 ? 'warn' : 'ok';
  const label = !isOpen(t) ? (end <= due ? 'Cumplido' : 'Incumplido') : left >= 0 ? `quedan ${dur(left)}` : `vencido hace ${dur(-left)}`;
  return { due, pct: Math.min(pct, 1), st, label };
}
const dur = ms => { const m = Math.round(ms / 60000); if (m < 60) return m + ' min'; if (m < 2880) return Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' m' : ''); return Math.round(m / 1440) + ' d'; };
const risk = c => { if (!c) return { n: 0, label: '—', col: 'var(--muted)' }; const s = c.impact + c.complexity + (c.rollback ? 0 : 2); return s <= 3 ? { n: s, label: 'Bajo', col: 'var(--ok)' } : s <= 5 ? { n: s, label: 'Medio', col: 'var(--warn)' } : { n: s, label: 'Alto', col: 'var(--bad)' }; };
function transitions(t) {
  const out = [], add = (to, label, cls = '') => out.push({ to, label, cls }), st = staff();
  if (t.type === 'C') {
    switch (t.status) {
      case 'Borrador': add('En evaluación', 'Enviar a evaluación (CAB)', 'pri'); break;
      case 'En evaluación': if (st) { add('Aprobado', '✔ Aprobar cambio', 'ok'); add('Rechazado', '✖ Rechazar', 'bad'); } break;
      case 'Aprobado': if (st) add('Programado', '📅 Programar ventana', 'pri'); break;
      case 'Programado': add('Implementando', '▶ Iniciar implementación', 'pri'); break;
      case 'Implementando': add('Implementado', '✔ Implementado', 'ok'); add('Programado', '↩ Revertir (rollback)', 'bad'); break;
      case 'Implementado': if (st) add('Cerrado', 'Cerrar cambio', 'pri'); break;
      case 'Rechazado': if (st) add('Borrador', 'Reabrir como borrador'); break;
    }
  } else {
    switch (t.status) {
      case 'Nuevo': if (st) add('Asignado', 'Asignar', 'pri'); else add('En curso', '▶ Tomar ticket', 'pri'); break;
      case 'Asignado': add('En curso', '▶ Iniciar trabajo', 'pri'); break;
      case 'En curso': add('En espera', '⏸ Poner en espera'); add('Resuelto', '✔ Resolver', 'ok'); break;
      case 'En espera': add('En curso', '▶ Reanudar', 'pri'); break;
      case 'Resuelto': if (st) add('Cerrado', 'Cerrar', 'pri'); add('En curso', '↩ Reabrir', 'bad'); break;
      case 'Cerrado': if (st) add('En curso', '↩ Reabrir', 'bad'); break;
    }
  }
  return out;
}
function log(t, text) { t.history.push({ at: Date.now(), by: S.session, text }); t.updatedAt = Date.now(); }
function setStatus(t, to, note) {
  if (!me() || !visible().includes(t)) return toast('No tienes acceso a este ticket'), false;
  if (!transitions(t).some(x => x.to === to)) return toast('Ese movimiento no está permitido por el flujo o tu rol'), false;
  if (t.type === 'C' && to === 'Programado' && !(t.change && t.change.start)) return toast('Define primero la ventana de implementación'), false;
  if (t.type === 'C' && to === 'En evaluación' && !(t.change && t.change.rollback)) return toast('Agrega el plan de rollback antes de enviar a evaluación'), false;
  if (t.type !== 'C' && ['Asignado', 'En curso'].includes(to) && !t.assigneeId) {
    const a = role() === 'tecnico' ? me() : classify(t.title + ' ' + t.desc, t.clientId, { excludeId: t.id }).assignee;
    if (a) { t.assigneeId = a.id; log(t, `Asignado a ${a.name}${role() === 'tecnico' ? '' : ' (sugerido por Nova)'}`); }
  }
  const from = t.status; t.status = to;
  if (['Resuelto', 'Implementado'].includes(to)) t.resolvedAt = Date.now(); if (['En curso', 'Implementando'].includes(to)) t.resolvedAt = null;
  if (t.type === 'C' && ['Aprobado', 'Rechazado'].includes(to)) { t.change = t.change || {}; (t.change.approvals = t.change.approvals || []).push({ by: S.session, at: Date.now(), decision: to, note: note || '' }); }
  log(t, `Estado: ${from} → ${to}`); save(); return true;
}
function changeConflicts(t) {
  if (t.type !== 'C' || !t.change?.start) return [];
  const s = t.change.start, e = s + (t.change.hours || 1) * H;
  return S.tickets.filter(o => o.id !== t.id && o.type === 'C' && o.change?.start && !['Cerrado', 'Rechazado', 'Implementado'].includes(o.status) && o.clientId === t.clientId && o.change.start < e && o.change.start + (o.change.hours || 1) * H > s);
}

/* ───────────── Utilidades de vista ───────────── */
const visible = () => (staff() ? S.tickets : S.tickets.filter(t => t.assigneeId === S.session || t.createdBy === S.session));
const fdate = ts => new Date(ts).toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const rel = ts => { const d = Date.now() - ts; return d < 0 ? 'en ' + dur(-d) : d < 60000 ? 'ahora' : 'hace ' + dur(d); };
const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = u => u ? `<span class="avatar" title="${esc(u.name)}" style="background:hsl(${hue(u.name)} 60% 50%)">${esc(u.name.split(' ').map(x => x[0]).slice(0, 2).join(''))}</span>` : '<span class="avatar" style="background:var(--bg2);color:var(--muted)">?</span>';
const tid = t => `<span class="tid ${t.type}">${t.id}</span>`;
const prioB = p => `<span class="badge p${p}">${PRIO[p]}</span>`;
const clientB = id => { const c = client(id); return `<span class="badge"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</span>`; };
const slaB = t => { const s = slaInfo(t); if (!s) { const c = t.change; return c?.start ? `<span class="sla">📅 ${fdate(c.start)}</span>` : '<span class="muted sm">sin ventana</span>'; } const col = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)' }[s.st]; return `<span class="sla"><i><b style="width:${s.pct * 100}%;background:${col}"></b></i><span style="color:${col}">${s.label}</span></span>`; };
function toast(msg) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; $('#toasts').appendChild(d); setTimeout(() => d.remove(), 3200); }

/* ───────────── Vistas ───────────── */
const NAV = [
  ['dashboard', '🌌', 'Panel'], ['tickets', '🎫', 'Tickets'], ['board', '🗂️', 'Tablero'], ['changes', '🔀', 'Cambios'],
  ['clients', '🏥', 'Clientes'], ['users', '👥', 'Usuarios', 'admin'],
];
function logo() { return '<svg width="34" height="34" viewBox="0 0 32 32"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#2de2e6"/></linearGradient></defs><path d="M16 2l3.2 10.2L30 16l-10.8 3.8L16 30l-3.2-10.2L2 16l10.8-3.8z" fill="url(#lg)"/><circle cx="16" cy="16" r="3" fill="#080818"/></svg>'; }

const authFrame = (title, sub, body) => `<div class="login"><div class="box" style="max-width:440px">
  <div class="orbit"><div style="position:absolute;inset:0;display:grid;place-items:center">${logo().replace('34', '46').replace('34', '46')}</div></div>
  <h1 style="font-size:42px">NovaDesk</h1><p class="muted">${sub}</p>
  <form class="card col" id="authForm" data-kind="${title}" autocomplete="on" style="text-align:left;margin-top:22px"><h2>${title === 'login' ? 'Iniciar sesión' : title === 'setup' ? 'Configuración inicial' : 'Crea tu contraseña'}</h2>${body}</form></div></div>`;
const pwField = (name, label, auto, id) => `<div><label>${label}</label><div class="row"><input ${id ? `id="${id}"` : ''} type="password" name="${name}" autocomplete="${auto}" required><button type="button" class="btn sm" data-act="togglePw" title="Mostrar u ocultar">👁</button></div></div>`;
const pwHint = '<div class="muted sm" id="pwhint" data-pw>Mínimo 10 caracteres con mayúscula, minúscula, número y símbolo.</div><div class="sm" id="pwmatch"></div>';
function checkPwForm(form) {
  const p1 = form.elements.p1.value, p2 = form.elements.p2.value, pr = pwProblems(p1), h = $('#pwhint'), m = $('#pwmatch');
  h.textContent = !p1 ? 'Mínimo 10 caracteres con mayúscula, minúscula, número y símbolo.' : pr.length ? 'Falta: ' + pr.join(', ') : '✔ Contraseña segura';
  h.style.color = p1 && !pr.length ? 'var(--ok)' : '';
  const mismatch = !!p2 && p1 !== p2;
  m.textContent = !p2 ? '' : mismatch ? '✖ Las contraseñas no coinciden' : '✔ Las contraseñas coinciden';
  m.style.color = mismatch ? 'var(--bad)' : 'var(--ok)';
  form.querySelector('[type=submit]').disabled = mismatch || (!!p1 && pr.length > 0);
}
function viewLogin() {
  return authFrame('login', 'Mesa de ayuda inteligente · Requerimientos · Incidentes · Cambios', `${ui.loginError ? `<div class="alert bad">${esc(ui.loginError)}</div>` : ''}
    <div><label>Usuario</label><input name="username" autocomplete="username" required autofocus value="${esc(ui.loginUser || '')}" placeholder="nombre.apellido"></div>
    ${pwField('password', 'Contraseña', 'current-password', 'lpw')}
    <button class="btn pri" type="submit" style="justify-content:center">Ingresar</button>
    <div class="muted sm">¿Olvidaste tu contraseña? Pide al administrador que la restablezca. Por seguridad la sesión se cierra tras 15 minutos de inactividad.</div>`);
}
function viewForceChange() {
  return authFrame('force', `Hola ${esc(me().name.split(' ')[0])}, debes elegir tu propia contraseña`, `<div class="alert">Tu contraseña es temporal. Define una nueva para continuar.</div>
    ${pwField('p1', 'Nueva contraseña', 'new-password')}${pwField('p2', 'Repite la nueva contraseña', 'new-password')}${pwHint}
    <button class="btn pri" type="submit" style="justify-content:center">Guardar y entrar</button><button class="btn" type="button" data-act="logout">Cancelar</button>`);
}

function viewShell(inner) {
  const u = me(), vis = visible();
  const nav = NAV.filter(n => !n[3] || n[3] === role()).map(([k, i, l]) => {
    const cnt = k === 'tickets' ? vis.filter(isOpen).length : k === 'changes' ? vis.filter(t => t.type === 'C' && ['En evaluación', 'Aprobado', 'Programado'].includes(t.status)).length : '';
    return `<a class="${ui.view === k ? 'on' : ''}" data-act="nav" data-v="${k}"><span>${i}</span>${l}${cnt ? `<span class="cnt">${cnt}</span>` : ''}</a>`;
  }).join('');
  return `<div class="shell"><aside class="side">
    <div class="brand">${logo()}<div><b>NovaDesk</b><small>mesa de ayuda</small></div></div>
    <button class="btn pri" data-act="nav" data-v="new" style="justify-content:center;margin-bottom:8px">✦ Nuevo ticket</button>
    <nav class="nav col" style="gap:2px">${nav}</nav>
    <div class="me"><div class="row">${avatar(u)}<div class="grow"><b>${esc(u.name)}</b><div class="muted sm">${ROLES[u.role].icon} ${ROLES[u.role].name}</div></div></div>
      <div class="row" style="margin-top:10px"><button class="btn sm grow" data-act="theme">◐ Tema</button><button class="btn sm grow" data-act="pwForm">🔑 Clave</button></div>
      <button class="btn sm" data-act="logout" style="width:100%;justify-content:center;margin-top:6px">Cerrar sesión</button></div>
  </aside><main class="main">
    <div class="top"><div class="search" data-act="palette">✨ Pregúntale a Nova… <span class="sm">“incidentes críticos de bupa”</span><kbd>Ctrl K</kbd></div></div>
    ${inner}</main></div>`;
}

function donut(parts) {
  const tot = parts.reduce((a, p) => a + p.v, 0) || 1; let off = 0;
  const arcs = parts.map(p => { const len = p.v / tot * 251.2; const s = `<circle r="40" cx="60" cy="60" fill="none" stroke="${p.c}" stroke-width="14" stroke-dasharray="${len} ${251.2 - len}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)" stroke-linecap="butt"/>`; off += len; return s; }).join('');
  return `<svg viewBox="0 0 120 120" width="150"><circle r="40" cx="60" cy="60" fill="none" stroke="var(--bg2)" stroke-width="14"/>${arcs}<text x="60" y="58" text-anchor="middle" style="font-size:22px;font-weight:700;fill:var(--text)">${tot === 1 && !parts.some(p => p.v) ? 0 : tot}</text><text x="60" y="72" text-anchor="middle">abiertos</text></svg>`;
}
function trend(vis) {
  const days = [...Array(14)].map((_, i) => { const b = new Date(); b.setHours(0, 0, 0, 0); const s = b.getTime() - (13 - i) * D; return vis.filter(t => t.createdAt >= s && t.createdAt < s + D).length; });
  const max = Math.max(1, ...days), pts = days.map((v, i) => `${i * 22 + 6},${70 - v / max * 58}`);
  return `<svg viewBox="0 0 300 80" width="100%"><defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b7bff" stop-opacity=".5"/><stop offset="1" stop-color="#8b7bff" stop-opacity="0"/></linearGradient></defs><polygon points="6,74 ${pts.join(' ')} ${13 * 22 + 6},74" fill="url(#tg)"/><polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>${days.map((v, i) => `<circle cx="${i * 22 + 6}" cy="${70 - v / max * 58}" r="2.6" fill="var(--accent2)"/>`).join('')}</svg>`;
}
function insights(vis) {
  const out = [], open = vis.filter(isOpen), g = {};
  open.filter(t => t.type === 'I' && Date.now() - t.createdAt < D).forEach(t => { const k = t.clientId + '|' + t.category; (g[k] = g[k] || []).push(t); });
  Object.values(g).filter(a => a.length >= 3).forEach(a => out.push({ ico: '⚡', cls: 'bad', txt: `<b>Posible incidente mayor:</b> ${a.length} incidentes de «${a[0].category}» en ${esc(client(a[0].clientId).name)} en 24 h. Recomiendo abrir un problema y avisar al cliente.` }));
  const risk_ = open.filter(t => slaInfo(t) && slaInfo(t).st !== 'ok'); if (risk_.length) out.push({ ico: '⏱️', cls: 'warn', txt: `<b>${risk_.length} ticket(s)</b> con SLA en riesgo o vencido. El más urgente: ${risk_.sort((a, b) => slaInfo(b).pct - slaInfo(a).pct)[0].id}.` });
  const un = open.filter(t => !t.assigneeId && t.type !== 'C'); if (un.length && staff()) out.push({ ico: '🧩', cls: 'warn', txt: `<b>${un.length} ticket(s) sin asignar.</b> Nova sugiere técnicos según habilidades y carga; entra al ticket y aplica la sugerencia.` });
  const cab = open.filter(t => t.status === 'En evaluación'); if (cab.length) out.push({ ico: '🗳️', cls: 'warn', txt: `<b>${cab.length} cambio(s)</b> esperando aprobación del CAB.` });
  S.users.filter(u => u.role === 'tecnico').forEach(u => { const n = S.tickets.filter(t => t.assigneeId === u.id && isOpen(t)).length; if (n >= 4 && staff()) out.push({ ico: '🔋', cls: '', txt: `<b>${esc(u.name)}</b> tiene ${n} tickets activos: considera redistribuir.` }); });
  return out.length ? out.map(i => `<div class="alert ${i.cls}">${i.ico} ${i.txt}</div>`).join('') : '<div class="empty">Todo en calma en la galaxia ✨</div>';
}
function viewDashboard() {
  const vis = visible(), open = vis.filter(isOpen);
  const crit = open.filter(t => t.priority <= 2).length, slaR = open.filter(t => slaInfo(t) && slaInfo(t).st !== 'ok').length;
  const chg = vis.filter(t => t.type === 'C' && ['Aprobado', 'Programado'].includes(t.status)).length;
  const done7 = vis.filter(t => !isOpen(t) && t.resolvedAt && Date.now() - t.resolvedAt < 7 * D).length;
  const byT = Object.keys(TYPES).map(k => ({ k, c: `var(--${k})`, v: open.filter(t => t.type === k).length }));
  const cl = S.clients.map(c => ({ c, n: open.filter(t => t.clientId === c.id).length })), mx = Math.max(1, ...cl.map(x => x.n));
  const techs = S.users.filter(u => u.active && (u.role === 'tecnico' || S.tickets.some(t => t.assigneeId === u.id && isOpen(t))));
  const mine = open.filter(t => t.assigneeId === S.session).sort((a, b) => (slaInfo(b)?.pct || 0) - (slaInfo(a)?.pct || 0));
  const act = vis.flatMap(t => t.history.map(h => ({ ...h, t }))).sort((a, b) => b.at - a.at).slice(0, 7);
  return viewShell(`<h1 style="margin-bottom:16px">${role() === 'tecnico' ? 'Tu centro de mando' : 'Panel de control'} <span class="muted" style="font-size:15px">· ${new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' })}</span></h1>
  <div class="grid g4">
    <div class="card kpi" style="--k:var(--accent)"><div class="l">Tickets abiertos</div><div class="v">${open.length}</div></div>
    <div class="card kpi" style="--k:var(--bad)"><div class="l">Críticos / altos</div><div class="v">${crit}</div></div>
    <div class="card kpi" style="--k:var(--warn)"><div class="l">SLA en riesgo</div><div class="v">${slaR}</div></div>
    <div class="card kpi" style="--k:var(--C)"><div class="l">Cambios próximos</div><div class="v">${chg}</div></div>
    <div class="card kpi" style="--k:var(--ok)"><div class="l">Resueltos 7 días</div><div class="v">${done7}</div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="ai"><h3><span class="spark">✦</span> Nova Insights</h3>${insights(vis)}</div>
    <div class="card"><h3>${role() === 'tecnico' ? 'Mi cola (ordenada por urgencia SLA)' : 'Mi cola'}</h3>${mine.length ? `<table>${mine.slice(0, 6).map(t => `<tr class="click" data-act="open" data-id="${t.id}"><td>${tid(t)}</td><td>${esc(t.title)}</td><td>${slaB(t)}</td></tr>`).join('')}</table>` : '<div class="empty">Sin tickets asignados 🎉</div>'}</div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h3>Abiertos por tipo</h3><div class="row wrap" style="justify-content:space-around">${donut(byT)}<div class="col">${byT.map(p => `<div class="row"><span class="dot" style="background:${p.c}"></span>${TYPES[p.k].plural}<b>${p.v}</b></div>`).join('')}</div></div></div>
    <div class="card"><h3>Entrada de tickets · 14 días</h3>${trend(vis)}</div>
    <div class="card"><h3>Por cliente</h3><div class="col">${cl.map(x => `<div class="row"><span style="width:70px">${esc(x.c.name)}</span><div class="bar"><b style="width:${x.n / mx * 100}%;background:${x.c.color}"></b></div><b>${x.n}</b></div>`).join('')}</div></div>
    ${staff() ? `<div class="card"><h3>Carga del equipo</h3><div class="col">${techs.map(u => { const n = S.tickets.filter(t => t.assigneeId === u.id && isOpen(t)).length; return `<div class="row">${avatar(u)}<span style="width:110px">${esc(u.name.split(' ')[0])}</span><div class="bar"><b style="width:${Math.min(100, n * 20)}%;background:${n >= 4 ? 'var(--bad)' : 'var(--accent)'}"></b></div><b>${n}</b></div>`; }).join('')}</div></div>` : ''}
    <div class="card" style="grid-column:1/-1"><h3>Actividad reciente</h3>${act.map(a => `<div class="row sm" style="padding:5px 0;cursor:pointer" data-act="open" data-id="${a.t.id}">${avatar(user(a.by))}${tid(a.t)}<span class="grow">${esc(a.text)}</span><span class="muted">${rel(a.at)}</span></div>`).join('')}</div>
  </div>`);
}

function filtered() {
  const f = ui.f, q = norm(f.q);
  return visible().filter(t => (!f.type || t.type === f.type) && (!f.client || t.clientId === f.client) && (!f.prio || String(t.priority) === f.prio)
    && (!f.assignee || (f.assignee === 'none' ? !t.assigneeId : t.assigneeId === f.assignee))
    && (f.status === '' || (f.status === 'abiertos' ? isOpen(t) : t.status === f.status))
    && (!q || norm(t.id + ' ' + t.title + ' ' + t.desc + ' ' + t.requester).includes(q))).sort((a, b) => b.createdAt - a.createdAt);
}
const opt = (v, l, sel) => `<option value="${esc(v)}" ${String(sel) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
function viewTickets() {
  const f = ui.f, list = filtered(), allSt = [...new Set([...FLOW.RI, ...FLOW.C, 'Rechazado'])];
  return viewShell(`<div class="row between wrap" style="margin-bottom:14px"><h1>Tickets</h1><div class="row">${staff() ? '<button class="btn" data-act="csv">⬇ Exportar CSV</button>' : ''}<button class="btn pri" data-act="nav" data-v="new">✦ Nuevo ticket</button></div></div>
  <div class="tabs" style="margin-bottom:12px"><span class="tab ${!f.type ? 'on' : ''}" data-act="ftype" data-v="">Todos</span>${Object.entries(TYPES).map(([k, v]) => `<span class="tab ${f.type === k ? 'on' : ''}" data-act="ftype" data-v="${k}">${v.icon} ${v.plural}</span>`).join('')}</div>
  <div class="filters"><input data-f="q" placeholder="Buscar…" value="${esc(f.q)}" style="min-width:200px">
    <select data-f="status">${opt('abiertos', 'Solo abiertos', f.status)}${opt('', 'Todos los estados', f.status)}${allSt.map(s => opt(s, s, f.status)).join('')}</select>
    <select data-f="client">${opt('', 'Todos los clientes', f.client)}${S.clients.map(c => opt(c.id, c.name, f.client)).join('')}</select>
    <select data-f="prio">${opt('', 'Toda prioridad', f.prio)}${Object.entries(PRIO).map(([k, v]) => opt(k, v, f.prio)).join('')}</select>
    ${staff() ? `<select data-f="assignee">${opt('', 'Cualquier técnico', f.assignee)}${opt('none', 'Sin asignar', f.assignee)}${assignable().map(u => opt(u.id, uLabel(u), f.assignee)).join('')}</select>` : ''}</div>
  <div class="card" style="padding:6px 8px;overflow:auto">${list.length ? `<table><tr><th>ID</th><th>Asunto</th><th>Cliente</th><th>Prioridad</th><th>Estado</th><th>Asignado</th><th>SLA / Ventana</th></tr>
    ${list.map(t => `<tr class="click" data-act="open" data-id="${t.id}"><td>${tid(t)}</td><td><b>${esc(t.title)}</b><div class="muted sm">${esc(t.category)} · ${rel(t.createdAt)}</div></td><td>${clientB(t.clientId)}</td><td>${prioB(t.priority)}</td><td><span class="badge">${t.status}</span></td><td>${t.assigneeId ? `<div class="row">${avatar(user(t.assigneeId))}<span class="sm">${esc(user(t.assigneeId).name.split(' ')[0])}</span></div>` : '<span class="muted sm">—</span>'}</td><td>${slaB(t)}</td></tr>`).join('')}</table>` : `<div class="empty">${role() === 'tecnico' ? 'No tienes tickets asignados con estos filtros.' : 'Sin resultados.'}</div>`}</div>`);
}

function viewBoard() {
  const type = ui.boardType, lanes = type === 'C' ? [...FLOW.C.slice(0, 5), 'Implementado', 'Cerrado', 'Rechazado'].filter((v, i, a) => a.indexOf(v) === i) : FLOW.RI;
  const list = visible().filter(t => t.type === type && !(t.status === 'Cerrado' && Date.now() - t.updatedAt > 7 * D));
  return viewShell(`<div class="row between wrap" style="margin-bottom:14px"><h1>Tablero</h1><div class="tabs">${Object.entries(TYPES).map(([k, v]) => `<span class="tab ${type === k ? 'on' : ''}" data-act="btype" data-v="${k}">${v.icon} ${v.plural}</span>`).join('')}</div></div>
  <p class="muted sm">Arrastra las tarjetas entre columnas. Los movimientos respetan el flujo y tu rol.</p>
  <div class="board">${lanes.map(l => { const items = list.filter(t => t.status === l); return `<div class="lane" data-lane="${l}"><h4>${l}<span>${items.length}</span></h4>${items.map(t => `<div class="tcard" draggable="true" data-id="${t.id}" data-act="open" style="--c:${client(t.clientId).color}">
      <div class="row between">${tid(t)}${prioB(t.priority)}</div><div class="t">${esc(t.title)}</div>
      <div class="row between">${clientB(t.clientId)}${avatar(user(t.assigneeId))}</div><div style="margin-top:6px">${slaB(t)}</div></div>`).join('')}</div>`; }).join('')}</div>`);
}

function viewChanges() {
  const chg = visible().filter(t => t.type === 'C'), pend = chg.filter(t => t.status === 'En evaluación');
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const days = [...Array(14)].map((_, i) => start.getTime() + i * D);
  const sched = chg.filter(t => t.change?.start && ['Aprobado', 'Programado', 'Implementando'].includes(t.status));
  return viewShell(`<div class="row between wrap" style="margin-bottom:14px"><h1>Control de cambios</h1><button class="btn pri" data-act="newtype" data-v="C">✦ Solicitar cambio</button></div>
  ${pend.length ? `<div class="card" style="margin-bottom:16px"><h3>🗳️ Pendientes del CAB (${pend.length})</h3>${pend.map(t => { const r = risk(t.change); return `<div class="row wrap" style="padding:8px 0;border-bottom:1px solid var(--line)"><span class="grow" data-act="open" data-id="${t.id}" style="cursor:pointer">${tid(t)} <b>${esc(t.title)}</b> ${clientB(t.clientId)} <span class="badge" style="color:${r.col}">Riesgo ${r.label}</span>${!t.change?.rollback ? ' <span class="badge p2">Sin rollback</span>' : ''}</span>${staff() ? `<button class="btn ok sm" data-act="cab" data-id="${t.id}" data-d="Aprobado">✔ Aprobar</button><button class="btn bad sm" data-act="cab" data-id="${t.id}" data-d="Rechazado">✖ Rechazar</button>` : ''}</div>`; }).join('')}</div>` : ''}
  <div class="card"><h3>📅 Calendario de ventanas · próximos 14 días</h3><div class="cal">${days.map((d, i) => { const ev = sched.filter(t => t.change.start >= d && t.change.start < d + D); return `<div class="day ${i === 0 ? 'today' : ''}"><h5>${new Date(d).toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })}</h5>${ev.map(t => `<div class="evt" data-act="open" data-id="${t.id}" style="border-color:${client(t.clientId).color}">${new Date(t.change.start).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })} · ${esc(t.title.slice(0, 34))}${changeConflicts(t).length ? ' ⚠️' : ''}</div>`).join('')}</div>`; }).join('')}</div></div>
  <div class="card" style="margin-top:16px;padding:6px 8px;overflow:auto"><h3 style="padding:10px 10px 0">Todos los cambios</h3><table><tr><th>ID</th><th>Cambio</th><th>Cliente</th><th>Riesgo</th><th>Estado</th><th>Ventana</th></tr>
  ${chg.map(t => { const r = risk(t.change); return `<tr class="click" data-act="open" data-id="${t.id}"><td>${tid(t)}</td><td><b>${esc(t.title)}</b></td><td>${clientB(t.clientId)}</td><td><span style="color:${r.col}">● ${r.label}</span></td><td><span class="badge">${t.status}</span></td><td>${slaB(t)}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">Sin cambios</td></tr>'}</table></div>`);
}

function viewClients() {
  return viewShell(`<div class="row between wrap" style="margin-bottom:14px"><h1>Clientes</h1>${role() === 'admin' ? '<button class="btn pri" data-act="clientForm">＋ Nuevo cliente</button>' : ''}</div>
  <div class="grid g4" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">${S.clients.map(c => {
    const all = S.tickets.filter(t => t.clientId === c.id), op = all.filter(isOpen);
    return `<div class="card" style="border-top:3px solid ${c.color}"><div class="row between"><h2 style="color:${c.color}">${esc(c.name)}</h2><span class="badge">${esc(c.code)}</span></div>
    <p class="muted sm">${esc(c.contact || 'Sin contacto')}</p>
    <div class="row wrap"><span class="badge">🔥 ${op.filter(t => t.type === 'I').length} inc.</span><span class="badge">📨 ${op.filter(t => t.type === 'R').length} req.</span><span class="badge">🔀 ${op.filter(t => t.type === 'C').length} cambios</span></div>
    <p class="sm muted">Factor SLA: <b>×${c.slaFactor}</b> ${c.slaFactor < 1 ? '(más exigente)' : ''} · ${all.length} tickets históricos</p>
    <div class="row"><button class="btn sm grow" data-act="clientTickets" data-id="${c.id}">Ver tickets</button>${role() === 'admin' ? `<button class="btn sm" data-act="clientForm" data-id="${c.id}">Editar</button>` : ''}</div></div>`; }).join('')}</div>`);
}
function viewUsers() {
  return viewShell(`<div class="row between wrap" style="margin-bottom:14px"><h1>Usuarios y roles</h1><button class="btn pri" data-act="newUser">＋ Nuevo usuario</button></div>
  <div class="card" style="overflow:auto"><table><tr><th>Usuario</th><th>Rol</th><th>Habilidades (usadas por Nova)</th><th>Acceso</th><th></th></tr>
  ${S.users.map(u => `<tr><td><div class="row">${avatar(u)}<div><b>${esc(u.name)}</b><div class="muted sm mono">${esc(u.username)}</div></div></div></td><td>${ROLES[u.role].icon} ${ROLES[u.role].name}</td><td>${u.skills.map(s => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="muted">—</span>'}</td>
    <td>${!u.active ? '<span class="badge p2">Inactivo / pendiente</span>' : u.mustChange ? '<span class="badge p2">Clave temporal</span>' : '<span class="badge" style="color:var(--ok)">Activo</span>'}<div class="muted sm">${u.lastLogin ? 'Último acceso ' + rel(u.lastLogin) : 'Nunca ingresó'}</div></td>
    <td><div class="row"><button class="btn sm" data-act="userForm" data-id="${u.id}">Editar</button><button class="btn sm" data-act="resetPw" data-id="${u.id}">🔑 Restablecer clave</button></div></td></tr>`).join('')}</table></div>
  <div class="card" style="margin-top:16px"><h3>🛡️ Registro de seguridad (últimos 15 eventos)</h3>${S.audit.slice(-15).reverse().map(a => `<div class="row sm" style="padding:4px 0"><span class="muted" style="width:110px">${fdate(a.at)}</span><b style="width:150px">${esc(user(a.by)?.name || 'Anónimo')}</b><span>${esc(a.text)}</span></div>`).join('') || '<div class="muted">Sin eventos</div>'}</div>
  <div class="card" style="margin-top:16px"><h3>Matriz de permisos</h3><table><tr><th>Acción</th><th>👑 Admin</th><th>🧭 Analista</th><th>🛠️ Técnico</th></tr>
  ${[['Ver todos los tickets', 1, 1, 0], ['Ver tickets asignados / propios', 1, 1, 1], ['Crear tickets', 1, 1, 1], ['Clasificar y asignar con Nova', 1, 1, 0], ['Cambiar prioridad / categoría', 1, 1, 0], ['Trabajar y resolver tickets', 1, 1, 1], ['Aprobar / rechazar cambios (CAB)', 1, 1, 0], ['Ejecutar cambios aprobados', 1, 1, 1], ['Gestionar clientes y usuarios', 1, 0, 0], ['Restablecer contraseñas', 1, 0, 0]].map(r => `<tr><td>${r[0]}</td>${r.slice(1).map(x => `<td>${x ? '✅' : '—'}</td>`).join('')}</tr>`).join('')}</table></div>`);
}

function novaPanel(a, cur) {
  return `<div class="ai"><h3><span class="spark">✦</span> Nova IA</h3>
  <div class="muted sm">Confianza de clasificación</div><div class="conf"><b style="width:${a.confidence}%"></b></div><div class="sm" style="text-align:right">${a.confidence}%</div>
  <div class="kv" style="margin:8px 0"><span>Tipo</span><b>${TYPES[a.type].icon} ${TYPES[a.type].name}</b><span>Categoría</span><b>${esc(a.category)}</b><span>Prioridad</span>${prioB(a.priority)}<span>Impacto</span><b>${a.impact}</b><span>Técnico</span><b>${a.assignee ? esc(a.assignee.name) : '—'}</b></div>
  ${a.major ? `<div class="alert bad">⚡ ${esc(a.major)}</div>` : ''}
  ${a.keywords.length ? `<div>${a.keywords.map(k => `<span class="chip">${esc(k)}</span>`).join('')}</div>` : ''}
  <div class="muted sm" style="margin-top:8px">¿Por qué?</div>${a.why.map(w => `<div class="sug">💡 ${esc(w)}</div>`).join('')}
  <div class="muted sm" style="margin-top:8px">Primeras acciones sugeridas</div>${a.actions.map(w => `<div class="sug">➜ ${esc(w)}</div>`).join('')}
  ${a.similar.length ? `<div class="muted sm" style="margin-top:8px">Tickets similares</div>${a.similar.map(x => `<div class="sug" style="cursor:pointer" data-act="open" data-id="${x.t.id}">${tid(x.t)} ${esc(x.t.title)} <span class="muted">${Math.round(x.sim * 100)}%</span></div>`).join('')}` : ''}
  ${cur ? `<div class="row wrap" style="margin-top:10px"><button class="btn sm" data-act="applyAI" data-id="${cur.id}">Aplicar categoría y prioridad</button>${!cur.assigneeId && a.assignee && cur.type !== 'C' ? `<button class="btn sm" data-act="assignAI" data-id="${cur.id}">Asignar a ${esc(a.assignee.name.split(' ')[0])}</button>` : ''}</div>` : ''}</div>`;
}

function viewNew() {
  const d = ui.draft || {}, t = d.type || '';
  const a = (d.title || d.desc) ? classify((d.title || '') + ' ' + (d.desc || ''), d.clientId || S.clients[0].id) : null;
  return viewShell(`<h1 style="margin-bottom:16px">Nuevo ticket</h1><div class="detail" style="grid-template-columns:1fr 360px">
  <form class="card col" id="newForm" autocomplete="off">
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
      <div><label>Tipo</label><select name="type">${opt('', '✦ Automático (Nova decide)', t)}${Object.entries(TYPES).map(([k, v]) => opt(k, v.icon + ' ' + v.name, t)).join('')}</select></div>
      <div><label>Cliente</label><select name="clientId">${S.clients.map(c => opt(c.id, c.name, d.clientId)).join('')}</select></div></div>
    <div><label>Asunto</label><input name="title" required placeholder="Ej: Impresora de farmacia no imprime" value="${esc(d.title || '')}"></div>
    <div><label>Descripción (mientras más detalle, mejor clasifica Nova)</label><textarea name="desc" placeholder="Describe qué pasa, a quiénes afecta y desde cuándo…">${esc(d.desc || '')}</textarea></div>
    <div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:10px">
      <div><label>Solicitante</label><input name="requester" value="${esc(d.requester || '')}" placeholder="Nombre / área"></div>
      <div><label>Prioridad</label><select name="priority">${opt('', '✦ Automática', d.priority)}${Object.entries(PRIO).map(([k, v]) => opt(k, v, d.priority)).join('')}</select></div>
      <div><label>Categoría</label><select name="category">${opt('', '✦ Automática', d.category)}${CATS.map(c => opt(c, c, d.category)).join('')}</select></div></div>
    ${t === 'C' ? `<div class="card" style="background:var(--bg2)"><h3>Datos del cambio</h3><div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:10px">
      <div><label>Ventana (inicio)</label><input type="datetime-local" name="start" value="${d.start || ''}"></div><div><label>Duración (h)</label><input type="number" min="0.5" step="0.5" name="hours" value="${d.hours || 2}"></div>
      <div><label>Impacto</label><select name="impact">${opt(1, 'Bajo', d.impact || 2)}${opt(2, 'Medio', d.impact || 2)}${opt(3, 'Alto', d.impact || 2)}</select></div>
      <div><label>Complejidad</label><select name="complexity">${opt(1, 'Baja', d.complexity || 2)}${opt(2, 'Media', d.complexity || 2)}${opt(3, 'Alta', d.complexity || 2)}</select></div></div>
      <label style="margin-top:8px">Plan de rollback</label><textarea name="rollback" style="min-height:70px">${esc(d.rollback || '')}</textarea></div>` : ''}
    <div class="row"><button class="btn pri" type="submit">Crear ticket</button><button class="btn" type="button" data-act="nav" data-v="tickets">Cancelar</button></div>
  </form>
  <div>${a ? novaPanel(a) : '<div class="ai"><h3><span class="spark">✦</span> Nova IA</h3><p class="muted">Empieza a escribir el asunto y la descripción: clasificaré el tipo, la categoría, la prioridad y sugeriré técnico y primeras acciones en tiempo real.</p></div>'}</div></div>`);
}

function viewDrawer(t) {
  const flow = flowOf(t), idx = flow.indexOf(t.status), a = classify(t.title + ' ' + t.desc, t.clientId, { excludeId: t.id });
  const s = slaInfo(t), conf = changeConflicts(t), r = risk(t.change);
  const ev = [...t.history.map(h => ({ ...h, k: 'h' })), ...t.comments.map(c => ({ ...c, k: 'c' }))].sort((x, y) => x.at - y.at);
  const ed = staff();
  return `<div class="overlay" data-act="closeOv"><div class="drawer">
  <div class="row between"><div class="row wrap">${tid(t)}${prioB(t.priority)}<span class="badge">${t.status}</span>${clientB(t.clientId)}${t.ai ? `<span class="badge" title="Clasificado por Nova">✦ Nova ${t.ai}%</span>` : ''}</div><button class="btn sm" data-act="closeOv">✕ Cerrar</button></div>
  <h2 style="margin:12px 0 4px">${esc(t.title)}</h2><div class="muted sm">${TYPES[t.type].icon} ${TYPES[t.type].name} · creado ${fdate(t.createdAt)} por ${esc(user(t.createdBy)?.name || '—')}</div>
  <div class="steps">${flow.map((f, i) => `<div class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${f}</div>`).join('')}</div>
  ${t.status === 'Rechazado' ? '<div class="alert bad">Este cambio fue rechazado por el CAB.</div>' : ''}
  <div class="detail"><div class="col">
    <div class="card"><h3>Descripción</h3><div style="white-space:pre-wrap">${esc(t.desc)}</div></div>
    ${s && s.st !== 'ok' && isOpen(t) ? `<div class="alert ${s.st === 'bad' ? 'bad' : ''}">⏱️ SLA ${s.st === 'bad' ? 'vencido' : 'en riesgo'}: ${s.label}</div>` : ''}
    ${t.type === 'C' ? `<div class="card"><h3>Plan del cambio</h3>
      ${conf.length ? `<div class="alert">⚠️ Conflicto de ventana con ${conf.map(c => c.id).join(', ')} (mismo cliente).</div>` : ''}
      <div class="kv"><span>Riesgo</span><b style="color:${r.col}">● ${r.label} (puntaje ${r.n})</b>
      <span>Ventana</span><span>${ed || t.status === 'Borrador' ? `<input type="datetime-local" data-chg="start" value="${t.change?.start ? new Date(t.change.start - new Date(t.change.start).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}" style="max-width:230px">` : (t.change?.start ? fdate(t.change.start) : '—')} · ${t.change?.hours || 2} h</span>
      <span>Impacto</span><select data-chg="impact" style="max-width:150px">${opt(1, 'Bajo', t.change?.impact)}${opt(2, 'Medio', t.change?.impact)}${opt(3, 'Alto', t.change?.impact)}</select>
      <span>Complejidad</span><select data-chg="complexity" style="max-width:150px">${opt(1, 'Baja', t.change?.complexity)}${opt(2, 'Media', t.change?.complexity)}${opt(3, 'Alta', t.change?.complexity)}</select></div>
      <label style="margin-top:10px">Plan de rollback</label><textarea data-chg="rollback" style="min-height:70px" placeholder="¿Cómo se revierte si algo sale mal?">${esc(t.change?.rollback || '')}</textarea>
      ${(t.change?.approvals || []).map(ap => `<div class="sug">${ap.decision === 'Aprobado' ? '✅' : '❌'} ${ap.decision} por ${esc(user(ap.by)?.name || '—')} · ${fdate(ap.at)} ${ap.note ? '— ' + esc(ap.note) : ''}</div>`).join('')}</div>` : ''}
    <div class="row wrap">${transitions(t).map(x => `<button class="btn ${x.cls}" data-act="status" data-id="${t.id}" data-to="${x.to}">${x.label}</button>`).join('') || '<span class="muted sm">No tienes acciones disponibles en este estado.</span>'}</div>
    <div class="card"><h3>Conversación e historial</h3><div class="timeline">${ev.map(e => e.k === 'h' ? `<div class="ev"><div class="sm"><b>${esc(user(e.by)?.name || 'Sistema')}</b> <span class="muted">${fdate(e.at)}</span></div><div class="sm">${esc(e.text)}</div></div>` : `<div class="ev ${e.internal ? 'int' : 'cm'}"><div class="sm"><b>${esc(user(e.by)?.name)}</b> <span class="muted">${fdate(e.at)}${e.internal ? ' · 🔒 nota interna' : ''}</span></div><div class="bubble ${e.internal ? 'int' : ''}">${esc(e.text)}</div></div>`).join('')}</div>
      <textarea id="cm" placeholder="Escribe un comentario o avance…" style="margin-top:10px;min-height:70px"></textarea>
      <div class="row between" style="margin-top:8px"><label class="row" style="margin:0"><input type="checkbox" id="cmInt" style="width:auto"> 🔒 Nota interna</label><button class="btn pri sm" data-act="comment" data-id="${t.id}">Comentar</button></div></div>
  </div><div class="col">
    <div class="card"><h3>Detalles</h3><div class="kv">
      <span>Cliente</span><b>${esc(client(t.clientId).name)}</b><span>Solicitante</span><span>${esc(t.requester || '—')}</span>
      <span>Prioridad</span>${ed ? `<select data-edit="priority">${Object.entries(PRIO).map(([k, v]) => opt(k, v, t.priority)).join('')}</select>` : prioB(t.priority)}
      <span>Categoría</span>${ed ? `<select data-edit="category">${CATS.map(c => opt(c, c, t.category)).join('')}</select>` : esc(t.category)}
      <span>Asignado</span>${ed ? `<select data-edit="assigneeId">${opt('', '— Sin asignar —', t.assigneeId || '')}${assignable().map(u => opt(u.id, uLabel(u), t.assigneeId)).join('')}</select>` : `<div class="row">${avatar(user(t.assigneeId))} ${esc(user(t.assigneeId)?.name || '—')}</div>`}
      <span>SLA</span>${slaB(t)}</div></div>
    ${novaPanel(a, ed ? t : null)}</div></div></div></div>`;
}

function viewOverlay() {
  const o = ui.overlay; if (!o) return '';
  if (o.kind === 'palette') return `<div class="overlay center" data-act="closeOv"><div class="palette"><input id="pal" placeholder="Pregunta o busca: “incidentes críticos de bupa”, “mis tickets”, “cambios”…" autocomplete="off"><div class="res" id="palRes"></div></div></div>`;
  if (o.kind === 'client') { const c = S.clients.find(x => x.id === o.id) || { name: '', code: '', color: '#8b7bff', contact: '', slaFactor: 1 }; return modal(o.id ? 'Editar cliente' : 'Nuevo cliente', `<div><label>Nombre</label><input name="name" required value="${esc(c.name)}"></div><div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:10px"><div><label>Código</label><input name="code" value="${esc(c.code)}"></div><div><label>Color</label><input type="color" name="color" value="${c.color}"></div><div><label>Factor SLA</label><input type="number" name="slaFactor" step="0.05" min="0.25" max="3" value="${c.slaFactor}"></div></div><div><label>Contacto</label><input name="contact" value="${esc(c.contact)}"></div>`, 'saveClient'); }
  if (o.kind === 'pw') return modal('Cambiar mi contraseña', `${pwField('cur', 'Contraseña actual', 'current-password')}${pwField('p1', 'Nueva contraseña', 'new-password')}${pwField('p2', 'Repite la nueva contraseña', 'new-password')}${pwHint}`, 'savePw');
  if (o.kind === 'temp') return `<div class="overlay center"><div class="modal col"><h2>🔑 ${o.created ? 'Usuario creado' : 'Contraseña restablecida'}</h2><p class="muted">Entrégale esto a <b>${esc(o.name)}</b> por un canal seguro. <b>La contraseña se muestra una sola vez</b>; al ingresar deberá elegir una propia.</p>
    <div class="card" style="background:var(--bg2)"><div class="muted sm">Usuario (o correo) para ingresar</div><div class="mono" style="font-size:16px;user-select:all">${esc(o.login)}</div><div class="muted sm" style="margin-top:8px">Contraseña temporal</div><div class="mono" style="font-size:20px;letter-spacing:1px;user-select:all">${esc(o.pw)}</div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-act="copyTemp">Copiar</button><button class="btn pri" data-act="closeOv">Ya la anoté</button></div></div></div>`;
  if (o.kind === 'user') {
    const isNew = !o.id, u = S.users.find(x => x.id === o.id) || { name: '', username: '', role: 'tecnico', active: true, skills: [] };
    return modal(isNew ? 'Nuevo usuario' : 'Editar usuario', `${isNew ? '<p class="muted sm" style="margin:0">Se genera una contraseña temporal que verás una sola vez. Al ingresar, la persona deberá elegir la suya.</p>' : ''}
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label>Nombre completo</label><input name="name" required value="${esc(u.name)}"></div>
    <div><label>${isNew ? 'Usuario o correo' : 'Usuario'}</label>${isNew ? `<input name="username" required placeholder="nombre.apellido o correo@empresa.cl" autocomplete="off" pattern="[A-Za-z0-9._@+\\-]{3,80}" title="Un usuario (letras minúsculas, números, punto o guion) o un correo">` : `<input name="username" readonly title="El usuario está ligado a su cuenta de acceso y no se puede cambiar" value="${esc(u.username)}">`}</div></div>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label>Rol</label><select name="role">${Object.entries(ROLES).map(([k, v]) => opt(k, v.name, u.role)).join('')}</select></div>
    ${isNew ? '' : `<div><label>Estado</label><select name="active">${opt('1', 'Activo', u.active ? '1' : '0')}${opt('0', 'Inactivo', u.active ? '1' : '0')}</select></div>`}</div>
    <div><label>Habilidades (técnicos)</label><div class="row wrap">${CATS.filter(c => c !== 'General').map(c => `<label class="row sm" style="margin:0"><input type="checkbox" style="width:auto" name="sk" value="${esc(c)}" ${u.skills.includes(c) ? 'checked' : ''}>${esc(c)}</label>`).join('')}</div></div>`, 'saveUser', isNew ? 'Crear usuario' : 'Guardar'); }
  return '';
}
const modal = (title, body, act, okLabel = 'Guardar') => `<div class="overlay center" data-act="closeOv"><form class="modal col" id="modalForm" data-submit="${act}"><h2>${title}</h2>${body}<div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-act="closeOv">Cancelar</button><button class="btn pri" type="submit">${okLabel}</button></div></form></div>`;

/* ───────────── Render y router ───────────── */
function render() {
  applyTheme();
  const app = $('#app'), keep = document.activeElement?.dataset?.f, pos = document.activeElement?.selectionStart;
  if (ui.booting) { app.innerHTML = '<div class="login"><div class="box"><h1 style="font-size:42px">NovaDesk</h1><p class="muted">Conectando…</p></div></div>'; return; }
  if (!me()) { app.innerHTML = viewLogin(); const u = $('[name=username]'); if (u && !u.value) u.focus(); else if ($('#lpw')) $('#lpw').focus(); return; }
  if (me().mustChange) { app.innerHTML = viewForceChange(); return; }
  const views = { dashboard: viewDashboard, tickets: viewTickets, board: viewBoard, changes: viewChanges, clients: viewClients, users: viewUsers, new: viewNew };
  const t = ui.open && visible().find(x => x.id === ui.open);
  app.innerHTML = (views[ui.view] || viewDashboard)() + (t ? viewDrawer(t) : '') + viewOverlay();
  if (keep) { const el = $(`[data-f="${keep}"]`); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }
  if (ui.overlay?.kind === 'palette') { $('#pal').focus(); $('#pal').value = ui.overlay.q || ''; paletteResults(); }
}

/* Búsqueda en lenguaje natural de Nova */
function nlSearch(q) {
  const n = norm(q), parts = [], f = {};
  const types = { incidente: 'I', requerimiento: 'R', requerimientos: 'R', cambio: 'C', caida: 'I' };
  for (const [w, k] of Object.entries(types)) if (n.includes(w)) { f.type = k; parts.push(TYPES[k].plural); break; }
  const cl = S.clients.find(c => n.includes(norm(c.name))); if (cl) { f.client = cl.id; parts.push(cl.name); }
  if (/critic|urgent/.test(n)) { f.prio = [1]; parts.push('Críticos'); } else if (/\balta/.test(n)) { f.prio = [1, 2]; parts.push('Alta+'); }
  if (/sin asignar/.test(n)) { f.unassigned = true; parts.push('Sin asignar'); }
  if (/\bmis\b|\bmio/.test(n)) { f.mine = true; parts.push('Asignados a mí'); }
  const tech = S.users.find(u => n.includes(norm(u.name.split(' ')[0]))); if (tech) { f.tech = tech.id; parts.push(tech.name); }
  const st = [...FLOW.RI, ...FLOW.C].find(s => n.includes(norm(s))); if (st) { f.status = st; parts.push(st); }
  else if (/resuelto|cerrado/.test(n)) { f.closed = true; parts.push('Cerrados'); } else { f.open = true; }
  const stop = /incidente|requerimiento|cambio|critic|urgent|alta|sin asignar|mis|de|del|los|las|la|el|en|con|para|abierto|resuelto|cerrado/;
  const free = n.split(/\s+/).filter(w => w.length > 2 && !stop.test(w) && !(cl && norm(cl.name) === w) && !(tech && norm(tech.name).includes(w)) && !(st && norm(st).includes(w)));
  const res = visible().filter(t => (!f.type || t.type === f.type) && (!f.client || t.clientId === f.client) && (!f.prio || f.prio.includes(t.priority)) && (!f.unassigned || !t.assigneeId)
    && (!f.mine || t.assigneeId === S.session) && (!f.tech || t.assigneeId === f.tech) && (!f.status || t.status === f.status) && (!f.closed || !isOpen(t)) && (!f.open || isOpen(t) || f.status)
    && free.every(w => norm(t.id + ' ' + t.title + ' ' + t.desc + ' ' + t.category).includes(w)));
  return { res: res.slice(0, 8), parts };
}
function paletteResults() {
  const q = $('#pal').value; ui.overlay.q = q; const box = $('#palRes'), n = norm(q);
  const cmds = [['➕ Nuevo ticket', 'new'], ['🌌 Ir al panel', 'dashboard'], ['🎫 Ir a tickets', 'tickets'], ['🗂️ Ir al tablero', 'board'], ['🔀 Ir a cambios', 'changes'], ['🏥 Ir a clientes', 'clients']].filter(c => !n || norm(c[0]).includes(n));
  let h = cmds.slice(0, q ? 2 : 6).map(c => `<div class="it" data-act="nav" data-v="${c[1]}">${c[0]}</div>`).join('');
  if (q.trim()) { const { res, parts } = nlSearch(q); h += `<div class="it muted sm">✦ Nova entendió: ${parts.length ? parts.join(' · ') : 'búsqueda libre'} — ${res.length} resultado(s)</div>` + res.map(t => `<div class="it" data-act="open" data-id="${t.id}">${tid(t)} <span class="grow">${esc(t.title)}</span>${prioB(t.priority)}</div>`).join(''); }
  box.innerHTML = h;
}

/* ───────────── Acciones ───────────── */
const A = {
  logout: () => { endSession(); ui.loginError = ''; ui.loginUser = ''; render(); },
  togglePw: e => { const i = e.target.closest('.row').querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; },
  pwForm: () => { ui.overlay = { kind: 'pw' }; render(); },
  newUser: () => { ui.overlay = { kind: 'user' }; render(); },
  copyTemp: () => { navigator.clipboard?.writeText(ui.overlay.pw).then(() => toast('Contraseña copiada')); },
  resetPw: async d => {
    const u = user(d.id); if (!confirm(`¿Restablecer la contraseña de ${u.name}? Se generará una temporal y se le exigirá cambiarla al ingresar.`)) return;
    try {
      const r = await adminUsers({ action: 'reset', id: u.id }); u.mustChange = true; snap.users[u.id] = JSON.stringify(userRow(u));
      S.audit.push({ at: Date.now(), by: S.session, text: `Restableció la contraseña de ${u.name}`, sent: true });
      ui.overlay = { kind: 'temp', name: u.name, login: r.login, pw: r.password }; render();
    } catch (e) { toast(e.message); }
  },
  nav: d => { ui.view = d.v; ui.open = null; ui.overlay = null; if (d.v === 'new') ui.draft = {}; render(); },
  theme: () => { localStorage.setItem(THEME_KEY, theme() === 'dark' ? 'light' : 'dark'); render(); },
  open: d => { ui.open = d.id; ui.overlay = null; render(); },
  closeOv: () => { ui.open = null; ui.overlay = null; render(); },
  palette: () => { ui.overlay = { kind: 'palette' }; render(); },
  ftype: d => { ui.f.type = d.v; render(); },
  btype: d => { ui.boardType = d.v; render(); },
  newtype: d => { ui.view = 'new'; ui.draft = { type: d.v }; render(); },
  status: d => { const t = S.tickets.find(x => x.id === d.id); if (setStatus(t, d.to)) { toast(`${t.id} → ${d.to}`); render(); } },
  cab: d => { const t = S.tickets.find(x => x.id === d.id); if (setStatus(t, d.d)) { toast(`${t.id}: ${d.d}`); render(); } },
  comment: d => { const txt = $('#cm').value.trim(); if (!txt) return; const t = S.tickets.find(x => x.id === d.id); t.comments.push({ id: uid(), by: S.session, at: Date.now(), text: txt, internal: $('#cmInt').checked }); t.updatedAt = Date.now(); save(); render(); },
  applyAI: d => { const t = S.tickets.find(x => x.id === d.id), a = classify(t.title + ' ' + t.desc, t.clientId, { excludeId: t.id }); t.category = a.category; t.priority = a.priority; t.ai = a.confidence; log(t, `Nova aplicó categoría «${a.category}» y prioridad ${PRIO[a.priority]}`); save(); toast('Sugerencia aplicada'); render(); },
  assignAI: d => { const t = S.tickets.find(x => x.id === d.id), a = classify(t.title + ' ' + t.desc, t.clientId, { excludeId: t.id }); t.assigneeId = a.assignee.id; log(t, `Nova asignó a ${a.assignee.name}`); save(); toast(`Asignado a ${a.assignee.name}`); render(); },
  csv: () => { const rows = [['ID', 'Tipo', 'Asunto', 'Cliente', 'Prioridad', 'Estado', 'Categoría', 'Asignado', 'Creado']].concat(filtered().map(t => [t.id, TYPES[t.type].name, t.title, client(t.clientId).name, PRIO[t.priority], t.status, t.category, user(t.assigneeId)?.name || '', new Date(t.createdAt).toISOString()]));
    const blob = new Blob(['﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n')], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'novadesk-tickets.csv'; a.click(); },
  clientForm: d => { ui.overlay = { kind: 'client', id: d.id }; render(); },
  userForm: d => { ui.overlay = { kind: 'user', id: d.id }; render(); },
  clientTickets: d => { ui.f = { q: '', type: '', status: 'abiertos', client: d.id, prio: '', assignee: '' }; ui.view = 'tickets'; render(); },
};
const SUBMIT = {
  async savePw(fd) {
    const u = me(), { data: { user: au } } = await sb.auth.getUser(), { error } = await sb.auth.signInWithPassword({ email: au?.email || u.username + EMAIL_DOMAIN, password: fd.get('cur') });
    if (error) { audit('Intento fallido de cambio de contraseña'); save(); return toast('La contraseña actual no es correcta'), false; }
    return setOwnPassword(u, fd.get('p1'), fd.get('p2'), 'Cambió su contraseña');
  },
  saveClient(fd) { if (role() !== 'admin') return false; const o = ui.overlay, n = fd.get('name').trim(); if (!n) return; const data = { name: n, code: (fd.get('code') || n.slice(0, 4)).toUpperCase(), color: fd.get('color'), contact: fd.get('contact'), slaFactor: parseFloat(fd.get('slaFactor')) || 1 };
    if (S.clients.some(c => c.id !== o.id && (c.name.toLowerCase() === data.name.toLowerCase() || c.code === data.code))) return toast('Ya existe un cliente con ese nombre o código'), false;
    if (o.id) Object.assign(S.clients.find(c => c.id === o.id), data); else S.clients.push({ id: uid(), ...data }); toast('Cliente guardado'); },
  async saveUser(fd) {
    if (role() !== 'admin') return false;
    const o = ui.overlay;
    if (!o.id) {   // usuario nuevo: lo crea la Edge Function (necesita la clave secreta, que nunca está en la página)
      const name = fd.get('name').trim(), login = fd.get('username').trim().toLowerCase(), skills = fd.get('role') === 'tecnico' ? fd.getAll('sk') : [];
      if (!name || !login) return toast('Completa el nombre y el usuario'), false;
      const email = login.includes('@') ? login : login + EMAIL_DOMAIN, uname = email.split('@')[0];
      if (S.users.some(u => u.username === uname)) return toast('Ya existe un usuario con ese nombre'), false;
      if (SUBMIT.busy) return false; SUBMIT.busy = true;
      try {
        const r = await adminUsers({ action: 'create', name, login, role: fd.get('role'), skills });
        const nu = { id: r.id, username: r.username, name, role: fd.get('role'), active: true, skills, mustChange: true, lastLogin: null };
        S.users.push(nu); snap.users[nu.id] = JSON.stringify(userRow(nu));
        S.audit.push({ at: Date.now(), by: S.session, text: `Creó al usuario ${name} (${ROLES[nu.role].name})`, sent: true });
        ui.overlay = { kind: 'temp', created: true, name, login: r.login, pw: r.password }; render();
      } catch (e) { toast(e.message); }
      finally { SUBMIT.busy = false; }
      return false;
    }
    const data = { name: fd.get('name').trim(), role: fd.get('role'), active: fd.get('active') === '1', skills: fd.get('role') === 'tecnico' ? fd.getAll('sk') : [] };
    if (!data.name) return toast('Falta el nombre'), false;
    const others = S.users.filter(u => u.id !== o.id && u.role === 'admin' && u.active);
    if (!others.length && (data.role !== 'admin' || !data.active)) return toast('Debe quedar al menos un administrador activo'), false;
    if (o.id === S.session && !data.active) return toast('No puedes desactivar tu propia cuenta'), false;
    Object.assign(S.users.find(u => u.id === o.id), data); audit(`Editó al usuario ${data.name}`); toast('Usuario guardado');
  },
};
async function setOwnPassword(u, p1, p2, msg) {
  if (p1 !== p2) return toast('Las contraseñas no coinciden'), false;
  const pr = pwProblems(p1); if (pr.length) return toast('La contraseña necesita: ' + pr.join(', ')), false;
  const { error } = await sb.auth.updateUser({ password: p1 });
  if (error) return toast(/different|same/i.test(error.message) ? 'La nueva contraseña debe ser distinta a la actual' : 'No se pudo cambiar la contraseña: ' + error.message), false;
  await sb.rpc('clear_must_change'); u.mustChange = false; audit(msg, u.id); save(); toast('Contraseña actualizada'); return true;
}
/* Crear usuarios y restablecer claves: solo lo puede el administrador, y lo hace la Edge Function «admin-users» en el servidor. */
async function adminUsers(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function login(fd) {
  const un = fd.get('username').trim().toLowerCase(), pw = fd.get('password');
  ui.loginUser = un; ui.loginError = '';
  if (!sb) { ui.loginError = 'No se pudo cargar la conexión a Supabase.'; return render(); }
  const generic = 'Usuario o contraseña incorrectos.';
  /* Se puede ingresar con el usuario (nombre.apellido → @novadesk.local) o con el correo completo. */
  const email = un.includes('@') ? un : un + EMAIL_DOMAIN;
  const { data, error } = /^[a-z0-9._-]{3,30}$/.test(un) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(un) ? await sb.auth.signInWithPassword({ email, password: pw }) : { error: { message: 'bad user' } };
  if (error) { await sleep(700); ui.loginError = /rate|too many|limit/i.test(error.message) ? 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' : generic; return render(); }
  try { await enter(data.user.id, true); ui.loginUser = ''; }
  catch (e) { ui.loginError = e.message === 'inactive' ? 'Tu cuenta está inactiva o pendiente de activación. Contacta al administrador.' : 'No se pudieron cargar tus datos: ' + (e.message || e); await sb.auth.signOut(); }
  render();
}
async function submitAuth(form) {
  const fd = new FormData(form), kind = form.dataset.kind;
  if (kind === 'login') return login(fd);
  if (kind === 'force') { const u = me(); if (await setOwnPassword(u, fd.get('p1'), fd.get('p2'), 'Estableció su contraseña definitiva')) render(); }
}
async function createTicket(fd) {
  if (createTicket.busy) return; createTicket.busy = true;
  try {
    const title = fd.get('title').trim(), desc = fd.get('desc').trim(), cl = fd.get('clientId'), a = classify(title + ' ' + desc, cl);
    const type = fd.get('type') || a.type, auto = [!fd.get('type'), !fd.get('priority'), !fd.get('category')].some(Boolean);
    const { data: id, error } = await sb.rpc('next_ticket_id', { p_type: type });
    if (error) return toast('No se pudo generar el número del ticket: ' + error.message);
    const now = Date.now();
    const t = { id, type, title, desc, clientId: cl, requester: fd.get('requester').trim() || me().name, priority: +fd.get('priority') || a.priority, category: fd.get('category') || a.category,
      status: type === 'C' ? 'Borrador' : 'Nuevo', assigneeId: null, createdBy: S.session, createdAt: now, updatedAt: now, comments: [], history: [{ at: now, by: S.session, text: 'Ticket creado' + (auto ? ` · Nova clasificó con ${a.confidence}% de confianza` : '') }], ai: auto ? a.confidence : null };
    if (type === 'C') { const st = fd.get('start'); t.change = { impact: +fd.get('impact') || 2, complexity: +fd.get('complexity') || 2, start: st ? new Date(st).getTime() : null, hours: +fd.get('hours') || 2, rollback: fd.get('rollback') || '', approvals: [] }; }
    else if (staff() && a.assignee && t.priority <= 2) { t.assigneeId = a.assignee.id; t.status = 'Asignado'; t.history.push({ at: now, by: S.session, text: `Nova asignó automáticamente a ${a.assignee.name} (prioridad ${PRIO[t.priority]})` }); }
    else if (!staff()) { t.assigneeId = S.session; t.status = 'Asignado'; }
    S.tickets.push(t); save(); toast(`Ticket ${t.id} creado${a.major ? ' · ⚡ posible incidente mayor' : ''}`); ui.view = 'tickets'; ui.open = t.id; ui.f.status = 'abiertos'; ui.f.type = ''; render();
  } finally { createTicket.busy = false; }
}

/* ───────────── Eventos ───────────── */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.classList.contains('overlay') && e.target !== el) return;
  const act = el.dataset.act, fn = A[act]; if (!fn) return;
  if (!me() && !['togglePw'].includes(act)) return;
  if (ADMIN_ACTS.has(act) && role() !== 'admin') return toast('Solo el administrador puede hacer esto');
  if (STAFF_ACTS.has(act) && !staff()) return toast('Acción no permitida para tu rol');
  touch(); const d = { ...el.dataset, target: e.target }; if (act === 'togglePw') return fn(e);
  fn(d);
});
['keydown', 'pointerdown'].forEach(ev => document.addEventListener(ev, () => S && S.session && touch(), { passive: true }));
document.addEventListener('input', e => {
  if (['p1', 'p2'].includes(e.target.name) && $('#pwhint')) return checkPwForm(e.target.form);
  const f = e.target.dataset.f; if (f) { ui.f[f] = e.target.value; render(); return; }
  if (e.target.id === 'pal') return paletteResults();
  const form = e.target.closest('#newForm'); if (form) { clearTimeout(form._t); form._t = setTimeout(() => { const fd = new FormData(form); ui.draft = Object.fromEntries(fd.entries()); const focus = e.target.name, pos = e.target.selectionStart; render(); const el = $(`#newForm [name="${focus}"]`); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }, 350); }
});
document.addEventListener('change', e => {
  const el = e.target, f = el.dataset.f; if (f) { ui.f[f] = el.value; render(); return; }
  if (el.closest('#newForm') && el.name === 'type') { const fd = new FormData(el.form); ui.draft = Object.fromEntries(fd.entries()); render(); return; }
  const t = ui.open && S.tickets.find(x => x.id === ui.open); if (!t) return;
  if ((el.dataset.edit || el.dataset.chg) && !staff() && !(el.dataset.chg && t.status === 'Borrador')) return toast('Acción no permitida para tu rol');
  if (el.dataset.edit) { const k = el.dataset.edit; let v = el.value; if (k === 'priority') v = +v; if (k === 'assigneeId') v = v || null; t[k] = v; log(t, `${k === 'assigneeId' ? 'Asignado a ' + (user(v)?.name || 'nadie') : k === 'priority' ? 'Prioridad: ' + PRIO[v] : 'Categoría: ' + v}`); save(); toast('Ticket actualizado'); render(); }
  if (el.dataset.chg) { const k = el.dataset.chg; t.change = t.change || { impact: 2, complexity: 2, hours: 2, approvals: [] }; t.change[k] = k === 'start' ? (el.value ? new Date(el.value).getTime() : null) : ['impact', 'complexity'].includes(k) ? +el.value : el.value; log(t, `Plan del cambio actualizado (${k})`); save(); render(); }
});
const ADMIN_ACTS = new Set(['clientForm', 'userForm', 'newUser', 'resetPw']);
const STAFF_ACTS = new Set(['applyAI', 'assignAI', 'csv', 'cab']);
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'authForm') return submitAuth(e.target);
  if (!me()) return;
  touch();
  if (e.target.id === 'newForm') return createTicket(new FormData(e.target));
  const act = e.target.dataset.submit; if (!act) return;
  if (await SUBMIT[act](new FormData(e.target)) === false) return;
  ui.overlay = null; save(); render();
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && me()) { e.preventDefault(); A.palette(); }
  if (e.key === 'Escape' && (ui.open || ui.overlay)) A.closeOv();
});
document.addEventListener('dragstart', e => { const c = e.target.closest?.('.tcard'); if (c) { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('drag'); } });
document.addEventListener('dragend', e => e.target.classList?.remove('drag'));
document.addEventListener('dragover', e => { const l = e.target.closest?.('.lane'); if (l) { e.preventDefault(); document.querySelectorAll('.lane.over').forEach(x => x !== l && x.classList.remove('over')); l.classList.add('over'); } });
document.addEventListener('drop', e => {
  const l = e.target.closest?.('.lane'); if (!l) return; e.preventDefault();
  const t = S.tickets.find(x => x.id === e.dataTransfer.getData('text/plain')); if (t && t.status !== l.dataset.lane && setStatus(t, l.dataset.lane)) toast(`${t.id} → ${l.dataset.lane}`); render();
});

boot();
})();
