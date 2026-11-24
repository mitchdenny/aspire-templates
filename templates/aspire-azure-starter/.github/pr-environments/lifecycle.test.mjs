import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { authorize, cleanupDue, command, nativeState, renewedExpiry, run, seal, target, unseal, validateRecord, verifyGroup, verifyProducer } from './lifecycle.mjs';

const subscription = '11111111-1111-1111-1111-111111111111';
const tenant = '22222222-2222-2222-2222-222222222222';
const repo = { id: 123, full_name: 'example/app', default_branch: 'main' };
const headSha = 'a'.repeat(40);
const record = () => ({
  version: 1, repositoryId: repo.id, repository: repo.full_name, pr: 7,
  group: target(repo.id, 7, subscription).group,
  resourceId: target(repo.id, 7, subscription).id,
  subscription, tenant, headSha, deploymentId: 'b'.repeat(32),
  status: 'active', expiresAt: 3600_000, cliVersion: '17.0.0',
  files: { [`${'c'.repeat(64)}/pr-7.json`]: JSON.stringify({
    'Azure:ResourceGroup': 'aspire-pr-123-7', 'Azure:SubscriptionId': subscription, 'Azure:TenantId': tenant,
  }) },
});

function request(permission = 'write', changes = {}) {
  const comment = { id: 9, body: '/deploy-pr', user: { id: 1, login: 'member', type: 'User' }, issue_url: 'https://api.github.com/repos/example/app/issues/7' };
  const context = {
    eventName: 'issue_comment', actor: 'member', repo: { owner: 'example', repo: 'app' },
    payload: { action: 'created', comment, issue: { number: 7, pull_request: {}, url: comment.issue_url } },
  };
  const pull = { number: 7, state: 'open', base: { repo, ref: 'main' }, head: { sha: headSha, repo }, ...changes };
  const users = [];
  const github = { rest: {
    issues: { getComment: async () => ({ data: comment }) },
    repos: { getCollaboratorPermissionLevel: async ({ username }) => {
      users.push(username);
      return { data: { permission } };
    } },
    pulls: { get: async () => ({ data: pull }) },
  } };
  return { github, context, comment, pull, users };
}

test('only exact human commands are accepted; bot results and command-like text cannot trigger', () => {
  assert.equal(command('/deploy-pr', 'User'), 'deploy');
  assert.equal(command('/cleanup-pr', 'User'), 'cleanup');
  for (const body of ['/cleanup-pr extra', ' /deploy-pr', '/deploy-pr\n', '/clean-up', '/deploy-pr && whoami']) {
    assert.equal(command(body, 'User'), undefined);
  }
  assert.equal(command('/deploy-pr', 'Bot'), undefined);
});

test('live permission accepts write/maintain/admin and rejects readers, triage and unknown roles', async () => {
  for (const role of ['write', 'maintain', 'admin']) {
    const { github, context, users } = request(role);
    assert.deepEqual(await authorize(github, context, repo), { action: 'deploy', pr: 7, headSha });
    assert.equal(users.length, 2);
  }
  for (const role of ['read', 'triage', 'none', 'unknown']) {
    const { github, context } = request(role);
    context.payload.comment.author_association = 'OWNER';
    await assert.rejects(authorize(github, context, repo), /live write/);
  }
});

test('edited comments, forks, closed deploys and wrong PR targets fail closed', async () => {
  for (const changes of [
    { state: 'closed' },
    { head: { sha: headSha, repo: { id: 456 } } },
    { head: { sha: 'refs/heads/main', repo } },
    { base: { repo: { id: 456 }, ref: 'main' } },
    { base: { repo, ref: 'other' } },
  ]) {
    const { github, context } = request('write', changes);
    await assert.rejects(authorize(github, context, repo));
  }
  const { github, context } = request();
  context.payload.action = 'edited';
  await assert.rejects(authorize(github, context, repo));
  context.payload.action = 'created';
  github.rest.issues.getComment = async () => ({ data: { ...context.payload.comment, body: '/cleanup-pr' } });
  await assert.rejects(authorize(github, context, repo), /comment changed/);
});

test('closed PR cleanup remains possible but does not bypass live membership', async () => {
  const { github, context, comment } = request('write', { state: 'closed' });
  comment.body = '/cleanup-pr';
  assert.equal((await authorize(github, context, repo)).action, 'cleanup');
});

test('a rerun by an unauthorized actor cannot borrow the original commenter permission', async () => {
  const { github, context } = request();
  let checks = 0;
  github.rest.repos.getCollaboratorPermissionLevel = async () => ({ data: { permission: ++checks === 1 ? 'write' : 'read' } });
  await assert.rejects(authorize(github, context, repo), /live write/);
});

test('state authenticates both encrypted data and key without exposing plaintext', () => {
  const key = randomBytes(32).toString('base64');
  const encrypted = seal(record(), key);
  assert.deepEqual(unseal(encrypted, key), record());
  assert.ok(!encrypted.includes(Buffer.from(subscription)));
  const changed = Buffer.from(encrypted);
  changed[30] ^= 1;
  assert.throws(() => unseal(changed, key), /authentication failed/);
  assert.throws(() => unseal(encrypted, randomBytes(32).toString('base64')), /authentication failed/);
  assert.throws(() => seal(record(), 'not-a-key'), /32-byte/);
});

test('cleanup provenance rejects another PR/repository/subscription and unsafe state paths', () => {
  assert.equal(validateRecord(record(), repo, 7, subscription).pr, 7);
  const uppercase = record();
  uppercase.files = Object.fromEntries(Object.entries(uppercase.files).map(([path, value]) =>
    [path.replace('c'.repeat(64), 'C'.repeat(64)), value]));
  nativeState(validateRecord(uppercase, repo, 7, subscription));
  for (const changes of [
    { pr: 8 }, { repositoryId: 456 }, { repository: 'other/app' },
    { group: 'production' }, { resourceId: `/subscriptions/${subscription}/resourceGroups/production` },
    { files: { '../production.json': '{}' } },
    { files: { [`${'c'.repeat(64)}/pr-7.json`]: '{"Azure:ResourceGroup":"production"}' } },
    { files: { [`${'c'.repeat(64)}/pr-7.json.migration`]: '{"CurrentState":"{\\"Azure:ResourceGroup\\":\\"production\\"}"}' } },
  ]) assert.throws(() => validateRecord({ ...record(), ...changes }, repo, 7, subscription));
  assert.throws(() => nativeState({ ...record(), files: {} }), /Exactly one/);
  nativeState(record());
});

test('live ownership requires all tags and exact resource identity, never just a prefix', () => {
  const state = record();
  const group = { id: state.resourceId, tags: {
    'aspire-pr-repository-id': '123', 'aspire-pr-number': '7', 'aspire-pr-deployment': state.deploymentId,
  } };
  verifyGroup(group, state);
  assert.throws(() => verifyGroup({ ...group, tags: { aspire: 'true' } }, state));
  assert.throws(() => verifyGroup({ ...group, id: `${state.resourceId}-other` }, state));
  assert.throws(() => verifyGroup({ ...group, tags: { ...group.tags, 'aspire-pr-deployment': 'd'.repeat(32) } }, state));
});

test('successful deploy refreshes exactly one hour; failures never extend an existing expiry', () => {
  assert.equal(renewedExpiry(record(), true, 1000), 3601_000);
  assert.equal(renewedExpiry(record(), false, 1000), record().expiresAt);
  assert.equal(renewedExpiry(null, false, 1000), 3601_000);
  assert.notEqual(target(repo.id, 7, subscription).group, target(repo.id, 8, subscription).group);
  assert.throws(() => target(repo.id, '7;rm', subscription));
});

test('a renewed lease defeats stale scheduled discovery and cleanup honors the exact expiry boundary', () => {
  const old = record();
  assert.equal(cleanupDue(old, 'expire', old.expiresAt - 1), false);
  assert.equal(cleanupDue(old, 'expire', old.expiresAt), true);
  const renewed = { ...old, expiresAt: renewedExpiry(old, true, old.expiresAt) };
  assert.equal(cleanupDue(renewed, 'expire', old.expiresAt), false);
  assert.equal(cleanupDue(renewed, 'cleanup', old.expiresAt), true);
  assert.equal(cleanupDue({ ...renewed, status: 'deleted' }, 'cleanup', renewed.expiresAt), false);
  assert.equal(cleanupDue(null, 'cleanup', renewed.expiresAt), false);
});

test('a matching artifact name cannot make PR/fork workflow runs trusted state producers', () => {
  const run = { path: '.github/workflows/pr-command.yml', event: 'issue_comment', head_branch: 'main', repository: repo };
  verifyProducer(run, repo);
  verifyProducer({ ...run, path: '.github/workflows/pr-expiry.yml', event: 'schedule' }, repo);
  for (const changes of [
    { event: 'pull_request' }, { head_branch: 'feature' }, { repository: { id: 999 } },
    { path: '.github/workflows/other.yml' }, { path: '.github/workflows/pr-command.yml@refs/heads/feature' },
  ]) assert.throws(() => verifyProducer({ ...run, ...changes }, repo));
});

test('failure reporting posts a run link and updates only the bot-owned command comment on rerun', async () => {
  const { github, context } = request();
  context.serverUrl = 'https://github.com';
  context.runId = 42;
  github.rest.repos.get = async () => ({ data: repo });
  const marker = '<!-- aspire-pr-command:9 -->';
  const comments = [{ id: 11, user: { type: 'User', login: 'member' }, body: `${marker}\nforged` }];
  github.rest.issues.listComments = async () => {};
  github.paginate = async () => comments;
  let creates = 0;
  let updates = 0;
  let body;
  github.rest.issues.createComment = async args => {
    creates++;
    body = args.body;
    comments.push({ id: 12, user: { type: 'Bot', login: 'github-actions[bot]' }, body });
  };
  github.rest.issues.updateComment = async args => {
    updates++;
    assert.equal(args.comment_id, 12);
    body = args.body;
  };
  const prior = process.env.AUTHORIZATION_RESULT;
  process.env.AUTHORIZATION_RESULT = 'failure';
  try {
    await run({ github, context, core: {} }, 'report');
    await run({ github, context, core: {} }, 'report');
  } finally {
    if (prior === undefined) delete process.env.AUTHORIZATION_RESULT;
    else process.env.AUTHORIZATION_RESULT = prior;
  }
  assert.equal(creates, 1);
  assert.equal(updates, 1);
  assert.match(body, /no deployment authorized/);
  assert.match(body, /https:\/\/github.com\/example\/app\/actions\/runs\/42/);
  assert.doesNotMatch(body, /portal.azure.com/);
});

test('the bot-owned deploy comment pins its head across reruns', async () => {
  const { github, context } = request();
  context.serverUrl = 'https://github.com';
  context.runId = 42;
  github.rest.repos.get = async () => ({ data: repo });
  const existing = {
    id: 12, user: { type: 'Bot', login: 'github-actions[bot]' },
    body: `<!-- aspire-pr-command:9 -->\n<!-- aspire-pr-head:${'d'.repeat(40)} -->`,
  };
  github.rest.issues.listComments = async () => {};
  github.paginate = async () => [existing];
  let updates = 0;
  github.rest.issues.updateComment = async () => { updates++; };
  const core = { setOutput() {} };
  await assert.rejects(run({ github, context, core }, 'authorize'), /different head/);
  assert.equal(updates, 0);
  existing.body = `<!-- aspire-pr-command:9 -->\n<!-- aspire-pr-head:${headSha} -->`;
  await run({ github, context, core }, 'authorize');
  assert.equal(updates, 1);
});
