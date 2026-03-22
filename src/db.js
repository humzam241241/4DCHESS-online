// ==================== DATABASE LAYER ====================
// SQLite persistence for games, moves, players, and chat.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'chaturaji.db');
let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      winner TEXT,
      state TEXT,
      turn_number INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      color TEXT NOT NULL,
      name TEXT NOT NULL,
      socket_id TEXT,
      connected INTEGER DEFAULT 1,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(game_id, color)
    );

    CREATE TABLE IF NOT EXISTS moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      turn_number INTEGER NOT NULL,
      player_color TEXT NOT NULL,
      piece_type TEXT NOT NULL,
      from_row INTEGER NOT NULL,
      from_col INTEGER NOT NULL,
      to_row INTEGER NOT NULL,
      to_col INTEGER NOT NULL,
      captured_type TEXT,
      captured_color TEXT,
      dice_1 TEXT NOT NULL,
      dice_2 TEXT NOT NULL,
      notation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_color TEXT,
      player_name TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_games_code ON games(code);
    CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
    CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id);
    CREATE INDEX IF NOT EXISTS idx_moves_game ON moves(game_id);
    CREATE INDEX IF NOT EXISTS idx_chat_game ON chat_messages(game_id);
  `);

  // Migrations (safe: ignore if column already exists)
  try { db.exec(`ALTER TABLE games ADD COLUMN game_type TEXT NOT NULL DEFAULT 'classic'`); } catch {}

  return db;
}

// ==================== GAMES ====================

function createGameRecord(id, code, gameType = 'classic') {
  db.prepare('INSERT INTO games (id, code, game_type) VALUES (?, ?, ?)').run(id, code, gameType);
}

function getGame(id) {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(id);
}

function getGameByCode(code) {
  return db.prepare('SELECT * FROM games WHERE code = ?').get(code);
}

function updateGameState(id, state, status) {
  db.prepare(
    'UPDATE games SET state = ?, status = ?, turn_number = ?, winner = ? WHERE id = ?'
  ).run(JSON.stringify(state), status || state.phase === 'finished' ? 'finished' : 'playing', state.turnNumber, state.winner, id);
}

function setGameStarted(id) {
  db.prepare("UPDATE games SET status = 'playing', started_at = datetime('now') WHERE id = ?").run(id);
}

function setGameFinished(id, winner) {
  db.prepare("UPDATE games SET status = 'finished', finished_at = datetime('now'), winner = ? WHERE id = ?").run(winner, id);
}

function getRecentGames(limit = 20) {
  return db.prepare(
    'SELECT g.*, COUNT(p.id) as player_count FROM games g LEFT JOIN players p ON g.id = p.game_id GROUP BY g.id ORDER BY g.created_at DESC LIMIT ?'
  ).all(limit);
}

function getOpenGames() {
  return db.prepare(
    "SELECT g.*, COUNT(p.id) as player_count FROM games g LEFT JOIN players p ON g.id = p.game_id WHERE g.status = 'waiting' GROUP BY g.id ORDER BY g.created_at DESC"
  ).all();
}

// ==================== PLAYERS ====================

function addPlayer(gameId, color, name, socketId) {
  db.prepare(
    'INSERT INTO players (game_id, color, name, socket_id) VALUES (?, ?, ?, ?)'
  ).run(gameId, color, name, socketId);
}

function getPlayers(gameId) {
  return db.prepare('SELECT * FROM players WHERE game_id = ? ORDER BY color').all(gameId);
}

function updatePlayerSocket(gameId, color, socketId, connected) {
  db.prepare(
    'UPDATE players SET socket_id = ?, connected = ? WHERE game_id = ? AND color = ?'
  ).run(socketId, connected ? 1 : 0, gameId, color);
}

function getPlayerBySocket(socketId) {
  return db.prepare('SELECT * FROM players WHERE socket_id = ?').get(socketId);
}

function removePlayer(gameId, color) {
  db.prepare('DELETE FROM players WHERE game_id = ? AND color = ?').run(gameId, color);
}

// ==================== MOVES ====================

function recordMove(gameId, move) {
  db.prepare(`
    INSERT INTO moves (game_id, turn_number, player_color, piece_type, from_row, from_col, to_row, to_col, captured_type, captured_color, dice_1, dice_2, notation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    gameId, move.turn, move.player, move.piece,
    move.from.row, move.from.col, move.to.row, move.to.col,
    move.captured?.type || null, move.captured?.color || null,
    move.dice[0], move.dice[1],
    `${move.piece} ${move.from.notation}-${move.to.notation}`
  );
}

function getMoves(gameId) {
  return db.prepare('SELECT * FROM moves WHERE game_id = ? ORDER BY id ASC').all(gameId);
}

// ==================== CHAT ====================

function addChatMessage(gameId, playerColor, playerName, message) {
  db.prepare(
    'INSERT INTO chat_messages (game_id, player_color, player_name, message) VALUES (?, ?, ?, ?)'
  ).run(gameId, playerColor, playerName, message);
}

function getChatMessages(gameId, limit = 100) {
  return db.prepare(
    'SELECT * FROM chat_messages WHERE game_id = ? ORDER BY id DESC LIMIT ?'
  ).all(gameId, limit).reverse();
}

// ==================== STATS ====================

function getPlayerStats(name) {
  const games = db.prepare(`
    SELECT p.color, g.winner, g.status
    FROM players p JOIN games g ON p.game_id = g.id
    WHERE p.name = ? AND g.status = 'finished'
  `).all(name);

  return {
    totalGames: games.length,
    wins: games.filter(g => g.winner === g.color).length,
    losses: games.filter(g => g.winner && g.winner !== g.color).length,
  };
}

module.exports = {
  init,
  createGameRecord, getGame, getGameByCode, updateGameState,
  setGameStarted, setGameFinished, getRecentGames, getOpenGames,
  addPlayer, getPlayers, updatePlayerSocket, getPlayerBySocket, removePlayer,
  recordMove, getMoves,
  addChatMessage, getChatMessages,
  getPlayerStats,
};
