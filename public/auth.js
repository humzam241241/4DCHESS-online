// ==================== CHATURAJI AUTH ====================
// Loaded before game.js. Controls sign-in, payment wall, and socket init.

let _sb = null;
window.supabaseClient = null;
window.currentUser = null;
window.currentProfile = null;
window.__jwt = null;

async function fetchConfig() {
  const res = await fetch(`${window.BACKEND_URL || ''}/api/config`);
  if (!res.ok) throw new Error('Failed to load config');
  return res.json();
}

// ==================== PROFILE ====================

async function loadUserProfile() {
  try {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) return;
    const res = await fetch(`${window.BACKEND_URL || ''}/api/my-profile`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (res.ok) {
      window.currentProfile = await res.json();
      // Pre-fill name field with Google display name
      const nameInput = document.getElementById('player-name');
      if (nameInput && !nameInput.value && window.currentProfile?.display_name) {
        nameInput.value = window.currentProfile.display_name;
        localStorage.setItem('chaturaji_name', window.currentProfile.display_name);
      }
      // Show admin button if user is admin
      if (window.currentProfile?.is_admin) {
        const adminBtn = document.getElementById('btn-admin-link');
        if (adminBtn) adminBtn.style.display = '';
      }
    }
  } catch (e) { console.warn('[auth] loadUserProfile:', e); }
}

function isPremium() {
  const p = window.currentProfile;
  return p?.has_lifetime_access === true || p?.subscription_status === 'active';
}
window.isPremium = isPremium;

// ==================== SIGN IN / OUT ====================

async function signInWithGoogle() {
  await _sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
}


async function signOut() {
  await _sb.auth.signOut();
  window.currentUser = null;
  window.currentProfile = null;
  window.__jwt = null;
  window.location.reload();
}

// ==================== PAYMENT WALL ====================

function showPaymentWall() {
  document.getElementById('payment-wall').style.display = 'flex';
}
function hidePaymentWall() {
  document.getElementById('payment-wall').style.display = 'none';
}
window.showPaymentWall = showPaymentWall;
window.hidePaymentWall = hidePaymentWall;

async function startCheckout(type) {
  const btn = document.getElementById(type === 'lifetime' ? 'btn-pay-lifetime' : 'btn-pay-monthly');
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting...'; }
  try {
    const { data: { session } } = await _sb.auth.getSession();
    const res = await fetch(`${window.BACKEND_URL || ''}/api/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token}`
      },
      body: JSON.stringify({ type })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    window.location.href = data.url;
  } catch (e) {
    console.error('[auth] checkout:', e);
    alert('Payment setup failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = type === 'lifetime' ? 'Get Premium — $5' : 'Subscribe Monthly'; }
  }
}
window.startCheckout = startCheckout;

function showPaymentSuccess() {
  const toast = document.createElement('div');
  toast.className = 'toast toast-success';
  toast.textContent = 'Payment successful! Premium features unlocked.';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ==================== LEADERBOARD ====================

async function showLeaderboard() {
  const overlay = document.getElementById('leaderboard-overlay');
  overlay.style.display = 'flex';
  const body = document.getElementById('leaderboard-body');
  body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px">Loading...</td></tr>';

  try {
    const { data: { session } } = await _sb.auth.getSession();
    const res = await fetch(`${window.BACKEND_URL || ''}/api/leaderboard`, {
      headers: { Authorization: `Bearer ${session?.access_token}` }
    });
    const rows = await res.json();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#888">No ranked games yet</td></tr>';
      return;
    }
    body.innerHTML = rows.map((r, i) => {
      const medal = i === 0 ? '\u{1F947}' : i === 1 ? '\u{1F948}' : i === 2 ? '\u{1F949}' : `${i + 1}`;
      return `
      <tr>
        <td class="lb-rank">${medal}</td>
        <td class="lb-name">
          ${r.avatar_url ? `<img src="${r.avatar_url}" class="lb-avatar">` : ''}
          ${escapeHtml(r.display_name || 'Unknown')}
        </td>
        <td class="lb-played">${r.games_played ?? 0}</td>
        <td class="lb-wins">${r.wins ?? 0}</td>
        <td class="lb-rate">${r.win_rate ?? 0}%</td>
        <td class="lb-points">${r.ranking_points ?? 0}</td>
      </tr>
    `}).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#ef4444">Failed to load</td></tr>`;
  }
}
window.showLeaderboard = showLeaderboard;

// ==================== MARKETPLACE ====================

async function showMarketplace() {
  document.getElementById('marketplace-overlay').style.display = 'flex';
  await loadMarketplaceItems();
}

async function loadMarketplaceItems() {
  const grid = document.getElementById('marketplace-grid');
  grid.innerHTML = '<p class="muted" style="grid-column:1/-1;text-align:center;padding:30px">Loading...</p>';

  try {
    const activeFilter = document.querySelector('.mp-filter.active');
    const type = activeFilter?.dataset.type || '';
    const sort = document.getElementById('mp-sort')?.value || 'created_at';
    const params = new URLSearchParams({ sort });
    if (type) params.set('type', type);

    const res = await fetch(`${window.BACKEND_URL || ''}/api/marketplace?${params}`);
    const items = await res.json();

    if (!items.length) {
      grid.innerHTML = '<p class="muted" style="grid-column:1/-1;text-align:center;padding:30px">No items yet. Be the first to create one!</p>';
      return;
    }

    grid.innerHTML = items.map(item => {
      const stars = item.rating ? '\u2605'.repeat(Math.round(item.rating)) + '\u2606'.repeat(5 - Math.round(item.rating)) : '\u2606\u2606\u2606\u2606\u2606';
      const priceLabel = item.price > 0 ? `${item.price} pts` : 'Free';
      const typeLabel = { board_theme: 'Board', piece_skin: 'Pieces', board_set: 'Set' }[item.item_type] || item.item_type;
      const creator = item.profiles?.display_name || 'Unknown';
      return `
        <div class="mp-card" data-id="${item.id}">
          <div class="mp-preview" style="background:${item.preview_url ? `url(${escapeHtml(item.preview_url)}) center/cover` : 'linear-gradient(135deg, #1a1a2e, #2d1f4e)'}">
            <span class="mp-type-badge">${typeLabel}</span>
          </div>
          <div class="mp-info">
            <div class="mp-title">${escapeHtml(item.title)}</div>
            <div class="mp-meta">
              <span class="mp-creator">by ${escapeHtml(creator)}</span>
              <span class="mp-rating">${stars}</span>
            </div>
            <div class="mp-bottom">
              <span class="mp-price ${item.price > 0 ? 'paid' : 'free'}">${priceLabel}</span>
              <span class="mp-downloads">${item.downloads || 0} downloads</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    grid.innerHTML = '<p class="muted" style="grid-column:1/-1;text-align:center;color:#ef4444">Failed to load marketplace</p>';
  }
}

window.showMarketplace = showMarketplace;

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==================== SCREEN MANAGEMENT ====================

function showSignIn() {
  document.getElementById('signin-screen').style.display = 'flex';
  document.getElementById('lobby-screen').classList.remove('active');
}

function hideSignIn() {
  document.getElementById('signin-screen').style.display = 'none';
  document.getElementById('lobby-screen').classList.add('active');
}

// ==================== GAME.JS LOADER ====================

let _gameLoaded = false;
function loadGameScript() {
  if (_gameLoaded) return;
  _gameLoaded = true;
  const s = document.createElement('script');
  s.src = '/game.js';
  document.body.appendChild(s);
}

// ==================== INIT ====================

async function initApp() {
  // Wire up buttons
  document.getElementById('btn-google-signin')?.addEventListener('click', signInWithGoogle);
  document.getElementById('btn-signout')?.addEventListener('click', signOut);
  document.getElementById('btn-close-payment')?.addEventListener('click', hidePaymentWall);
  document.getElementById('btn-pay-lifetime')?.addEventListener('click', () => startCheckout('lifetime'));
  document.getElementById('btn-pay-monthly')?.addEventListener('click', () => startCheckout('monthly'));
  document.getElementById('btn-leaderboard')?.addEventListener('click', showLeaderboard);
  document.getElementById('btn-close-leaderboard')?.addEventListener('click', () => {
    document.getElementById('leaderboard-overlay').style.display = 'none';
  });

  // Marketplace overlay
  document.getElementById('btn-marketplace')?.addEventListener('click', showMarketplace);
  document.getElementById('btn-close-marketplace')?.addEventListener('click', () => {
    document.getElementById('marketplace-overlay').style.display = 'none';
  });
  document.querySelectorAll('.mp-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mp-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadMarketplaceItems();
    });
  });
  document.getElementById('mp-sort')?.addEventListener('change', loadMarketplaceItems);

  // History overlay
  document.getElementById('btn-history')?.addEventListener('click', () => {
    document.getElementById('history-overlay').style.display = 'flex';
  });
  document.getElementById('btn-close-history')?.addEventListener('click', () => {
    document.getElementById('history-overlay').style.display = 'none';
  });
  document.querySelectorAll('.history-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.history-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.history-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('htab-' + tab.dataset.htab)?.classList.add('active');
    });
  });

  // Load config from backend — no hardcoded keys in frontend
  let config;
  try {
    config = await fetchConfig();
  } catch (e) {
    console.error('[auth] Failed to load config:', e);
    document.getElementById('signin-screen').innerHTML =
      '<div style="color:#ef4444;padding:40px;text-align:center">Server unreachable. Please try again.</div>';
    document.getElementById('signin-screen').style.display = 'flex';
    return;
  }

  _sb = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);
  window.supabaseClient = _sb;

  // Check for existing session
  const { data: { session } } = await _sb.auth.getSession();

  if (session) {
    window.currentUser = session.user;
    window.__jwt = session.access_token;
    await loadUserProfile();

    // Handle payment success redirect
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success') {
      window.history.replaceState({}, '', window.location.pathname);
      await loadUserProfile(); // refresh to get updated premium status
      showPaymentSuccess();
    }

    loadGameScript();
  } else {
    showSignIn();
  }

  // Auth state changes (OAuth redirect return, sign-out)
  _sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      window.currentUser = session.user;
      window.__jwt = session.access_token;
      await loadUserProfile();
      hideSignIn();
      loadGameScript();
    } else if (event === 'TOKEN_REFRESHED' && session) {
      window.__jwt = session.access_token;
      // Keep socket token in sync if available
      if (window.socket?.auth) window.socket.auth.token = session.access_token;
    }
  });
}

initApp();
