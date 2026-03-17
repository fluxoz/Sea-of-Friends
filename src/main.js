/**
 * main.js – Entry point: wires the UI overlays to the Game and NetworkManager.
 */
import { Game }           from './game.js'
import { NetworkManager } from './network.js'
import { ProximityAudio } from './audio.js'

const DEFAULT_ROOM_CODE = 'world-1'

const PIRATE_NAMES = [
  'Blackbeard', 'Redcoat', 'SilverJack', 'DeepWater',
  'IronHull', 'StormCap', 'BrinyBones', 'CopperKeel',
]

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loadingEl    = document.getElementById('loading')
const nameScreen   = document.getElementById('name-screen')
const nameInput    = document.getElementById('name-input')
const roomInput    = document.getElementById('room-input')
const joinBtn      = document.getElementById('join-btn')
const hudEl        = document.getElementById('hud')
const chatMessages = document.getElementById('chat-messages')
const chatInputRow = document.getElementById('chat-input-row')
const chatInputEl  = document.getElementById('chat-input')
const chatSendBtn  = document.getElementById('chat-send')

// Voice chat DOM refs
const voiceBtn          = document.getElementById('voice-btn')
const voicePanel        = document.getElementById('voice-panel')
const voiceMuteBtn      = document.getElementById('voice-mute-btn')
const voiceDeviceSelect = document.getElementById('voice-device-select')
const voiceNearby       = document.getElementById('voice-nearby')

// ── Global state ──────────────────────────────────────────────────────────────
let game     = null
let network  = null
let chatOpen = false
let audio    = null
let voicePanelOpen = false

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  game = new Game(document.getElementById('canvas'))
  game.init()

  loadingEl.style.display  = 'none'
  nameScreen.style.display = 'flex'
  nameInput.focus()
}

// ── Join ──────────────────────────────────────────────────────────────────────
function startGame(playerName) {
  const roomId = roomInput.value.trim() || DEFAULT_ROOM_CODE

  nameScreen.style.display = 'none'
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

  game.start(playerName, color, network)

  // Wire up chat network handler
  network.onChat = (peerId, data) => {
    const peer  = network.getPeer(peerId)
    const name  = peer?.name  || peerId.slice(0, 8)
    const color = peer?.color || '#aaa'
    addChatMessage(name, data.t, color)
  }
}

// ── Voice chat ────────────────────────────────────────────────────────────────

function updateVoiceUI() {
  if (!audio) return
  if (audio.isEnabled()) {
    voiceBtn.classList.add('active')
    voiceBtn.title = 'Voice chat – click to manage'
    voiceBtn.textContent = audio.isMuted() ? '🔇' : '🎤'
    if (audio.isMuted()) voiceBtn.classList.add('muted')
    else voiceBtn.classList.remove('muted')
    voiceMuteBtn.textContent = audio.isMuted() ? '🔇 Mic muted' : '🎤 Mic on'
    voiceMuteBtn.classList.toggle('muted', audio.isMuted())
  } else {
    voiceBtn.classList.remove('active', 'muted')
    voiceBtn.textContent = '🎤'
    voiceBtn.title = 'Enable voice chat'
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
  game.setChatMode(false)
}

function sendChat() {
  const msg = chatInputEl.value.trim()
  if (!msg) { closeChat(); return }
  network.sendChatMessage(msg)
  addChatMessage('You', msg, '#c8a96e')
  closeChat()
}

function addChatMessage(name, text, color) {
  const div  = document.createElement('div')
  const span = document.createElement('span')
  span.style.color = color
  span.textContent = name
  div.appendChild(span)
  div.appendChild(document.createTextNode(': ' + text))
  chatMessages.appendChild(div)
  chatMessages.scrollTop = chatMessages.scrollHeight
  // Keep at most 60 messages
  while (chatMessages.children.length > 60) {
    chatMessages.removeChild(chatMessages.firstChild)
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim()
    || PIRATE_NAMES[Math.floor(Math.random() * PIRATE_NAMES.length)]
  joinBtn.disabled = true
  startGame(name)
})

nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') roomInput.focus()
})

roomInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinBtn.click()
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

chatSendBtn.addEventListener('click', sendChat)

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

// ── Go ────────────────────────────────────────────────────────────────────────
init()
