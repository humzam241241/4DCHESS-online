// ==================== DATABASE LAYER (Supabase PostgreSQL) ====================
// All functions are async. State is stored as JSONB — no JSON.stringify/parse needed.

const supabase = require('./supabase');

// ==================== GAMES ====================

async function createGameRecord(id, code, gameType = 'classic') {
  const { error } = await supabase.from('games').insert({ id, code, game_type: gameType });
  if (error) throw error;
}

async function getGame(id) {
  const { data, error } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getGameByCode(code) {
  const { data, error } = await supabase.from('games').select('*').eq('code', code).maybeSingle();
  if (error) throw error;
  return data;
}

async function updateGameState(id, state) {
  const status = state.winner ? 'finished' : 'playing';
  const { error } = await supabase.from('games').update({
    state,
    status,
    turn_number: state.turnNumber || 1,
    winner: state.winner || null
  }).eq('id', id);
  if (error) throw error;
}

async function setGameStarted(id) {
  const { error } = await supabase.from('games').update({
    status: 'playing',
    started_at: new Date().toISOString()
  }).eq('id', id);
  if (error) throw error;
}

async function setGameFinished(id, winner) {
  const { error } = await supabase.from('games').update({
    status: 'finished',
    finished_at: new Date().toISOString(),
    winner
  }).eq('id', id);
  if (error) throw error;
}

async function getOpenGames() {
  const { data: games, error } = await supabase
    .from('games')
    .select('*')
    .eq('status', 'waiting')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!games || !games.length) return [];

  const { data: playerRows } = await supabase
    .from('players')
    .select('game_id')
    .in('game_id', games.map(g => g.id));

  const counts = {};
  (playerRows || []).forEach(p => { counts[p.game_id] = (counts[p.game_id] || 0) + 1; });
  return games.map(g => ({ ...g, player_count: counts[g.id] || 0 }));
}

async function getRecentGames(limit = 20) {
  const { data: games, error } = await supabase
    .from('games')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  if (!games || !games.length) return [];

  const { data: playerRows } = await supabase
    .from('players')
    .select('game_id')
    .in('game_id', games.map(g => g.id));

  const counts = {};
  (playerRows || []).forEach(p => { counts[p.game_id] = (counts[p.game_id] || 0) + 1; });
  return games.map(g => ({ ...g, player_count: counts[g.id] || 0 }));
}

// ==================== PLAYERS ====================

async function addPlayer(gameId, color, name, socketId, userId = null) {
  const { error } = await supabase.from('players').insert({
    game_id: gameId, color, name, socket_id: socketId, user_id: userId
  });
  if (error) throw error;
}

async function getPlayers(gameId) {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('game_id', gameId)
    .order('color');
  if (error) throw error;
  return data || [];
}

async function updatePlayerSocket(gameId, color, socketId, connected) {
  const { error } = await supabase.from('players').update({
    socket_id: socketId, connected
  }).eq('game_id', gameId).eq('color', color);
  if (error) throw error;
}

async function getPlayerBySocket(socketId) {
  const { data, error } = await supabase.from('players').select('*').eq('socket_id', socketId).maybeSingle();
  if (error) throw error;
  return data;
}

async function removePlayer(gameId, color) {
  const { error } = await supabase.from('players').delete().eq('game_id', gameId).eq('color', color);
  if (error) throw error;
}

// ==================== MOVES ====================

async function recordMove(gameId, move) {
  const { error } = await supabase.from('moves').insert({
    game_id: gameId,
    turn_number: move.turn,
    player_color: move.player,
    piece_type: move.piece,
    from_row: move.from.row,
    from_col: move.from.col,
    to_row: move.to.row,
    to_col: move.to.col,
    captured_type: move.captured?.type || null,
    captured_color: move.captured?.color || null,
    dice_1: move.dice[0],
    dice_2: move.dice[1],
    notation: `${move.piece} ${move.from.notation}-${move.to.notation}`
  });
  if (error) throw error;
}

async function getMoves(gameId) {
  const { data, error } = await supabase
    .from('moves')
    .select('*')
    .eq('game_id', gameId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ==================== CHAT ====================

async function addChatMessage(gameId, playerColor, playerName, message) {
  const { error } = await supabase.from('chat_messages').insert({
    game_id: gameId, player_color: playerColor, player_name: playerName, message
  });
  if (error) throw error;
}

async function getChatMessages(gameId, limit = 100) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('game_id', gameId)
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse();
}

// ==================== STATS ====================

async function getPlayerStats(name) {
  const { data: playerRows, error: pErr } = await supabase
    .from('players')
    .select('color, game_id')
    .eq('name', name);
  if (pErr) throw pErr;
  if (!playerRows || !playerRows.length) return { totalGames: 0, wins: 0, losses: 0 };

  const { data: gameRows, error: gErr } = await supabase
    .from('games')
    .select('id, winner')
    .in('id', playerRows.map(p => p.game_id))
    .eq('status', 'finished');
  if (gErr) throw gErr;

  const gameMap = {};
  (gameRows || []).forEach(g => { gameMap[g.id] = g; });
  const finished = playerRows.filter(p => gameMap[p.game_id]);
  return {
    totalGames: finished.length,
    wins: finished.filter(p => gameMap[p.game_id]?.winner === p.color).length,
    losses: finished.filter(p => gameMap[p.game_id]?.winner && gameMap[p.game_id]?.winner !== p.color).length
  };
}

// ==================== PROFILES ====================

async function getProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function updateProfile(userId, updates) {
  const { error } = await supabase.from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) throw error;
}

async function getOrCreateProfile(userId, email, displayName, avatarUrl) {
  let profile = await getProfile(userId);
  if (!profile) {
    await supabase.from('profiles').insert({
      id: userId,
      display_name: displayName || email,
      avatar_url: avatarUrl || null
    });
    profile = await getProfile(userId);
  }
  return profile;
}

async function getLeaderboard() {
  const { data, error } = await supabase.rpc('get_leaderboard');
  if (error) throw error;
  return data || [];
}

module.exports = {
  createGameRecord, getGame, getGameByCode, updateGameState,
  setGameStarted, setGameFinished, getRecentGames, getOpenGames,
  addPlayer, getPlayers, updatePlayerSocket, getPlayerBySocket, removePlayer,
  recordMove, getMoves,
  addChatMessage, getChatMessages,
  getPlayerStats,
  getProfile, updateProfile, getOrCreateProfile, getLeaderboard,
};
