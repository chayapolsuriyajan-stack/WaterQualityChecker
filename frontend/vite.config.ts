import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/ws/app': {
        target: 'ws://localhost:8080',
        ws: true,
      },
      '/history': 'http://localhost:8080',
      '/calibration': 'http://localhost:8080',
      '/update': 'http://localhost:8080',
    },
  },
})
