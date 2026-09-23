const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const id = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

function createSet() {
  const tiles = [];

  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) {
      tiles.push([i, j]);
    }
  }

  return tiles.sort(() => Math.random() - 0.5);
}

async function save(g) {
  await kv.set(
    `domino:${g.code}`,
    g,
    { ex: 86400 }
  );
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

    const done =
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

    const done =
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

  const left =
    g.board[0][0];

  const right =
    g.board[
      g.board.length - 1
    ][1];

  let placed;

  if (side === 'left') {
    if (tile[1] === left) {
      placed = tile;
    } else {
      placed = [
        tile[1],
        tile[0]
      ];
    }

    g.board.unshift(placed);

  } else {
    if (tile[0] === right) {
      placed = tile;
    } else {
      placed = [
        tile[1],
        tile[0]
      ];
    }

    g.board.push(placed);
  }

  player.hand.splice(
    tileIndex,
    1
  );

  g.consecutivePasses = 0;

  return placed;
}

function chooseBotMove(
  g,
  playerIndex
) {
  const player =
    g.players[playerIndex];

  const moves =
    getValidMoves(
      player,
      g.board
    );

  if (!moves.length) {
    return null;
  }

  if (
    g.botDifficulty ===
    'easy'
  ) {
    return moves[
      Math.floor(
        Math.random() *
        moves.length
      )
    ];
  }

  if (
    g.botDifficulty ===
    'normal'
  ) {
    return moves
      .sort(
        (a, b) =>
          (
            b.tile[0] +
            b.tile[1]
          ) -
          (
            a.tile[0] +
            a.tile[1]
          )
      )[0];
  }

  const frequencies = {};

  player.hand.forEach(
    tile => {

      frequencies[tile[0]] =
        (
          frequencies[tile[0]] ||
          0
        ) + 1;

      frequencies[tile[1]] =
        (
          frequencies[tile[1]] ||
          0
        ) + 1;
    }
  );

  function moveScore(move) {
    const tile =
      move.tile;

    let value =
      (
        tile[0] +
        tile[1]
      ) * 3;

    if (
      tile[0] ===
      tile[1]
    ) {
      value += 5;
    }

    value +=
      (
        frequencies[tile[0]] ||
        0
      ) +
      (
        frequencies[tile[1]] ||
        0
      );

    return value;
  }

  return moves
    .sort(
      (a, b) =>
        moveScore(b) -
        moveScore(a)
    )[0];
}

function prepareRound(g) {
  const tiles =
    createSet();

  g.players.forEach(
    player => {
      player.hand = [];
    }
  );

  g.board = [];
  g.boneyard = tiles;
  g.consecutivePasses = 0;
  g.history = [];

  g.roundNumber =
    (g.roundNumber || 0) + 1;

  g.players.forEach(
    player => {
      player.hand =
        g.boneyard.splice(
          0,
          7
        );
    }
  );

  const opening =
    findOpeningTile(g);

  const starter =
    opening.playerIndex;

  const openingTile =
    g.players[starter]
      .hand.splice(
        opening.tileIndex,
        1
      )[0];

  g.board.push(
    openingTile
  );

  g.turn =
    (starter + 1) %
    g.players.length;

  g.status =
    'playing';

  g.message =
    `${g.players[starter].name} abre con ${openingTile[0]}-${openingTile[1]}`;

  addHistory(
    g,
    `🎲 ${g.players[starter].name} abrió con ${openingTile[0]}|${openingTile[1]}`
  );
}

function publicGame(
  g,
  playerId
) {
  const myIndex =
    g.players.findIndex(
      player =>
        player.id === playerId
    );

  const me =
    myIndex >= 0
      ? g.players[myIndex]
      : null;

  return {
    code:
      g.code,

    maxPlayers:
      g.maxPlayers,

    botCount:
      g.botCount || 0,

    botDifficulty:
      g.botDifficulty ||
      'normal',

    humanSlots:
      g.maxPlayers -
      (g.botCount || 0),

    target:
      g.target,

    board:
      g.board,

    boneyardCount:
      g.boneyard.length,

    turn:
      g.turn,

    status:
      g.status,

    message:
      g.message,

    roundNumber:
      g.roundNumber || 0,

    history:
      g.history || [],

    chat:
      g.chat || [],

    signals:
      (g.signals || []).filter(
        signal =>
          signal.to === playerId
      ),

    myIndex,

    myHand:
      me
        ? me.hand
        : [],

    isHost:
      g.host === playerId,

    currentPlayerIsBot:
      !!g.players[g.turn]?.isBot,

    players:
      g.players.map(
        (player, index) => ({
          id:
            player.isBot
              ? null
              : player.id,

          name:
            player.name,

          handCount:
            player.hand.length,

          isBot:
            !!player.isBot,

          team:
            g.players.length === 4
              ? teamOf(index)
              : null,

          score:
            g.players.length === 4
              ? null
              : g.scores[player.id] || 0,

          isMe:
            player.id === playerId
        })
      ),

    teamScores:
      g.players.length === 4
        ? g.teamScores
        : null
  };
}


module.exports =
async (req, res) => {
  try {
    const b =
      req.body || {};

    const action =
      b.action;

    if (
      req.method ===
      'GET'
    ) {
      const g =
        await kv.get(
          `domino:${req.query.code}`
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
          req.query.playerId
        )
      );
    }

    if (
      action ===
      'create'
    ) {
      const code =
        id();

      const pid =
        id();

      const maxPlayers =
        Math.min(
          4,
          Math.max(
            2,
            Number(
              b.maxPlayers
            ) || 4
          )
        );

      const botCount =
        Math.min(
          maxPlayers - 1,
          Math.max(
            0,
            Number(
              b.botCount
            ) || 0
          )
        );

      const difficulty =
        [
          'easy',
          'normal',
          'hard'
        ].includes(
          b.botDifficulty
        )
          ? b.botDifficulty
          : 'normal';

      const g = {
        code,
        host: pid,

        maxPlayers,
        botCount,

        botDifficulty:
          difficulty,

        target:
          Number(b.target) ||
          100,

        turnDirection:
          'clockwise',

        players: [
          {
            id: pid,

            name:
              (
                b.name ||
                ''
              ).trim() ||
              'Jugador 1',

            hand: [],

            isBot:
              false
          }
        ],

        board: [],

        boneyard:
          createSet(),

        scores: {},

        teamScores: {
          A: 0,
          B: 0
        },

        turn: 0,

        status:
          'lobby',

        message:
          'Sala creada',

        history: [],

        chat: [],

        signals: [],

        consecutivePasses: 0,

        roundNumber: 0
      };

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

    const g =
      await kv.get(
        `domino:${b.code}`
      );

    if (!g) {
      return res
        .status(404)
        .json({
          error:
            'Sala no encontrada'
        });
    }


    /* =========================
       CHAT
    ========================= */

    if (
      action ===
      'chat'
    ) {
      const sender =
        g.players.find(
          player =>
            player.id === b.playerId &&
            !player.isBot
        );

      if (!sender) {
        return res
          .status(403)
          .json({
            error:
              'Jugador inválido'
          });
      }

      const ok =
        addChatMessage(
          g,
          sender,
          b.text
        );

      if (!ok) {
        return res
          .status(400)
          .json({
            error:
              'El mensaje está vacío'
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
      action ===
      'signal'
    ) {
      const sender =
        g.players.find(
          player =>
            player.id === b.playerId &&
            !player.isBot
        );

      if (!sender) {
        return res
          .status(403)
          .json({
            error:
              'Jugador inválido'
          });
      }

      const ok =
        addSignal(
          g,
          sender,
          b.to,
          b.signal
        );

      if (!ok) {
        return res
          .status(400)
          .json({
            error:
              'Señal de cámara inválida'
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
       ACK WEBRTC SIGNALS
    ========================= */

    if (
      action ===
      'ackSignals'
    ) {
      const sender =
        g.players.find(
          player =>
            player.id === b.playerId &&
            !player.isBot
        );

      if (!sender) {
        return res
          .status(403)
          .json({
            error:
              'Jugador inválido'
          });
      }

      const ids =
        Array.isArray(b.signalIds)
          ? new Set(
              b.signalIds
                .map(String)
                .slice(0, 100)
            )
          : new Set();

      g.signals =
        (g.signals || []).filter(
          signal =>
            !(
              signal.to ===
                b.playerId &&
              ids.has(
                String(signal.id)
              )
            )
        );

      await save(g);

      return res.json(
        publicGame(
          g,
          b.playerId
        )
      );
    }


    /* =========================
       JOIN
    ========================= */

    if (
      action ===
      'join'
    ) {
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

      const humanSlots =
        g.maxPlayers -
        (g.botCount || 0);

      const humanPlayers =
        g.players.filter(
          player =>
            !player.isBot
        ).length;

      if (
        humanPlayers >=
        humanSlots
      ) {
        return res
          .status(400)
          .json({
            error:
              'Todos los puestos humanos están ocupados'
          });
      }

      const pid =
        id();

      g.players.push({
        id: pid,

        name:
          (
            b.name ||
            ''
          ).trim() ||
          `Jugador ${g.players.length + 1}`,

        hand: [],

        isBot:
          false
      });

      g.message =
        `${humanPlayers + 1}/${humanSlots} jugadores humanos conectados`;

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
       START
    ========================= */

    if (
      action ===
      'start'
    ) {
      if (
        b.playerId !==
        g.host
      ) {
        return res
          .status(403)
          .json({
            error:
              'Solo el host puede iniciar'
          });
      }

      const humanSlots =
        g.maxPlayers -
        (g.botCount || 0);

      const humanPlayers =
        g.players.filter(
          player =>
            !player.isBot
        ).length;

      if (
        humanPlayers !==
        humanSlots
      ) {
        return res
          .status(400)
          .json({
            error:
              `Faltan jugadores humanos. ${humanPlayers}/${humanSlots} conectados.`
          });
      }

      while (
        g.players.length <
        g.maxPlayers
      ) {
        const botNumber =
          g.players.filter(
            player =>
              player.isBot
          ).length + 1;

        g.players.push({
          id:
            `BOT-${id()}`,

          name:
            `Bot ${botNumber}`,

          hand: [],

          isBot:
            true
        });
      }

      prepareRound(g);

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
        g.host
      ) {
        return res
          .status(403)
          .json({
            error:
              'Solo el host puede iniciar una nueva ronda'
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
              'La ronda todavía no ha terminado'
          });
      }

      prepareRound(g);

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
    ========================= */

    if (
      action ===
      'botStep'
    ) {
      if (
        g.status !==
        'playing'
      ) {
        return res.json(
          publicGame(
            g,
            b.playerId
          )
        );
      }

      const botIndex =
        g.turn;

      const bot =
        g.players[
          botIndex
        ];

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

      let move =
        chooseBotMove(
          g,
          botIndex
        );

      if (move) {
        const played =
          placeTile(
            g,
            botIndex,
            move.index,
            move.side
          );

        addHistory(
          g,
          `🤖 ${bot.name} jugó ${played[0]}|${played[1]} ${move.side === 'left' ? '←' : '→'}`
        );

        if (
          !bot.hand.length
        ) {
          finishDominoRound(
            g,
            botIndex
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

        await save(g);

        return res.json(
          publicGame(
            g,
            b.playerId
          )
        );
      }

      if (
        g.boneyard.length
      ) {
        bot.hand.push(
          g.boneyard.pop()
        );

        g.message =
          `${bot.name} roba del pozo`;

        addHistory(
          g,
          `🤖 ${bot.name} robó del pozo`
        );

        await save(g);

        return res.json(
          publicGame(
            g,
            b.playerId
          )
        );
      }

      g.consecutivePasses =
        (g.consecutivePasses || 0) +
        1;

      addHistory(
        g,
        `🤖 ${bot.name} pasó`
      );

      if (
        g.consecutivePasses >=
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

      await save(g);

      return res.json(
        publicGame(
          g,
          b.playerId
        )
      );
    }


    /* =========================
       VALIDATE HUMAN PLAYER
    ========================= */

    const pi =
      g.players.findIndex(
        player =>
          player.id ===
          b.playerId
      );

    if (pi < 0) {
      return res
        .status(403)
        .json({
          error:
            'Jugador inválido'
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
            'La ronda no está activa'
        });
    }

    if (
      pi !== g.turn
    ) {
      return res
        .status(400)
        .json({
          error:
            'No es tu turno'
        });
    }

    const player =
      g.players[pi];


    /* =========================
       DRAW
    ========================= */

    if (
      action ===
      'draw'
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
              'Ya tienes una ficha que puedes jugar'
          });
      }

      if (
        !g.boneyard.length
      ) {
        return res
          .status(400)
          .json({
            error:
              'El pozo está vacío. Debes pasar.'
          });
      }

      player.hand.push(
        g.boneyard.pop()
      );

      g.message =
        `${player.name} roba una ficha`;

      addHistory(
        g,
        `🁣 ${player.name} robó del pozo`
      );

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
      action ===
      'pass'
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
              'Todavía quedan fichas en el pozo'
          });
      }

      g.consecutivePasses =
        (g.consecutivePasses || 0) +
        1;

      addHistory(
        g,
        `⏭ ${player.name} pasó`
      );

      if (
        g.consecutivePasses >=
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
      action ===
      'play'
    ) {
      const tileIndex =
        Number(
          b.tileIndex
        );

      const tile =
        player.hand[
          tileIndex
        ];

      if (!tile) {
        return res
          .status(400)
          .json({
            error:
              'Ficha inválida'
          });
      }

      const moves =
        getValidMoves(
          player,
          g.board
        );

      const valid =
        moves.some(
          move =>
            move.index ===
              tileIndex &&
            move.side ===
              b.side
        );

      if (!valid) {
        return res
          .status(400)
          .json({
            error:
              'La ficha no puede colocarse en ese extremo'
          });
      }

      const played =
        placeTile(
          g,
          pi,
          tileIndex,
          b.side
        );

      addHistory(
        g,
        `🁣 ${player.name} jugó ${played[0]}|${played[1]} ${b.side === 'left' ? '←' : '→'}`
      );

      if (
        !player.hand.length
      ) {
        finishDominoRound(
          g,
          pi
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

      await save(g);

      return res.json(
        publicGame(
          g,
          b.playerId
        )
      );
    }

    return res
      .status(400)
      .json({
        error:
          'Acción inválida'
      });

  } catch(e) {
    console.error(e);

    return res
      .status(500)
      .json({
        error:
          e.message ||
          'Error del servidor'
      });
  }
};
