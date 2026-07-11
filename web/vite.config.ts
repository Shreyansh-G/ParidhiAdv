import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the big vendors into parallel-loadable chunks (three.js
        // already lives in the lazy Project3DViewer chunk — leave it there).
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('three') || id.includes('@react-three')) return undefined
          if (id.includes('firebase')) return 'firebase'
          if (id.includes('leaflet') || id.includes('supercluster')) return 'map'
          if (id.includes('framer-motion')) return 'motion'
          if (id.includes('react')) return 'react-vendor'
          return undefined
        },
      },
    },
  },
})
