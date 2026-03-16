const keys = {}

let yaw = 0
let pitch = 0
let isPointerLocked = false

export function initInput(canvas) {
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true
  })
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false
  })

  canvas.addEventListener('click', () => {
    canvas.requestPointerLock()
  })

  document.addEventListener('pointerlockchange', () => {
    isPointerLocked = document.pointerLockElement === canvas
  })

  document.addEventListener('mousemove', (e) => {
    if (!isPointerLocked) return
    yaw -= e.movementX * 0.002
    pitch -= e.movementY * 0.002
    pitch = Math.max(-1.2, Math.min(0.8, pitch))
  })
}

export function getInput() {
  return {
    forward: !!keys['KeyW'],
    backward: !!keys['KeyS'],
    left: !!keys['KeyA'],
    right: !!keys['KeyD'],
    boost: !!keys['Space'],
  }
}

export function getCameraAngles() {
  return {yaw, pitch}
}

export function hasPointerLock() {
  return isPointerLocked
}
