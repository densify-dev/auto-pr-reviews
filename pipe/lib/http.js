function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

async function requestJson({ url, method, token, body, fetchImpl = fetch }) {
  let response;

  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error,
    };
  }

  const text = await response.text();
  let parsed = null;

  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    text,
  };
}

async function retryJson({ attempts, url, method, token, body, fetchImpl, logger, sleep = defaultSleep }) {
  let lastResponse = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await requestJson({ url, method, token, body, fetchImpl });
    lastResponse = response;

    const shouldRetry =
      !response.ok && (response.status === 0 || isTransientStatus(response.status)) && attempt < attempts;

    if (!shouldRetry) {
      return response;
    }

    if (logger?.debug) {
      logger.debug(`Retrying ${method} ${url} after attempt ${attempt} (status=${response.status || 'network'})`);
    }

    await sleep(attempt * 200);
  }

  return lastResponse;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  requestJson,
  retryJson,
};
