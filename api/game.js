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
  await kv.set(`domino:${g.code}`, g, { ex: 86400 });
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

function canPlayTile(tile, board) {
  if (!tile) return false;
  if (!board.length) return true;

  const left = board[0][0];
  const right = board[board.length - 1][1];

  return (
    tile[0] === left ||
    tile[1] === left ||
    tile[0] === right ||
    tile[1] === right
  );
}

function hasPlayableTile(player, board) {
  return player.hand.some(tile =>
    canPlayTile(tile, board)
  );
}

function findOpeningTile(g) {
  let bestDouble = null;

  g.players.forEach((player, playerIndex) => {
    player.hand.forEach((tile, tileIndex) => {
      if (tile[0] === tile[1]) {
        if (
          !bestDouble ||
          tile[0] > bestDouble.value
        ) {
          bestDouble = {
            playerIndex,
            tileIndex,
            value: tile[0],
            tile
          };
        }
      }
    });
  });

  if (bestDouble) {
    return bestDouble;
  }

  /*
    Si ningún jugador recibió un doble,
    usamos la ficha de mayor valor total
    como desempate para poder iniciar.
  */

  let bestTile = null;

  g.players.forEach((player, playerIndex) => {
    player.hand.forEach((tile, tileIndex) => {
      const total = tile[0] + tile[1];
      const high = Math.max(tile[0], tile[1]);

      if (
        !bestTile ||
        total > bestTile.total ||
        (total === bestTile.total &&
          high > bestTile.high)
      ) {
        bestTile = {
          playerIndex,
          tileIndex,
          total,
          high,
          tile
        };
      }
    });
  });

  return bestTile;
}

function prepareRound(g) {
  const tiles = createSet();

  g.players.forEach(player => {
    player.hand = [];
  });

  g.board = [];
  g.boneyard = tiles;
  g.consecutivePasses = 0;
  g.roundNumber = (g.roundNumber || 0) + 1;

  const count = 7;

  g.players.forEach(player => {
    player.hand = g.boneyard.splice(0, count);
  });

  const opening = findOpeningTile(g);

  const starter = opening.playerIndex;

  const openingTile =
    g.players[starter].hand.splice(
      opening.tileIndex,
      1
    )[0];

  g.board.push(openingTile);

  g.turn =
    (starter + 1) %
    g.players.length;

  g.status = 'playing';

  g.message =
    `${g.players[starter].name} abre con ` +
    `${openingTile[0]}-${openingTile[1]}. ` +
    `Turno de ${g.players[g.turn].name}`;
}

function finishBlockedRound(g) {
  const totals = g.players.map(player =>
    pipTotal(player.hand)
  );

  if (g.players.length === 4) {
    const totalA = totals[0] + totals[2];
    const totalB = totals[1] + totals[3];

    if (totalA === totalB) {
      g.status = 'finished';
      g.message =
        `Cierre empatado. Equipo A ${totalA} ` +
        `- Equipo B ${totalB}. Sin puntos.`;

      return;
    }

    const winnerTeam =
      totalA < totalB ? 'A' : 'B';

    const points =
      winnerTeam === 'A'
        ? totalB
        : totalA;

    g.teamScores[winnerTeam] =
      (g.teamScores[winnerTeam] || 0) +
      points;

    const reachedTarget =
      g.teamScores[winnerTeam] >= g.target;

    g.status =
      reachedTarget
        ? 'match_finished'
        : 'finished';

    g.message =
      `Cierre. Equipo ${winnerTeam} gana ` +
      `la ronda (+${points}). ` +
      `Marcador: A ${g.teamScores.A} - ` +
      `B ${g.teamScores.B}` +
      (reachedTarget
        ? `. ¡Equipo ${winnerTeam} gana la partida!`
        : '');

    return;
  }

  const minimum = Math.min(...totals);

  const winners = totals
    .map((total, index) => ({
      total,
      index
    }))
    .filter(x => x.total === minimum);

  if (winners.length !== 1) {
    g.status = 'finished';
    g.message =
      `Cierre empatado con ${minimum} puntos. ` +
      `Sin puntos para esta ronda.`;

    return;
  }

  const winnerIndex = winners[0].index;
  const winner = g.players[winnerIndex];

  const points = totals.reduce(
    (sum, total, index) =>
      index === winnerIndex
        ? sum
        : sum + total,
    0
  );

  g.scores[winner.id] =
    (g.scores[winner.id] || 0) +
    points;

  const reachedTarget =
    g.scores[winner.id] >= g.target;

  g.status =
    reachedTarget
      ? 'match_finished'
      : 'finished';

  g.message =
    `${winner.name} gana el cierre (+${points}). ` +
    `Total: ${g.scores[winner.id]} pts` +
    (reachedTarget
      ? `. ¡${winner.name} gana la partida!`
      : '');
}

function finishDominoRound(g, winnerIndex) {
  const winner = g.players[winnerIndex];

  if (g.players.length === 4) {
    const winnerTeam = teamOf(winnerIndex);
    const loserTeam =
      winnerTeam === 'A' ? 'B' : 'A';

    let points = 0;

    g.players.forEach((player, index) => {
      if (teamOf(index) === loserTeam) {
        points += pipTotal(player.hand);
      }
    });

    g.teamScores[winnerTeam] =
      (g.teamScores[winnerTeam] || 0) +
      points;

    const reachedTarget =
      g.teamScores[winnerTeam] >= g.target;

    g.status =
      reachedTarget
        ? 'match_finished'
        : 'finished';

    g.message =
      `¡Dominó! ${winner.name}, Equipo ${winnerTeam}, ` +
      `gana la ronda (+${points}). ` +
      `Marcador: A ${g.teamScores.A} - ` +
      `B ${g.teamScores.B}` +
      (reachedTarget
        ? `. ¡Equipo ${winnerTeam} gana la partida!`
        : '');

    return;
  }

  let points = 0;

  g.players.forEach((player, index) => {
    if (index !== winnerIndex) {
      points += pipTotal(player.hand);
    }
  });

  g.scores[winner.id] =
    (g.scores[winner.id] || 0) +
    points;

  const reachedTarget =
    g.scores[winner.id] >= g.target;

  g.status =
    reachedTarget
      ? 'match_finished'
      : 'finished';

  g.message =
    `¡Dominó! ${winner.name} gana la ronda ` +
    `(+${points}). Total: ${g.scores[winner.id]} pts` +
    (reachedTarget
      ? `. ¡${winner.name} gana la partida!`
      : '');
}

function publicGame(g, playerId) {
  const myIndex =
    g.players.findIndex(
      player => player.id === playerId
    );

  const me =
    myIndex >= 0
      ? g.players[myIndex]
      : null;

  return {
    code: g.code,
    maxPlayers: g.maxPlayers,
    target: g.target,
    turnDirection: g.turnDirection,
    board: g.board,
    boneyardCount: g.boneyard.length,
    turn: g.turn,
    status: g.status,
    message: g.message,
    roundNumber: g.roundNumber || 0,

    myIndex,
    myHand: me ? me.hand : [],
    isHost: g.host === playerId,

    players: g.players.map(
      (player, index) => ({
        name: player.name,
        handCount: player.hand.length,
        team:
          g.players.length === 4
            ? teamOf(index)
            : null,
        score:
          g.players.length === 4
            ? null
            : g.scores[player.id] || 0,
        isMe: player.id === playerId
      })
    ),

    teamScores:
      g.players.length === 4
        ? g.teamScores
        : null
  };
}

module.exports = async (req, res) => {
  try {
    const b = req.body || {};
    const action = b.action;

    /*
      REFRESH
    */

    if (req.method === 'GET') {
      const code = req.query.code;
      const playerId = req.query.playerId;

      const g = await kv.get(
        `domino:${code}`
      );

      if (!g) {
        return res
          .status(404)
          .json({
            error: 'Sala no encontrada'
          });
      }

      return res.json(
        publicGame(g, playerId)
      );
    }

    /*
      CREAR SALA
    */

    if (action === 'create') {
      const code = id();
      const pid = id();

      const g = {
        code,
        host: pid,
        maxPlayers:
          Math.min(
            4,
            Math.max(
              2,
              Number(b.maxPlayers) || 4
            )
          ),
        target:
          Number(b.target) || 100,
        turnDirection:
          b.turnDirection ||
          'clockwise',

        players: [
          {
            id: pid,
            name:
              (b.name || '').trim() ||
              'Jugador 1',
            hand: []
          }
        ],

        board: [],
        boneyard: createSet(),

        scores: {},
        teamScores: {
          A: 0,
          B: 0
        },

        turn: 0,
        status: 'lobby',
        message: 'Sala creada',
        consecutivePasses: 0,
        roundNumber: 0
      };

      await save(g);

      return res.json({
        game: publicGame(g, pid),
        playerId: pid
      });
    }

    /*
      BUSCAR SALA
    */

    const g = await kv.get(
      `domino:${b.code}`
    );

    if (!g) {
      return res
        .status(404)
        .json({
          error: 'Sala no encontrada'
        });
    }

    /*
      UNIRSE
    */

    if (action === 'join') {
      if (g.status !== 'lobby') {
        return res
          .status(400)
          .json({
            error:
              'La partida ya comenzó'
          });
      }

      if (
        g.players.length >=
        g.maxPlayers
      ) {
        return res
          .status(400)
          .json({
            error: 'Sala llena'
          });
      }

      const pid = id();

      g.players.push({
        id: pid,
        name:
          (b.name || '').trim() ||
          `Jugador ${g.players.length + 1}`,
        hand: []
      });

      g.message =
        `${g.players.length}/${g.maxPlayers} ` +
        `jugadores conectados`;

      await save(g);

      return res.json({
        game: publicGame(g, pid),
        playerId: pid
      });
    }

    /*
      INICIAR PARTIDA
    */

    if (action === 'start') {
      if (b.playerId !== g.host) {
        return res
          .status(403)
          .json({
            error:
              'Solo el host puede iniciar'
          });
      }

      if (g.status !== 'lobby') {
        return res
          .status(400)
          .json({
            error:
              'La partida ya comenzó'
          });
      }

      if (
        g.players.length !==
        g.maxPlayers
      ) {
        return res
          .status(400)
          .json({
            error:
              `Faltan jugadores. ` +
              `${g.players.length}/${g.maxPlayers} conectados.`
          });
      }

      prepareRound(g);

      await save(g);

      return res.json(
        publicGame(g, b.playerId)
      );
    }

    /*
      NUEVA RONDA
    */

    if (action === 'newRound') {
      if (b.playerId !== g.host) {
        return res
          .status(403)
          .json({
            error:
              'Solo el host puede iniciar una nueva ronda'
          });
      }

      if (g.status !== 'finished') {
        return res
          .status(400)
          .json({
            error:
              'La ronda actual todavía no ha terminado'
          });
      }

      prepareRound(g);

      await save(g);

      return res.json(
        publicGame(g, b.playerId)
      );
    }

    /*
      VALIDAR JUGADOR
    */

    const pi =
      g.players.findIndex(
        player =>
          player.id === b.playerId
      );

    if (pi < 0) {
      return res
        .status(403)
        .json({
          error: 'Jugador inválido'
        });
    }

    if (g.status !== 'playing') {
      return res
        .status(400)
        .json({
          error:
            'La ronda no está activa'
        });
    }

    if (pi !== g.turn) {
      return res
        .status(400)
        .json({
          error:
            'No es tu turno'
        });
    }

    const player = g.players[pi];

    function nextTurn() {
      const step =
        g.turnDirection ===
        'clockwise'
          ? 1
          : g.players.length - 1;

      g.turn =
        (g.turn + step) %
        g.players.length;

      g.message =
        `Turno de ` +
        `${g.players[g.turn].name}`;
    }

    /*
      ROBAR
    */

    if (action === 'draw') {
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

      if (!g.boneyard.length) {
        return res
          .status(400)
          .json({
            error:
              'El pozo está vacío. Debes pasar.'
          });
      }

      const drawn =
        g.boneyard.pop();

      player.hand.push(drawn);

      g.message =
        `${player.name} roba una ficha`;

      await save(g);

      return res.json(
        publicGame(g, b.playerId)
      );
    }

    /*
      PASAR
    */

    if (action === 'pass') {
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

      if (g.boneyard.length) {
        return res
          .status(400)
          .json({
            error:
              'Todavía quedan fichas en el pozo'
          });
      }

      g.consecutivePasses =
        (g.consecutivePasses || 0) + 1;

      if (
        g.consecutivePasses >=
        g.players.length
      ) {
        finishBlockedRound(g);

        await save(g);

        return res.json(
          publicGame(g, b.playerId)
        );
      }

      nextTurn();

      await save(g);

      return res.json(
        publicGame(g, b.playerId)
      );
    }

    /*
      JUGAR
    */

    if (action === 'play') {
      const tileIndex =
        Number(b.tileIndex);

      const t =
        player.hand[tileIndex];

      if (!t) {
        return res
          .status(400)
          .json({
            error:
              'Ficha inválida'
          });
      }

      if (
        !canPlayTile(
          t,
          g.board
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'Esa ficha no coincide con ningún extremo'
          });
      }

      const left =
        g.board[0][0];

      const right =
        g.board[
          g.board.length - 1
        ][1];

      let placed;

      if (b.side === 'left') {
        if (t[1] === left) {
          placed = t;
        } else if (t[0] === left) {
          placed = [
            t[1],
            t[0]
          ];
        } else {
          return res
            .status(400)
            .json({
              error:
                'No coincide con el extremo izquierdo'
            });
        }

        g.board.unshift(placed);
      } else {
        if (t[0] === right) {
          placed = t;
        } else if (t[1] === right) {
          placed = [
            t[1],
            t[0]
          ];
        } else {
          return res
            .status(400)
            .json({
              error:
                'No coincide con el extremo derecho'
            });
        }

        g.board.push(placed);
      }

      player.hand.splice(
        tileIndex,
        1
      );

      g.consecutivePasses = 0;

      if (!player.hand.length) {
        finishDominoRound(g, pi);

        await save(g);

        return res.json(
          publicGame(g, b.playerId)
        );
      }

      nextTurn();

      await save(g);

      return res.json(
        publicGame(g, b.playerId)
      );
    }

    return res
      .status(400)
      .json({
        error: 'Acción inválida'
      });

  } catch (e) {
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
