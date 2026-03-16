export function initHud() {
  const hud = document.getElementById('hud')
  const statusEl = document.getElementById('hud-status')
  const peersEl = document.getElementById('hud-peers')
  const coordsEl = document.getElementById('hud-coords')

  function show() {
    hud.classList.add('visible')
  }

  function hide() {
    hud.classList.remove('visible')
  }

  function setConnected(connected) {
    statusEl.textContent = connected ? '🟢 Connected' : '⏳ Connecting…'
  }

  function setPeerCount(n) {
    peersEl.textContent = `Players: ${n}`
  }

  function setCoords(x, z) {
    coordsEl.textContent = `X: ${Math.round(x)}  Z: ${Math.round(z)}`
  }

  return {show, hide, setConnected, setPeerCount, setCoords}
}

export function initLobby(onJoin) {
  const overlay = document.getElementById('lobby')
  const input = document.getElementById('room-input')
  const btn = document.getElementById('join-btn')

  function join() {
    const roomId = input.value.trim()
    if (!roomId) return
    btn.disabled = true
    onJoin(roomId)
  }

  btn.addEventListener('click', join)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join()
  })

  function hide() {
    overlay.classList.add('hidden')
  }

  return {hide}
}
