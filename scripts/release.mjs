#!/usr/bin/env node
/**
 * Releases pickfix-mcp from your machine: checks that main is ready, then starts the `publish` workflow on GitHub
 * (which bumps the version, publishes to npm, commits and tags) and follows it to the end.
 *
 *   pnpm release [patch|minor|major] [--yes] [--dry-run]
 *
 *   patch|minor|major  the bump (default patch): fixes are patch, new features minor, breaking changes major
 *   --dry-run          run the checks and show what would be released, start nothing
 *   --yes              do not ask before starting the release
 *
 * Exit code 0 when released (or ready, with --dry-run), 3 when there is nothing new since the last release, 1 otherwise.
 *
 * It never changes a version itself: only the workflow does, so npm, the tag and main always agree. To see the
 * version locally without releasing, use `node scripts/bump-version.mjs` on a throwaway branch instead.
 *
 * Needs git, the GitHub CLI (`gh auth login`) and npm on the PATH.
 */

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { BUMPS, nextVersion } from './bump-version.mjs';

export const REPO = 'ledutu-studio/pickfix-mcp';
export const PACKAGE = 'pickfix-mcp';
export const BRANCH = 'main';
export const PUBLISH_WORKFLOW = 'publish.yml';
export const CI_WORKFLOW = 'ci.yml';
/** Exit codes: 0 released (or ready, with --dry-run), 1 cannot or did not release, 3 nothing new to release. */
export const EXIT_NOTHING = 3;
const root = fileURLToPath(new URL('..', import.meta.url));

/** Reads the command line; throws on anything it does not know. */
export function parseArgs(argv) {
  const options = { bump: 'patch', yes: false, dryRun: false, help: false };
  let bumpSeen = false;
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (BUMPS.includes(arg) && !bumpSeen) {
      options.bump = arg;
      bumpSeen = true;
    } else throw new Error(`unknown argument "${arg}". Usage: pnpm release [patch|minor|major] [--yes] [--dry-run]`);
  }
  return options;
}

/**
 * What stands in the way of a release, from facts gathered about the repository. Each problem is a sentence that
 * says what to do. An empty list means the release can start.
 *
 * facts: { remoteSha, ciSha, ahead, behind, dirty, current, next, unreleased, ciStatus, ciConclusion, publishRunning,
 * npmHasNext }. `ciSha` is the newest commit CI runs on (release commits carry [skip ci]); `ciStatus` is null when
 * CI never ran there; `unreleased` counts the commits since the tag of the current version (null without that tag).
 */
export function problems(facts) {
  const list = [];
  if (facts.publishRunning) list.push('A publish run is already in progress. Wait for it to finish (gh run list --workflow publish.yml).');
  if (facts.ahead > 0) {
    list.push(`Your ${BRANCH} has ${facts.ahead} commit(s) that origin/${BRANCH} does not. Push them first: the workflow releases what is on GitHub, not your machine.`);
  }
  if (facts.unreleased === 0) list.push(`Nothing to release: origin/${BRANCH} has no commits since v${facts.current}.`);
  if (facts.ciStatus === null) {
    list.push(
      `CI has not run on ${short(facts.ciSha)}, the newest commit on origin/${BRANCH} it should run on. GitHub skips CI when a commit message contains [skip ci] anywhere, even in the body, and for changes to docs or .md files only. Push a commit that CI runs on, then retry.`,
    );
  }
  else if (facts.ciStatus !== 'completed') list.push(`CI is still running on ${short(facts.ciSha)}. Wait for it: gh run watch.`);
  else if (facts.ciConclusion !== 'success') list.push(`CI ${facts.ciConclusion} on ${short(facts.ciSha)}. Fix ${BRANCH} before releasing it.`);
  if (facts.npmHasNext) list.push(`npm already has ${PACKAGE}@${facts.next}. main's version is behind npm: check that the last release commit reached main.`);
  return list;
}

/** The newest commit CI should have run on: release commits ([skip ci]) start no CI. `log` is `<sha>\t<subject>` lines. */
export function ciCommit(log) {
  for (const line of log.split('\n')) {
    const [sha, ...subject] = line.split('\t');
    if (sha && !subject.join('\t').includes('[skip ci]')) return sha;
  }
  return null;
}

/** Things worth knowing that do not stop the release. */
export function warnings(facts) {
  const list = [];
  if (facts.behind > 0) list.push(`Your ${BRANCH} is ${facts.behind} commit(s) behind origin/${BRANCH}; the release uses origin/${BRANCH}. Pull afterwards.`);
  if (facts.dirty) list.push('You have uncommitted changes. They are not part of the release.');
  if (facts.unreleased === null) list.push(`There is no tag v${facts.current}, so the commits since the last release are not counted.`);
  return list;
}

const short = (sha) => (sha ? sha.slice(0, 7) : '?');

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function tryRun(command, args) {
  try {
    return { ok: true, out: run(command, args) };
  } catch (error) {
    return { ok: false, out: String(error.stderr ?? error.message ?? error).trim() };
  }
}

function need(command, args, hint) {
  const result = tryRun(command, args);
  if (!result.ok) throw new Error(`${hint}\n${result.out}`);
  return result.out;
}

const ghJson = (args) => JSON.parse(need('gh', [...args, '-R', REPO], 'The GitHub CLI failed. Is it installed and logged in (gh auth login)?') || 'null');

function gatherFacts(bump) {
  need('gh', ['auth', 'status'], 'The GitHub CLI is not logged in. Run: gh auth login');
  need('git', ['fetch', '--quiet', '--tags', 'origin', BRANCH], `Could not fetch origin/${BRANCH}.`);
  const remoteSha = run('git', ['rev-parse', `origin/${BRANCH}`]);
  const hasLocal = tryRun('git', ['rev-parse', '--verify', '--quiet', BRANCH]).ok;
  const [ahead, behind] = hasLocal
    ? run('git', ['rev-list', '--left-right', '--count', `${BRANCH}...origin/${BRANCH}`]).split(/\s+/).map(Number)
    : [0, 0];
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']) !== '';
  const current = JSON.parse(run('git', ['show', `origin/${BRANCH}:package.json`])).version;
  const next = nextVersion(current, bump);
  const ciSha = ciCommit(run('git', ['log', '--format=%H%x09%s', '-50', `origin/${BRANCH}`])) ?? remoteSha;
  const ciRuns = ghJson(['run', 'list', '--workflow', CI_WORKFLOW, '--commit', ciSha, '--limit', '1', '--json', 'status,conclusion,url']);
  const ci = ciRuns[0] ?? null;
  const since = tryRun('git', ['rev-list', '--count', `v${current}..origin/${BRANCH}`]);
  const publishRuns = ghJson(['run', 'list', '--workflow', PUBLISH_WORKFLOW, '--limit', '5', '--json', 'status']);
  const publishRunning = publishRuns.some((r) => r.status !== 'completed');
  const npmHasNext = tryRun('npm', ['view', `${PACKAGE}@${next}`, 'version']).out === next;
  const npmLatest = tryRun('npm', ['view', PACKAGE, 'version']);
  return {
    remoteSha,
    ciSha,
    unreleased: since.ok ? Number(since.out) : null,
    ahead,
    behind,
    dirty,
    current,
    next,
    npmLatest: npmLatest.ok ? npmLatest.out : 'unknown',
    ciStatus: ci?.status ?? null,
    ciConclusion: ci?.conclusion ?? null,
    ciUrl: ci?.url ?? null,
    publishRunning,
    npmHasNext,
  };
}

async function confirm(question) {
  if (!process.stdin.isTTY) throw new Error('Not a terminal, so there is no one to ask. Add --yes to release without asking.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The workflow_dispatch run created after `since`; GitHub needs a few seconds to list it. */
async function findRun(since) {
  for (let i = 0; i < 30; i++) {
    const runs = ghJson(['run', 'list', '--workflow', PUBLISH_WORKFLOW, '--event', 'workflow_dispatch', '--limit', '5', '--json', 'databaseId,createdAt,url']);
    const found = runs.find((r) => Date.parse(r.createdAt) >= since - 5000);
    if (found) return found;
    await sleep(2000);
  }
  throw new Error('The publish run did not show up. Look at: gh run list --workflow publish.yml');
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: pnpm release [patch|minor|major] [--yes] [--dry-run]\nSee the top of scripts/release.mjs.');
    return 0;
  }

  console.log(`Checking ${REPO} ${BRANCH}…`);
  const facts = gatherFacts(options.bump);
  const ci = facts.ciStatus === null ? 'never ran' : `${facts.ciStatus}${facts.ciConclusion ? ` (${facts.ciConclusion})` : ''}`;
  const rows = [
    [`origin/${BRANCH}`, `${short(facts.remoteSha)}${facts.unreleased === null ? '' : `, ${facts.unreleased} commit(s) since v${facts.current}`}`],
    ['CI', `${ci} on ${short(facts.ciSha)}`],
    ['version on main', facts.current],
    ['latest on npm', facts.npmLatest],
    ['release', `${facts.current} → ${facts.next} (${options.bump})`],
  ];
  console.log(`\n${rows.map(([label, value]) => `  ${label.padEnd(17)} ${value}`).join('\n')}\n`);
  for (const warning of warnings(facts)) console.log(`  ! ${warning}`);
  const blockers = problems(facts);
  if (facts.unreleased === 0 && blockers.length === 1) {
    console.log(`Nothing to release: no commits since v${facts.current}.`);
    return EXIT_NOTHING;
  }
  if (blockers.length > 0) {
    console.error('\nCannot release:');
    for (const problem of blockers) console.error(`  ✗ ${problem}`);
    return 1;
  }
  if (options.dryRun) {
    console.log(`\nDry run: everything is ready. \`pnpm release ${options.bump}\` would publish ${PACKAGE}@${facts.next}.`);
    return 0;
  }
  if (!options.yes && !(await confirm(`Publish ${PACKAGE}@${facts.next} to npm and tag v${facts.next}? [y/N] `))) {
    console.log('Nothing started.');
    return 1;
  }

  const since = Date.now();
  need('gh', ['workflow', 'run', PUBLISH_WORKFLOW, '--ref', BRANCH, '-f', `bump=${options.bump}`, '-R', REPO], 'Could not start the publish workflow.');
  const started = await findRun(since);
  console.log(`\nStarted: ${started.url}\nFollowing it (Ctrl+C stops watching, not the release)…\n`);
  const watched = tryRun('gh', ['run', 'watch', String(started.databaseId), '--exit-status', '--interval', '10', '-R', REPO]);
  if (!watched.ok) {
    console.error(`\nThe publish run failed: ${started.url}\nIts summary says whether npm got the version. Do not start another release before reading it.`);
    return 1;
  }

  need('git', ['fetch', '--quiet', '--tags', 'origin', BRANCH], `Could not fetch origin/${BRANCH}.`);
  const released = JSON.parse(run('git', ['show', `origin/${BRANCH}:package.json`])).version;
  const onMain = tryRun('git', ['symbolic-ref', '--short', 'HEAD']).out === BRANCH;
  const pulled = onMain && !facts.dirty && tryRun('git', ['merge', '--ff-only', '--quiet', `origin/${BRANCH}`]).ok;
  console.log(`
Released ${PACKAGE}@${released}
  npm      https://www.npmjs.com/package/${PACKAGE}/v/${released}
  tag      v${released}
  ${pulled ? `Your ${BRANCH} is up to date with the release commit.` : `Run \`git pull\` on ${BRANCH} to get the release commit.`}
Claude Code users get it with /plugin (update the pickfix marketplace, then the plugin); npx users on their next start.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`release: ${error.message}`);
      process.exit(1);
    },
  );
}
