import { NextResponse } from 'next/server';
import { isPasswordConfigured, sessionAccountFromCookieHeader } from '@/lib/auth';
import { DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_NAME, getAccountById, hasExtraAccounts } from '@/lib/accounts';
import type { LiveSourceConfig, SourceConfig } from '@/lib/types';
import { getEnvSources } from '@/lib/env-sources';
import { getEnvLiveSources } from '@/lib/env-live-sources';
import { getEnvSubscriptions } from '@/lib/env-subscriptions';
import { getEnvRecommendSource } from '@/lib/env-recommend-source';
import { getEnvImageMode } from '@/lib/env-image-mode';

export const runtime = 'nodejs';

/** 会话账号的公开信息（id 仅用于 key 命名空间，name 用于前端展示当前线路） */
function accountInfoOf(accountId: string): { id: string; name: string } | null {
  if (!hasExtraAccounts()) {
    return accountId === DEFAULT_ACCOUNT_ID
      ? { id: DEFAULT_ACCOUNT_ID, name: process.env.PASSWORD_NAME || DEFAULT_ACCOUNT_NAME }
      : null;
  }
  const acc = getAccountById(accountId);
  return acc ? { id: acc.id, name: acc.name } : null;
}

/** 按账号解析应下发的预置源：
 * - 单密码模式：沿用全局 DEFAULT_*（与改动前一致，未登录也下发）；
 * - 多账号模式：默认账号取全局 DEFAULT_*（单独配置），其余账号取各自配置（没配返回空）；
 *   未登录或账号已失效时返回空，需登录后获取。
 */
function sourcesFor(accountId: string | null): {
  defaultSources: SourceConfig[];
  defaultLiveSources: LiveSourceConfig[];
} {
  if (!hasExtraAccounts()) {
    return { defaultSources: getEnvSources(), defaultLiveSources: getEnvLiveSources() };
  }
  if (!accountId) return { defaultSources: [], defaultLiveSources: [] };
  const acc = getAccountById(accountId);
  if (!acc) return { defaultSources: [], defaultLiveSources: [] };
  if (acc.id === DEFAULT_ACCOUNT_ID) {
    return { defaultSources: getEnvSources(), defaultLiveSources: getEnvLiveSources() };
  }
  const short = acc.id.replace(/^acc_/, '');
  return {
    defaultSources: acc.sources.map((s, i) => ({ ...s, key: `env_${short}_${i}` })),
    defaultLiveSources: acc.liveSources.map((s, i) => ({ ...s, key: `envlive_${short}_${i}` })),
  };
}

/** 站点状态：客户端据此决定是否弹出登录框 / 提示管理员配置密码，并获取预置采集站与预置直播源。
 * 多账号模式（ACCOUNTS）下按会话账号下发各自的源：未登录返回空，需登录后获取；
 * 单密码模式保持原行为（未登录也下发全局预置）。 */
export async function GET(req: Request) {
  const passwordRequired = isPasswordConfigured();
  const accountId = passwordRequired
    ? sessionAccountFromCookieHeader(req.headers.get('cookie'))
    : null;
  const verified = accountId !== null;
  // 当前会话的账号（多账号模式下决定下发哪份源；单密码模式登录后为默认账号）
  const account = accountId ? accountInfoOf(accountId) : null;
  const { defaultSources, defaultLiveSources } = sourcesFor(account?.id ?? null);
  return NextResponse.json({
    passwordRequired,
    verified,
    // 登录会话绑定的账号（未登录为 null；单密码模式登录后为默认账号）
    account,
    // 构建时由 next.config.ts 从 package.json 注入
    version: process.env.APP_VERSION || 'dev',
    // 部署者预置的采集站（多账号模式下为当前账号的源）
    defaultSources,
    // 部署者预置的直播源（多账号模式下为当前账号的源）
    defaultLiveSources,
    // 部署者通过 DEFAULT_SUBSCRIPTIONS 预置的 SourceList 订阅链接
    defaultSubscriptions: getEnvSubscriptions(),
    // 部署者通过 DEFAULT_RECOMMEND_SOURCE 指定的首页推荐数据源默认值（未配置时为 null）
    defaultRecommendSource: getEnvRecommendSource() ?? null,
    // 部署者通过 DEFAULT_IMAGE_MODE 指定的封面图加载方式默认值（未配置时为 null）
    defaultImageMode: getEnvImageMode() ?? null,
  });
}
