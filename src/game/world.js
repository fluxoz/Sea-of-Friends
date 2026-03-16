import * as THREE from 'three'
import {createOcean} from './ocean.js'
import {createSky} from './sky.js'
import {createShip} from './ship.js'

export function createWorld(scene) {
  const ocean = createOcean(scene)
  createSky(scene)

  const localShip = createShip(scene, true)
  const remoteShips = new Map()

  function update(dt, elapsed, input) {
    ocean.update(elapsed)
    localShip.update(dt, input)
  }

  function addRemoteShip(peerId) {
    if (remoteShips.has(peerId)) return
    const ship = createShip(scene, false)
    remoteShips.set(peerId, ship)
  }

  function removeRemoteShip(peerId) {
    const ship = remoteShips.get(peerId)
    if (ship) {
      ship.dispose()
      remoteShips.delete(peerId)
    }
  }

  function updateRemoteShip(peerId, state) {
    const ship = remoteShips.get(peerId)
    if (ship) {
      ship.setFromState(state)
      ship.update(0, null)
    }
  }

  function getLocalState() {
    return localShip.getState()
  }

  function getLocalShip() {
    return localShip
  }

  return {
    localShip,
    remoteShips,
    update,
    addRemoteShip,
    removeRemoteShip,
    updateRemoteShip,
    getLocalState,
    getLocalShip,
  }
}
