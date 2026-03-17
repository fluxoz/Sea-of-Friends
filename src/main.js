/**
 * main.js – Entry point: wires the UI overlays to the Game and NetworkManager.
 */
import { Game }           from './game.js'
import { NetworkManager } from './network.js'

const DEFAULT_ROOM_CODE = 'world-1'

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
const chatMessages = document.getElementById('chat-messages')
const chatInputRow = document.getElementById('chat-input-row')
const chatInputEl  = document.getElementById('chat-input')
const chatSendBtn  = document.getElementById('chat-send')

// ── Global state ──────────────────────────────────────────────────────────────
let game     = null
let network  = null
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
  const roomId = roomInput.value.trim() || DEFAULT_ROOM_CODE

  nameScreen.style.display = 'none'
  hudEl.style.display      = 'block'

  const color = Math.random() * 0xffffff | 0

  network = new NetworkManager(roomId)
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
  if (msg.startsWith('/')) {
    handleCommand(msg)
    closeChat()
    return
  }
  network.sendChatMessage(msg)
  addChatMessage('You', msg, '#c8a96e')
  closeChat()
}

/**
 * Handle a '/' slash command entered by the local player.
 * @param {string} raw  – the full input string including the leading '/'
 */
function handleCommand(raw) {
  const parts   = raw.slice(1).trim().split(/\s+/)
  const cmd     = parts[0].toLowerCase()
  const args    = parts.slice(1)

  switch (cmd) {
    case 'help':
      addSystemMessage('Commands: /help  /clear  /name <newname>')
      break

    case 'clear':
      while (chatMessages.firstChild) chatMessages.removeChild(chatMessages.firstChild)
      break

    case 'name': {
      const newName = args.join(' ').trim().slice(0, MAX_PLAYER_NAME_LENGTH)
      if (!newName) { addSystemMessage('Usage: /name <newname>'); break }
      network.setLocalInfo(newName, network.getLocalColor() ?? '#c8a96e')
      addSystemMessage(`You are now known as "${newName}"`)
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
}

function addSystemMessage(text) {
  const div  = document.createElement('div')

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

// ── Go ────────────────────────────────────────────────────────────────────────
init()
