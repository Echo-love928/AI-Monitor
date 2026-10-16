import type { Evidence, Signal } from './types.js';
import { qualifiedTwitter, TWITTER_FILTER_VERSION } from './twitter.js';
import { nonTwitterDiscovery } from './discovery.js';

export const FRESHNESS_DAYS = 5;
export const FRESHNESS_HOURS = FRESHNESS_DAYS * 24;
export const FRESHNESS_MS = FRESHNESS_HOURS * 3600000;

export function timestamp(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 300000 ? time : null;
}
export function withinWindow(value: string | null | undefined, now = Date.now()): boolean {
  const time = timestamp(value, now);
  return time !== null && time >= now - FRESHNESS_MS;
}
export function signalTime(signal: Signal, now = Date.now()): number | null {
  // An explicit event date always wins: a new post must not refresh an old event.
  if (signal.occurredAt) return timestamp(signal.occurredAt, now);
  const dates = signal.evidence.filter(item => qualifiedTwitter(item) || nonTwitterDiscovery(item,now)).map(item => timestamp(item.publishedAt, now)).filter((time): time is number => time !== null);
  return dates.length ? Math.min(...dates) : null;
}
export function currentSignal(signal: Signal, now = Date.now()): boolean {
  const time = signalTime(signal, now);
  const other=signal.evidence.some(item=>nonTwitterDiscovery(item,now));
  const discovery=other || signal.twitterFilterVersion === TWITTER_FILTER_VERSION && signal.evidence.some(qualifiedTwitter);
  return discovery && !signal.auditOnly && signal.status !== 'rejected' && signal.isNewsworthy !== false && signal.isNewEvent !== false && time !== null && time >= now - FRESHNESS_MS;
}
export function defaultSignal(signal: Signal, now = Date.now()): boolean {
  return currentSignal(signal, now) && (signal.status === 'confirmed' || signal.status === 'pending');
}
export function expiredEvidence(item: Evidence, now = Date.now()): boolean {
  const time = timestamp(item.publishedAt, now);
  return time !== null && time < now - FRESHNESS_MS;
}
