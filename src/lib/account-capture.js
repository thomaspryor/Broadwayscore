/** Keep the email follow prompt hidden until authentication settles.
 * @param {boolean} authLoading
 * @param {boolean} isAuthenticated
 */
function showFollowEligible(authLoading, isAuthenticated) {
  return !authLoading && !isAuthenticated;
}

/** Both funnel property names identify the same entry point.
 * @param {string | null} source
 */
function signInOpenerProperties(source) {
  return { source, context: source };
}

module.exports = { showFollowEligible, signInOpenerProperties };
