import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      include: ['path', 'fs', 'crypto', 'stream', 'buffer', 'process', 'util', 'events', 'constants', 'os', 'vm', 'net']
    }),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5000000, // Increase limit to 5MB
        navigateFallbackDenylist: [/^\/api\//],  // Don't intercept API routes
      },
      manifest: {
        name: 'Cloud Space',
        short_name: 'Cloud Space',
        description: 'Unlimited Cloud Storage powered by Telegram',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ],
  resolve: {
    alias: {
      net: 'net-browserify',
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      path: 'path-browserify',
      fs: 'browserify-fs'
    }
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    },
    watch: {
      // Ignore runtime files written by admin-tg-server.mjs so Vite
      // doesn't trigger HMR reloads when these files change during uploads
      ignored: [
        '**/.simple-user-meta.json',
        '**/.tmp-uploads/**',
      ]
    }
  }
})
