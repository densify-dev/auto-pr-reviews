const crypto = require('crypto');
const { requestJson, retryJson } = require('./http');

function createAppJwt(appClientId, appPrivateKey, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iat: now - 60, exp: now + 540, iss: appClientId });
  let signingKey;

  try {
    signingKey = crypto.createPrivateKey({ key: appPrivateKey, format: 'pem' });
  } catch {
    throw new Error(
      'Failed because PR_REVIEW_DISPATCH_APP_PRIVATE_KEY_B64 did not decode to a valid GitHub App private key PEM.',
    );
  }

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();

  const signature = signer.sign(signingKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function lookupInstallationId({ githubApiUrl, centralRepo, appJwt, fetchImpl, logger }) {
  const candidates = [
    `${githubApiUrl}/repos/${centralRepo.owner}/${centralRepo.repo}/installation`,
    `${githubApiUrl}/orgs/${centralRepo.owner}/installation`,
    `${githubApiUrl}/users/${centralRepo.owner}/installation`,
  ];

  for (const url of candidates) {
    const response = await retryJson({
      attempts: 3,
      url,
      method: 'GET',
      token: appJwt,
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      fetchImpl,
      logger,
    });

    if (response.ok && response.body && response.body.id) {
      return String(response.body.id);
    }
  }

  throw new Error(`Failed because GitHub App installation lookup failed: ${centralRepo.fullName}`);
}

async function createInstallationToken({ githubApiUrl, installationId, centralRepo, appJwt, fetchImpl, logger }) {
  const response = await retryJson({
    attempts: 3,
    url: `${githubApiUrl}/app/installations/${installationId}/access_tokens`,
    method: 'POST',
    token: appJwt,
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    fetchImpl,
    logger,
  });

  if (!response.ok || !response.body || !response.body.token) {
    throw new Error(`Failed because GitHub installation token creation failed: ${centralRepo.fullName}`);
  }

  return response.body.token;
}

function buildDispatchPayload({ eventType, bitbucketRepo, prNumber }) {
  return {
    event_type: eventType,
    client_payload: {
      provider: 'bitbucket',
      repo: bitbucketRepo,
      pr_number: String(prNumber),
    },
  };
}

async function sendDispatch({ githubApiUrl, centralRepo, installationToken, payload, fetchImpl, logger }) {
  const response = await retryJson({
    attempts: 3,
    url: `${githubApiUrl}/repos/${centralRepo.owner}/${centralRepo.repo}/dispatches`,
    method: 'POST',
    token: installationToken,
    body: payload,
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    fetchImpl,
    logger,
  });

  if (!response.ok) {
    throw new Error(
      `Failed because dispatch POST failed: ${payload.client_payload.repo}#${payload.client_payload.pr_number}`,
    );
  }
}

module.exports = {
  buildDispatchPayload,
  createAppJwt,
  createInstallationToken,
  lookupInstallationId,
  sendDispatch,
};
