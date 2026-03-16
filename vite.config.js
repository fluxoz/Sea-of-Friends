<<<<<<< HEAD
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
  },
  build: {
    target: 'esnext',
=======
import {defineConfig} from 'vite'

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
  },
  server: {
    open: false,
>>>>>>> master
  },
})
