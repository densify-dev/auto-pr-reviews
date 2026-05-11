const { execFile } = require('child_process');
const { fetchPullRequest, classifyPullRequest } = require('./bitbucket');
const { readConfig } = require('./config');
const { createLogger } = require('./log');

async function runOpencode({ repo, prNumber, mcpToken, logger }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'opencode',
      ['run', '--agent', 'bitbucket-pr-review', '--repo', repo, '--pr-number', String(prNumber)],
      {
        env: { ...process.env, BB_MCP_TOKEN: mcpToken },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`opencode exited with code ${error.code}: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );

    child.stdout.on('data', (chunk) => {
      logger.info(chunk.toString().trim());
    });

    child.stderr.on('data', (chunk) => {
      logger.debug(chunk.toString().trim());
    });
  });
}

async function runPipe({ env = process.env, fetchImpl = fetch, logger, execImpl = runOpencode } = {}) {
  const config = readConfig(env);
  const activeLogger = logger || createLogger({ debug: config.debug });

  const pr = await fetchPullRequest({
    repoFullName: config.bitbucket.repo.fullName,
    prNumber: config.bitbucket.prNumber,
    readToken: config.bitbucket.mcpToken,
    fetchImpl,
    logger: activeLogger,
  });

  const decision = classifyPullRequest(pr);
  if (decision.action === 'skip-draft') {
    activeLogger.info(
      `Skipped because PR is draft: ${config.bitbucket.repo.fullName}#${config.bitbucket.prNumber}`,
    );
    return { outcome: 'skipped-draft' };
  }

  if (decision.action === 'skip-closed') {
    activeLogger.info(
      `Skipped because PR is not open: ${config.bitbucket.repo.fullName}#${config.bitbucket.prNumber} (state=${decision.state})`,
    );
    return { outcome: 'skipped-not-open' };
  }

  await execImpl({
    repo: config.bitbucket.repo.fullName,
    prNumber: config.bitbucket.prNumber,
    mcpToken: config.bitbucket.mcpToken,
    logger: activeLogger,
  });

  activeLogger.info(
    `Review completed: repo=${config.bitbucket.repo.fullName} pr=${config.bitbucket.prNumber}`,
  );

  return { outcome: 'reviewed' };
}

module.exports = {
  runPipe,
};
