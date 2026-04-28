const { fetchPullRequest, classifyPullRequest } = require('./bitbucket');
const { readConfig } = require('./config');
const {
  createAppJwt,
  lookupInstallationId,
  createInstallationToken,
  buildDispatchPayload,
  sendDispatch,
} = require('./github');
const { createLogger } = require('./log');

async function runPipe({ env = process.env, fetchImpl = fetch, logger } = {}) {
  const config = readConfig(env);
  const activeLogger = logger || createLogger({ debug: config.debug });

  const pr = await fetchPullRequest({
    repoFullName: config.bitbucket.repo.fullName,
    prNumber: config.bitbucket.prNumber,
    readToken: config.bitbucket.readToken,
    fetchImpl,
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

  const appJwt = createAppJwt(config.appClientId, config.appPrivateKey);
  const installationId = await lookupInstallationId({
    githubApiUrl: config.githubApiUrl,
    centralRepo: config.centralRepo,
    appJwt,
    fetchImpl,
    logger: activeLogger,
  });

  const installationToken = await createInstallationToken({
    githubApiUrl: config.githubApiUrl,
    installationId,
    centralRepo: config.centralRepo,
    appJwt,
    fetchImpl,
    logger: activeLogger,
  });

  const payload = buildDispatchPayload({
    eventType: config.eventType,
    bitbucketRepo: config.bitbucket.repo.fullName,
    prNumber: config.bitbucket.prNumber,
  });

  await sendDispatch({
    githubApiUrl: config.githubApiUrl,
    centralRepo: config.centralRepo,
    installationToken,
    payload,
    fetchImpl,
    logger: activeLogger,
  });

  activeLogger.info(
    `Dispatched successfully: repo=${config.bitbucket.repo.fullName} pr=${config.bitbucket.prNumber}`,
  );

  return { outcome: 'dispatched', payload };
}

module.exports = {
  runPipe,
};
