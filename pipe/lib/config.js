const REQUIRED_ENV_VARS = [
  'BB_MCP_TOKEN',
  'PR_REVIEW_BITBUCKET_PR_READ_TOKEN',
  'BITBUCKET_REPO_FULL_NAME',
  'BITBUCKET_PR_ID',
];

function validateRequiredEnv(env) {
  for (const name of REQUIRED_ENV_VARS) {
    if (!env[name]) {
      throw new Error(`Failed because required variable is missing: ${name}`);
    }
  }
}

function parseRepo(value, envName) {
  if (!/^[^/]+\/[^/]+$/.test(value)) {
    throw new Error(`Failed because repo format is invalid: ${envName} must be owner/name, got: ${value}`);
  }

  const [owner, repo] = value.split('/');
  return { owner, repo, fullName: value };
}

function parsePositiveInteger(value, envName) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Failed because required variable is invalid: ${envName} must be a positive integer, got: ${value}`);
  }

  return Number.parseInt(value, 10);
}

function readConfig(env = process.env) {
  validateRequiredEnv(env);

  return {
    bitbucket: {
      repo: parseRepo(env.BITBUCKET_REPO_FULL_NAME, 'BITBUCKET_REPO_FULL_NAME'),
      prNumber: parsePositiveInteger(env.BITBUCKET_PR_ID, 'BITBUCKET_PR_ID'),
      readToken: env.PR_REVIEW_BITBUCKET_PR_READ_TOKEN,
      pipelineCommitHash: env.BITBUCKET_COMMIT || null,
    },
    opencode: {
      mcpToken: env.BB_MCP_TOKEN,
    },
    debug: String(env.DEBUG || 'false').toLowerCase() === 'true',
  };
}

module.exports = {
  parsePositiveInteger,
  parseRepo,
  readConfig,
};
