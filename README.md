# Auto PR Reviews

This repository receives review requests from other repositories and runs the central PR review workflow.

## GitHub Consumer

Consuming repositories can request a review by using the root action from this repository:

```yaml
- uses: your-org/auto-pr-reviews@v1
  with:
    app-client-id: ${{ vars.PR_REVIEW_DISPATCH_APP_CLIENT_ID }}
    app-private-key: ${{ secrets.PR_REVIEW_DISPATCH_APP_PRIVATE_KEY }}
    central-repo: your-org/auto-pr-reviews
    provider: github
    repo: ${{ github.repository }}
    pr-number: ${{ github.event.pull_request.number }}
```

The action mints a GitHub App installation token scoped to this central repository, then sends a `repository_dispatch` event with the provider, repository, and pull request number.

## Required GitHub App Setup

Create a dedicated dispatch app and install it on this repository.

- Installation scope: `auto-pr-reviews` only
- Repository permission: `Contents: write`

Expose the app credentials to consuming repositories:

- Org variable: `PR_REVIEW_DISPATCH_APP_CLIENT_ID`
- Org secret: `PR_REVIEW_DISPATCH_APP_PRIVATE_KEY`

The dispatch app is intentionally separate from the review app used by the central workflow so consuming repositories do not receive broader review credentials.

## GitHub Consumer Workflow Example

Add this workflow to each consuming repository:

```yaml
name: Request PR Review

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read

jobs:
  request-review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: your-org/auto-pr-reviews@v1
        with:
          app-client-id: ${{ vars.PR_REVIEW_DISPATCH_APP_CLIENT_ID }}
          app-private-key: ${{ secrets.PR_REVIEW_DISPATCH_APP_PRIVATE_KEY }}
          central-repo: your-org/auto-pr-reviews
          provider: github
          repo: ${{ github.repository }}
          pr-number: ${{ github.event.pull_request.number }}
```

## Central Workflow

The receiving workflow lives in `.github/workflows/trigger-review.yaml`.

It:

- validates the dispatch payload
- creates the review-side GitHub App token for the target repository
- runs the GitHub or Bitbucket review agent

## Bitbucket Consumer

Bitbucket repositories do not use the reusable GitHub Action. Instead, they dispatch directly to this repository from a PR pipeline.

Consumer contract:

- Run only in pull request pipelines.
- Use `BITBUCKET_REPO_FULL_NAME` as the canonical `repo` payload value.
- Use `BITBUCKET_PR_ID` as the `pr_number` payload value.
- Check the Bitbucket PR state before dispatching.
- Skip draft or WIP PRs before calling GitHub.
- Optionally skip non-open PRs before calling GitHub.
- Dispatch only valid non-draft PRs to the central repository.

Required Bitbucket variables:

- Repository or workspace variable: `PR_REVIEW_DISPATCH_APP_CLIENT_ID`
- Secured repository or workspace variable: `PR_REVIEW_DISPATCH_APP_PRIVATE_KEY`
- Repository or workspace variable: `PR_REVIEW_CENTRAL_REPO`
- Secured repository or workspace variable: `PR_REVIEW_BITBUCKET_PR_READ_TOKEN`

Optional Bitbucket variables:

- Repository or workspace variable: `PR_REVIEW_EVENT_TYPE` with default `pr-review-request`
- Repository or workspace variable: `PR_REVIEW_GITHUB_API_URL` with default `https://api.github.com`

The central repository must also set `ALLOWED_BITBUCKET_WORKSPACE` and `BB_MCP_TOKEN` so incoming Bitbucket requests are accepted and reviewed.

## Bitbucket Pipeline Example

Add this step to a Bitbucket PR pipeline. It validates the required variables, reads the PR from Bitbucket, skips draft PRs, retries transient GitHub API calls, and then sends the same `repository_dispatch` payload shape used by GitHub consumers.

```yaml
image: node:22

pipelines:
  pull-requests:
    '**':
      - step:
          name: Request central PR review
          script:
            - |
              set -euo pipefail

              log() {
                printf '%s\n' "$1"
              }

              fail() {
                printf '%s\n' "$1" >&2
                exit 1
              }

              require_var() {
                local name="$1"
                if [[ -z "${!name:-}" ]]; then
                  fail "Missing required variable: $name"
                fi
              }

              retry_http() {
                local attempts="$1"
                local method="$2"
                local url="$3"
                local token="$4"
                local response_file="$5"
                local body="${6:-}"

                local attempt=1
                local http_code=""
                while true; do
                  if [[ -n "$body" ]]; then
                    http_code=$(curl -sS -o "$response_file" -w '%{http_code}' \
                      -X "$method" \
                      -H "Accept: application/vnd.github+json" \
                      -H "Authorization: Bearer $token" \
                      -H "X-GitHub-Api-Version: 2022-11-28" \
                      "$url" \
                      -d "$body") && curl_status=0 || curl_status=$?
                  else
                    http_code=$(curl -sS -o "$response_file" -w '%{http_code}' \
                      -X "$method" \
                      -H "Accept: application/vnd.github+json" \
                      -H "Authorization: Bearer $token" \
                      -H "X-GitHub-Api-Version: 2022-11-28" \
                      "$url") && curl_status=0 || curl_status=$?
                  fi

                  if [[ "$curl_status" -eq 0 && ! "$http_code" =~ ^(429|5[0-9][0-9])$ ]]; then
                    RETRY_HTTP_CODE="$http_code"
                    return 0
                  fi

                  if [[ "$attempt" -ge "$attempts" ]]; then
                    RETRY_HTTP_CODE="$http_code"
                    return 1
                  fi

                  sleep $((attempt * 2))
                  attempt=$((attempt + 1))
                done
              }

              require_var PR_REVIEW_DISPATCH_APP_CLIENT_ID
              require_var PR_REVIEW_DISPATCH_APP_PRIVATE_KEY
              require_var PR_REVIEW_CENTRAL_REPO
              require_var PR_REVIEW_BITBUCKET_PR_READ_TOKEN
              require_var BITBUCKET_REPO_FULL_NAME
              require_var BITBUCKET_PR_ID

              PR_REVIEW_EVENT_TYPE="${PR_REVIEW_EVENT_TYPE:-pr-review-request}"
              PR_REVIEW_GITHUB_API_URL="${PR_REVIEW_GITHUB_API_URL:-https://api.github.com}"

              if [[ ! "$BITBUCKET_REPO_FULL_NAME" =~ ^[^/]+/[^/]+$ ]]; then
                fail "BITBUCKET_REPO_FULL_NAME must be workspace/repo, got: $BITBUCKET_REPO_FULL_NAME"
              fi

              if [[ ! "$PR_REVIEW_CENTRAL_REPO" =~ ^[^/]+/[^/]+$ ]]; then
                fail "PR_REVIEW_CENTRAL_REPO must be owner/name, got: $PR_REVIEW_CENTRAL_REPO"
              fi

              if [[ ! "$BITBUCKET_PR_ID" =~ ^[1-9][0-9]*$ ]]; then
                fail "BITBUCKET_PR_ID must be a positive integer, got: $BITBUCKET_PR_ID"
              fi

              bb_pr_url="https://api.bitbucket.org/2.0/repositories/$BITBUCKET_REPO_FULL_NAME/pullrequests/$BITBUCKET_PR_ID"
              bb_pr_response_file="$(mktemp)"

              bb_pr_http_code=$(curl -sS -o "$bb_pr_response_file" -w '%{http_code}' \
                -H "Authorization: Bearer $PR_REVIEW_BITBUCKET_PR_READ_TOKEN" \
                -H "Accept: application/json" \
                "$bb_pr_url") || {
                  rm -f "$bb_pr_response_file"
                  fail "Bitbucket PR lookup failed for $BITBUCKET_REPO_FULL_NAME#$BITBUCKET_PR_ID"
                }

              if [[ "$bb_pr_http_code" -lt 200 || "$bb_pr_http_code" -ge 300 ]]; then
                cat "$bb_pr_response_file" >&2
                rm -f "$bb_pr_response_file"
                fail "Bitbucket PR lookup failed for $BITBUCKET_REPO_FULL_NAME#$BITBUCKET_PR_ID (HTTP $bb_pr_http_code)"
              fi

              bb_pr_state=$(node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(data.state || ''));" "$bb_pr_response_file")
              bb_pr_title=$(node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(data.title || ''));" "$bb_pr_response_file")
              bb_pr_draft=$(node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const title = String(data.title || '').toLowerCase(); const draft = data.draft === true || title.startsWith('draft:') || title.startsWith('[draft]') || title.startsWith('wip:') || title.startsWith('[wip]'); process.stdout.write(draft ? 'true' : 'false');" "$bb_pr_response_file")
              rm -f "$bb_pr_response_file"

              if [[ "$bb_pr_draft" == "true" ]]; then
                log "Skipped dispatch because PR is draft/WIP: $BITBUCKET_REPO_FULL_NAME#$BITBUCKET_PR_ID ($bb_pr_title)"
                exit 0
              fi

              if [[ "$bb_pr_state" != "OPEN" ]]; then
                log "Skipped dispatch because PR is not open: $BITBUCKET_REPO_FULL_NAME#$BITBUCKET_PR_ID (state=$bb_pr_state)"
                exit 0
              fi

              app_jwt=$(node <<'NODE'
              const crypto = require('crypto');

              const appId = process.env.PR_REVIEW_DISPATCH_APP_CLIENT_ID;
              const privateKey = process.env.PR_REVIEW_DISPATCH_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
              const now = Math.floor(Date.now() / 1000);

              const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
              const header = encode({ alg: 'RS256', typ: 'JWT' });
              const payload = encode({ iat: now - 60, exp: now + 540, iss: appId });

              const signer = crypto.createSign('RSA-SHA256');
              signer.update(`${header}.${payload}`);
              signer.end();

              process.stdout.write(`${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`);
              NODE
              )

              central_owner="${PR_REVIEW_CENTRAL_REPO%%/*}"
              central_repo="${PR_REVIEW_CENTRAL_REPO#*/}"
              installation_id=""

              for path in \
                "$PR_REVIEW_GITHUB_API_URL/repos/$central_owner/$central_repo/installation" \
                "$PR_REVIEW_GITHUB_API_URL/orgs/$central_owner/installation" \
                "$PR_REVIEW_GITHUB_API_URL/users/$central_owner/installation"
              do
                response_file="$(mktemp)"

                if retry_http 3 GET "$path" "$app_jwt" "$response_file"; then
                  if [[ "$RETRY_HTTP_CODE" -ge 200 && "$RETRY_HTTP_CODE" -lt 300 ]]; then
                    installation_id=$(node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(data.id || ''));" "$response_file")
                    rm -f "$response_file"
                    break
                  fi
                fi

                rm -f "$response_file"
              done

              if [[ -z "$installation_id" ]]; then
                fail "GitHub App installation lookup failed for $PR_REVIEW_CENTRAL_REPO"
              fi

              token_response_file="$(mktemp)"
              if ! retry_http 3 POST "$PR_REVIEW_GITHUB_API_URL/app/installations/$installation_id/access_tokens" "$app_jwt" "$token_response_file"; then
                rm -f "$token_response_file"
                fail "GitHub installation token creation failed for $PR_REVIEW_CENTRAL_REPO"
              fi

              token_http_code="$RETRY_HTTP_CODE"
              if [[ "$token_http_code" -lt 200 || "$token_http_code" -ge 300 ]]; then
                cat "$token_response_file" >&2
                rm -f "$token_response_file"
                fail "GitHub installation token creation failed for $PR_REVIEW_CENTRAL_REPO (HTTP $token_http_code)"
              fi

              installation_token=$(node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(data.token || ''));" "$token_response_file")
              rm -f "$token_response_file"

              if [[ -z "$installation_token" ]]; then
                fail "GitHub installation token creation failed for $PR_REVIEW_CENTRAL_REPO"
              fi

              dispatch_payload=$(cat <<EOF
              {
                "event_type": "$PR_REVIEW_EVENT_TYPE",
                "client_payload": {
                  "provider": "bitbucket",
                  "repo": "$BITBUCKET_REPO_FULL_NAME",
                  "pr_number": "$BITBUCKET_PR_ID"
                }
              }
              EOF
              )

              dispatch_response_file="$(mktemp)"
              if ! retry_http 3 POST "$PR_REVIEW_GITHUB_API_URL/repos/$central_owner/$central_repo/dispatches" "$installation_token" "$dispatch_response_file" "$dispatch_payload"; then
                rm -f "$dispatch_response_file"
                fail "Dispatch POST failed for $BITBUCKET_REPO_FULL_NAME#$BITBUCKET_PR_ID"
              fi

              dispatch_http_code="$RETRY_HTTP_CODE"
              if [[ "$dispatch_http_code" -lt 200 || "$dispatch_http_code" -ge 300 ]]; then
                cat "$dispatch_response_file" >&2
                rm -f "$dispatch_response_file"
                fail "Dispatch POST failed for $BITBUCKET_REPO_FULL_NAME#$BITBUCKET_PR_ID (HTTP $dispatch_http_code)"
              fi

              rm -f "$dispatch_response_file"
              log "Dispatched successfully: repo=$BITBUCKET_REPO_FULL_NAME pr=$BITBUCKET_PR_ID"
```

Notes:

- `PR_REVIEW_DISPATCH_APP_PRIVATE_KEY` and `PR_REVIEW_BITBUCKET_PR_READ_TOKEN` should be stored as secured Bitbucket variables.
- `PR_REVIEW_CENTRAL_REPO` must point at this repository in `owner/name` format.
- The Bitbucket pipeline is responsible for draft suppression. The central GitHub workflow will review any valid Bitbucket request it receives.
