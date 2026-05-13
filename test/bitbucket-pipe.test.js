const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPullRequest, fetchPullRequest, hasAiReviewTag } = require('../pipe/lib/bitbucket');
const { parseRepo, parsePositiveInteger } = require('../pipe/lib/config');
const { isDraftPullRequest } = require('../pipe/lib/draft');
const { retryJson } = require('../pipe/lib/http');
const { runPipe } = require('../pipe/lib/run');

function createEnv(overrides = {}) {
  return {
    BB_MCP_TOKEN: 'bb-mcp-token',
    PR_REVIEW_BITBUCKET_PR_READ_TOKEN: 'bb-read-token',
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

test('hasAiReviewTag detects the opt-in marker', () => {
  assert.equal(hasAiReviewTag('feat: add API [ai-review]'), true);
  assert.equal(hasAiReviewTag('feat: add API'), false);
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

test('runPipe runs opencode for an open non-draft pull request', async () => {
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
    fetchImpl: async (url) => {
      if (url.includes('/pullrequests/42')) {
        return createJsonResponse(200, {
          title: 'Feature',
          state: 'OPEN',
          draft: false,
          source: { commit: { hash: 'abc123' } },
        });
      }

      if (url.includes('/commit/abc123')) {
        return createJsonResponse(200, { message: 'feat: add feature [ai-review]' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
    execImpl: async ({ repo, prNumber, mcpToken, logger }) => {
      assert.equal(repo, 'workspace/service');
      assert.equal(prNumber, 42);
      assert.equal(mcpToken, 'bb-mcp-token');
      logger.info('opencode output');
    },
  });

  assert.equal(result.outcome, 'reviewed');
  assert.match(logs.at(-1), /Review completed/);
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
      if (url.includes('/pullrequests/42')) {
        return createJsonResponse(200, {
          title: 'Feature',
          state: 'OPEN',
          draft: true,
          source: { commit: { hash: 'abc123' } },
        });
      }

      if (url.includes('/commit/abc123')) {
        return createJsonResponse(200, { message: 'feat: add feature [ai-review]' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
    execImpl: async () => {
      throw new Error('opencode should not be called');
    },
  });

  assert.equal(result.outcome, 'skipped-draft');
  assert.match(logs.find(l => l.includes('Skipped because PR is draft')), /Skipped because PR is draft/);
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
    fetchImpl: async (url) => {
      if (url.includes('/pullrequests/42')) {
        return createJsonResponse(200, {
          title: 'Feature',
          state: 'MERGED',
          draft: false,
          source: { commit: { hash: 'abc123' } },
        });
      }

      if (url.includes('/commit/abc123')) {
        return createJsonResponse(200, { message: 'feat: add feature [ai-review]' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
    execImpl: async () => {
      throw new Error('opencode should not be called');
    },
  });

  assert.equal(result.outcome, 'skipped-not-open');
  assert.match(logs.find(l => l.includes('Skipped because PR is not open')), /Skipped because PR is not open/);
});

test('runPipe exits successfully when source commit is not tagged for AI review', async () => {
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
      if (url.includes('/pullrequests/42')) {
        return createJsonResponse(200, {
          title: 'Feature',
          state: 'OPEN',
          draft: false,
          source: { commit: { hash: 'abc123' } },
        });
      }

      if (url.includes('/commit/abc123')) {
        return createJsonResponse(200, { message: 'feat: add feature' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
    execImpl: async () => {
      throw new Error('opencode should not be called');
    },
  });

  assert.equal(result.outcome, 'skipped-no-ai-review-tag');
  assert.match(
    logs.find(l => l.includes('source commit message does not contain [ai-review]')),
    /source commit message does not contain \[ai-review\]/,
  );
});

test('runPipe fails clearly on missing PR_REVIEW_BITBUCKET_PR_READ_TOKEN', async () => {
  await assert.rejects(
    () =>
      runPipe({
        env: createEnv({ PR_REVIEW_BITBUCKET_PR_READ_TOKEN: undefined }),
        fetchImpl: async () => createJsonResponse(200, {}),
      }),
    /required variable is missing: PR_REVIEW_BITBUCKET_PR_READ_TOKEN/,
  );
});

test('runPipe fails clearly on malformed BITBUCKET_PR_ID', async () => {
  await assert.rejects(
    () => runPipe({ env: createEnv({ BITBUCKET_PR_ID: 'abc' }), fetchImpl: async () => createJsonResponse(200, {}) }),
    /BITBUCKET_PR_ID must be a positive integer/,
  );
});
