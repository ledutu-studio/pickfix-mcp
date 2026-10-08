import { describe, expect, it } from 'vitest';
import { ciCommit, parseArgs, problems, warnings, type ReleaseFacts } from '../scripts/release.mjs';

const ready: ReleaseFacts = {
  remoteSha: 'aaaaaaa1111111',
  ciSha: 'aaaaaaa1111111',
  current: '1.2.0',
  next: '1.3.0',
  unreleased: 3,
  ahead: 0,
  behind: 0,
  dirty: false,
  ciStatus: 'completed',
  ciConclusion: 'success',
  publishRunning: false,
  npmHasNext: false,
};

describe('parseArgs', () => {
  it('defaults to a patch release that asks first', () => {
    expect(parseArgs([])).toEqual({ bump: 'patch', yes: false, dryRun: false, help: false });
  });

  it('reads the bump and the flags in any order', () => {
    expect(parseArgs(['--dry-run', 'minor', '-y'])).toEqual({ bump: 'minor', yes: true, dryRun: true, help: false });
    expect(parseArgs(['major', '-n']).bump).toBe('major');
  });

  it('refuses unknown arguments and a second bump', () => {
    expect(() => parseArgs(['1.3.0'])).toThrow('unknown argument "1.3.0"');
    expect(() => parseArgs(['minor', 'patch'])).toThrow('unknown argument "patch"');
    expect(() => parseArgs(['--force'])).toThrow('Usage: pnpm release');
  });
});

describe('ciCommit', () => {
  it('skips release commits, which start no CI', () => {
    expect(ciCommit('r1\tchore(release): 1.2.0 [skip ci]\nf2\tfeat: PICKFIX_PORT\nf1\tfix: x')).toBe('f2');
  });

  it('takes the newest commit when it is not a release', () => {
    expect(ciCommit('f3\tdocs: readme\nr1\tchore(release): 1.2.0 [skip ci]')).toBe('f3');
  });

  it('gives null when every commit skips CI', () => {
    expect(ciCommit('r1\tchore(release): 1.2.0 [skip ci]')).toBeNull();
  });
});

describe('problems', () => {
  it('has none when main is pushed, green and has something new', () => {
    expect(problems(ready)).toEqual([]);
  });

  it('stops while another publish runs', () => {
    expect(problems({ ...ready, publishRunning: true })[0]).toContain('already in progress');
  });

  it('stops on local commits that GitHub does not have', () => {
    expect(problems({ ...ready, ahead: 2 })[0]).toContain('2 commit(s) that origin/main does not');
  });

  it('stops when there is nothing new since the last release', () => {
    expect(problems({ ...ready, unreleased: 0 })[0]).toContain('no commits since v1.2.0');
  });

  it('stops unless CI passed on the commit it should have run on', () => {
    expect(problems({ ...ready, ciStatus: null })[0]).toContain('CI has not run on aaaaaaa');
    expect(problems({ ...ready, ciStatus: 'in_progress', ciConclusion: null })[0]).toContain('still running');
    expect(problems({ ...ready, ciConclusion: 'failure' })[0]).toContain('CI failure on aaaaaaa');
  });

  it('stops when npm already has the next version', () => {
    expect(problems({ ...ready, npmHasNext: true })[0]).toContain('npm already has pickfix-mcp@1.3.0');
  });
});

describe('warnings', () => {
  it('mentions a local main behind GitHub, uncommitted work and a missing tag, without stopping', () => {
    const facts = { ...ready, behind: 1, dirty: true, unreleased: null };
    expect(warnings(facts)).toHaveLength(3);
    expect(problems(facts)).toEqual([]);
  });
});
