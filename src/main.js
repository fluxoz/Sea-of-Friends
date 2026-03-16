/**
 * main.js – Entry point: wires the UI overlays to the Game and NetworkManager.
 */
import { Game }           from './game.js'
import { NetworkManager } from './network.js'

const PIRATE_NAMES = [
  'Blackbeard', 'Redcoat', 'SilverJack', 'DeepWater',
  'IronHull', 'StormCap', 'BrinyBones', 'CopperKeel',
]

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loadingEl      = document.getElementById('loading')
const nameScreen     = document.getElementById('name-screen')
const nameInput      = document.getElementById('name-input')
const joinBtn        = document.getElementById('join-btn')
const hudEl          = document.getElementById('hud')
const chatMessages   = document.getElementById('chat-messages')
const chatInputRow   = document.getElementById('chat-input-row')
const chatInputEl    = document.getElementById('chat-input')
const chatSendBtn    = document.getElementById('chat-send')

// ── Global state ──────────────────────────────────────────────────────────────
let game    = null
let network = null
let chatOpen = false

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
  nameScreen.style.display = 'none'
  hudEl.style.display      = 'block'

  const color = Math.random() * 0xffffff | 0

  network = new NetworkManager('world-1')
  game.start(playerName, color, network)

  // Wire up chat network handler
  network.onChat = (peerId, data) => {
    const peer  = network.getPeer(peerId)
    const name  = peer?.name  || peerId.slice(0, 8)
    const color = peer?.color || '#aaa'
    addChatMessage(name, data.t, color)
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
  startGame(name)
})

nameInput.addEventListener('keydown', e => {
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

// ── Go ────────────────────────────────────────────────────────────────────────
init()
