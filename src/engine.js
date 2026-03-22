// ==================== CHATURAJI GAME ENGINE ====================
// Pure game logic — no I/O, no side effects. Fully serializable state.

const PLAYERS = ['red', 'yellow', 'green', 'black'];
const PLAYER_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', black: 'Black' };
const DIE_FACES = ['king', 'elephant', 'horse', 'boat'];

const INITIAL_SETUP = {
  red: {
    pieces: [
      { type: 'pawn', row: 6, col: 0 }, { type: 'pawn', row: 6, col: 1 },
      { type: 'pawn', row: 6, col: 2 }, { type: 'pawn', row: 6, col: 3 },
      { type: 'king', row: 7, col: 0 }, { type: 'elephant', row: 7, col: 1 },
      { type: 'horse', row: 7, col: 2 }, { type: 'boat', row: 7, col: 3 },
    ],
    pawnDir: [-1, 0]
  },
  yellow: {
    // West-moving army: back rank at col 7, pawns at col 6, king at bottom-right corner
    pieces: [
      { type: 'king', row: 7, col: 7 }, { type: 'elephant', row: 6, col: 7 },
      { type: 'horse', row: 5, col: 7 }, { type: 'boat', row: 4, col: 7 },
      { type: 'pawn', row: 7, col: 6 }, { type: 'pawn', row: 6, col: 6 },
      { type: 'pawn', row: 5, col: 6 }, { type: 'pawn', row: 4, col: 6 },
    ],
    pawnDir: [0, -1]
  },
  green: {
    pieces: [
      { type: 'boat', row: 0, col: 4 }, { type: 'horse', row: 0, col: 5 },
      { type: 'elephant', row: 0, col: 6 }, { type: 'king', row: 0, col: 7 },
      { type: 'pawn', row: 1, col: 4 }, { type: 'pawn', row: 1, col: 5 },
      { type: 'pawn', row: 1, col: 6 }, { type: 'pawn', row: 1, col: 7 },
    ],
    pawnDir: [1, 0]
  },
  black: {
    // East-moving army: back rank at col 0, pawns at col 1, king at top-left corner
    pieces: [
      { type: 'king', row: 0, col: 0 }, { type: 'elephant', row: 1, col: 0 },
      { type: 'horse', row: 2, col: 0 }, { type: 'boat', row: 3, col: 0 },
      { type: 'pawn', row: 0, col: 1 }, { type: 'pawn', row: 1, col: 1 },
      { type: 'pawn', row: 2, col: 1 }, { type: 'pawn', row: 3, col: 1 },
    ],
    pawnDir: [0, 1]
  }
};

function createGame() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const color of PLAYERS) {
    for (const p of INITIAL_SETUP[color].pieces) {
      board[p.row][p.col] = { type: p.type, color };
    }
  }
  return {
    board,
    currentPlayer: 'red',
    eliminated: [],
    dice: null,       // [face1, face2] or null
    diceUsed: [false, false],
    winner: null,
    moveHistory: [],  // [{player, piece, from, to, captured, dice, turn}]
    turnNumber: 1,
    phase: 'roll',    // 'roll' | 'move' | 'finished'
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// ==================== DICE ====================

function rollDice(state) {
  if (state.phase !== 'roll' || state.winner) return { error: 'Cannot roll now' };
  const next = cloneState(state);
  const d1 = DIE_FACES[Math.floor(Math.random() * 4)];
  const d2 = DIE_FACES[Math.floor(Math.random() * 4)];
  next.dice = [d1, d2];
  next.diceUsed = [false, false];
  next.phase = 'move';

  // Auto-skip if no moves possible
  if (!hasAnyValidMove(next)) {
    advanceTurn(next);
  }
  return { state: next, dice: [d1, d2] };
}

function getMovableTypesForDie(state, dieFace) {
  const color = state.currentPlayer;
  const types = [];
  if (dieFace === 'king') {
    if (hasPiece(state.board, color, 'king')) types.push('king');
    if (hasPiece(state.board, color, 'pawn')) types.push('pawn');
  } else {
    if (hasPiece(state.board, color, dieFace)) {
      types.push(dieFace);
    } else {
      if (hasPiece(state.board, color, 'pawn')) types.push('pawn');
    }
  }
  return types;
}

function getAvailablePieceTypes(state) {
  if (!state.dice) return [];
  const types = new Set();
  for (let i = 0; i < 2; i++) {
    if (state.diceUsed[i]) continue;
    for (const t of getMovableTypesForDie(state, state.dice[i])) {
      types.add(t);
    }
  }
  return [...types];
}

function hasPiece(board, color, type) {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] && board[r][c].color === color && board[r][c].type === type)
        return true;
  return false;
}

// ==================== MOVEMENT ====================

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function isEmpty(board, r, c) { return !board[r][c]; }
function isEnemy(board, r, c, color) { return board[r][c] && board[r][c].color !== color; }

function getValidMoves(board, row, col) {
  const piece = board[row][col];
  if (!piece) return [];
  const moves = [];
  switch (piece.type) {
    case 'king': addKingMoves(board, row, col, piece, moves); break;
    case 'elephant': addElephantMoves(board, row, col, piece, moves); break;
    case 'horse': addHorseMoves(board, row, col, piece, moves); break;
    case 'boat': addBoatMoves(board, row, col, piece, moves); break;
    case 'pawn': addPawnMoves(board, row, col, piece, moves); break;
  }
  return moves;
}

function addKingMoves(board, row, col, piece, moves) {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr, nc = col + dc;
      if (inBounds(nr, nc) && (isEmpty(board, nr, nc) || isEnemy(board, nr, nc, piece.color)))
        moves.push({ row: nr, col: nc });
    }
  }
}

function addElephantMoves(board, row, col, piece, moves) {
  for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    let nr = row + dr, nc = col + dc;
    while (inBounds(nr, nc)) {
      if (isEmpty(board, nr, nc)) {
        moves.push({ row: nr, col: nc });
      } else {
        if (isEnemy(board, nr, nc, piece.color)) moves.push({ row: nr, col: nc });
        break;
      }
      nr += dr; nc += dc;
    }
  }
}

function addHorseMoves(board, row, col, piece, moves) {
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const nr = row + dr, nc = col + dc;
    if (inBounds(nr, nc) && (isEmpty(board, nr, nc) || isEnemy(board, nr, nc, piece.color)))
      moves.push({ row: nr, col: nc });
  }
}

function addBoatMoves(board, row, col, piece, moves) {
  for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
    const nr = row + 2*dr, nc = col + 2*dc;
    if (!inBounds(nr, nc)) continue;
    if (isEmpty(board, nr, nc)) {
      moves.push({ row: nr, col: nc });
    } else if (isEnemy(board, nr, nc, piece.color) && board[nr][nc].type !== 'king') {
      moves.push({ row: nr, col: nc });
    }
  }
}

function addPawnMoves(board, row, col, piece, moves) {
  const [dr, dc] = INITIAL_SETUP[piece.color].pawnDir;
  const nr = row + dr, nc = col + dc;
  if (inBounds(nr, nc) && isEmpty(board, nr, nc))
    moves.push({ row: nr, col: nc });

  const capDirs = dr !== 0 ? [[dr, -1], [dr, 1]] : [[-1, dc], [1, dc]];
  for (const [cdr, cdc] of capDirs) {
    const cr = row + cdr, cc = col + cdc;
    if (inBounds(cr, cc) && isEnemy(board, cr, cc, piece.color))
      moves.push({ row: cr, col: cc });
  }
}

// When a pawn reaches the far edge, resurrect the first dead major piece (elephant > horse > boat)
function checkPawnPromotion(state, row, col) {
  const piece = state.board[row][col];
  if (!piece || piece.type !== 'pawn') return null;
  const color = piece.color;
  const dir = INITIAL_SETUP[color].pawnDir;
  let atFarEnd = false;
  if (dir[0] === -1 && row === 0) atFarEnd = true;  // Red moves north
  if (dir[0] === 1  && row === 7) atFarEnd = true;  // Green moves south
  if (dir[1] === -1 && col === 0) atFarEnd = true;  // Yellow moves west
  if (dir[1] === 1  && col === 7) atFarEnd = true;  // Black moves east
  if (!atFarEnd) return null;
  for (const type of ['elephant', 'horse', 'boat']) {
    if (!hasPiece(state.board, color, type)) {
      state.board[row][col] = { type, color };
      return type;
    }
  }
  return null; // All major pieces still alive — pawn waits at far edge
}

function hasAnyValidMove(state) {
  const types = getAvailablePieceTypes(state);
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (p && p.color === state.currentPlayer && types.includes(p.type))
        if (getValidMoves(state.board, r, c).length > 0) return true;
    }
  return false;
}

// ==================== EXECUTE MOVE ====================

function executeMove(state, fromRow, fromCol, toRow, toCol) {
  if (state.phase !== 'move' || state.winner) return { error: 'Cannot move now' };

  const piece = state.board[fromRow][fromCol];
  if (!piece || piece.color !== state.currentPlayer)
    return { error: 'Not your piece' };

  const availTypes = getAvailablePieceTypes(state);
  if (!availTypes.includes(piece.type))
    return { error: 'Dice do not allow this piece type' };

  const moves = getValidMoves(state.board, fromRow, fromCol);
  if (!moves.some(m => m.row === toRow && m.col === toCol))
    return { error: 'Invalid move' };

  const next = cloneState(state);
  const target = next.board[toRow][toCol];
  let captured = null;

  if (target) {
    captured = { ...target };
    if (target.type === 'king') {
      eliminatePlayer(next, target.color);
    }
  }

  next.board[toRow][toCol] = next.board[fromRow][fromCol];
  next.board[fromRow][fromCol] = null;

  // Check pawn promotion
  let promotion = null;
  if (piece.type === 'pawn') {
    promotion = checkPawnPromotion(next, toRow, toCol);
  }

  // Use a die
  useDie(next, piece.type);

  const colLetters = 'abcdefgh';
  const moveRecord = {
    player: state.currentPlayer,
    piece: piece.type,
    from: { row: fromRow, col: fromCol, notation: colLetters[fromCol] + (8 - fromRow) },
    to: { row: toRow, col: toCol, notation: colLetters[toCol] + (8 - toRow) },
    captured,
    promotion: promotion || undefined,
    dice: [...state.dice],
    turn: state.turnNumber,
    timestamp: Date.now(),
  };
  next.moveHistory.push(moveRecord);

  // Check if turn is over
  if (next.diceUsed[0] && next.diceUsed[1]) {
    advanceTurn(next);
  } else if (!hasAnyValidMove(next)) {
    advanceTurn(next);
  }

  return { state: next, move: moveRecord };
}

function useDie(state, pieceType) {
  for (let i = 0; i < 2; i++) {
    if (state.diceUsed[i]) continue;
    const movable = getMovableTypesForDie(state, state.dice[i]);
    if (movable.includes(pieceType)) {
      state.diceUsed[i] = true;
      return;
    }
  }
}

function skipTurn(state) {
  if (state.phase !== 'move' || state.winner) return { error: 'Cannot skip now' };
  const next = cloneState(state);
  advanceTurn(next);
  return { state: next };
}

function eliminatePlayer(state, color) {
  if (!state.eliminated.includes(color)) {
    state.eliminated.push(color);
  }
  // Remove all pieces
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (state.board[r][c] && state.board[r][c].color === color)
        state.board[r][c] = null;

  const alive = PLAYERS.filter(p => !state.eliminated.includes(p));
  if (alive.length === 1) {
    state.winner = alive[0];
    state.phase = 'finished';
  }
}

function advanceTurn(state) {
  if (state.winner) { state.phase = 'finished'; return; }
  state.dice = null;
  state.diceUsed = [false, false];
  state.phase = 'roll';
  let idx = PLAYERS.indexOf(state.currentPlayer);
  do { idx = (idx + 1) % 4; } while (state.eliminated.includes(PLAYERS[idx]));
  state.currentPlayer = PLAYERS[idx];
  state.turnNumber++;
}

// ==================== QUERIES ====================

function getGameInfo(state) {
  const pieceCounts = {};
  for (const color of PLAYERS) {
    pieceCounts[color] = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (state.board[r][c] && state.board[r][c].color === color)
          pieceCounts[color]++;
  }
  return {
    currentPlayer: state.currentPlayer,
    phase: state.phase,
    eliminated: state.eliminated,
    winner: state.winner,
    turnNumber: state.turnNumber,
    pieceCounts,
    dice: state.dice,
    diceUsed: state.diceUsed,
    totalMoves: state.moveHistory.length,
  };
}

module.exports = {
  PLAYERS,
  PLAYER_NAMES,
  DIE_FACES,
  createGame,
  cloneState,
  rollDice,
  getAvailablePieceTypes,
  getValidMoves,
  executeMove,
  skipTurn,
  getGameInfo,
  hasAnyValidMove,
};
