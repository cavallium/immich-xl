/**
 * For You Engine — TikTok-like personalized content recommendation algorithm.
 *
 * Core principles:
 *  1. **Implicit signals only** — the user never explicitly tells us what they like.
 *     We infer preference from relative watch-time: spending more time than
 *     average on an asset is a positive signal, less time is negative.
 *     There is no absolute "skip" threshold.
 *  2. **Content-based (CLIP)** — we query Immich's smart-search with `queryAssetId`
 *     to find visually/semantically similar assets.  Assets the user engaged with
 *     longer become stronger "query anchors".
 *  3. **Person-based** — faces detected in liked content provide a minor
 *     secondary signal, but visual content/preference drive recommendations.
 *  4. **Exploration vs Exploitation** — a configurable discovery rate injects
 *     random content so the feed doesn't collapse into a filter bubble.
 *  5. **Persistent state** — all engagement data is stored in localStorage so the
 *     algorithm remembers across sessions.
 *  6. **Time decay** — older engagement signals fade so the algorithm adapts to
 *     changing taste.
 *  7. **Session momentum** — a short-term session window tracks recent interest
 *     bursts so the feed pivots quickly within a browsing session.
 *  8. **Multi-anchor blending** — multiple positive anchors are queried and their
 *     results merged/ranked, rather than relying on a single anchor per request.
 *  9. **Diversity guarantee** — consecutive items from the same CLIP cluster are
 *     penalised to keep the feed varied even during exploitation.
 */

import { browser } from '$app/environment';

// ─── Debug log buffer ────────────────────────────────────────────────────────

export type ForYouLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ForYouLogEntry {
  timestamp: number;
  message: string;
  level: ForYouLogLevel;
}

const MAX_LOG_ENTRIES = 200;
const debugLog: ForYouLogEntry[] = [];

function fyLog(msg: string, level: ForYouLogLevel = 'debug'): void {
  debugLog.push({ timestamp: Date.now(), message: msg, level });
  if (debugLog.length > MAX_LOG_ENTRIES) {
    debugLog.splice(0, debugLog.length - MAX_LOG_ENTRIES);
  }
}

export function getForYouDebugLog(): ForYouLogEntry[] {
  return debugLog;
}

export function clearForYouDebugLog(): void {
  debugLog.length = 0;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Media type for per-type watch time normalisation. */
export type ForYouMediaType = 'photo' | 'gif' | 'video';

/** A single engagement record for an asset. */
export interface AssetEngagement {
  /** Total accumulated watch time in ms across all views. */
  totalWatchTimeMs: number;
  /** Number of times this asset was shown. */
  viewCount: number;
  /** Timestamp (epoch ms) of the most recent view. */
  lastSeenAt: number;
  /** Computed engagement score (updated on every interaction). */
  score: number;
  /** Media type (used for type-normalised scoring). */
  mediaType?: ForYouMediaType;
}

/** A single engagement record for a person (face cluster). */
export interface PersonEngagement {
  /** Total watch time across all assets featuring this person. */
  totalWatchTimeMs: number;
  /** Number of asset views that included this person. */
  viewCount: number;
  /** Timestamp of last engagement. */
  lastSeenAt: number;
  /** Computed score. */
  score: number;
}

/** Serialisable state persisted to localStorage. */
export interface ForYouState {
  /** version tag for future migrations */
  version: number;
  assets: Record<string, AssetEngagement>;
  persons: Record<string, PersonEngagement>;
  /** Ring-buffer of recently shown asset IDs (to avoid repetition). */
  recentlyShown: string[];
  /** Running total of all watch times (ms) for computing the global average. */
  totalGlobalWatchTimeMs: number;
  /** Running total of all views for computing the global average. */
  totalGlobalViewCount: number;
  /** Running totals split by media type to avoid video/gif bias. */
  totalPhotoWatchTimeMs: number;
  totalPhotoViewCount: number;
  totalGifWatchTimeMs: number;
  totalGifViewCount: number;
  totalVideoWatchTimeMs: number;
  totalVideoViewCount: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'for-you-engine-state';
const STATE_VERSION = 8;

/** Minimum watch time (ms) to count engagement for a revisited asset. */
const MIN_REVISIT_WATCH_TIME_MS = 2000;

/** Minimum number of views before we use the relative average (cold-start). */
const MIN_VIEWS_FOR_AVERAGE = 5;
/** Fallback average watch time (ms) used during cold-start. */
const FALLBACK_AVG_WATCH_TIME_MS = 3000;
/** Maximum tracked assets (oldest by lastSeenAt are evicted). */
const MAX_TRACKED_ASSETS = 500;
/** Maximum tracked persons. */
const MAX_TRACKED_PERSONS = 200;
/** Maximum recently-shown ring buffer size (large to handle big libraries). */
const MAX_RECENTLY_SHOWN = 2000;
/** Half-life for time-decay in hours — engagement halves every N hours. */
const DECAY_HALF_LIFE_HOURS = 24;
/** How many top-scored assets we consider as query anchors for CLIP search. */
const TOP_ANCHOR_POOL = 30;
/** How many top-negatively-scored assets we consider as negative CLIP anchors. */
const TOP_NEGATIVE_ANCHOR_POOL = 5;

// ── Adaptive discovery constants ──────────────────────────────────────────
/** Base discovery rate multiplier during cold-start (few views). */
const COLD_START_DISCOVERY_MULTIPLIER = 4.0;
/** Number of views after which cold-start boost fully fades. */
const COLD_START_FADE_VIEWS = 40;
/** Minimum effective discovery rate (fraction, not percent). */
const MIN_DISCOVERY_RATE = 0.10;
/**
 * Score per second of watch time relative to the average.
 * Positive when above average, negative when below.
 */
const RELATIVE_TIME_SCORE_PER_SEC = 1.0;

// ── Session momentum constants ────────────────────────────────────────────
/** How many recent interactions form the "session window". */
const SESSION_WINDOW_SIZE = 15;
/** Weight multiplier for session-momentum scores vs long-term scores. */
const SESSION_MOMENTUM_WEIGHT = 4.0;

// ── Multi-anchor constants ────────────────────────────────────────────────
/** Number of distinct CLIP anchors to query per recommendation request. */
const MULTI_ANCHOR_COUNT = 5;

// ── Diversity constants ───────────────────────────────────────────────────
/** How many recent anchor IDs to track for diversity (avoid same cluster). */
const DIVERSITY_ANCHOR_HISTORY = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decayFactor(lastSeenAt: number, now: number): number {
  const hoursAgo = (now - lastSeenAt) / (1000 * 60 * 60);
  return Math.pow(0.5, hoursAgo / DECAY_HALF_LIFE_HOURS);
}

/** Weighted random pick: returns the index chosen proportional to weights. */
function weightedRandomIndex(weights: number[]): number {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return Math.floor(Math.random() * weights.length);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

class ForYouEngine {
  private state: ForYouState;

  /**
   * In-memory session ring buffer: stores the last N (assetId, watchTimeMs)
   * pairs from the current browsing session. Not persisted — resets on reload.
   */
  private sessionRing: Array<{ assetId: string; watchTimeMs: number }> = [];

  /**
   * In-memory list of recently used CLIP anchor IDs (for diversity).
   * Not persisted.
   */
  private recentAnchorIds: string[] = [];

  constructor() {
    this.state = this.load();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load(): ForYouState {
    if (!browser) return this.emptyState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: ForYouState = JSON.parse(raw);
        if (parsed.version === STATE_VERSION) return parsed;
      }
    } catch (error) {
      console.warn('ForYouEngine: failed to load state from localStorage, starting fresh', error);
    }
    return this.emptyState();
  }

  private save(): void {
    if (!browser) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (error) {
      console.warn('ForYouEngine: localStorage save failed, evicting and retrying', error);
      this.evict();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch (retryError) {
        console.error('ForYouEngine: localStorage save failed after eviction', retryError);
      }
    }
  }

  private emptyState(): ForYouState {
    return {
      version: STATE_VERSION, assets: {}, persons: {}, recentlyShown: [],
      totalGlobalWatchTimeMs: 0, totalGlobalViewCount: 0,
      totalPhotoWatchTimeMs: 0, totalPhotoViewCount: 0,
      totalGifWatchTimeMs: 0, totalGifViewCount: 0,
      totalVideoWatchTimeMs: 0, totalVideoViewCount: 0,
    };
  }

  // ── Eviction ─────────────────────────────────────────────────────────────

  private evict(): void {
    const assetEntries = Object.entries(this.state.assets);
    if (assetEntries.length > MAX_TRACKED_ASSETS) {
      assetEntries.sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      const toRemove = assetEntries.slice(0, assetEntries.length - MAX_TRACKED_ASSETS);
      for (const [id, ae] of toRemove) {
        // Subtract evicted data from running totals to prevent average drift.
        // Clamp to 0 to guard against negative totals from mediaType changes.
        this.state.totalGlobalWatchTimeMs = Math.max(0, this.state.totalGlobalWatchTimeMs - ae.totalWatchTimeMs);
        this.state.totalGlobalViewCount = Math.max(0, this.state.totalGlobalViewCount - ae.viewCount);
        const mt = ae.mediaType ?? 'photo';
        if (mt === 'video') {
          this.state.totalVideoWatchTimeMs = Math.max(0, this.state.totalVideoWatchTimeMs - ae.totalWatchTimeMs);
          this.state.totalVideoViewCount = Math.max(0, this.state.totalVideoViewCount - ae.viewCount);
        } else if (mt === 'gif') {
          this.state.totalGifWatchTimeMs = Math.max(0, this.state.totalGifWatchTimeMs - ae.totalWatchTimeMs);
          this.state.totalGifViewCount = Math.max(0, this.state.totalGifViewCount - ae.viewCount);
        } else {
          this.state.totalPhotoWatchTimeMs = Math.max(0, this.state.totalPhotoWatchTimeMs - ae.totalWatchTimeMs);
          this.state.totalPhotoViewCount = Math.max(0, this.state.totalPhotoViewCount - ae.viewCount);
        }
        delete this.state.assets[id];
      }
    }
    const personEntries = Object.entries(this.state.persons);
    if (personEntries.length > MAX_TRACKED_PERSONS) {
      personEntries.sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      const toRemove = personEntries.slice(0, personEntries.length - MAX_TRACKED_PERSONS);
      for (const [id] of toRemove) delete this.state.persons[id];
    }
    if (this.state.recentlyShown.length > MAX_RECENTLY_SHOWN) {
      this.state.recentlyShown = this.state.recentlyShown.slice(0, MAX_RECENTLY_SHOWN);
    }
  }

  // ── Score computation ────────────────────────────────────────────────────

  /**
   * Compute the global average watch time per view.
   * During cold-start (< MIN_VIEWS_FOR_AVERAGE views) we use a fallback.
   */
  private getAverageWatchTimeMs(): number {
    if (this.state.totalGlobalViewCount < MIN_VIEWS_FOR_AVERAGE) {
      return FALLBACK_AVG_WATCH_TIME_MS;
    }
    return this.state.totalGlobalWatchTimeMs / this.state.totalGlobalViewCount;
  }

  /**
   * Compute the average watch time for a specific media type.
   * Falls back to the global average if not enough type-specific data exists.
   * This prevents videos/gifs from always scoring higher than photos due to
   * their inherently longer watch times.
   */
  private getTypeAverageWatchTimeMs(mediaType: ForYouMediaType): number {
    const typeWatchMs = mediaType === 'video' ? this.state.totalVideoWatchTimeMs
      : mediaType === 'gif' ? this.state.totalGifWatchTimeMs
      : this.state.totalPhotoWatchTimeMs;
    const typeViews = mediaType === 'video' ? this.state.totalVideoViewCount
      : mediaType === 'gif' ? this.state.totalGifViewCount
      : this.state.totalPhotoViewCount;
    if (typeViews < MIN_VIEWS_FOR_AVERAGE) {
      return this.getAverageWatchTimeMs();
    }
    return typeWatchMs / typeViews;
  }

  /**
   * Long-term score: how much time the user spent on this asset relative to
   * their average, summed across all views, with time decay.
   *
   * Positive → user spent MORE time than average (interest).
   * Negative → user spent LESS time than average (disinterest).
   *
   * During cold-start (few views) scores are dampened to avoid hallucinating
   * preferences from noisy skip-rate variance.
   */
  private computeAssetScore(e: AssetEngagement, now: number): number {
    const decay = decayFactor(e.lastSeenAt, now);
    // Use type-specific average so videos are compared against other videos
    // and photos against other photos — prevents video watch-time inflation.
    const avgMs = this.getTypeAverageWatchTimeMs(e.mediaType ?? 'photo');
    const relativeSec = (e.totalWatchTimeMs - avgMs * e.viewCount) / 1000;
    const raw = relativeSec * RELATIVE_TIME_SCORE_PER_SEC;
    // Dampen scores during cold-start: ramp from 0.1 to 1.0 over MIN_VIEWS_FOR_AVERAGE views
    const views = this.state.totalGlobalViewCount;
    const coldDampen = views < MIN_VIEWS_FOR_AVERAGE
      ? 0.1 + 0.9 * (views / MIN_VIEWS_FOR_AVERAGE)
      : 1.0;
    return raw * decay * coldDampen;
  }

  private computePersonScore(e: PersonEngagement, now: number): number {
    const decay = decayFactor(e.lastSeenAt, now);
    const avgMs = this.getAverageWatchTimeMs();
    const relativeSec = (e.totalWatchTimeMs - avgMs * e.viewCount) / 1000;
    const raw = relativeSec * RELATIVE_TIME_SCORE_PER_SEC;
    // Dampen scores during cold-start (same as asset scores)
    const views = this.state.totalGlobalViewCount;
    const coldDampen = views < MIN_VIEWS_FOR_AVERAGE
      ? 0.1 + 0.9 * (views / MIN_VIEWS_FOR_AVERAGE)
      : 1.0;
    return raw * decay * coldDampen;
  }

  // ── Session momentum ────────────────────────────────────────────────────

  /**
   * Compute a short-term "momentum" score for an asset based on the last
   * SESSION_WINDOW_SIZE interactions. This lets the algorithm pivot quickly
   * when the user suddenly starts engaging with a new topic.
   *
   * Returns a map of assetId → momentum score (only for assets in the window).
   */
  private getSessionMomentumScores(): Map<string, number> {
    const scores = new Map<string, number>();
    if (this.sessionRing.length === 0) return scores;

    const avgMs = this.getAverageWatchTimeMs();
    // More recent items in the ring get higher weight (recency within session)
    for (let i = 0; i < this.sessionRing.length; i++) {
      const { assetId, watchTimeMs } = this.sessionRing[i];
      // i=0 is oldest in ring, i=length-1 is newest
      const recencyWeight = (i + 1) / this.sessionRing.length;
      const relativeSec = (watchTimeMs - avgMs) / 1000;
      const momentumDelta = relativeSec * RELATIVE_TIME_SCORE_PER_SEC * recencyWeight;
      scores.set(assetId, (scores.get(assetId) ?? 0) + momentumDelta);
    }
    return scores;
  }

  /**
   * Combined score = long-term score + SESSION_MOMENTUM_WEIGHT × session score.
   * This is used for anchor selection so that recent session interests are
   * amplified without losing long-term preferences.
   *
   * When called in a loop (e.g. pickQueryAnchorAssetIds), pass a pre-computed
   * momentum map to avoid recomputing it on every call.
   */
  private getCombinedAssetScore(assetId: string, longTermScore: number, momentum?: Map<string, number>): number {
    const m = momentum ?? this.getSessionMomentumScores();
    const sessionScore = m.get(assetId) ?? 0;
    return longTermScore + SESSION_MOMENTUM_WEIGHT * sessionScore;
  }

  // ── Public API: record engagement ────────────────────────────────────────

  /**
   * Record engagement. If `isRevisit` is true (user went back to this asset),
   * only count the watch time if it exceeds MIN_REVISIT_WATCH_TIME_MS — this
   * avoids polluting stats with brief navigation flashes.
   */
  recordEngagement(assetId: string, watchTimeMs: number, personIds: string[], isRevisit: boolean = false, mediaType: ForYouMediaType = 'photo'): void {
    if (isRevisit && watchTimeMs < MIN_REVISIT_WATCH_TIME_MS) {
      fyLog(
        `recordEngagement: SKIPPED revisit asset=${assetId.slice(0, 8)}… ` +
        `watchTime=${(watchTimeMs / 1000).toFixed(1)}s < ${(MIN_REVISIT_WATCH_TIME_MS / 1000).toFixed(1)}s threshold`,
      );
      return;
    }
    const now = Date.now();
    const avgMs = this.getAverageWatchTimeMs();
    const relativeSec = (watchTimeMs - avgMs) / 1000;
    fyLog(
      `recordEngagement: asset=${assetId.slice(0, 8)}… ` +
      `watchTime=${(watchTimeMs / 1000).toFixed(1)}s avg=${(avgMs / 1000).toFixed(1)}s ` +
      `relative=${relativeSec > 0 ? '+' : ''}${relativeSec.toFixed(1)}s ` +
      `persons=[${personIds.map((p) => p.slice(0, 8)).join(',')}] ` +
      `totalViews=${this.state.totalGlobalViewCount + 1} sessionSize=${this.sessionRing.length + 1}`,
    );

    // Update global running averages
    this.state.totalGlobalWatchTimeMs += watchTimeMs;
    this.state.totalGlobalViewCount += 1;

    // Update per-type running averages (to normalise video/gif/photo watch times)
    if (mediaType === 'video') {
      this.state.totalVideoWatchTimeMs += watchTimeMs;
      this.state.totalVideoViewCount += 1;
    } else if (mediaType === 'gif') {
      this.state.totalGifWatchTimeMs += watchTimeMs;
      this.state.totalGifViewCount += 1;
    } else {
      this.state.totalPhotoWatchTimeMs += watchTimeMs;
      this.state.totalPhotoViewCount += 1;
    }

    // Asset engagement
    const ae: AssetEngagement = this.state.assets[assetId] ?? {
      totalWatchTimeMs: 0, viewCount: 0, lastSeenAt: now, score: 0, mediaType,
    };
    ae.mediaType = mediaType;
    ae.totalWatchTimeMs += watchTimeMs;
    ae.viewCount += 1;
    ae.lastSeenAt = now;
    ae.score = this.computeAssetScore(ae, now);
    this.state.assets[assetId] = ae;
    fyLog(`  asset score: ${ae.score.toFixed(3)} (views=${ae.viewCount}, totalWatch=${(ae.totalWatchTimeMs / 1000).toFixed(1)}s)`);

    // Person engagement
    for (const pid of personIds) {
      const pe: PersonEngagement = this.state.persons[pid] ?? {
        totalWatchTimeMs: 0, viewCount: 0, lastSeenAt: now, score: 0,
      };
      pe.totalWatchTimeMs += watchTimeMs;
      pe.viewCount += 1;
      pe.lastSeenAt = now;
      pe.score = this.computePersonScore(pe, now);
      this.state.persons[pid] = pe;
      fyLog(`  person ${pid.slice(0, 8)}… score: ${pe.score.toFixed(3)} (views=${pe.viewCount})`);
    }

    // Session ring buffer (in-memory only)
    this.sessionRing.push({ assetId, watchTimeMs });
    if (this.sessionRing.length > SESSION_WINDOW_SIZE) {
      this.sessionRing.shift();
    }

    // Mark as recently shown
    this.addRecentlyShown(assetId);

    this.evict();
    this.save();
  }

  /**
   * Mark an asset as shown without recording watch time yet
   * (call recordEngagement later when the user navigates away).
   */
  addRecentlyShown(assetId: string): void {
    const idx = this.state.recentlyShown.indexOf(assetId);
    if (idx !== -1) this.state.recentlyShown.splice(idx, 1);
    this.state.recentlyShown.unshift(assetId);
    if (this.state.recentlyShown.length > MAX_RECENTLY_SHOWN) {
      this.state.recentlyShown.length = MAX_RECENTLY_SHOWN;
    }
  }

  // ── Public API: query recommendations ────────────────────────────────────

  /**
   * Pick multiple distinct query-anchor asset IDs for CLIP similarity search.
   * Uses weighted random selection (without replacement) from the top-scored
   * tracked assets, blending long-term and session-momentum scores.
   *
   * Returns up to `count` anchor IDs. Avoids recently-used anchors for diversity.
   * Also returns the score for each anchor so callers can allocate more search
   * slots to higher-scored anchors.
   *
   * Assets with mildly negative long-term scores but positive session momentum
   * can still become anchors — this handles the "overskip" case where the user
   * skipped something once but later engaged with similar content.
   */
  pickQueryAnchorAssetIds(count: number = MULTI_ANCHOR_COUNT): Array<{ id: string; score: number }> {
    const now = Date.now();
    // Pre-compute session momentum once to avoid O(n × sessionSize) recomputation
    const momentum = this.getSessionMomentumScores();
    const entries = Object.entries(this.state.assets).map(([id, e]) => {
      const lt = this.computeAssetScore(e, now);
      return { id, score: this.getCombinedAssetScore(id, lt, momentum) };
    });
    if (entries.length === 0) {
      fyLog('pickAnchors: no tracked assets', 'warn');
      return [];
    }

    // Take top N by combined score (positive only — session momentum can
    // rescue assets with mildly negative long-term scores)
    entries.sort((a, b) => b.score - a.score);
    const pool = entries.slice(0, TOP_ANCHOR_POOL).filter((e) => e.score > 0);
    fyLog(`pickAnchors: ${entries.length} tracked, ${pool.length} positive in top-${TOP_ANCHOR_POOL} pool, requesting ${count}`);
    if (pool.length > 0) {
      fyLog(`  top-5 pool scores: ${pool.slice(0, 5).map((e) => `${e.id.slice(0, 8)}…=${e.score.toFixed(2)}`).join(', ')}`);
    }
    if (pool.length === 0) return [];

    // Penalise recently-used anchors for diversity
    const recentSet = new Set(this.recentAnchorIds);
    const weights = pool.map((e) => recentSet.has(e.id) ? e.score * 0.2 : e.score);

    const picked: Array<{ id: string; score: number }> = [];
    for (let i = 0; i < Math.min(count, pool.length); i++) {
      const idx = weightedRandomIndex(weights);
      picked.push({ id: pool[idx].id, score: pool[idx].score });
      weights[idx] = 0; // don't pick again
    }

    fyLog(`  picked anchors: ${picked.map((a) => `${a.id.slice(0, 8)}…(score=${a.score.toFixed(2)})`).join(', ')}`);

    // Track for diversity
    for (const { id } of picked) {
      this.recentAnchorIds.push(id);
    }
    if (this.recentAnchorIds.length > DIVERSITY_ANCHOR_HISTORY) {
      this.recentAnchorIds = this.recentAnchorIds.slice(-DIVERSITY_ANCHOR_HISTORY);
    }

    return picked;
  }

  /**
   * Legacy single-anchor method — delegates to multi-anchor and returns the first.
   */
  pickQueryAnchorAssetId(): string | null {
    const anchors = this.pickQueryAnchorAssetIds(1);
    return anchors.length > 0 ? anchors[0].id : null;
  }

  /**
   * Pick negative anchor asset IDs — assets the user consistently disliked.
   * To avoid penalising content the user merely "overskipped" once, we only
   * treat an asset as a negative anchor if:
   *   - it has been viewed more than once and still has a negative score, OR
   *   - its negative score is strong enough (below -4) even from a single view.
   * A single quick skip (mildly negative score) is NOT enough to become a
   * negative anchor — the user may simply have overskipped.
   */
  pickNegativeAnchorAssetIds(): string[] {
    const now = Date.now();
    const STRONG_NEGATIVE_THRESHOLD = -4;
    const entries = Object.entries(this.state.assets).map(([id, e]) => ({
      id,
      score: this.computeAssetScore(e, now),
      viewCount: e.viewCount,
    }));
    // Only include assets with confirmed disinterest
    const negatives = entries.filter((e) =>
      e.score < 0 && (e.viewCount > 1 || e.score < STRONG_NEGATIVE_THRESHOLD),
    );
    if (negatives.length === 0) {
      fyLog('pickNegativeAnchors: none qualified', 'warn');
      return [];
    }
    negatives.sort((a, b) => a.score - b.score); // most negative first
    const picked = negatives.slice(0, TOP_NEGATIVE_ANCHOR_POOL);
    fyLog(`pickNegativeAnchors: ${negatives.length} negative, picked ${picked.length}: ${picked.map((e) => `${e.id.slice(0, 8)}…(score=${e.score.toFixed(2)}, views=${e.viewCount})`).join(', ')}`);
    return picked.map((e) => e.id);
  }

  /**
   * Pick person IDs to use as a filter for person-based recommendations.
   * Returns 1-3 person IDs weighted by engagement score, or empty array.
   */
  pickPersonIds(): string[] {
    const now = Date.now();
    const entries = Object.entries(this.state.persons).map(([id, e]) => ({
      id,
      score: this.computePersonScore(e, now),
    }));
    const pool = entries.filter((e) => e.score > 0);
    if (pool.length === 0) {
      fyLog('pickPersonIds: no positive persons', 'warn');
      return [];
    }

    pool.sort((a, b) => b.score - a.score);
    fyLog(`pickPersonIds: ${pool.length} positive persons, top-3: ${pool.slice(0, 3).map((e) => `${e.id.slice(0, 8)}…=${e.score.toFixed(2)}`).join(', ')}`);

    const count = Math.min(Math.floor(Math.random() * 3) + 1, pool.length);
    const weights = pool.map((e) => e.score);
    const picked: string[] = [];
    for (let i = 0; i < count; i++) {
      const idx = weightedRandomIndex(weights);
      picked.push(pool[idx].id);
      weights[idx] = 0;
    }
    fyLog(`  picked persons: [${picked.map((p) => p.slice(0, 8)).join(', ')}]`);
    return picked;
  }

  /** Check if an asset was recently shown. */
  isRecentlyShown(assetId: string): boolean {
    return this.state.recentlyShown.includes(assetId);
  }

  /**
   * Return a recency penalty for an asset based on how recently it was shown.
   * Assets shown very recently get a large penalty; the penalty decays as the
   * asset moves further back in the recently-shown queue.
   * Returns 0 if the asset is not in the recently-shown list.
   */
  getRecencyPenalty(assetId: string): number {
    const idx = this.state.recentlyShown.indexOf(assetId);
    if (idx === -1) return 0;
    // idx 0 = most recent → strongest penalty; decays as idx grows.
    // Penalty ranges from -20 (just shown) to ~-2 (near end of list).
    const recency = 1 - idx / this.state.recentlyShown.length; // 1.0 → 0.0
    return -(2 + 18 * recency);
  }

  /**
   * Score a candidate asset for ranking within CLIP search results.
   * Combines:
   *  - Person affinity: boost if the asset features people the user likes
   *  - Negative signal: penalise if the user previously disliked this exact asset
   *  - Freshness: slight boost for never-seen assets
   *  - Recency penalty: strong penalty for recently-shown assets (decays with distance)
   *
   * Returns a score modifier (can be negative). Higher is better.
   */
  scoreCandidateAsset(assetId: string, personIds: string[]): number {
    const now = Date.now();
    let score = 0;
    let personBoost = 0;
    let interestBoost = 0;
    let dislikePenalty = 0;
    let freshnessBonus = 0;

    // Person affinity boost (minor — content/preference matter more than faces)
    for (const pid of personIds) {
      const pe = this.state.persons[pid];
      if (pe) {
        const ps = this.computePersonScore(pe, now);
        personBoost += ps * 0.1;
      }
    }
    score += personBoost;

    // Interest boost / dislike penalty based on prior engagement with this exact asset
    const ae = this.state.assets[assetId];
    if (ae) {
      const as_ = this.computeAssetScore(ae, now);
      if (as_ < 0) {
        dislikePenalty = as_ * 2; // strong penalty for disliked content
        score += dislikePenalty;
      } else if (as_ > 0) {
        interestBoost = as_ * 0.5; // mild boost for previously liked content
        score += interestBoost;
      }
    }

    // Freshness bonus for never-seen assets
    if (!ae) {
      freshnessBonus = 1;
      score += freshnessBonus;
    }

    // Recency penalty — strongly deprioritise assets shown in the near past
    const recencyPenalty = this.getRecencyPenalty(assetId);
    score += recencyPenalty;

    if (personBoost !== 0 || dislikePenalty !== 0 || interestBoost !== 0 || recencyPenalty !== 0) {
      fyLog(
        `scoreCandidate ${assetId.slice(0, 8)}…: ` +
        `person=${personBoost.toFixed(2)} interest=${interestBoost.toFixed(2)} dislike=${dislikePenalty.toFixed(2)} fresh=${freshnessBonus} recency=${recencyPenalty.toFixed(1)} → ${score.toFixed(2)}`,
      );
    }

    return score;
  }

  /**
   * Compute an adaptive discovery rate. During cold-start the algorithm
   * explores more aggressively; as engagement data accumulates the rate
   * converges toward the user's configured value (or a minimum floor).
   *
   * @param userRate The user-configured discovery rate as a fraction (0–1).
   * @returns Effective discovery rate as a fraction (0–1).
   */
  getAdaptiveDiscoveryRate(userRate: number): number {
    const views = this.state.totalGlobalViewCount;
    // Cold-start multiplier decays linearly from COLD_START_DISCOVERY_MULTIPLIER to 1
    const coldFactor = views < COLD_START_FADE_VIEWS
      ? COLD_START_DISCOVERY_MULTIPLIER - (COLD_START_DISCOVERY_MULTIPLIER - 1) * (views / COLD_START_FADE_VIEWS)
      : 1.0;
    const rate = Math.max(MIN_DISCOVERY_RATE, Math.min(1.0, userRate * coldFactor));
    fyLog(`adaptiveDiscovery: userRate=${(userRate * 100).toFixed(1)}% coldFactor=${coldFactor.toFixed(2)} → effective=${(rate * 100).toFixed(1)}% (views=${views})`);
    return rate;
  }

  /** Whether we have enough positive engagement data to make ML-based recommendations. */
  hasEngagementData(): boolean {
    const now = Date.now();
    return Object.entries(this.state.assets).some(([, e]) => this.computeAssetScore(e, now) > 0);
  }

  /** Whether we have positive person engagement data. */
  hasPersonData(): boolean {
    const now = Date.now();
    return Object.entries(this.state.persons).some(([, e]) => this.computePersonScore(e, now) > 0);
  }

  /** Get all tracked asset IDs (for filtering out already-seen). */
  getTrackedAssetIds(): Set<string> {
    return new Set(Object.keys(this.state.assets));
  }

  /**
   * Get the number of views recorded so far (for cold-start detection).
   */
  getViewCount(): number {
    return this.state.totalGlobalViewCount;
  }

  /**
   * Get the current session ring size (how many items viewed this session).
   */
  getSessionSize(): number {
    return this.sessionRing.length;
  }

  /**
   * Detect a sudden interest shift within the current session.
   * Returns true if the most recent SESSION_WINDOW_SIZE/3 interactions
   * have significantly higher engagement than the older ones in the window,
   * indicating the user just discovered something they like.
   */
  hasInterestBurst(): boolean {
    if (this.sessionRing.length < 6) return false;
    const recentCount = Math.max(2, Math.floor(this.sessionRing.length / 3));
    const recent = this.sessionRing.slice(-recentCount);
    const older = this.sessionRing.slice(0, -recentCount);
    // Normalise watch times relative to the global average so that videos
    // don't artificially inflate the burst ratio.
    const avgMs = this.getAverageWatchTimeMs();
    const normalise = (ms: number) => avgMs > 0 ? ms / avgMs : ms;
    const avgRecent = recent.reduce((s, r) => s + normalise(r.watchTimeMs), 0) / recent.length;
    const avgOlder = older.reduce((s, r) => s + normalise(r.watchTimeMs), 0) / older.length;
    // A burst is detected when recent normalised watch time is >1.8× the older average
    const ratio = avgOlder > 0 ? avgRecent / avgOlder : 0;
    const burst = avgOlder > 0 && ratio > 1.8;
    fyLog(
      `interestBurst: sessionSize=${this.sessionRing.length} ` +
      `recentAvg=${avgRecent.toFixed(2)} olderAvg=${avgOlder.toFixed(2)} ` +
      `ratio=${ratio.toFixed(2)} → burst=${burst}`,
    );
    return burst;
  }

  /** Get a snapshot of the engine's internal state for the debug overlay. */
  getDebugState() {
    const now = Date.now();
    const momentum = this.getSessionMomentumScores();
    const assetEntries = Object.entries(this.state.assets).map(([id, e]) => {
      const score = this.computeAssetScore(e, now);
      return {
        id: id.slice(0, 8),
        fullId: id,
        score,
        combined: this.getCombinedAssetScore(id, score, momentum),
        views: e.viewCount,
        totalWatchSec: +(e.totalWatchTimeMs / 1000).toFixed(1),
        lastSeenAgo: `${((now - e.lastSeenAt) / 60_000).toFixed(0)}m`,
      };
    });
    assetEntries.sort((a, b) => b.combined - a.combined);

    const personEntries = Object.entries(this.state.persons).map(([id, e]) => ({
      id: id.slice(0, 8),
      fullId: id,
      score: this.computePersonScore(e, now),
      views: e.viewCount,
    }));
    personEntries.sort((a, b) => b.score - a.score);

    return {
      totalViews: this.state.totalGlobalViewCount,
      avgWatchTimeSec: +(this.getAverageWatchTimeMs() / 1000).toFixed(1),
      trackedAssets: Object.keys(this.state.assets).length,
      trackedPersons: Object.keys(this.state.persons).length,
      recentlyShownCount: this.state.recentlyShown.length,
      sessionSize: this.sessionRing.length,
      interestBurst: this.sessionRing.length >= 6 ? this.hasInterestBurst() : false,
      topAssets: assetEntries.slice(0, 10),
      bottomAssets: assetEntries.filter((a) => a.score < 0).slice(-5).reverse(),
      topPersons: personEntries.slice(0, 5),
    };
  }

  /** Remove a single tracked asset from engagement data, adjusting running totals. */
  removeAsset(assetId: string): void {
    const ae = this.state.assets[assetId];
    if (ae) {
      // Subtract from running totals (same logic as eviction) to prevent average drift
      this.state.totalGlobalWatchTimeMs = Math.max(0, this.state.totalGlobalWatchTimeMs - ae.totalWatchTimeMs);
      this.state.totalGlobalViewCount = Math.max(0, this.state.totalGlobalViewCount - ae.viewCount);
      const mt = ae.mediaType ?? 'photo';
      if (mt === 'video') {
        this.state.totalVideoWatchTimeMs = Math.max(0, this.state.totalVideoWatchTimeMs - ae.totalWatchTimeMs);
        this.state.totalVideoViewCount = Math.max(0, this.state.totalVideoViewCount - ae.viewCount);
      } else if (mt === 'gif') {
        this.state.totalGifWatchTimeMs = Math.max(0, this.state.totalGifWatchTimeMs - ae.totalWatchTimeMs);
        this.state.totalGifViewCount = Math.max(0, this.state.totalGifViewCount - ae.viewCount);
      } else {
        this.state.totalPhotoWatchTimeMs = Math.max(0, this.state.totalPhotoWatchTimeMs - ae.totalWatchTimeMs);
        this.state.totalPhotoViewCount = Math.max(0, this.state.totalPhotoViewCount - ae.viewCount);
      }
      delete this.state.assets[assetId];
    }
    this.state.recentlyShown = this.state.recentlyShown.filter((id) => id !== assetId);
    this.save();
    fyLog(`removeAsset: removed ${assetId.slice(0, 8)}`, 'info');
  }

  /** Remove a single tracked person from engagement data. */
  removePerson(personId: string): void {
    delete this.state.persons[personId];
    this.save();
    fyLog(`removePerson: removed ${personId.slice(0, 8)}`, 'info');
  }

  /** Reset all engagement data. */
  reset(): void {
    this.state = this.emptyState();
    this.sessionRing = [];
    this.recentAnchorIds = [];
    this.save();
    fyLog('reset: all engagement data cleared', 'warn');
  }
}

/** Singleton engine instance. */
export const forYouEngine = new ForYouEngine();
