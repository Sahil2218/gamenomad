import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so a production build works from any folder.
  base: './',
  server: { port: 5173 },
});
