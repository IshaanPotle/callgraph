import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: at('.'),
  // The committed run artifacts *are* the public directory. There is no server
  // and no API: the UI reads the same JSON the pipeline wrote, which is what
  // makes `git clone && npm run dev` show a real run with no key and no network.
  publicDir: at('../artifacts'),
  build: { outDir: at('../dist'), emptyOutDir: true },
  plugins: [react()],
});
