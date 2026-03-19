// ==================== CHATURAJI CLIENT ====================
// Mobile-first, cross-platform (iOS/Android PWA)

const socket = io(window.BACKEND_URL || '', { reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 20 });

// ==================== STATE ====================
let myColor = null;
let myName = null;
let gameId = null;
let roomCode = null;
let gameState = null;
let players = [];
let selectedCell = null;
let validMoves = [];
let lastMove = null;
let moveHistory = [];
let replayMode = false;
let replayIndex = 0;
let replayMoves = [];

const PLAYERS = ['red', 'yellow', 'green', 'black'];
const PLAYER_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', black: 'Black' };
const PIECE_ICONS = {
  king: '\u265A', elephant: '\u265C', horse: '\u265E',
  boat: '\u2658', pawn: '\u265F'
};
const PLAYER_COLORS = { red: '#ef4444', yellow: '#eab308', green: '#22c55e', black: '#64748b' };

// ==================== PWA & SERVICE WORKER ====================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ==================== CONNECTION STATUS ====================
(function setupConnectionBar() {
  const bar = document.createElement('div');
  bar.className = 'connection-bar';
  bar.id = 'connection-bar';
  bar.textContent = 'Reconnecting...';
  document.body.prepend(bar);

  socket.on('connect', () => bar.classList.remove('show'));
  socket.on('disconnect', () => bar.classList.add('show'));
  socket.on('reconnect_attempt', (n) => { bar.textContent = `Reconnecting... (${n})`; });
  socket.on('reconnect_failed', () => { bar.textContent = 'Connection lost. Tap to retry.'; });
  bar.addEventListener('click', () => { socket.connect(); }, { passive: true });
})();

// ==================== DYNAMIC BOARD SIZING ====================
function computeCellSize() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const isLandscape = vw > vh;
  let available;

  if (vw <= 600) {
    // Phone portrait: fit board to screen width with small padding
    available = vw - 24; // 12px padding each side
  } else if (vw <= 1100) {
    // Tablet or phone landscape: fit within available area
    available = Math.min(vw - 40, vh - 120);
  } else {
    // Desktop: fixed comfortable size, but cap at viewport
    available = Math.min(560, vw - 580, vh - 40);
  }

  // Board is 8 cells + 4px border
  const cellSize = Math.max(36, Math.min(72, Math.floor((available - 4) / 8)));
  document.documentElement.style.setProperty('--cell-size', cellSize + 'px');
  return cellSize;
}

// Recompute on resize and orientation change
function onResize() {
  computeCellSize();
}
window.addEventListener('resize', debounce(onResize, 150));
window.addEventListener('orientationchange', () => setTimeout(onResize, 300));
// iOS visual viewport resize (keyboard show/hide)
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', debounce(onResize, 150));
}
computeCellSize();

// ==================== HAPTIC FEEDBACK ====================
function haptic(style) {
  if (!navigator.vibrate) return;
  switch (style) {
    case 'light': navigator.vibrate(10); break;
    case 'medium': navigator.vibrate(20); break;
    case 'heavy': navigator.vibrate([30, 10, 30]); break;
    case 'success': navigator.vibrate([10, 50, 10]); break;
    case 'error': navigator.vibrate([50, 30, 50]); break;
  }
}

// ==================== SCREEN MANAGEMENT ====================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  // Recompute board size when entering game
  if (id === 'game-screen') setTimeout(computeCellSize, 50);
}

// ==================== LOCAL STORAGE ====================
function saveSession() {
  if (gameId && myColor && myName) {
    localStorage.setItem('chaturaji_session', JSON.stringify({ gameId, myColor, myName, roomCode }));
  }
}
function clearSession() {
  localStorage.removeItem('chaturaji_session');
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem('chaturaji_session')); } catch { return null; }
}

// ==================== LOBBY ====================
function refreshOpenGames() {
  fetch('/api/games').then(r => r.json()).then(games => {
    const el = document.getElementById('open-games-list');
    if (!games.length) { el.innerHTML = '<p class="muted">No open games</p>'; return; }
    el.innerHTML = games.map(g => `
      <div class="game-item" data-code="${g.code}">
        <span class="code">${g.code}</span>
        <span class="info">${g.player_count}/4 players</span>
      </div>
    `).join('');
    // Delegated tap handler
    el.querySelectorAll('.game-item').forEach(item => {
      item.addEventListener('click', () => joinGameByCode(item.dataset.code), { passive: true });
    });
  }).catch(() => {});
}

function refreshRecentGames() {
  fetch('/api/recent').then(r => r.json()).then(games => {
    const el = document.getElementById('recent-games-list');
    const finished = games.filter(g => g.status === 'finished');
    if (!finished.length) { el.innerHTML = '<p class="muted">No completed games yet</p>'; return; }
    el.innerHTML = finished.slice(0, 10).map(g => `
      <div class="game-item" data-id="${g.id}">
        <span class="code">${g.code}</span>
        <span class="info">Winner: ${g.winner ? PLAYER_NAMES[g.winner] : '?'} | ${g.turn_number} turns</span>
      </div>
    `).join('');
    el.querySelectorAll('.game-item').forEach(item => {
      item.addEventListener('click', () => viewReplay(item.dataset.id), { passive: true });
    });
  }).catch(() => {});
}

function joinGameByCode(code) {
  document.getElementById('join-code').value = code;
  document.getElementById('btn-join').click();
}

// ==================== CREATE/JOIN ====================
document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('player-name').value.trim();
  if (!name) return showToast('Please enter your name');
  myName = name;
  haptic('light');

  socket.emit('create-game', { playerName: name }, (res) => {
    if (res.error) return showToast(res.error);
    gameId = res.gameId;
    roomCode = res.code;
    myColor = res.color;
    gameState = res.state;
    players = res.players;
    saveSession();
    showWaitingRoom();
    haptic('success');
  });
}, { passive: true });

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name) return showToast('Please enter your name');
  if (!code) return showToast('Please enter a room code');
  myName = name;
  haptic('light');

  socket.emit('join-game', { code, playerName: name }, (res) => {
    if (res.error) return showToast(res.error);
    gameId = res.gameId;
    roomCode = res.code;
    myColor = res.color;
    gameState = res.state;
    players = res.players;
    saveSession();

    if (players.length >= 4 || gameState.phase !== 'roll' || gameState.turnNumber > 1) {
      enterGame();
    } else {
      showWaitingRoom();
    }
    haptic('success');
  });
}, { passive: true });

// ==================== WAITING ROOM ====================
function showWaitingRoom() {
  showScreen('waiting-screen');
  document.getElementById('room-code').textContent = roomCode;
  renderWaitingPlayers();
}

function renderWaitingPlayers() {
  const el = document.getElementById('waiting-players');
  el.innerHTML = PLAYERS.map(color => {
    const p = players.find(pl => pl.color === color);
    const filled = !!p;
    return `
      <div class="waiting-slot ${filled ? 'filled' : ''}">
        <div class="color-dot" style="background:${PLAYER_COLORS[color]}"></div>
        <div>${PLAYER_NAMES[color]}</div>
        ${filled
          ? `<div class="player-name">${escapeHtml(p.name)}${p.color === myColor ? ' (You)' : ''}</div>`
          : '<div class="empty-label">Waiting...</div>'
        }
      </div>
    `;
  }).join('');
}

document.getElementById('btn-copy-code').addEventListener('click', () => {
  haptic('light');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(roomCode).then(() => updateCopyBtn('Copied!'));
  } else {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = roomCode; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    updateCopyBtn('Copied!');
  }
}, { passive: true });

function updateCopyBtn(text) {
  const btn = document.getElementById('btn-copy-code');
  btn.textContent = text;
  setTimeout(() => btn.textContent = 'Copy', 1500);
}

// Native share on mobile
document.getElementById('btn-copy-code').addEventListener('long-press', () => {
  if (navigator.share) {
    navigator.share({ title: 'Join my Chaturaji game!', text: `Room code: ${roomCode}` }).catch(() => {});
  }
});

document.getElementById('btn-start-bots').addEventListener('click', () => {
  haptic('medium');
  socket.emit('start-game', (res) => {
    if (res.error) return showToast(res.error);
    players = res.players;
    gameState = res.state;
    enterGame();
  });
}, { passive: true });

document.getElementById('btn-leave').addEventListener('click', () => {
  clearSession();
  location.reload();
}, { passive: true });

// ==================== ENTER GAME ====================
function enterGame() {
  showScreen('game-screen');
  document.getElementById('game-room-code').textContent = roomCode;
  computeCellSize();
  renderGame();
}

// ==================== BOARD RENDERING ====================
function renderGame() {
  if (!gameState) return;
  renderBoard();
  renderTurnIndicator();
  renderDice();
  renderPlayers();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  // Create a document fragment for performance
  const frag = document.createDocumentFragment();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      cell.dataset.row = r;
      cell.dataset.col = c;

      if (lastMove) {
        if ((lastMove.from.row === r && lastMove.from.col === c) ||
            (lastMove.to.row === r && lastMove.to.col === c))
          cell.classList.add('last-move');
      }

      if (selectedCell && selectedCell.row === r && selectedCell.col === c)
        cell.classList.add('selected');

      const isTarget = validMoves.some(m => m.row === r && m.col === c);
      if (isTarget) {
        cell.classList.add(gameState.board[r][c] ? 'capture-target' : 'move-target');
      }

      const piece = gameState.board[r][c];
      if (piece) {
        const span = document.createElement('span');
        span.className = `piece-${piece.color}`;
        span.textContent = PIECE_ICONS[piece.type];
        cell.appendChild(span);
      }

      frag.appendChild(cell);
    }
  }

  boardEl.appendChild(frag);

  // Single delegated event handler on board (better perf than 64 listeners)
  boardEl.onclick = null;
  boardEl.ontouchend = null;

  // Use pointer events for unified touch/mouse handling
  boardEl.addEventListener('pointerup', onBoardPointerUp, { passive: true });
}

let boardPointerHandlerAttached = false;
function onBoardPointerUp(e) {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const row = parseInt(cell.dataset.row);
  const col = parseInt(cell.dataset.col);
  if (!isNaN(row) && !isNaN(col)) {
    onCellClick(row, col);
  }
}

function renderTurnIndicator() {
  const el = document.getElementById('turn-indicator');
  if (gameState.winner) {
    el.textContent = `${PLAYER_NAMES[gameState.winner]} Wins!`;
    el.className = `turn-indicator turn-${gameState.winner}`;
  } else {
    const isMe = gameState.currentPlayer === myColor;
    el.textContent = isMe ? 'Your Turn!' : `${PLAYER_NAMES[gameState.currentPlayer]}'s Turn`;
    el.className = `turn-indicator turn-${gameState.currentPlayer}`;
  }
}

function renderDice() {
  const die1 = document.getElementById('die-1');
  const die2 = document.getElementById('die-2');
  const rollBtn = document.getElementById('btn-roll');
  const skipBtn = document.getElementById('btn-skip');

  const isMyTurn = gameState.currentPlayer === myColor;

  if (!gameState.dice) {
    die1.textContent = '-'; die2.textContent = '-';
    die1.className = 'die'; die2.className = 'die';
    rollBtn.disabled = !isMyTurn || !!gameState.winner;
    skipBtn.style.display = 'none';
  } else {
    die1.textContent = gameState.dice[0];
    die2.textContent = gameState.dice[1];
    die1.className = 'die' + (gameState.diceUsed[0] ? ' used' : ' active');
    die2.className = 'die' + (gameState.diceUsed[1] ? ' used' : ' active');
    rollBtn.disabled = true;
    skipBtn.style.display = isMyTurn && !gameState.winner ? 'block' : 'none';
  }
}

function renderPlayers() {
  const el = document.getElementById('game-players');
  el.innerHTML = players.map(p => {
    const isElim = gameState.eliminated.includes(p.color);
    const isCurrent = gameState.currentPlayer === p.color && !gameState.winner;
    const count = countPieces(p.color);
    return `
      <div class="player-row ${isElim ? 'eliminated' : ''} ${isCurrent ? 'current' : ''}">
        <span class="dot" style="background:${PLAYER_COLORS[p.color]}"></span>
        <span class="name">${escapeHtml(p.name)}</span>
        ${p.color === myColor ? '<span class="you-badge">YOU</span>' : ''}
        ${!p.connected && p.socket_id !== null ? '<span class="disconnected">DC</span>' : ''}
        <span class="pieces">${count}</span>
      </div>
    `;
  }).join('');
}

function countPieces(color) {
  let n = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (gameState.board[r][c]?.color === color) n++;
  return n;
}

// ==================== INTERACTION ====================
function onCellClick(row, col) {
  if (!gameState || gameState.winner || gameState.currentPlayer !== myColor || !gameState.dice) return;

  // Clicking a valid move target
  if (selectedCell && validMoves.some(m => m.row === row && m.col === col)) {
    haptic('medium');
    socket.emit('make-move', {
      fromRow: selectedCell.row, fromCol: selectedCell.col,
      toRow: row, toCol: col
    }, (res) => {
      if (res.error) { haptic('error'); return console.error(res.error); }
      gameState = res.state;
      if (res.move) {
        lastMove = { from: res.move.from, to: res.move.to };
        addMoveToHistory(res.move);
        if (res.move.captured) haptic('heavy');
      }
      selectedCell = null;
      validMoves = [];
      renderGame();
    });
    return;
  }

  // Clicking own piece
  const piece = gameState.board[row][col];
  if (piece && piece.color === myColor) {
    haptic('light');
    socket.emit('get-moves', { row, col }, (res) => {
      if (res.moves && res.moves.length > 0) {
        selectedCell = { row, col };
        validMoves = res.moves;
      } else {
        selectedCell = null;
        validMoves = [];
      }
      renderBoard();
    });
    return;
  }

  // Deselect
  selectedCell = null;
  validMoves = [];
  renderBoard();
}

// ==================== DICE ====================
document.getElementById('btn-roll').addEventListener('click', () => {
  haptic('medium');
  socket.emit('roll-dice', (res) => {
    if (res.error) { haptic('error'); return console.error(res.error); }
    gameState = res.state;
    animateDice();
    renderGame();
  });
}, { passive: true });

function animateDice() {
  const d1 = document.getElementById('die-1');
  const d2 = document.getElementById('die-2');
  d1.classList.add('rolling');
  d2.classList.add('rolling');
  setTimeout(() => { d1.classList.remove('rolling'); d2.classList.remove('rolling'); }, 400);
}

document.getElementById('btn-skip').addEventListener('click', () => {
  haptic('light');
  socket.emit('skip-turn', (res) => {
    if (res.error) return console.error(res.error);
    gameState = res.state;
    selectedCell = null;
    validMoves = [];
    renderGame();
  });
}, { passive: true });

// ==================== MOVE HISTORY ====================
function addMoveToHistory(move) {
  moveHistory.push(move);
  const el = document.getElementById('move-history');
  const div = document.createElement('div');
  div.className = 'move-entry' + (move.captured?.type === 'king' ? ' king-capture' : '');
  const capText = move.captured
    ? ` <span class="capture">x${move.captured.type}</span>`
    : '';
  div.innerHTML = `
    <span class="turn-num">${move.turn}.</span>
    <span style="color:${PLAYER_COLORS[move.player]}">${PLAYER_NAMES[move.player]}</span>
    ${move.piece} ${move.from.notation}-${move.to.notation}${capText}
  `;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ==================== CHAT ====================
document.getElementById('btn-send-chat').addEventListener('click', sendChat, { passive: true });
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
});

function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat-message', { message: msg });
  input.value = '';
  // Blur input on mobile to hide keyboard
  if (window.innerWidth <= 600) input.blur();
}

function addChatMessage(data) {
  const el = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `
    <span class="chat-name ${data.color || ''}">${escapeHtml(data.name)}</span>
    <span class="chat-text">${escapeHtml(data.message)}</span>
  `;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ==================== TABS ====================
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    haptic('light');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  }, { passive: true });
});

// ==================== SOCKET EVENTS ====================
socket.on('player-joined', (data) => {
  players = data.players;
  renderWaitingPlayers();
  renderPlayers();
  addSystemMessage(`${data.name} joined as ${PLAYER_NAMES[data.color]}`);
  haptic('light');
});

socket.on('player-reconnected', (data) => {
  const p = players.find(pl => pl.color === data.color);
  if (p) p.connected = true;
  renderPlayers();
  addSystemMessage(`${data.name} reconnected`);
});

socket.on('player-disconnected', (data) => {
  const p = players.find(pl => pl.color === data.color);
  if (p) p.connected = false;
  renderPlayers();
  addSystemMessage(`${data.name} disconnected`);
});

socket.on('game-started', (data) => {
  gameState = data.state;
  players = data.players;
  enterGame();
  addSystemMessage('Game started!');
  haptic('success');
});

socket.on('dice-rolled', (data) => {
  gameState = data.state;
  selectedCell = null;
  validMoves = [];
  animateDice();
  renderGame();
  haptic('light');
});

socket.on('move-made', (data) => {
  gameState = data.state;
  if (data.move) {
    lastMove = { from: data.move.from, to: data.move.to };
    addMoveToHistory(data.move);
  }
  selectedCell = null;
  validMoves = [];
  renderGame();
  haptic('light');
});

socket.on('turn-skipped', (data) => {
  gameState = data.state;
  selectedCell = null;
  validMoves = [];
  renderGame();
  addSystemMessage(`${PLAYER_NAMES[data.player]} skipped`);
});

socket.on('chat-message', addChatMessage);

socket.on('game-over', (data) => {
  const overlay = document.getElementById('game-over-overlay');
  const text = document.getElementById('winner-text');
  const stats = document.getElementById('winner-stats');
  text.textContent = `${PLAYER_NAMES[data.winner]} Wins!`;
  text.className = `turn-${data.winner}`;
  stats.textContent = `Game lasted ${gameState.turnNumber} turns with ${moveHistory.length} moves`;
  overlay.classList.add('show');
  renderGame();
  haptic('heavy');
});

// ==================== REPLAY ====================
document.getElementById('btn-replay').addEventListener('click', () => {
  document.getElementById('game-over-overlay').classList.remove('show');
  startReplay();
}, { passive: true });

document.getElementById('btn-back-lobby').addEventListener('click', () => {
  document.getElementById('game-over-overlay').classList.remove('show');
  clearSession();
  showScreen('lobby-screen');
  refreshOpenGames();
  refreshRecentGames();
}, { passive: true });

function viewReplay(id) {
  fetch(`/api/games/${id}`).then(r => r.json()).then(data => {
    gameId = data.game.id;
    roomCode = data.game.code;
    players = data.players;
    replayMoves = data.moves;
    myColor = null;
    gameState = buildInitialState();
    moveHistory = [];
    enterGame();
    startReplay();
  }).catch(() => showToast('Failed to load replay'));
}

function buildInitialState() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  const setup = {
    red: [
      { type: 'pawn', row: 6, col: 0 }, { type: 'pawn', row: 6, col: 1 },
      { type: 'pawn', row: 6, col: 2 }, { type: 'pawn', row: 6, col: 3 },
      { type: 'king', row: 7, col: 0 }, { type: 'elephant', row: 7, col: 1 },
      { type: 'horse', row: 7, col: 2 }, { type: 'boat', row: 7, col: 3 },
    ],
    yellow: [
      { type: 'boat', row: 7, col: 4 }, { type: 'horse', row: 7, col: 5 },
      { type: 'elephant', row: 7, col: 6 }, { type: 'king', row: 7, col: 7 },
      { type: 'pawn', row: 6, col: 4 }, { type: 'pawn', row: 6, col: 5 },
      { type: 'pawn', row: 6, col: 6 }, { type: 'pawn', row: 6, col: 7 },
    ],
    green: [
      { type: 'boat', row: 0, col: 4 }, { type: 'horse', row: 0, col: 5 },
      { type: 'elephant', row: 0, col: 6 }, { type: 'king', row: 0, col: 7 },
      { type: 'pawn', row: 1, col: 4 }, { type: 'pawn', row: 1, col: 5 },
      { type: 'pawn', row: 1, col: 6 }, { type: 'pawn', row: 1, col: 7 },
    ],
    black: [
      { type: 'king', row: 0, col: 0 }, { type: 'elephant', row: 0, col: 1 },
      { type: 'horse', row: 0, col: 2 }, { type: 'boat', row: 0, col: 3 },
      { type: 'pawn', row: 1, col: 0 }, { type: 'pawn', row: 1, col: 1 },
      { type: 'pawn', row: 1, col: 2 }, { type: 'pawn', row: 1, col: 3 },
    ]
  };
  for (const color of PLAYERS) {
    for (const p of setup[color]) {
      board[p.row][p.col] = { type: p.type, color };
    }
  }
  return {
    board, currentPlayer: 'red', eliminated: [], dice: null,
    diceUsed: [false, false], winner: null, turnNumber: 1, phase: 'roll'
  };
}

function startReplay() {
  replayMode = true;
  replayIndex = 0;
  gameState = buildInitialState();
  lastMove = null;
  document.getElementById('replay-panel').style.display = 'block';
  updateReplayCounter();
  renderGame();
}

function applyReplayMove(state, m) {
  const captured = state.board[m.to_row][m.to_col];
  state.board[m.to_row][m.to_col] = state.board[m.from_row][m.from_col];
  state.board[m.from_row][m.from_col] = null;
  if (captured && captured.type === 'king') {
    state.eliminated.push(captured.color);
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (state.board[r][c]?.color === captured.color)
          state.board[r][c] = null;
  }
  return { from: { row: m.from_row, col: m.from_col }, to: { row: m.to_row, col: m.to_col } };
}

function replayStep(dir) {
  if (!replayMode) return;
  const moves = replayMoves.length ? replayMoves : moveHistory;
  if (dir > 0 && replayIndex < moves.length) {
    lastMove = applyReplayMove(gameState, moves[replayIndex]);
    gameState.currentPlayer = moves[replayIndex].player_color;
    replayIndex++;
  } else if (dir < 0 && replayIndex > 0) {
    replayIndex--;
    gameState = buildInitialState();
    lastMove = null;
    for (let i = 0; i < replayIndex; i++) {
      lastMove = applyReplayMove(gameState, moves[i]);
    }
  }
  haptic('light');
  updateReplayCounter();
  renderGame();
}

function updateReplayCounter() {
  const total = (replayMoves.length ? replayMoves : moveHistory).length;
  document.getElementById('replay-counter').textContent = `${replayIndex} / ${total}`;
}

document.getElementById('btn-replay-start').addEventListener('click', () => {
  replayIndex = 0; gameState = buildInitialState(); lastMove = null;
  updateReplayCounter(); renderGame(); haptic('light');
}, { passive: true });
document.getElementById('btn-replay-prev').addEventListener('click', () => replayStep(-1), { passive: true });
document.getElementById('btn-replay-next').addEventListener('click', () => replayStep(1), { passive: true });
document.getElementById('btn-replay-end').addEventListener('click', () => {
  const moves = replayMoves.length ? replayMoves : moveHistory;
  while (replayIndex < moves.length) replayStep(1);
}, { passive: true });

// ==================== TOAST NOTIFICATIONS ====================
function showToast(msg, duration = 3000) {
  // Remove existing toast
  const old = document.getElementById('toast');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.textContent = msg;
  Object.assign(toast.style, {
    position: 'fixed', bottom: `calc(20px + ${getComputedStyle(document.documentElement).getPropertyValue('--sab') || '0px'})`,
    left: '50%', transform: 'translateX(-50%)',
    background: '#333', color: '#fff', padding: '10px 20px',
    borderRadius: '8px', fontSize: '0.9rem', zIndex: '3000',
    opacity: '0', transition: 'opacity 0.3s',
    maxWidth: '90vw', textAlign: 'center',
  });
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, duration);
  haptic('error');
}

// ==================== HELPERS ====================
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function addSystemMessage(msg) {
  addChatMessage({ name: 'System', color: '', message: msg });
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ==================== RECONNECTION ====================
socket.on('connect', () => {
  const session = loadSession();
  if (session) {
    socket.emit('rejoin-game', session, (res) => {
      if (res.error) { clearSession(); return; }
      gameId = session.gameId;
      myColor = session.myColor;
      myName = session.myName;
      roomCode = session.roomCode;
      gameState = res.state;
      players = res.players;

      // Restore move history
      if (res.moves) {
        moveHistory = [];
        document.getElementById('move-history').innerHTML = '';
        for (const m of res.moves) {
          addMoveToHistory({
            turn: m.turn_number, player: m.player_color, piece: m.piece_type,
            from: { row: m.from_row, col: m.from_col, notation: `${String.fromCharCode(97+m.from_col)}${8-m.from_row}` },
            to: { row: m.to_row, col: m.to_col, notation: `${String.fromCharCode(97+m.to_col)}${8-m.to_row}` },
            captured: m.captured_type ? { type: m.captured_type, color: m.captured_color } : null,
            dice: [m.dice_1, m.dice_2]
          });
        }
      }
      // Restore chat
      if (res.chat) {
        for (const c of res.chat) addChatMessage({ color: c.player_color, name: c.player_name, message: c.message });
      }

      enterGame();
    });
  }
});

// ==================== PREVENT ZOOM GESTURES ON BOARD ====================
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

// Prevent double-tap zoom on the board specifically
let lastTapTime = 0;
document.getElementById('board')?.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTapTime < 300) e.preventDefault();
  lastTapTime = now;
});

// ==================== WAKE LOCK (keep screen on during game) ====================
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {}
}
// Re-request on visibility change (iOS releases on tab switch)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && gameId) requestWakeLock();
});

// ==================== INIT ====================
document.getElementById('btn-refresh').addEventListener('click', () => {
  refreshOpenGames(); refreshRecentGames();
}, { passive: true });

// Load saved name
const savedName = localStorage.getItem('chaturaji_name');
if (savedName) document.getElementById('player-name').value = savedName;
document.getElementById('player-name').addEventListener('change', (e) => {
  localStorage.setItem('chaturaji_name', e.target.value.trim());
});

// Enter key on inputs
document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-join').click(); }
});
document.getElementById('player-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('player-name').blur(); }
});

refreshOpenGames();
refreshRecentGames();
