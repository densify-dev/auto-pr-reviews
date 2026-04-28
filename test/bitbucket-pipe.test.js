const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { classifyPullRequest, fetchPullRequest } = require('../pipe/lib/bitbucket');
const { parseRepo, parsePositiveInteger } = require('../pipe/lib/config');
const { isDraftPullRequest } = require('../pipe/lib/draft');
const { buildDispatchPayload } = require('../pipe/lib/github');
const { retryJson } = require('../pipe/lib/http');
const { runPipe } = require('../pipe/lib/run');

function createEnv(overrides = {}) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  return {
    PR_REVIEW_DISPATCH_APP_CLIENT_ID: '12345',
    PR_REVIEW_DISPATCH_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    PR_REVIEW_CENTRAL_REPO: 'example/auto-pr-reviews',
    PR_REVIEW_BITBUCKET_PR_READ_TOKEN: 'bb-token',
    PR_REVIEW_EVENT_TYPE: 'pr-review-request',
    PR_REVIEW_GITHUB_API_URL: 'https://api.github.com',
    BITBUCKET_REPO_FULL_NAME: 'workspace/service',
    BITBUCKET_PR_ID: '42',
    DEBUG: 'false',
    ...overrides,
  };
}

function createJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

test('parseRepo accepts owner/name values', () => {
  assert.deepEqual(parseRepo('workspace/repo', 'BITBUCKET_REPO_FULL_NAME'), {
    owner: 'workspace',
    repo: 'repo',
    fullName: 'workspace/repo',
  });
});

test('parseRepo rejects invalid formats', () => {
  assert.throws(() => parseRepo('workspace', 'BITBUCKET_REPO_FULL_NAME'), /repo format is invalid/);
});

test('parsePositiveInteger accepts positive integers', () => {
  assert.equal(parsePositiveInteger('17', 'BITBUCKET_PR_ID'), 17);
});

test('parsePositiveInteger rejects invalid values', () => {
  assert.throws(() => parsePositiveInteger('0', 'BITBUCKET_PR_ID'), /positive integer/);
});

test('isDraftPullRequest detects draft field only', () => {
  assert.equal(isDraftPullRequest({ draft: true, title: 'Feature' }), true);
  assert.equal(isDraftPullRequest({ title: '[WIP] Feature' }), false);
  assert.equal(isDraftPullRequest({ title: 'Feature' }), false);
});

test('classifyPullRequest skips non-open pull requests', () => {
  assert.deepEqual(classifyPullRequest({ title: 'Feature', state: 'DECLINED' }), {
    action: 'skip-closed',
    state: 'DECLINED',
  });
});

test('buildDispatchPayload preserves the central payload contract', () => {
  assert.deepEqual(
    buildDispatchPayload({ eventType: 'pr-review-request', bitbucketRepo: 'workspace/service', prNumber: 42 }),
    {
      event_type: 'pr-review-request',
      client_payload: {
        provider: 'bitbucket',
        repo: 'workspace/service',
        pr_number: '42',
      },
    },
  );
});

test('retryJson retries transient failures and eventually succeeds', async () => {
  let attempts = 0;
  const sleeps = [];

  const response = await retryJson({
    attempts: 3,
    url: 'https://api.github.com/repos/example/auto-pr-reviews/dispatches',
    method: 'POST',
    token: 'token',
    body: { ok: true },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        return createJsonResponse(502, { message: 'bad gateway' });
      }

      return createJsonResponse(204);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [200, 400]);
  assert.equal(response.status, 204);
});

test('fetchPullRequest retries transient Bitbucket failures and eventually succeeds', async () => {
  let attempts = 0;
  const logs = [];

  const pr = await fetchPullRequest({
    repoFullName: 'workspace/service',
    prNumber: 42,
    readToken: 'bb-token',
    logger: {
      debug(message) {
        logs.push(message);
      },
    },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        return createJsonResponse(502, { error: { message: 'bad gateway' } });
      }

      return createJsonResponse(200, { title: 'Feature', state: 'OPEN', draft: false });
    },
  });

  assert.equal(attempts, 3);
  assert.equal(logs.length, 2);
  assert.deepEqual(pr, { title: 'Feature', state: 'OPEN', draft: false });
});

test('runPipe dispatches an open non-draft pull request', async () => {
  const calls = [];
  const logs = [];
  const env = createEnv();

  const result = await runPipe({
    env,
    logger: {
      info(message) {
        logs.push(message);
      },
      debug() {},
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });

      if (url.includes('api.bitbucket.org')) {
        return createJsonResponse(200, { title: 'Feature', state: 'OPEN', draft: false });
      }

      if (url.endsWith('/repos/example/auto-pr-reviews/installation')) {
        return createJsonResponse(200, { id: 99 });
      }

      if (url.endsWith('/app/installations/99/access_tokens')) {
        return createJsonResponse(201, { token: 'installation-token' });
      }

      if (url.endsWith('/repos/example/auto-pr-reviews/dispatches')) {
        return createJsonResponse(204);
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(result.outcome, 'dispatched');
  assert.equal(calls.length, 4);
  assert.match(logs.at(-1), /Dispatched successfully/);
});

test('runPipe exits successfully for draft pull requests', async () => {
  const env = createEnv();
  const logs = [];

  const result = await runPipe({
    env,
    logger: {
      info(message) {
        logs.push(message);
      },
      debug() {},
    },
    fetchImpl: async (url) => {
      assert.match(url, /api\.bitbucket\.org/);
      return createJsonResponse(200, { title: 'Feature', state: 'OPEN', draft: true });
    },
  });

  assert.equal(result.outcome, 'skipped-draft');
  assert.match(logs[0], /Skipped because PR is draft/);
});

test('runPipe exits successfully for non-open pull requests', async () => {
  const env = createEnv();
  const logs = [];

  const result = await runPipe({
    env,
    logger: {
      info(message) {
        logs.push(message);
      },
      debug() {},
    },
    fetchImpl: async () => createJsonResponse(200, { title: 'Feature', state: 'MERGED', draft: false }),
  });

  assert.equal(result.outcome, 'skipped-not-open');
  assert.match(logs[0], /Skipped because PR is not open/);
});

test('runPipe fails clearly on malformed input', async () => {
  await assert.rejects(
    () => runPipe({ env: createEnv({ BITBUCKET_PR_ID: 'abc' }), fetchImpl: async () => createJsonResponse(200, {}) }),
    /BITBUCKET_PR_ID must be a positive integer/,
  );
});
