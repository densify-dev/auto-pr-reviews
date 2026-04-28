const DRAFT_PREFIXES = ['draft:', '[draft]', 'wip:', '[wip]'];

function isDraftPullRequest(pr) {
  const title = String(pr.title || '').trim().toLowerCase();
  return pr.draft === true || DRAFT_PREFIXES.some((prefix) => title.startsWith(prefix));
}

module.exports = {
  isDraftPullRequest,
};
