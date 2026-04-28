function isDraftPullRequest(pr) {
  return pr.draft === true;
}

module.exports = {
  isDraftPullRequest,
};
