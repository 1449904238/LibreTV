/**
 * 首页两级分类体系（对齐 TV 端展示方案）：
 * 一级：最近最火 / 电影 / 剧集 / 综艺 / 动漫 / 短剧 / 纪录片 / 海外专区；
 * 二级：电影 → 动作/武打、喜剧……；剧集 → 国产剧、都市/家庭……；海外专区 → 欧美/日韩/其他。
 *
 * 映射规则（与 TV 端一致）：
 * - 源生类目按关键词归入节点，一个类目可归入多个节点（如"悬疑"同时服务电影·悬疑与剧集·悬疑/罪案）；
 * - 解说 / 预告 / 体育等无归属类目直接丢弃；
 * - 海外优先判定（"韩剧"含"剧"，必须先于剧集桶命中）；
 * - "短剧"优先于剧集（短剧含"剧"）；
 * - 单字"剧"兜底时跳过带"片"的名字（如"剧情片"归电影）；
 * - 国内节点展示时过滤海外条目（area + type_name 判定），海外专区不过滤。
 */

export interface TaxonomySub {
  key: string;
  label: string;
  keywords: string[];
}

export interface TaxonomyPrimary {
  key: string;
  label: string;
  /** 一级兜底关键词：命中即归入该一级（二级取 null，由调用方并入"全部X"并集） */
  bucket: string[];
  /** 该一级是否整体为海外内容 */
  overseas?: boolean;
  /** 二级列表；有二级时 subs[0] 必须为"全部X"并作为默认选中 */
  subs: TaxonomySub[];
}

export interface TaxonomyHit {
  primary: string;
  secondary: string | null;
}

/** 无归属类目：命中即丢弃（解说/预告/体育等在展示体系中没有节点） */
const EXCLUDED_KEYWORDS: string[] = [
  '解说', '预告', '花絮', '资讯', '体育', '足球', '篮球', '网球', '斯诺克',
  'NBA', '音乐', '演唱会', '戏曲',
];

export const TAXONOMY: TaxonomyPrimary[] = [
  // 最近最火是特殊节点：不参与类目映射，走最新入库接口
  { key: 'hot', label: '最近最火', bucket: [], subs: [] },
  {
    key: 'movie',
    label: '电影',
    bucket: ['电影', '影片', '剧情片'],
    subs: [
      { key: 'all', label: '全部电影', keywords: [] },
      { key: 'action', label: '动作/武打', keywords: ['动作', '武打'] },
      { key: 'comedy', label: '喜剧', keywords: ['喜剧'] },
      { key: 'romance', label: '爱情', keywords: ['爱情'] },
      { key: 'scifi', label: '科幻', keywords: ['科幻'] },
      { key: 'horror', label: '恐怖', keywords: ['恐怖', '惊悚'] },
      { key: 'suspense', label: '悬疑', keywords: ['悬疑', '推理'] },
      { key: 'crime', label: '警匪', keywords: ['警匪', '犯罪', '刑侦'] },
      { key: 'war', label: '战争/抗日', keywords: ['战争', '抗日', '军事', '军旅'] },
      { key: 'costume', label: '古装/武侠', keywords: ['古装', '武侠', '仙侠', '清宫'] },
      { key: 'history', label: '历史', keywords: ['历史'] },
    ],
  },
  {
    key: 'tv',
    label: '剧集',
    bucket: ['连续剧', '剧集', '电视剧', '情景'],
    subs: [
      { key: 'all', label: '全部剧集', keywords: [] },
      { key: 'domestic', label: '国产剧', keywords: ['国产'] },
      { key: 'urban', label: '都市/家庭', keywords: ['都市', '家庭', '时装'] },
      { key: 'costume', label: '古装/历史', keywords: ['古装', '历史', '清宫', '宫廷'] },
      { key: 'suspense', label: '悬疑/罪案', keywords: ['悬疑', '罪案', '刑侦', '推理'] },
      { key: 'spy', label: '谍战', keywords: ['谍战', '特工'] },
      { key: 'war', label: '抗日/战争', keywords: ['抗日', '战争', '军旅'] },
      { key: 'wuxia', label: '武侠/江湖', keywords: ['武侠', '仙侠', '江湖'] },
    ],
  },
  { key: 'variety', label: '综艺', bucket: ['综艺', '真人秀', '选秀', '脱口秀', '晚会'], subs: [] },
  { key: 'anime', label: '动漫', bucket: ['动漫', '动画', '卡通', '番剧'], subs: [] },
  { key: 'short', label: '短剧', bucket: ['短剧'], subs: [] },
  { key: 'doc', label: '纪录片', bucket: ['纪录', '纪实'], subs: [] },
  {
    key: 'overseas',
    label: '海外专区',
    overseas: true,
    bucket: [
      '韩国', '欧美', '日本', '海外', '泰国', '日韩', '美剧', '韩剧', '日剧',
      '美国', '英国', '法国', '德国', '泰剧', '英剧', '欧洲',
    ],
    subs: [
      { key: 'all', label: '全部海外', keywords: [] },
      { key: 'western', label: '欧美影视', keywords: ['欧美', '美剧', '美国', '英国', '法国', '德国', '欧洲', '英剧'] },
      { key: 'jpk', label: '日韩影视', keywords: ['日本', '日剧', '韩国', '韩剧', '日韩'] },
      { key: 'other', label: '其他海外', keywords: [] },
    ],
  },
];

function primaryOf(key: string): TaxonomyPrimary {
  const found = TAXONOMY.find((p) => p.key === key);
  if (!found) throw new Error(`未知的一级分类: ${key}`);
  return found;
}

/**
 * 源生类目名 → 两级分类命中列表（可多命中；无命中返回空数组，调用方丢弃该类目）。
 * 'all' 命中由一级兜底产生；'other' 仅海外专区无二级命中时产生。
 */
export function matchSourceCategory(name: string): TaxonomyHit[] {
  const raw = (name || '').trim();
  if (!raw) return [];
  if (EXCLUDED_KEYWORDS.some((k) => raw.includes(k))) return [];
  const hits: TaxonomyHit[] = [];
  const push = (primary: string, secondary: string | null) => {
    if (!hits.some((h) => h.primary === primary && h.secondary === secondary)) {
      hits.push({ primary, secondary });
    }
  };

  // 海外优先："韩剧"含"剧"，必须先于剧集桶落定；命中海外则统一归入海外专区，不再进国内节点
  const overseas = primaryOf('overseas');
  const isOverseas = overseas.bucket.some((k) => raw.includes(k));
  if (isOverseas) {
    const sub = overseas.subs.find(
      (s) => s.key !== 'all' && s.key !== 'other' && s.keywords.some((k) => raw.includes(k))
    );
    push('overseas', sub ? sub.key : 'other');
    return hits;
  }
  // 短剧优先于剧集（短剧含"剧"，但独立成类）
  const isShort = primaryOf('short').bucket.some((k) => raw.includes(k));
  if (isShort) {
    push('short', null);
    return hits;
  }
  // 动漫与电影双归属（"动漫电影"两边都收），但动漫一旦命中则不再进剧集
  const isAnime = primaryOf('anime').bucket.some((k) => raw.includes(k));
  if (isAnime) push('anime', null);
  // 电影：二级 + 兜底
  const movie = primaryOf('movie');
  for (const sub of movie.subs) {
    if (sub.key !== 'all' && sub.keywords.some((k) => raw.includes(k))) push('movie', sub.key);
  }
  if (movie.bucket.some((k) => raw.includes(k))) push('movie', 'all');
  // 剧集：二级 + 兜底（显式桶 + 不带"片"的单字"剧"；"剧情片"已由电影兜底收走）
  if (!isAnime) {
    const tv = primaryOf('tv');
    for (const sub of tv.subs) {
      if (sub.key !== 'all' && sub.keywords.some((k) => raw.includes(k))) push('tv', sub.key);
    }
    if (tv.bucket.some((k) => raw.includes(k)) || (raw.includes('剧') && !raw.includes('片'))) {
      push('tv', 'all');
    }
  }
  // 综艺 / 纪录片：单节点
  if (primaryOf('variety').bucket.some((k) => raw.includes(k))) push('variety', null);
  if (primaryOf('doc').bucket.some((k) => raw.includes(k))) push('doc', null);
  return hits;
}

/** 海外内容判定（地区 + 类型名，与 TV 端关键词表一致） */
const FOREIGN_ITEM_KEYWORDS: string[] = [
  '美国', '欧美', '英国', '法国', '德国', '意大利', '西班牙', '加拿大', '澳大利亚',
  '俄罗斯', '日本', '韩国', '泰国', '印度', '海外', '日韩', '欧美剧', '韩剧', '美剧', '日剧',
];

export function isForeignItem(item: { area?: string; typeName?: string }): boolean {
  const text = `${item.area || ''} ${item.typeName || ''}`.toLowerCase();
  return FOREIGN_ITEM_KEYWORDS.some((k) => text.includes(k.toLowerCase()));
}

/** 国内节点内容过滤：剔除海外条目（字段缺失无法判定时保留，避免误杀） */
export function filterDomesticItems<T extends { area?: string; typeName?: string }>(items: T[]): T[] {
  return items.filter((item) => !isForeignItem(item));
}

