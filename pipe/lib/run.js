const { execFile } = require('child_process');
const { fetchPullRequest, classifyPullRequest } = require('./bitbucket');
const { readConfig } = require('./config');
const { createLogger } = require('./log');

function logOpencodeEnv(env, logger) {
  const opencodeVars = ['BB_MCP_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'GH_MCP_TOKEN'];
  for (const name of opencodeVars) {
    if (env[name]) {
      logger.info(`${name}=<set (${env[name].length} chars)>`);
    } else {
      logger.info(`${name}=<NOT SET>`);
    }
  }
}

function getTimeout(env) {
  if (env.OPENCODE_TIMEOUT) {
    const parsed = Number.parseInt(env.OPENCODE_TIMEOUT, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }
  return 600000;
}

async function checkConnections(logger) {
  const endpoints = [
    { name: 'Bitbucket MCP', url: 'https://mcp.atlassian.com/v1/mcp' },
    { name: 'GitHub MCP', url: 'https://api.githubcopilot.com/mcp/' },
    { name: 'Context7 MCP', url: 'https://mcp.context7.com/mcp' },
    { name: 'npm registry', url: 'https://registry.npmjs.org/' },
    { name: 'GitHub (ripgrep)', url: 'https://github.com' },
  ];

  for (const ep of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(ep.url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeout);
      logger.info(`[connectivity] ${ep.name}: ${res.status} ${res.statusText} (${ep.url})`);
    } catch (err) {
      logger.info(`[connectivity] ${ep.name}: FAILED (${err.cause?.code || err.message}) (${ep.url})`);
    }
  }
}

async function runOpencode({ repo, prNumber, mcpToken, logger, env }) {
  return new Promise((resolve, reject) => {
    const reviewTarget = `https://bitbucket.org/${repo}/pull-requests/${prNumber}`;
    const timeout = getTimeout(env);
    const timeoutMinutes = Math.round(timeout / 60000);

    logger.info(`opencode timeout: ${timeoutMinutes} minute(s)`);
    logOpencodeEnv(env, logger);

    const child = execFile(
      'opencode',
      ['run', `Review ${reviewTarget}`, '--agent', 'bitbucket-pr-review', '--print-logs', '--log-level', 'DEBUG'],
      {
        env: { ...process.env, BB_MCP_TOKEN: mcpToken, PATH: `${process.env.HOME}/.opencode/bin:${process.env.PATH}` },
        timeout,
      },
      (error, stdout, stderr) => {
        if (error) {
          const reason = error.killed ? 'timed out' : `exited with code ${error.code}`;
          reject(new Error(`opencode ${reason}: ${stderr || error.message}`));
          return;
        }
        logger.info(`opencode completed`);
        resolve(stdout);
      },
    );

    const heartbeatMs = 60000;
    const heartbeat = setInterval(() => {
      logger.info(`[heartbeat] opencode still running (pid=${child.pid})...`);
    }, heartbeatMs);

    const clearHeartbeat = () => {
      clearInterval(heartbeat);
    };

    child.on('spawn', () => {
      logger.info(`opencode process started: Review ${reviewTarget}`);
    });

    child.stdout.on('data', (chunk) => {
      const line = chunk.toString();
      if (line.trim()) {
        logger.info(line.trim());
      }
    });

    child.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      if (line.trim()) {
        logger.info(line.trim());
      }
    });

    child.on('error', (error) => {
      logger.info(`opencode error: ${error.message}`);
    });

    child.on('exit', (code) => {
      clearHeartbeat();
      logger.info(`opencode exited with code ${code}`);
    });
  });
}

async function runPipe({ env = process.env, fetchImpl = fetch, logger, execImpl = runOpencode } = {}) {
  const config = readConfig(env);
  const activeLogger = logger || createLogger({ debug: config.debug });

  activeLogger.info(`Fetching PR: ${config.bitbucket.repo.fullName}#${config.bitbucket.prNumber}`);
  const pr = await fetchPullRequest({
    repoFullName: config.bitbucket.repo.fullName,
    prNumber: config.bitbucket.prNumber,
    readToken: config.bitbucket.readToken,
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

  activeLogger.info(`Starting review for ${config.bitbucket.repo.fullName}#${config.bitbucket.prNumber}`);

  await checkConnections(activeLogger);

  await execImpl({
    repo: config.bitbucket.repo.fullName,
    prNumber: config.bitbucket.prNumber,
    mcpToken: config.opencode.mcpToken,
    logger: activeLogger,
    env,
  });

  activeLogger.info(
    `Review completed: repo=${config.bitbucket.repo.fullName} pr=${config.bitbucket.prNumber}`,
  );

  return { outcome: 'reviewed' };
}

module.exports = {
  runPipe,
};
