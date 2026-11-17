/** Development entry point (`pnpm dev`): defaults NODE_ENV to development. */
process.env.NODE_ENV ??= 'development';
await import('./index.js');
export {};
