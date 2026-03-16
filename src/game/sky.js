import * as THREE from 'three'

export function createSky(scene) {
  const skyGeo = new THREE.SphereGeometry(9000, 32, 15)
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      void main() {
        float h = normalize(vWorldPos).y;
        vec3 low  = vec3(0.02, 0.04, 0.12);
        vec3 mid  = vec3(0.04, 0.12, 0.30);
        vec3 high = vec3(0.01, 0.01, 0.04);
        vec3 color = mix(low, mid, smoothstep(0.0, 0.25, h));
        color = mix(color, high, smoothstep(0.25, 0.9, h));

        // horizon glow
        float glow = exp(-8.0 * abs(h));
        color += vec3(0.12, 0.08, 0.04) * glow;

        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  })

  const sky = new THREE.Mesh(skyGeo, skyMat)
  scene.add(sky)

  // Ambient + directional lights
  const ambient = new THREE.AmbientLight(0x223355, 0.6)
  scene.add(ambient)

  const sun = new THREE.DirectionalLight(0xffeedd, 1.2)
  sun.position.set(200, 300, 400)
  scene.add(sun)

  return {sky, sun}
}
