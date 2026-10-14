import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  // Dual ESM + CJS. The core is isomorphic and dependency-free, so both
  // formats build cleanly. The CJS output gives a `require` entry that
  // CJS-first resolvers (e.g. tsx's tsconfig-paths) can find — without it,
  // consuming apps that run TS via tsx fail with ERR_PACKAGE_PATH_NOT_EXPORTED.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});
