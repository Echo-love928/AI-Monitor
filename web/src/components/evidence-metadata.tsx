import { useState } from 'react';
import { Bookmark, Coins, Eye, Heart, MessageCircle, Radio, Repeat2, Star, TrendingUp, UserRound, UsersRound } from 'lucide-react';
import type { Evidence } from '../../../shared/types.js';
import { count, formatCount, mediaUrl, metricRows } from '../../../shared/engagement.js';

const metricIcons = { likes: Heart, reposts: Repeat2, replies: MessageCircle, views: Eye, bookmarks: Bookmark, favorites: Star, coins: Coins, danmaku: Radio, points: TrendingUp };

export function AuthorInfo({ item, linked = false }: { item: Evidence; linked?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const avatar = mediaUrl(item.authorAvatarUrl);
  const name = item.authorName || item.author || '作者未提供';
  const followers = count(item.authorFollowers);
  const url = mediaUrl(item.authorUrl);
  const content = <><strong>{name}</strong>{item.authorName && item.author && item.author !== item.authorName && item.author.startsWith('@') && <small>{item.author}</small>}</>;
  return <div className="evidence-author">
    <span className="author-avatar" aria-hidden="true">{avatar && failedUrl !== avatar ? <img src={avatar} width={32} height={32} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(avatar)}/> : <UserRound size={17}/>}</span>
    <span className="author-name">{linked && url ? <a href={url} target="_blank" rel="noopener noreferrer">{content}</a> : content}</span>
    <span className="author-followers" title={followers === undefined ? '来源未提供粉丝数' : `粉丝 ${followers.toLocaleString('zh-CN')}`}><UsersRound size={13} aria-hidden="true"/>{followers === undefined ? '粉丝数未提供' : `${formatCount(followers)} 粉丝`}</span>
  </div>;
}

export function InteractionMetrics({ item }: { item: Evidence }) {
  const rows = metricRows(item);
  const hasData = rows.some(row => row.value !== undefined);
  return <div className="interaction-block">
    <div className="interaction-metrics" aria-label="原帖互动数据">{rows.map(({ key, label, value }) => {
      const Icon = metricIcons[key];
      const description = value === undefined ? `${label}：来源未提供` : `${label} ${value.toLocaleString('zh-CN')}`;
      return <span key={key} className={`interaction-metric${value === undefined ? ' unavailable' : ''}`} title={description} aria-label={description}><Icon size={14} aria-hidden="true"/><span>{label}</span><b>{formatCount(value)}</b></span>;
    })}</div>
    {!hasData && <span className="interaction-note">{item.metricsUnavailable ? '本次回查无法读取互动数据' : '来源未提供互动数据'}</span>}
  </div>;
}
