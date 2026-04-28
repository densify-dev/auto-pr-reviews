const { isDraftPullRequest } = require('./draft');
const { retryJson } = require('./http');

async function fetchPullRequest({ repoFullName, prNumber, readToken, fetchImpl = fetch, logger }) {
  const url = `https://api.bitbucket.org/2.0/repositories/${repoFullName}/pullrequests/${prNumber}`;

  const response = await retryJson({
    attempts: 3,
    url,
    method: 'GET',
    token: readToken,
    headers: {
      Accept: 'application/json',
    },
    fetchImpl,
    logger,
  });

  if (!response.ok) {
    const detail = response.status ? ` (HTTP ${response.status})` : '';
    throw new Error(`Failed because Bitbucket PR lookup failed: ${repoFullName}#${prNumber}${detail}`);
  }

  return response.body;
}

function classifyPullRequest(pr) {
  if (isDraftPullRequest(pr)) {
    return { action: 'skip-draft' };
  }

  if (pr.state !== 'OPEN') {
    return { action: 'skip-closed', state: pr.state };
  }

  return { action: 'dispatch' };
}

module.exports = {
  classifyPullRequest,
  fetchPullRequest,
};
