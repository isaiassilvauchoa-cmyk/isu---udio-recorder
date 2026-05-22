import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [
      react(), 
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'ÍSU Áudio Recorder',
          short_name: 'ÍSU Áudio',
          description: 'Professional Audio Recorder',
          theme_color: '#09090b',
          background_color: '#09090b',
          display: 'standalone',
          orientation: 'portrait',
          icons: [
            {
              src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgZmlsbD0iIzA5MDkwYiIvPjxwYXRoIGQ9Ik0yNTYgMTI4djI1Nk0xOTIgMTkydjEyOE0zMjAgMTkydjEyOE0xMjggMjU2aDI1NiIgc3Ryb2tlPSIjZjU5ZTBiIiBzdHJva2Utd2lkdGg9IjMyIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz4=',
              sizes: '192x192',
              type: 'image/svg+xml'
            },
            {
              src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgZmlsbD0iIzA5MDkwYiIvPjxwYXRoIGQ9Ik0yNTYgMTI4djI1Nk0xOTIgMTkydjEyOE0zMjAgMTkydjEyOE0xMjggMjU2aDI1NiIgc3Ryb2tlPSIjZjU5ZTBiIiBzdHJva2Utd2lkdGg9IjMyIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz4=',
              sizes: '512x512',
              type: 'image/svg+xml'
            }
          ]
        }
      })
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
