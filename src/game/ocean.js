import * as THREE from 'three'

const OCEAN_VERT = `
uniform float uTime;
varying vec2 vUv;
varying float vElevation;

void main() {
  vUv = uv;
  vec3 pos = position;
  float wave1 = sin(pos.x * 0.02 + uTime * 0.6) * 2.5;
  float wave2 = sin(pos.z * 0.03 + uTime * 0.4) * 1.8;
  float wave3 = sin((pos.x + pos.z) * 0.01 + uTime * 0.8) * 3.0;
  pos.y += wave1 + wave2 + wave3;
  vElevation = pos.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`

const OCEAN_FRAG = `
uniform float uTime;
varying vec2 vUv;
varying float vElevation;

void main() {
  vec3 deep    = vec3(0.01, 0.05, 0.15);
  vec3 surface = vec3(0.02, 0.18, 0.38);
  vec3 foam    = vec3(0.55, 0.72, 0.82);

  float mixVal = smoothstep(-3.0, 5.0, vElevation);
  vec3 color   = mix(deep, surface, mixVal);

  float foamLine = smoothstep(3.8, 5.0, vElevation);
  color = mix(color, foam, foamLine * 0.4);

  gl_FragColor = vec4(color, 0.92);
}
`

export function createOcean(scene) {
  const geometry = new THREE.PlaneGeometry(10000, 10000, 256, 256)
  geometry.rotateX(-Math.PI / 2)

  const uniforms = {uTime: {value: 0}}
  const material = new THREE.ShaderMaterial({
    vertexShader: OCEAN_VERT,
    fragmentShader: OCEAN_FRAG,
    uniforms,
    transparent: true,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = 0
  scene.add(mesh)

  function update(elapsed) {
    uniforms.uTime.value = elapsed
  }

  return {mesh, update}
}
