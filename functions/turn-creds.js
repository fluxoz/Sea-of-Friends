/**
 * Pages Function: GET /turn-creds
 *
 * Mints short-lived Cloudflare TURN credentials so symmetric-NAT pairs can
 * relay when a direct WebRTC path fails. ICE only touches relay candidates
 * as a last resort, so most crews never generate a byte of TURN traffic.
 * The TURN key secret lives here as a Pages secret and never reaches the
 * client — the client only ever sees per-session credentials that expire.
 */
export async function onRequestGet(context) {
  const { TURN_KEY_ID, TURN_KEY_SECRET } = context.env
  if (!TURN_KEY_ID || !TURN_KEY_SECRET) {
    return new Response(JSON.stringify({ error: 'turn not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })
  }
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TURN_KEY_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 21600 }),   // 6 h — outlives any session
    },
  )
  if (!r.ok) {
    return new Response(JSON.stringify({ error: 'turn upstream failed' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })
  }
  const creds = await r.json()
  return new Response(JSON.stringify(creds), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
