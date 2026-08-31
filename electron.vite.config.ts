import react from '@vitejs/plugin-react'
import { defineConfig,externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

const secureEsbuildOptions = {
  legalComments: 'none' as const,
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
  keepNames: false
}

export default defineConfig({
  main: {
    esbuild: secureEsbuildOptions,
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      minify: true,
      rollupOptions: {
        output: {
          compact: true
        }
      }
    }
  },
  preload: {
    esbuild: secureEsbuildOptions,
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      minify: true,
      rollupOptions: {
        output: {
          compact: true
        }
      }
    }
  },
  renderer: {
    esbuild: secureEsbuildOptions,
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      target: 'chrome120',
      sourcemap: false,
      minify: 'esbuild',
      chunkSizeWarningLimit: 2400,
      rollupOptions: {
        output: {
          compact: true
        }
      }
    },
    server: {
      host: '127.0.0.1',
      port: 39217,
      strictPort: true,
      hmr: {
        overlay: false
      }
    }
  }
})
