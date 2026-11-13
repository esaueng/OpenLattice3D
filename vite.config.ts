import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Keep in sync with public/_headers, which production (Cloudflare static
// assets) serves. Workers and the notification service worker are same-origin
// files, downloads are blob: object URLs opened by an anchor (a navigation, not
// a fetch), the stylesheet embeds data: SVG icons, and React sets inline styles
// through the CSSOM, which style-src does not restrict. No eval, no inline
// script or style, no third-party origins: models never leave the browser.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}

const vendorChunk = (packages: string) => new RegExp(`[\\\\/]node_modules[\\\\/](?:${packages})[\\\\/]`)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev stays without a CSP: Vite HMR injects inline scripts and styles.
    headers: { ...crossOriginIsolationHeaders, ...securityHeaders },
  },
  preview: {
    headers: {
      ...crossOriginIsolationHeaders,
      ...securityHeaders,
      'Content-Security-Policy': contentSecurityPolicy,
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Vendor code changes far less often than the app; separate chunks
        // keep it cached across app deploys. Higher priority wins on overlap.
        codeSplitting: {
          groups: [
            { name: 'three', test: vendorChunk('three'), priority: 40 },
            { name: 'react-three', test: vendorChunk('@react-three|three-stdlib|three-mesh-bvh|troika-[^\\\\/]+|camera-controls|maath|meshline|stats-gl|@monogrid|@use-gesture|its-fine|suspend-react'), priority: 30 },
            { name: 'react', test: vendorChunk('react|react-dom|scheduler|zustand|use-sync-external-store'), priority: 20 },
            { name: 'vendor', test: /[\\/]node_modules[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
})
