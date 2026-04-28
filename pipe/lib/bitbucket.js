const { isDraftPullRequest } = require('./draft');

async function fetchPullRequest({ repoFullName, prNumber, readToken, fetchImpl = fetch }) {
  const url = `https://api.bitbucket.org/2.0/repositories/${repoFullName}/pullrequests/${prNumber}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${readToken}`,
      },
    });
  } catch {
    throw new Error(`Failed because Bitbucket PR lookup failed: ${repoFullName}#${prNumber}`);
  }

  if (!response.ok) {
    throw new Error(`Failed because Bitbucket PR lookup failed: ${repoFullName}#${prNumber} (HTTP ${response.status})`);
  }

  return response.json();
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
