/**
 * 平台注册表。
 * 新增一个平台通常只需要：
 *   1) 在 PLATFORMS 里加一条域名规则
 *   2) 如有专用接口，再写一个 extractor 并注册到 index.js
 * 没有专用 extractor 的平台会走通用抓取器（OG / JSON-LD / <video> / HLS）。
 */

export const PLATFORMS = [
  {
    id: 'douyin',
    name: '抖音',
    domains: ['douyin.com', 'iesdouyin.com', 'douyinpic.com', 'douyinvod.com'],
    shortDomains: ['v.douyin.com'],
    color: '#FE2C55',
    referer: 'https://www.douyin.com/',
    ua: 'android',
  },
  {
    id: 'kuaishou',
    name: '快手',
    domains: ['kuaishou.com', 'gifshow.com', 'chenzhongtech.com', 'kwimgs.com'],
    shortDomains: ['v.kuaishou.com'],
    color: '#FF5000',
    referer: 'https://www.kuaishou.com/',
    ua: 'android',
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    domains: ['bilibili.com', 'bilivideo.com', 'biliapi.net'],
    shortDomains: ['b23.tv', 'bili2233.cn', 'acg.tv'],
    color: '#00A1D6',
    referer: 'https://www.bilibili.com/',
    ua: 'desktop',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    domains: ['youtube.com', 'googlevideo.com', 'ytimg.com'],
    shortDomains: ['youtu.be'],
    color: '#FF0033',
    referer: 'https://www.youtube.com/',
    ua: 'desktop',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    domains: ['tiktok.com', 'tiktokcdn.com', 'tiktokv.com'],
    shortDomains: ['vt.tiktok.com', 'vm.tiktok.com'],
    color: '#00F2EA',
    referer: 'https://www.tiktok.com/',
    ua: 'desktop',
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    domains: ['xiaohongshu.com', 'xhscdn.com'],
    shortDomains: ['xhslink.com'],
    color: '#FF2442',
    referer: 'https://www.xiaohongshu.com/',
    ua: 'desktop',
  },
  {
    id: 'weibo',
    name: '微博',
    domains: ['weibo.com', 'weibo.cn', 'sinaimg.cn', 'sina.com.cn'],
    shortDomains: ['t.cn'],
    color: '#E6162D',
    referer: 'https://weibo.com/',
    ua: 'mobile',
  },
  {
    id: 'xigua',
    name: '西瓜视频',
    domains: ['ixigua.com', 'toutiao.com', 'zjcdn.com', 'ixiguavideo.com'],
    color: '#F4622A',
    referer: 'https://www.ixigua.com/',
    ua: 'desktop',
  },
  {
    id: 'haokan',
    name: '好看视频',
    domains: ['haokan.baidu.com', 'baidu.com'],
    color: '#2932E1',
    referer: 'https://haokan.baidu.com/',
    ua: 'desktop',
  },
  {
    id: 'qqvideo',
    name: '腾讯视频',
    domains: ['v.qq.com', 'qq.com'],
    color: '#FF6A00',
    referer: 'https://v.qq.com/',
    ua: 'desktop',
  },
  {
    id: 'youku',
    name: '优酷',
    domains: ['youku.com', 'ykimg.com'],
    color: '#1EB8FF',
    referer: 'https://www.youku.com/',
    ua: 'desktop',
  },
  {
    id: 'iqiyi',
    name: '爱奇艺',
    domains: ['iqiyi.com', 'qiyi.com', 'iqiyipic.com'],
    color: '#00BE06',
    referer: 'https://www.iqiyi.com/',
    ua: 'desktop',
  },
  {
    id: 'mgtv',
    name: '芒果TV',
    domains: ['mgtv.com', 'hunantv.com'],
    color: '#FF7E00',
    referer: 'https://www.mgtv.com/',
    ua: 'desktop',
  },
  {
    id: 'sohu',
    name: '搜狐视频',
    domains: ['sohu.com', 'itc.cn'],
    color: '#FF7F00',
    referer: 'https://tv.sohu.com/',
    ua: 'desktop',
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    domains: ['vimeo.com', 'vimeocdn.com'],
    color: '#1AB7EA',
    referer: 'https://vimeo.com/',
    ua: 'desktop',
  },
  {
    id: 'twitter',
    name: 'X / Twitter',
    domains: ['twitter.com', 'x.com', 'twimg.com'],
    color: '#1D9BF0',
    referer: 'https://x.com/',
    ua: 'desktop',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    domains: ['instagram.com', 'cdninstagram.com'],
    color: '#E1306C',
    referer: 'https://www.instagram.com/',
    ua: 'desktop',
  },
];

export const GENERIC_PLATFORM = {
  id: 'generic',
  name: '通用网页',
  domains: [],
  shortDomains: [],
  color: '#7C8CF8',
  referer: '',
  ua: 'desktop',
};

/** 去掉 www. / m. / v. 之类的前缀，便于域名匹配 */
function normalizeHost(host) {
  return host.toLowerCase().replace(/\.$/, '');
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function findPlatformByHost(host) {
  const h = normalizeHost(host);
  for (const platform of PLATFORMS) {
    // 短链域名（youtu.be / b23.tv / v.douyin.com…）也算这个平台，
    // 否则 user 看到短链会落到「通用网页」，提示和专用解析都不会生效
    const all = [...platform.domains, ...(platform.shortDomains ?? [])];
    if (all.some((d) => hostMatches(h, d))) return platform;
  }
  return null;
}

export function getPlatform(id) {
  return PLATFORMS.find((p) => p.id === id) ?? GENERIC_PLATFORM;
}

export function isShortUrl(url) {
  try {
    const host = normalizeHost(new URL(url).hostname);
    return PLATFORMS.some((p) => (p.shortDomains ?? []).some((d) => hostMatches(host, d)));
  } catch {
    return false;
  }
}
