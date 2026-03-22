// ==================== CHATURAJI MULTIPLAYER SERVER ====================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const engine = require('./src/engine');
const engine2v2 = require('./src/engine2v2');
const db = require('./src/db');

// Helper: pick engine by game type
function getEngine(gameType) { return gameType === '2v2' ? engine2v2 : engine; }

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://chaturaji-4dchess.vercel.app', /\.vercel\.app$/],
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Initialize DB
db.init();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory active game states (keyed by game ID)
const activeGames = new Map();

// ==================== REST API ====================

// List open games
app.get('/api/games', (req, res) => {
  const games = db.getOpenGames();
  res.json(games);
});

// Get game details
app.get('/api/games/:id', (req, res) => {
  const game = db.getGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const players = db.getPlayers(game.id);
  const moves = db.getMoves(game.id);
  res.json({ game, players, moves });
});

// Get game by code
app.get('/api/games/code/:code', (req, res) => {
  const game = db.getGameByCode(req.params.code.toUpperCase());
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const players = db.getPlayers(game.id);
  res.json({ game, players });
});

// Get move history for replay
app.get('/api/games/:id/moves', (req, res) => {
  const moves = db.getMoves(req.params.id);
  res.json(moves);
});

// Player stats
app.get('/api/stats/:name', (req, res) => {
  const stats = db.getPlayerStats(req.params.name);
  res.json(stats);
});

// Recent finished games
app.get('/api/recent', (req, res) => {
  const games = db.getRecentGames(20);
  res.json(games);
});

// ==================== SOCKET.IO ====================

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  // Ensure unique
  if (db.getGameByCode(code)) return generateRoomCode();
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ---- CREATE GAME ----
  socket.on('create-game', ({ playerName, randomColor, gameType = 'classic' }, callback) => {
    const gameId = uuidv4();
    const code = generateRoomCode();
    const eng = getEngine(gameType);
    // R&G: randomize color assignment; otherwise creator gets red
    const color = randomColor
      ? eng.PLAYERS[Math.floor(Math.random() * eng.PLAYERS.length)]
      : 'red';

    db.createGameRecord(gameId, code, gameType);
    db.addPlayer(gameId, color, playerName, socket.id);

    const state = eng.createGame();
    activeGames.set(gameId, state);
    db.updateGameState(gameId, state);

    socket.join(gameId);
    socket.data = { gameId, color, playerName, gameType };

    callback({ gameId, code, color, gameType, state: sanitizeState(state), players: sortPlayers(db.getPlayers(gameId)) });
    console.log(`[Game] ${playerName} created ${gameType} game ${code} (${gameId}) as ${color}`);
  });

  // ---- JOIN GAME ----
  socket.on('join-game', ({ code, playerName, randomColor }, callback) => {
    const game = db.getGameByCode(code.toUpperCase());
    if (!game) return callback({ error: 'Game not found' });
    if (game.status === 'finished') return callback({ error: 'Game is already finished' });

    const players = db.getPlayers(game.id);
    if (players.length >= 4) return callback({ error: 'Game is full' });

    const gameType = game.game_type || 'classic';
    const eng = getEngine(gameType);

    // Assign random or next available color
    const taken = players.map(p => p.color);
    const available = eng.PLAYERS.filter(c => !taken.includes(c));
    const color = randomColor
      ? available[Math.floor(Math.random() * available.length)]
      : available[0];

    db.addPlayer(game.id, color, playerName, socket.id);
    socket.join(game.id);
    socket.data = { gameId: game.id, color, playerName, gameType };

    const allPlayers = db.getPlayers(game.id);
    let state = activeGames.get(game.id);
    if (!state) {
      state = game.state ? JSON.parse(game.state) : eng.createGame();
      activeGames.set(game.id, state);
    }

    const sorted = sortPlayers(allPlayers);
    callback({ gameId: game.id, code: game.code, color, gameType, state: sanitizeState(state), players: sorted });
    socket.to(game.id).emit('player-joined', { color, name: playerName, players: sorted });

    // Auto-start when 4 players join
    if (allPlayers.length === 4 && game.status === 'waiting') {
      db.setGameStarted(game.id);
      io.to(game.id).emit('game-started', { state: sanitizeState(state), players: sorted });
      console.log(`[Game] ${game.code} started with 4 players`);
    }

    console.log(`[Game] ${playerName} joined ${game.code} as ${color}`);
  });

  // ---- REJOIN GAME ----
  socket.on('rejoin-game', ({ gameId, color, playerName }, callback) => {
    const game = db.getGame(gameId);
    if (!game) return callback({ error: 'Game not found' });

    const gameType = game.game_type || 'classic';
    db.updatePlayerSocket(gameId, color, socket.id, true);
    socket.join(gameId);
    socket.data = { gameId, color, playerName, gameType };

    let state = activeGames.get(gameId);
    if (!state && game.state) {
      state = JSON.parse(game.state);
      activeGames.set(gameId, state);
    }

    const players = sortPlayers(db.getPlayers(gameId));
    const moves = db.getMoves(gameId);
    const chat = db.getChatMessages(gameId);

    callback({ state: sanitizeState(state), players, moves, chat, gameType });
    socket.to(gameId).emit('player-reconnected', { color, name: playerName });
    console.log(`[Game] ${playerName} rejoined ${gameId}`);
  });

  // ---- ROLL DICE ----
  socket.on('roll-dice', (callback) => {
    const { gameId, color, gameType } = socket.data || {};
    if (!gameId) return callback({ error: 'Not in a game' });

    const state = activeGames.get(gameId);
    if (!state) return callback({ error: 'Game not found' });
    if (state.currentPlayer !== color) return callback({ error: 'Not your turn' });

    const eng = getEngine(gameType || state.gameType);
    const result = eng.rollDice(state);
    if (result.error) return callback({ error: result.error });

    activeGames.set(gameId, result.state);
    db.updateGameState(gameId, result.state);

    callback({ dice: result.dice, state: sanitizeState(result.state) });
    socket.to(gameId).emit('dice-rolled', { player: color, dice: result.dice, state: sanitizeState(result.state) });

    // If turn was auto-skipped (no valid moves), trigger next player (may be bot)
    scheduleBotMove(gameId, result.state);
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

    const moves = eng.getValidMoves(state.board, row, col);
    callback({ moves });
  });

  // ---- MAKE MOVE ----
  socket.on('make-move', ({ fromRow, fromCol, toRow, toCol }, callback) => {
    const { gameId, color, gameType } = socket.data || {};
    if (!gameId) return callback({ error: 'Not in a game' });

    const state = activeGames.get(gameId);
    if (!state) return callback({ error: 'Game not found' });
    if (state.currentPlayer !== color) return callback({ error: 'Not your turn' });

    const eng = getEngine(gameType || state.gameType);
    const result = eng.executeMove(state, fromRow, fromCol, toRow, toCol);
    if (result.error) return callback({ error: result.error });

    activeGames.set(gameId, result.state);
    db.updateGameState(gameId, result.state);
    db.recordMove(gameId, result.move);

    if (result.state.winner) {
      db.setGameFinished(gameId, result.state.winner);
    }

    callback({ state: sanitizeState(result.state), move: result.move });
    socket.to(gameId).emit('move-made', { state: sanitizeState(result.state), move: result.move });

    if (result.state.winner) {
      io.to(gameId).emit('game-over', { winner: result.state.winner, winnerTeam: result.state.winnerTeam || null });
    } else {
      // If turn advanced to a bot, trigger it
      scheduleBotMove(gameId, result.state);
    }
  });

  // ---- SKIP TURN ----
  socket.on('skip-turn', (callback) => {
    const { gameId, color, gameType } = socket.data || {};
    if (!gameId) return callback({ error: 'Not in a game' });

    const state = activeGames.get(gameId);
    if (!state) return callback({ error: 'Game not found' });
    if (state.currentPlayer !== color) return callback({ error: 'Not your turn' });

    const eng = getEngine(gameType || state.gameType);
    const result = eng.skipTurn(state);
    if (result.error) return callback({ error: result.error });

    activeGames.set(gameId, result.state);
    db.updateGameState(gameId, result.state);

    callback({ state: sanitizeState(result.state) });
    socket.to(gameId).emit('turn-skipped', { player: color, state: sanitizeState(result.state) });

    // Trigger next player if it's a bot
    scheduleBotMove(gameId, result.state);
  });

  // ---- CHAT ----
  socket.on('chat-message', ({ message }) => {
    const { gameId, color, playerName } = socket.data || {};
    if (!gameId || !message || message.length > 500) return;

    const sanitized = message.trim().slice(0, 500);
    db.addChatMessage(gameId, color, playerName, sanitized);
    io.to(gameId).emit('chat-message', { color, name: playerName, message: sanitized, timestamp: Date.now() });
  });

  // ---- START GAME (with bots or fewer players) ----
  socket.on('start-game', (callback) => {
    const { gameId, gameType } = socket.data || {};
    if (!gameId) return callback({ error: 'Not in a game' });

    const game = db.getGame(gameId);
    const players = db.getPlayers(gameId);
    if (players.length < 1) return callback({ error: 'Need at least 1 player' });

    const eng = getEngine(gameType || game.game_type);
    let state = activeGames.get(gameId);

    // Fill remaining slots with AI markers
    const taken = players.map(p => p.color);
    const bots = eng.PLAYERS.filter(c => !taken.includes(c));
    for (const botColor of bots) {
      db.addPlayer(gameId, botColor, `Bot (${eng.PLAYER_NAMES[botColor]})`, null);
    }

    db.setGameStarted(gameId);
    const allPlayers = sortPlayers(db.getPlayers(gameId));

    callback({ state: sanitizeState(state), players: allPlayers, gameType: game.game_type });
    io.to(gameId).emit('game-started', { state: sanitizeState(state), players: allPlayers, gameType: game.game_type });

    // If current player is a bot, trigger bot move
    scheduleBotMove(gameId, state);
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const { gameId, color, playerName } = socket.data || {};
    if (gameId && color) {
      db.updatePlayerSocket(gameId, color, null, false);
      socket.to(gameId).emit('player-disconnected', { color, name: playerName });
      console.log(`[-] ${playerName} (${color}) disconnected from ${gameId}`);
    }
  });
});

// ==================== HELPERS ====================

// Sort players in canonical turn order: red, yellow, green, black
const COLOR_ORDER = ['red', 'yellow', 'green', 'black'];
function sortPlayers(players) {
  return [...players].sort((a, b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color));
}

// ==================== SIMPLE BOT AI ====================

function isBot(gameId, color) {
  const players = db.getPlayers(gameId);
  const player = players.find(p => p.color === color);
  return player && !player.socket_id && player.name.startsWith('Bot');
}

function scheduleBotMove(gameId, state) {
  if (!state || state.winner) return;
  if (!isBot(gameId, state.currentPlayer)) return;

  setTimeout(() => {
    let current = activeGames.get(gameId);
    if (!current || current.winner) return;
    if (!isBot(gameId, current.currentPlayer)) return;

    const game = db.getGame(gameId);
    const eng = getEngine(game?.game_type);

    // Roll dice
    if (current.phase === 'roll') {
      const rollResult = eng.rollDice(current);
      if (rollResult.error) return;
      current = rollResult.state;
      activeGames.set(gameId, current);
      db.updateGameState(gameId, current);
      io.to(gameId).emit('dice-rolled', { player: current.currentPlayer, dice: rollResult.dice, state: sanitizeState(current) });

      // If auto-skipped (no moves), recurse
      if (current.phase === 'roll') {
        scheduleBotMove(gameId, current);
        return;
      }
    }

    // Make moves
    makeBotMoves(gameId, current, eng);
  }, 800 + Math.random() * 700);
}

function makeBotMoves(gameId, state, eng = engine) {
  if (!state || state.phase !== 'move' || state.winner) return;

  const types = eng.getAvailablePieceTypes(state);
  let bestMove = null;
  let bestScore = -Infinity;

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
        // Prefer moving toward center
        score += (3.5 - Math.abs(m.row - 3.5)) + (3.5 - Math.abs(m.col - 3.5));
        if (score > bestScore) {
          bestScore = score;
          bestMove = { fromRow: r, fromCol: c, toRow: m.row, toCol: m.col };
        }
      }
    }
  }

  if (!bestMove) {
    // Skip
    const skipResult = eng.skipTurn(state);
    if (!skipResult.error) {
      activeGames.set(gameId, skipResult.state);
      db.updateGameState(gameId, skipResult.state);
      io.to(gameId).emit('turn-skipped', { player: state.currentPlayer, state: sanitizeState(skipResult.state) });
      scheduleBotMove(gameId, skipResult.state);
    }
    return;
  }

  const result = eng.executeMove(state, bestMove.fromRow, bestMove.fromCol, bestMove.toRow, bestMove.toCol);
  if (result.error) return;

  activeGames.set(gameId, result.state);
  db.updateGameState(gameId, result.state);
  db.recordMove(gameId, result.move);

  io.to(gameId).emit('move-made', { state: sanitizeState(result.state), move: result.move });

  if (result.state.winner) {
    db.setGameFinished(gameId, result.state.winner);
    io.to(gameId).emit('game-over', { winner: result.state.winner, winnerTeam: result.state.winnerTeam || null });
    return;
  }

  // If still this bot's turn (second die), continue
  if (result.state.phase === 'move' && isBot(gameId, result.state.currentPlayer)) {
    setTimeout(() => makeBotMoves(gameId, activeGames.get(gameId), eng), 600);
  } else {
    scheduleBotMove(gameId, result.state);
  }
}

// Strip moveHistory from state sent to clients (too large)
function sanitizeState(state) {
  if (!state) return null;
  const { moveHistory, ...rest } = state;
  return rest;
}

// ==================== START ====================

server.listen(PORT, () => {
  console.log(`\n  Chaturaji server running on http://localhost:${PORT}\n`);
});
