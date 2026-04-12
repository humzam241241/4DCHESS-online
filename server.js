// ==================== CHATURAJI MULTIPLAYER SERVER ====================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const Stripe = require('stripe');
// const rateLimit = require('express-rate-limit'); // disabled — causes crashes behind Render proxy
const engine = require('./src/engine');
const engineAoW = require('./src/engineAoW');
const engineEnochian = require('./src/engineEnochian');
const db = require('./src/db');
const supabase = require('./src/supabase');

// Warn on missing env vars (don't crash — Render may inject them late)
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) console.warn(`WARNING: Missing env var ${key}`);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

function getEngine(gameType) {
  if (gameType === 'aow') return engineAoW;
  if (gameType === 'enochian') return engineEnochian;
  return engine;
}
function isPremium(profile) {
  return profile?.has_lifetime_access === true || profile?.subscription_status === 'active';
}

// Admin: email allowlist from env var  e.g. ADMIN_EMAILS=a@b.com,c@d.com
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const CORS_ORIGINS = [
  'http://localhost:3000',
  'https://chaturaji-4dchess.vercel.app',
];
const io = new Server(server, {
  cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ==================== STRIPE WEBHOOK (raw body — must come before express.json) ====================
app.post('/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[Stripe] Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const userId = session.metadata?.user_id;
          if (!userId) break;
          if (session.mode === 'payment') {
            await db.updateProfile(userId, { has_lifetime_access: true });
            console.log(`[Stripe] Lifetime access granted to ${userId}`);
          }
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub = event.data.object;
          const { data: profile } = await supabase
            .from('profiles').select('id').eq('stripe_customer_id', sub.customer).maybeSingle();
          if (profile) {
            await db.updateProfile(profile.id, {
              subscription_status: sub.status === 'active' ? 'active' : 'cancelled',
              stripe_subscription_id: sub.id
            });
          }
          break;
        }
        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const { data: profile } = await supabase
            .from('profiles').select('id').eq('stripe_customer_id', sub.customer).maybeSingle();
          if (profile) {
            await db.updateProfile(profile.id, {
              subscription_status: 'cancelled',
              stripe_subscription_id: null
            });
          }
          break;
        }
      }
    } catch (err) {
      console.error('[Stripe] Webhook handler error:', err);
    }

    res.json({ received: true });
  }
);

// ==================== MIDDLEWARE ====================

// Security headers (H1)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// CORS for REST API (Socket.IO has its own cors config above)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Rate limiting (H5)
// Rate limiting disabled until proxy config is resolved
// const apiLimiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false, validate: false });
// const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 5, message: { error: 'Too many requests' }, validate: false });
// app.use('/api/', apiLimiter);
// app.use('/api/create-checkout', checkoutLimiter);

// Auth middleware for protected routes
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  const { data: { user }, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

// In-memory active game states
const activeGames = new Map();

// ==================== REST API ====================

app.get('/api/games', async (req, res) => {
  try { res.json(await db.getOpenGames()); } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const game = await db.getGame(req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const [players, moves] = await Promise.all([db.getPlayers(game.id), db.getMoves(game.id)]);
    res.json({ game, players, moves });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/games/code/:code', async (req, res) => {
  try {
    const game = await db.getGameByCode(req.params.code.toUpperCase());
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const players = await db.getPlayers(game.id);
    res.json({ game, players });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/games/:id/moves', async (req, res) => {
  try { res.json(await db.getMoves(req.params.id)); } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/stats/:name', async (req, res) => {
  try { res.json(await db.getPlayerStats(req.params.name)); } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/recent', async (req, res) => {
  try { res.json(await db.getRecentGames(20)); } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Public config for frontend (only safe public keys)
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY
  });
});

// ---- Auth-protected routes ----

app.get('/api/my-profile', requireAuth, async (req, res) => {
  try {
    const profile = await db.getOrCreateProfile(
      req.user.id,
      req.user.email,
      req.user.user_metadata?.full_name,
      req.user.user_metadata?.avatar_url
    );
    res.json(profile);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

function isValidHttpsUrl(str) {
  try { const u = new URL(str); return u.protocol === 'https:'; } catch { return false; }
}

const SOCIAL_LINK_KEYS = ['discord', 'youtube', 'twitch', 'twitter', 'github'];

app.put('/api/my-profile', requireAuth, async (req, res) => {
  try {
    const { display_name, bio, social_links, avatar_url } = req.body;
    const updates = {};
    if (display_name !== undefined) updates.display_name = String(display_name).slice(0, 30);
    if (bio !== undefined) updates.bio = String(bio).slice(0, 300);
    if (social_links !== undefined) {
      if (typeof social_links !== 'object' || social_links === null || Array.isArray(social_links)) {
        return res.status(400).json({ error: 'social_links must be an object' });
      }
      const sanitized = {};
      for (const key of SOCIAL_LINK_KEYS) {
        if (key in social_links) {
          const val = String(social_links[key] || '').slice(0, 200);
          if (val && !isValidHttpsUrl(val)) return res.status(400).json({ error: `${key} must be a valid https URL` });
          sanitized[key] = val || null;
        }
      }
      updates.social_links = sanitized;
    }
    if (avatar_url !== undefined) {
      if (avatar_url && !isValidHttpsUrl(avatar_url)) {
        return res.status(400).json({ error: 'avatar_url must be a valid https URL' });
      }
      updates.avatar_url = avatar_url || null;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' });
    await db.updateProfile(req.user.id, updates);
    const profile = await db.getProfile(req.user.id);
    res.json(profile);
  } catch (e) { console.error('[my-profile]', e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/my-stats', requireAuth, async (req, res) => {
  try {
    const { data: playerRows } = await supabase.from('players')
      .select('color, placement, games!inner(status)')
      .eq('user_id', req.user.id);
    const finished = (playerRows || []).filter(r => r.games?.status === 'finished');
    const wins = finished.filter(r => r.placement === 'gold').length;
    const silvers = finished.filter(r => r.placement === 'silver').length;
    const bronzes = finished.filter(r => r.placement === 'bronze').length;
    res.json({
      games_played: finished.length,
      wins,
      silvers,
      bronzes,
      win_rate: finished.length > 0 ? Math.round((wins / finished.length) * 100) : 0,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/my-items', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('marketplace_items')
      .select('*')
      .eq('creator_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/leaderboard', requireAuth, async (req, res) => {
  try {
    const profile = await db.getProfile(req.user.id);
    if (!isPremium(profile)) return res.status(403).json({ error: 'Premium required' });
    res.json(await db.getLeaderboard());
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ==================== ADMIN MIDDLEWARE + ROUTES ====================

async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  const { data: { user }, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  const email = (user.email || '').toLowerCase();
  if (!ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Admin access required' });
  req.user = user;
  next();
}

// Overview stats
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const [{ data: profiles }, { data: games }] = await Promise.all([
      supabase.from('profiles').select('has_lifetime_access, subscription_status, is_admin'),
      supabase.from('games').select('status')
    ]);
    const p = profiles || [];
    const g = games || [];
    res.json({
      totalUsers:        p.length,
      lifetimeUsers:     p.filter(u => u.has_lifetime_access).length,
      activeSubscribers: p.filter(u => u.subscription_status === 'active').length,
      freeUsers:         p.filter(u => !u.has_lifetime_access && u.subscription_status !== 'active').length,
      adminUsers:        p.filter(u => u.is_admin).length,
      totalGames:        g.length,
      activePlaying:     g.filter(x => x.status === 'playing').length,
      waitingGames:      g.filter(x => x.status === 'waiting').length,
      finishedGames:     g.filter(x => x.status === 'finished').length,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// All users (join auth.users + profiles + game counts)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { data: { users: authUsers } } = await supabase.auth.admin.listUsers({ perPage: 500 });
    const { data: profiles } = await supabase.from('profiles').select('*');
    const { data: playerRows } = await supabase.from('players').select('user_id').not('user_id', 'is', null);

    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });

    const gameCounts = {};
    (playerRows || []).forEach(r => {
      gameCounts[r.user_id] = (gameCounts[r.user_id] || 0) + 1;
    });

    const users = (authUsers || []).map(u => ({
      id: u.id,
      email: u.email,
      display_name: profileMap[u.id]?.display_name || u.user_metadata?.full_name || null,
      avatar_url: profileMap[u.id]?.avatar_url || null,
      has_lifetime_access: profileMap[u.id]?.has_lifetime_access || false,
      subscription_status: profileMap[u.id]?.subscription_status || 'none',
      is_admin: profileMap[u.id]?.is_admin || false,
      games_played: gameCounts[u.id] || 0,
      created_at: u.created_at,
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ users });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Update a user's access/permissions
app.patch('/api/admin/users/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const allowed = ['has_lifetime_access', 'subscription_status'];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
    await db.updateProfile(userId, updates);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Recent games
app.get('/api/admin/games', requireAdmin, async (req, res) => {
  try {
    const games = await db.getRecentGames(50);
    res.json({ games });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Revenue from Stripe
app.get('/api/admin/revenue', requireAdmin, async (req, res) => {
  let lifetimeTotal = 0, activeSubscriptions = 0;
  try {
    const charges = await stripe.paymentIntents.list({ limit: 100 });
    lifetimeTotal = charges.data
      .filter(p => p.status === 'succeeded')
      .reduce((sum, p) => sum + p.amount, 0);
  } catch (e) { console.warn('[admin/revenue] paymentIntents.list failed:', e.message); }
  try {
    const subs = await stripe.subscriptions.list({ limit: 100, status: 'active' });
    activeSubscriptions = subs.data.length;
  } catch (e) { console.warn('[admin/revenue] subscriptions.list failed:', e.message); }
  const monthlyTotal = activeSubscriptions * 300;
  res.json({ lifetimeTotal, monthlyTotal, grossTotal: lifetimeTotal + monthlyTotal, activeSubscriptions });
});

// ==================== MARKETPLACE API ====================

// Browse marketplace items
app.get('/api/marketplace', async (req, res) => {
  try {
    const { type, sort = 'created_at' } = req.query;
    let query = supabase.from('marketplace_items').select('*, profiles!creator_id(display_name, avatar_url)')
      .eq('status', 'approved');
    if (type) query = query.eq('item_type', type);
    if (sort === 'popular') query = query.order('downloads', { ascending: false });
    else if (sort === 'rating') query = query.order('rating', { ascending: false });
    else query = query.order('created_at', { ascending: false });
    const { data, error } = await query.limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Get single item
app.get('/api/marketplace/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('marketplace_items')
      .select('*, profiles!creator_id(display_name, avatar_url)')
      .eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Item not found' });
    // Get reviews
    const { data: reviews } = await supabase.from('marketplace_reviews')
      .select('*, profiles!user_id(display_name)').eq('item_id', req.params.id)
      .order('created_at', { ascending: false }).limit(20);
    res.json({ ...data, reviews: reviews || [] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Create item (auth required)
app.post('/api/marketplace', requireAuth, async (req, res) => {
  try {
    const { title, description, item_type, preview_url, asset_data, price } = req.body;
    if (!title || !item_type) return res.status(400).json({ error: 'Title and item_type required' });
    const { data, error } = await supabase.from('marketplace_items').insert({
      creator_id: req.user.id, title, description, item_type,
      preview_url, asset_data, price: price || 0,
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Purchase/download item
app.post('/api/marketplace/:id/purchase', requireAuth, async (req, res) => {
  try {
    const item = await supabase.from('marketplace_items').select('*').eq('id', req.params.id).single();
    if (item.error || !item.data) return res.status(404).json({ error: 'Item not found' });
    // Check if already purchased
    const { data: existing } = await supabase.from('marketplace_purchases')
      .select('id').eq('user_id', req.user.id).eq('item_id', req.params.id).maybeSingle();
    if (existing) return res.json({ already_owned: true, asset_data: item.data.asset_data });
    // Atomic deduction — prevents race condition from concurrent requests
    if (item.data.price > 0) {
      const { data: deducted, error: deductErr } = await supabase.rpc('deduct_ranking_points', {
        target_user: req.user.id,
        amount: item.data.price,
      });
      if (deductErr || !deducted) {
        return res.status(400).json({ error: 'Not enough ranking points' });
      }
    }
    await supabase.from('marketplace_purchases').insert({ user_id: req.user.id, item_id: req.params.id });
    await supabase.from('marketplace_items').update({ downloads: (item.data.downloads || 0) + 1 }).eq('id', req.params.id);
    res.json({ purchased: true, asset_data: item.data.asset_data });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Review item
app.post('/api/marketplace/:id/review', requireAuth, async (req, res) => {
  try {
    const { rating, review_text } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating 1-5 required' });
    const { error } = await supabase.from('marketplace_reviews').upsert({
      user_id: req.user.id, item_id: req.params.id, rating, review_text,
    }, { onConflict: 'user_id,item_id' });
    if (error) throw error;
    // Update average rating
    const { data: reviews } = await supabase.from('marketplace_reviews').select('rating').eq('item_id', req.params.id);
    if (reviews?.length) {
      const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
      await supabase.from('marketplace_items').update({ rating: Math.round(avg * 100) / 100 }).eq('id', req.params.id);
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ==================== SOCIAL API ====================

// Get user profile
app.get('/api/users/:id', async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles')
      .select('id, display_name, avatar_url, bio, ranking_points, followers_count, following_count')
      .eq('id', req.params.id).maybeSingle();
    if (!profile) return res.status(404).json({ error: 'User not found' });
    const { data: items } = await supabase.from('marketplace_items')
      .select('*').eq('creator_id', req.params.id).eq('status', 'approved')
      .order('created_at', { ascending: false }).limit(20);
    res.json({ ...profile, items: items || [] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Follow user
app.post('/api/follow/:userId', requireAuth, async (req, res) => {
  try {
    if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });
    const { error } = await supabase.from('follows').insert({
      follower_id: req.user.id, following_id: req.params.userId,
    });
    if (error && error.code === '23505') return res.json({ already_following: true });
    if (error) throw error;
    // Update counts
    await supabase.rpc('increment_followers', { target_user: req.params.userId });
    await supabase.rpc('increment_following', { target_user: req.user.id });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Unfollow user
app.delete('/api/follow/:userId', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('follows').delete()
      .eq('follower_id', req.user.id).eq('following_id', req.params.userId)
      .select();
    if (error) throw error;
    if (data && data.length > 0) {
      await supabase.rpc('decrement_followers', { target_user: req.params.userId }).catch(() => {});
      await supabase.rpc('decrement_following', { target_user: req.user.id }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { console.error('[unfollow]', e); res.status(500).json({ error: 'Server error' }); }
});

// Direct messages — list conversations
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('direct_messages')
      .select('*, sender:profiles!sender_id(display_name, avatar_url), receiver:profiles!receiver_id(display_name, avatar_url)')
      .or(`sender_id.eq.${req.user.id},receiver_id.eq.${req.user.id}`)
      .order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Send direct message
app.post('/api/messages/:userId', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || message.length > 2000) return res.status(400).json({ error: 'Message required (max 2000 chars)' });
    const { error } = await supabase.from('direct_messages').insert({
      sender_id: req.user.id, receiver_id: req.params.userId, message: message.trim(),
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Activity feed
app.get('/api/feed', requireAuth, async (req, res) => {
  try {
    const { data: following } = await supabase.from('follows')
      .select('following_id').eq('follower_id', req.user.id);
    const followingIds = (following || []).map(f => f.following_id);
    followingIds.push(req.user.id); // Include own activity
    const { data, error } = await supabase.from('activity_feed')
      .select('*, profiles!user_id(display_name, avatar_url)')
      .in('user_id', followingIds)
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ==================== STRIPE CHECKOUT ====================

app.post('/api/create-checkout', requireAuth, async (req, res) => {
  try {
    const { type } = req.body; // 'lifetime' | 'monthly'
    if (!['lifetime', 'monthly'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

    let profile = await db.getOrCreateProfile(req.user.id, req.user.email);
    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { user_id: req.user.id }
      });
      customerId = customer.id;
      await db.updateProfile(req.user.id, { stripe_customer_id: customerId });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: type === 'lifetime' ? 'payment' : 'subscription',
      line_items: [{
        price: type === 'lifetime'
          ? process.env.STRIPE_LIFETIME_PRICE_ID
          : process.env.STRIPE_MONTHLY_PRICE_ID,
        quantity: 1
      }],
      success_url: `${frontendUrl}?payment=success`,
      cancel_url: `${frontendUrl}?payment=cancelled`,
      metadata: { user_id: req.user.id, type }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('[Stripe] Checkout error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== SOCKET.IO AUTH MIDDLEWARE ====================
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return next(new Error('Invalid or expired token'));
  socket.data.userId = user.id;
  socket.data.userEmail = user.email;
  next();
});

// ==================== SOCKET.IO ====================

async function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (await db.getGameByCode(code)) return generateRoomCode();
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected (user: ${socket.data.userId})`);

  // Per-socket event throttle to prevent spam/DoS
  const eventCounts = {};
  const originalEmit = socket.onevent;
  socket.onevent = function(packet) {
    const event = packet.data?.[0];
    if (event) {
      const now = Date.now();
      if (!eventCounts[event]) eventCounts[event] = { count: 0, reset: now + 1000 };
      if (now > eventCounts[event].reset) { eventCounts[event] = { count: 0, reset: now + 1000 }; }
      eventCounts[event].count++;
      if (eventCounts[event].count > 30) return; // silently drop
    }
    originalEmit.call(this, packet);
  };

  // ---- CREATE GAME ----
  socket.on('create-game', async ({ playerName, randomColor, gameType = 'classic', preferredColors }, callback) => {
    try {
      const gameId = uuidv4();
      const code = await generateRoomCode();
      const eng = getEngine(gameType);
      // If player chose preferred colors for solo play, use the first one; otherwise random or default
      // Use eng.PLAYERS[0] instead of hardcoded 'red' — Enochian starts with 'yellow'
      const color = (preferredColors && preferredColors.length > 0)
        ? preferredColors[0]
        : randomColor
          ? eng.PLAYERS[Math.floor(Math.random() * eng.PLAYERS.length)]
          : eng.PLAYERS[0];

      await db.createGameRecord(gameId, code, gameType);
      await db.addPlayer(gameId, color, playerName, socket.id, socket.data.userId);

      const state = eng.createGame();
      activeGames.set(gameId, state);
      await db.updateGameState(gameId, state);

      socket.join(gameId);
      socket.data = { ...socket.data, gameId, color, playerName, gameType, preferredColors: preferredColors || [] };

      callback({ gameId, code, color, gameType, state: sanitizeState(state), players: sortPlayers(await db.getPlayers(gameId)) });
      console.log(`[Game] ${playerName} created ${gameType} game ${code} (${gameId}) as ${color}`);
    } catch (e) { console.error('[create-game]', e); callback({ error: 'Server error' }); }
  });

  // ---- JOIN GAME ----
  socket.on('join-game', async ({ code, playerName, randomColor, takeOverBot }, callback) => {
    try {
      const game = await db.getGameByCode(code.toUpperCase());
      if (!game) return callback({ error: 'Game not found' });
      if (game.status === 'finished') return callback({ error: 'Game is already finished' });

      const players = await db.getPlayers(game.id);
      const gameType = game.game_type || 'classic';
      const eng = getEngine(gameType);

      // Check for bot slots that can be taken over
      const botPlayers = players.filter(p => !p.socket_id && p.name.startsWith('Bot'));
      const humanPlayers = players.filter(p => p.socket_id || !p.name.startsWith('Bot'));

      let color;

      if (players.length >= 4 && botPlayers.length > 0) {
        // Game is full but has bots — offer takeover or auto-take if requested
        if (!takeOverBot) {
          // Send back bot info so client can ask user which bot to replace
          return callback({
            canTakeOver: true,
            bots: botPlayers.map(b => ({ color: b.color, name: b.name })),
            gameId: game.id,
            code: game.code,
            gameType,
          });
        }
        // takeOverBot is the color of the bot to replace
        const botToReplace = botPlayers.find(b => b.color === takeOverBot);
        if (!botToReplace) return callback({ error: 'That bot slot is no longer available' });
        color = botToReplace.color;
        // Replace the bot: update the player record with the new human's info
        await db.updatePlayerSocket(game.id, color, socket.id, true);
        await supabase.from('players').update({
          name: playerName,
          user_id: socket.data.userId,
          socket_id: socket.id,
          connected: true,
        }).eq('game_id', game.id).eq('color', color);
      } else if (players.length >= 4) {
        return callback({ error: 'Game is full' });
      } else {
        // Normal join — open slot available
        const taken = players.map(p => p.color);
        const available = eng.PLAYERS.filter(c => !taken.includes(c));
        color = randomColor
          ? available[Math.floor(Math.random() * available.length)]
          : available[0];
        await db.addPlayer(game.id, color, playerName, socket.id, socket.data.userId);
      }

      socket.join(game.id);
      socket.data = { ...socket.data, gameId: game.id, color, playerName, gameType };

      const allPlayers = await db.getPlayers(game.id);
      let state = activeGames.get(game.id);
      if (!state) {
        state = game.state || eng.createGame();
        activeGames.set(game.id, state);
      }

      const sorted = sortPlayers(allPlayers);
      callback({ gameId: game.id, code: game.code, color, gameType, state: sanitizeState(state), players: sorted });
      socket.to(game.id).emit('player-joined', { color, name: playerName, players: sorted });

      if (allPlayers.length === 4 && game.status === 'waiting') {
        await db.setGameStarted(game.id);
        io.to(game.id).emit('game-started', { state: sanitizeState(state), players: sorted });
        console.log(`[Game] ${game.code} started with 4 players`);
      }

      // If this was a bot takeover on an in-progress game and another bot is
      // still the current player, re-arm the bot scheduler (it may have been
      // lost if the server restarted while the slot was a bot).
      if (state && !state.winner && game.status === 'playing') {
        scheduleBotMove(game.id, state);
      }

      console.log(`[Game] ${playerName} joined ${game.code} as ${color}`);
    } catch (e) { console.error('[join-game]', e); callback({ error: 'Server error' }); }
  });

  // ---- REJOIN GAME ----
  socket.on('rejoin-game', async ({ gameId, color, playerName }, callback) => {
    try {
      const game = await db.getGame(gameId);
      if (!game) return callback({ error: 'Game not found' });

      // Verify the caller actually owns this seat
      const players = await db.getPlayers(gameId);
      const seat = players.find(p => p.color === color);
      if (!seat || (seat.user_id && seat.user_id !== socket.data.userId)) {
        return callback({ error: 'Not your seat' });
      }

      const gameType = game.game_type || 'classic';
      await db.updatePlayerSocket(gameId, color, socket.id, true);
      socket.join(gameId);
      socket.data = { ...socket.data, gameId, color, playerName, gameType };

      let state = activeGames.get(gameId);
      if (!state && game.state) {
        state = game.state; // already an object (JSONB)
        activeGames.set(gameId, state);
      }

      const [allPlayers, moves, chat] = await Promise.all([
        db.getPlayers(gameId),
        db.getMoves(gameId),
        db.getChatMessages(gameId)
      ]);

      callback({ state: sanitizeState(state), players: sortPlayers(allPlayers), moves, chat, gameType });
      socket.to(gameId).emit('player-reconnected', { color, name: playerName });
      console.log(`[Game] ${playerName} rejoined ${gameId}`);

      // If the current player is a bot, the bot's setTimeout from the previous
      // process may have been lost (server restart, crash, or long disconnect).
      // Re-arm the scheduler so the bot isn't stuck forever. scheduleBotMove
      // is idempotent and self-exits if the current player is a human.
      if (state && !state.winner) scheduleBotMove(gameId, state);
    } catch (e) { console.error('[rejoin-game]', e); callback({ error: 'Server error' }); }
  });

  // ---- ROLL DICE ----
  socket.on('roll-dice', async (callback) => {
    try {
      const { gameId, color, gameType } = socket.data || {};
      if (!gameId) return callback({ error: 'Not in a game' });

      const state = activeGames.get(gameId);
      if (!state) return callback({ error: 'Game not found' });
      if (!isPlayerColor(socket.data, state.currentPlayer)) return callback({ error: 'Not your turn' });

      const eng = getEngine(gameType || state.gameType);
      const result = eng.rollDice(state);
      if (result.error) return callback({ error: result.error });

      activeGames.set(gameId, result.state);
      await db.updateGameState(gameId, result.state);

      callback({ dice: result.dice, state: sanitizeState(result.state) });
      socket.to(gameId).emit('dice-rolled', { player: color, dice: result.dice, state: sanitizeState(result.state) });

      scheduleBotMove(gameId, result.state);
    } catch (e) { console.error('[roll-dice]', e); callback({ error: 'Server error' }); }
  });

  // ---- GET VALID MOVES ----
  socket.on('get-moves', ({ row, col }, callback) => {
    const { gameId, color, gameType } = socket.data || {};
    if (!gameId) return callback({ error: 'Not in a game' });

    const state = activeGames.get(gameId);
    if (!state) return callback({ error: 'Game not found' });

    const piece = state.board[row][col];
    if (!piece || !isPlayerColor(socket.data, piece.color)) return callback({ moves: [] });

    const eng = getEngine(gameType || state.gameType);
    const availTypes = eng.getAvailablePieceTypes(state);
    if (!availTypes.includes(piece.type)) return callback({ moves: [] });

    callback({ moves: eng.getValidMoves(state.board, row, col, state) });
  });

  // ---- MAKE MOVE ----
  socket.on('make-move', async ({ fromRow, fromCol, toRow, toCol }, callback) => {
    try {
      const { gameId, color, gameType } = socket.data || {};
      if (!gameId) return callback({ error: 'Not in a game' });

      const state = activeGames.get(gameId);
      if (!state) return callback({ error: 'Game not found' });
      if (!isPlayerColor(socket.data, state.currentPlayer)) return callback({ error: 'Not your turn' });

      const eng = getEngine(gameType || state.gameType);
      const result = eng.executeMove(state, fromRow, fromCol, toRow, toCol);
      if (result.error) return callback({ error: result.error });

      activeGames.set(gameId, result.state);
      await db.updateGameState(gameId, result.state);
      // Move history is informational, not state-critical. Don't let a
      // recordMove failure bubble up and mask a successful move — the user
      // would see a "Server error" toast and no UI update even though the
      // game state already committed above, then the move would appear only
      // after a refresh.
      await db.recordMove(gameId, result.move).catch(e => console.error('[make-move] recordMove', e));

      let rankingResult = null;
      if (result.state.winner) {
        await db.setGameFinished(gameId, result.state.winner);
        rankingResult = await db.awardRankingPoints(gameId, result.state.placements).catch(e => { console.error('[ranking]', e); return null; });
      }

      callback({ state: sanitizeState(result.state), move: result.move });
      socket.to(gameId).emit('move-made', { state: sanitizeState(result.state), move: result.move });

      // If there's a pending promotion, notify the player
      if (result.state.pendingPromotion) {
        const promo = result.state.pendingPromotion;
        io.to(gameId).emit('promotion-needed', {
          color: promo.color,
          row: promo.row,
          col: promo.col,
          options: promo.options,
        });
        // If it's a bot's pawn, auto-promote to the best piece
        if (await isBot(gameId, promo.color)) {
          const bestType = promo.options[0]; // elephant > horse > boat
          const eng = getEngine(gameType || state.gameType);
          const promoResult = eng.applyPromotion(result.state, bestType);
          if (!promoResult.error) {
            activeGames.set(gameId, result.state);
            await db.updateGameState(gameId, result.state);
            io.to(gameId).emit('promotion-applied', {
              color: promo.color,
              row: promo.row,
              col: promo.col,
              promotedTo: promoResult.promotedTo,
              state: sanitizeState(result.state),
            });
          }
        }
      }

      // Announce elimination with placement rank
      if (result.move.captured?.type === 'king' && result.state.eliminationOrder) {
        const elimColor = result.move.captured.color;
        const elimCount = result.state.eliminationOrder.length;
        const rankLabels = { 1: '4th Place', 2: '3rd Place (Bronze)', 3: '2nd Place (Silver)' };
        const rankLabel = rankLabels[elimCount] || `Eliminated (#${elimCount})`;
        io.to(gameId).emit('player-eliminated', { color: elimColor, rank: rankLabel });
      }

      if (result.state.winner) {
        cancelPendingBotMove(gameId);
        io.to(gameId).emit('game-over', {
          winner: result.state.winner,
          winnerTeam: result.state.winnerTeam || null,
          placements: result.state.placements || null,
          oddEvenCode: rankingResult?.oddEvenCode || null,
          playerPoints: rankingResult?.playerPoints || null,
          captureScores: rankingResult?.captureScores || null,
          geomanticFigure: rankingResult?.geomanticFigure || null,
        });
      } else {
        scheduleBotMove(gameId, result.state);
      }
    } catch (e) { console.error('[make-move]', e); callback({ error: 'Server error' }); }
  });

  // ---- SKIP TURN ----
  socket.on('skip-turn', async (callback) => {
    try {
      const { gameId, color, gameType } = socket.data || {};
      if (!gameId) return callback({ error: 'Not in a game' });

      const state = activeGames.get(gameId);
      if (!state) return callback({ error: 'Game not found' });
      if (!isPlayerColor(socket.data, state.currentPlayer)) return callback({ error: 'Not your turn' });

      const eng = getEngine(gameType || state.gameType);
      const result = eng.skipTurn(state);
      if (result.error) return callback({ error: result.error });

      activeGames.set(gameId, result.state);
      await db.updateGameState(gameId, result.state);

      callback({ state: sanitizeState(result.state) });
      socket.to(gameId).emit('turn-skipped', { player: color, state: sanitizeState(result.state) });

      scheduleBotMove(gameId, result.state);
    } catch (e) { console.error('[skip-turn]', e); callback({ error: 'Server error' }); }
  });

  // ---- PROMOTE PAWN ----
  socket.on('promote-pawn', async ({ chosenType }, callback) => {
    try {
      const { gameId, gameType } = socket.data || {};
      if (!gameId) return callback({ error: 'Not in a game' });

      const state = activeGames.get(gameId);
      if (!state) return callback({ error: 'Game not found' });
      if (!state.pendingPromotion) return callback({ error: 'No pending promotion' });
      if (!isPlayerColor(socket.data, state.pendingPromotion.color)) return callback({ error: 'Not your promotion' });

      const eng = getEngine(gameType || state.gameType);
      const promoResult = eng.applyPromotion(state, chosenType);
      if (promoResult.error) return callback({ error: promoResult.error });

      // Turn advancement is now handled inside applyPromotion

      activeGames.set(gameId, state);
      await db.updateGameState(gameId, state);

      callback({ state: sanitizeState(state), promotedTo: promoResult.promotedTo });
      io.to(gameId).emit('promotion-applied', {
        color: state.currentPlayer,
        promotedTo: promoResult.promotedTo,
        state: sanitizeState(state),
      });

      scheduleBotMove(gameId, state);
    } catch (e) { console.error('[promote-pawn]', e); callback({ error: 'Server error' }); }
  });

  // ---- CHAT ----
  socket.on('chat-message', async ({ message }) => {
    const { gameId, color, playerName } = socket.data || {};
    if (!gameId || !message || message.length > 500) return;
    const sanitized = message.trim().slice(0, 500);
    await db.addChatMessage(gameId, color, playerName, sanitized).catch(() => {});
    io.to(gameId).emit('chat-message', { color, name: playerName, message: sanitized, timestamp: Date.now() });
  });

  // ---- START GAME (with bots) ----
  socket.on('start-game', async (callback) => {
    try {
      const { gameId, gameType, preferredColors } = socket.data || {};
      if (!gameId) return callback({ error: 'Not in a game' });

      const game = await db.getGame(gameId);
      const players = await db.getPlayers(gameId);
      if (players.length < 1) return callback({ error: 'Need at least 1 player' });
      // Only the first player (game creator) can start the game
      const creator = players[0];
      if (creator.user_id && creator.user_id !== socket.data.userId) {
        return callback({ error: 'Only the game creator can start the game' });
      }

      const eng = getEngine(gameType || game.game_type);
      const state = activeGames.get(gameId);

      // If player chose 2 colors, add the second color as a human-controlled slot
      const taken = players.map(p => p.color);
      if (preferredColors && preferredColors.length === 2) {
        const secondColor = preferredColors[1];
        if (!taken.includes(secondColor)) {
          // Add second color as the same player (same socket, same user)
          await db.addPlayer(gameId, secondColor, players[0].name, socket.id, socket.data.userId);
          taken.push(secondColor);
        }
      }

      const bots = eng.PLAYERS.filter(c => !taken.includes(c));
      for (const botColor of bots) {
        await db.addPlayer(gameId, botColor, `Bot (${eng.PLAYER_NAMES[botColor]})`, null, null);
      }

      await db.setGameStarted(gameId);
      const allPlayers = sortPlayers(await db.getPlayers(gameId));

      callback({ state: sanitizeState(state), players: allPlayers, gameType: game.game_type });
      io.to(gameId).emit('game-started', { state: sanitizeState(state), players: allPlayers, gameType: game.game_type });

      scheduleBotMove(gameId, state);
    } catch (e) { console.error('[start-game]', e); callback({ error: 'Server error' }); }
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', async () => {
    const { gameId, color, playerName } = socket.data || {};
    if (gameId && color) {
      await db.updatePlayerSocket(gameId, color, null, false).catch(() => {});
      socket.to(gameId).emit('player-disconnected', { color, name: playerName });
      console.log(`[-] ${playerName} (${color}) disconnected from ${gameId}`);
    }
  });
});

// ==================== HELPERS ====================

const COLOR_ORDER = ['red', 'yellow', 'green', 'black'];
function sortPlayers(players) {
  return [...players].sort((a, b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color));
}

// ==================== SIMPLE BOT AI ====================

async function isBot(gameId, color) {
  const players = await db.getPlayers(gameId);
  const player = players.find(p => p.color === color);
  return player && !player.socket_id && player.name.startsWith('Bot');
}

// Check if a color belongs to the given socket's player (for multi-color solo play)
function isPlayerColor(socketData, color) {
  if (socketData.color === color) return true;
  if (socketData.preferredColors && socketData.preferredColors.includes(color)) return true;
  return false;
}

// Tracks the pending setTimeout handle per game so we can cancel/replace it.
// Critical for idempotency: rejoin-game and move handlers can both schedule,
// and without this we'd get racing bot actions on the same turn.
const pendingBotTimers = new Map();

function cancelPendingBotMove(gameId) {
  const existing = pendingBotTimers.get(gameId);
  if (existing) {
    clearTimeout(existing);
    pendingBotTimers.delete(gameId);
  }
}

function scheduleBotMove(gameId, state) {
  if (!state || state.winner) { cancelPendingBotMove(gameId); return; }
  cancelPendingBotMove(gameId);

  // Emit immediate bot-thinking signal so the client can show a timer
  // BEFORE the setTimeout delay runs. Optimistic — if it turns out not
  // to be a bot, the client's state-driven check will cancel the indicator.
  (async () => {
    try {
      if (await isBot(gameId, state.currentPlayer)) {
        io.to(gameId).emit('bot-thinking', { color: state.currentPlayer });
      }
    } catch {}
  })();

  const timer = setTimeout(async () => {
    pendingBotTimers.delete(gameId);
    try {
      let current = activeGames.get(gameId);
      if (!current || current.winner) return;
      if (!await isBot(gameId, current.currentPlayer)) return;

      const game = await db.getGame(gameId);
      const eng = getEngine(game?.game_type);

      // Resolve any stuck pending promotion for this bot
      if (current.pendingPromotion && await isBot(gameId, current.pendingPromotion.color)) {
        const promo = current.pendingPromotion;
        const bestType = promo.options ? promo.options[0] : 'elephant';
        const promoResult = eng.applyPromotion(current, bestType);
        if (!promoResult.error) {
          activeGames.set(gameId, current);
          await db.updateGameState(gameId, current);
          io.to(gameId).emit('promotion-applied', {
            color: promo.color, row: promo.row, col: promo.col,
            promotedTo: promoResult.promotedTo, state: sanitizeState(current),
          });
        }
      }

      if (current.phase === 'roll') {
        const rollResult = eng.rollDice(current);
        if (rollResult.error) return;
        current = rollResult.state;
        activeGames.set(gameId, current);
        await db.updateGameState(gameId, current);
        io.to(gameId).emit('dice-rolled', { player: current.currentPlayer, dice: rollResult.dice, state: sanitizeState(current) });
        if (current.phase === 'roll') { scheduleBotMove(gameId, current); return; }
      }

      await makeBotMoves(gameId, current, eng);
    } catch (e) {
      console.error('[bot] scheduled move failed', e);
      // Don't leave the game permanently stuck — try again shortly.
      const retryState = activeGames.get(gameId);
      if (retryState && !retryState.winner) {
        setTimeout(() => scheduleBotMove(gameId, activeGames.get(gameId)), 2000);
      }
    }
  }, 1500 + Math.random() * 1200);

  pendingBotTimers.set(gameId, timer);
}

async function makeBotMoves(gameId, state, eng = engine) {
  if (!state || state.phase !== 'move' || state.winner) return;

  const types = eng.getAvailablePieceTypes(state);
  let bestMove = null, bestScore = -Infinity;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (!p || p.color !== state.currentPlayer || !types.includes(p.type)) continue;
      const moves = eng.getValidMoves(state.board, r, c, state);
      for (const m of moves) {
        let score = Math.random() * 2;
        const target = state.board[m.row][m.col];
        if (target) {
          score += 10;
          if (target.type === 'king')     score += 100;
          if (target.type === 'queen')    score += 18;
          if (target.type === 'rook')     score += 10;
          if (target.type === 'elephant') score += 8;
          if (target.type === 'bishop')   score += 6;
          if (target.type === 'horse')    score += 6;
          if (target.type === 'knight')   score += 6;
          // Bonus: capturing a double-occupied throne captures an extra piece
          if (target.thronePartner)       score += 8;
        }
        score += (3.5 - Math.abs(m.row - 3.5)) + (3.5 - Math.abs(m.col - 3.5));
        if (score > bestScore) { bestScore = score; bestMove = { fromRow: r, fromCol: c, toRow: m.row, toCol: m.col }; }
      }
    }
  }

  if (!bestMove) {
    const skipResult = eng.skipTurn(state);
    if (skipResult.error) {
      console.error('[bot] no moves AND skipTurn failed for', state.currentPlayer, skipResult.error);
      return;
    }
    activeGames.set(gameId, skipResult.state);
    await db.updateGameState(gameId, skipResult.state);
    io.to(gameId).emit('turn-skipped', { player: state.currentPlayer, state: sanitizeState(skipResult.state) });
    scheduleBotMove(gameId, skipResult.state);
    return;
  }

  const result = eng.executeMove(state, bestMove.fromRow, bestMove.fromCol, bestMove.toRow, bestMove.toCol);
  if (result.error) {
    console.error('[bot] executeMove failed for', state.currentPlayer, result.error, bestMove);
    // Don't leave the game frozen — try skipping this turn instead.
    const skipResult = eng.skipTurn(state);
    if (!skipResult.error) {
      activeGames.set(gameId, skipResult.state);
      await db.updateGameState(gameId, skipResult.state).catch(e => console.error('[bot] updateGameState', e));
      io.to(gameId).emit('turn-skipped', { player: state.currentPlayer, state: sanitizeState(skipResult.state) });
      scheduleBotMove(gameId, skipResult.state);
    }
    return;
  }

  // Auto-resolve bot pawn promotion
  if (result.state.pendingPromotion) {
    const promo = result.state.pendingPromotion;
    const bestType = promo.options ? promo.options[0] : 'elephant';
    const promoResult = eng.applyPromotion(result.state, bestType);
    if (!promoResult.error) {
      result.move.promotion = promoResult.promotedTo;
      io.to(gameId).emit('promotion-applied', {
        color: promo.color,
        row: promo.row,
        col: promo.col,
        promotedTo: promoResult.promotedTo,
        state: sanitizeState(result.state),
      });
    }
  }

  activeGames.set(gameId, result.state);
  await db.updateGameState(gameId, result.state);
  await db.recordMove(gameId, result.move).catch(e => console.error('[bot] recordMove', e));
  io.to(gameId).emit('move-made', { state: sanitizeState(result.state), move: result.move });

  if (result.state.winner) {
    cancelPendingBotMove(gameId);
    await db.setGameFinished(gameId, result.state.winner);
    const rankingResult = await db.awardRankingPoints(gameId, result.state.placements).catch(e => { console.error('[ranking]', e); return null; });
    io.to(gameId).emit('game-over', {
      winner: result.state.winner,
      winnerTeam: result.state.winnerTeam || null,
      placements: result.state.placements || null,
      oddEvenCode: rankingResult?.oddEvenCode || null,
      playerPoints: rankingResult?.playerPoints || null,
      captureScores: rankingResult?.captureScores || null,
      geomanticFigure: rankingResult?.geomanticFigure || null,
    });
    return;
  }

  // Always go through scheduleBotMove — it's idempotent and safely re-exits if
  // the current player turns out to be human. Previously this path used a raw
  // setTimeout that bypassed the bot timer registry and could race with a
  // rejoin-triggered schedule.
  scheduleBotMove(gameId, result.state);
}

function sanitizeState(state) {
  if (!state) return null;
  const { moveHistory, ...rest } = state;
  return rest;
}

// ==================== START ====================
server.listen(PORT, () => {
  console.log(`\n  Chaturaji server running on http://localhost:${PORT}\n`);
});
