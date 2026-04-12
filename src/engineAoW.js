// ==================== 4-KING CHESS ENGINE (Air of Water) ====================
// 4-player standard chess on 8x8. No dice. Turn order: yellow → green → red → black.
// Corner throne squares start with king + bishop stacked; enemy entering captures both.

const PLAYERS = ['yellow', 'green', 'red', 'black'];
const PLAYER_NAMES = { yellow: 'Yellow', green: 'Blue', red: 'Red', black: 'Black' };

// Throne corners [row, col] (row 0 = rank 8, col 0 = file a)
const THRONE = { yellow: [0,0], green: [0,7], red: [7,7], black: [7,0] };

// Pawn movement direction [dr, dc]
const PAWN_DIR = {
  yellow: [1, 0],   // moves toward rank 1 (down the board)
  green:  [0, -1],  // moves toward file a (leftward)
  red:    [-1, 0],  // moves toward rank 8 (up the board)
  black:  [0, 1],   // moves toward file h (rightward)
};

function isAtFarEnd(color, row, col) {
  if (color === 'yellow') return row === 7;
  if (color === 'green')  return col === 0;
  if (color === 'red')    return row === 0;
  if (color === 'black')  return col === 7;
  return false;
}

// ==================== INITIAL STATE ====================

function createGame() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));

  // Yellow (top edge, a8 corner throne)
  board[0][0] = { type: 'king',   color: 'yellow', thronePartner: { type: 'bishop', color: 'yellow' } };
  board[0][1] = { type: 'queen',  color: 'yellow' };
  board[0][2] = { type: 'rook',   color: 'yellow' };
  board[0][3] = { type: 'knight', color: 'yellow' };
  board[1][0] = { type: 'pawn',   color: 'yellow' };
  board[1][1] = { type: 'pawn',   color: 'yellow' };
  board[1][2] = { type: 'pawn',   color: 'yellow' };
  board[1][3] = { type: 'pawn',   color: 'yellow' };

  // Green/Blue (right edge, h8 corner throne)
  board[0][7] = { type: 'king',   color: 'green', thronePartner: { type: 'bishop', color: 'green' } };
  board[1][7] = { type: 'queen',  color: 'green' };
  board[2][7] = { type: 'rook',   color: 'green' };
  board[3][7] = { type: 'knight', color: 'green' };
  board[0][6] = { type: 'pawn',   color: 'green' };
  board[1][6] = { type: 'pawn',   color: 'green' };
  board[2][6] = { type: 'pawn',   color: 'green' };
  board[3][6] = { type: 'pawn',   color: 'green' };

  // Red (bottom edge, h1 corner throne)
  board[7][7] = { type: 'king',   color: 'red', thronePartner: { type: 'bishop', color: 'red' } };
  board[7][6] = { type: 'queen',  color: 'red' };
  board[7][5] = { type: 'rook',   color: 'red' };
  board[7][4] = { type: 'knight', color: 'red' };
  board[6][7] = { type: 'pawn',   color: 'red' };
  board[6][6] = { type: 'pawn',   color: 'red' };
  board[6][5] = { type: 'pawn',   color: 'red' };
  board[6][4] = { type: 'pawn',   color: 'red' };

  // Black (left edge, a1 corner throne)
  board[7][0] = { type: 'king',   color: 'black', thronePartner: { type: 'bishop', color: 'black' } };
  board[6][0] = { type: 'queen',  color: 'black' };
  board[5][0] = { type: 'rook',   color: 'black' };
  board[4][0] = { type: 'knight', color: 'black' };
  board[7][1] = { type: 'pawn',   color: 'black' };
  board[6][1] = { type: 'pawn',   color: 'black' };
  board[5][1] = { type: 'pawn',   color: 'black' };
  board[4][1] = { type: 'pawn',   color: 'black' };

  return {
    board,
    currentPlayer: 'yellow',
    eliminated: [],
    winner: null,
    moveHistory: [],
    turnNumber: 1,
    phase: 'move',      // No dice — always 'move'
    gameType: 'aow',
    dice: null,
    diceUsed: null,
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// No-op — AoW has no dice
function rollDice(state) {
  return { state: cloneState(state), dice: null };
}

// All piece types always available (no dice restriction)
function getAvailablePieceTypes() {
  return ['king', 'queen', 'bishop', 'knight', 'rook', 'pawn'];
}

// ==================== MOVE GENERATION ====================

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

function addSlideMoves(board, row, col, color, dirs, moves) {
  for (const [dr, dc] of dirs) {
    let r = row + dr, c = col + dc;
    while (inBounds(r, c)) {
      const target = board[r][c];
      if (!target) {
        moves.push({ row: r, col: c });
      } else {
        if (target.color !== color) moves.push({ row: r, col: c });
        break;
      }
      r += dr; c += dc;
    }
  }
}

function getMovesForPieceType(board, row, col, type, color) {
  const moves = [];
  switch (type) {
    case 'king':
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = row + dr, c = col + dc;
          if (inBounds(r, c) && board[r][c]?.color !== color)
            moves.push({ row: r, col: c });
        }
      }
      break;
    case 'queen':
      addSlideMoves(board, row, col, color,
        [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]], moves);
      break;
    case 'rook':
      addSlideMoves(board, row, col, color, [[-1,0],[1,0],[0,-1],[0,1]], moves);
      break;
    case 'bishop':
      addSlideMoves(board, row, col, color, [[-1,-1],[-1,1],[1,-1],[1,1]], moves);
      break;
    case 'knight':
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const r = row + dr, c = col + dc;
        if (inBounds(r, c) && board[r][c]?.color !== color)
          moves.push({ row: r, col: c });
      }
      break;
    case 'pawn': {
      const [dr, dc] = PAWN_DIR[color];
      const nr = row + dr, nc = col + dc;
      if (inBounds(nr, nc) && !board[nr][nc])
        moves.push({ row: nr, col: nc });
      // Diagonal captures
      const capDirs = dr !== 0 ? [[dr, -1], [dr, 1]] : [[-1, dc], [1, dc]];
      for (const [cdr, cdc] of capDirs) {
        const cr = row + cdr, cc = col + cdc;
        if (inBounds(cr, cc) && board[cr][cc] && board[cr][cc].color !== color)
          moves.push({ row: cr, col: cc });
      }
      break;
    }
  }
  return moves;
}

function getValidMoves(board, row, col) {
  const piece = board[row][col];
  if (!piece) return [];

  const moves = getMovesForPieceType(board, row, col, piece.type, piece.color);

  // Throne square with stacked bishop: also include bishop's moves
  if (piece.thronePartner) {
    const partnerMoves = getMovesForPieceType(board, row, col,
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
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (p && p.color === color && getValidMoves(state.board, r, c).length > 0) return true;
    }
  return false;
}

// ==================== EXECUTE MOVE ====================

function executeMove(state, fromRow, fromCol, toRow, toCol) {
  if (state.winner || state.phase === 'finished') return { error: 'Game is over' };

  const cell = state.board[fromRow][fromCol];
  if (!cell || cell.color !== state.currentPlayer) return { error: 'Not your piece' };

  const allMoves = getValidMoves(state.board, fromRow, fromCol);
  if (!allMoves.some(m => m.row === toRow && m.col === toCol))
    return { error: 'Invalid move' };

  const next = cloneState(state);
  const fromCell = next.board[fromRow][fromCol];

  // Determine which piece moves: if throne has partner, pick king unless
  // only the bishop can reach the destination
  let movingType = fromCell.type;
  let leftBehind = null;

  if (fromCell.thronePartner) {
    const kingMoves = getMovesForPieceType(next.board, fromRow, fromCol, 'king', fromCell.color);
    if (kingMoves.some(m => m.row === toRow && m.col === toCol)) {
      movingType = 'king';
      leftBehind = { type: 'bishop', color: fromCell.color };
    } else {
      movingType = 'bishop';
      leftBehind = { type: 'king', color: fromCell.color };
    }
  }

  // Capture at destination
  const target = next.board[toRow][toCol];
  let captured = null;
  let capturedExtra = null;
  if (target) {
    captured = { type: target.type, color: target.color };
    if (target.thronePartner) {
      // Enemy entering a still-double-occupied throne captures both pieces
      capturedExtra = { type: target.thronePartner.type, color: target.thronePartner.color };
    }
    if (target.type === 'king') {
      eliminatePlayer(next, target.color);
    }
  }

  // Place moving piece (eliminatePlayer may have cleared [toRow][toCol])
  next.board[toRow][toCol] = { type: movingType, color: fromCell.color };

  // Leave partner behind on throne (or clear the square)
  next.board[fromRow][fromCol] = leftBehind || null;

  // Pawn promotion → queen
  let promotion = null;
  if (movingType === 'pawn' && isAtFarEnd(fromCell.color, toRow, toCol)) {
    next.board[toRow][toCol] = { type: 'queen', color: fromCell.color };
    promotion = 'queen';
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

function eliminatePlayer(state, color) {
  if (state.eliminated.includes(color)) return;
  state.eliminated.push(color);
  // Remove all pieces of this player from the board
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (!p) continue;
      if (p.color === color) {
        state.board[r][c] = null;
      } else if (p.thronePartner && p.thronePartner.color === color) {
        delete p.thronePartner;
      }
    }
  }
  const alive = PLAYERS.filter(p => !state.eliminated.includes(p));
  if (alive.length === 1) {
    state.winner = alive[0];
    state.phase = 'finished';
  }
}

function advanceTurn(state) {
  if (state.winner) { state.phase = 'finished'; return; }
  let idx = PLAYERS.indexOf(state.currentPlayer);
  do { idx = (idx + 1) % 4; } while (state.eliminated.includes(PLAYERS[idx]));
  state.currentPlayer = PLAYERS[idx];
  state.turnNumber++;
  state.phase = 'move';
}

function skipTurn(state) {
  if (hasAnyValidMove(state)) return { error: 'You have valid moves' };
  const next = cloneState(state);
  advanceTurn(next);
  return { state: next };
}

function getGameInfo(state) {
  return {
    currentPlayer: state.currentPlayer,
    phase: state.phase,
    eliminated: state.eliminated,
    winner: state.winner,
    turnNumber: state.turnNumber,
    gameType: 'aow',
  };
}

module.exports = {
  PLAYERS,
  PLAYER_NAMES,
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
