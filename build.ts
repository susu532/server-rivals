import * as esbuild from 'esbuild';

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/index.cjs',
  format: 'cjs',
  external: ['express', 'socket.io', 'cannon-es', 'vite'],
}).catch(() => process.exit(1));
