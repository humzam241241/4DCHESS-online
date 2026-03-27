// ==================== CHATURAJI MULTIPLAYER SERVER ====================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const Stripe = require('stripe');
const engine = require('./src/engine');
const engine2v2 = require('./src/engine2v2');
const db = require('./src/db');
const supabase = require('./src/supabase');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

function getEngine(gameType) { return gameType === '2v2' ? engine2v2 : engine; }
function isPremium(profile) {
  return profile?.has_lifetime_access === true || profile?.subscription_status === 'active';
}

// Admin: email allowlist from env var  e.g. ADMIN_EMAILS=a@b.com,c@d.com
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://chaturaji-4dchess.vercel.app', /\.vercel\.app$/],
    methods: ['GET', 'POST']
  }
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

// CORS for REST API (Socket.IO has its own cors config above)
const ALLOWED_ORIGINS = ['http://localhost:3000', 'https://chaturaji-4dchess.vercel.app'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || /\.vercel\.app$/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
  try { res.json(await db.getOpenGames()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const game = await db.getGame(req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const [players, moves] = await Promise.all([db.getPlayers(game.id), db.getMoves(game.id)]);
    res.json({ game, players, moves });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/games/code/:code', async (req, res) => {
  try {
    const game = await db.getGameByCode(req.params.code.toUpperCase());
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const players = await db.getPlayers(game.id);
    res.json({ game, players });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/games/:id/moves', async (req, res) => {
  try { res.json(await db.getMoves(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/:name', async (req, res) => {
  try { res.json(await db.getPlayerStats(req.params.name)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recent', async (req, res) => {
  try { res.json(await db.getRecentGames(20)); } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard', requireAuth, async (req, res) => {
  try {
    const profile = await db.getProfile(req.user.id);
    if (!isPremium(profile)) return res.status(403).json({ error: 'Premium required' });
    res.json(await db.getLeaderboard());
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      stripe_customer_id: profileMap[u.id]?.stripe_customer_id || null,
      games_played: gameCounts[u.id] || 0,
      created_at: u.created_at,
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a user's access/permissions
app.patch('/api/admin/users/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const allowed = ['has_lifetime_access', 'subscription_status', 'is_admin'];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
    await db.updateProfile(userId, updates);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recent games
app.get('/api/admin/games', requireAdmin, async (req, res) => {
  try {
    const games = await db.getRecentGames(50);
    res.json({ games });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.status(500).json({ error: e.message });
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

  // ---- CREATE GAME ----
  socket.on('create-game', async ({ playerName, randomColor, gameType = 'classic' }, callback) => {
    try {
      // Premium check for 2v2
      if (gameType === '2v2') {
        const profile = await db.getProfile(socket.data.userId);
        if (!isPremium(profile)) return callback({ error: 'Premium required for 2v2 games' });
      }

      const gameId = uuidv4();
      const code = await generateRoomCode();
      const eng = getEngine(gameType);
      const color = randomColor
        ? eng.PLAYERS[Math.floor(Math.random() * eng.PLAYERS.length)]
        : 'red';

      await db.createGameRecord(gameId, code, gameType);
      await db.addPlayer(gameId, color, playerName, socket.id, socket.data.userId);

      const state = eng.createGame();
      activeGames.set(gameId, state);
      await db.updateGameState(gameId, state);

      socket.join(gameId);
      socket.data = { ...socket.data, gameId, color, playerName, gameType };

      callback({ gameId, code, color, gameType, state: sanitizeState(state), players: sortPlayers(await db.getPlayers(gameId)) });
      console.log(`[Game] ${playerName} created ${gameType} game ${code} (${gameId}) as ${color}`);
    } catch (e) { console.error('[create-game]', e); callback({ error: 'Server error' }); }
  });

  // ---- JOIN GAME ----
  socket.on('join-game', async ({ code, playerName, randomColor }, callback) => {
    try {
      const game = await db.getGameByCode(code.toUpperCase());
      if (!game) return callback({ error: 'Game not found' });
      if (game.status === 'finished') return callback({ error: 'Game is already finished' });

      const players = await db.getPlayers(game.id);
      if (players.length >= 4) return callback({ error: 'Game is full' });

      const gameType = game.game_type || 'classic';
      const eng = getEngine(gameType);

      const taken = players.map(p => p.color);
      const available = eng.PLAYERS.filter(c => !taken.includes(c));
      const color = randomColor
        ? available[Math.floor(Math.random() * available.length)]
        : available[0];

      await db.addPlayer(game.id, color, playerName, socket.id, socket.data.userId);
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

      console.log(`[Game] ${playerName} joined ${game.code} as ${color}`);
    } catch (e) { console.error('[join-game]', e); callback({ error: 'Server error' }); }
  });

  // ---- REJOIN GAME ----
  socket.on('rejoin-game', async ({ gameId, color, playerName }, callback) => {
    try {
      const game = await db.getGame(gameId);
      if (!game) return callback({ error: 'Game not found' });

      const gameType = game.game_type || 'classic';
      await db.updatePlayerSocket(gameId, color, socket.id, true);
      socket.join(gameId);
      socket.data = { ...socket.data, gameId, color, playerName, gameType };

      let state = activeGames.get(gameId);
      if (!state && game.state) {
        state = game.state; // already an object (JSONB)
        activeGames.set(gameId, state);
      }

      const [players, moves, chat] = await Promise.all([
        db.getPlayers(gameId),
        db.getMoves(gameId),
        db.getChatMessages(gameId)
      ]);

      callback({ state: sanitizeState(state), players: sortPlayers(players), moves, chat, gameType });
      socket.to(gameId).emit('player-reconnected', { color, name: playerName });
      console.log(`[Game] ${playerName} rejoined ${gameId}`);
    } catch (e) { console.error('[rejoin-game]', e); callback({ error: 'Server error' }); }
  });

  // ---- ROLL DICE ----
  socket.on('roll-dice', async (callback) => {
    try {
      const { gameId, color, gameType } = socket.data || {};
      if (!gameId) return callback({ error: 'Not in a game' });

      const state = activeGames.get(gameId);
      if (!state) return callback({ error: 'Game not found' });
      if (state.currentPlayer !== color) return callback({ error: 'Not your turn' });

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
    if (!piece || piece.color !== color) return callback({ moves: [] });

    const eng = getEngine(gameType || state.gameType);
    const availTypes = eng.getAvailablePieceTypes(state);
    if (!availTypes.includes(piece.type)) return callback({ moves: [] });

    callback({ moves: eng.getValidMoves(state.board, row, col) });
  });

  // ---- MAKE MOVE ----
  socket.on('make-move', async ({ fromRow, fromCol, toRow, toCol }, callback) => {
    try {
      const { gameId, color, gameType } = socket.data || {};
      if (!gameId) return callback({ error: 'Not in a game' });

      const state = activeGames.get(gameId);
      if (!state) return callback({ error: 'Game not found' });
      if (state.currentPlayer !== color) return callback({ error: 'Not your turn' });

      const eng = getEngine(gameType || state.gameType);
      const result = eng.executeMove(state, fromRow, fromCol, toRow, toCol);
      if (result.error) return callback({ error: result.error });

      activeGames.set(gameId, result.state);
      await db.updateGameState(gameId, result.state);
      await db.recordMove(gameId, result.move);

      if (result.state.winner) await db.setGameFinished(gameId, result.state.winner);

      callback({ state: sanitizeState(result.state), move: result.move });
      socket.to(gameId).emit('move-made', { state: sanitizeState(result.state), move: result.move });

      if (result.state.winner) {
        io.to(gameId).emit('game-over', { winner: result.state.winner, winnerTeam: result.state.winnerTeam || null });
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
      if (state.currentPlayer !== color) return callback({ error: 'Not your turn' });

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
      const { gameId, gameType } = socket.data || {};
      if (!gameId) return callback({ error: 'Not in a game' });

      // Premium check for bots
      const profile = await db.getProfile(socket.data.userId);
      if (!isPremium(profile)) return callback({ error: 'Premium required for bot games' });

      const game = await db.getGame(gameId);
      const players = await db.getPlayers(gameId);
      if (players.length < 1) return callback({ error: 'Need at least 1 player' });

      const eng = getEngine(gameType || game.game_type);
      const state = activeGames.get(gameId);

      const taken = players.map(p => p.color);
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

function scheduleBotMove(gameId, state) {
  if (!state || state.winner) return;
  setTimeout(async () => {
    try {
      let current = activeGames.get(gameId);
      if (!current || current.winner) return;
      if (!await isBot(gameId, current.currentPlayer)) return;

      const game = await db.getGame(gameId);
      const eng = getEngine(game?.game_type);

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
    } catch (e) { console.error('[bot]', e); }
  }, 800 + Math.random() * 700);
}

async function makeBotMoves(gameId, state, eng = engine) {
  if (!state || state.phase !== 'move' || state.winner) return;

  const types = eng.getAvailablePieceTypes(state);
  let bestMove = null, bestScore = -Infinity;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (!p || p.color !== state.currentPlayer || !types.includes(p.type)) continue;
      const moves = eng.getValidMoves(state.board, r, c);
      for (const m of moves) {
        let score = Math.random() * 2;
        const target = state.board[m.row][m.col];
        if (target) {
          score += 10;
          if (target.type === 'king') score += 100;
          if (target.type === 'elephant') score += 8;
          if (target.type === 'horse') score += 6;
        }
        score += (3.5 - Math.abs(m.row - 3.5)) + (3.5 - Math.abs(m.col - 3.5));
        if (score > bestScore) { bestScore = score; bestMove = { fromRow: r, fromCol: c, toRow: m.row, toCol: m.col }; }
      }
    }
  }

  if (!bestMove) {
    const skipResult = eng.skipTurn(state);
    if (!skipResult.error) {
      activeGames.set(gameId, skipResult.state);
      await db.updateGameState(gameId, skipResult.state);
      io.to(gameId).emit('turn-skipped', { player: state.currentPlayer, state: sanitizeState(skipResult.state) });
      scheduleBotMove(gameId, skipResult.state);
    }
    return;
  }

  const result = eng.executeMove(state, bestMove.fromRow, bestMove.fromCol, bestMove.toRow, bestMove.toCol);
  if (result.error) return;

  activeGames.set(gameId, result.state);
  await db.updateGameState(gameId, result.state);
  await db.recordMove(gameId, result.move);
  io.to(gameId).emit('move-made', { state: sanitizeState(result.state), move: result.move });

  if (result.state.winner) {
    await db.setGameFinished(gameId, result.state.winner);
    io.to(gameId).emit('game-over', { winner: result.state.winner, winnerTeam: result.state.winnerTeam || null });
    return;
  }

  if (result.state.phase === 'move' && await isBot(gameId, result.state.currentPlayer)) {
    setTimeout(() => makeBotMoves(gameId, activeGames.get(gameId), eng).catch(() => {}), 600);
  } else {
    scheduleBotMove(gameId, result.state);
  }
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
