import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { GitSyncService } from '../src/gitSync/service';
import { isSyncPathExcluded, parseGitChanges } from '../src/gitSync/types';

const cleanups: string[] = [];
const services: GitSyncService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const directory of cleanups.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function team() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-git-sync-'));
  cleanups.push(directory);
  const globalConfig = path.join(directory, 'global-config');
  fs.writeFileSync(globalConfig, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig };
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = path.join(directory, 'team.git');
  git(directory, 'init', '--bare', remote);
  const alice = path.join(directory, 'alice');
  git(directory, 'clone', remote, alice);
  const identity = (cwd: string): void => {
    git(cwd, 'config', 'user.name', 'Test Teammate');
    git(cwd, 'config', 'user.email', 'team@example.test');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    git(cwd, 'config', 'core.hooksPath', path.join(directory, 'no-hooks'));
  };
  identity(alice);
  git(alice, 'checkout', '-b', 'main');
  fs.writeFileSync(path.join(alice, 'note.md'), 'original\n');
  git(alice, 'add', '.');
  git(alice, 'commit', '-m', 'Initial');
  git(alice, 'push', '-u', 'origin', 'main');
  const bob = path.join(directory, 'bob');
  git(directory, 'clone', '--branch', 'main', remote, bob);
  identity(bob);
  let time = 1_800_000_000_000;
  const notify = vi.fn();
  const serviceFor = (vaultPath = alice, settingsDir = path.join(directory, 'settings')) => {
    const service = new GitSyncService({ vaultPath, configDir: '.config-obsidian', settingsDir, env, now: () => time, notify });
    services.push(service);
    return service;
  };
  const commit = (cwd: string, file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
    git(cwd, 'add', '--', file);
    git(cwd, 'commit', '-m', `Update ${file}`);
  };
  return { directory, alice, bob, remote, git, commit, serviceFor, notify, advance: (minutes: number) => { time += minutes * 60_000; } };
}

describe('Git changes and scope', () => {
  test('parses Chinese, spaces, newlines, renames and conflicts without losing file paths', () => {
    expect(parseGitChanges(' M 中文 空格.md\0?? line\nbreak.md\0R  新名字.md\0旧名字.md\0UU conflict.md\0'))
      .toMatchObject([
        { path: '中文 空格.md', working: 'M', conflict: false },
        { path: 'line\nbreak.md', untracked: true },
        { path: '新名字.md', index: 'R' },
        { path: 'conflict.md', conflict: true },
      ]);
  });

  test('excludes directory descendants and wildcard filenames, including literal regex characters', () => {
    expect(isSyncPathExcluded('.wesight/chats/a.json', ['.wesight/'])).toBe(true);
    expect(isSyncPathExcluded('.wesight-notes.md', ['.wesight/'])).toBe(false);
    expect(isSyncPathExcluded('.env.production', ['.env.*'])).toBe(true);
    expect(isSyncPathExcluded('notes/[draft].md', ['notes/[draft].md'])).toBe(true);
  });
});

describe('GitSyncService with two real collaborators', () => {
  test('checks remote commits and manually pulls into the current tracking branch', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    expect(s.getState()).toMatchObject({ available: true, branch: 'main', remote: 'origin', ahead: 0, behind: 0 });
    t.commit(t.bob, '团队更新.md', 'team update'); t.git(t.bob, 'push');
    expect((await s.check()).ok).toBe(true);
    expect(s.getState().behind).toBe(1);
    expect((await s.pull()).ok).toBe(true);
    expect(fs.readFileSync(path.join(t.alice, '团队更新.md'), 'utf8')).toBe('team update');
    expect(s.getState().behind).toBe(0);
    expect(s.getState().history[0].action).toBe('拉取团队更新');
  });

  test('preserves uncommitted local edits when remote updates arrive', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'local unsaved work\n');
    t.commit(t.bob, 'team.md', 'remote'); t.git(t.bob, 'push');
    const head = t.git(t.alice, 'rev-parse', 'HEAD');
    const result = await s.pull();
    expect(result.ok).toBe(false); expect(result.message).toContain('尚未提交');
    expect(fs.readFileSync(path.join(t.alice, 'note.md'), 'utf8')).toBe('local unsaved work\n');
    expect(t.git(t.alice, 'rev-parse', 'HEAD')).toBe(head);
    expect(t.git(t.alice, 'stash', 'list')).toBe('');
  });

  test('merges independent team changes and pushes the combined history without forcing', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    t.commit(t.alice, 'alice.md', 'alice'); t.commit(t.bob, 'bob.md', 'bob'); t.git(t.bob, 'push');
    const result = await s.push();
    expect(result.ok).toBe(false); expect(result.message).toContain('先拉取');
    expect((await s.pull()).ok).toBe(true);
    expect(t.git(t.alice, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect((await s.push()).ok).toBe(true);
    t.git(t.bob, 'pull', '--ff-only');
    expect(fs.readFileSync(path.join(t.bob, 'alice.md'), 'utf8')).toBe('alice');
    expect(fs.readFileSync(path.join(t.alice, 'bob.md'), 'utf8')).toBe('bob');
    expect(s.getState()).toMatchObject({ ahead: 0, behind: 0 });
  });

  test('reports conflicts and pauses automatic writes until the user completes the merge', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    await s.saveSettings({ ...s.getSettings(), autoPull: true, autoPush: true });
    t.commit(t.alice, 'note.md', 'alice changed\n'); t.commit(t.bob, 'note.md', 'bob changed\n'); t.git(t.bob, 'push');
    const remoteHead = t.git(t.bob, 'rev-parse', 'HEAD');
    expect((await s.pull()).ok).toBe(false);
    expect(s.getState().changes.some(c => c.conflict)).toBe(true);
    expect(s.getState().pausedReason).toContain('冲突');
    t.advance(5); await s.tick();
    expect(t.git(t.remote, 'rev-parse', 'refs/heads/main')).toBe(remoteHead);
    expect(t.notify).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'resolved\n');
    t.git(t.alice, 'add', 'note.md'); t.git(t.alice, 'commit', '-m', 'Resolve');
    t.advance(5); await s.tick();
    expect(s.getState()).toMatchObject({ ahead: 0, behind: 0, pausedReason: null, error: null });
  });

  test('does not overwrite an untracked file colliding with a teammate file', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'new.md'), 'local draft');
    t.commit(t.bob, 'new.md', 'remote version'); t.git(t.bob, 'push');
    expect((await s.pull()).ok).toBe(false);
    expect(fs.readFileSync(path.join(t.alice, 'new.md'), 'utf8')).toBe('local draft');
  });

  test('defaults to no automatic writes or network fetches', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    expect(s.getSettings()).toMatchObject({ autoPull: false, autoPush: false, autoCommit: false, pullOnOpen: false });
    t.commit(t.bob, 'remote.md', 'remote'); t.git(t.bob, 'push');
    t.advance(30); await s.onVaultOpened(); await s.tick();
    expect(s.getState().remoteCheckedAt).toBe(null);
    expect(fs.existsSync(path.join(t.alice, 'remote.md'))).toBe(false);
  });

  test('automatically commits only allowed files and pushes after the idle interval', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    expect((await s.saveSettings({ ...s.getSettings(), autoCommit: true, autoPull: true, autoPush: true,
      intervalMinutes: 30, idleMinutes: 1 })).ok).toBe(true);
    for (const [file, content] of [['note.md', 'edited'], ['中文 空格.md', 'new'], [':(glob)literal.md', 'literal'],
      ['.wesight/chats/private.json', 'private'], ['.config-obsidian/plugins/wesight/data.json', 'credential'], ['.env.local', 'secret']]) {
      fs.mkdirSync(path.dirname(path.join(t.alice, file)), { recursive: true });
      fs.writeFileSync(path.join(t.alice, file), content);
    }
    s.markActivity('note.md'); t.advance(0.5); await s.tick();
    expect(t.git(t.alice, 'log', '-1', '--format=%s')).toBe('Initial');
    t.advance(0.6); await s.tick();
    expect(t.git(t.alice, 'log', '-1', '--format=%s')).toContain('知识库更新');
    const pushedFiles = t.git(t.remote, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'main');
    expect(pushedFiles).toContain('中文 空格.md');
    expect(pushedFiles).toContain(':(glob)literal.md');
    expect(pushedFiles).not.toContain('private.json');
    expect(pushedFiles).not.toContain('data.json');
    expect(pushedFiles).not.toContain('.env.local');
    expect(s.getState().ahead).toBe(0);
  });

  test('leaves manually staged edits untouched and skips automatic commit', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    await s.saveSettings({ ...s.getSettings(), autoCommit: true });
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'staged'); t.git(t.alice, 'add', 'note.md');
    t.advance(5); await s.tick();
    expect(t.git(t.alice, 'log', '-1', '--format=%s')).toBe('Initial');
    expect(t.git(t.alice, 'diff', '--cached', '--name-only')).toBe('note.md');
    expect(s.getState().error).toContain('暂存区');
  });

  test('binds automatic operations to the saved branch and resumes only after saving the new target', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    await s.saveSettings({ ...s.getSettings(), autoPush: true });
    t.git(t.alice, 'checkout', '-b', 'other'); t.git(t.alice, 'push', '-u', 'origin', 'other');
    t.commit(t.alice, 'other.md', 'other branch');
    t.advance(5); await s.tick();
    expect(s.getState().pausedReason).toContain('已变更');
    expect(t.git(t.remote, 'ls-tree', '-r', '--name-only', 'other')).not.toContain('other.md');
    expect((await s.saveSettings(s.getSettings())).ok).toBe(true);
    expect(s.getState().pausedReason).toBe(null);
    t.advance(5); await s.tick();
    expect(t.git(t.remote, 'ls-tree', '-r', '--name-only', 'other')).toContain('other.md');
  });

  test('persists settings and history per vault on this device, with no credential in the record', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    await s.saveSettings({ ...s.getSettings(), autoPull: true }); await s.check();
    const second = t.serviceFor(); await second.initialize();
    expect(second.getSettings().autoPull).toBe(true);
    expect(second.getState().history[0].action).toBe('检查远程更新');
    const otherVault = t.serviceFor(t.bob); await otherVault.initialize();
    expect(otherVault.getSettings().autoPull).toBe(false);
    expect(fs.readdirSync(t.alice)).not.toContain('git-sync.json');
    const records = fs.readdirSync(path.join(t.directory, 'settings')).map(file => fs.readFileSync(path.join(t.directory, 'settings', file), 'utf8')).join('');
    expect(records).not.toContain('apiKey');
  });

  test('pulls on vault open independently of the periodic pull switch', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    await s.saveSettings({ ...s.getSettings(), pullOnOpen: true });
    t.commit(t.bob, 'welcome.md', 'welcome'); t.git(t.bob, 'push');
    await s.onVaultOpened();
    expect(fs.existsSync(path.join(t.alice, 'welcome.md'))).toBe(true);
    expect(s.getSettings().autoPull).toBe(false);
  });

  test('scopes automatic commits to a vault nested inside a larger Git repository', async () => {
    const t = team(); const vault = path.join(t.alice, 'vault'); fs.mkdirSync(vault);
    const s = t.serviceFor(vault); await s.initialize();
    await s.saveSettings({ ...s.getSettings(), autoCommit: true, autoPush: true });
    fs.writeFileSync(path.join(vault, 'nested.md'), 'in scope'); fs.writeFileSync(path.join(t.alice, 'outside.md'), 'out of scope');
    t.advance(5); await s.tick();
    const committed = t.git(t.alice, 'show', '--format=', '--name-only', 'HEAD');
    expect(committed).toBe('vault/nested.md');
    expect(t.git(t.alice, 'status', '--short')).toContain('outside.md');
  });

  test('serializes Git operations and stops background work after disposal', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    const first = s.check();
    const concurrent = await s.pull();
    expect(concurrent.ok).toBe(false); expect(concurrent.message).toContain('正在执行');
    expect((await first).ok).toBe(true);
    s.dispose();
    const stopped = await s.push();
    expect(stopped.ok).toBe(false); expect(stopped.message).toContain('已停止');
  });

  test('offers a usable diagnostic for a knowledge vault without Git or upstream', async () => {
    const t = team(); const empty = path.join(t.directory, 'no-repo'); fs.mkdirSync(empty);
    const s = t.serviceFor(empty); await s.initialize();
    expect(s.getState().available).toBe(false); expect(s.getState().error).toContain('尚未连接');
    const noUpstream = t.serviceFor();
    t.git(t.alice, 'branch', '--unset-upstream'); await noUpstream.initialize();
    expect(noUpstream.getState().pausedReason).toContain('跟踪分支');
    expect((await noUpstream.saveSettings({ ...noUpstream.getSettings(), autoPull: true })).ok).toBe(false);
    expect(noUpstream.getSettings().autoPull).toBe(false);
  });

  test('can disable automation even when the Git repository is no longer accessible', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    await s.saveSettings({ ...s.getSettings(), autoPull: true });
    fs.renameSync(path.join(t.alice, '.git'), path.join(t.alice, 'git-disabled'));
    expect((await s.saveSettings({ ...s.getSettings(), autoPull: false })).ok).toBe(true);
    expect(s.getSettings().target).toBe(null);
    expect(s.getSettings().autoPull).toBe(false);
    const restarted = t.serviceFor(); await restarted.initialize();
    expect(restarted.getSettings().autoPull).toBe(false);
  });

  test('hides remote URL credentials in the UI and stores only a target hash', async () => {
    const t = team();
    t.git(t.alice, 'remote', 'set-url', 'origin', 'https://alice:secret-token@github.com/team/knowledge.git?token=secret-query');
    const s = t.serviceFor(); await s.initialize();
    expect(s.getState().remoteUrl).toBe('https://github.com/team/knowledge.git');
    await s.saveSettings({ ...s.getSettings(), autoPull: true });
    const records = fs.readdirSync(path.join(t.directory, 'settings')).map(file => fs.readFileSync(path.join(t.directory, 'settings', file), 'utf8')).join('');
    expect(records).not.toContain('secret-token'); expect(records).not.toContain('secret-query');
  });

  test('uses the upstream branch name when it differs from the local branch', async () => {
    const t = team(); t.git(t.alice, 'push', '-u', 'origin', 'main:shared');
    const s = t.serviceFor(); await s.initialize();
    expect(s.getState().remoteBranch).toBe('shared');
    t.commit(t.bob, 'shared.md', 'shared'); t.git(t.bob, 'push', 'origin', 'HEAD:shared');
    expect((await s.pull()).ok).toBe(true);
    t.commit(t.alice, 'local.md', 'local'); expect((await s.push()).ok).toBe(true);
    expect(t.git(t.remote, 'ls-tree', '-r', '--name-only', 'shared')).toContain('local.md');
    expect(t.git(t.remote, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('local.md');
  });

  test('respects gitignore and always excludes the configured Obsidian directory', async () => {
    const t = team(); t.commit(t.alice, '.gitignore', 'ignored.md\n'); t.git(t.alice, 'push');
    const s = t.serviceFor(); await s.initialize();
    await s.saveSettings({ ...s.getSettings(), autoCommit: true, excludedPaths: [] });
    fs.mkdirSync(path.join(t.alice, '.config-obsidian'));
    fs.writeFileSync(path.join(t.alice, '.config-obsidian', 'data.json'), 'sensitive');
    fs.writeFileSync(path.join(t.alice, 'ignored.md'), 'ignored');
    fs.writeFileSync(path.join(t.alice, 'allowed.md'), 'allowed');
    t.advance(5); await s.tick();
    expect(t.git(t.alice, 'show', '--format=', '--name-only', 'HEAD')).toBe('allowed.md');
    expect(s.getState().remoteCheckedAt).toBe(null);
  });

  test('resets the idle timer on content edits while excluded chat activity does not delay commits', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    await s.saveSettings({ ...s.getSettings(), autoCommit: true, idleMinutes: 1, intervalMinutes: 30 });
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'content');
    t.advance(0.9); s.markActivity('note.md'); t.advance(0.2); await s.tick();
    expect(t.git(t.alice, 'log', '-1', '--format=%s')).toBe('Initial');
    t.advance(0.9); s.markActivity('.wesight/chats/conversation.json'); await s.tick();
    expect(t.git(t.alice, 'log', '-1', '--format=%s')).toContain('知识库更新');
  });

  test('reports a missing Git executable without preventing local settings access', async () => {
    const t = team(); const s = new GitSyncService({ vaultPath: t.alice, configDir: '.config-obsidian',
      settingsDir: path.join(t.directory, 'missing-git-settings'), gitPath: path.join(t.directory, 'no-git-executable') });
    services.push(s); await s.initialize();
    expect(s.getState().error).toContain('未找到 Git');
    expect((await s.saveSettings(s.getSettings())).ok).toBe(true);
  });

  test('ignores inherited checkout overrides and operates on the selected vault', async () => {
    const t = team();
    const s = new GitSyncService({ vaultPath: t.alice, configDir: '.config-obsidian',
      settingsDir: path.join(t.directory, 'env-settings'),
      env: { ...process.env, GIT_DIR: path.join(t.bob, '.git'), GIT_WORK_TREE: t.bob } });
    services.push(s); await s.initialize();
    expect(s.getState().root).toBe(fs.realpathSync(t.alice));
    t.commit(t.bob, 'chosen-vault.md', 'incoming'); t.git(t.bob, 'push');
    expect((await s.pull()).ok).toBe(true);
    expect(fs.readFileSync(path.join(t.alice, 'chosen-vault.md'), 'utf8')).toBe('incoming');
  });

  test('identifies remote branch protection instead of suggesting another pull', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    fs.writeFileSync(path.join(t.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "GH013: protected branch requires a pull request" >&2\nexit 1\n', { mode: 0o755 });
    t.commit(t.alice, 'protected.md', 'local commit');
    const result = await s.push();
    expect(result.ok).toBe(false); expect(result.message).toContain('分支规则');
    expect(t.git(t.remote, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('protected.md');
    expect(fs.readFileSync(path.join(t.alice, 'protected.md'), 'utf8')).toBe('local commit');
  });

  test('commits a selected working-tree edit and pushes it without requiring automatic commit', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'manual edit\n');
    const result = await s.commitAndPush(['note.md'], '修订正文');
    expect(result.ok).toBe(true);
    expect(t.git(t.remote, 'show', 'main:note.md')).toBe('manual edit');
    expect(t.git(t.alice, 'log', '-1', '--format=%s')).toBe('修订正文');
    expect(s.getState().changes).toHaveLength(0);
    expect(s.getSettings().autoCommit).toBe(false);
  });

  test('does not include unselected files or another client staged changes in a manual commit', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'selected');
    fs.writeFileSync(path.join(t.alice, 'other.md'), 'unselected staged');
    t.git(t.alice, 'add', 'other.md');
    expect((await s.commitAndPush(['note.md'], 'Selected only')).ok).toBe(true);
    expect(t.git(t.alice, 'show', '--format=', '--name-only', 'HEAD')).toBe('note.md');
    expect(t.git(t.alice, 'diff', '--cached', '--name-only')).toBe('other.md');
    expect(t.git(t.remote, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('other.md');
  });

  test('commits locally then merges independent remote updates before pushing', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'my edit');
    t.commit(t.bob, 'new-team.md', 'team'); t.git(t.bob, 'push');
    expect((await s.commitAndPush(['note.md'], 'My update')).ok).toBe(true);
    expect(t.git(t.remote, 'show', 'main:note.md')).toBe('my edit');
    expect(t.git(t.remote, 'show', 'main:new-team.md')).toBe('team');
  });

  test('retains the local commit and reports a conflict instead of pushing conflict markers', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'my changed text');
    t.commit(t.bob, 'note.md', 'team changed text'); t.git(t.bob, 'push');
    const result = await s.commitAndPush(['note.md'], 'My conflicting update');
    expect(result.ok).toBe(false); expect(result.message).toContain('本地提交已保存');
    expect(result.message).toContain('冲突');
    expect(t.git(t.alice, 'log', '-1', '--format=%s')).toBe('My conflicting update');
    expect(t.git(t.remote, 'show', 'main:note.md')).toBe('team changed text');
  });

  test('validates manual commit selection and message before staging any content', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'local edit');
    expect((await s.commitAndPush(['note.md'], '')).ok).toBe(false);
    expect((await s.commitAndPush(['../outside.md'], 'Bad scope')).ok).toBe(false);
    expect((await s.commitAndPush([], 'No file')).ok).toBe(false);
    expect(t.git(t.alice, 'diff', '--cached', '--name-only')).toBe('');
    expect(t.git(t.alice, 'log', '-1', '--format=%s')).toBe('Initial');
  });

  test('generates a summary from selected staged and unstaged differences without committing or contacting AI', async () => {
    const t = team(); const s = t.serviceFor(); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'original3\n');
    fs.writeFileSync(path.join(t.alice, 'other.md'), 'unselected');
    const before = t.git(t.alice, 'rev-parse', 'HEAD');
    const summary = await s.summarizeCommit(['note.md']);
    expect(summary.ok).toBe(true); expect(summary.message).toBe('note.md：添加「3」');
    expect(summary.message).not.toContain('other.md');
    expect(t.git(t.alice, 'rev-parse', 'HEAD')).toBe(before);
    expect(t.git(t.alice, 'diff', '--cached', '--name-only')).toBe('');
    expect(s.getState().remoteCheckedAt).toBe(null);
    t.git(t.alice, 'add', 'note.md');
    expect((await s.summarizeCommit(['note.md'])).message).toBe('note.md：添加「3」');
  });

  test('AI receives only selected allowed files and bounded differences, without any Git write', async () => {
    const t = team();
    const ai = vi.fn(async (_diffs: Array<{ file: string; patch: string; truncated: boolean }>, _signal: AbortSignal) => '添加尾部数字标记');
    const s = new GitSyncService({ vaultPath: t.alice, configDir: '.config-obsidian',
      settingsDir: path.join(t.directory, 'summary-settings'), generateCommitMessage: ai });
    services.push(s); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'note.md'), 'original3\n');
    fs.writeFileSync(path.join(t.alice, 'other.md'), 'unselected-private-content');
    const result = await s.summarizeCommit(['note.md'], true);
    expect(result.message).toBe('添加尾部数字标记');
    expect(ai.mock.calls[0][0]).toHaveLength(1);
    expect(ai.mock.calls[0][0][0].file).toBe('note.md');
    expect(ai.mock.calls[0][0][0].patch).toContain('+original3');
    expect(t.git(t.alice, 'log', '-1', '--format=%s')).toBe('Initial');
    expect((await s.summarizeCommit(['.env'], true)).ok).toBe(false);
    expect(ai).toHaveBeenCalledOnce();
  });

  test('limits new-file content sent to a summary model and handles excluded files without reading them', async () => {
    const t = team();
    const ai = vi.fn(async (_diffs: Array<{ file: string; patch: string; truncated: boolean }>, _signal: AbortSignal) => '新增文章');
    const s = new GitSyncService({ vaultPath: t.alice, configDir: '.config-obsidian',
      settingsDir: path.join(t.directory, 'summary-settings'), generateCommitMessage: ai });
    services.push(s); await s.initialize();
    fs.writeFileSync(path.join(t.alice, 'large.md'), 'long content\n'.repeat(1000));
    fs.writeFileSync(path.join(t.alice, '.env'), 'SECRET=private');
    expect((await s.summarizeCommit(['large.md'], true)).ok).toBe(true);
    const diff = ai.mock.calls[0][0][0];
    expect(diff.patch.length).toBeLessThanOrEqual(8_000); expect(diff.truncated).toBe(true);
    expect((await s.summarizeCommit(['.env'], true)).ok).toBe(false);
    expect(ai).toHaveBeenCalledOnce();
  });
});
