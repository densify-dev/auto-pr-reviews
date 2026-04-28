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

Bitbucket repositories use the published Bitbucket pipe instead of the reusable GitHub Action.

Consumer contract:

- Run only in pull request pipelines.
- Use `BITBUCKET_REPO_FULL_NAME` as the canonical `repo` payload value.
- Use `BITBUCKET_PR_ID` as the canonical `pr_number` payload value.
- The pipe reads the Bitbucket PR state before dispatching.
- The pipe exits `0` for draft or non-open pull requests.
- The pipe dispatches only valid open pull requests to the central repository.

Required Bitbucket variables:

- Repository or workspace variable: `PR_REVIEW_DISPATCH_APP_CLIENT_ID`
- Secured repository or workspace variable: `PR_REVIEW_DISPATCH_APP_PRIVATE_KEY`
- Repository or workspace variable: `PR_REVIEW_CENTRAL_REPO`
- Secured repository or workspace variable: `PR_REVIEW_BITBUCKET_PR_READ_TOKEN`

Optional Bitbucket variables:

- Repository or workspace variable: `PR_REVIEW_EVENT_TYPE` with default `pr-review-request`
- Repository or workspace variable: `PR_REVIEW_GITHUB_API_URL` with default `https://api.github.com`
- Repository or workspace variable: `DEBUG` with default `false`

The central repository must also set `ALLOWED_BITBUCKET_WORKSPACE` and `BB_MCP_TOKEN` so incoming Bitbucket requests are accepted and reviewed.

## Bitbucket Pipeline Example

Pin the pipe to an explicit version tag. The pipe image is published publicly to GHCR as `ghcr.io/densify-dev/auto-pr-reviews-bitbucket-pipe`.

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          name: Request central PR review
          script:
            - pipe: docker://ghcr.io/densify-dev/auto-pr-reviews-bitbucket-pipe:1.0.0
              variables:
                PR_REVIEW_DISPATCH_APP_CLIENT_ID: $PR_REVIEW_DISPATCH_APP_CLIENT_ID
                PR_REVIEW_DISPATCH_APP_PRIVATE_KEY: $PR_REVIEW_DISPATCH_APP_PRIVATE_KEY
                PR_REVIEW_CENTRAL_REPO: $PR_REVIEW_CENTRAL_REPO
                PR_REVIEW_BITBUCKET_PR_READ_TOKEN: $PR_REVIEW_BITBUCKET_PR_READ_TOKEN
```

Notes:

- `PR_REVIEW_DISPATCH_APP_PRIVATE_KEY` and `PR_REVIEW_BITBUCKET_PR_READ_TOKEN` should be secured Bitbucket variables.
- `PR_REVIEW_CENTRAL_REPO` must point at this repository in `owner/name` format.
- The pipe performs the PR state check and dispatch retry handling before the central workflow runs.
- Pin to a full semver tag such as `1.0.0` for stable rollouts. Convenience tags such as `1` and `1.0` may also be published for upgrades within a release line.
