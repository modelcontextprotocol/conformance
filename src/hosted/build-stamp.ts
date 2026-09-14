/**
 * The build this server was deployed from. Empty in the repository:
 * examples/hosted/deploy-valtown.ts replaces this file in the staged copy
 * it uploads with the commit and the time of the deploy, and the local
 * `hosted` command reads the commit from git instead (see ./git-build.ts).
 */
export const BUILD_STAMP: { build?: string; deployedAt?: string } = {};
