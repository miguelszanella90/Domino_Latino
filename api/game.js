const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const id = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

const ROOM_TTL_SECONDS = 6 * 60 * 60;

function createSet() {
  const tiles = [];

  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) {
      tiles.push([i, j]);
    }
  }

  return tiles.sort(() => Math.random() - 0.5);
}


function createMexicanSet() {
  const tiles = [];
  for (let i = 0; i <= 12; i++) {
    for (let j = i; j <= 12; j++) tiles.push([i, j]);
  }
  return tiles.sort(() => Math.random() - 0.5);
}

function mtHandSize(n) {
  if (n <= 4) return 15;
  if (n <= 6) return 12;
  return 11;
}

function mtPips(hand) {
  return (hand || []).reduce((sum,t) => sum + ((t[0]===0 && t[1]===0) ? 50 : t[0]+t[1]), 0);
}

function mtTrainEnd(g, key) {
  const train = g.mtTrains[key] || [];
  return train.length ? train[train.length-1][1] : g.mtEngine;
}

function mtAllowedTrain(g, playerIndex, key) {
  if (g.mtPendingDouble) return key === g.mtPendingDouble;
  if (key === 'mexican') return true;
  const owner = Number(String(key).replace('p',''));
  return owner === playerIndex || !!g.mtOpen?.[owner];
}

function mtValidMoves(g, playerIndex) {
  const player = g.players[playerIndex];
  if (!player) return [];
  const keys = ['mexican', ...g.players.map((_,i)=>`p${i}`)];
  const moves=[];
  player.hand.forEach((tile,index)=>{
    keys.forEach(key=>{
      if (!mtAllowedTrain(g,playerIndex,key)) return;
      const end=mtTrainEnd(g,key);
      if (tile[0]===end || tile[1]===end) moves.push({index,train:key});
    });
  });
  return moves;
}

function mtPlace(g, playerIndex, tileIndex, trainKey) {
  if (!mtAllowedTrain(g,playerIndex,trainKey)) return false;
  const p=g.players[playerIndex], tile=p?.hand?.[tileIndex];
  if (!tile) return false;
  const end=mtTrainEnd(g,trainKey);
  let placed;
  if (tile[0]===end) placed=[tile[0],tile[1]];
  else if (tile[1]===end) placed=[tile[1],tile[0]];
  else return false;
  p.hand.splice(tileIndex,1);
  g.mtTrains[trainKey].push(placed);
  if (trainKey===`p${playerIndex}`) g.mtOpen[playerIndex]=false;
  g.mtPendingDouble = placed[0]===placed[1] ? trainKey : null;
  return placed;
}

function mtFinishRound(g) {
  g.players.forEach(p=>{ g.individualScores[p.id]=(g.individualScores[p.id]||0)+mtPips(p.hand); });
  g.status = g.mtRoundIndex >= 12 ? 'gameover' : 'finished';
  if (g.status==='gameover') {
    const ordered=g.players.slice().sort((a,b)=>(g.individualScores[a.id]||0)-(g.individualScores[b.id]||0));
    g.message=`Fin de las 13 rondas · gana ${ordered[0]?.name||''} con ${g.individualScores[ordered[0]?.id]||0} puntos`;
  } else g.message=`Ronda ${g.mtRoundIndex+1}/13 terminada · siguiente motor: ${11-g.mtRoundIndex}-${11-g.mtRoundIndex}`;
}

function prepareMexicanRound(g) {
  g.mtRoundIndex = Number.isInteger(g.mtRoundIndex) ? g.mtRoundIndex + 1 : 0;
  if (g.mtRoundIndex>12) { g.status='gameover'; return; }
  g.mtEngine=12-g.mtRoundIndex;
  let set=createMexicanSet();
  const ei=set.findIndex(t=>t[0]===g.mtEngine && t[1]===g.mtEngine);
  if(ei>=0) set.splice(ei,1);
  g.players.forEach(p=>p.hand=[]);
  const handSize=mtHandSize(g.players.length);
  for(let r=0;r<handSize;r++) g.players.forEach(p=>{if(set.length)p.hand.push(set.pop());});
  g.boneyard=set;
  g.board=[];
  g.mtTrains={mexican:[],...Object.fromEntries(g.players.map((_,i)=>[`p${i}`,[]]))};
  g.mtOpen=Object.fromEntries(g.players.map((_,i)=>[i,false]));
  g.mtPendingDouble=null;
  g.mtDrawnThisTurn=false;
  g.mtStuckTurns=0;
  g.turn=0;
  g.status='playing';
  g.round=g.mtRoundIndex+1;
  g.message=`Ronda ${g.round}/13 · motor ${g.mtEngine}-${g.mtEngine}`;
  addHistory(g,`🚂 Ronda ${g.round}: estación ${g.mtEngine}|${g.mtEngine}`);
}

function mtNextTurn(g){
  g.turn=(g.turn+1)%g.players.length;
  g.mtDrawnThisTurn=false;
}

async function save(g) {
  await kv.set(
    `domino:${g.code}`,
    g,
    { ex: ROOM_TTL_SECONDS }
  );

  if (g.roomName) {
    const normalizedName =
      normalizeRoomLookup(g.roomName);

    if (normalizedName) {
      await kv.set(
        `domino-room-name:${normalizedName}`,
        g.code,
        { ex: ROOM_TTL_SECONDS }
      );
    }
  }
}
function normalizeRoomLookup(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function findGameByCodeOrName(value) {
  const raw = String(value || '').trim();

  if (!raw) return null;

  const directCode = raw.toUpperCase();

  const directGame =
    await kv.get(
      `domino:${directCode}`
    );

  if (directGame) {
    return directGame;
  }

  const normalizedName =
    normalizeRoomLookup(raw);

  if (!normalizedName) {
    return null;
  }

  const mappedCode =
    await kv.get(
      `domino-room-name:${normalizedName}`
    );

  if (!mappedCode) {
    return null;
  }

  const mappedGame =
    await kv.get(
      `domino:${mappedCode}`
    );

  if (!mappedGame) {
    await kv.del(
      `domino-room-name:${normalizedName}`
    );

    return null;
  }

  return mappedGame;
}

async function reserveRoomName(
  roomName,
  code
) {
  const normalizedName =
    normalizeRoomLookup(
      roomName
    );

  if (!normalizedName) {
    return true;
  }

  const existingCode =
    await kv.get(
      `domino-room-name:${normalizedName}`
    );

  if (existingCode) {
    const existingNamedGame =
      await kv.get(
        `domino:${existingCode}`
      );

    if (existingNamedGame) {
      return false;
    }

    await kv.del(
      `domino-room-name:${normalizedName}`
    );
  }

  const possibleGameCode =
    String(roomName || '')
      .trim()
      .toUpperCase();

  const existingDirectGame =
    possibleGameCode
      ? await kv.get(
          `domino:${possibleGameCode}`
        )
      : null;

  if (existingDirectGame) {
    return false;
  }

  await kv.set(
    `domino-room-name:${normalizedName}`,
    code,
    { ex: ROOM_TTL_SECONDS }
  );

  return true;
}
function pipTotal(hand = []) {
  return hand.reduce(
    (sum, tile) => sum + tile[0] + tile[1],
    0
  );
}

function teamOf(index) {
  return index % 2 === 0 ? 'A' : 'B';
}

function ensureRotationData(g) {
  g.waiting = Array.isArray(g.waiting) ? g.waiting : [];
  g.individualScores = g.individualScores || {};
  g.participantNames = g.participantNames || {};
  g.rotationCursor = g.rotationCursor || { A: 0, B: 1 };

  g.players.forEach(p => {
    if (!p.isBot) {
      if (g.individualScores[p.id] == null) {
        g.individualScores[p.id] = 0;
      }

      g.participantNames[p.id] = p.name;
    }
  });

  g.waiting.forEach(p => {
    if (g.individualScores[p.id] == null) {
      g.individualScores[p.id] = 0;
    }

    g.participantNames[p.id] = p.name;
  });
}

function awardRotationRound(g, winnerTeam, points) {
  if (g.gameMode !== 'rotation') return;

  ensureRotationData(g);

  g.players.forEach((p, i) => {
    if (!p.isBot && teamOf(i) === winnerTeam) {
      g.individualScores[p.id] =
        (g.individualScores[p.id] || 0) + points;
    }
  });

  g.pendingRotationTeam =
    winnerTeam === 'A'
      ? 'B'
      : 'A';
}

function applyPendingRotation(g) {
  if (
    g.gameMode !== 'rotation' ||
    !g.pendingRotationTeam ||
    !g.waiting?.length
  ) {
    return;
  }

  ensureRotationData(g);

  const loserTeam =
    g.pendingRotationTeam;

  const seats =
    loserTeam === 'A'
      ? [0, 2]
      : [1, 3];

  let seat =
    g.rotationCursor[loserTeam];

  if (!seats.includes(seat)) {
    seat = seats[0];
  }

  const outgoing =
    g.players[seat];

  const incoming =
    g.waiting.shift();

  outgoing.hand = [];
  incoming.hand = [];

  g.players[seat] =
    incoming;

  g.waiting.push(
    outgoing
  );

  g.rotationCursor[loserTeam] =
    seats[0] === seat
      ? seats[1]
      : seats[0];

  addHistory(
    g,
    `🔄 ${outgoing.name} sale de la mesa y entra ${incoming.name}`
  );

  g.pendingRotationTeam =
    null;
}

function addHistory(g, text) {
  if (!g.history) {
    g.history = [];
  }

  g.history.push({
    text,
    time: Date.now()
  });

  if (g.history.length > 40) {
    g.history =
      g.history.slice(-40);
  }
}


/* =========================
   CHAT
========================= */

function addChatMessage(g, player, text) {
  if (!g.chat) {
    g.chat = [];
  }

  const clean =
    String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);

  if (!clean) {
    return false;
  }

  g.chat.push({
    id: `${Date.now()}-${id()}`,
    playerId: player.id,
    name: player.name,
    text: clean,
    time: Date.now()
  });

  if (g.chat.length > 100) {
    g.chat =
      g.chat.slice(-100);
  }

  return true;
}


/* =========================
   WEBRTC SIGNALING
========================= */

function addSignal(
  g,
  fromPlayer,
  toPlayerId,
  signal
) {
  if (!g.signals) {
    g.signals = [];
  }

  const target =
    g.players.find(
      player =>
        player.id === toPlayerId &&
        !player.isBot
    );

  if (
    !target ||
    target.id === fromPlayer.id
  ) {
    return false;
  }

  const allowedTypes = [
    'offer',
    'answer',
    'candidate',
    'hangup'
  ];

  if (
    !signal ||
    !allowedTypes.includes(signal.type)
  ) {
    return false;
  }

  g.signals.push({
    id: `${Date.now()}-${id()}`,
    from: fromPlayer.id,
    fromName: fromPlayer.name,
    to: target.id,
    signal,
    time: Date.now()
  });

  if (g.signals.length > 200) {
    g.signals =
      g.signals.slice(-200);
  }

  return true;
}


function canPlayTile(tile, board) {
  if (!tile) return false;
  if (!board.length) return true;

  const left =
    board[0][0];

  const right =
    board[board.length - 1][1];

  return (
    tile[0] === left ||
    tile[1] === left ||
    tile[0] === right ||
    tile[1] === right
  );
}

function getValidMoves(player, board) {
  if (!board.length) {
    return player.hand.map(
      (tile, index) => ({
        index,
        side: 'right',
        tile
      })
    );
  }

  const left =
    board[0][0];

  const right =
    board[board.length - 1][1];

  const moves = [];

  player.hand.forEach(
    (tile, index) => {

      if (
        tile[0] === left ||
        tile[1] === left
      ) {
        moves.push({
          index,
          side: 'left',
          tile
        });
      }

      if (
        tile[0] === right ||
        tile[1] === right
      ) {
        moves.push({
          index,
          side: 'right',
          tile
        });
      }
    }
  );

  return moves;
}

function hasPlayableTile(player, board) {
  return getValidMoves(
    player,
    board
  ).length > 0;
}

function findOpeningTile(g) {
  let bestDouble = null;

  g.players.forEach(
    (player, playerIndex) => {

      player.hand.forEach(
        (tile, tileIndex) => {

          if (
            tile[0] === tile[1] &&
            (
              !bestDouble ||
              tile[0] > bestDouble.value
            )
          ) {
            bestDouble = {
              playerIndex,
              tileIndex,
              value: tile[0],
              tile
            };
          }
        }
      );
    }
  );

  if (bestDouble) {
    return bestDouble;
  }

  let bestTile = null;

  g.players.forEach(
    (player, playerIndex) => {

      player.hand.forEach(
        (tile, tileIndex) => {

          const total =
            tile[0] + tile[1];

          const high =
            Math.max(
              tile[0],
              tile[1]
            );

          if (
            !bestTile ||
            total > bestTile.total ||
            (
              total === bestTile.total &&
              high > bestTile.high
            )
          ) {
            bestTile = {
              playerIndex,
              tileIndex,
              total,
              high,
              tile
            };
          }
        }
      );
    }
  );

  return bestTile;
}

function nextTurn(g) {
  const step =
    g.turnDirection === 'clockwise'
      ? 1
      : g.players.length - 1;

  g.turn =
    (g.turn + step) %
    g.players.length;

  g.message =
    `Turno de ${g.players[g.turn].name}`;
}

function finishDominoRound(
  g,
  winnerIndex
) {
  const winner =
    g.players[winnerIndex];

  if (g.players.length === 4) {
    const winnerTeam =
      teamOf(winnerIndex);

    const loserTeam =
      winnerTeam === 'A'
        ? 'B'
        : 'A';

    let points = 0;

    g.players.forEach(
      (player, index) => {

        if (
          teamOf(index) ===
          loserTeam
        ) {
          points +=
            pipTotal(
              player.hand
            );
        }
      }
    );

    g.teamScores[winnerTeam] +=
      points;

    awardRotationRound(
      g,
      winnerTeam,
      points
    );

    const done =
      g.gameMode !== 'rotation' &&
      g.teamScores[winnerTeam] >=
      g.target;

    g.status =
      done
        ? 'match_finished'
        : 'finished';

    g.message =
      `¡Dominó! ${winner.name} gana la ronda.`;

    addHistory(
      g,
      `🏆 ${winner.name} hizo dominó. Equipo ${winnerTeam} +${points} puntos`
    );

    return;
  }

  let points = 0;

  g.players.forEach(
    (player, index) => {

      if (index !== winnerIndex) {
        points +=
          pipTotal(
            player.hand
          );
      }
    }
  );

  g.scores[winner.id] =
    (g.scores[winner.id] || 0) +
    points;

  const done =
    g.scores[winner.id] >=
    g.target;

  g.status =
    done
      ? 'match_finished'
      : 'finished';

  g.message =
    `¡Dominó! ${winner.name} gana la ronda.`;

  addHistory(
    g,
    `🏆 ${winner.name} hizo dominó y sumó ${points} puntos`
  );
}

function finishBlockedRound(g) {
  const totals =
    g.players.map(
      player =>
        pipTotal(player.hand)
    );

  if (g.players.length === 4) {
    const totalA =
      totals[0] + totals[2];

    const totalB =
      totals[1] + totals[3];

    if (totalA === totalB) {
      g.status =
        'finished';

      g.message =
        'Cierre empatado.';

      addHistory(
        g,
        '🔒 Cierre empatado. Sin puntos.'
      );

      return;
    }

    const winnerTeam =
      totalA < totalB
        ? 'A'
        : 'B';

    const points =
      winnerTeam === 'A'
        ? totalB
        : totalA;

    g.teamScores[winnerTeam] +=
      points;

    awardRotationRound(
      g,
      winnerTeam,
      points
    );

    const done =
      g.gameMode !== 'rotation' &&
      g.teamScores[winnerTeam] >=
      g.target;

    g.status =
      done
        ? 'match_finished'
        : 'finished';

    g.message =
      `Cierre. Equipo ${winnerTeam} gana.`;

    addHistory(
      g,
      `🔒 Cierre. Equipo ${winnerTeam} +${points} puntos`
    );

    return;
  }

  const minimum =
    Math.min(...totals);

  const winners =
    totals
      .map(
        (total, index) => ({
          total,
          index
        })
      )
      .filter(
        x =>
          x.total === minimum
      );

  if (winners.length !== 1) {
    g.status =
      'finished';

    g.message =
      'Cierre empatado.';

    addHistory(
      g,
      '🔒 Cierre empatado. Sin puntos.'
    );

    return;
  }

  const winnerIndex =
    winners[0].index;

  const winner =
    g.players[winnerIndex];

  const points =
    totals.reduce(
      (sum, total, index) =>
        index === winnerIndex
          ? sum
          : sum + total,
      0
    );

  g.scores[winner.id] =
    (g.scores[winner.id] || 0) +
    points;

  const done =
    g.scores[winner.id] >=
    g.target;

  g.status =
    done
      ? 'match_finished'
      : 'finished';

  g.message =
    `${winner.name} gana el cierre.`;

  addHistory(
    g,
    `🔒 ${winner.name} gana el cierre y suma ${points} puntos`
  );
}
function placeTile(
  g,
  playerIndex,
  tileIndex,
  side
) {
  const player =
    g.players[playerIndex];

  const tile =
    player.hand[tileIndex];

  if (!tile) {
    return false;
  }

  if (!g.board.length) {
    g.board.push([
      tile[0],
      tile[1]
    ]);

    player.hand.splice(
      tileIndex,
      1
    );

    return true;
  }

  const left =
    g.board[0][0];

  const right =
    g.board[
      g.board.length - 1
    ][1];

  if (side === 'left') {
    if (tile[1] === left) {
      g.board.unshift([
        tile[0],
        tile[1]
      ]);
    } else if (
      tile[0] === left
    ) {
      g.board.unshift([
        tile[1],
        tile[0]
      ]);
    } else {
      return false;
    }
  } else {
    if (tile[0] === right) {
      g.board.push([
        tile[0],
        tile[1]
      ]);
    } else if (
      tile[1] === right
    ) {
      g.board.push([
        tile[1],
        tile[0]
      ]);
    } else {
      return false;
    }
  }

  player.hand.splice(
    tileIndex,
    1
  );

  return true;
}

function chooseBotMove(
  g,
  botIndex
) {
  const bot =
    g.players[botIndex];

  const moves =
    getValidMoves(
      bot,
      g.board
    );

  if (!moves.length) {
    return null;
  }

  if (
    g.difficulty === 'easy'
  ) {
    return moves[
      Math.floor(
        Math.random() *
        moves.length
      )
    ];
  }

  const left =
    g.board.length
      ? g.board[0][0]
      : null;

  const right =
    g.board.length
      ? g.board[
          g.board.length - 1
        ][1]
      : null;

  const counts = {};

  bot.hand.forEach(tile => {
    counts[tile[0]] =
      (counts[tile[0]] || 0) + 1;

    counts[tile[1]] =
      (counts[tile[1]] || 0) + 1;
  });

  function exposedValue(move) {
    const [a, b] =
      move.tile;

    if (!g.board.length) {
      return b;
    }

    if (
      move.side === 'left'
    ) {
      return b === left
        ? a
        : b;
    }

    return a === right
      ? b
      : a;
  }

  function moveScore(move) {
    const [a, b] =
      move.tile;

    let score =
      a + b;

    if (a === b) {
      score += 3;
    }

    const exposed =
      exposedValue(move);

    score +=
      (counts[exposed] || 0) *
      2;

    if (
      g.difficulty === 'hard'
    ) {
      score +=
        Math.max(a, b);

      if (
        a === left ||
        b === left ||
        a === right ||
        b === right
      ) {
        score += 2;
      }
    }

    return score;
  }

  return moves
    .slice()
    .sort(
      (a, b) =>
        moveScore(b) -
        moveScore(a)
    )[0];
}

function prepareRound(g) {
  applyPendingRotation(g);

  const set =
    createSet();

  g.players.forEach(
    player => {
      player.hand = [];
    }
  );

  const handSize =
    g.players.length === 2
      ? 7
      : g.players.length === 3
        ? 7
        : 7;

  for (
    let round = 0;
    round < handSize;
    round++
  ) {
    g.players.forEach(
      player => {
        if (set.length) {
          player.hand.push(
            set.pop()
          );
        }
      }
    );
  }

  g.boneyard = set;
  g.board = [];
  g.passCount = 0;
  g.status = 'playing';
  g.round =
    (g.round || 0) + 1;

  const opening =
    findOpeningTile(g);

  if (!opening) {
    g.message =
      'No se pudo determinar quién abre.';
    return;
  }

  g.turn =
    opening.playerIndex;

  const opener =
    g.players[g.turn];

  const openingTile =
    opener.hand[
      opening.tileIndex
    ];

  placeTile(
    g,
    g.turn,
    opening.tileIndex,
    'right'
  );

  const isDouble =
    openingTile[0] ===
    openingTile[1];

  g.message =
    isDouble
      ? `${opener.name} abre con ${openingTile[0]}-${openingTile[1]}`
      : `${opener.name} abre con ${openingTile[0]}-${openingTile[1]}`;

  addHistory(
    g,
    `🎲 ${opener.name} abrió con ${openingTile[0]}|${openingTile[1]}`
  );

  if (
    opener.hand.length === 0
  ) {
    finishDominoRound(
      g,
      g.turn
    );
    return;
  }

  nextTurn(g);
}

function publicGame(
  g,
  playerId
) {
  ensureRotationData(g);

  const me =
    g.players.find(
      p =>
        p.id === playerId
    ) ||
    g.waiting?.find(
      p =>
        p.id === playerId
    );

  const playerIndex =
    g.players.findIndex(
      p =>
        p.id === playerId
    );

  const isWaiting =
    playerIndex === -1 &&
    !!g.waiting?.some(
      p =>
        p.id === playerId
    );

  const humanPlayers =
    g.players
      .filter(
        p => !p.isBot
      )
      .map(p => ({
        id: p.id,
        name: p.name
      }));

  return {
    code: g.code,

    roomName:
      g.roomName ||
      g.code,

    customRoomName:
      !!g.customRoomName,

    hostId:
      g.hostId,

    status:
      g.status,

    message:
      g.message,

    target:
      g.target,

    round:
      g.round,

    turn:
      g.turn,

    turnDirection:
      g.turnDirection,

    difficulty:
      g.difficulty,

    maxPlayers:
      g.maxPlayers,

    botCount:
      g.botCount || 0,

    gameMode:
      g.gameMode ||
      'classic',

    board:
      g.board,

    mexicanTrain: g.gameMode==='mexican' ? {
      engine:g.mtEngine,
      roundIndex:g.mtRoundIndex,
      trains:g.mtTrains,
      open:g.mtOpen,
      pendingDouble:g.mtPendingDouble
    } : null,

    boneyardCount:
      g.boneyard.length,

    players:
      g.players.map(
        (p, index) => ({
          id: p.id,
          name: p.name,
          isBot: p.isBot,
          handCount:
            p.hand.length,
          team:
            g.gameMode!=='mexican' && g.players.length === 4 ? teamOf(index) : null,
          score: g.gameMode==='mexican' ? (g.individualScores?.[p.id]||0) : null,
          trainOpen: g.gameMode==='mexican' ? !!g.mtOpen?.[index] : false
        })
      ),

    myHand:
      me &&
      !isWaiting
        ? me.hand
        : [],

    myIndex:
      playerIndex,

    isWaiting,

    waiting:
      (g.waiting || []).map(
        p => ({
          id: p.id,
          name: p.name
        })
      ),

    waitingCount:
      (g.waiting || [])
        .length,

    scores:
      g.scores,

    teamScores:
      g.teamScores,

    individualScores:
      g.individualScores ||
      {},

    participantNames:
      g.participantNames ||
      {},

    history:
      g.history ||
      [],

    chat:
      g.chat ||
      [],

    humanPlayers,

    signals:
      (g.signals || [])
        .filter(
          signal =>
            signal.to ===
            playerId
        ),

    canStart:
      g.hostId ===
        playerId &&
      (
        g.status ===
          'lobby' ||
        g.status ===
          'finished'
      ),

  isHost:
   g.hostId ===
   playerId,

currentPlayerIsBot:
   !!g.players[g.turn]?.isBot
  };
}

async function runBots(g) {
  let safety = 0;

  while (
    g.status ===
      'playing' &&
    g.players[g.turn]
      ?.isBot &&
    safety < 100
  ) {
    safety++;

    const botIndex =
      g.turn;

    const bot =
      g.players[botIndex];

    let moves =
      getValidMoves(
        bot,
        g.board
      );

    while (
      !moves.length &&
      g.boneyard.length
    ) {
      const drawn =
        g.boneyard.pop();

      bot.hand.push(
        drawn
      );

      addHistory(
        g,
        `🤖 ${bot.name} robó una ficha`
      );

      moves =
        getValidMoves(
          bot,
          g.board
        );
    }

    if (!moves.length) {
      g.passCount++;

      addHistory(
        g,
        `🤖 ${bot.name} pasó`
      );

      if (
        g.passCount >=
        g.players.length
      ) {
        finishBlockedRound(g);
        break;
      }

      nextTurn(g);
      continue;
    }

    g.passCount = 0;

    const move =
      chooseBotMove(
        g,
        botIndex
      );

    if (!move) {
      nextTurn(g);
      continue;
    }

    const playedTile =
      bot.hand[
        move.index
      ].slice();

    const placed =
      placeTile(
        g,
        botIndex,
        move.index,
        move.side
      );

    if (!placed) {
      nextTurn(g);
      continue;
    }

    addHistory(
      g,
      `🤖 ${bot.name} jugó ${playedTile[0]}|${playedTile[1]} ${move.side === 'left' ? '←' : '→'}`
    );

    if (
      bot.hand.length === 0
    ) {
      finishDominoRound(
        g,
        botIndex
      );
      break;
    }

    nextTurn(g);
  }
}
module.exports = async (req, res) => {
  try {
    const b =
      req.body || {};

    const action =
      b.action;

    /* =========================
       WEBRTC / TURN CONFIG
    ========================= */

    if (
      req.method === 'POST' &&
      action === 'rtcConfig'
    ) {
      const username =
        process.env.METERED_TURN_USERNAME;

      const credential =
        process.env.METERED_TURN_CREDENTIAL;

      if (
        !username ||
        !credential
      ) {
        return res
          .status(503)
          .json({
            error:
              'TURN no está configurado'
          });
      }

      return res.json({
        iceServers: [
          {
            urls:
              'stun:stun.relay.metered.ca:80'
          },
          {
            urls:
              'turn:global.relay.metered.ca:80',
            username,
            credential
          },
          {
            urls:
              'turn:global.relay.metered.ca:80?transport=tcp',
            username,
            credential
          },
          {
            urls:
              'turn:global.relay.metered.ca:443',
            username,
            credential
          },
          {
            urls:
              'turns:global.relay.metered.ca:443?transport=tcp',
            username,
            credential
          }
        ]
      });
    }


    /* =========================
       GET GAME
    ========================= */

    if (
      req.method === 'GET'
    ) {
      const code =
        String(
          req.query.code ||
          ''
        )
          .trim()
          .toUpperCase();

      const playerId =
        String(
          req.query.playerId ||
          ''
        ).trim();

      if (!code) {
        return res
          .status(400)
          .json({
            error:
              'Falta el código de la sala'
          });
      }

     const g =
      await findGameByCodeOrName(
        req.query.code
      );

      if (!g) {
        return res
          .status(404)
          .json({
            error:
              'Sala no encontrada'
          });
      }

      return res.json(
        publicGame(
          g,
          playerId
        )
      );
    }


    /* =========================
       CREATE ROOM
    ========================= */

    if (
      action === 'create'
    ) {
      const code =
        id();

      const pid =
        id();

      const requestedName =
        String(
          b.roomName ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40);

      const useAutomaticName =
        b.autoRoomName !== false ||
        !requestedName;

      const roomName =
        useAutomaticName
          ? code
          : requestedName;

      const gameMode =
        b.gameMode === 'rotation' ? 'rotation' :
        b.gameMode === 'mexican' ? 'mexican' : 'classic';

      const requestedPlayers =
        Number(
          b.maxPlayers
        ) || 4;

      const maxPlayers =
        gameMode === 'rotation' ? 4 :
        gameMode === 'mexican' ? Math.max(2,Math.min(8,requestedPlayers)) :
        Math.max(2,Math.min(4,requestedPlayers));

      const requestedBots =
        Number(
          b.botCount
        ) || 0;

      const botCount =
        gameMode === 'rotation' ? 0 :
        Math.max(0,Math.min(maxPlayers-1,requestedBots));

      const difficulty =
        [
          'easy',
          'normal',
          'hard'
        ].includes(
          b.difficulty
        )
          ? b.difficulty
          : 'normal';

      const target =
        Math.max(
          25,
          Number(
            b.target
          ) || 100
        );

      const playerName =
        String(
          b.name ||
          'Jugador'
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 30) ||
        'Jugador';

      const g = {
        code,

        roomName,

        customRoomName:
          !useAutomaticName,

        hostId:
          pid,

        status:
          'lobby',

        gameMode,

        maxPlayers,

        botCount,

        difficulty,

        target,

        turnDirection:
          'clockwise',

        players: [
          {
            id: pid,
            name:
              playerName,
            hand: [],
            isBot:
              false
          }
        ],

        waiting: [],

        board: [],

        boneyard: [],

        turn: 0,

        passCount: 0,

        round: 0,

        message:
          gameMode ===
          'rotation'
            ? 'Sala rotativa creada'
            : 'Sala creada',

        scores: {
          [pid]: 0
        },

        teamScores: {
          A: 0,
          B: 0
        },

        individualScores: {
          [pid]: 0
        },

        participantNames: {
          [pid]:
            playerName
        },

        rotationCursor: {
          A: 0,
          B: 1
        },

        pendingRotationTeam:
          null,

        mtRoundIndex: -1,
        mtEngine: 12,
        mtTrains: null,
        mtOpen: null,
        mtPendingDouble: null,
        mtDrawnThisTurn: false,

        history: [],

        chat: [],

        signals: []
      };
      if (roomName) {
  const roomNameAvailable =
    await reserveRoomName(
      roomName,
      code
    );

  if (!roomNameAvailable) {
    return res
      .status(409)
      .json({
        error:
          'Ese nombre de sala ya está en uso. Elige otro.'
      });
  }
}
      await save(g);

      return res.json({
        game:
          publicGame(
            g,
            pid
          ),

        playerId:
          pid
      });
    }


    /* =========================
       FROM HERE ROOM REQUIRED
    ========================= */

    const code =
      String(
        b.code ||
        ''
      )
        .trim()
        .toUpperCase();

    if (!code) {
      return res
        .status(400)
        .json({
          error:
            'Falta el código de la sala'
        });
    }

    const g =
      await findGameByCodeOrName(
      b.code
    );

    if (!g) {
      return res
        .status(404)
        .json({
          error:
            'Sala no encontrada'
        });
    }

    ensureRotationData(g);


    /* =========================
       JOIN ROOM
    ========================= */

    if (
      action === 'join'
    ) {
      const pid =
        id();

      const playerName =
        String(
          b.name ||
          'Jugador'
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 30) ||
        'Jugador';

      const player = {
        id: pid,

        name:
          playerName,

        hand: [],

        isBot:
          false
      };

      const humanCount =
        g.players.filter(
          p => !p.isBot
        ).length;

      const humanSlots =
        g.maxPlayers -
        (g.botCount || 0);

      if (g.gameMode === 'mexican') {
        while (g.players.length < g.maxPlayers) {
          const botNumber=g.players.filter(p=>p.isBot).length+1;
          g.players.push({id:`BOT_${id()}`,name:`Bot ${botNumber}`,hand:[],isBot:true});
        }
        g.players.forEach(p=>{ if(g.individualScores[p.id]==null) g.individualScores[p.id]=0; });
        prepareMexicanRound(g);
        await save(g);
        return res.json(publicGame(g,b.playerId));
      }

      if (
        g.gameMode ===
        'rotation'
      ) {
        if (
          humanCount < 4 &&
          g.status === 'lobby'
        ) {
          g.players.push(
            player
          );

          g.message =
            `${player.name} se unió a la mesa`;
        } else {
          g.waiting.push(
            player
          );

          g.message =
            `${player.name} entró en la cola`;
        }

        g.individualScores[
          pid
        ] = 0;

        g.participantNames[
          pid
        ] =
          playerName;

      } else {
        if (
          g.status !==
          'lobby'
        ) {
          return res
            .status(400)
            .json({
              error:
                'La partida ya comenzó'
            });
        }

        if (
          humanCount >=
          humanSlots
        ) {
          return res
            .status(400)
            .json({
              error:
                'La sala está llena'
            });
        }

        g.players.push(
          player
        );

        g.scores[pid] = 0;

        g.individualScores[
          pid
        ] = 0;

        g.participantNames[
          pid
        ] =
          playerName;

        g.message =
          `${player.name} se unió a la sala`;
      }

      addHistory(
        g,
        `👋 ${player.name} entró a la sala`
      );

      await save(g);

      return res.json({
        game:
          publicGame(
            g,
            pid
          ),

        playerId:
          pid
      });
    }


    /* =========================
       CHAT
    ========================= */

    if (
      action === 'chat'
    ) {
      const player =
        g.players.find(
          p =>
            p.id ===
            b.playerId
        ) ||
        g.waiting.find(
          p =>
            p.id ===
            b.playerId
        );

      if (!player) {
        return res
          .status(403)
          .json({
            error:
              'Jugador no válido'
          });
      }

      const added =
        addChatMessage(
          g,
          player,
          b.text
        );

      if (!added) {
        return res
          .status(400)
          .json({
            error:
              'Mensaje vacío'
          });
      }

      await save(g);

      return res.json(
        publicGame(
          g,
          b.playerId
        )
      );
    }


    /* =========================
       WEBRTC SIGNAL
    ========================= */

    if (
      action === 'signal'
    ) {
      const player =
        g.players.find(
          p =>
            p.id ===
              b.playerId &&
            !p.isBot
        );

      if (!player) {
        return res
          .status(403)
          .json({
            error:
              'Jugador no válido'
          });
      }

      const added =
        addSignal(
          g,
          player,
          b.toPlayerId,
          b.signal
        );

      if (!added) {
        return res
          .status(400)
          .json({
            error:
              'Señal no válida'
          });
      }

      await save(g);

      return res.json({
        ok: true
      });
    }


    /* =========================
       ACK WEBRTC SIGNALS
    ========================= */

    if (
      action ===
      'ackSignals'
    ) {
      const player =
        g.players.find(
          p =>
            p.id ===
              b.playerId &&
            !p.isBot
        );

      if (!player) {
        return res
          .status(403)
          .json({
            error:
              'Jugador no válido'
          });
      }

      const ids =
        Array.isArray(
          b.signalIds
        )
          ? b.signalIds
          : [];

      const idSet =
        new Set(ids);

      g.signals =
        (g.signals || [])
          .filter(
            signal =>
              !(
                signal.to ===
                  b.playerId &&
                idSet.has(
                  signal.id
                )
              )
          );

      await save(g);

      return res.json({
        ok: true
      });
    }


    /* =========================
       START GAME
    ========================= */

    if (
      action === 'start'
    ) {
      if (
        b.playerId !==
        g.hostId
      ) {
        return res
          .status(403)
          .json({
            error:
              'Solo el anfitrión puede iniciar'
          });
      }

      if (
        g.status !==
        'lobby'
      ) {
        return res
          .status(400)
          .json({
            error:
              'La partida ya comenzó'
          });
      }

      if (
        g.gameMode ===
        'rotation'
      ) {
        if (
          g.players.length < 4
        ) {
          return res
            .status(400)
            .json({
              error:
                'La mesa rotativa necesita 4 jugadores para comenzar'
            });
        }

        g.players =
          g.players.slice(
            0,
            4
          );

      } else {
        while (
          g.players.length <
          g.maxPlayers
        ) {
          const botNumber =
            g.players.filter(
              p => p.isBot
            ).length + 1;

          g.players.push({
            id:
              `BOT_${id()}`,

            name:
              `Bot ${botNumber}`,

            hand: [],

            isBot:
              true
          });
        }
      }

      g.players.forEach(
        p => {
          if (
            !p.isBot &&
            g.scores[p.id] ==
              null
          ) {
            g.scores[p.id] =
              0;
          }
        }
      );

      if (g.gameMode==='mexican') prepareMexicanRound(g);
      else prepareRound(g);

      // Los bots avanzan uno por uno desde el frontend.

      await save(g);

      return res.json(
        publicGame(
          g,
          b.playerId
        )
      );
    }


    /* =========================
       NEW ROUND
    ========================= */

    if (
      action ===
      'newRound'
    ) {
      if (
        b.playerId !==
        g.hostId
      ) {
        return res
          .status(403)
          .json({
            error:
              'Solo el anfitrión puede iniciar otra ronda'
          });
      }

      if (
        g.status !==
        'finished'
      ) {
        return res
          .status(400)
          .json({
            error:
              'La ronda actual no ha terminado'
          });
      }

      if (g.gameMode==='mexican') prepareMexicanRound(g);
      else prepareRound(g);

      // Los bots avanzan uno por uno desde el frontend.

      await save(g);

      return res.json(
        publicGame(
          g,
          b.playerId
        )
      );
    }
/* =========================
   BOT STEP
   Ejecuta una sola jugada de bot
========================= */

if (
  action === 'botStep'
) {
  if (
    b.playerId !==
    g.hostId
  ) {
    return res
      .status(403)
      .json({
        error:
          'Solo el anfitrión puede avanzar los bots'
      });
  }

  if (
    g.status !==
    'playing'
  ) {
    return res
      .status(400)
      .json({
        error:
          'La partida no está activa'
      });
  }

  const botIndex =
    g.turn;

  const bot =
    g.players[botIndex];

  if (
    !bot ||
    !bot.isBot
  ) {
    return res.json(
      publicGame(
        g,
        b.playerId
      )
    );
  }

  if (g.gameMode==='mexican') {
    let moves=mtValidMoves(g,botIndex);
    if(!moves.length && g.boneyard.length){
      bot.hand.push(g.boneyard.pop());
      addHistory(g,`🤖 ${bot.name} robó una ficha`);
      moves=mtValidMoves(g,botIndex);
    }
    if(!moves.length){
      g.mtOpen[botIndex]=true;
      g.mtStuckTurns=(g.mtStuckTurns||0)+1;
      addHistory(g,`🚂 ${bot.name} abrió su tren y pasó`);
      if(!g.boneyard.length && g.mtStuckTurns>=g.players.length) mtFinishRound(g); else mtNextTurn(g);
      await save(g); return res.json(publicGame(g,b.playerId));
    }
    g.mtStuckTurns=0;
    const move=moves[0], tile=bot.hand[move.index].slice();
    const placed=mtPlace(g,botIndex,move.index,move.train);
    addHistory(g,`🤖 ${bot.name} jugó ${tile[0]}|${tile[1]} en ${move.train==='mexican'?'Tren Mexicano':'un tren personal'}`);
    if(!bot.hand.length) mtFinishRound(g);
    else if(!g.mtPendingDouble) mtNextTurn(g);
    await save(g); return res.json(publicGame(g,b.playerId));
  }

  let moves =
    getValidMoves(
      bot,
      g.board
    );

  while (
    !moves.length &&
    g.boneyard.length
  ) {
    const drawn =
      g.boneyard.pop();

    bot.hand.push(
      drawn
    );

    addHistory(
      g,
      `🤖 ${bot.name} robó una ficha`
    );

    moves =
      getValidMoves(
        bot,
        g.board
      );
  }

  if (!moves.length) {
    g.passCount =
      (g.passCount || 0) + 1;

    addHistory(
      g,
      `🤖 ${bot.name} pasó`
    );

    if (
      g.passCount >=
      g.players.length
    ) {
      finishBlockedRound(g);
    } else {
      nextTurn(g);
    }

    await save(g);

    return res.json(
      publicGame(
        g,
        b.playerId
      )
    );
  }

  g.passCount = 0;

  const move =
    chooseBotMove(
      g,
      botIndex
    );

  if (!move) {
    nextTurn(g);

    await save(g);

    return res.json(
      publicGame(
        g,
        b.playerId
      )
    );
  }

  const playedTile =
    bot.hand[
      move.index
    ].slice();

  const placed =
    placeTile(
      g,
      botIndex,
      move.index,
      move.side
    );

  if (!placed) {
    nextTurn(g);

    await save(g);

    return res.json(
      publicGame(
        g,
        b.playerId
      )
    );
  }

  addHistory(
    g,
    `🤖 ${bot.name} jugó ${playedTile[0]}|${playedTile[1]} ${move.side === 'left' ? '←' : '→'}`
  );

  if (
    bot.hand.length === 0
  ) {
    finishDominoRound(
      g,
      botIndex
    );
  } else {
    nextTurn(g);
  }

  await save(g);

  return res.json(
    publicGame(
      g,
      b.playerId
    )
  );
}

    /* =========================
       PLAYER VALIDATION
    ========================= */

    const playerIndex =
      g.players.findIndex(
        p =>
          p.id ===
          b.playerId
      );

    if (
      playerIndex < 0
    ) {
      return res
        .status(403)
        .json({
          error:
            'Jugador no válido'
        });
    }

    if (
      g.status !==
      'playing'
    ) {
      return res
        .status(400)
        .json({
          error:
            'La partida no está activa'
        });
    }

    if (
      playerIndex !==
      g.turn
    ) {
      return res
        .status(400)
        .json({
          error:
            'No es tu turno'
        });
    }

    const player =
      g.players[
        playerIndex
      ];


    /* =========================
       MEXICAN TRAIN ACTIONS
    ========================= */
    if (g.gameMode==='mexican') {
      if(action==='mtPlay'){
        const tileIndex=Number(b.tileIndex), train=String(b.train||'');
        if(!Number.isInteger(tileIndex)||tileIndex<0||tileIndex>=player.hand.length) return res.status(400).json({error:'Ficha no válida'});
        const valid=mtValidMoves(g,playerIndex).some(m=>m.index===tileIndex&&m.train===train);
        if(!valid) return res.status(400).json({error:'Esa ficha no se puede jugar en ese tren'});
        const tile=player.hand[tileIndex].slice();
        mtPlace(g,playerIndex,tileIndex,train); g.mtStuckTurns=0;
        addHistory(g,`🚂 ${player.name} jugó ${tile[0]}|${tile[1]} en ${train==='mexican'?'Tren Mexicano':train===`p${playerIndex}`?'su tren':'un tren abierto'}`);
        if(!player.hand.length) mtFinishRound(g); else if(!g.mtPendingDouble) mtNextTurn(g);
        await save(g); return res.json(publicGame(g,b.playerId));
      }
      if(action==='draw'){
        if(mtValidMoves(g,playerIndex).length) return res.status(400).json({error:'Tienes una ficha que puedes jugar'});
        if(g.mtDrawnThisTurn) return res.status(400).json({error:'Ya robaste una ficha este turno'});
        if(!g.boneyard.length) return res.status(400).json({error:'No quedan fichas en el pozo'});
        player.hand.push(g.boneyard.pop()); g.mtDrawnThisTurn=true;
        addHistory(g,`🎲 ${player.name} robó una ficha`);
        g.message=mtValidMoves(g,playerIndex).length?`${player.name} robó y puede jugar`:`${player.name} robó y no puede jugar`;
        await save(g); return res.json(publicGame(g,b.playerId));
      }
      if(action==='pass'){
        if(mtValidMoves(g,playerIndex).length) return res.status(400).json({error:'Tienes una ficha que puedes jugar'});
        if(g.boneyard.length && !g.mtDrawnThisTurn) return res.status(400).json({error:'Primero debes robar del pozo'});
        g.mtOpen[playerIndex]=true; g.mtPendingDouble=null; g.mtStuckTurns=(g.mtStuckTurns||0)+1;
        addHistory(g,`🚂 ${player.name} abrió su tren y pasó`);
        if(!g.boneyard.length && g.mtStuckTurns>=g.players.length) mtFinishRound(g); else mtNextTurn(g);
        await save(g); return res.json(publicGame(g,b.playerId));
      }
      if(action==='play') return res.status(400).json({error:'Selecciona un tren para colocar la ficha'});
    }

    /* =========================
       DRAW
    ========================= */

    if (
      action === 'draw'
    ) {
      if (
        hasPlayableTile(
          player,
          g.board
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'Tienes una ficha que puedes jugar'
          });
      }

      if (
        !g.boneyard.length
      ) {
        return res
          .status(400)
          .json({
            error:
              'No quedan fichas para robar'
          });
      }

      const tile =
        g.boneyard.pop();

      player.hand.push(
        tile
      );

      g.passCount = 0;

      addHistory(
        g,
        `🎲 ${player.name} robó una ficha`
      );

      g.message =
        `${player.name} robó una ficha`;

      await save(g);

      return res.json(
        publicGame(
          g,
          b.playerId
        )
      );
    }
        /* =========================
       PASS
    ========================= */

    if (
      action === 'pass'
    ) {
      if (
        hasPlayableTile(
          player,
          g.board
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'Tienes una ficha que puedes jugar'
          });
      }

      if (
        g.boneyard.length
      ) {
        return res
          .status(400)
          .json({
            error:
              'Todavía puedes robar del pozo'
          });
      }

      g.passCount =
        (g.passCount || 0) + 1;

      addHistory(
        g,
        `⏭️ ${player.name} pasó`
      );

      if (
        g.passCount >=
        g.players.length
      ) {
        finishBlockedRound(g);

        await save(g);

        return res.json(
          publicGame(
            g,
            b.playerId
          )
        );
      }

      nextTurn(g);

      // Los bots avanzan uno por uno desde el frontend.

      await save(g);

      return res.json(
        publicGame(
          g,
          b.playerId
        )
      );
    }


    /* =========================
       PLAY
    ========================= */

    if (
      action === 'play'
    ) {
      const tileIndex =
        Number(
          b.tileIndex
        );

      const side =
        b.side === 'left'
          ? 'left'
          : b.side === 'right'
            ? 'right'
            : null;

      if (
        !Number.isInteger(
          tileIndex
        ) ||
        tileIndex < 0 ||
        tileIndex >=
          player.hand.length
      ) {
        return res
          .status(400)
          .json({
            error:
              'Ficha no válida'
          });
      }

      if (!side) {
        return res
          .status(400)
          .json({
            error:
              'Debes indicar izquierda o derecha'
          });
      }

      const tile =
        player.hand[
          tileIndex
        ].slice();

      const validMoves =
        getValidMoves(
          player,
          g.board
        );

      const valid =
        validMoves.some(
          move =>
            move.index ===
              tileIndex &&
            move.side ===
              side
        );

      if (!valid) {
        return res
          .status(400)
          .json({
            error:
              'Esa ficha no se puede jugar en ese lado'
          });
      }

      const placed =
        placeTile(
          g,
          playerIndex,
          tileIndex,
          side
        );

      if (!placed) {
        return res
          .status(400)
          .json({
            error:
              'No se pudo colocar la ficha'
          });
      }

      g.passCount = 0;

      addHistory(
        g,
        `🁣 ${player.name} jugó ${tile[0]}|${tile[1]} ${side === 'left' ? '←' : '→'}`
      );

      if (
        player.hand.length === 0
      ) {
        finishDominoRound(
          g,
          playerIndex
        );

        await save(g);

        return res.json(
          publicGame(
            g,
            b.playerId
          )
        );
      }

      nextTurn(g);

      // Los bots avanzan uno por uno desde el frontend.

      await save(g);

      return res.json(
        publicGame(
          g,
          b.playerId
        )
      );
    }


    /* =========================
       UNKNOWN ACTION
    ========================= */

    return res
      .status(400)
      .json({
        error:
          'Acción no válida'
      });

  } catch (error) {
    console.error(
      'DOMINO API ERROR:',
      error
    );

    return res
      .status(500)
      .json({
        error:
          error?.message ||
          'Error interno del servidor'
      });
  }
};
