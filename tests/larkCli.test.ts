import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildFeishuCreateDocumentArgs,
  buildFeishuUpdateDocumentArgs,
  buildLarkAuthStatusArgs,
  buildLarkAuthorizationArgs,
  buildLarkRefreshSessionArgs,
  isLarkUserTokenUsable,
  isValidLarkAuthorizationRecord,
  LarkCliService,
  missingLarkScopes,
  parseLarkCliFailure,
} from '../src/feishu/larkCli';
import {
  larkCliAuthorizationRecordPath,
} from '../src/paths';

const ALL_REQUIRED_SCOPES = [
  'im:chat:read',
  'im:message:readonly',
  'im:message.send_as_user',
  'docx:document:create',
  'docx:document:readonly',
  'docx:document:write_only',
  'docs:document.media:upload',
  'base:app:read',
  'base:record:read',
  'base:table:read',
  'calendar:calendar:read',
  'calendar:calendar.event:read',
  'calendar:calendar.event:create',
  'calendar:calendar.event:update',
  'drive:drive.metadata:readonly',
  'space:folder:create',
];

describe('LarkCliService commands', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('requests every CLI business domain with split-flow authorization', () => {
    expect(buildLarkAuthorizationArgs()).toEqual([
      'auth',
      'login',
      '--domain',
      'all',
      '--no-wait',
      '--json',
    ]);
  });

  test('verifies the stored token when checking authorization state', () => {
    expect(buildLarkAuthStatusArgs()).toEqual([
      'auth',
      'status',
      '--json',
      '--verify',
    ]);
  });

  test('compares all app scopes with the user authorization', () => {
    expect(missingLarkScopes(
      ['im:chat:read', 'base:app:read', 'calendar:calendar:read'],
      ['im:chat:read', 'calendar:calendar:read'],
    )).toEqual(['base:app:read']);
  });

  test('accepts only current all-mode authorization records', () => {
    const record = {
      authorizationMode: 'all',
      scopeVersion: 1,
      cliVersion: '1.2.3',
      authorizedAt: '2026-07-30T08:00:00.000Z',
    };
    expect(isValidLarkAuthorizationRecord(record)).toBe(true);
    expect(isValidLarkAuthorizationRecord({
      ...record,
      authorizationMode: 'docs',
    })).toBe(false);
    expect(isValidLarkAuthorizationRecord({
      ...record,
      scopeVersion: 2,
    })).toBe(false);
  });

  test('detects an independently installed system CLI', () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    expect(cli.discoverCli()).toMatchObject({
      path: path.join(env.WESIGHT_HOME!, 'bin', 'lark-cli'),
      cliStatus: 'ready',
    });
  });

  test('recovers an existing full authorization when the local record is missing', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const grantedScopes = ALL_REQUIRED_SCOPES;
    Reflect.set(cli, 'run', buildConnectionRunner(grantedScopes, grantedScopes));

    const beforeRecord = await cli.getConnectionState();
    expect(beforeRecord).toMatchObject({
      status: 'connected',
      connected: true,
      permissionsComplete: true,
      authorizationMode: 'all',
    });
    expect(beforeRecord.authorizedAt).toEqual(expect.any(String));

    const recoveredRecord: unknown = JSON.parse(
      fs.readFileSync(larkCliAuthorizationRecordPath(env), 'utf8'),
    );
    expect(isValidLarkAuthorizationRecord(recoveredRecord)).toBe(true);
    expect(recoveredRecord).toMatchObject({
      authorizationMode: 'all',
      scopeVersion: 1,
      cliVersion: beforeRecord.cliVersion,
      authorizedAt: beforeRecord.authorizedAt,
    });

    const afterRecord = await cli.getConnectionState();
    expect(afterRecord).toMatchObject({
      status: 'connected',
      connected: true,
      permissionsComplete: true,
      authorizationMode: 'all',
      authorizedAt: beforeRecord.authorizedAt,
    });
  });

  test('detects partial authorization when a Base scope is missing', async () => {
    const env = createSystemCliFixture(tempDirs);
    fs.writeFileSync(larkCliAuthorizationRecordPath(env), JSON.stringify({
      authorizationMode: 'all',
      scopeVersion: 1,
      cliVersion: '9.9.9',
      authorizedAt: '2026-07-30T08:00:00.000Z',
    }));
    const cli = new LarkCliService(env);
    const appScopes = [
      'im:chat:read',
      'base:app:read',
      'base:record:read',
      'base:table:read',
    ];
    const grantedScopes = [
      'im:chat:read',
      'base:app:read',
      'base:table:read',
    ];
    Reflect.set(cli, 'run', buildConnectionRunner(grantedScopes, appScopes));

    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({
      status: 'needs-auth',
      connected: false,
      permissionsComplete: false,
    });
    expect(connection.capabilities.base.granted).toBe(false);
  });

  test('returns to scanning when the verified user token has expired', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    Reflect.set(cli, 'run', async (args: string[]) => {
      if (args[0] === 'config') return commandResult({ appId: 'cli_test' });
      if (args[0] === 'auth' && args[1] === 'status') {
        expect(args).toContain('--verify');
        return commandResult({
          identities: {
            user: {
              status: 'missing',
              available: false,
              tokenStatus: 'expired',
              message: 'refresh token expired',
              scope: '',
            },
          },
        });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({
      status: 'needs-auth',
      connected: false,
      permissionsComplete: false,
    });
  });

  test('treats an auto-refreshable user token as still connected', () => {
    const now = Date.parse('2026-10-14T10:00:00+08:00');
    const user = {
      status: 'needs_refresh',
      available: true,
      tokenStatus: 'needs_refresh',
      refreshExpiresAt: '2026-10-20T15:15:43+08:00',
    };
    expect(isLarkUserTokenUsable(user, now)).toBe(true);
    expect(isLarkUserTokenUsable({ ...user, refreshExpiresAt: '2026-10-13T00:00:00+08:00' }, now)).toBe(false);
    expect(isLarkUserTokenUsable({ ...user, tokenStatus: 'expired' }, now)).toBe(false);
    expect(isLarkUserTokenUsable({ ...user, available: false }, now)).toBe(false);
  });

  test('refreshes the user session instead of asking to rescan', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const connectionRunner = buildConnectionRunner(
      ALL_REQUIRED_SCOPES,
      ALL_REQUIRED_SCOPES,
      'needs_refresh',
    );
    const calls: string[][] = [];
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'api') return commandResult({ ok: true });
      return connectionRunner(args);
    });

    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({ status: 'connected', connected: true });
    expect(calls).toContainEqual(buildLarkRefreshSessionArgs());
  });

  test('keeps an authorized session alive in the background', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const calls: string[][] = [];
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'auth' && args[1] === 'status') {
        expect(args).not.toContain('--verify');
        return commandResult({
          identities: { user: { status: 'needs_refresh', available: true, tokenStatus: 'needs_refresh' } },
        });
      }
      if (args[0] === 'api') return commandResult({ ok: true });
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    expect(await cli.keepAlive()).toBe(false);
    expect(calls).toEqual([]);

    fs.writeFileSync(larkCliAuthorizationRecordPath(env), JSON.stringify({
      authorizationMode: 'all',
      scopeVersion: 1,
      cliVersion: '9.9.9',
      authorizedAt: '2026-07-30T08:00:00.000Z',
    }));
    expect(await cli.keepAlive()).toBe(true);
    expect(calls).toContainEqual(buildLarkRefreshSessionArgs());
  });

  test('uses user identity, v2 and stdin for document writes', () => {
    expect(buildFeishuCreateDocumentArgs('fldcn123')).toEqual([
      'docs',
      '+create',
      '--api-version',
      'v2',
      '--as',
      'user',
      '--doc-format',
      'markdown',
      '--parent-token',
      'fldcn123',
      '--content',
      '-',
      '--json',
    ]);
    expect(buildFeishuUpdateDocumentArgs('doxcn123')).toContain('overwrite');
    expect(buildFeishuUpdateDocumentArgs('doxcn123')).toContain('-');
  });

  test('maps permission configuration URLs without adding confirmation flags', () => {
    const error = parseLarkCliFailure(
      1,
      '',
      JSON.stringify({
        error: {
          message: 'missing scope',
          console_url: 'https://open.feishu.cn/app/permission',
          permission_violations: [{ scope: 'docx:document:create' }],
        },
      }),
    );
    expect(error.message).toBe('missing scope');
    expect(error.consoleUrl).toBe('https://open.feishu.cn/app/permission');
    expect(error.permissionViolations).toEqual(['docx:document:create']);
    expect(error.confirmationRequired).toBe(false);
  });

  test('recognizes the CLI high-risk confirmation gate', () => {
    const error = parseLarkCliFailure(
      10,
      '',
      JSON.stringify({
        error: {
          type: 'confirmation_required',
          message: 'action requires confirmation',
        },
      }),
    );
    expect(error.confirmationRequired).toBe(true);
  });
});

interface MockCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
}

function commandResult(stdout: unknown): MockCommandResult {
  return {
    code: 0,
    stdout: JSON.stringify(stdout),
    stderr: '',
    cancelled: false,
    timedOut: false,
  };
}

function buildConnectionRunner(
  grantedScopes: string[],
  appScopes: string[],
  userStatus = 'ready',
): (args: string[]) => Promise<MockCommandResult> {
  return async (args: string[]) => {
    if (args[0] === 'config') {
      return commandResult({ appId: 'cli_test' });
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      expect(args).toContain('--verify');
      return commandResult({
        identity: 'user',
        identities: {
          user: {
            status: userStatus,
            available: true,
            tokenStatus: userStatus === 'ready' ? 'valid' : userStatus,
            userName: 'Test User',
            openId: 'ou_test',
            scope: grantedScopes.join(' '),
          },
        },
      });
    }
    if (args[0] === 'auth' && args[1] === 'scopes') {
      return commandResult({ userScopes: appScopes });
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
}

function createSystemCliFixture(tempDirs: string[]): NodeJS.ProcessEnv {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-lark-state-'));
  tempDirs.push(tempDir);
  const binDir = path.join(tempDir, 'bin');
  const env = {
    WESIGHT_HOME: tempDir,
    PATH: [binDir, process.env.PATH ?? ''].join(path.delimiter),
  } as NodeJS.ProcessEnv;
  const binaryPath = path.join(binDir, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, '#!/bin/sh\nprintf "lark-cli 9.9.9\\n"\n');
  fs.chmodSync(binaryPath, 0o755);
  fs.mkdirSync(path.dirname(larkCliAuthorizationRecordPath(env)), { recursive: true });
  return env;
}
