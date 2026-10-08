import crypto from 'node:crypto';
import type { LiveSourceConfig, SourceConfig } from './types';

/**
 * 多账号（不同密码不同源）。
 *
 * - PASSWORD 登录的是默认账号（id 为 default），点播/直播源取全局
 *   DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES，可单独配置；
 * - ACCOUNTS 环境变量（JSON 数组）可再配多个账号，各自独立的源；
 *   账号没配某类源时返回空数组（不回退全局）。
 * - 会话 token 绑定账号 id（见 auth.ts），/api/status 按会话账号下发源。
 */

export const DEFAULT_ACCOUNT_ID = 'default';
/** 默认账号的中性显示名（不带身份标识，可用 PASSWORD_NAME 覆盖） */
export const DEFAULT_ACCOUNT_NAME = '默认线路';

export interface AccountDef {
  /** default 或 acc_<12位hex>（由密码派生，与顺序无关） */
  id: string;
  /** 中性显示名：ACCOUNTS 条目缺省为 线路1/2…，默认账号缺省为 默认线路 */
  name: string;
  /** 点播源（不含 key，key 由 /api/status 按账号命名空间分配） */
  sources: Array<Omit<SourceConfig, 'key'>>;
  /** 直播源（同上） */
  liveSources: Array<Omit<LiveSourceConfig, 'key'>>;
}

interface ParsedAccount {
  def: AccountDef;
  password: string;
}

function accountIdFor(password: string): string {
  return (
    'acc_' +
    crypto.createHash('sha256').update('libretv::account::' + password).digest('hex').slice(0, 12)
  );
}

function isValidUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//.test(url.trim());
}

function parseVodSources(raw: unknown, owner: string): Array<Omit<SourceConfig, 'key'>> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    console.warn(`[fuhuiTV] ACCOUNTS ${owner} 的 sources 不是数组，已忽略`);
    return [];
  }
  const list: Array<Omit<SourceConfig, 'key'>> = [];
  raw.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      console.warn(`[fuhuiTV] ACCOUNTS ${owner} 的 sources[${i}] 不是对象，已跳过`);
      return;
    }
    const { name, url, detail, isAdult } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || !isValidUrl(url)) {
      console.warn(`[fuhuiTV] ACCOUNTS ${owner} 的 sources[${i}] 缺少合法 name/url，已跳过`);
      return;
    }
    list.push({
      name: name.trim(),
      url: (url as string).trim().replace(/\/+$/, ''),
      detail: typeof detail === 'string' && detail.trim() ? detail.trim() : undefined,
      isAdult: isAdult === true,
    });
  });
  return list;
}

function parseLiveSources(raw: unknown, owner: string): Array<Omit<LiveSourceConfig, 'key'>> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    console.warn(`[fuhuiTV] ACCOUNTS ${owner} 的 liveSources 不是数组，已忽略`);
    return [];
  }
  const list: Array<Omit<LiveSourceConfig, 'key'>> = [];
  raw.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      console.warn(`[fuhuiTV] ACCOUNTS ${owner} 的 liveSources[${i}] 不是对象，已跳过`);
      return;
    }
    const { name, url, epg } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || !isValidUrl(url)) {
      console.warn(`[fuhuiTV] ACCOUNTS ${owner} 的 liveSources[${i}] 缺少合法 name/url，已跳过`);
      return;
    }
    list.push({
      name: name.trim(),
      url: (url as string).trim().replace(/\/+$/, ''),
      epg: typeof epg === 'string' && epg.trim() ? epg.trim() : undefined,
    });
  });
  return list;
}

function parseAccounts(): ParsedAccount[] {
  const list: ParsedAccount[] = [];
  const mainPassword = process.env.PASSWORD || '';
  if (mainPassword) {
    list.push({
      def: {
        id: DEFAULT_ACCOUNT_ID,
        name: process.env.PASSWORD_NAME || DEFAULT_ACCOUNT_NAME,
        sources: [],
        liveSources: [],
      },
      password: mainPassword,
    });
  }
  const raw = process.env.ACCOUNTS || '';
  if (!raw.trim()) return list;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[fuhuiTV] ACCOUNTS 解析失败，已忽略：', err instanceof Error ? err.message : err);
    return list;
  }
  if (!Array.isArray(parsed)) {
    console.warn('[fuhuiTV] ACCOUNTS 必须是 JSON 数组，已忽略');
    return list;
  }
  parsed.forEach((item, i) => {
    const owner = `第 ${i + 1} 项`;
    if (typeof item !== 'object' || item === null) {
      console.warn(`[fuhuiTV] ACCOUNTS ${owner}不是对象，已跳过`);
      return;
    }
    const { name, password, sources, liveSources } = item as Record<string, unknown>;
    if (typeof password !== 'string' || !password) {
      console.warn(`[fuhuiTV] ACCOUNTS ${owner}缺少 password，已跳过`);
      return;
    }
    list.push({
      def: {
        id: accountIdFor(password),
        name: typeof name === 'string' && name.trim() ? name.trim() : `线路${i + 1}`,
        sources: parseVodSources(sources, owner),
        liveSources: parseLiveSources(liveSources, owner),
      },
      password,
    });
  });
  return list;
}

/** 是否启用多账号模式（ACCOUNTS 配出至少一个有效账号） */
export function hasExtraAccounts(): boolean {
  return parseAccounts().some((a) => a.def.id !== DEFAULT_ACCOUNT_ID);
}

/** 账号定义（不含密码，供服务端内部使用） */
export function getAccounts(): AccountDef[] {
  return parseAccounts().map((a) => a.def);
}

/** 按 id 取账号定义，无匹配返回 null */
export function getAccountById(id: string): AccountDef | null {
  return parseAccounts().find((a) => a.def.id === id)?.def ?? null;
}

/**
 * 按密码查账号（恒定时间比较摘要；全量比对，命中取首个）。
 * 无匹配返回 null。空输入直接拒绝。
 */
export function findAccountByPassword(input: string): AccountDef | null {
  if (!input) return null;
  const digestOf = (s: string) => crypto.createHash('sha256').update(s).digest();
  const want = digestOf(input);
  let matched: AccountDef | null = null;
  for (const entry of parseAccounts()) {
    const got = digestOf(entry.password);
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) {
      matched ??= entry.def;
    }
  }
  return matched;
}
