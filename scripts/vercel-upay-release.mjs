// Deploy the tested prebuilt output and run authenticated, read-only UPay diagnostics.
// Windows credentials stay protected by DPAPI; no credential value is printed or returned.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const project = JSON.parse(fs.readFileSync(path.join(root, '.vercel/project.json'), 'utf8'));
if (!/^prj_[A-Za-z0-9]+$/.test(project.projectId)) throw new Error('Invalid linked Vercel project');
if (process.platform !== 'win32') throw new Error('This release helper uses the current Windows user DPAPI store');
const auth = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'com.vercel.cli/Data/auth.json'), 'utf8'));
if (!auth.token) throw new Error('Sign in to Vercel CLI first');
const vault = path.join(process.env.LOCALAPPDATA, 'GUDEX');
fs.mkdirSync(vault, { recursive: true });

async function vercel(endpoint, options = {}) {
  const response = await fetch(`https://api.vercel.com${endpoint}${endpoint.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(project.orgId)}`, {
    ...options, headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Vercel request failed: HTTP ${response.status}, code ${data.error?.code ?? 'unknown'}`);
  return data;
}

function protectedSecret(key, value) {
  const filename = path.join(vault, `${project.projectId}-${key}.dpapi`);
  const command = value === undefined
    ? "$auditCipher = [Convert]::FromBase64String([IO.File]::ReadAllText($env:GUDEX_SECRET_FILE)); $auditBytes = [Security.Cryptography.ProtectedData]::Unprotect($auditCipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($auditBytes))"
    : "$auditBytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $auditCipher = [Security.Cryptography.ProtectedData]::Protect($auditBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllText($env:GUDEX_SECRET_FILE, [Convert]::ToBase64String($auditCipher))";
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: value, encoding: 'utf8', windowsHide: true, env: { ...process.env, GUDEX_SECRET_FILE: filename },
  });
  if (result.status !== 0) throw new Error(`Could not ${value === undefined ? 'read' : 'protect'} ${key} in the Windows credential file`);
  return value === undefined ? result.stdout.trim() : value;
}

const envs = (await vercel(`/v9/projects/${project.projectId}/env`)).envs;
async function ensureSecret(key, needLocalValue) {
  const existing = envs.some(e => e.key === key && e.target?.includes('production'));
  const filename = path.join(vault, `${project.projectId}-${key}.dpapi`);
  if (existing) {
    if (fs.existsSync(filename)) return protectedSecret(key);
    if (!needLocalValue) return undefined;
    throw new Error(`${key} already exists in Vercel but is not in this Windows credential store; provide a matching credential through your secret manager`);
  }
  const value = protectedSecret(key, randomBytes(32).toString('hex'));
  await vercel(`/v10/projects/${project.projectId}/env`, { method: 'POST', body: JSON.stringify({ key, value, type: 'sensitive', target: ['production'] }) });
  console.log(`${key}: configured as a production secret`);
  return value;
}

const opsToken = await ensureSecret('OPS_API_TOKEN', true);
await ensureSecret('CRON_SECRET', false);

// Prefer an existing local CLI: this script does not install or execute downloaded packages.
const npx = path.join(process.env.LOCALAPPDATA, 'npm-cache/_npx');
const candidates = fs.readdirSync(npx).map(name => path.join(npx, name, 'node_modules/vercel'))
  .filter(folder => fs.existsSync(path.join(folder, 'dist/index.js')))
  .map(folder => ({ folder, version: JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).version }))
  .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
if (!candidates[0]) throw new Error('Install/sign in to Vercel CLI before using this helper');
const cli = path.join(candidates[0].folder, 'dist/index.js');
const deploy = spawnSync(process.execPath, [cli, 'deploy', '--prebuilt', '--prod', '--yes'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'inherit' });
if (deploy.status !== 0) throw new Error('Vercel deployment failed');

const metadata = await vercel(`/v9/projects/${project.projectId}`);
const target = metadata.targets?.production;
if (!target?.url || !target.url.endsWith('.vercel.app')) throw new Error('No verified production deployment URL was returned');
const alias = target.alias?.find(a => a.endsWith('.vercel.app')) ?? target.url;
const base = `https://${alias}`;
const healthResponse = await fetch(`${base}/health`, { signal: AbortSignal.timeout(30000), redirect: 'error' });
const configResponse = await fetch(`${base}/v1/config`, { signal: AbortSignal.timeout(30000), redirect: 'error' });
const publicConfig = await configResponse.json();
if (!healthResponse.ok || !configResponse.ok || !publicConfig.integration) throw new Error('Deployed runtime health/config verification failed');
const check = await fetch(`${base}/v1/ops/upay/check`, { method: 'POST', headers: { Authorization: `Bearer ${opsToken}` },
  signal: AbortSignal.timeout(55000), redirect: 'error' });
const result = await check.json();
const receipt = { checkedAt: new Date().toISOString(), url: base, deployment: target.url,
  healthStatus: healthResponse.status, integration: publicConfig.integration, upayCheckStatus: check.status, upay: result };
fs.writeFileSync(path.join(root, '.vercel/last-upay-check.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
if (!check.ok) process.exitCode = 2;
if (process.argv.includes('--contracts')) {
  const probe = await fetch(`${base}/v1/ops/upay/contracts`, { headers: { Authorization: `Bearer ${opsToken}` },
    signal: AbortSignal.timeout(55000), redirect: 'error' });
  const contracts = await probe.json();
  fs.writeFileSync(path.join(root, '.vercel/last-upay-contracts.json'), JSON.stringify(contracts, null, 2));
  console.log(JSON.stringify({ contractsStatus: probe.status, contracts }, null, 2));
  if (!probe.ok) process.exitCode = 2;
}
