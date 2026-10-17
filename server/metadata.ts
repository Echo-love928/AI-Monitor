import type { Evidence } from '../shared/types.js';
import { count, mediaUrl, normalizeMetadata } from '../shared/engagement.js';

type RecordData = Record<string, unknown>;
const record = (value: unknown): RecordData => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const id = (value: unknown): string | undefined => text(value) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined);

// Adapt only fields actually returned by the current endpoint. No extra profile
// requests, scraped guesses or cross-post sums are needed for missing data.
export function sourceMetadata(platform: 'x' | 'bilibili' | 'weibo' | 'hackernews', value: unknown): Partial<Evidence> {
  const data = record(value);
  let fields: Partial<Evidence>;
  if (platform === 'x') {
    const user = record(data.author);
    fields = { likes: count(data.likeCount), reposts: count(data.retweetCount), replies: count(data.replyCount), views: count(data.viewCount), bookmarks: count(data.bookmarkCount), authorName: text(user.name), authorAvatarUrl: mediaUrl(user.profilePicture), authorUrl: text(user.userName) ? `https://x.com/${encodeURIComponent(text(user.userName)!)}` : undefined, authorFollowers: count(user.followers) };
  } else if (platform === 'bilibili') {
    const stat = record(data.stat); const user = record(data.owner); const authorId = id(user.mid ?? data.mid);
    fields = { likes: count(stat.like ?? data.like), reposts: count(stat.share ?? data.share), replies: count(stat.reply ?? data.reply), views: count(stat.view ?? data.play), favorites: count(stat.favorite ?? data.favorites), coins: count(stat.coin ?? data.coin), danmaku: count(stat.danmaku ?? data.danmaku ?? data.video_review), authorName: text(user.name ?? data.author), authorAvatarUrl: mediaUrl(user.face ?? data.upic), authorId, authorUrl: authorId ? `https://space.bilibili.com/${encodeURIComponent(authorId)}` : undefined, authorFollowers: count(user.follower ?? data.follower) };
  } else if (platform === 'weibo') {
    const user = record(data.user); const authorId = id(user.idstr ?? user.id);
    fields = { likes: count(data.attitudes_count), reposts: count(data.reposts_count), replies: count(data.comments_count), views: count(data.reads_count), authorName: text(user.screen_name), authorAvatarUrl: mediaUrl(user.avatar_hd ?? user.avatar_large ?? user.profile_image_url), authorFollowers: count(user.followers_count), authorId, authorUrl: authorId ? `https://weibo.com/u/${encodeURIComponent(authorId)}` : undefined };
  } else {
    const name = text(data.by);
    fields = { points: count(data.score ?? data['hn:score']), replies: count(data.descendants ?? data['hn:comments']), authorName: name, authorUrl: name ? `https://news.ycombinator.com/user?id=${encodeURIComponent(name)}` : undefined };
  }
  return normalizeMetadata(fields);
}
