# Auto PR Reviews

This repository receives review requests from other repositories and runs the central PR review workflow.

## GitHub Consumer

Consuming repositories can request a review by using the root action from this repository:

```yaml
- uses: your-org/auto-pr-reviews@v1
  with:
    app-client-id: ${{ vars.PR_REVIEW_DISPATCH_APP_CLIENT_ID }}
    app-private-key: ${{ secrets.PR_REVIEW_DISPATCH_APP_PRIVATE_KEY_B64 }}
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
- Org secret: `PR_REVIEW_DISPATCH_APP_PRIVATE_KEY_B64`

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
          app-private-key: ${{ secrets.PR_REVIEW_DISPATCH_APP_PRIVATE_KEY_B64 }}
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

The pipe:

- Reads the Bitbucket PR state
- Runs `opencode` directly to perform the review
- Exits `0` for draft or non-open pull requests
- Exits non-zero if the review fails

Required Bitbucket variables:

- Secured repository or workspace variable: `BB_MCP_TOKEN`
- Secured repository or workspace variable: `PR_REVIEW_BITBUCKET_PR_READ_TOKEN`

Optional Bitbucket variables:

- Repository or workspace variable: `DEBUG` with default `false`

## Bitbucket Pipeline Example

Pin the pipe to an explicit version tag. The pipe image is published publicly to GHCR as `ghcr.io/densify-dev/auto-pr-reviews-bitbucket-pipe`.

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          name: Request PR review
          script:
            - pipe: docker://ghcr.io/densify-dev/auto-pr-reviews-bitbucket-pipe:1.0.0
              variables:
                BB_MCP_TOKEN: $BB_MCP_TOKEN
                PR_REVIEW_BITBUCKET_PR_READ_TOKEN: $PR_REVIEW_BITBUCKET_PR_READ_TOKEN
```

Notes:

- `BB_MCP_TOKEN` and `PR_REVIEW_BITBUCKET_PR_READ_TOKEN` must be secured Bitbucket variables.
- Pin to a full semver tag such as `1.0.0` for stable rollouts. Convenience tags such as `1` and `1.0` may also be published for upgrades within a release line.
