// ==================== ENOCHIAN CHESS ENGINE ====================
// Team-based 4-player chess inspired by the Golden Dawn's Enochian Chess.
// Teams: [Red (Fire) + Yellow (Air)] vs [Green/Blue (Water) + Black (Earth)]
// No dice. Alibaba queen. Frozen pieces. Throne squares. Typed pawn promotion.
// Board quadrants: Yellow=Air(NW), Green=Water(NE), Red=Fire(SE), Black=Earth(SW)

const PLAYERS = ['yellow', 'green', 'red', 'black'];
const PLAYER_NAMES = { yellow: 'Yellow', green: 'Blue', red: 'Red', black: 'Black' };
const TEAMS = [['red', 'yellow'], ['green', 'black']];

// Throne corners [row, col]
const THRONE = { yellow: [0, 0], green: [0, 7], red: [7, 7], black: [7, 0] };

// Pawn forward direction [dr, dc]
const PAWN_DIR = {
  yellow: [1, 0],   // south (toward rank 1)
  green:  [0, -1],  // west  (toward file a)
  red:    [-1, 0],  // north (toward rank 8)
  black:  [0, 1],   // east  (toward file h)
};

function isAtFarEnd(color, row, col) {
  if (color === 'yellow') return row === 7;
  if (color === 'green')  return col === 0;
  if (color === 'red')    return row === 0;
  if (color === 'black')  return col === 7;
  return false;
}

function getTeamKey(color) {
  return TEAMS[0].includes(color) ? 'ry' : 'gb';
}

function isAllyColor(c1, c2) {
  if (c1 === c2) return true;
  return getTeamKey(c1) === getTeamKey(c2);
}

// ==================== INITIAL STATE ====================

function createGame() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));

  // Yellow (Air, NW corner, a8 throne) — pawns move south
  board[0][0] = { type: 'king', color: 'yellow', thronePartner: { type: 'bishop', color: 'yellow' } };
  board[0][1] = { type: 'queen',  color: 'yellow' };
  board[0][2] = { type: 'knight', color: 'yellow' };
  board[0][3] = { type: 'rook',   color: 'yellow' };
  board[1][0] = { type: 'pawn', color: 'yellow', pawnOf: 'bishop' };
  board[1][1] = { type: 'pawn', color: 'yellow', pawnOf: 'queen' };
  board[1][2] = { type: 'pawn', color: 'yellow', pawnOf: 'knight' };
  board[1][3] = { type: 'pawn', color: 'yellow', pawnOf: 'rook' };

  // Green/Blue (Water, NE corner, h8 throne) — pawns move west
  board[0][7] = { type: 'king', color: 'green', thronePartner: { type: 'bishop', color: 'green' } };
  board[1][7] = { type: 'queen',  color: 'green' };
  board[2][7] = { type: 'knight', color: 'green' };
  board[3][7] = { type: 'rook',   color: 'green' };
  board[0][6] = { type: 'pawn', color: 'green', pawnOf: 'bishop' };
  board[1][6] = { type: 'pawn', color: 'green', pawnOf: 'queen' };
  board[2][6] = { type: 'pawn', color: 'green', pawnOf: 'knight' };
  board[3][6] = { type: 'pawn', color: 'green', pawnOf: 'rook' };

  // Red (Fire, SE corner, h1 throne) — pawns move north
  board[7][7] = { type: 'king', color: 'red', thronePartner: { type: 'bishop', color: 'red' } };
  board[7][6] = { type: 'queen',  color: 'red' };
  board[7][5] = { type: 'knight', color: 'red' };
  board[7][4] = { type: 'rook',   color: 'red' };
  board[6][7] = { type: 'pawn', color: 'red', pawnOf: 'bishop' };
  board[6][6] = { type: 'pawn', color: 'red', pawnOf: 'queen' };
  board[6][5] = { type: 'pawn', color: 'red', pawnOf: 'knight' };
  board[6][4] = { type: 'pawn', color: 'red', pawnOf: 'rook' };

  // Black (Earth, SW corner, a1 throne) — pawns move east
  board[7][0] = { type: 'king', color: 'black', thronePartner: { type: 'bishop', color: 'black' } };
  board[6][0] = { type: 'queen',  color: 'black' };
  board[5][0] = { type: 'knight', color: 'black' };
  board[4][0] = { type: 'rook',   color: 'black' };
  board[7][1] = { type: 'pawn', color: 'black', pawnOf: 'bishop' };
  board[6][1] = { type: 'pawn', color: 'black', pawnOf: 'queen' };
  board[5][1] = { type: 'pawn', color: 'black', pawnOf: 'knight' };
  board[4][1] = { type: 'pawn', color: 'black', pawnOf: 'rook' };

  return {
    board,
    currentPlayer: 'yellow',
    frozen: [],        // players whose king was captured; pieces stay as blocking terrain
    eliminated: [],    // kept for interface compatibility
    eliminationOrder: [],  // tracks order of freezing for placements
    winner: null,
    winnerTeam: null,  // 'ry' or 'gb'
    placements: null,  // { gold, silver, bronze, fourth } — set on game over
    moveHistory: [],
    turnNumber: 1,
    phase: 'move',     // always 'move' — no dice in Enochian
    gameType: 'enochian',
    dice: null,
    diceUsed: null,
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// No-op — Enochian Chess has no dice
function rollDice(state) {
  return { state: cloneState(state), dice: null };
}

// All piece types always available (no dice restriction)
function getAvailablePieceTypes() {
  return ['king', 'queen', 'bishop', 'knight', 'rook', 'pawn'];
}

// ==================== HELPERS ====================

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

function isFrozen(state, color) {
  return state.frozen.includes(color);
}

// Can a piece of the given color move to (r, c)?
function canMoveTo(board, state, r, c, color) {
  const target = board[r][c];
  if (!target) return true;                           // empty square
  if (isFrozen(state, target.color)) return false;    // frozen piece = impassable wall
  if (isAllyColor(target.color, color)) return false;  // cannot capture allies
  return true;                                         // enemy, not frozen = capturable
}

// Is there a capturable enemy (non-frozen, non-ally) piece at (r, c)?
function canCapture(board, state, r, c, color) {
  const target = board[r][c];
  if (!target) return false;
  if (isFrozen(state, target.color)) return false;
  if (isAllyColor(target.color, color)) return false;
  return true;
}

// ==================== MOVE GENERATION ====================

function addSlideMoves(board, state, row, col, color, dirs, moves) {
  for (const [dr, dc] of dirs) {
    let r = row + dr, c = col + dc;
    while (inBounds(r, c)) {
      const target = board[r][c];
      if (!target) {
        moves.push({ row: r, col: c });
      } else {
        // Any piece blocks further sliding; can only capture enemies
        if (canCapture(board, state, r, c, color)) {
          moves.push({ row: r, col: c });
        }
        break;
      }
      r += dr; c += dc;
    }
  }
}

function getMovesForPieceType(board, state, row, col, type, color) {
  const moves = [];
  switch (type) {
    case 'king':
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = row + dr, c = col + dc;
          if (inBounds(r, c) && canMoveTo(board, state, r, c, color))
            moves.push({ row: r, col: c });
        }
      }
      break;

    case 'queen':
      // Alibaba: leaps exactly 2 squares in any of 8 directions (jumps over pieces)
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
        const r = row + 2 * dr, c = col + 2 * dc;
        if (inBounds(r, c) && canMoveTo(board, state, r, c, color))
          moves.push({ row: r, col: c });
      }
      break;

    case 'rook':
      addSlideMoves(board, state, row, col, color, [[-1,0],[1,0],[0,-1],[0,1]], moves);
      break;

    case 'bishop':
      addSlideMoves(board, state, row, col, color, [[-1,-1],[-1,1],[1,-1],[1,1]], moves);
      break;

    case 'knight':
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const r = row + dr, c = col + dc;
        if (inBounds(r, c) && canMoveTo(board, state, r, c, color))
          moves.push({ row: r, col: c });
      }
      break;

    case 'pawn': {
      const [dr, dc] = PAWN_DIR[color];
      // Forward move (no double step, no en passant)
      const nr = row + dr, nc = col + dc;
      if (inBounds(nr, nc) && !board[nr][nc])
        moves.push({ row: nr, col: nc });
      // Diagonal captures
      const capDirs = dr !== 0 ? [[dr, -1], [dr, 1]] : [[-1, dc], [1, dc]];
      for (const [cdr, cdc] of capDirs) {
        const cr = row + cdr, cc = col + cdc;
        if (inBounds(cr, cc) && canCapture(board, state, cr, cc, color))
          moves.push({ row: cr, col: cc });
      }
      break;
    }
  }
  return moves;
}

function getValidMoves(board, row, col, state) {
  const piece = board[row][col];
  if (!piece) return [];
  if (!state) state = { frozen: [], eliminated: [] };
  if (isFrozen(state, piece.color)) return [];

  const moves = getMovesForPieceType(board, state, row, col, piece.type, piece.color);

  // Throne: stacked king + bishop — include partner's moves too
  if (piece.thronePartner) {
    const partnerMoves = getMovesForPieceType(board, state, row, col,
      piece.thronePartner.type, piece.color);
    const seen = new Set(moves.map(m => `${m.row},${m.col}`));
    for (const m of partnerMoves) {
      if (!seen.has(`${m.row},${m.col}`)) {
        moves.push(m);
        seen.add(`${m.row},${m.col}`);
      }
    }
  }

  return moves;
}

function hasAnyValidMove(state) {
  const color = state.currentPlayer;
  if (isFrozen(state, color)) return false;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (p && p.color === color && getValidMoves(state.board, r, c, state).length > 0)
        return true;
    }
  return false;
}

// ==================== PAWN PROMOTION ====================

function checkPawnPromotion(state, row, col) {
  const piece = state.board[row][col];
  if (!piece || piece.type !== 'pawn') return null;
  if (!isAtFarEnd(piece.color, row, col)) return null;

  // Count current pawns for this player
  let pawnCount = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (state.board[r][c]?.color === piece.color && state.board[r][c]?.type === 'pawn')
        pawnCount++;

  // Promotion delayed if all 4 pawns still alive
  if (pawnCount >= 4) return null;

  // Check for privileged pawn: K+Q+P, K+B+P, or K+P only remaining
  let totalPieces = 0;
  let hasQueen = false, hasBishop = false;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (p?.color === piece.color) {
        totalPieces++;
        if (p.type === 'queen') hasQueen = true;
        if (p.type === 'bishop') hasBishop = true;
        if (p.thronePartner?.color === piece.color) {
          totalPieces++;
          if (p.thronePartner.type === 'bishop') hasBishop = true;
        }
      }
    }

  const privileged = (totalPieces === 2) ||
    (totalPieces === 3 && (hasQueen || hasBishop));

  if (privileged) {
    // Privileged pawn can promote to any piece — choose queen
    state.board[row][col] = { type: 'queen', color: piece.color };
    return 'queen';
  }

  // Normal promotion: promote to this pawn's designated type
  const promoType = piece.pawnOf || 'queen';
  state.board[row][col] = { type: promoType, color: piece.color };
  return promoType;
}

// ==================== FREEZE & WIN CONDITION ====================

function freezePlayer(state, color) {
  if (state.frozen.includes(color)) return;
  state.frozen.push(color);
  if (!state.eliminationOrder) state.eliminationOrder = [];
  state.eliminationOrder.push(color);
  // Pieces stay on the board as blocking terrain — no removal
  checkTeamWin(state);
}

function checkTeamWin(state) {
  // Team 0: [red, yellow] — team key 'ry'
  // Team 1: [green, black] — team key 'gb'
  const team0AllFrozen = TEAMS[0].every(c => state.frozen.includes(c));
  const team1AllFrozen = TEAMS[1].every(c => state.frozen.includes(c));

  if (team0AllFrozen || team1AllFrozen) {
    const winnerTeamKey = team0AllFrozen ? 'gb' : 'ry';
    const winnerTeam = team0AllFrozen ? TEAMS[1] : TEAMS[0];
    const loserTeam = team0AllFrozen ? TEAMS[0] : TEAMS[1];
    state.winnerTeam = winnerTeamKey;
    state.winner = winnerTeamKey;
    state.phase = 'finished';

    // Placements for team games: winners get gold/silver, losers get bronze/fourth
    // Order within teams: first frozen player ranks lower
    const elimOrder = state.eliminationOrder || [];
    const loserFirst = loserTeam.find(c => elimOrder.indexOf(c) < elimOrder.indexOf(loserTeam.find(c2 => c2 !== c)));
    const loserSecond = loserTeam.find(c => c !== loserFirst);
    // Winners: the one NOT frozen (or frozen last) gets gold
    const winnerFrozen = winnerTeam.filter(c => state.frozen.includes(c));
    const winnerAlive = winnerTeam.filter(c => !state.frozen.includes(c));
    const goldPlayer = winnerAlive[0] || winnerTeam[0];
    const silverPlayer = winnerTeam.find(c => c !== goldPlayer);
    state.placements = {
      gold: goldPlayer,
      silver: silverPlayer,
      bronze: loserSecond || loserTeam[1],
      fourth: loserFirst || loserTeam[0],
    };
  }
}

// ==================== EXECUTE MOVE ====================

function executeMove(state, fromRow, fromCol, toRow, toCol) {
  if (state.winner || state.phase === 'finished') return { error: 'Game is over' };

  const cell = state.board[fromRow][fromCol];
  if (!cell || cell.color !== state.currentPlayer) return { error: 'Not your piece' };
  if (isFrozen(state, cell.color)) return { error: 'Your pieces are frozen' };

  const allMoves = getValidMoves(state.board, fromRow, fromCol, state);
  if (!allMoves.some(m => m.row === toRow && m.col === toCol))
    return { error: 'Invalid move' };

  const next = cloneState(state);
  const fromCell = next.board[fromRow][fromCol];

  // Determine which piece moves from a throne (king or bishop)
  let movingType = fromCell.type;
  let leftBehind = null;

  if (fromCell.thronePartner) {
    const kingMoves = getMovesForPieceType(next.board, next, fromRow, fromCol, 'king', fromCell.color);
    if (kingMoves.some(m => m.row === toRow && m.col === toCol)) {
      movingType = 'king';
      leftBehind = { type: 'bishop', color: fromCell.color };
    } else {
      movingType = 'bishop';
      leftBehind = { type: 'king', color: fromCell.color };
    }
  }

  // Handle capture at destination
  const target = next.board[toRow][toCol];
  let captured = null;
  let capturedExtra = null;

  if (target) {
    captured = { type: target.type, color: target.color };
    // Throne double-occupancy: entering captures both pieces
    if (target.thronePartner) {
      capturedExtra = { type: target.thronePartner.type, color: target.thronePartner.color };
    }
    // King captured → freeze that player's army
    if (target.type === 'king') {
      freezePlayer(next, target.color);
    }
    if (target.thronePartner?.type === 'king') {
      freezePlayer(next, target.thronePartner.color);
    }
  }

  // Place moving piece at destination
  next.board[toRow][toCol] = { type: movingType, color: fromCell.color };

  // Leave throne partner behind or clear origin
  next.board[fromRow][fromCol] = leftBehind || null;

  // Check pawn promotion
  let promotion = null;
  if (movingType === 'pawn') {
    promotion = checkPawnPromotion(next, toRow, toCol);
  }

  const colLetters = 'abcdefgh';
  const moveRecord = {
    player: state.currentPlayer,
    piece: movingType,
    from: { row: fromRow, col: fromCol, notation: colLetters[fromCol] + (8 - fromRow) },
    to:   { row: toRow,   col: toCol,   notation: colLetters[toCol]   + (8 - toRow)   },
    captured,
    capturedExtra: capturedExtra || undefined,
    promotion: promotion || undefined,
    turn: state.turnNumber,
    timestamp: Date.now(),
  };
  next.moveHistory.push(moveRecord);

  if (!next.winner) advanceTurn(next);

  return { state: next, move: moveRecord };
}

function advanceTurn(state) {
  if (state.winner) { state.phase = 'finished'; return; }
  let idx = PLAYERS.indexOf(state.currentPlayer);
  let attempts = 0;
  do {
    idx = (idx + 1) % 4;
    attempts++;
  } while (state.frozen.includes(PLAYERS[idx]) && attempts < 4);
  if (attempts >= 4) { state.phase = 'finished'; return; }
  state.currentPlayer = PLAYERS[idx];
  state.turnNumber++;
  state.phase = 'move';
}

function skipTurn(state) {
  const next = cloneState(state);
  advanceTurn(next);
  return { state: next };
}

function getGameInfo(state) {
  return {
    currentPlayer: state.currentPlayer,
    phase: state.phase,
    frozen: state.frozen,
    eliminated: state.eliminated,
    winner: state.winner,
    winnerTeam: state.winnerTeam,
    turnNumber: state.turnNumber,
    gameType: 'enochian',
  };
}

// Enochian pawns have typed promotion — no player choice needed
function applyPromotion(state, chosenType) {
  if (!state.pendingPromotion) return { error: 'No pending promotion' };
  const { row, col, color } = state.pendingPromotion;
  state.board[row][col] = { type: chosenType, color };
  delete state.pendingPromotion;
  if (!state.winner) advanceTurn(state);
  return { promotedTo: chosenType };
}

module.exports = {
  PLAYERS,
  PLAYER_NAMES,
  TEAMS,
  createGame,
  cloneState,
  rollDice,
  getAvailablePieceTypes,
  getValidMoves,
  executeMove,
  applyPromotion,
  skipTurn,
  getGameInfo,
  hasAnyValidMove,
};
