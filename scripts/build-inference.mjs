import { build } from 'vite';
// Standalone deployment avoids launchd reading dependencies inside macOS protected folders.
await build({
  configFile: false,
  ssr: { noExternal: true },
  build: {
    ssr: 'src/inference-gateway.ts', outDir: 'dist/inference', target: 'node22', minify: false,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'inference-gateway.js' } },
  },
});
