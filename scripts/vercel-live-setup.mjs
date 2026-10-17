// Prepare an isolated database and production-only configuration without exporting existing secrets.
// The new database role credential is generated locally and protected by Windows DPAPI.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const project = JSON.parse(fs.readFileSync(path.join(root, '.vercel/project.json')));
const auth = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'com.vercel.cli/Data/auth.json')));
if (!auth.token || !/^prj_[A-Za-z0-9]+$/.test(project.projectId)) throw new Error('Linked Vercel authentication is required');
async function api(endpoint, options = {}) {
  const response = await fetch(`https://api.vercel.com${endpoint}${endpoint.includes('?') ? '&' : '?'}teamId=${project.orgId}`, {
    ...options, headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Vercel request failed: ${response.status} ${result.error?.code ?? ''}`);
  return result;
}
function secret(key, create = false) {
  const filename = path.join(process.env.LOCALAPPDATA, 'GUDEX', `${project.projectId}-${key}.dpapi`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const exists = fs.existsSync(filename);
  if (!exists && !create) throw new Error(`Missing local protected ${key}`);
  const value = exists ? undefined : randomBytes(32).toString('hex');
  const command = exists
    ? "$setupCipher=[Convert]::FromBase64String([IO.File]::ReadAllText($env:GUDEX_SECRET_FILE)); $setupBytes=[Security.Cryptography.ProtectedData]::Unprotect($setupCipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($setupBytes))"
    : "$setupBytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $setupCipher=[Security.Cryptography.ProtectedData]::Protect($setupBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllText($env:GUDEX_SECRET_FILE,[Convert]::ToBase64String($setupCipher))";
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input: value, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GUDEX_SECRET_FILE: filename } });
  if (result.status !== 0) throw new Error(`Protected ${key} is unavailable`);
  return exists ? result.stdout.trim() : value;
}
async function setProduction(key, value, sensitive = false) {
  const env = (await api(`/v9/projects/${project.projectId}/env`)).envs.find(item => item.key === key && item.target?.includes('production'));
  const type = sensitive || env?.type === 'sensitive' ? 'sensitive' : 'encrypted';
  if (env && env.target.length > 1) {
    await api(`/v9/projects/${project.projectId}/env/${env.id}`, { method: 'PATCH', body: JSON.stringify({ target: env.target.filter(target => target !== 'production') }) });
  } else if (env) {
    await api(`/v9/projects/${project.projectId}/env/${env.id}`, { method: 'PATCH', body: JSON.stringify({ value, type, target: ['production'] }) });
    return;
  }
  await api(`/v10/projects/${project.projectId}/env`, { method: 'POST', body: JSON.stringify({ key, value, type, target: ['production'] }) });
}
const action = process.argv[2];
// These fixed, OPS-authenticated observations do not need deployment-control access.
// Other actions still require the Vercel project lookup and its normal permissions.
const directObservation = action === 'card-status' || action === 'card-provider-status';
const metadata = directObservation ? null : await api(`/v9/projects/${project.projectId}`);
const alias = directObservation ? 'gudex-seven.vercel.app'
  : metadata.targets.production.alias.find(value => value === 'gudex-seven.vercel.app');
if (!alias) throw new Error('The expected production alias is missing');
const base = `https://${alias}`;
async function authorized(endpoint, body) {
  const response = await fetch(`${base}${endpoint}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${secret('OPS_API_TOKEN')}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(55000), redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new Error(`Operator request failed: HTTP ${response.status} ${result.error?.code ?? ''}`);
  return result;
}
const ops = (endpoint, body) => authorized(`/v1/ops${endpoint}`, body);
const databaseKeys = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL_NON_POOLING', 'POSTGRES_URL_NO_SSL', 'PGHOST', 'POSTGRES_HOST', 'PGHOST_UNPOOLED',
  'PGUSER', 'POSTGRES_USER', 'PGDATABASE', 'POSTGRES_DATABASE', 'PGPASSWORD', 'POSTGRES_PASSWORD'];
const rollbackFile = path.join(root, '.vercel/live-db-rollback.json');
async function requireNoPreviews() {
  let until;
  do {
    const page = await api(`/v6/deployments?projectId=${project.projectId}&limit=100${until ? `&until=${until}` : ''}`);
    if (page.deployments.some(item => item.target !== 'production')) throw new Error('Existing preview deployments require separate database isolation before activation');
    until = page.pagination?.next;
  } while (until);
}
function productionOnly(env) {
  return env.target?.length === 1 && env.target[0] === 'production' && !env.gitBranch && !env.customEnvironmentIds?.length;
}
async function setLiveDatabaseValue(key, value) {
  const envs = (await api(`/v9/projects/${project.projectId}/env`)).envs;
  const sources = envs.filter(item => item.key === key);
  if (sources.length > 1) throw new Error(`Duplicate database variable metadata: ${key}`);
  if (sources.length) {
    if (sources[0].gitBranch || sources[0].customEnvironmentIds?.length) throw new Error(`Branch-specific database metadata requires isolation: ${key}`);
    // Sensitive keys cannot be renamed. Replace only project configuration;
    // immutable trusted production deployments keep their original runtime configuration.
    await api(`/v9/projects/${project.projectId}/env/${sources[0].id}`, { method: 'PATCH',
      body: JSON.stringify({ value, type: 'sensitive', target: ['production'] }) });
    return;
  }
  await setProduction(key, value, true);
}
async function verifyDatabaseTargets() {
  const envs = (await api(`/v9/projects/${project.projectId}/env`)).envs;
  for (const key of databaseKeys) {
    const live = envs.filter(item => item.key === key);
    if (live.length !== 1 || !productionOnly(live[0]) || envs.some(item => item.key === `DEMO_${key}`)) {
      throw new Error(`Database production-only postcondition failed: ${key}`);
    }
  }
}
async function preserveRollbackDeployment() {
  if (fs.existsSync(rollbackFile)) {
    const saved = JSON.parse(fs.readFileSync(rollbackFile));
    const deployment = await api(`/v13/deployments/${saved.deploymentId}`);
    if (deployment.readyState !== 'READY' || deployment.target !== 'production' || deployment.projectId !== project.projectId) throw new Error('Original production rollback deployment is unavailable');
    return;
  }
  const deploymentId = metadata.targets.production.id;
  const deployment = await api(`/v13/deployments/${deploymentId}`);
  if (deployment.readyState !== 'READY' || deployment.target !== 'production' || deployment.projectId !== project.projectId) throw new Error('A trusted production rollback deployment is required');
  fs.writeFileSync(rollbackFile, JSON.stringify({ savedAt: new Date().toISOString(), deploymentId, url: deployment.url,
    note: 'Immutable deployment retains original runtime configuration. Original database and administrator role remain untouched.' }, null, 2));
}
if (action === 'enable-setup') {
  await setProduction('LIVE_DATABASE_SETUP_ENABLED', 'true');
  console.log('One-time database setup enabled for the next production deployment. Financial flags unchanged.');
} else if (action === 'check') {
  const check = await ops('/upay/check', {});
  const status = await ops('/status');
  const wallet = await ops('/upay/wallet/check');
  const database = await ops('/database/status');
  const result = { checkedAt: new Date().toISOString(), check, status, wallet, database };
  fs.writeFileSync(path.join(root, '.vercel/live-readiness.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'access') {
  const result = await ops('/upay/access/check');
  fs.writeFileSync(path.join(root, '.vercel/upay-access-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'bot-status') {
  console.log(JSON.stringify(await authorized('/v1/telegram/status'), null, 2));
} else if (action === 'upay-check') {
  console.log(JSON.stringify(await ops('/upay/check', {}), null, 2));
} else if (action === 'inspect-test-reset' || action === 'reset-test-account') {
  const telegramId = process.argv[3];
  if (telegramId !== '514468501') throw new Error('Only the explicitly authorized personal test account can be reset');
  const endpoint = `/test-account/${telegramId}/reset`;
  const inspection = await ops(endpoint);
  let result = inspection;
  if (action === 'reset-test-account') {
    if (inspection.status !== 'eligible' || !inspection.userId) throw new Error('The personal test account is not eligible for an unfunded reset');
    result = await ops(endpoint, { expectedUserId: inspection.userId, expectedSubmissionId: inspection.submissionId,
      confirmation: 'DELETE_ONLY_MY_UNFUNDED_GUDEX_TEST_ACCOUNT' });
  }
  // Keep personal identity, internal account IDs and the old generation out of the receipt.
  const { userId, submissionId, ...safe } = result;
  const resetReceipt = action === 'reset-test-account' ? 'test-account-reset.json' : 'test-account-reset-inspection.json';
  fs.writeFileSync(path.join(root, `.vercel/${resetReceipt}`), JSON.stringify({ checkedAt: new Date().toISOString(), ...safe }, null, 2));
  console.log(JSON.stringify(safe, null, 2));
} else if (action === 'inspect-existing-kyc' || action === 'resume-existing-kyc') {
  const telegramId = process.argv[3];
  if (telegramId !== '514468501') throw new Error('Only the explicitly authorized personal verification may be resumed');
  const endpoint = `/kyc/${telegramId}/existing-customer`;
  const inspection = await ops(endpoint);
  let result = inspection;
  if (action === 'resume-existing-kyc') {
    if (inspection.eligible !== true || !inspection.snapshot) throw new Error('The existing customer binding is not eligible');
    result = await ops(endpoint, { expected: inspection.snapshot,
      confirmation: 'USE_MY_PREVIOUS_UPAY_CUSTOMER_AND_SUBMIT_CURRENT_KYC' });
  }
  const { snapshot, ...safe } = result;
  const filename = action === 'resume-existing-kyc' ? 'kyc-existing-customer-resume.json' : 'kyc-existing-customer-inspection.json';
  fs.writeFileSync(path.join(root, `.vercel/${filename}`), JSON.stringify({ checkedAt: new Date().toISOString(), ...safe }, null, 2));
  console.log(JSON.stringify(safe, null, 2));
} else if (action === 'card-status' || action === 'card-provider-status' || action === 'card-recheck') {
  const operationId = process.argv[3];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId ?? '')) throw new Error('A current card operation UUID is required');
  const result = action === 'card-recheck' ? await ops(`/cards/${operationId}/reconcile`, {})
    : await ops(`/cards/${operationId}/${action === 'card-provider-status' ? 'provider-status' : 'status'}`);
  const safe = action !== 'card-recheck' ? result : {
    type: result.type, status: result.status, fundingSource: result.fundingSource,
    amount: result.amount, fee: result.fee, createdAt: result.createdAt,
    remoteMutationsPerformed: false,
  };
  fs.writeFileSync(path.join(root, `.vercel/${action === 'card-provider-status' ? 'card-provider-status' : 'card-operation-status'}.json`), JSON.stringify({ checkedAt: new Date().toISOString(), ...safe }, null, 2));
  const auditSummary = value => {
    if (!value) return value;
    const { items = [], ...summary } = value;
    return { ...summary, matchingOperators: items.filter(item => item.operatorMatchesLogin).length,
      customerMentions: items.filter(item => item.ownCustomerMentioned).length,
      endpointMentions: items.filter(item => item.endpointMentioned).length,
      fieldTypePatterns: [...new Set(items.map(item => JSON.stringify(item.fieldTypes)))].map(item => JSON.parse(item)) };
  };
  console.log(JSON.stringify(action === 'card-provider-status' ? { ...safe,
    audit: auditSummary(safe.audit), auditHistoryPreview: auditSummary(safe.auditHistoryPreview) } : safe, null, 2));
} else if (action === 'inspect-kyc-subject' || action === 'attest-kyc-subject') {
  const telegramId = process.argv[3];
  if (telegramId !== '514468501') throw new Error('Only the explicitly authorized personal verification may be attested');
  const endpoint = `/kyc/${telegramId}/subject-attestation`;
  const inspection = await ops(endpoint);
  let result = inspection;
  if (action === 'attest-kyc-subject') {
    const [observedBeforeAt, observedReviewAt] = process.argv.slice(4, 6);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    if (!inspection.eligible || !inspection.snapshot || !iso.test(observedBeforeAt ?? '') || !iso.test(observedReviewAt ?? '') ||
        !Number.isFinite(Date.parse(observedBeforeAt)) || !Number.isFinite(Date.parse(observedReviewAt))) {
      throw new Error('A current eligible snapshot and two previously observed UTC transition cutoffs are required');
    }
    result = await ops(endpoint, { expected: inspection.snapshot, observedBeforeAt, observedReviewAt,
      confirmation: 'RECORD_MY_OBSERVED_PRIMARY_KYC_TRANSITION' });
  }
  // This records an operator observation; the regular verifier must still read the current bank status.
  // Never persist the private expected snapshot, account identifiers or request hash in CLI receipts.
  const checks = Object.fromEntries(Object.entries(result.checks ?? {}).filter(([key, value]) =>
    /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(key) && typeof value === 'boolean'));
  const safe = { checkedAt: new Date().toISOString(),
    status: ['eligible', 'recorded', 'already_recorded', 'unknown'].includes(result.status) ? result.status : 'unconfirmed',
    ...(typeof result.eligible === 'boolean' ? { eligible: result.eligible } : {}),
    ...(typeof result.recorded === 'boolean' ? { recorded: result.recorded } : {}),
    remoteMutationsPerformed: false, approvalGranted: false, checks };
  const filename = action === 'attest-kyc-subject' ? 'kyc-subject-attestation.json' : 'kyc-subject-inspection.json';
  fs.writeFileSync(path.join(root, `.vercel/${filename}`), JSON.stringify(safe, null, 2));
  console.log(JSON.stringify(safe, null, 2));
} else if (action === 'kyc-status' || action === 'kyc-recheck') {
  const telegramId = process.argv[3];
  if (!/^[1-9]\d{0,15}$/.test(telegramId ?? '')) throw new Error('An authorized Telegram ID is required');
  const result = action === 'kyc-recheck' ? await ops(`/kyc/${telegramId}/recheck`, {}) :
    await ops(`/kyc/${telegramId}${process.argv.includes('--customer-binding') ? '?customerBinding=1' : ''}`);
  fs.writeFileSync(path.join(root, '.vercel/kyc-status.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'sponsor-issue') {
  const telegramId = process.argv[3];
  if (!/^[1-9]\d{0,15}$/.test(telegramId ?? '')) throw new Error('An explicitly authorized Telegram ID is required');
  const result = await ops('/card-issue-sponsorships', {
    telegramId, reason: 'Owner-authorized personal end-to-end test; one first issuance funded by the broker, maximum 10 USD',
  });
  fs.writeFileSync(path.join(root, '.vercel/issue-sponsorship.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'status') {
  const status = await ops('/status');
  const database = await ops('/database/status');
  const result = { checkedAt: new Date().toISOString(), status, database };
  fs.writeFileSync(path.join(root, '.vercel/live-runtime-status.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'verify') {
  await requireNoPreviews();
  await verifyDatabaseTargets();
  const config = await (await fetch(`${base}/v1/config`, { signal: AbortSignal.timeout(30000), redirect: 'error' })).json();
  const fundingBoundary = config.integration?.deposits === 'disabled' && config.integration?.depositFlow === 'disabled'
    || config.integration?.deposits === 'live' && config.integration?.depositFlow === 'checkout';
  if (config.devTools !== false || config.integration?.cardPartner !== 'upay' || !fundingBoundary || config.integration.withdrawals !== 'disabled') throw new Error('Unexpected live provider boundaries');
  const checks = [];
  for (const [endpoint, method, authorized, expected] of [
    ['/v1/ops/status', 'GET', false, 401], ['/v1/cron', 'GET', false, 401],
    ['/v1/kyc', 'POST', false, 401], ['/v1/dev/deposit', 'POST', false, 404],
    ['/v1/deposit-invoices/options', 'GET', false, 401], ['/v1/deposit-invoices/active', 'GET', false, 401],
    ['/v1/deposit-invoices', 'POST', false, 401],
    ['/v1/cards/additional-attempt-quote', 'GET', false, 401], ['/v1/cards/additional-attempt', 'POST', false, 401],
    ['/v1/cards/issue-quote?asset=USDT', 'GET', false, 401],
    ['/v1/ops/card-issue-sponsorships', 'POST', false, 401],
    ['/v1/ops/test-account/514468501/reset', 'GET', false, 401],
    ['/v1/ops/test-account/514468501/reset', 'POST', false, 401],
    ['/v1/ops/kyc/514468501/existing-customer', 'GET', false, 401],
    ['/v1/ops/kyc/514468501/existing-customer', 'POST', false, 401],
    ['/v1/ops/kyc/514468501/subject-attestation', 'GET', false, 401],
    ['/v1/ops/kyc/514468501/subject-attestation', 'POST', false, 401],
      ['/v1/ops/cards/00000000-0000-4000-8000-000000000001/status', 'GET', false, 401],
      ['/v1/ops/cards/00000000-0000-4000-8000-000000000001/provider-status', 'GET', false, 401],
    ['/v1/ops/database/prepare-live', 'POST', true, 404],
  ]) {
    const response = await fetch(`${base}${endpoint}`, { method, headers: { 'Content-Type': 'application/json',
      ...(authorized ? { Authorization: `Bearer ${secret('OPS_API_TOKEN')}` } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(30000), redirect: 'error' });
    checks.push({ endpoint, status: response.status });
    if (response.status !== expected) throw new Error(`Unexpected route guard: ${endpoint} HTTP ${response.status}`);
  }
  const database = await ops('/database/status');
  if (database.database !== 'gudex_live' || database.mode !== 'live' || database.demo_deposits !== 0 || database.demo_cards !== 0 ||
    database.sponsorship_guard_triggers !== 3 || database.additional_issue_guard_triggers !== 6 || database.invoice_guard_triggers !== 1 || database.issuance_alias_guard_triggers !== 2
    || Object.values(database.privileges ?? {}).some(Boolean)) throw new Error('Unexpected live database isolation or missing financial guards');
  const result = { checkedAt: new Date().toISOString(), credentialsProductionOnly: true, config: config.integration,
    devTools: config.devTools, checks, database };
  fs.writeFileSync(path.join(root, '.vercel/live-guard-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'check-payment-password') {
  // Explicit action: exactly one non-financial PIN validation, never a dummy withdrawal or issuance.
  const result = await ops('/upay/payment-password/check', {});
  fs.writeFileSync(path.join(root, '.vercel/payment-password-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...result }));
  console.log(JSON.stringify(result));
} else if (action === 'provision') {
  const validation = JSON.parse(fs.readFileSync(path.join(root, '.vercel/payment-password-check.json')));
  const validationAge = Date.now() - Date.parse(validation.checkedAt);
  if (validation.valid !== true || !Number.isFinite(validationAge) || validationAge < 0 || validationAge > 3600000) throw new Error('A recent successful PIN check is required');
  await requireNoPreviews();
  await preserveRollbackDeployment();
  const rolePassword = secret('LIVE_DATABASE_ROLE_PASSWORD', true);
  const result = await ops('/database/prepare-live', { rolePassword });
  if (result.database !== 'gudex_live' || result.role !== 'gudex_live_owner' || !result.host?.endsWith('.neon.tech') || !result.pooledHost?.endsWith('.neon.tech')) throw new Error('Unexpected database preparation result');
  const unpooled = new URL(`postgresql://${result.host}:${result.port}/${result.database}?sslmode=require`);
  unpooled.username = result.role; unpooled.password = rolePassword;
  const pooled = new URL(unpooled); pooled.hostname = result.pooledHost;
  const values = {
    DATABASE_URL: pooled.toString(), POSTGRES_URL: pooled.toString(), POSTGRES_PRISMA_URL: pooled.toString(),
    DATABASE_URL_UNPOOLED: unpooled.toString(), POSTGRES_URL_NON_POOLING: unpooled.toString(),
    POSTGRES_URL_NO_SSL: pooled.toString(), PGHOST: result.pooledHost, POSTGRES_HOST: result.pooledHost,
    PGHOST_UNPOOLED: result.host, PGUSER: result.role, POSTGRES_USER: result.role,
    PGDATABASE: result.database, POSTGRES_DATABASE: result.database, PGPASSWORD: rolePassword, POSTGRES_PASSWORD: rolePassword,
  };
  for (const [key, value] of Object.entries(values)) await setLiveDatabaseValue(key, value);
  await requireNoPreviews();
  await verifyDatabaseTargets();
  await setProduction('LIVE_DATABASE_SETUP_ENABLED', 'false');
  await setProduction('CARD_PARTNER', 'upay');
  await setProduction('DEV_TOOLS', 'false');
  await setProduction('DEV_LOGIN', 'false');
  await setProduction('UPAY_KYC_ENABLED', 'true');
  await setProduction('UPAY_WRITES_ENABLED', 'true');
  fs.writeFileSync(path.join(root, '.vercel/live-database-setup.json'), JSON.stringify({ preparedAt: new Date().toISOString(), database: result.database,
    role: result.role, originalDataPreserved: result.originalDataPreserved, created: result.created, credentialsProductionOnly: true }, null, 2));
  console.log('Live database and restricted role prepared; original demo database preserved. Production-only variables configured. Redeploy to activate.');
} else throw new Error('Choose enable-setup, check, access, bot-status, upay-check, inspect-test-reset <Telegram ID>, reset-test-account <Telegram ID>, inspect-existing-kyc <Telegram ID>, resume-existing-kyc <Telegram ID>, inspect-kyc-subject <Telegram ID>, attest-kyc-subject <Telegram ID> <observedBeforeAt UTC> <observedReviewAt UTC>, kyc-status <Telegram ID> [--customer-binding], kyc-recheck <Telegram ID>, sponsor-issue <Telegram ID>, status, verify, check-payment-password or provision');
