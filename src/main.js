/**
 * main.js – Entry point: wires the UI overlays to the Game and NetworkManager.
 */
import { Game }           from './game.js'
import { NetworkManager, APP_VERSION, fetchTurnServers } from './network.js'
import { ProximityAudio } from './audio.js'
import { preloadAssets }  from './assets.js'

const DEFAULT_ROOM_CODE = 'world-1'

// ── Update watch ──────────────────────────────────────────────────────────────
// Peers on different builds never meet (the protocol version is part of the
// app id), so a stale tab just finds an empty-feeling sea. Poll the deployed
// version and tell the captain a refresh is due.
function watchForNewVersion() {
  if (APP_VERSION === 'dev') return
  const check = async () => {
    try {
      const r = await fetch('/version.json', { cache: 'no-store' })
      if (!r.ok) return
      const { version } = await r.json()
      if (version && version !== APP_VERSION && !document.getElementById('update-banner')) {
        const el = document.createElement('div')
        el.id = 'update-banner'
        el.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:500;'
          + 'background:rgba(10,22,40,0.95);color:#c8a96e;border:1px solid rgba(200,169,110,0.5);'
          + 'border-top:none;border-radius:0 0 6px 6px;padding:0.5rem 1.1rem;font-size:0.85rem;'
          + 'cursor:pointer;pointer-events:all'
        el.textContent = `⚓ A new version has shipped (${version}) — click to refresh and rejoin the fleet`
        el.addEventListener('click', () => location.reload())
        document.body.appendChild(el)
        addSystemMessage(`⚓ New version ${version} is live — refresh to sail with the fleet (you're on ${APP_VERSION})`)
      }
    } catch { /* offline or dev — try again later */ }
  }
  check()
  setInterval(check, 10 * 60 * 1000)
}

const PIRATE_NAMES = [
  'Blackbeard', 'Redcoat', 'SilverJack', 'DeepWater',
  'IronHull', 'StormCap', 'BrinyBones', 'CopperKeel',
]

/** Must match the maxlength attribute on #name-input in index.html. */
const MAX_PLAYER_NAME_LENGTH = 20

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loadingEl    = document.getElementById('loading')
const nameScreen   = document.getElementById('name-screen')
const nameInput    = document.getElementById('name-input')
const roomInput    = document.getElementById('room-input')
const joinBtn      = document.getElementById('join-btn')
const hudEl        = document.getElementById('hud')
const chatBox      = document.getElementById('chat-box')
const chatTabs     = document.getElementById('chat-tabs')
const chatMessages = document.getElementById('chat-messages')
const chatInputRow = document.getElementById('chat-input-row')
const chatInputEl  = document.getElementById('chat-input')
const chatSendBtn  = document.getElementById('chat-send')
const chatCmdHint  = document.getElementById('chat-cmd-hint')

// Voice chat DOM refs
const voiceBtn          = document.getElementById('voice-btn')
const voicePanel        = document.getElementById('voice-panel')
const voiceMuteBtn      = document.getElementById('voice-mute-btn')
const voiceDeviceSelect = document.getElementById('voice-device-select')
const voiceNearby       = document.getElementById('voice-nearby')
const voiceLevelFill    = document.getElementById('voice-level-fill')
const voicePttBtn       = document.getElementById('voice-ptt-btn')
const pttIndicator      = document.getElementById('ptt-indicator')
const voiceChannelInput = document.getElementById('voice-channel-input')
const voiceChannelBtn   = document.getElementById('voice-channel-btn')
const voiceChannelStatus = document.getElementById('voice-channel-status')

// ── Global state ──────────────────────────────────────────────────────────────
let game     = null
let network  = null
let chatOpen = false
let audio    = null
let voicePanelOpen = false
let activeTab      = 'all'
const unreadCount  = { crew: 0, system: 0 }

// ── Settings (render/audio side only — never simulation state) ────────────────
const SETTINGS_KEY = 'sof-settings'
const settings = { fps: false, shadows: 'high', sfxVolume: 1, listPublic: false }
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')) } catch { /* fresh */ }

function applyAndSaveSettings() {
  game?.applySettings(settings)
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* private mode */ }
}

/** Available slash commands (used by autocomplete hint). */
const COMMANDS = [
  { cmd: '/help',  args: '',          desc: 'Show available commands' },
  { cmd: '/clear', args: '',          desc: 'Clear chat history' },
  { cmd: '/name',  args: '<newname>', desc: 'Change your captain name' },
  { cmd: '/me',    args: '<action>',  desc: 'Emote an action' },
  { cmd: '/roll',  args: '[max]',     desc: 'Roll dice (default d100)' },
  { cmd: '/channel', args: '<name|off>', desc: 'Join/leave a private crew voice channel' },
  { cmd: '/votekick', args: '<name>', desc: 'Vote to kick a captain (majority of the crew)' },
  { cmd: '/mute',  args: '<name>',    desc: 'Mute/unmute a captain (voice + chat)' },
  { cmd: '/desync', args: '',         desc: 'Download the desync evidence bundle' },
]

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  // Show asset-loading progress in the loading screen
  const loadingText = loadingEl.querySelector('p')
  const progressBar = document.createElement('div')
  progressBar.style.cssText = [
    'width:260px', 'height:6px', 'background:rgba(200,169,110,0.2)',
    'border-radius:3px', 'overflow:hidden', 'margin-top:0.5rem',
  ].join(';')
  const progressFill = document.createElement('div')
  progressFill.style.cssText = 'height:100%;width:0%;background:#c8a96e;border-radius:3px;transition:width 0.15s'
  progressBar.appendChild(progressFill)
  loadingEl.appendChild(progressBar)

  await preloadAssets(p => {
    progressFill.style.width = `${Math.round(p * 100)}%`
    if (loadingText) loadingText.textContent = `Loading assets… ${Math.round(p * 100)}%`
  })

  game = new Game(document.getElementById('canvas'))
  game.init()
  game.applySettings(settings)

  loadingEl.style.display  = 'none'
  nameScreen.style.display = 'flex'
  nameInput.focus()
  watchForNewVersion()
  // Warm the TURN credentials while the captain reads the menu, so joining
  // never waits on it; STUN-only if it fails (local dev, offline)
  fetchTurnServers()
  window.addEventListener('pagehide', () => network?.sendBye?.())
}

// ── Settings panel ────────────────────────────────────────────────────────────
{
  const btn     = document.getElementById('settings-btn')
  const panel   = document.getElementById('settings-panel')
  const fpsBox  = document.getElementById('set-fps')
  const shadows = document.getElementById('set-shadows')
  const sfxVol  = document.getElementById('set-sfx')

  fpsBox.checked  = settings.fps
  shadows.value   = settings.shadows
  sfxVol.value    = Math.round(settings.sfxVolume * 100)

  btn.addEventListener('click', () => panel.classList.toggle('open'))
  document.addEventListener('click', e => {
    if (panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn) {
      panel.classList.remove('open')
    }
  })

  fpsBox.addEventListener('change', () => { settings.fps = fpsBox.checked; applyAndSaveSettings() })
  shadows.addEventListener('change', () => { settings.shadows = shadows.value; applyAndSaveSettings() })
  sfxVol.addEventListener('input', () => { settings.sfxVolume = sfxVol.value / 100; applyAndSaveSettings() })
}

// ── Public session board (its own menu, off the scroll) ──────────────────────
{
  const btn     = document.getElementById('public-seas-btn')
  const panel   = document.getElementById('public-seas-panel')
  const listEl  = document.getElementById('public-seas-list')
  const emptyEl = document.getElementById('public-seas-empty')
  const closeBtn = document.getElementById('public-seas-close')
  const listBox  = document.getElementById('list-public')
  listBox.checked = !!settings.listPublic
  listBox.addEventListener('change', () => {
    settings.listPublic = listBox.checked
    applyAndSaveSettings()
    if (game) game.listPublicly = listBox.checked
  })

  const ageText = ticks => {
    const mins = Math.round(ticks / 20 / 60)
    if (mins < 60) return `${mins} min at sea`
    return `${(mins / 60).toFixed(1)} h at sea`
  }

  const refresh = async () => {
    if (!panel.classList.contains('open')) return
    try {
      const r = await fetch(
        'https://sea-of-friends-signal.fluxoz.workers.dev/board/list?v='
        + encodeURIComponent(APP_VERSION))
      if (!r.ok) return
      const { seas } = await r.json()
      listEl.replaceChildren()
      for (const sea of seas ?? []) {
        const row = document.createElement('div')
        row.className = 'sea-row'
        const name = document.createElement('span')
        name.className = 'sea-name'
        name.textContent = '⛵ ' + sea.room
        const meta = document.createElement('span')
        meta.className = 'sea-meta'
        meta.textContent = `${sea.players} sailor${sea.players !== 1 ? 's' : ''} · ${ageText(sea.age)}`
        row.append(name, meta)
        row.addEventListener('click', () => {
          roomInput.value = sea.room
          panel.classList.remove('open')
          roomInput.focus()
        })
        listEl.appendChild(row)
      }
      emptyEl.style.display = (seas ?? []).length ? 'none' : 'block'
    } catch { /* board down — menu works without it */ }
  }

  let refreshTimer = null
  const setOpen = open => {
    panel.classList.toggle('open', open)
    clearInterval(refreshTimer)
    if (open) {
      refresh()
      refreshTimer = setInterval(refresh, 15000)
    }
  }
  btn.addEventListener('click', () => setOpen(!panel.classList.contains('open')))
  closeBtn.addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', e => {
    if (e.code === 'Escape' && panel.classList.contains('open')) setOpen(false)
  })
}

// ── Menu burn-up transition ───────────────────────────────────────────────────

/**
 * Set the scroll alight: an animated mask consumes the panel from the bottom
 * while a particle canvas renders the fire front — flames, embers, smoke.
 */
function burnMenu(done) {
  const panel = document.getElementById('join-panel')
  const fading = ['title', 'tagline', 'features', 'join-hint']
    .map(id => document.getElementById(id)).filter(Boolean)
  const rect = panel.getBoundingClientRect()

  const cv = document.createElement('canvas')
  cv.width = window.innerWidth
  cv.height = window.innerHeight
  cv.style.cssText = 'position:fixed;inset:0;z-index:960;pointer-events:none'
  document.body.appendChild(cv)
  const ctx = cv.getContext('2d')

  try { game?._sfx?.burn() } catch {}

  const parts = []
  const DUR = 1500
  const t0 = performance.now()
  let last = t0

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now
    const k = Math.min(1, (now - t0) / DUR)
    // Burn line climbs the panel bottom → top
    const burnY = rect.bottom - k * (rect.height + 40)
    const pct = k * 130 - 15
    const mask = `linear-gradient(to top, transparent ${pct}%, black ${pct + 14}%)`
    panel.style.webkitMaskImage = mask
    panel.style.maskImage = mask
    for (const el of fading) el.style.opacity = String(Math.max(0, 1 - k * 1.4))

    // Feed the fire along the burn front
    if (k < 1) {
      for (let i = 0; i < 16; i++) {
        const x = rect.left + Math.random() * rect.width
        const smoke = Math.random() < 0.25
        parts.push({
          x, y: burnY + (Math.random() - 0.5) * 10,
          vx: (Math.random() - 0.5) * 30,
          vy: -(30 + Math.random() * (smoke ? 40 : 110)),
          life: smoke ? 0.9 + Math.random() * 0.5 : 0.35 + Math.random() * 0.45,
          age: 0,
          size: smoke ? 8 + Math.random() * 10 : 3 + Math.random() * 6,
          smoke,
        })
      }
    }

    ctx.clearRect(0, 0, cv.width, cv.height)
    // Ember glow along the front
    if (k < 1) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const grad = ctx.createLinearGradient(0, burnY - 18, 0, burnY + 12)
      grad.addColorStop(0, 'rgba(255,150,40,0)')
      grad.addColorStop(0.7, 'rgba(255,120,20,0.55)')
      grad.addColorStop(1, 'rgba(255,60,10,0)')
      ctx.fillStyle = grad
      ctx.fillRect(rect.left - 10, burnY - 18, rect.width + 20, 30)
      ctx.restore()
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      p.age += dt
      if (p.age >= p.life) { parts.splice(i, 1); continue }
      p.x += p.vx * dt
      p.y += p.vy * dt
      const t = p.age / p.life
      ctx.globalCompositeOperation = p.smoke ? 'source-over' : 'lighter'
      if (p.smoke) {
        ctx.fillStyle = `rgba(70,60,55,${0.3 * (1 - t)})`
      } else {
        const r = 255, g = Math.round(200 - t * 160), b = Math.round(80 - t * 70)
        ctx.fillStyle = `rgba(${r},${g},${b},${0.85 * (1 - t)})`
      }
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size * (p.smoke ? 1 + t : 1 - t * 0.5), 0, Math.PI * 2)
      ctx.fill()
    }

    if (k < 1 || parts.length) requestAnimationFrame(frame)
    else {
      cv.remove()
      // Reset for the next visit to the menu (quit button)
      panel.style.webkitMaskImage = panel.style.maskImage = ''
      for (const el of fading) el.style.opacity = ''
      done()
    }
  }
  requestAnimationFrame(frame)
}

// ── Join ──────────────────────────────────────────────────────────────────────
function startGame(playerName) {
  const roomId = roomInput.value.trim() || DEFAULT_ROOM_CODE
  const shipClass = document.querySelector('.ship-card.selected')?.dataset.cls || 'frigate'

  // The scroll burns away while the game boots underneath it
  burnMenu(() => { nameScreen.style.display = 'none' })
  hudEl.style.display      = 'block'

  const color = Math.random() * 0xffffff | 0

  network = new NetworkManager(roomId)

  // ── Proximity audio ──────────────────────────────────────────────────────
  audio = new ProximityAudio()
  audio.setStreamHandlers(
    (s, t) => network.addStream(s, t),
    (s, t) => network.removeStream(s, t),
    cb      => network.onStream(cb),
  )
  game.setAudio(audio)

  // Battle notices (kills, sinkings) go to the system chat channel
  game.onSystemMessage = addSystemMessage
  game.onKicked = () => {
    addSystemMessage('⚖ You have been voted off the ship. Returning to the menu…')
    setTimeout(() => quitToMenu(), 4000)
  }

  game.listPublicly = !!settings.listPublic
  game.start(playerName, color, network, shipClass)

  // Debug handle (used by smoke tests; handy in the browser console too)
  window.__game = game

  // Wire up chat network handler
  network.onChat = (peerId, data) => {
    if (game.muted.has(peerId)) return   // muted: neither chat nor emotes
    const peer  = network.getPeer(peerId)
    const name  = peer?.name  || peerId.slice(0, 8)
    const color = peer?.color || '#aaa'
    if (data.m === 'e') {
      addEmoteMessage(name, data.t)
      game.showPlayerChat(peerId, `* ${name} ${data.t} *`, true)
    } else {
      addChatMessage(name, data.t, color)
      game.showPlayerChat(peerId, data.t)
    }
  }
}

// ── Voice chat ────────────────────────────────────────────────────────────────

function updateVoiceUI() {
  if (!audio) return
  if (audio.isEnabled()) {
    voiceBtn.classList.add('active')
    voiceBtn.title = 'Voice chat – click to manage'
    const talking = audio.isTransmitting()
    voiceBtn.textContent = audio.isMuted() ? '🔇' : (talking ? '📢' : '🎤')
    if (audio.isMuted()) voiceBtn.classList.add('muted')
    else voiceBtn.classList.remove('muted')
    voiceMuteBtn.textContent = audio.isMuted() ? '🔇 Mic muted' : '🎤 Mic on'
    voiceMuteBtn.classList.toggle('muted', audio.isMuted())
  } else {
    voiceBtn.classList.remove('active', 'muted')
    voiceBtn.textContent = '🎤'
    voiceBtn.title = 'Enable voice chat'
  }

  // PTT mode toggle button
  if (voicePttBtn) {
    const ptt = audio.isPttMode()
    voicePttBtn.textContent = ptt ? '📢 Push to Talk  [hold V]' : '🎙 Always On'
    voicePttBtn.classList.toggle('ptt-on', ptt)
  }

  // PTT active indicator
  if (pttIndicator) {
    const pttActive = audio.isEnabled() && audio.isPttMode() && audio.isPttHeld()
    pttIndicator.classList.toggle('active', pttActive)
  }
}

async function populateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mics = devices.filter(d => d.kind === 'audioinput')
    // Keep a "Default" entry and add labelled entries
    voiceDeviceSelect.innerHTML = '<option value="">Default microphone</option>'
    mics.forEach(d => {
      const opt = document.createElement('option')
      opt.value = d.deviceId
      opt.textContent = d.label || `Microphone ${voiceDeviceSelect.options.length}`
      voiceDeviceSelect.appendChild(opt)
    })
  } catch {}
}

async function toggleVoicePanel() {
  voicePanelOpen = !voicePanelOpen
  voicePanel.classList.toggle('open', voicePanelOpen)
  if (voicePanelOpen && audio && !audio.isEnabled()) {
    // First open: try to enable voice chat
    const ok = await audio.enable()
    if (ok) {
      await populateDevices()
    } else {
      voiceNearby.textContent = '⚠ Mic permission denied'
    }
    updateVoiceUI()
  }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

/** Switch the active chat tab and clear its unread badge. */
function switchTab(tab) {
  activeTab = tab
  chatBox.dataset.tab = tab
  chatTabs.querySelectorAll('.chat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab)
  })
  // 'all' has no badge or entry in unreadCount
  if (tab !== 'all') {
    unreadCount[tab] = 0
    const badge = document.getElementById(`badge-${tab}`)
    if (badge) badge.textContent = ''
  }
  chatMessages.scrollTop = chatMessages.scrollHeight
}

/** Increment the unread badge for a tab the user is not currently viewing. */
function bumpUnread(type) {
  if (activeTab === 'all') return
  const tabForType = type === 'system' ? 'system' : 'crew'
  if (activeTab === tabForType) return
  unreadCount[tabForType] = (unreadCount[tabForType] || 0) + 1
  const badge = document.getElementById(`badge-${tabForType}`)
  if (badge) badge.textContent = unreadCount[tabForType] > 99 ? '99+' : String(unreadCount[tabForType])
}

function openChat() {
  if (chatOpen) return
  chatOpen = true
  chatInputRow.classList.add('active')
  chatInputEl.focus()
  game.setChatMode(true)
}

function closeChat() {
  chatOpen = false
  chatInputRow.classList.remove('active')
  chatInputEl.value = ''
  chatInputEl.blur()
  chatCmdHint.classList.remove('visible')
  game.setChatMode(false)
}

function sendChat() {
  const msg = chatInputEl.value.trim()
  chatCmdHint.classList.remove('visible')
  if (!msg) { closeChat(); return }
  chatInputEl.value = ''
  if (msg.startsWith('/')) {
    handleCommand(msg)
    // Keep input open after a command so the user can type another
    chatInputEl.focus()
    return
  }
  network.sendChatMessage(msg)
  addChatMessage('You', msg, '#c8a96e')
  game.showLocalChat(msg)
  // Keep input open so the user can send consecutive messages
  chatInputEl.focus()
}

/**
 * Handle a '/' slash command entered by the local player.
 * @param {string} raw  – the full input string including the leading '/'
 */
/** Find a peer id by (case-insensitive) captain name. */
function resolvePeerByName(name) {
  for (const [pid, peer] of network?.peers ?? []) {
    if ((peer.name ?? '').toLowerCase() === name) return pid
  }
  return null
}

function handleCommand(raw) {
  const parts   = raw.slice(1).trim().split(/\s+/)
  const cmd     = parts[0].toLowerCase()
  const args    = parts.slice(1)

  switch (cmd) {
    case 'help':
      addSystemMessage('Commands: /help  /clear  /name <name>  /me <action>  /roll [max]')
      break

    case 'clear':
      while (chatMessages.firstChild) chatMessages.removeChild(chatMessages.firstChild)
      break

    case 'votekick': {
      const who = args.join(' ').trim().toLowerCase()
      if (!who) { addSystemMessage('Usage: /votekick <captain name>'); break }
      const pid = resolvePeerByName(who)
      if (!pid) { addSystemMessage(`No captain called "${who}" on this sea.`); break }
      game.castVote(pid)
      break
    }

    case 'mute': {
      const who = args.join(' ').trim().toLowerCase()
      if (!who) { addSystemMessage('Usage: /mute <captain name>'); break }
      const pid = resolvePeerByName(who)
      if (!pid) { addSystemMessage(`No captain called "${who}" on this sea.`); break }
      game.toggleMute(pid)
      break
    }

    case 'desync': {
      const bundle = window.__desyncBundle
      if (!bundle) { addSystemMessage('No desync captured this session — the sea agrees with everyone.'); break }
      const blob = new Blob([JSON.stringify(bundle, null, 1)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `sof-desync-${bundle.tick}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      addSystemMessage(`Desync bundle downloaded (tick ${bundle.tick}, diverged: ${bundle.guilty.join(', ') || 'unknown'}) — attach it to a bug report.`)
      break
    }

    case 'name': {
      const newName = args.join(' ').trim().slice(0, MAX_PLAYER_NAME_LENGTH)
      if (!newName) { addSystemMessage('Usage: /name <newname>'); break }
      network.setLocalInfo(newName, network.getLocalColor() ?? '#c8a96e')
      addSystemMessage(`You are now known as "${newName}"`)
      break
    }

    case 'me': {
      const action = args.join(' ').trim()
      if (!action) { addSystemMessage('Usage: /me <action>'); break }
      const myName = network.getLocalName() ?? 'You'
      network.sendEmoteMessage(action)
      addEmoteMessage(myName, action)
      game.showLocalChat(`* ${myName} ${action} *`, true)
      break
    }

    case 'channel': {
      const arg = args.join(' ').trim().slice(0, 24)
      if (!arg) { addSystemMessage('Usage: /channel <name>  or  /channel off'); break }
      setVoiceChannel(arg.toLowerCase() === 'off' ? '' : arg)
      break
    }

    case 'roll': {
      const parsed = parseInt(args[0])
      if (args[0] !== undefined && (isNaN(parsed) || parsed < 2)) {
        addSystemMessage('Usage: /roll [max]  (max must be a whole number ≥ 2)')
        break
      }
      const max    = isNaN(parsed) ? 100 : parsed
      const result = Math.floor(Math.random() * max) + 1
      const rollText = `🎲 rolls ${result} (1–${max})`
      network.sendChatMessage(rollText)
      addChatMessage('You', rollText, '#c8a96e')
      game.showLocalChat(rollText)
      break
    }

    default:
      addSystemMessage(`Unknown command "/${cmd}". Type /help for a list.`)
  }
}

function nowTimestamp() {
  const d = new Date()
  return d.getHours().toString().padStart(2, '0') + ':'
       + d.getMinutes().toString().padStart(2, '0')
}

function addChatMessage(name, text, color) {
  const div  = document.createElement('div')
  div.dataset.type = 'chat'

  const ts = document.createElement('span')
  ts.className   = 'chat-ts'
  ts.textContent = nowTimestamp()
  div.appendChild(ts)

  const nameSpan = document.createElement('span')
  nameSpan.style.color = color
  nameSpan.textContent = name
  div.appendChild(nameSpan)

  div.appendChild(document.createTextNode(': ' + text))
  chatMessages.appendChild(div)
  chatMessages.scrollTop = chatMessages.scrollHeight
  // Keep at most 60 messages
  while (chatMessages.children.length > 60) {
    chatMessages.removeChild(chatMessages.firstChild)
  }
  bumpUnread('chat')
}

function addEmoteMessage(name, action) {
  const div = document.createElement('div')
  div.dataset.type = 'chat'

  const ts = document.createElement('span')
  ts.className   = 'chat-ts'
  ts.textContent = nowTimestamp()
  div.appendChild(ts)

  const msg = document.createElement('span')
  msg.className   = 'chat-emote'
  msg.textContent = `* ${name} ${action} *`
  div.appendChild(msg)

  chatMessages.appendChild(div)
  chatMessages.scrollTop = chatMessages.scrollHeight
  while (chatMessages.children.length > 60) {
    chatMessages.removeChild(chatMessages.firstChild)
  }
  bumpUnread('chat')
}

function addSystemMessage(text) {
  const div  = document.createElement('div')
  div.dataset.type = 'system'

  const ts = document.createElement('span')
  ts.className   = 'chat-ts'
  ts.textContent = nowTimestamp()
  div.appendChild(ts)

  const msg = document.createElement('span')
  msg.className   = 'chat-sys'
  msg.textContent = text
  div.appendChild(msg)

  chatMessages.appendChild(div)
  chatMessages.scrollTop = chatMessages.scrollHeight
  while (chatMessages.children.length > 60) {
    chatMessages.removeChild(chatMessages.firstChild)
  }
  bumpUnread('system')
}

// ── Event listeners ───────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim()
    || PIRATE_NAMES[Math.floor(Math.random() * PIRATE_NAMES.length)]
  joinBtn.disabled = true
  startGame(name)
})

nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.stopPropagation(); roomInput.focus() }
})

roomInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.stopPropagation(); joinBtn.click() }
})

document.addEventListener('keydown', e => {
  if (!hudEl || hudEl.style.display === 'none') return   // not in game yet
  if (e.key === 'Enter' && !chatOpen) {
    e.preventDefault()
    openChat()
  } else if (e.key === 'Escape' && chatOpen) {
    closeChat()
  }
})

chatInputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); sendChat() }
  if (e.key === 'Escape') closeChat()
  e.stopPropagation()   // prevent game keys while typing
})

// Clicking the (always-visible) input field opens chat mode
chatInputEl.addEventListener('focus', () => {
  if (!chatOpen) openChat()
})

// Update command autocomplete hint while the user types
chatInputEl.addEventListener('input', () => {
  const val = chatInputEl.value
  if (!val.startsWith('/')) {
    chatCmdHint.classList.remove('visible')
    return
  }
  const query   = val.toLowerCase()
  const matches = COMMANDS.filter(c => c.cmd.startsWith(query))
  if (matches.length === 0) {
    chatCmdHint.classList.remove('visible')
    return
  }
  chatCmdHint.innerHTML = matches.map(c =>
    `<div class="cmd-hint-item" data-cmd="${c.cmd}">${c.cmd}` +
    (c.args ? ` <span class="cmd-args">${c.args}</span>` : '') +
    ` <span class="cmd-desc">${c.desc}</span></div>`
  ).join('')
  chatCmdHint.classList.add('visible')
})

// Clicking a hint item completes the command into the input
chatCmdHint.addEventListener('click', e => {
  const item = e.target.closest('.cmd-hint-item')
  if (!item) return
  chatInputEl.value = item.dataset.cmd + ' '
  chatCmdHint.classList.remove('visible')
  chatInputEl.focus()
  e.stopPropagation()
})

chatSendBtn.addEventListener('click', sendChat)

// Tab switching
chatTabs.addEventListener('click', e => {
  const tab = e.target.closest('.chat-tab')
  if (tab) switchTab(tab.dataset.tab)
})

// ── Voice chat event listeners ────────────────────────────────────────────────
voiceBtn.addEventListener('click', e => {
  e.stopPropagation()
  if (!audio) return  // game not started yet
  toggleVoicePanel()
})

voiceMuteBtn.addEventListener('click', () => {
  if (!audio) return
  audio.setMuted(!audio.isMuted())
  updateVoiceUI()
})

voicePttBtn.addEventListener('click', () => {
  if (!audio) return
  audio.setPttMode(!audio.isPttMode())
  updateVoiceUI()
})

voiceDeviceSelect.addEventListener('change', async () => {
  if (!audio || !audio.isEnabled()) return
  const deviceId = voiceDeviceSelect.value
  await audio.setInputDevice(deviceId)
})

// Close voice panel when clicking outside
document.addEventListener('click', e => {
  if (voicePanelOpen && !voicePanel.contains(e.target) && e.target !== voiceBtn) {
    voicePanelOpen = false
    voicePanel.classList.remove('open')
  }
})

// ── Quit to menu ──────────────────────────────────────────────────────────────

const quitBtn = document.getElementById('quit-btn')
let quitArmTimer = null

function quitToMenu() {
  // Tell the crew this is deliberate — no reconnect grace, drop the ship now
  network?.sendBye?.()
  // Order matters: stop the sim first, then leave the room (the crew's
  // departure protocol drops our ship — and our purse — deterministically)
  if (audio) { try { audio.disable() } catch {} }
  game.stop()
  if (network) { try { network.leave() } catch {} }
  network = null
  audio   = null

  closeChat()
  while (chatMessages.firstChild) chatMessages.removeChild(chatMessages.firstChild)
  unreadCount.crew = 0; unreadCount.system = 0
  voicePanelOpen = false
  voicePanel.classList.remove('open')

  hudEl.style.display      = 'none'
  nameScreen.style.display = 'flex'
  joinBtn.disabled = false
  quitBtn.classList.remove('armed')
  quitBtn.textContent = '⏏'
  nameInput.focus()
}

quitBtn?.addEventListener('click', e => {
  e.stopPropagation()
  if (!network) return
  if (!quitBtn.classList.contains('armed')) {
    // First click arms; second click within 3 s abandons ship
    quitBtn.classList.add('armed')
    quitBtn.textContent = 'Abandon ship?'
    clearTimeout(quitArmTimer)
    quitArmTimer = setTimeout(() => {
      quitBtn.classList.remove('armed')
      quitBtn.textContent = '⏏'
    }, 3000)
    return
  }
  clearTimeout(quitArmTimer)
  quitToMenu()
})

// ── Crew voice channel ────────────────────────────────────────────────────────

function setVoiceChannel(name) {
  if (!network) return
  network.setVoiceChannel(name)
  if (name) {
    addSystemMessage(`🔊 Joined crew channel "${name}" — anyone announcing the same name hears you at any distance`)
    if (voiceChannelInput) voiceChannelInput.value = name
    if (voiceChannelBtn) voiceChannelBtn.textContent = 'Leave'
  } else {
    addSystemMessage('🔇 Left the crew channel — proximity voice only')
    if (voiceChannelBtn) voiceChannelBtn.textContent = 'Join'
  }
  updateChannelStatus()
}

function updateChannelStatus() {
  if (!voiceChannelStatus || !network) return
  const vc = network.getLocalVc()
  if (!vc) { voiceChannelStatus.textContent = ''; return }
  let members = 0
  network.peers.forEach(p => { if (p.vc === vc) members++ })
  voiceChannelStatus.textContent =
    `⚓ In "${vc}" with ${members} other${members !== 1 ? 's' : ''}`
}

voiceChannelBtn?.addEventListener('click', () => {
  if (!network) return
  if (network.getLocalVc()) setVoiceChannel('')
  else {
    const name = voiceChannelInput.value.trim().slice(0, 24)
    if (name) setVoiceChannel(name)
  }
})

voiceChannelInput?.addEventListener('keydown', e => {
  e.stopPropagation()
  if (e.key === 'Enter') voiceChannelBtn?.click()
})

setInterval(updateChannelStatus, 2000)

// ── PTT key (V) ───────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.code !== 'KeyV') return
  if (!hudEl || hudEl.style.display === 'none') return
  if (chatOpen) return
  if (!audio || !audio.isEnabled()) return
  e.preventDefault()
  if (!e.repeat) {
    // Auto-switch to PTT mode the first time V is pressed
    if (!audio.isPttMode()) audio.setPttMode(true)
    audio.pressPTT()
    updateVoiceUI()
  }
})

document.addEventListener('keyup', e => {
  if (e.code !== 'KeyV') return
  if (!audio || !audio.isEnabled() || !audio.isPttMode()) return
  audio.releasePTT()
  updateVoiceUI()
})

// ── Voice level & nearby update (≈20 fps) ─────────────────────────────────────
// The early-return inside the callback means this does negligible work when
// voice is not active, so the interval doesn't need to be torn down.
setInterval(() => {
  if (!audio || !audio.isEnabled()) {
    if (pttIndicator) pttIndicator.classList.remove('active')
    return
  }

  // Update mic level visualiser bar
  if (voiceLevelFill) {
    const level = audio.getInputLevel()
    // Scale RMS (typically 0–0.5 when speaking) to fill the bar comfortably
    voiceLevelFill.style.width = `${Math.min(100, level * 400)}%`
    // Turn red when muted so user knows their mic is off
    voiceLevelFill.style.background = audio.isMuted()
      ? '#f44336'
      : (audio.isPttMode() && !audio.isPttHeld() ? '#f0a020' : '#4caf50')
  }

  // Update nearby-sailors display
  if (voiceNearby) {
    const n = audio.getNearbyPeerIds().length
    voiceNearby.textContent = n > 0
      ? `🔊 ${n} sailor${n !== 1 ? 's' : ''} in range`
      : '🔈 No sailors in range'
  }

  // Keep the PTT indicator in sync
  if (pttIndicator) {
    pttIndicator.classList.toggle('active', audio.isPttMode() && audio.isPttHeld())
  }
}, 50)

// Ship class selection cards
document.getElementById('ship-select')?.addEventListener('click', e => {
  const card = e.target.closest('.ship-card')
  if (!card) return
  document.querySelectorAll('.ship-card').forEach(c => c.classList.remove('selected'))
  card.classList.add('selected')
})

// ── Go ────────────────────────────────────────────────────────────────────────
init()
