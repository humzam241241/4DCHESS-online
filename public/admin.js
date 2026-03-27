// ==================== CHATURAJI ADMIN DASHBOARD ====================

let _sb = null;
let _token = null;
const API = window.BACKEND_URL || '';

// ==================== AUTH ====================

async function initAdmin() {
  // Load config from backend
  let config;
  try {
    const r = await fetch(`${API}/api/config`);
    config = await r.json();
  } catch {
    showAuthError('Cannot reach server. Is it running?');
    return;
  }

  _sb = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);

  document.getElementById('btn-admin-signin').addEventListener('click', async () => {
    await _sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/admin' }
    });
  });

  document.getElementById('btn-admin-signout').addEventListener('click', async () => {
    await _sb.auth.signOut();
    location.reload();
  });

  document.getElementById('btn-refresh-all').addEventListener('click', loadAll);

  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { showAuthGate(); return; }

  _token = session.access_token;

  _sb.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED' && session) _token = session.access_token;
    if (event === 'SIGNED_OUT') { showAuthGate(); }
  });

  // Verify admin
  const check = await apiFetch('/api/admin/overview');
  if (check.error === 'Admin access required') {
    showAuthError(`${session.user.email} is not an admin account.`);
    return;
  }
  if (check.error) { showAuthError(check.error); return; }

  document.getElementById('admin-email').textContent = session.user.email;
  document.getElementById('auth-gate').style.display = 'none';
  document.getElementById('admin-dash').style.display = 'block';

  renderOverview(check);
  loadUsers();
  loadGames();
  loadRevenue();
}

function showAuthGate() {
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('admin-dash').style.display = 'none';
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ==================== API HELPER ====================

async function apiFetch(path, options = {}) {
  try {
    const r = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${_token}`,
        ...(options.headers || {})
      }
    });
    return r.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ==================== OVERVIEW ====================

function renderOverview(data) {
  set('stat-users',   data.totalUsers ?? '—');
  set('stat-premium', data.lifetimeUsers ?? '—');
  set('stat-subs',    data.activeSubscribers ?? '—');
  set('stat-games',   data.totalGames ?? '—');
  set('stat-active',  data.activePlaying ?? '—');

  const revenue = ((data.lifetimeUsers ?? 0) * 5) + ((data.activeSubscribers ?? 0) * 3);
  set('stat-revenue', `$${revenue}`);
  set('stat-users-sub', `${data.freeUsers ?? 0} free`);
  set('stat-games-sub', `${data.finishedGames ?? 0} finished`);
  set('stat-waiting-sub', `${data.waitingGames ?? 0} waiting`);
}

async function loadAll() {
  const [overview, , ] = await Promise.all([
    apiFetch('/api/admin/overview'),
    loadUsers(),
    loadGames(),
  ]);
  if (!overview.error) renderOverview(overview);
  loadRevenue();
}

// ==================== REVENUE ====================

async function loadRevenue() {
  const data = await apiFetch('/api/admin/revenue');
  if (data.error) return;
  set('rev-lifetime', `$${(data.lifetimeTotal / 100).toFixed(2)}`);
  set('rev-mrr',      `$${(data.monthlyTotal / 100).toFixed(2)}`);
  set('rev-total',    `$${(data.grossTotal / 100).toFixed(2)}`);
}

// ==================== USERS ====================

async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="loading">Loading...</td></tr>';

  const data = await apiFetch('/api/admin/users');
  if (data.error || !data.users) {
    tbody.innerHTML = `<tr><td colspan="5" class="error-msg">${data.error || 'Failed'}</td></tr>`;
    return;
  }

  set('users-count', `(${data.users.length})`);

  if (!data.users.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No users yet</td></tr>';
    return;
  }

  tbody.innerHTML = data.users.map(u => `
    <tr>
      <td>${esc(u.display_name || '—')}</td>
      <td style="color:var(--muted);font-size:0.82rem">${esc(u.email || '—')}</td>
      <td>${planBadge(u)}</td>
      <td style="color:var(--muted)">${u.games_played ?? 0}</td>
      <td style="color:var(--muted);font-size:0.82rem">${fmtDate(u.created_at)}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${u.has_lifetime_access
            ? `<button class="action-btn btn-revoke" onclick="updateUser('${u.id}','has_lifetime_access',false)">Revoke Premium</button>`
            : `<button class="action-btn btn-grant" onclick="updateUser('${u.id}','has_lifetime_access',true)">Grant Premium</button>`
          }
          ${u.subscription_status === 'active'
            ? `<button class="action-btn btn-revoke" onclick="updateUser('${u.id}','subscription_status','cancelled')">Cancel Sub</button>`
            : `<button class="action-btn btn-grant" onclick="updateUser('${u.id}','subscription_status','active')">Activate Sub</button>`
          }
          ${u.is_admin
            ? `<button class="action-btn btn-danger" onclick="updateUser('${u.id}','is_admin',false)">Revoke Admin</button>`
            : `<button class="action-btn btn-admin" onclick="updateUser('${u.id}','is_admin',true)">Make Admin</button>`
          }
        </div>
      </td>
    </tr>
  `).join('');

  // Inject action button styles once
  if (!document.getElementById('action-styles')) {
    const s = document.createElement('style');
    s.id = 'action-styles';
    s.textContent = `
      .action-btn { padding:3px 10px; border-radius:5px; border:none; cursor:pointer; font-size:0.78rem; font-weight:600; }
      .btn-grant  { background:rgba(34,197,94,0.15); color:#22c55e; }
      .btn-revoke { background:rgba(239,68,68,0.12); color:#ef4444; }
      .btn-admin  { background:rgba(124,58,237,0.15); color:#7c3aed; }
      .btn-danger { background:rgba(239,68,68,0.18); color:#ef4444; }
      .action-btn:hover { filter:brightness(1.2); }
    `;
    document.head.appendChild(s);
  }

  // Add actions column header if not already there
  const headers = document.querySelectorAll('#users-tbody')
  const th = document.querySelector('.data-table thead tr');
  if (th && th.children.length === 5) {
    const actionTh = document.createElement('th');
    actionTh.textContent = 'Actions';
    th.appendChild(actionTh);
  }
}

async function updateUser(userId, field, value) {
  const data = await apiFetch(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ [field]: value })
  });
  if (data.error) { alert('Error: ' + data.error); return; }
  await loadUsers();
}

function planBadge(u) {
  if (u.is_admin) return '<span class="badge badge-premium">Admin</span>';
  if (u.subscription_status === 'active') return '<span class="badge badge-sub">Monthly</span>';
  if (u.has_lifetime_access) return '<span class="badge badge-premium">Premium</span>';
  return '<span class="badge badge-free">Free</span>';
}

// ==================== GAMES ====================

async function loadGames() {
  const tbody = document.getElementById('games-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="loading">Loading...</td></tr>';

  const data = await apiFetch('/api/admin/games');
  if (data.error || !data.games) {
    tbody.innerHTML = `<tr><td colspan="7" class="error-msg">${data.error || 'Failed'}</td></tr>`;
    return;
  }

  set('games-count', `(${data.games.length})`);

  if (!data.games.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No games yet</td></tr>';
    return;
  }

  const STATUS_COLORS = { playing: 'badge-playing', waiting: 'badge-waiting', finished: 'badge-finished' };

  tbody.innerHTML = data.games.map(g => `
    <tr>
      <td style="font-family:monospace;font-weight:700">${g.code}</td>
      <td style="color:var(--muted)">${g.game_type}</td>
      <td><span class="badge ${STATUS_COLORS[g.status] || 'badge-free'}">${g.status}</span></td>
      <td style="color:var(--muted)">${g.player_count ?? 0}/4</td>
      <td style="color:var(--muted)">${g.winner ? cap(g.winner) : '—'}</td>
      <td style="color:var(--muted)">${g.turn_number ?? 0}</td>
      <td style="color:var(--muted);font-size:0.82rem">${fmtDate(g.created_at)}</td>
    </tr>
  `).join('');
}

// ==================== HELPERS ====================

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function cap(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

// ==================== BOOT ====================
initAdmin();
