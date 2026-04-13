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
    dice_1: move.dice?.[0] ?? '',
    dice_2: move.dice?.[1] ?? '',
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

// ==================== RANKING POINTS ====================

const PLACEMENT_POINTS = { gold: 10, silver: 6, bronze: 3, fourth: 1 };

// Geomantic Figures: 16 figures mapped by 4-digit odd(1)/even(2) code
// Pattern: gold→silver→bronze→4th (top row to bottom row of figure)
// Each row: 1 = single dot (odd), 2 = double dots (even)
// Geomantic Figures mapped by 4-digit odd(1)/even(2) code
// Each row of a geomantic figure: single dot=1(odd), double dots=2(even)
// Our mapping: gold(row1/head) → silver(row2/neck) → bronze(row3/body) → fourth(row4/feet)
// All 16 unique patterns from the traditional geomantic system
const GEOMANTIC_FIGURES = {
  '1111': { name: 'Via',              element: 'Water', planet: 'Moon',    sign: 'Cancer' },
  '2222': { name: 'Populus',          element: 'Water', planet: 'Moon',    sign: 'Cancer' },
  '2211': { name: 'Fortuna Major',    element: 'Fire',  planet: 'Sun',     sign: 'Leo' },
  '1122': { name: 'Fortuna Minor',    element: 'Air',   planet: 'Sun',     sign: 'Leo' },
  '2121': { name: 'Acquisitio',       element: 'Fire',  planet: 'Jupiter', sign: 'Sagittarius' },
  '2221': { name: 'Tristitia',        element: 'Air',   planet: 'Saturn',  sign: 'Aquarius' },
  '1222': { name: 'Laetitia',         element: 'Water', planet: 'Jupiter', sign: 'Pisces' },
  '1221': { name: 'Carcer',           element: 'Earth', planet: 'Saturn',  sign: 'Capricorn' },
  '1211': { name: 'Puer',             element: 'Fire',  planet: 'Mars',    sign: 'Aries' },
  '2212': { name: 'Albus',            element: 'Air',   planet: 'Mercury', sign: 'Virgo' },
  '2122': { name: 'Rubeus',           element: 'Water', planet: 'Mars',    sign: 'Scorpio' },
  '2112': { name: 'Conjunctio',       element: 'Earth', planet: 'Mercury', sign: 'Gemini' },
  '2111': { name: 'Caput Draconis',   element: 'Earth', planet: 'N Node',  sign: 'Benefics' },
  '1112': { name: 'Cauda Draconis',   element: 'Fire',  planet: 'S Node',  sign: 'Malefics' },
  '1212': { name: 'Amissio',          element: 'Earth', planet: 'Venus',   sign: 'Taurus' },
  '1121': { name: 'Puella',           element: 'Air',   planet: 'Venus',   sign: 'Libra' },
};

function getGeomanticFigure(code) {
  return GEOMANTIC_FIGURES[code] || null;
}

// Point values for each captured piece type (Chaturaji capture scoring)
const CAPTURE_POINT_VALUES = {
  king: 5, elephant: 4, horse: 3, boat: 2, pawn: 1,
  queen: 4, rook: 4, bishop: 2, knight: 3,
};

async function awardRankingPoints(gameId, placements) {
  if (!placements) return { oddEvenCode: null, playerPoints: {}, captureScores: {} };
  const players = await getPlayers(gameId);
  const playerPoints = {}; // color -> new total ranking points

  for (const [rank, color] of Object.entries(placements)) {
    if (!color || !PLACEMENT_POINTS[rank]) continue;
    const player = players.find(p => p.color === color);

    // Update placement on the player record
    if (player) {
      await supabase.from('players')
        .update({ placement: rank })
        .eq('game_id', gameId)
        .eq('color', color);
    }

    if (!player?.user_id) {
      // Bot or guest: use placement points for this game
      playerPoints[color] = PLACEMENT_POINTS[rank];
      continue;
    }

    // Award ranking points via increment
    const profile = await getProfile(player.user_id);
    if (profile) {
      const newPoints = (profile.ranking_points || 0) + PLACEMENT_POINTS[rank];
      await updateProfile(player.user_id, { ranking_points: newPoints });
      playerPoints[color] = newPoints;
    }
  }

  // Compute capture scores per player from the game's move history
  const moves = await getMoves(gameId);
  const captureScores = { red: 0, yellow: 0, green: 0, black: 0 };
  for (const m of moves) {
    if (m.captured_type) {
      const pts = CAPTURE_POINT_VALUES[m.captured_type] || 1;
      captureScores[m.player_color] = (captureScores[m.player_color] || 0) + pts;
    }
  }

  // Compute odd/even code based on CAPTURE POINT parity for each placement
  // Odd capture score = "1" (single dot), Even capture score = "2" (double dots)
  const orderedRanks = ['gold', 'silver', 'bronze', 'fourth'];
  let oddEvenCode = '';
  for (const rank of orderedRanks) {
    const color = placements[rank];
    if (!color) { oddEvenCode += '2'; continue; } // default even for missing
    const score = captureScores[color] || 0;
    oddEvenCode += (score % 2 === 1) ? '1' : '2';
  }

  const geomanticFigure = getGeomanticFigure(oddEvenCode);
  return { oddEvenCode, playerPoints, captureScores, geomanticFigure };
}

module.exports = {
  createGameRecord, getGame, getGameByCode, updateGameState,
  setGameStarted, setGameFinished, getRecentGames, getOpenGames,
  addPlayer, getPlayers, updatePlayerSocket, getPlayerBySocket, removePlayer,
  recordMove, getMoves,
  addChatMessage, getChatMessages,
  getPlayerStats,
  getProfile, updateProfile, getOrCreateProfile, getLeaderboard,
  awardRankingPoints,
};
