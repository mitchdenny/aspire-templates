import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const commands = new Map([['/deploy-pr', 'deploy'], ['/cleanup-pr', 'cleanup']]);
const workflows = new Map([['pr-command.yml', 'issue_comment'], ['pr-expiry.yml', 'schedule']]);
const hour = 3600_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{40}$/;
const allowed = new Set(['write', 'maintain', 'admin']);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const number = value => {
  requireValue(/^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value)), 'Invalid PR number.');
  return Number(value);
};

export function command(body, userType) {
  return userType === 'User' ? commands.get(body) : undefined;
}

export function target(repositoryId, pr, subscription) {
  requireValue(/^[1-9][0-9]*$/.test(String(repositoryId)) && uuid.test(subscription), 'Invalid deployment identity.');
  const group = `aspire-pr-${repositoryId}-${number(pr)}`;
  return { group, id: `/subscriptions/${subscription}/resourceGroups/${group}` };
}

export function seal(record, key) {
  const bytes = Buffer.from(key ?? '', 'base64');
  requireValue(bytes.length === 32, 'PR_STATE_KEY must be a base64-encoded 32-byte key.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', bytes, iv);
  cipher.setAAD(Buffer.from('aspire-pr-state-v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function unseal(bytes, key) {
  const decoded = Buffer.from(key ?? '', 'base64');
  requireValue(decoded.length === 32 && bytes.length > 28 && bytes.length < 16_000_000, 'Invalid encrypted PR state.');
  const cipher = createDecipheriv('aes-256-gcm', decoded, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from('aspire-pr-state-v1'));
  cipher.setAuthTag(bytes.subarray(12, 28));
  try {
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  } catch {
    throw new Error('PR state authentication failed; no target will be changed.');
  }
}

export function validateRecord(record, repo, pr, subscription) {
  const expected = target(repo.id, pr, subscription);
  requireValue(record.version === 1 && record.repositoryId === repo.id &&
    record.repository === repo.full_name && record.pr === number(pr) &&
    record.subscription === subscription && record.group === expected.group &&
    record.resourceId.toLowerCase() === expected.id.toLowerCase() &&
    uuid.test(record.tenant) && sha.test(record.headSha) &&
    /^[a-f0-9]{32}$/.test(record.deploymentId) &&
    ['active', 'failed', 'deleted'].includes(record.status) &&
    Number.isSafeInteger(record.expiresAt), 'PR state provenance or target mismatch.');
  requireValue(record.files && typeof record.files === 'object', 'Missing native Aspire deployment state.');
  for (const [path, text] of Object.entries(record.files)) {
    requireValue(new RegExp(`^[a-f0-9]{64}/pr-${number(pr)}\\.json(?:\\.migration)?$`, 'i').test(path) &&
      typeof text === 'string', 'Unsafe deployment state path.');
    const check = data => {
      requireValue(data && typeof data === 'object', 'Invalid native deployment state.');
      for (const [key, value] of Object.entries(data)) {
        if (key === 'Azure:ResourceGroup') requireValue(value === expected.group, 'Native state resource group mismatch.');
        if (key === 'Azure:SubscriptionId') requireValue(value === subscription, 'Native state subscription mismatch.');
        if (key === 'Azure:TenantId') requireValue(value === record.tenant, 'Native state tenant mismatch.');
        if (key === 'CurrentState') check(JSON.parse(value));
        else if (value && typeof value === 'object') check(value);
      }
    };
    check(JSON.parse(text));
  }
  return record;
}

export function nativeState(record) {
  const states = Object.entries(record.files).filter(([path]) => path.endsWith('.json'));
  requireValue(states.length === 1, 'Exactly one native Aspire state file is required; refusing teardown.');
  const data = JSON.parse(states[0][1]);
  requireValue(data['Azure:ResourceGroup'] === record.group &&
    data['Azure:SubscriptionId'] === record.subscription &&
    data['Azure:TenantId'] === record.tenant, 'Native Aspire state does not identify the verified target.');
}

export function renewedExpiry(previous, success, now) {
  return success ? now + hour : previous?.expiresAt ?? now + hour;
}

export function cleanupDue(record, action, now) {
  return !!record && record.status !== 'deleted' && (action === 'cleanup' || record.expiresAt <= now);
}

export function verifyProducer(run, repo) {
  const file = run.path.split('/').at(-1);
  requireValue(workflows.get(file) === run.event && run.head_branch === 'main' &&
    run.repository.id === repo.id && run.path === `.github/workflows/${file}`, 'Untrusted PR state producer.');
}

function az(...args) {
  return JSON.parse(execFileSync('az', [...args, '--output', 'json', '--only-show-errors'], { encoding: 'utf8' }));
}

function liveGroup(group, subscription) {
  if (az('group', 'exists', '--name', group, '--subscription', subscription) === false) return null;
  return az('group', 'show', '--name', group, '--subscription', subscription);
}

export function verifyGroup(group, record) {
  requireValue(group.id.toLowerCase() === record.resourceId.toLowerCase() &&
    group.tags?.['aspire-pr-repository-id'] === String(record.repositoryId) &&
    group.tags?.['aspire-pr-number'] === String(record.pr) &&
    group.tags?.['aspire-pr-deployment'] === record.deploymentId, 'Live resource group ownership mismatch.');
}

async function repository(github, context) {
  requireValue(context.serverUrl === 'https://github.com', 'This workflow supports GitHub.com and Azure public cloud only.');
  const { data } = await github.rest.repos.get(context.repo);
  requireValue(data.default_branch === 'main', 'PR workflows require the main default branch.');
  return data;
}

async function permission(github, context, login) {
  const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: login });
  requireValue(allowed.has(data.permission), 'The command requires live write, maintain or admin repository permission.');
}

export async function authorize(github, context, repo) {
  requireValue(context.eventName === 'issue_comment' && context.payload.action === 'created' &&
    context.payload.issue?.pull_request, 'Only new PR issue comments are supported.');
  const action = command(context.payload.comment.body, context.payload.comment.user.type);
  requireValue(action, 'Use exactly /deploy-pr or /cleanup-pr in a human-authored comment.');
  const { data: comment } = await github.rest.issues.getComment({ ...context.repo, comment_id: context.payload.comment.id });
  requireValue(comment.body === context.payload.comment.body &&
    comment.user.id === context.payload.comment.user.id &&
    comment.issue_url === context.payload.issue.url, 'The triggering comment changed or belongs to a different PR.');
  await permission(github, context, comment.user.login);
  await permission(github, context, process.env.GITHUB_TRIGGERING_ACTOR || context.actor);
  const pr = number(context.payload.issue.number);
  const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: pr });
  requireValue(pull.number === pr && pull.base.repo.id === repo.id &&
    pull.base.ref === 'main' && sha.test(pull.head.sha), 'PR target or head identity mismatch.');
  if (action === 'deploy') {
    requireValue(pull.state === 'open' && pull.head.repo?.id === repo.id, 'Deploy requires an open same-repository PR; fork PRs are rejected.');
  }
  return { action, pr, headSha: pull.head.sha };
}

async function statusComment(github, context, text, headSha) {
  const marker = `<!-- aspire-pr-command:${context.payload.comment.id} -->`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: context.payload.issue.number, per_page: 100,
  });
  const existing = comments.find(item => item.user.type === 'Bot' &&
    item.user.login === 'github-actions[bot]' && item.body.startsWith(marker));
  const pinned = existing?.body.match(/<!-- aspire-pr-head:([a-f0-9]{40}) -->/)?.[1];
  requireValue(!pinned || !headSha || pinned === headSha, 'This command already pinned a different head; post a new command.');
  const headMarker = headSha || pinned;
  const body = `${marker}\n${headMarker ? `<!-- aspire-pr-head:${headMarker} -->\n` : ''}${text}` +
    `\n\n[Workflow run](${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId})`;
  if (existing) await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  else await github.rest.issues.createComment({ ...context.repo, issue_number: context.payload.issue.number, body });
}

async function artifacts(github, context, repo) {
  const items = await github.paginate(github.rest.actions.listArtifactsForRepo, { ...context.repo, per_page: 100 });
  return items.filter(item => item.name.startsWith(`aspire-pr-state-${repo.id}-`)).sort((a, b) => b.id - a.id);
}

async function loadArtifact(github, context, repo, artifact, pr) {
  requireValue(!artifact.expired, 'The newest PR deployment record expired; refusing to restore older state.');
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: artifact.workflow_run.id });
  verifyProducer(run, repo);
  const bytes = execFileSync('gh', ['api', `repos/${repo.full_name}/actions/artifacts/${artifact.id}/zip`],
    { maxBuffer: 16_000_000 });
  const archive = join(process.env.RUNNER_TEMP, 'pr-state.zip');
  writeFileSync(archive, bytes, { mode: 0o600 });
  const encrypted = execFileSync('unzip', ['-p', archive, 'state.enc'], { maxBuffer: 16_000_000 });
  return validateRecord(unseal(encrypted, process.env.PR_STATE_KEY), repo, pr, process.env.AZURE_SUBSCRIPTION_ID);
}

async function latest(github, context, repo, pr) {
  const prefix = `aspire-pr-state-${repo.id}-${number(pr)}-`;
  const item = (await artifacts(github, context, repo)).find(artifact => artifact.name.startsWith(prefix));
  return item ? loadArtifact(github, context, repo, item, pr) : null;
}

function localContext() {
  return join(process.env.RUNNER_TEMP, 'pr-operation.json');
}

function files(pr) {
  const base = join(process.env.ASPIRE_HOME, 'deployments');
  const result = {};
  if (!existsSync(base)) return result;
  for (const hash of readdirSync(base)) {
    requireValue(/^[a-f0-9]{64}$/i.test(hash), 'Unexpected Aspire deployment identity.');
    for (const file of readdirSync(join(base, hash))) {
      if (file.endsWith('.lock')) continue;
      requireValue(file === `pr-${pr}.json` || file === `pr-${pr}.json.migration`, 'Unexpected Aspire environment state.');
      result[`${hash}/${file}`] = readFileSync(join(base, hash, file), 'utf8');
    }
  }
  return result;
}

export async function run({ github, context, core }, mode) {
  const repo = await repository(github, context);
  if (mode === 'authorize') {
    const request = await authorize(github, context, repo);
    core.setOutput('action', request.action);
    core.setOutput('pr', request.pr);
    core.setOutput('head_sha', request.headSha);
    await statusComment(github, context, `${request.action === 'deploy' ? 'Deployment' : 'Cleanup'} authorized by live repository permission. ` +
      (request.action === 'deploy' ? `Deploying pinned head \`${request.headSha}\`. This command explicitly trusts that code with the PR Azure identity; no separate approval is required.` :
        'Only the recorded, positively identified PR resource group will be targeted.'),
      request.action === 'deploy' ? request.headSha : undefined);
    return;
  }
  if (mode === 'report') {
    let outcome = process.env.OPERATION_OUTCOME || 'failed or cancelled before a verified result';
    if (process.env.AUTHORIZATION_RESULT !== 'success') outcome = 'authorization or PR validation failed; no deployment authorized';
    else if (process.env.OPERATION_RESULT !== 'success' && ['deployed', 'deleted'].includes(outcome)) {
      outcome = `${outcome}, but the workflow failed afterward; verify state persistence before retrying`;
    }
    let url;
    let reportingError = false;
    if (process.env.AUTHORIZATION_RESULT === 'success' && process.env.VERIFIED_TARGET === 'true') {
      try {
        const pr = number(context.payload.issue.number);
        const prefix = `aspire-pr-state-${repo.id}-${pr}-${context.runId}-`;
        const item = (await artifacts(github, context, repo)).find(artifact => artifact.name.startsWith(prefix));
        requireValue(item, 'The verified deployment record was not persisted.');
        const record = await loadArtifact(github, context, repo, item, pr);
        url = `https://portal.azure.com/#@${record.tenant}/resource${record.resourceId}`;
      } catch {
        reportingError = true;
        outcome += '; verified resource-group record unavailable, recovery required';
      }
    }
    await statusComment(github, context, `PR environment operation: **${outcome}**.` +
      (url ? `\n\n${outcome.startsWith('deleted') ? 'Deleted target (the resource group no longer exists)' : 'Verified resource group'}: [Azure Portal](${url}).` : '') +
      '\n\nSee the run for diagnostics. Credentials and raw logs are omitted.');
    if (reportingError) core.setFailed('Unable to retrieve the authenticated resource-group record for reporting.');
    return;
  }
  requireValue(uuid.test(process.env.AZURE_SUBSCRIPTION_ID ?? '') &&
    uuid.test(process.env.AZURE_TENANT_ID ?? ''), 'Configure the pr environment Azure identity and subscription.');
  seal({}, process.env.PR_STATE_KEY);
  if (mode === 'discover') {
    const selected = new Map();
    for (const item of await artifacts(github, context, repo)) {
      const match = new RegExp(`^aspire-pr-state-${repo.id}-([1-9][0-9]*)-[0-9]+-[0-9]+$`).exec(item.name);
      requireValue(match, 'Malformed PR state artifact name.');
      const pr = number(match[1]);
      if (selected.has(pr)) continue;
      const record = await loadArtifact(github, context, repo, item, pr);
      selected.set(pr, cleanupDue(record, 'expire', Date.now()));
    }
    core.setOutput('prs', JSON.stringify([...selected].filter(([, expired]) => expired).map(([pr]) => pr)));
    return;
  }
  const pr = number(process.env.PR_NUMBER);
  if (mode === 'prepare') {
    const action = process.env.OPERATION;
    requireValue(['deploy', 'cleanup', 'expire'].includes(action), 'Invalid lifecycle operation.');
    if (action !== 'expire') {
      const request = await authorize(github, context, repo);
      requireValue(request.action === action && request.pr === pr &&
        request.headSha === process.env.HEAD_SHA, 'PR head changed after authorization; post a new command.');
    } else requireValue(context.eventName === 'schedule', 'Expiry requires the trusted scheduled workflow.');
    const previous = await latest(github, context, repo, pr);
    const expected = target(repo.id, pr, process.env.AZURE_SUBSCRIPTION_ID);
    const account = az('account', 'show');
    requireValue(account.id === process.env.AZURE_SUBSCRIPTION_ID &&
      account.tenantId === process.env.AZURE_TENANT_ID, 'Authenticated Azure subscription or tenant mismatch.');
    requireValue(!previous || previous.tenant === process.env.AZURE_TENANT_ID, 'Stored tenant changed; restore the original configuration before cleanup.');
    requireValue(!previous || previous.cliVersion === process.env.ASPIRE_VERSION, 'The deployment CLI version changed; clean up with its original version first.');
    const group = liveGroup(expected.group, process.env.AZURE_SUBSCRIPTION_ID);
    if (group) {
      requireValue(previous && previous.status !== 'deleted', 'An existing resource group has no active trusted record; refusing to adopt it.');
      verifyGroup(group, previous);
    }
    const skip = action !== 'deploy' && !cleanupDue(previous, action, Date.now());
    if (!skip && action !== 'deploy' && group) nativeState(previous);
    const record = previous ?? {
      version: 1, repositoryId: repo.id, repository: repo.full_name, pr,
      deploymentId: randomBytes(16).toString('hex'),
      subscription: process.env.AZURE_SUBSCRIPTION_ID, tenant: process.env.AZURE_TENANT_ID,
      group: expected.group, resourceId: expected.id, headSha: process.env.HEAD_SHA,
      status: 'failed', expiresAt: Date.now() + hour, cliVersion: process.env.ASPIRE_VERSION, files: {},
    };
    writeFileSync(localContext(), JSON.stringify({ record, previous, action, skip, absent: !group }), { mode: 0o600 });
    if (!skip && group && previous) {
      for (const [path, text] of Object.entries(previous.files)) {
        const destination = join(process.env.ASPIRE_HOME, 'deployments', path);
        mkdirSync(join(destination, '..'), { recursive: true, mode: 0o700 });
        writeFileSync(destination, text, { mode: 0o600 });
      }
    }
    core.setOutput('execute', !skip && (action === 'deploy' || !!group));
    core.setOutput('resource_group', expected.group);
    return;
  }
  requireValue(mode === 'finalize', 'Unknown lifecycle phase.');
  requireValue(existsSync(localContext()), 'Preflight did not complete; no verified result.');
  const { record, previous, action, skip, absent } = JSON.parse(readFileSync(localContext(), 'utf8'));
  if (skip) {
    core.setOutput('outcome', 'no cleanup needed');
    return;
  }
  let group = liveGroup(record.group, record.subscription);
  const succeeded = process.env.NATIVE_OUTCOME === 'success';
  let outcome = 'failed';
  if (action === 'deploy') {
    record.files = files(pr);
    record.status = succeeded ? 'active' : 'failed';
    record.headSha = process.env.HEAD_SHA;
    record.expiresAt = renewedExpiry(previous, succeeded, Date.now());
    validateRecord(record, repo, pr, record.subscription);
    if (group) {
      nativeState(record);
      if (!absent) verifyGroup(group, record);
      requireValue(group.id.toLowerCase() === record.resourceId.toLowerCase() &&
        group.tags?.aspire === 'true', 'Aspire did not create the expected resource group.');
      group = az('group', 'update', '--name', record.group, '--subscription', record.subscription,
        '--set', `tags.aspire-pr-repository-id=${repo.id}`, `tags.aspire-pr-number=${pr}`,
        `tags.aspire-pr-deployment=${record.deploymentId}`);
      verifyGroup(group, record);
    }
    if (succeeded) requireValue(group, 'Deployment did not produce a verified resource group.');
    outcome = succeeded ? 'deployed' : 'deployment failed; recorded partial state retained';
  } else {
    if (group) verifyGroup(group, record);
    if (succeeded && group) {
      for (let attempt = 0; attempt < 60 && group; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10_000));
        group = liveGroup(record.group, record.subscription);
        if (group) verifyGroup(group, record);
      }
    }
    if (!group) {
      record.status = 'deleted';
      record.files = {};
      outcome = 'deleted';
    } else outcome = succeeded ? 'deletion initiated; still pending, expiry will retry' : 'cleanup failed; state retained for retry';
  }
  mkdirSync(join(process.env.RUNNER_TEMP, 'encrypted-state'), { recursive: true, mode: 0o700 });
  writeFileSync(join(process.env.RUNNER_TEMP, 'encrypted-state/state.enc'), seal(record, process.env.PR_STATE_KEY), { mode: 0o600 });
  core.setOutput('save_state', true);
  core.setOutput('artifact_name', `aspire-pr-state-${repo.id}-${pr}-${context.runId}-${process.env.GITHUB_RUN_ATTEMPT}`);
  core.setOutput('outcome', outcome);
  if (group || outcome === 'deleted') core.setOutput('verified_target', true);
  if (outcome.includes('failed') || outcome.includes('pending')) core.setFailed(outcome);
}
