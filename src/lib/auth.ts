import crypto from 'node:crypto';
import { DEFAULT_ACCOUNT_ID, hasExtraAccounts } from './accounts';

/**
 * 会话鉴权：httpOnly cookie + HMAC 签名。
 *
 * 相比旧版的改进：
 * - 页面源码不再下发 sha256(password)，前端拿不到任何可重放的凭证；
 * - 兼容模式「哈希即凭证」被彻底移除；
 * - 登录接口只接受 POST body，不再把明文密码放 query。
 */

export const SESSION_COOKIE = 'ltv_session';
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 天

export function getPassword(): string {
  return process.env.PASSWORD || '';
}

export function isPasswordConfigured(): boolean {
  return getPassword().length > 0 || hasExtraAccounts();
}

function getSecret(): string {
  if (process.env.PROXY_SECRET) return process.env.PROXY_SECRET;
  // PASSWORD 不变则已签发会话继续有效；无 PASSWORD 时用 ACCOUNTS 原文派生（同样确定性）
  const base = getPassword() || process.env.ACCOUNTS || '';
  return crypto.createHash('sha256').update(base + ':libretv::session-salt').digest('hex');
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
}

/** 生成签名会话 token：`<accountId>.<expiresAtMs>.<hmac>`（账号 id 参与签名，不可篡改冒用） */
export function signSession(accountId: string = DEFAULT_ACCOUNT_ID): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${accountId}.${expiresAt}`;
  return { token: `${payload}.${hmac(payload)}`, expiresAt };
}

/** 校验会话 token 的签名与有效期，返回绑定的账号 id；无效返回 null。
 * 兼容老格式 token（`<expiresAtMs>.<hmac>`，无账号段）：视为默认账号。 */
export function verifySession(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split('.');
  let accountId: string;
  let expiresText: string;
  let signedPayload: string;
  let sig: string;
  if (parts.length === 3) {
    const [id, expires, signature] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    accountId = id;
    expiresText = expires;
    signedPayload = `${id}.${expires}`;
    sig = signature;
  } else if (parts.length === 2) {
    accountId = DEFAULT_ACCOUNT_ID;
    expiresText = parts[0];
    signedPayload = parts[0];
    sig = parts[1];
  } else {
    return null;
  }
  const expected = hmac(signedPayload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const expiresAt = parseInt(expiresText, 10);
  if (!Number.isFinite(expiresAt)) return null;
  return Date.now() < expiresAt ? accountId : null;
}

/** 从请求 Cookie 中解析会话，返回绑定的账号 id；无效返回 null */
export function sessionAccountFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';');
  for (const c of cookies) {
    const eq = c.indexOf('=');
    if (eq === -1) continue;
    const name = c.slice(0, eq).trim();
    if (name === SESSION_COOKIE) {
      return verifySession(decodeURIComponent(c.slice(eq + 1).trim()));
    }
  }
  return null;
}

/** 从请求 Cookie 中解析会话（布尔语义，供只需鉴权的接口使用） */
export function sessionFromCookieHeader(cookieHeader: string | null): boolean {
  return sessionAccountFromCookieHeader(cookieHeader) !== null;
}

// —— 登录速率限制（内存实现，单实例部署足够；多实例可换 Redis） ——

const attemptMap = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attemptMap.get(ip);
  if (!entry || now > entry.resetAt) {
    attemptMap.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

export function clearRateLimit(ip: string): void {
  attemptMap.delete(ip);
}

// 定期清理过期限流记录，避免长期运行下 Map 膨胀
if (typeof setInterval === 'function') {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attemptMap) {
      if (now > entry.resetAt) attemptMap.delete(ip);
    }
  }, 60 * 1000);
  // 不阻止 Node 进程退出
  if (typeof timer.unref === 'function') timer.unref();
}
