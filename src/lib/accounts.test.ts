import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_ID,
  findAccountByPassword,
  getAccountById,
  getAccounts,
  hasExtraAccounts,
} from './accounts';

/**
 * 多账号单测：ACCOUNTS 解析/容错、密码匹配、中性默认名。
 * 每个用例独立设置环境变量并还原。
 */

const ENV_KEYS = ['PASSWORD', 'PASSWORD_NAME', 'ACCOUNTS'] as const;
const savedEnv = new Map<string, string | undefined>();

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const k of ENV_KEYS) {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

const VOD = 'https://cj.lziapi.com/api.php/provide/vod';
const M3U = 'https://example.com/list.m3u';

describe('hasExtraAccounts / getAccounts', () => {
  it('不配 ACCOUNTS 时为单密码模式', () => {
    setEnv({ PASSWORD: 'pw', ACCOUNTS: undefined });
    expect(hasExtraAccounts()).toBe(false);
    expect(getAccounts().map((a) => a.id)).toEqual([DEFAULT_ACCOUNT_ID]);
  });

  it('ACCOUNTS 为空数组时仍为单密码模式', () => {
    setEnv({ PASSWORD: 'pw', ACCOUNTS: '[]' });
    expect(hasExtraAccounts()).toBe(false);
  });

  it('ACCOUNTS 格式非法时整体忽略（不炸进程）', () => {
    setEnv({ PASSWORD: 'pw', ACCOUNTS: 'not-json' });
    expect(hasExtraAccounts()).toBe(false);
    expect(getAccounts()).toHaveLength(1);
  });

  it('缺 password 的条目被跳过', () => {
    setEnv({
      PASSWORD: 'pw',
      ACCOUNTS: JSON.stringify([{ name: '坏的' }, { password: 'ok', sources: [] }]),
    });
    expect(hasExtraAccounts()).toBe(true);
    expect(getAccounts()).toHaveLength(2);
  });

  it('无 PASSWORD 时 ACCOUNTS 也可独立工作', () => {
    setEnv({ PASSWORD: undefined, ACCOUNTS: JSON.stringify([{ password: 'a' }]) });
    expect(hasExtraAccounts()).toBe(true);
    expect(getAccounts().map((a) => a.id)).toHaveLength(1);
  });
});

describe('findAccountByPassword', () => {
  it('默认账号与附加账号各回各家', () => {
    setEnv({
      PASSWORD: 'main-pw',
      ACCOUNTS: JSON.stringify([{ name: '线路一', password: 'sub-pw', sources: [] }]),
    });
    expect(findAccountByPassword('main-pw')?.id).toBe(DEFAULT_ACCOUNT_ID);
    const sub = findAccountByPassword('sub-pw');
    expect(sub?.name).toBe('线路一');
    expect(sub?.id).toMatch(/^acc_[0-9a-f]{12}$/);
  });

  it('错误密码与空输入返回 null', () => {
    setEnv({ PASSWORD: 'main-pw', ACCOUNTS: JSON.stringify([{ password: 'sub-pw' }]) });
    expect(findAccountByPassword('wrong')).toBeNull();
    expect(findAccountByPassword('')).toBeNull();
  });

  it('未配置任何密码时一律拒绝', () => {
    setEnv({ PASSWORD: undefined, ACCOUNTS: undefined });
    expect(findAccountByPassword('anything')).toBeNull();
  });

  it('重复密码取首个命中', () => {
    setEnv({
      PASSWORD: undefined,
      ACCOUNTS: JSON.stringify([{ name: '一', password: 'dup' }, { name: '二', password: 'dup' }]),
    });
    expect(findAccountByPassword('dup')?.name).toBe('一');
  });
});

describe('账号源解析', () => {
  it('源条目清洗：非法条目跳过、尾斜杠去除、缺省返回空', () => {
    setEnv({
      PASSWORD: undefined,
      ACCOUNTS: JSON.stringify([
        {
          password: 'a',
          sources: [
            { name: '好源', url: `${VOD}///` },
            { name: '', url: VOD },
            { name: '坏地址', url: 'ftp://x' },
            'not-object',
          ],
          liveSources: [{ name: '直播', url: M3U, epg: 'https://example.com/epg.xml' }],
        },
        { password: 'b' },
      ]),
    });
    const a = getAccounts().find((x) => x.name === '线路1');
    expect(a?.sources).toEqual([{ name: '好源', url: VOD, detail: undefined, isAdult: false }]);
    expect(a?.liveSources).toEqual([
      { name: '直播', url: M3U, epg: 'https://example.com/epg.xml' },
    ]);
    const b = getAccounts().find((x) => x.name === '线路2');
    expect(b?.sources).toEqual([]);
    expect(b?.liveSources).toEqual([]);
  });

  it('中性默认名：ACCOUNTS 条目缺省为 线路N，默认账号缺省为 默认线路', () => {
    setEnv({ PASSWORD: 'pw', ACCOUNTS: JSON.stringify([{ password: 'a' }]) });
    const ids = getAccounts();
    expect(ids[0].name).toBe('默认线路');
    expect(ids[1].name).toBe('线路1');
  });

  it('PASSWORD_NAME 可覆盖默认账号显示名', () => {
    setEnv({ PASSWORD: 'pw', PASSWORD_NAME: '线路A', ACCOUNTS: undefined });
    expect(getAccounts()[0].name).toBe('线路A');
  });

  it('getAccountById 未知 id 返回 null', () => {
    setEnv({ PASSWORD: 'pw' });
    expect(getAccountById('acc_nope')).toBeNull();
    expect(getAccountById('default')?.id).toBe(DEFAULT_ACCOUNT_ID);
  });
});
