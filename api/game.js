if (
  action ===
  'rtcConfig'
) {
  const username =
    process.env.METERED_TURN_USERNAME;

  const credential =
    process.env.METERED_TURN_CREDENTIAL;

  if (!username || !credential) {
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
