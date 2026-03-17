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

// ── Global state ──────────────────────────────────────────────────────────────
let game     = null
let network  = null
let chatOpen = false
let audio    = null
let voicePanelOpen = false
let activeTab      = 'all'
const unreadCount  = { crew: 0, system: 0 }

/** Available slash commands (used by autocomplete hint). */
const COMMANDS = [
  { cmd: '/help',  args: '',          desc: 'Show available commands' },
  { cmd: '/clear', args: '',          desc: 'Clear chat history' },
  { cmd: '/name',  args: '<newname>', desc: 'Change your captain name' },
  { cmd: '/me',    args: '<action>',  desc: 'Emote an action' },
  { cmd: '/roll',  args: '[max]',     desc: 'Roll dice (default d100)' },
]

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
    if (data.m === 'e') {
      addEmoteMessage(name, data.t)
    } else {
      addChatMessage(name, data.t, color)
    }
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
  // Keep input open so the user can send consecutive messages
  chatInputEl.focus()
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
      addSystemMessage('Commands: /help  /clear  /name <name>  /me <action>  /roll [max]')
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

    case 'me': {
      const action = args.join(' ').trim()
      if (!action) { addSystemMessage('Usage: /me <action>'); break }
      const myName = network.getLocalName() ?? 'You'
      network.sendEmoteMessage(action)
      addEmoteMessage(myName, action)
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
