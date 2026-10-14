import fs from 'fs';
import { expect, test, vi } from 'vitest';
import { generateAiCommitMessage, summarizeGitDiffs, type GitCommitDiff } from '../src/gitSync/commitMessage';
import type { RuntimeManager } from '../src/runtime/runtimeManager';
import type { ChatTurnRequest, RuntimeTurnEvent } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/types';

test('describes the exact inserted character and retains the Chinese filename', () => {
  expect(summarizeGitDiffs([{ file: '公众号/开演唱会.md', kind: 'modified', truncated: false,
    patch: '@@ -1 +1 @@\n-买一瓶酱油。\n+买一瓶酱油。3\n' }])).toBe('开演唱会.md：添加「3」');
});

test('describes replacements and deletions without inventing a reason', () => {
  expect(summarizeGitDiffs([{ file: 'note.md', kind: 'modified', truncated: false,
    patch: '-这是旧版文案\n+这是新版文案\n' }])).toContain('将「旧」改为「新」');
  expect(summarizeGitDiffs([{ file: 'note.md', kind: 'modified', truncated: false,
    patch: '-正文3\n+正文\n' }])).toContain('删除「3」');
});

test('summarizes only the supplied files and labels truncated evidence', () => {
  const summary = summarizeGitDiffs([
    { file: 'new.md', kind: 'added', patch: '+content', truncated: false },
    { file: 'old.md', kind: 'deleted', patch: '-content', truncated: false },
    { file: 'large.md', kind: 'modified', patch: '-old\n+new', truncated: true },
  ]);
  expect(summary).toContain('更新 3 个文件');
  expect(summary).toContain('新增 new.md'); expect(summary).toContain('删除 old.md');
  expect(summary).toContain('差异已截断');
});

test('AI summary uses the configured agent without tools, vault cwd or committing', async () => {
  let request!: ChatTurnRequest;
  const runtime = { runTurn: vi.fn(async (input: ChatTurnRequest, emit: (event: RuntimeTurnEvent) => void) => {
    request = input;
    emit({ type: 'text', content: '调整首段' });
    emit({ type: 'text', content: '调整首段的数字标记' });
  }) };
  const diffs: GitCommitDiff[] = [{ file: 'note.md', kind: 'modified', patch: '-正文\n+正文3', truncated: false }];
  const result = await generateAiCommitMessage(runtime as unknown as RuntimeManager,
    { ...DEFAULT_SETTINGS, defaultAgentId: 'codex' }, diffs, new AbortController().signal);
  expect(result).toBe('调整首段的数字标记');
  expect(request.agentId).toBe('codex'); expect(request.textOnly).toBe(true);
  expect(request.accessMode).toBe('read-only'); expect(request.logPolicy).toBe('metadata-only');
  expect(request.prompt).toContain('正文3');
  expect(fs.existsSync(request.cwd)).toBe(false);
});

test('empty, error and cancelled AI output cannot replace a user commit message', async () => {
  const empty = { runTurn: vi.fn(async () => undefined) };
  const diffs: GitCommitDiff[] = [{ file: 'note.md', kind: 'modified', patch: '+text', truncated: false }];
  await expect(generateAiCommitMessage(empty as unknown as RuntimeManager, DEFAULT_SETTINGS, diffs,
    new AbortController().signal)).rejects.toThrow('未返回');
  const failed = { runTurn: vi.fn(async (_req: ChatTurnRequest, emit: (event: RuntimeTurnEvent) => void) => {
    emit({ type: 'error', message: '模型暂不可用' });
  }) };
  await expect(generateAiCommitMessage(failed as unknown as RuntimeManager, DEFAULT_SETTINGS, diffs,
    new AbortController().signal)).rejects.toThrow('模型暂不可用');
  const controller = new AbortController(); controller.abort();
  await expect(generateAiCommitMessage(empty as unknown as RuntimeManager, DEFAULT_SETTINGS, diffs,
    controller.signal)).rejects.toThrow('取消');
});
