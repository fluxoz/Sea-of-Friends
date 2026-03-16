import * as THREE from 'three'

export function createEngine(canvas) {
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true})
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.5

  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x0a1e3c, 0.0008)

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    1,
    20000
  )
  camera.position.set(0, 40, 80)

  const clock = new THREE.Clock()

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  return {renderer, scene, camera, clock}
}
