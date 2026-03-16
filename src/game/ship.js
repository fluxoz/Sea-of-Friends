import * as THREE from 'three'

const HULL_COLOR = 0x8b5e3c
const SAIL_COLOR = 0xf5f0e0
const MAST_COLOR = 0x6b4423

export function createShip(scene, isLocal = true) {
  const group = new THREE.Group()

  // Hull
  const hullShape = new THREE.Shape()
  hullShape.moveTo(-6, 0)
  hullShape.quadraticCurveTo(-6, 3, -3, 4)
  hullShape.lineTo(3, 4)
  hullShape.quadraticCurveTo(6, 3, 7, 1)
  hullShape.quadraticCurveTo(6, -1, 3, -1)
  hullShape.lineTo(-3, -1)
  hullShape.quadraticCurveTo(-6, -1, -6, 0)

  const extrudeSettings = {depth: 4, bevelEnabled: true, bevelSize: 0.3, bevelThickness: 0.3}
  const hullGeo = new THREE.ExtrudeGeometry(hullShape, extrudeSettings)
  hullGeo.rotateX(-Math.PI / 2)
  hullGeo.translate(0, 0, 0)
  const hullMat = new THREE.MeshStandardMaterial({color: HULL_COLOR, roughness: 0.7})
  const hull = new THREE.Mesh(hullGeo, hullMat)
  hull.position.y = 0
  group.add(hull)

  // Mast
  const mastGeo = new THREE.CylinderGeometry(0.2, 0.25, 14, 8)
  const mastMat = new THREE.MeshStandardMaterial({color: MAST_COLOR, roughness: 0.6})
  const mast = new THREE.Mesh(mastGeo, mastMat)
  mast.position.set(0, 7, 2)
  group.add(mast)

  // Sail
  const sailGeo = new THREE.PlaneGeometry(6, 10, 8, 8)
  const sailMat = new THREE.MeshStandardMaterial({
    color: SAIL_COLOR,
    side: THREE.DoubleSide,
    roughness: 0.9,
  })
  const sail = new THREE.Mesh(sailGeo, sailMat)
  sail.position.set(0, 8, 4)
  sail.rotation.y = Math.PI / 6
  group.add(sail)

  if (!isLocal) {
    // Tint remote ships slightly differently
    hullMat.color.set(0x7a4e2c)
  }

  scene.add(group)

  // State
  const state = {
    x: 0,
    z: 0,
    heading: 0,
    speed: 0,
  }

  const MAX_SPEED = 40
  const ACCEL = 18
  const DRAG = 0.97
  const TURN_SPEED = 1.6
  const BOOST_MULT = 2.2

  function update(dt, input) {
    if (input) {
      let accel = 0
      if (input.forward) accel += ACCEL
      if (input.backward) accel -= ACCEL * 0.5
      const boost = input.boost ? BOOST_MULT : 1

      state.speed += accel * boost * dt
      state.speed *= DRAG

      const maxSpd = MAX_SPEED * boost
      state.speed = Math.max(-maxSpd * 0.3, Math.min(maxSpd, state.speed))

      let turn = 0
      if (input.left) turn += TURN_SPEED
      if (input.right) turn -= TURN_SPEED
      state.heading += turn * dt * (0.3 + 0.7 * Math.min(1, Math.abs(state.speed) / 10))
    }

    state.x += Math.sin(state.heading) * state.speed * dt
    state.z += Math.cos(state.heading) * state.speed * dt

    group.position.set(state.x, 0, state.z)
    group.rotation.y = state.heading

    // Bob on waves
    const time = performance.now() / 1000
    const wave =
      Math.sin(state.x * 0.02 + time * 0.6) * 2.5 +
      Math.sin(state.z * 0.03 + time * 0.4) * 1.8 +
      Math.sin((state.x + state.z) * 0.01 + time * 0.8) * 3.0
    group.position.y = wave

    // Tilt from waves
    const rollAngle = Math.sin(state.x * 0.02 + time * 0.6) * 0.05
    const pitchAngle = Math.sin(state.z * 0.03 + time * 0.4) * 0.04
    group.rotation.z = rollAngle
    group.rotation.x = pitchAngle

    // Animate sail
    if (sail.geometry.attributes.position) {
      const positions = sail.geometry.attributes.position
      const original = sail.geometry.getAttribute('position')
      for (let i = 0; i < positions.count; i++) {
        const y = original.getY(i)
        const billowAmount = Math.sin(y * 0.3 + time * 2) * 0.3 * (1 + Math.abs(state.speed) * 0.02)
        positions.setZ(i, original.getZ(i) + billowAmount)
      }
      positions.needsUpdate = true
    }
  }

  function setFromState(s) {
    state.x = s.x
    state.z = s.z
    state.heading = s.heading
    state.speed = s.speed
  }

  function getState() {
    return {...state}
  }

  function dispose() {
    scene.remove(group)
  }

  return {group, state, update, setFromState, getState, dispose}
}
