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
