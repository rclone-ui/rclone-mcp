import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    sourcemap: true,
    clean: true,
    target: 'node22',
    platform: 'node',
    treeshake: true,
    minify: false,
    banner: {
        js: '#!/usr/bin/env node',
    },
})
