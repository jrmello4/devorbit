import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'node:path'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: [
                'electron',
                'electron-updater',
                'koffi',
                'node:child_process',
                'node-pty',
                'node:fs',
                'node:fs/promises',
                'node:module',
                'node:path',
                'node:os',
                'node:url',
              ],
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          plugins: [
            {
              name: 'preload-force-cjs',
              // O package.json é "type": "module", então o default do
              // vite-plugin-electron é formats:['es']; o mergeConfig do Vite
              // CONCATENA arrays e o ['cjs'] abaixo vira ['es','cjs'] — os dois
              // bundles caem no mesmo index.cjs e, no dev, o ESM pode escrever
              // por último ("Cannot use import statement outside a module" no
              // preload). Força só CJS depois do merge.
              config(config) {
                const lib = config.build?.lib
                if (lib && 'formats' in lib) {
                  lib.formats = ['cjs']
                }
              },
            },
          ],
          build: {
            lib: {
              entry: 'src/preload/index.ts',
              formats: ['cjs'],
              fileName: () => 'index.cjs',
            },
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
