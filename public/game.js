// ==================== CHATURAJI CLIENT ====================
// Mobile-first, cross-platform (iOS/Android PWA)

const socket = io(window.BACKEND_URL || '', {
  reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 20,
  auth: { token: window.__jwt || '' }
});
window.socket = socket;

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
// AoW renames Green → Blue in display
const AOW_PLAYERS = ['yellow', 'green', 'red', 'black'];
const AOW_PLAYER_NAMES = { yellow: 'Yellow', green: 'Blue', red: 'Red', black: 'Black' };
function playerName(color) {
  return ((gameType === 'aow' || gameType === 'enochian') ? AOW_PLAYER_NAMES : PLAYER_NAMES)[color] || color;
}
// ♚=King ♜=Elephant/Rook ♞=Horse/Knight ♝=Boat/Bishop ♟=Pawn ♛=Queen
const PIECE_ICONS = {
  king: '\u265A', elephant: '\u265C', horse: '\u265E',
  boat: '\u265D', pawn: '\u265F', queen: '\u265B',
  bishop: '\u265D', rook: '\u265C', knight: '\u265E'
};
const PIECE_ABBR = {
  king: 'K', elephant: 'El', horse: 'H', boat: 'Bt', pawn: 'P', queen: 'Q',
  bishop: 'B', rook: 'R', knight: 'N'
};

let gameType = 'classic'; // 'classic' | 'enochian'
let selectedMode = 'classic';
let selectedBoard = localStorage.getItem('chaturaji_board') || 'bw';
const PLAYER_COLORS = { red: '#ef4444', yellow: '#eab308', green: '#22c55e', black: '#64748b' };

// ==================== FREE TRIAL SYSTEM ====================
const TRIAL_LIMITS = { classic_bot: 16, classic_mp: 8, enochian_bot: 12, enochian_mp: 6 };
function getTrialCounts() {
  try { return JSON.parse(localStorage.getItem('chaturaji_trials') || '{}'); } catch { return {}; }
}
function getTrialCount(mode, isBot) {
  return getTrialCounts()[`${mode}_${isBot ? 'bot' : 'mp'}`] || 0;
}
function incrementTrial(mode, isBot) {
  const counts = getTrialCounts();
  const key = `${mode}_${isBot ? 'bot' : 'mp'}`;
  counts[key] = (counts[key] || 0) + 1;
  localStorage.setItem('chaturaji_trials', JSON.stringify(counts));
}
function canPlayTrial(mode, isBot) {
  const key = `${mode}_${isBot ? 'bot' : 'mp'}`;
  return getTrialCount(mode, isBot) < (TRIAL_LIMITS[key] || 16);
}
function showTrialEnded() {
  document.getElementById('payment-wall').style.display = 'flex';
}
function getRemainingTrials(mode, isBot) {
  const key = `${mode}_${isBot ? 'bot' : 'mp'}`;
  return Math.max(0, (TRIAL_LIMITS[key] || 16) - getTrialCount(mode, isBot));
}

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
  fetch(`${window.BACKEND_URL}/api/games`).then(r => r.json()).then(games => {
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
  fetch(`${window.BACKEND_URL}/api/recent`).then(r => r.json()).then(games => {
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
function getRandomColorPref() { return document.getElementById('random-color')?.checked ?? true; }

document.getElementById('btn-play-bots').addEventListener('click', () => {
  if (!canPlayTrial(selectedMode, true)) return showTrialEnded();
  const name = document.getElementById('player-name').value.trim();
  if (!name) return showToast('Please enter your name');
  myName = name;
  haptic('light');
  localStorage.setItem('chaturaji_name', name);

  socket.emit('create-game', { playerName: name, randomColor: getRandomColorPref(), gameType: selectedMode }, (res) => {
    if (res.error) return showToast(res.error);
    gameId = res.gameId; roomCode = res.code; myColor = res.color;
    gameState = res.state; players = res.players;
    if (res.gameType) gameType = res.gameType;
    saveSession();

    socket.emit('start-game', (startRes) => {
      if (startRes.error) return showToast(startRes.error);
      players = startRes.players; gameState = startRes.state;
      if (startRes.gameType) gameType = startRes.gameType;
      enterGame(); haptic('success');
    });
  });
}, { passive: true });

document.getElementById('btn-create').addEventListener('click', () => {
  if (!canPlayTrial(selectedMode, false)) return showTrialEnded();
  const name = document.getElementById('player-name').value.trim();
  if (!name) return showToast('Please enter your name');
  myName = name;
  haptic('light');
  localStorage.setItem('chaturaji_name', name);

  socket.emit('create-game', { playerName: name, randomColor: getRandomColorPref(), gameType: selectedMode }, (res) => {
    if (res.error) return showToast(res.error);
    gameId = res.gameId; roomCode = res.code; myColor = res.color;
    gameState = res.state; players = res.players;
    if (res.gameType) gameType = res.gameType;
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

  if (!canPlayTrial(selectedMode, false)) return showTrialEnded();
  socket.emit('join-game', { code, playerName: name, randomColor: getRandomColorPref() }, (res) => {
    if (res.error) return showToast(res.error);

    // If game is full but has bots, offer takeover
    if (res.canTakeOver && res.bots && res.bots.length > 0) {
      const botChoice = prompt(
        'This game has bot players. Enter a color to take over:\n' +
        res.bots.map(b => `  • ${b.color}`).join('\n') +
        '\n\nType a color name (e.g. "red") or cancel:'
      );
      if (!botChoice) return;
      const chosenColor = botChoice.trim().toLowerCase();
      if (!res.bots.find(b => b.color === chosenColor)) return showToast('Invalid color');
      socket.emit('join-game', { code, playerName: name, randomColor: false, takeOverBot: chosenColor }, (res2) => {
        if (res2.error) return showToast(res2.error);
        finishJoinGame(res2);
      });
      return;
    }

    finishJoinGame(res);
  });

  function finishJoinGame(res) {
    gameId = res.gameId; roomCode = res.code; myColor = res.color;
    gameState = res.state; players = res.players;
    if (res.gameType) gameType = res.gameType;
    saveSession();

    const inProgress = players.length >= 4 || gameState.turnNumber > 1 ||
      (gameType !== 'aow' && gameType !== 'enochian' && gameState.phase !== 'roll');
    if (inProgress) {
      enterGame();
    } else {
      showWaitingRoom();
    }
    haptic('success');
  }
}, { passive: true });

// ==================== WAITING ROOM ====================
function showWaitingRoom() {
  showScreen('waiting-screen');
  document.getElementById('room-code').textContent = roomCode;
  renderWaitingPlayers();
}

function renderWaitingPlayers() {
  const el = document.getElementById('waiting-players');
  const order = (gameType === 'aow' || gameType === 'enochian') ? AOW_PLAYERS : PLAYERS;
  el.innerHTML = order.map(color => {
    const p = players.find(pl => pl.color === color);
    const filled = !!p;
    return `
      <div class="waiting-slot ${filled ? 'filled' : ''}">
        <div class="color-dot" style="background:${PLAYER_COLORS[color]}"></div>
        <div>${playerName(color)}</div>
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
  // Apply board theme
  boardEl.className = 'board' + (selectedBoard ? ' theme-' + selectedBoard : '');

  // Create a document fragment for performance
  const frag = document.createDocumentFragment();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('div');
      // Quadrant class for Enochian sub-boards: NW/NE/SE/SW
      const quad = r < 4 ? (c < 4 ? 'quad-nw' : 'quad-ne') : (c < 4 ? 'quad-sw' : 'quad-se');
      cell.className = 'cell ' + ((r + c) % 2 === 0 ? 'light' : 'dark') + ' ' + quad;
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

      // Rank label (col 0, left edge)
      if (c === 0) {
        const rl = document.createElement('span');
        rl.className = 'coord-label rank-label';
        rl.textContent = 8 - r;
        cell.appendChild(rl);
      }
      // File label (row 7, bottom edge)
      if (r === 7) {
        const fl = document.createElement('span');
        fl.className = 'coord-label file-label';
        fl.textContent = 'abcdefgh'[c];
        cell.appendChild(fl);
      }

      const piece = gameState.board[r][c];
      if (piece) {
        const wrap = document.createElement('span');
        wrap.className = `piece-wrap piece-${piece.color}`;
        const icon = document.createElement('span');
        icon.className = 'piece-icon';
        icon.textContent = PIECE_ICONS[piece.type];
        const lbl = document.createElement('span');
        lbl.className = 'piece-name';
        lbl.textContent = PIECE_ABBR[piece.type];
        wrap.appendChild(icon);
        wrap.appendChild(lbl);
        // Frozen pieces: greyed out, not interactive
        if (gameState.frozen?.includes(piece.color)) {
          wrap.classList.add('frozen');
        }
        // Throne double-occupancy: show stacked partner bishop
        if (piece.thronePartner) {
          cell.classList.add('throne-double');
          const partnerEl = document.createElement('span');
          partnerEl.className = 'throne-partner';
          partnerEl.textContent = (PIECE_ICONS[piece.thronePartner.type] || '♝') + (PIECE_ABBR[piece.thronePartner.type] || 'B');
          wrap.appendChild(partnerEl);
        }
        cell.appendChild(wrap);
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
    el.textContent = `${playerName(gameState.winner)} Wins!`;
    el.className = `turn-indicator turn-${gameState.winner}`;
  } else {
    const isMe = gameState.currentPlayer === myColor;
    el.textContent = isMe ? 'Your Turn!' : `${playerName(gameState.currentPlayer)}'s Turn`;
    el.className = `turn-indicator turn-${gameState.currentPlayer}`;
  }
}

function renderDice() {
  const dicePanel = document.getElementById('dice-panel');
  if (gameType === 'aow' || gameType === 'enochian') {
    if (dicePanel) dicePanel.style.display = 'none';
    return;
  }
  if (dicePanel) dicePanel.style.display = '';
  const die1 = document.getElementById('die-1');
  const die2 = document.getElementById('die-2');
  const rollBtn = document.getElementById('btn-roll');
  const skipBtn = document.getElementById('btn-skip');

  const isMyTurn = gameState.currentPlayer === myColor;

  function dieFaceHTML(face) {
    const icon = PIECE_ICONS[face] || '?';
    const abbr = PIECE_ABBR[face] || face;
    return `<span class="die-icon">${icon}</span><span class="die-label">${abbr}</span>`;
  }

  if (!gameState.dice) {
    die1.innerHTML = '<span class="die-icon">—</span>'; die2.innerHTML = '<span class="die-icon">—</span>';
    die1.className = 'die'; die2.className = 'die';
    rollBtn.disabled = !isMyTurn || !!gameState.winner;
    skipBtn.style.display = 'none';
  } else {
    die1.innerHTML = dieFaceHTML(gameState.dice[0]);
    die2.innerHTML = dieFaceHTML(gameState.dice[1]);
    die1.className = 'die die-' + gameState.dice[0] + (gameState.diceUsed[0] ? ' used' : ' active');
    die2.className = 'die die-' + gameState.dice[1] + (gameState.diceUsed[1] ? ' used' : ' active');
    rollBtn.disabled = true;
    skipBtn.style.display = isMyTurn && !gameState.winner ? 'block' : 'none';
  }
}

const ENOCHIAN_TEAM_COLORS = { red: 'A', yellow: 'A', green: 'B', black: 'B' };
const ENOCHIAN_TEAM_LABELS = { red: 'Sulphur', yellow: 'Sulphur', green: 'Salt', black: 'Salt' };
function renderPlayers() {
  const el = document.getElementById('game-players');
  const order = (gameType === 'aow' || gameType === 'enochian') ? AOW_PLAYERS : PLAYERS;
  const sorted = [...players].sort((a, b) => order.indexOf(a.color) - order.indexOf(b.color));
  el.innerHTML = sorted.map(p => {
    const isElim = gameState.eliminated.includes(p.color);
    const isFroz = gameState.frozen?.includes(p.color);
    const isCurrent = gameState.currentPlayer === p.color && !gameState.winner;
    const count = countPieces(p.color);
    let teamBadge = '';
    if (gameType === 'enochian') teamBadge = `<span class="team-badge team-${ENOCHIAN_TEAM_COLORS[p.color]}">${ENOCHIAN_TEAM_LABELS[p.color]}</span>`;
    return `
      <div class="player-row ${isElim ? 'eliminated' : ''} ${isFroz ? 'frozen' : ''} ${isCurrent ? 'current' : ''}">
        <span class="dot" style="background:${PLAYER_COLORS[p.color]}"></span>
        <span class="name">${escapeHtml(p.name)}</span>
        ${teamBadge}
        ${p.color === myColor ? '<span class="you-badge">YOU</span>' : ''}
        ${isFroz ? '<span class="frozen-badge">FROZEN</span>' : ''}
        ${!p.connected && p.socket_id !== null ? '<span class="disconnected">DC</span>' : ''}
        <span class="pieces">${count}</span>
      </div>
    `;
  }).join('');
}

function countPieces(color) {
  let n = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = gameState.board[r][c];
      if (!p) continue;
      if (p.color === color) {
        n++;
        if (p.thronePartner && p.thronePartner.color === color) n++;
      }
    }
  return n;
}

// ==================== INTERACTION ====================
function onCellClick(row, col) {
  const noDiceGame = gameType === 'aow' || gameType === 'enochian';
  if (!gameState || gameState.winner || gameState.currentPlayer !== myColor) return;
  if (!noDiceGame && !gameState.dice) return;

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
        if (res.move.promotion) showToast(`Pawn promoted to ${res.move.promotion}!`, 2000);
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
  // Roll-dice with a 3s timeout + one retry. Previously a dropped socket
  // response (reconnect, packet loss) would leave the button hanging.
  let settled = false;
  const attempt = (isRetry) => {
    const timer = setTimeout(() => {
      if (settled) return;
      if (!isRetry) {
        attempt(true);
      } else {
        settled = true;
        haptic('error');
        console.error('roll-dice: no response after retry');
      }
    }, 3000);
    socket.emit('roll-dice', (res) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      if (res && res.error) { haptic('error'); return console.error(res.error); }
      if (res && res.state) {
        gameState = res.state;
        animateDice();
        renderGame();
      }
    });
  };
  attempt(false);
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
  const promoText = move.promotion
    ? ` <span class="promotion">=>${move.promotion}</span>`
    : '';
  div.innerHTML = `
    <span class="turn-num">${move.turn}.</span>
    <span style="color:${PLAYER_COLORS[move.player]}">${playerName(move.player)}</span>
    ${move.piece} ${move.from.notation}-${move.to.notation}${capText}${promoText}
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
  addSystemMessage(`${data.name} joined as ${playerName(data.color)}`);
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
    if (data.move.promotion) addSystemMessage(`${playerName(data.move.player)} pawn promoted to ${data.move.promotion}!`);
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
  addSystemMessage(`${playerName(data.player)} skipped`);
});

socket.on('chat-message', addChatMessage);

socket.on('game-started', (data) => {
  gameState = data.state; players = data.players;
  if (data.gameType) gameType = data.gameType;
  // Track free trial usage
  const isBotGame = players.some(p => p.name?.startsWith('Bot'));
  incrementTrial(gameType === 'enochian' ? 'enochian' : 'classic', isBotGame);
  enterGame();
  addSystemMessage('Game started!');
  haptic('success');
});

socket.on('game-over', (data) => {
  const overlay = document.getElementById('game-over-overlay');
  const text = document.getElementById('winner-text');
  const stats = document.getElementById('winner-stats');
  // Handle team win
  const teamNames = { rg: 'Red & Green', yb: 'Yellow & Black', ry: 'Team Sulphur', gb: 'Team Salt' };
  const winnerLabel = data.winnerTeam
    ? `${teamNames[data.winnerTeam] || data.winnerTeam} Win!`
    : `${playerName(data.winner) || data.winner} Wins!`;
  text.textContent = winnerLabel;
  text.className = data.winnerTeam ? '' : `turn-${data.winner}`;

  // Show placements if available
  const placements = data.placements;
  if (placements) {
    const medals = { gold: '\u{1F947}', silver: '\u{1F948}', bronze: '\u{1F949}', fourth: '4th' };
    let placementHTML = '<div style="margin:12px 0;text-align:left;">';
    for (const [rank, color] of Object.entries(placements)) {
      if (!color) continue;
      const medal = medals[rank] || rank;
      const isMe = color === myColor;
      const highlight = isMe ? 'font-weight:bold;color:#D4AF37;font-size:1.1em;' : '';
      placementHTML += `<div style="padding:4px 0;${highlight}">${medal} ${playerName(color)} — ${rank.toUpperCase()}${isMe ? ' (YOU)' : ''}</div>`;
    }
    placementHTML += '</div>';
    // Show personal placement prominently
    const myRank = Object.entries(placements).find(([_, c]) => c === myColor);
    if (myRank) {
      const [rank] = myRank;
      const medal = medals[rank] || rank;
      text.innerHTML = `<div style="font-size:2em;margin-bottom:4px;">${medal}</div>YOU GOT ${rank.toUpperCase()}!`;
    }
    stats.innerHTML = placementHTML + `<div style="color:#a09880;margin-top:8px;">Game lasted ${gameState.turnNumber} turns with ${moveHistory.length} moves</div>`;
  } else {
    stats.textContent = `Game lasted ${gameState.turnNumber} turns with ${moveHistory.length} moves`;
  }
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
      { type: 'king', row: 7, col: 7 }, { type: 'elephant', row: 6, col: 7 },
      { type: 'horse', row: 5, col: 7 }, { type: 'boat', row: 4, col: 7 },
      { type: 'pawn', row: 7, col: 6 }, { type: 'pawn', row: 6, col: 6 },
      { type: 'pawn', row: 5, col: 6 }, { type: 'pawn', row: 4, col: 6 },
    ],
    green: [
      { type: 'boat', row: 0, col: 4 }, { type: 'horse', row: 0, col: 5 },
      { type: 'elephant', row: 0, col: 6 }, { type: 'king', row: 0, col: 7 },
      { type: 'pawn', row: 1, col: 4 }, { type: 'pawn', row: 1, col: 5 },
      { type: 'pawn', row: 1, col: 6 }, { type: 'pawn', row: 1, col: 7 },
    ],
    black: [
      { type: 'king', row: 0, col: 0 }, { type: 'elephant', row: 1, col: 0 },
      { type: 'horse', row: 2, col: 0 }, { type: 'boat', row: 3, col: 0 },
      { type: 'pawn', row: 0, col: 1 }, { type: 'pawn', row: 1, col: 1 },
      { type: 'pawn', row: 2, col: 1 }, { type: 'pawn', row: 3, col: 1 },
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
  const piece = state.board[m.from_row][m.from_col];
  const captured = state.board[m.to_row][m.to_col];
  state.board[m.to_row][m.to_col] = piece;
  state.board[m.from_row][m.from_col] = null;
  // Handle pawn promotion in replay
  if (piece && piece.type === 'pawn') {
    const promotedType = replayCheckPromotion(state, m.to_row, m.to_col, piece.color);
    if (promotedType) state.board[m.to_row][m.to_col] = { type: promotedType, color: piece.color };
  }
  if (captured && captured.type === 'king') {
    state.eliminated.push(captured.color);
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (state.board[r][c]?.color === captured.color)
          state.board[r][c] = null;
  }
  return { from: { row: m.from_row, col: m.from_col }, to: { row: m.to_row, col: m.to_col } };
}

// Mirror of engine pawn promotion logic for replay
const PAWN_DIRS = { red: [-1,0], yellow: [0,-1], green: [1,0], black: [0,1] };
function replayCheckPromotion(state, row, col, color) {
  const dir = PAWN_DIRS[color];
  if (!dir) return null;
  let atFarEnd = false;
  if (dir[0] === -1 && row === 0) atFarEnd = true;
  if (dir[0] === 1 && row === 7) atFarEnd = true;
  if (dir[1] === -1 && col === 0) atFarEnd = true;
  if (dir[1] === 1 && col === 7) atFarEnd = true;
  if (!atFarEnd) return null;
  for (const type of ['elephant', 'horse', 'boat']) {
    let found = false;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (state.board[r][c]?.color === color && state.board[r][c]?.type === type) found = true;
    if (!found) return type;
  }
  return null;
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
  // Only auto-rejoin if we're already in an active game (lost connection mid-game)
  // On initial page load gameId is null, so we don't auto-redirect to game screen
  if (gameId && myColor) {
    const session = loadSession();
    if (session && session.gameId === gameId) {
      socket.emit('rejoin-game', session, (res) => {
        if (res.error) { clearSession(); return; }
        gameState = res.state;
        players = res.players;
        if (res.gameType) gameType = res.gameType;
        renderGame();
      });
    }
  }
});

function restoreSessionHistory(res) {
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
  if (res.chat) {
    for (const c of res.chat) addChatMessage({ color: c.player_color, name: c.player_name, message: c.message });
  }
}

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

// ---- SESSION BANNER ----
(function initSessionBanner() {
  const session = loadSession();
  const banner = document.getElementById('session-banner');
  if (!banner) return;
  if (session && session.gameId) {
    document.getElementById('session-banner-name').textContent = session.myName;
    document.getElementById('session-banner-code').textContent = session.roomCode || '';
    document.getElementById('session-banner-color').textContent = session.myColor || '';
    banner.style.display = 'flex';
  }
  document.getElementById('btn-rejoin-session')?.addEventListener('click', () => {
    const s = loadSession();
    if (!s) return;
    myName = s.myName;
    socket.emit('rejoin-game', s, (res) => {
      if (res.error) {
        showToast('Game no longer available. Starting fresh.');
        clearSession();
        banner.style.display = 'none';
        return;
      }
      gameId = s.gameId; myColor = s.myColor; myName = s.myName; roomCode = s.roomCode;
      gameState = res.state; players = res.players;
      if (res.gameType) gameType = res.gameType;
      restoreSessionHistory(res);
      enterGame();
    });
  }, { passive: true });
  document.getElementById('btn-new-session')?.addEventListener('click', () => {
    clearSession();
    banner.style.display = 'none';
    document.getElementById('player-name').value = '';
    document.getElementById('player-name').focus();
  }, { passive: true });
})();

// ---- MODE TABS ----
function updateModeUI(mode) {
  const sub = document.querySelector('.subtitle');
  const qRow = document.getElementById('queen-legend-row');
  const aowLegend = document.getElementById('aow-legend-rows');
  const enochianLegend = document.getElementById('enochian-legend-rows');
  const classicLegend = document.getElementById('classic-legend-rows');
  if (sub) {
    if (mode === 'enochian') sub.textContent = 'Enochian Chess — Elemental Team Battle';
    else sub.textContent = 'Free for All (Chaturaji) — Online Multiplayer';
  }
  if (qRow) qRow.style.display = 'none';
  if (aowLegend) aowLegend.style.display = mode === 'aow' ? '' : 'none';
  if (enochianLegend) enochianLegend.style.display = mode === 'enochian' ? '' : 'none';
  if (classicLegend) classicLegend.style.display = (mode === 'enochian') ? 'none' : '';
}
updateModeUI('classic');
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    selectedMode = mode;
    updateModeUI(selectedMode);
  }, { passive: true });
});

// ---- BOARD THEME CUSTOMIZATION ----
function applyBoardTheme(theme) {
  selectedBoard = theme;
  localStorage.setItem('chaturaji_board', theme);
  document.querySelectorAll('.customize-opt[data-board]').forEach(b => b.classList.remove('active'));
  document.querySelector(`.customize-opt[data-board="${theme}"]`)?.classList.add('active');
  const boardEl = document.getElementById('board');
  if (boardEl) boardEl.className = 'board theme-' + theme;
}
document.querySelectorAll('.customize-opt[data-board]').forEach(btn => {
  btn.addEventListener('click', () => applyBoardTheme(btn.dataset.board), { passive: true });
});
// Apply saved theme on load
if (selectedBoard) {
  document.querySelector(`.customize-opt[data-board="${selectedBoard}"]`)?.classList.add('active');
  document.querySelectorAll('.customize-opt[data-board]').forEach(b => {
    if (b.dataset.board !== selectedBoard) b.classList.remove('active');
  });
}

// Enter key on inputs
document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-join').click(); }
});
document.getElementById('player-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('player-name').blur(); }
});

refreshOpenGames();
refreshRecentGames();

// Populate user bar with Google display name
(function initUserBar() {
  const nameEl = document.getElementById('user-display-name');
  if (nameEl && window.currentProfile?.display_name) {
    nameEl.textContent = window.currentProfile.display_name;
  }
})();
