<<<<<<< HEAD
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
=======
import * as THREE from 'three'
import {createEngine} from './game/engine.js'
import {createWorld} from './game/world.js'
import {initInput, getInput, getCameraAngles, hasPointerLock} from './game/input.js'
import {createNetwork} from './network/peer.js'
import {initHud, initLobby} from './ui/hud.js'

const canvas = document.getElementById('game-canvas')
const {renderer, scene, camera, clock} = createEngine(canvas)
const world = createWorld(scene)
const hud = initHud()

let network = null

const CAMERA_DIST = 50
const CAMERA_HEIGHT_OFFSET = 18

function startGame(roomId) {
  hud.show()

  network = createNetwork(roomId)
  hud.setConnected(true)

  network.callbacks.onPeerJoin = (peerId) => {
    world.addRemoteShip(peerId)
    hud.setPeerCount(network.getPeerCount() + 1)
  }

  network.callbacks.onPeerLeave = (peerId) => {
    world.removeRemoteShip(peerId)
    hud.setPeerCount(network.getPeerCount() + 1)
  }

  network.callbacks.onPeerState = (peerId, state) => {
    if (!world.remoteShips.has(peerId)) {
      world.addRemoteShip(peerId)
    }
    world.updateRemoteShip(peerId, state)
  }

  network.startSync(() => world.getLocalState())

  initInput(canvas)
  tick()
}

function tick() {
  requestAnimationFrame(tick)

  const dt = Math.min(clock.getDelta(), 0.05)
  const elapsed = clock.getElapsedTime()

  const input = hasPointerLock() ? getInput() : null
  world.update(dt, elapsed, input)

  const ship = world.getLocalShip()
  const {yaw, pitch} = getCameraAngles()

  const camX = ship.state.x - Math.sin(yaw) * CAMERA_DIST
  const camZ = ship.state.z - Math.cos(yaw) * CAMERA_DIST
  const camY = ship.group.position.y + CAMERA_HEIGHT_OFFSET - pitch * 20

  camera.position.set(camX, camY, camZ)
  camera.lookAt(
    ship.group.position.x,
    ship.group.position.y + 5,
    ship.group.position.z
  )

  renderer.render(scene, camera)

  hud.setCoords(ship.state.x, ship.state.z)
  if (network) {
    hud.setPeerCount(network.getPeerCount() + 1)
  }
}

const lobby = initLobby((roomId) => {
  lobby.hide()
  startGame(roomId)
})
>>>>>>> master
