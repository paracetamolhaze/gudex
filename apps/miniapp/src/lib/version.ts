// vite.config.ts replaces __APP_VERSION__ with the package.json version; tests run without it.
declare const __APP_VERSION__: string | undefined;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
