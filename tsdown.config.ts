import { defineConfig } from 'tsdown';

// The hosted server imports scenario modules on demand (src/hosted/catalog.ts)
// so a deployment that stages the sources evaluates only what a request needs.
// The CLI still ships as one file: split into chunks, the scenario modules the
// registry also imports statically are evaluated before the base classes they
// extend ("Class extends value undefined").
export default defineConfig({
  outputOptions: { inlineDynamicImports: true }
});
