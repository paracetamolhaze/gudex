// Сборка для Vercel (Build Output API v3): статика Mini App + API одной serverless-функцией.
// Деплой: `npm run vercel:build`, затем `npx vercel deploy --prebuilt --prod`.
import { execSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.vercel', 'output');
const fn = path.join(out, 'functions', 'api.func');
const cronSchedule = process.env.GUDEX_CRON_SCHEDULE?.trim() || '0 4 * * *';
const cronBounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const cronFields = cronSchedule.split(/\s+/);
const validCronField = (field, [min, max]) => field.split(',').every(part => {
  const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
  if (!match || (match[2] && Number(match[2]) < 1)) return false;
  if (match[1] === '*') return true;
  const [start, end = start] = match[1].split('-').map(Number);
  return start >= min && end <= max && start <= end;
});
if (cronFields.length !== 5 || !cronFields.every((field, i) => validCronField(field, cronBounds[i]))) {
  throw new Error('GUDEX_CRON_SCHEDULE must be a valid numeric five-field cron expression');
}
const deployedCronSchedule = cronFields.join(' ');

// Windows can keep the output directory itself open while watching files.
// Preserve that directory and clear only its checked descendants.
if (!out.startsWith(`${root}${path.sep}`)) throw new Error('Build output must remain inside the workspace');
await mkdir(out, { recursive: true });
for (const name of await readdir(out)) {
  const target = path.resolve(out, name);
  if (!target.startsWith(`${out}${path.sep}`)) throw new Error('Invalid build output descendant');
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
await mkdir(fn, { recursive: true });

// 1. Mini App — статические файлы.
execSync('npm run build -w @gudex/miniapp', { cwd: root, stdio: 'inherit' });
await cp(path.join(root, 'apps', 'miniapp', 'dist'), path.join(out, 'static'), { recursive: true });

// 2. API — один ESM-файл со всеми зависимостями + SQL-миграции рядом.
await build({
  entryPoints: [path.join(root, 'apps', 'api', 'src', 'serverless.ts')],
  outfile: path.join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['pg-native'],
  define: { 'process.env.GUDEX_CRON_SCHEDULE': JSON.stringify(deployedCronSchedule) },
  // CommonJS-зависимости внутри ESM-бандла ждут require/__dirname.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
});
await cp(path.join(root, 'apps', 'api', 'drizzle'), path.join(fn, 'drizzle'), { recursive: true });
await writeFile(
  path.join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      maxDuration: 60,
      // Франкфурт — ближе всего к пользователям из СНГ; база Neon должна быть там же.
      regions: ['fra1'],
    },
    null,
    2,
  ),
);

// 3. Маршруты: API → функция, файлы → как есть, остальное → index.html (одностраничное приложение).
await writeFile(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: '^/(v1|health)(/.*)?$', dest: '/api' }, { handle: 'filesystem' }, { src: '/.*', dest: '/index.html' }],
      // Daily is the safe staging default; Vercel Pro live builds may use '* * * * *'.
      crons: [{ path: '/v1/cron', schedule: deployedCronSchedule }],
    },
    null,
    2,
  ),
);

console.log(`Vercel output ready: ${path.relative(root, out)}`);
