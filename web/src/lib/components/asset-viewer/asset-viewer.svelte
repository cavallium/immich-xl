<script lang="ts">
  import { goto } from '$app/navigation';
  import { focusTrap } from '$lib/actions/focus-trap';
  import type { Action, OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
  import MotionPhotoAction from '$lib/components/asset-viewer/actions/motion-photo-action.svelte';
  import NextAssetAction from '$lib/components/asset-viewer/actions/next-asset-action.svelte';
  import PreviousAssetAction from '$lib/components/asset-viewer/actions/previous-asset-action.svelte';
  import AssetViewerNavBar from '$lib/components/asset-viewer/asset-viewer-nav-bar.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { AppRoute, AssetAction, ProjectionType } from '$lib/constants';
  import { activityManager } from '$lib/managers/activity-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte.ts';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { closeEditorCofirm } from '$lib/stores/asset-editor.store';
  import { assetViewingStore } from '$lib/stores/asset-viewing.store';
  import { ocrManager } from '$lib/stores/ocr.svelte';
  import { alwaysLoadOriginalVideo, isShowDetail } from '$lib/stores/preferences.store';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { forYouEngine, getForYouDebugLog, clearForYouDebugLog, type ForYouLogEntry, type ForYouLogLevel } from '$lib/stores/for-you-engine';
  import { user } from '$lib/stores/user.store';
  import { websocketEvents } from '$lib/stores/websocket';
  import { getAssetJobMessage, getAssetThumbnailUrl, getSharedLink, handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { SlideshowHistory } from '$lib/utils/slideshow-history';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AssetJobName,
    AssetTypeEnum,
    getAllAlbums,
    getAssetInfo,
    getRandom,
    getStack,
    runAssetJobs,
    searchRandom,
    searchSmart,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
    type StackResponseDto,
  } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fly } from 'svelte/transition';
  import Thumbnail from '../assets/thumbnail/thumbnail.svelte';
  import ActivityStatus from './activity-status.svelte';
  import ActivityViewer from './activity-viewer.svelte';
  import DetailPanel from './detail-panel.svelte';
  import CropArea from './editor/crop-tool/crop-area.svelte';
  import EditorPanel from './editor/editor-panel.svelte';
  import ImagePanoramaViewer from './image-panorama-viewer.svelte';
  import OcrButton from './ocr-button.svelte';
  import PhotoViewer from './photo-viewer.svelte';
  import SlideshowBar from './slideshow-bar.svelte';
  import VideoViewer from './video-wrapper-viewer.svelte';

  type HasAsset = boolean;

  interface Props {
    asset: AssetResponseDto;
    preloadAssets?: TimelineAsset[];
    showNavigation?: boolean;
    withStacked?: boolean;
    isShared?: boolean;
    album?: AlbumResponseDto | null;
    person?: PersonResponseDto | null;
    preAction?: PreAction | undefined;
    onAction?: OnAction | undefined;
    showCloseButton?: boolean;
    onClose: (asset: AssetResponseDto) => void;
    onNext: () => Promise<HasAsset>;
    onPrevious: () => Promise<HasAsset>;
    onRandom: () => Promise<{ id: string } | undefined>;
    copyImage?: () => Promise<void>;
  }

  let {
    asset = $bindable(),
    preloadAssets = $bindable([]),
    showNavigation = true,
    withStacked = false,
    isShared = false,
    album = null,
    person = null,
    preAction = undefined,
    onAction = undefined,
    showCloseButton,
    onClose,
    onNext,
    onPrevious,
    onRandom,
    copyImage = $bindable(),
  }: Props = $props();

  const { setAssetId, setAsset } = assetViewingStore;
  const {
    restartProgress: restartSlideshowProgress,
    stopProgress: stopSlideshowProgress,
    slideshowNavigation,
    slideshowState,
    slideshowTransition,
    forYouOnlyVideos,
    forYouOnlyFavorites,
    forYouMinRating,
    forYouDiscoveryRate,
    forYouAvoidRecent,
  } = slideshowStore;

  // For You algorithm state — only need to track when the current asset started being viewed;
  // all engagement data is persisted in the ForYouEngine (localStorage).
  let currentAssetStartTime: number = $state(0);
  // Prefetch queue: pre-fetched next assets for instant ForYou transitions.
  let forYouPrefetchQueue: AssetResponseDto[] = [];
  // Whether a prefetch is currently in-flight (avoid duplicate fetches).
  let forYouPrefetching = false;
  // Debug overlay state
  let expandedThumbId = $state<string | null>(null);
  let showForYouDebug = $state(false);
  let debugLogLevel: ForYouLogLevel = $state('debug');
  const LOG_LEVELS: ForYouLogLevel[] = ['debug', 'info', 'warn', 'error'];
  let forYouDebugState: ReturnType<typeof forYouEngine.getDebugState> | null = $state(null);
  let forYouDebugLogs: ForYouLogEntry[] = $state([]);
  let forYouLastStrategy = $state('');

  function fyLog(msg: string, level: ForYouLogLevel = 'debug'): void {
    const entry: ForYouLogEntry = { timestamp: Date.now(), message: msg, level };
    getForYouDebugLog().push(entry);
    forYouDebugLogs = getForYouDebugLog().slice();
  }

  function refreshDebugOverlay(): void {
    forYouDebugState = forYouEngine.getDebugState();
    forYouDebugLogs = getForYouDebugLog().slice();
  }
  const stackThumbnailSize = 60;
  const stackSelectedThumbnailSize = 65;

  let appearsInAlbums: AlbumResponseDto[] = $state([]);
  let shouldPlayMotionPhoto = $state(false);
  let sharedLink = getSharedLink();
  let enableDetailPanel = asset.hasMetadata;
  let slideshowStateUnsubscribe: () => void;
  let shuffleSlideshowUnsubscribe: () => void;
  let previewStackedAsset: AssetResponseDto | undefined = $state();
  let isShowActivity = $state(false);
  let isShowEditor = $state(false);
  let fullscreenElement = $state<Element>();
  let unsubscribes: (() => void)[] = [];
  let selectedEditType: string = $state('');
  let stack: StackResponseDto | null = $state(null);

  let zoomToggle = $state(() => void 0);
  let playOriginalVideo = $state($alwaysLoadOriginalVideo);

  const setPlayOriginalVideo = (value: boolean) => {
    playOriginalVideo = value;
  };

  const refreshStack = async () => {
    if (authManager.isSharedLink) {
      return;
    }

    if (asset.stack) {
      stack = await getStack({ id: asset.stack.id });
    }

    if (!stack?.assets.some(({ id }) => id === asset.id)) {
      stack = null;
    }

    untrack(() => {
      if (stack && stack?.assets.length > 1) {
        preloadAssets.push(toTimelineAsset(stack.assets[1]));
      }
    });
  };

  const handleFavorite = async () => {
    if (album && album.isActivityEnabled) {
      try {
        await activityManager.toggleLike();
      } catch (error) {
        handleError(error, $t('errors.unable_to_change_favorite'));
      }
    }
  };

  const onAssetUpdate = ({ asset: assetUpdate }: { event: 'upload' | 'update'; asset: AssetResponseDto }) => {
    if (assetUpdate.id === asset.id) {
      asset = assetUpdate;
    }
  };

  onMount(async () => {
    unsubscribes.push(
      websocketEvents.on('on_upload_success', (asset) => onAssetUpdate({ event: 'upload', asset })),
      websocketEvents.on('on_asset_update', (asset) => onAssetUpdate({ event: 'update', asset })),
    );

    slideshowStateUnsubscribe = slideshowState.subscribe((value) => {
      if (value === SlideshowState.PlaySlideshow) {
        slideshowHistory.reset();
        slideshowHistory.queue(toTimelineAsset(asset));
        // Seed ForYou engine with current asset and start tracking watch time
        forYouEngine.addRecentlyShown(asset.id);
        currentAssetStartTime = Date.now();
        handlePromiseError(handlePlaySlideshow());
      } else if (value === SlideshowState.StopSlideshow) {
        // Record watch time for the last viewed asset before stopping
        recordWatchTime(asset);
        handlePromiseError(handleStopSlideshow());
      }
    });

    shuffleSlideshowUnsubscribe = slideshowNavigation.subscribe((value) => {
      if (
        value === SlideshowNavigation.Shuffle ||
        value === SlideshowNavigation.RandomLibrary ||
        value === SlideshowNavigation.ForYou
      ) {
        slideshowHistory.reset();
        slideshowHistory.queue(toTimelineAsset(asset));
      }
    });

    if (!sharedLink) {
      await handleGetAllAlbums();
    }
  });

  onDestroy(() => {
    if (slideshowStateUnsubscribe) {
      slideshowStateUnsubscribe();
    }

    if (shuffleSlideshowUnsubscribe) {
      shuffleSlideshowUnsubscribe();
    }

    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }

    activityManager.reset();
  });

  const handleGetAllAlbums = async () => {
    if (authManager.isSharedLink) {
      return;
    }

    try {
      appearsInAlbums = await getAllAlbums({ assetId: asset.id });
    } catch (error) {
      console.error('Error getting album that asset belong to', error);
    }
  };

  const handleOpenActivity = () => {
    if ($isShowDetail) {
      $isShowDetail = false;
    }
    isShowActivity = !isShowActivity;
  };

  const toggleDetailPanel = () => {
    isShowActivity = false;
    $isShowDetail = !$isShowDetail;
  };

  const closeViewer = () => {
    onClose(asset);
  };

  const closeEditor = () => {
    closeEditorCofirm(() => {
      isShowEditor = false;
    });
  };

  const getLibraryRandomAsset = async (): Promise<AssetResponseDto | null> => {
    try {
      const assets = await getRandom({ count: 1 });
      if (!assets || assets.length === 0) {
        toastManager.info('No assets available for random slideshow.');
        return null;
      }
      return assets[0];
    } catch (error) {
      console.error('Failed to fetch random asset:', error);
      toastManager.error('Failed to fetch random asset.');
      return null;
    }
  };

  // ── For You algorithm ────────────────────────────────────────────────────
  // TikTok-like personalised feed powered by the persistent ForYouEngine.
  //
  // Strategy selection (per request):
  //   1. Roll against discoveryRate → pure random (exploration).
  //   2. Otherwise, if CLIP is available and we have engagement data →
  //      ML similarity search using the engine's weighted anchor selection.
  //   3. Otherwise, if we have person data → person-based random search.
  //   4. Fallback → pure random (cold-start / no ML).
  //
  // Within each strategy we apply the user's filters (video-only, favorites,
  // min-rating) and avoid recently shown assets when configured.

  /** Build common filter params from user settings. */
  const buildFilterParams = () => {
    const params: Record<string, unknown> = {};
    if ($forYouOnlyVideos) params.type = AssetTypeEnum.Video;
    if ($forYouOnlyFavorites) params.isFavorite = true;
    if ($forYouMinRating > 0) params.rating = $forYouMinRating;
    return params;
  };

  /** Pick the best candidate from a list, filtering recently-shown and negatively-scored assets,
   *  then re-ranking by person affinity and engagement signals. */
  const pickCandidate = (assets: AssetResponseDto[], negativeIds?: Set<string>): AssetResponseDto | null => {
    if (!assets || assets.length === 0) {
      fyLog('[pick] no candidates to pick from', 'warn');
      return null;
    }
    let pool = assets;
    // Filter out negatively-scored assets (content the user dislikes)
    if (negativeIds && negativeIds.size > 0) {
      const before = pool.length;
      const filtered = pool.filter((a) => !negativeIds.has(a.id));
      if (filtered.length > 0) pool = filtered;
      fyLog(`[pick] negative content filter: ${before} → ${pool.length} candidates`);
    }
    if ($forYouAvoidRecent) {
      const before = pool.length;
      const fresh = pool.filter((a) => !forYouEngine.isRecentlyShown(a.id));
      if (fresh.length > 0) pool = fresh;
      fyLog(`[pick] recently-shown filter: ${before} → ${pool.length} candidates`);
    }
    // Re-rank candidates using person affinity, negative history, and freshness.
    // The CLIP search order provides a base relevance rank (index-based),
    // which we combine with the engine's candidate score.
    const scored = pool.map((a, idx) => {
      const personIds = (a.people ?? []).filter((p) => p.id).map((p) => p.id);
      const candidateScore = forYouEngine.scoreCandidateAsset(a.id, personIds);
      // Base rank score: earlier CLIP results get a strong exponential bonus.
      // CLIP similarity drops off quickly, so we use exponential decay to
      // heavily favour the top results and suppress the irrelevant tail.
      const clipRankBonus = 5 * Math.exp(-3 * idx / pool.length);
      return { asset: a, candidateScore, clipRankBonus, finalScore: candidateScore + clipRankBonus };
    });
    scored.sort((a, b) => b.finalScore - a.finalScore);
    // Weighted random pick from top 5 to add variety while preferring best matches
    const topN = scored.slice(0, Math.min(5, scored.length));
    fyLog(`[pick] top-${topN.length} candidates: ${topN.map((s) => `${s.asset.id.slice(0, 8)}…(clip=${s.clipRankBonus.toFixed(2)} eng=${s.candidateScore.toFixed(2)} total=${s.finalScore.toFixed(2)})`).join(', ')}`);
    const minScore = Math.min(...topN.map((s) => s.finalScore));
    const weights = topN.map((s) => Math.max(0.1, s.finalScore - minScore + 1));
    const totalW = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * totalW;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        fyLog(`[pick] selected: ${topN[i].asset.id.slice(0, 8)}… (rank #${i}, weight=${(weights[i] / totalW * 100).toFixed(1)}%)`);
        return topN[i].asset;
      }
    }
    fyLog(`[pick] selected last: ${topN[topN.length - 1].asset.id.slice(0, 8)}…`);
    return topN[topN.length - 1].asset;
  };

  const getForYouAsset = async (): Promise<AssetResponseDto | null> => {
    try {
      fyLog('════════════════════════════════════════════════', 'info');
      fyLog(`[fetch] starting asset selection (views=${forYouEngine.getViewCount()}, session=${forYouEngine.getSessionSize()})`);
      const userDiscoveryRate = $forYouDiscoveryRate / 100;
      const effectiveDiscoveryRate = forYouEngine.getAdaptiveDiscoveryRate(userDiscoveryRate);
      const roll = Math.random();
      const burst = forYouEngine.hasInterestBurst();
      // During an interest burst, suppress discovery to keep riding the wave
      const useDiscovery = burst
        ? roll < effectiveDiscoveryRate * 0.3
        : roll < effectiveDiscoveryRate;
      forYouLastStrategy = useDiscovery ? 'DISCOVERY' : 'RECOMMENDATION';
      fyLog(`[fetch] discovery: roll=${(roll * 100).toFixed(1)}% threshold=${(burst ? effectiveDiscoveryRate * 0.3 * 100 : effectiveDiscoveryRate * 100).toFixed(1)}% → ${forYouLastStrategy} (burst=${burst})`);

      let isSmartSearchEnabled = false;
      try {
        let features = featureFlagsManager.value;
        if (!features) {
          fyLog('[config] featureFlagsManager.value is null, calling init()');
          await featureFlagsManager.init();
          features = featureFlagsManager.value;
        }
        fyLog(`[config] smartSearch=${features?.smartSearch}`);
        if (features?.smartSearch) {
          isSmartSearchEnabled = true;
        }
      } catch (error) {
        fyLog(`[config] ERROR loading server features: ${error}`, 'error');
        console.warn('ForYou: failed to load server features, skipping CLIP strategy', error);
      }
      fyLog(`[gate] isSmartSearchEnabled=${isSmartSearchEnabled} hasEngagement=${forYouEngine.hasEngagementData()} hasPersonData=${forYouEngine.hasPersonData()}`);

      let selectedAsset: AssetResponseDto | null = null;

      // ── Build content-based negative exclusion set ──────────────────────
      // In a large library you almost never see the same asset twice, so
      // filtering by exact asset ID is useless. Instead, use negative anchors
      // as CLIP queries to find assets *similar* to disliked content and
      // exclude those from recommendations (content-based filtering).
      const negativeAnchorIds = forYouEngine.pickNegativeAnchorAssetIds();
      let negativeContentIds = new Set<string>();
      if (isSmartSearchEnabled && negativeAnchorIds.length > 0) {
        fyLog(`building negative content set from ${negativeAnchorIds.length} negative anchors`);
        const negSearchPromises = negativeAnchorIds.map(async (anchorId) => {
          try {
            const response = await searchSmart({
              smartSearchDto: {
                queryAssetId: anchorId,
                size: 15,
                ...buildFilterParams(),
              } as Parameters<typeof searchSmart>[0]['smartSearchDto'],
            });
            return response.assets.items.map((a) => a.id);
          } catch {
            return [];
          }
        });
        const negResults = await Promise.all(negSearchPromises);
        negativeContentIds = new Set(negResults.flat());
        // Also add the negative anchor IDs themselves
        for (const id of negativeAnchorIds) negativeContentIds.add(id);
        fyLog(`negative content exclusion set has ${negativeContentIds.size} assets`);
      }

      // ── Strategy 1: Discovery (random exploration) ──────────────────────
      if (useDiscovery) {
        fyLog(`discovery roll (${(roll * 100).toFixed(1)}% < ${(effectiveDiscoveryRate * 100).toFixed(1)}%, burst=${forYouEngine.hasInterestBurst()})`);
        selectedAsset = await fetchRandomAsset(negativeContentIds);
      }

      // ── Strategy 2: Multi-anchor CLIP similarity search ─────────────────
      // Query multiple anchors in parallel and merge results for better coverage.
      // During an interest burst, use fewer anchors (more focused) for tighter results.
      if (!selectedAsset && !useDiscovery && isSmartSearchEnabled && forYouEngine.hasEngagementData()) {
        const anchorCount = forYouEngine.hasInterestBurst() ? 2 : undefined;
        const anchors = forYouEngine.pickQueryAnchorAssetIds(anchorCount);
        forYouLastStrategy = `CLIP (${anchors.length} anchors)`;
        fyLog(`[CLIP] strategy with ${anchors.length} anchors, ${negativeContentIds.size} negative content exclusions`);
        if (anchors.length > 0) {
          // Allocate search slots proportional to anchor score so higher-scored
          // anchors contribute more candidates. Keep budget small (~50) because
          // CLIP results are sorted by similarity and the tail becomes random.
          const totalScore = anchors.reduce((s, a) => s + a.score, 0);
          const TOTAL_BUDGET = 50;
          const MIN_PER_ANCHOR = 5;
          const anchorSizes = anchors.map((a) => {
            const proportional = Math.round((a.score / totalScore) * TOTAL_BUDGET);
            return Math.max(MIN_PER_ANCHOR, proportional);
          });
          fyLog(`[CLIP] budget allocation: ${anchors.map((a, i) => `${a.id.slice(0, 8)}…→${anchorSizes[i]} slots`).join(', ')} (total=${anchorSizes.reduce((s, n) => s + n, 0)})`);

          const allCandidates: AssetResponseDto[] = [];
          const searchPromises = anchors.map(async (anchor, idx) => {
            try {
              const response = await searchSmart({
                smartSearchDto: {
                  queryAssetId: anchor.id,
                  size: anchorSizes[idx],
                  withPeople: true,
                  ...buildFilterParams(),
                } as Parameters<typeof searchSmart>[0]['smartSearchDto'],
              });
              return response.assets.items;
            } catch (error) {
              console.warn(`ForYou: CLIP search failed for anchor ${anchor.id}`, error);
              return [];
            }
          });
          const results = await Promise.all(searchPromises);
          // Merge results via round-robin across anchors so each anchor
          // contributes equally to the top of the candidate list.
          const seen = new Set<string>(anchors.map((a) => a.id)); // exclude anchor assets themselves
          const maxLen = Math.max(...results.map((r) => r.length));
          for (let i = 0; i < maxLen; i++) {
            for (const items of results) {
              if (i < items.length && !seen.has(items[i].id)) {
                seen.add(items[i].id);
                allCandidates.push(items[i]);
              }
            }
          }
          fyLog(`[CLIP] merged ${allCandidates.length} unique candidates from ${results.length} anchor queries`);
          selectedAsset = pickCandidate(allCandidates, negativeContentIds);
        }
      }

      // ── Strategy 3: Person-based recommendation (low priority fallback) ──
      // Person-based is only a fallback — content/preference via CLIP are primary.
      if (!selectedAsset && !useDiscovery && forYouEngine.hasPersonData()) {
        forYouLastStrategy = 'PERSON';
        fyLog('[person] falling through to person-based strategy', 'warn');
        const personIds = forYouEngine.pickPersonIds();
        if (personIds.length > 0) {
          try {
            const assets = await searchRandom({
              randomSearchDto: {
                personIds,
                size: 5,
                withPeople: true,
                ...buildFilterParams(),
              } as Parameters<typeof searchRandom>[0]['randomSearchDto'],
            });
            selectedAsset = pickCandidate(assets, negativeContentIds);
          } catch (error) {
            console.warn('ForYou: person-based search failed', error);
          }
        }
      }

      // ── Strategy 4: Fallback random ─────────────────────────────────────
      if (!selectedAsset) {
        forYouLastStrategy = 'RANDOM (fallback)';
        fyLog('[fallback] all strategies exhausted, using random', 'warn');
        selectedAsset = await fetchRandomAsset(negativeContentIds);
      }

      if (!selectedAsset) {
        toastManager.info('No assets available for For You feed.');
        return null;
      }

      fyLog(`[fetch] ✓ selected asset: ${selectedAsset.id.slice(0, 8)}… (type=${selectedAsset.type})`, 'info');
      refreshDebugOverlay();

      // Mark as recently shown so we don't repeat it soon
      forYouEngine.addRecentlyShown(selectedAsset.id);

      // Trigger background prefetch of the next asset for instant transition
      triggerForYouPrefetch();

      return selectedAsset;
    } catch (error) {
      console.error('Failed to fetch For You asset:', error);
      toastManager.error('Failed to fetch For You content.');
      return null;
    }
  };

  /** Try to return a prefetched asset, or fall back to fetching on demand. */
  const getForYouAssetFast = async (): Promise<AssetResponseDto | null> => {
    if (forYouPrefetchQueue.length > 0) {
      const prefetched = forYouPrefetchQueue.shift()!;
      // Verify it's still fresh (not recently shown by another path)
      if (!forYouEngine.isRecentlyShown(prefetched.id) || !$forYouAvoidRecent) {
        fyLog(`[prefetch] serving prefetched asset ${prefetched.id.slice(0, 8)}… (queue=${forYouPrefetchQueue.length} remaining)`);
        forYouEngine.addRecentlyShown(prefetched.id);
        triggerForYouPrefetch();
        return prefetched;
      }
      fyLog(`[prefetch] prefetched asset ${prefetched.id.slice(0, 8)}… was already shown, falling back to fresh fetch`);
    }
    return getForYouAsset();
  };

  /** Background prefetch: fetch the next ForYou asset ahead of time. */
  const triggerForYouPrefetch = () => {
    if (forYouPrefetching || forYouPrefetchQueue.length >= 2) return;
    forYouPrefetching = true;
    getForYouAssetInternal()
      .then((a) => {
        if (a) forYouPrefetchQueue.push(a);
      })
      .catch(() => { /* prefetch failure is non-critical */ })
      .finally(() => { forYouPrefetching = false; });
  };

  /** Internal version of getForYouAsset that doesn't trigger further prefetch (avoids recursion). */
  const getForYouAssetInternal = async (): Promise<AssetResponseDto | null> => {
    try {
      const userDiscoveryRate = $forYouDiscoveryRate / 100;
      const effectiveDiscoveryRate = forYouEngine.getAdaptiveDiscoveryRate(userDiscoveryRate);
      const roll = Math.random();
      const useDiscovery = forYouEngine.hasInterestBurst()
        ? roll < effectiveDiscoveryRate * 0.3
        : roll < effectiveDiscoveryRate;

      let isSmartSearchEnabled = false;
      try {
        let features = featureFlagsManager.value;
        if (!features) {
          await featureFlagsManager.init();
          features = featureFlagsManager.value;
        }
        if (features?.smartSearch) {
          isSmartSearchEnabled = true;
        }
      } catch { /* ignore */ }

      let selectedAsset: AssetResponseDto | null = null;

      if (useDiscovery) {
        selectedAsset = await fetchRandomAsset();
      }

      if (!selectedAsset && !useDiscovery && isSmartSearchEnabled && forYouEngine.hasEngagementData()) {
        const anchorCount = forYouEngine.hasInterestBurst() ? 2 : undefined;
        const anchors = forYouEngine.pickQueryAnchorAssetIds(anchorCount);
        if (anchors.length > 0) {
          const totalScore = anchors.reduce((s, a) => s + a.score, 0);
          const TOTAL_BUDGET = 50;
          const MIN_PER_ANCHOR = 5;
          const anchorSizes = anchors.map((a) => {
            const proportional = Math.round((a.score / totalScore) * TOTAL_BUDGET);
            return Math.max(MIN_PER_ANCHOR, proportional);
          });
          const allCandidates: AssetResponseDto[] = [];
          const results = await Promise.all(anchors.map(async (anchor, idx) => {
            try {
              const response = await searchSmart({
                smartSearchDto: {
                  queryAssetId: anchor.id,
                  size: anchorSizes[idx],
                  withPeople: true,
                  ...buildFilterParams(),
                } as Parameters<typeof searchSmart>[0]['smartSearchDto'],
              });
              return response.assets.items;
            } catch { return []; }
          }));
          const seen = new Set<string>(anchors.map((a) => a.id));
          const maxLen = Math.max(...results.map((r) => r.length));
          for (let i = 0; i < maxLen; i++) {
            for (const items of results) {
              if (i < items.length && !seen.has(items[i].id)) {
                seen.add(items[i].id);
                allCandidates.push(items[i]);
              }
            }
          }
          selectedAsset = pickCandidate(allCandidates);
        }
      }

      if (!selectedAsset && !useDiscovery && forYouEngine.hasPersonData()) {
        const personIds = forYouEngine.pickPersonIds();
        if (personIds.length > 0) {
          try {
            const assets = await searchRandom({
              randomSearchDto: {
                personIds,
                size: 5,
                withPeople: true,
                ...buildFilterParams(),
              } as Parameters<typeof searchRandom>[0]['randomSearchDto'],
            });
            selectedAsset = pickCandidate(assets);
          } catch { /* ignore */ }
        }
      }

      if (!selectedAsset) {
        selectedAsset = await fetchRandomAsset();
      }

      if (selectedAsset) {
        forYouEngine.addRecentlyShown(selectedAsset.id);
      }
      return selectedAsset;
    } catch {
      return null;
    }
  };

  /** Fetch a random asset respecting user filters and recently-shown avoidance. */
  const fetchRandomAsset = async (negativeIds?: Set<string>): Promise<AssetResponseDto | null> => {
    try {
      const assets = await searchRandom({
        randomSearchDto: {
          size: 10,
          withPeople: true,
          ...buildFilterParams(),
        } as Parameters<typeof searchRandom>[0]['randomSearchDto'],
      });
      return pickCandidate(assets, negativeIds);
    } catch (error) {
      console.error('ForYou: fetchRandomAsset failed', error);
      return null;
    }
  };

  // Record watch time for an asset — delegates to the persistent ForYouEngine.
  // The engine scores relative to the user's average watch time (no absolute skip threshold).
  const recordWatchTime = (viewedAsset: AssetResponseDto) => {
    if (currentAssetStartTime === 0) return;
    const watchTimeMs = Date.now() - currentAssetStartTime;
    const personIds = (viewedAsset.people ?? []).filter((p) => p.id).map((p) => p.id);
    forYouEngine.recordEngagement(viewedAsset.id, watchTimeMs, personIds);
    currentAssetStartTime = Date.now();
  };

  const navigateAsset = async (order?: 'previous' | 'next', e?: Event) => {
    if (!order) {
      if ($slideshowState === SlideshowState.PlaySlideshow) {
        order = $slideshowNavigation === SlideshowNavigation.AscendingOrder ? 'previous' : 'next';
      } else {
        return;
      }
    }

    e?.stopPropagation();

    let hasNext = false;

    if ($slideshowNavigation === SlideshowNavigation.RandomLibrary) {
      // Record watch time before navigating away
      recordWatchTime(asset);

      if (order === 'previous') {
        hasNext = slideshowHistory.previous();
      } else {
        hasNext = slideshowHistory.next();
        if (!hasNext) {
          const newAsset = await getLibraryRandomAsset();
          if (newAsset) {
            slideshowHistory.queue(toTimelineAsset(newAsset));
            setAsset(newAsset);
            hasNext = true;
          } else {
            hasNext = false;
          }
        }
      }
    } else if ($slideshowNavigation === SlideshowNavigation.ForYou) {
      // Record watch time before navigating - this is crucial for the algorithm
      recordWatchTime(asset);

      if (order === 'previous') {
        hasNext = slideshowHistory.previous();
      } else {
        hasNext = slideshowHistory.next();
        if (!hasNext) {
          const newAsset = await getForYouAssetFast();
          if (newAsset) {
            slideshowHistory.queue(toTimelineAsset(newAsset));
            setAsset(newAsset);
            hasNext = true;
          } else {
            hasNext = false;
          }
        }
      }
    } else if ($slideshowState === SlideshowState.PlaySlideshow && $slideshowNavigation === SlideshowNavigation.Shuffle) {
      if (order === 'previous') {
        hasNext = slideshowHistory.previous();
      } else {
        hasNext = slideshowHistory.next();
        if (!hasNext) {
          const randomAsset = await onRandom();
          if (randomAsset) {
            slideshowHistory.queue(randomAsset);
            setAssetId(randomAsset.id);
            hasNext = true;
          }
        }
      }
    } else {
      hasNext = order === 'previous' ? await onPrevious() : await onNext();
    }

    if ($slideshowState === SlideshowState.PlaySlideshow) {
      if (hasNext) {
        $restartSlideshowProgress = true;
      } else {
        await handleStopSlideshow();
      }
    }
  };

  // const showEditorHandler = () => {
  //   if (isShowActivity) {
  //     isShowActivity = false;
  //   }
  //   isShowEditor = !isShowEditor;
  // };

  const handleRunJob = async (name: AssetJobName) => {
    try {
      await runAssetJobs({ assetJobsDto: { assetIds: [asset.id], name } });
      toastManager.success($getAssetJobMessage(name));
    } catch (error) {
      handleError(error, $t('errors.unable_to_submit_job'));
    }
  };

  /**
   * Slide show mode
   */

  let assetViewerHtmlElement = $state<HTMLElement>();

  const slideshowHistory = new SlideshowHistory((asset) => {
    handlePromiseError(setAssetId(asset.id).then(() => ($restartSlideshowProgress = true)));
  });

  const handleVideoStarted = () => {
    if ($slideshowState === SlideshowState.PlaySlideshow) {
      $stopSlideshowProgress = true;
    }
  };

  const handlePlaySlideshow = async () => {
    // ForYou mode starts without fullscreen
    if ($slideshowNavigation === SlideshowNavigation.ForYou) {
      return;
    }
    try {
      await assetViewerHtmlElement?.requestFullscreen?.();
    } catch (error) {
      handleError(error, $t('errors.unable_to_enter_fullscreen'));
      $slideshowState = SlideshowState.StopSlideshow;
    }
  };

  const handleStopSlideshow = async () => {
    try {
      if (document.fullscreenElement) {
        document.body.style.cursor = '';
        await document.exitFullscreen();
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_exit_fullscreen'));
    } finally {
      $stopSlideshowProgress = true;
      $slideshowState = SlideshowState.None;
    }
  };

  const handleStackedAssetMouseEvent = (isMouseOver: boolean, asset: AssetResponseDto) => {
    previewStackedAsset = isMouseOver ? asset : undefined;
  };
  const handlePreAction = (action: Action) => {
    preAction?.(action);
  };
  const handleAction = async (action: Action) => {
    switch (action.type) {
      case AssetAction.ADD_TO_ALBUM: {
        await handleGetAllAlbums();
        break;
      }
      case AssetAction.REMOVE_ASSET_FROM_STACK: {
        stack = action.stack;
        if (stack) {
          asset = stack.assets[0];
        }
        break;
      }
      case AssetAction.STACK:
      case AssetAction.SET_STACK_PRIMARY_ASSET: {
        stack = action.stack;
        break;
      }
      case AssetAction.SET_PERSON_FEATURED_PHOTO: {
        const assetInfo = await getAssetInfo({ id: asset.id });
        asset = { ...asset, people: assetInfo.people };
        break;
      }
      case AssetAction.KEEP_THIS_DELETE_OTHERS:
      case AssetAction.UNSTACK: {
        closeViewer();
        break;
      }
    }

    onAction?.(action);
  };

  const handleUpdateSelectedEditType = (type: string) => {
    selectedEditType = type;
  };

  const handleAssetReplace = async ({ oldAssetId, newAssetId }: { oldAssetId: string; newAssetId: string }) => {
    if (oldAssetId !== asset.id) {
      return;
    }

    await new Promise((promise) => setTimeout(promise, 500));
    await goto(`${AppRoute.PHOTOS}/${newAssetId}`);
  };

  let isFullScreen = $derived(fullscreenElement !== null);

  $effect(() => {
    if (asset) {
      previewStackedAsset = undefined;
      handlePromiseError(refreshStack());
    }
  });
  $effect(() => {
    if (album && !album.isActivityEnabled && activityManager.commentCount === 0) {
      isShowActivity = false;
    }
  });
  $effect(() => {
    if (album && isShared && asset.id) {
      handlePromiseError(activityManager.init(album.id, asset.id));
    }
  });

  // primarily, this is reactive on `asset`
  $effect(() => {
    handlePromiseError(handleGetAllAlbums());
    ocrManager.clear();
    if (!sharedLink) {
      handlePromiseError(ocrManager.getAssetOcr(asset.id));
    }
  });
</script>

<OnEvents onAssetReplace={handleAssetReplace} />

<svelte:document bind:fullscreenElement />

<section
  id="immich-asset-viewer"
  class="fixed start-0 top-0 grid size-full grid-cols-4 grid-rows-[64px_1fr] overflow-hidden bg-black"
  use:focusTrap
  bind:this={assetViewerHtmlElement}
>
  <!-- Top navigation bar -->
  {#if $slideshowState === SlideshowState.None && !isShowEditor}
    <div class="col-span-4 col-start-1 row-span-1 row-start-1 transition-transform">
      <AssetViewerNavBar
        {asset}
        {album}
        {person}
        {stack}
        {showCloseButton}
        showDetailButton={enableDetailPanel}
        showSlideshow={true}
        onZoomImage={zoomToggle}
        onCopyImage={copyImage}
        preAction={handlePreAction}
        onAction={handleAction}
        onRunJob={handleRunJob}
        onPlaySlideshow={() => ($slideshowState = SlideshowState.PlaySlideshow)}
        onPlayForYou={() => {
          $slideshowNavigation = SlideshowNavigation.ForYou;
          $slideshowState = SlideshowState.PlaySlideshow;
        }}
        onShowDetail={toggleDetailPanel}
        onClose={closeViewer}
        {playOriginalVideo}
        {setPlayOriginalVideo}
      >
        {#snippet motionPhoto()}
          <MotionPhotoAction
            isPlaying={shouldPlayMotionPhoto}
            onClick={(shouldPlay) => (shouldPlayMotionPhoto = shouldPlay)}
          />
        {/snippet}
      </AssetViewerNavBar>
    </div>
  {/if}

  {#if $slideshowState != SlideshowState.None}
    <div class="absolute w-full flex">
      <SlideshowBar
        {isFullScreen}
        onSetToFullScreen={() => assetViewerHtmlElement?.requestFullscreen?.()}
        onPrevious={() => navigateAsset('previous')}
        onNext={() => navigateAsset('next')}
        onClose={() => ($slideshowState = SlideshowState.StopSlideshow)}
      />
    </div>
  {/if}

  <!-- ForYou Debug Overlay Toggle & Panel -->
  {#if $slideshowNavigation === SlideshowNavigation.ForYou && $slideshowState !== SlideshowState.None}
    <button
      class="absolute top-16 left-2 z-[9999] rounded-full bg-black/60 text-white px-2 py-1 text-xs font-mono hover:bg-black/80 transition-colors"
      onclick={() => { showForYouDebug = !showForYouDebug; if (showForYouDebug) refreshDebugOverlay(); }}
    >
      {showForYouDebug ? '✕ Debug' : '🐛 Debug'}
    </button>

    {#if showForYouDebug && forYouDebugState}
      <div class="absolute top-28 left-2 z-[9999] w-[380px] max-h-[70vh] overflow-y-auto rounded-lg bg-black/85 text-white text-xs font-mono p-3 shadow-xl backdrop-blur-sm">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-sm font-bold text-yellow-300">ForYou Debug</span>
          <button
            class="rounded bg-red-700/80 hover:bg-red-600 px-2 py-0.5 text-[10px] text-white transition-colors"
            onclick={() => { if (confirm('Reset all ForYou engagement data?')) { forYouEngine.reset(); refreshDebugOverlay(); } }}
          >🗑 Reset All</button>
        </div>

        <!-- Summary -->
        <div class="mb-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
          <span class="text-gray-400">Strategy:</span><span class="text-green-300">{forYouLastStrategy}</span>
          <span class="text-gray-400">Total views:</span><span>{forYouDebugState.totalViews}</span>
          <span class="text-gray-400">Avg watch:</span><span>{forYouDebugState.avgWatchTimeSec}s</span>
          <span class="text-gray-400">Session size:</span><span>{forYouDebugState.sessionSize}</span>
          <span class="text-gray-400">Tracked assets:</span><span>{forYouDebugState.trackedAssets}</span>
          <span class="text-gray-400">Tracked persons:</span><span>{forYouDebugState.trackedPersons}</span>
          <span class="text-gray-400">Recently shown:</span><span>{forYouDebugState.recentlyShownCount}</span>
          <span class="text-gray-400">Interest burst:</span><span class={forYouDebugState.interestBurst ? 'text-red-400 font-bold' : ''}>{forYouDebugState.interestBurst ? '🔥 YES' : 'no'}</span>
        </div>

        <!-- Top Assets -->
        {#if forYouDebugState.topAssets.length > 0}
          <details class="mb-1">
            <summary class="cursor-pointer text-yellow-200 hover:text-yellow-100">Top Assets ({forYouDebugState.topAssets.length})</summary>
            <table class="w-full mt-1">
              <thead><tr class="text-gray-500"><th class="text-left"></th><th class="text-left">ID</th><th>Score</th><th>Comb</th><th>Views</th><th>Watch</th><th>Ago</th><th></th></tr></thead>
              <tbody>
                {#each forYouDebugState.topAssets as a}
                  <tr class="border-t border-gray-700/50">
                    <td>
                      <button class="block" onclick={() => { expandedThumbId = expandedThumbId === a.fullId ? null : a.fullId; }}>
                        <img
                          src={getAssetThumbnailUrl(a.fullId)}
                          alt={a.id}
                          class="rounded transition-all {expandedThumbId === a.fullId ? 'w-32 h-32' : 'w-6 h-6'} object-cover cursor-pointer"
                        />
                      </button>
                    </td>
                    <td class="text-blue-300">{a.id}</td>
                    <td class="text-right">{a.score.toFixed(1)}</td>
                    <td class="text-right">{a.combined.toFixed(1)}</td>
                    <td class="text-center">{a.views}</td>
                    <td class="text-right">{a.totalWatchSec}s</td>
                    <td class="text-right text-gray-400">{a.lastSeenAgo}</td>
                    <td><button class="text-red-400 hover:text-red-200 px-1" title="Remove" onclick={() => { forYouEngine.removeAsset(a.fullId); refreshDebugOverlay(); }}>✕</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </details>
        {/if}

        <!-- Bottom Assets (disliked) -->
        {#if forYouDebugState.bottomAssets.length > 0}
          <details class="mb-1">
            <summary class="cursor-pointer text-red-300 hover:text-red-200">Disliked Assets ({forYouDebugState.bottomAssets.length})</summary>
            <table class="w-full mt-1">
              <thead><tr class="text-gray-500"><th class="text-left"></th><th class="text-left">ID</th><th>Score</th><th>Views</th><th></th></tr></thead>
              <tbody>
                {#each forYouDebugState.bottomAssets as a}
                  <tr class="border-t border-gray-700/50">
                    <td>
                      <button class="block" onclick={() => { expandedThumbId = expandedThumbId === a.fullId ? null : a.fullId; }}>
                        <img
                          src={getAssetThumbnailUrl(a.fullId)}
                          alt={a.id}
                          class="rounded transition-all {expandedThumbId === a.fullId ? 'w-32 h-32' : 'w-6 h-6'} object-cover cursor-pointer"
                        />
                      </button>
                    </td>
                    <td class="text-red-400">{a.id}</td>
                    <td class="text-right">{a.score.toFixed(1)}</td>
                    <td class="text-center">{a.views}</td>
                    <td><button class="text-red-400 hover:text-red-200 px-1" title="Remove" onclick={() => { forYouEngine.removeAsset(a.fullId); refreshDebugOverlay(); }}>✕</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </details>
        {/if}

        <!-- Top Persons -->
        {#if forYouDebugState.topPersons.length > 0}
          <details class="mb-1">
            <summary class="cursor-pointer text-purple-300 hover:text-purple-200">Top Persons ({forYouDebugState.topPersons.length})</summary>
            <div class="mt-1">
              {#each forYouDebugState.topPersons as p}
                <div class="flex justify-between border-t border-gray-700/50 py-0.5">
                  <span class="text-purple-300">{p.id}</span>
                  <span>score={p.score.toFixed(1)} views={p.views}</span>
                  <button class="text-red-400 hover:text-red-200 px-1 ml-1" title="Remove" onclick={() => { forYouEngine.removePerson(p.fullId); refreshDebugOverlay(); }}>✕</button>
                </div>
              {/each}
            </div>
          </details>
        {/if}

        <!-- Log -->
        <details>
          <summary class="cursor-pointer text-gray-300 hover:text-gray-100">Log ({forYouDebugLogs.filter(e => LOG_LEVELS.indexOf(e.level) >= LOG_LEVELS.indexOf(debugLogLevel)).length})</summary>
          <div class="flex gap-1 mt-1 mb-1">
            {#each LOG_LEVELS as lvl}
              {@const active = LOG_LEVELS.indexOf(lvl) >= LOG_LEVELS.indexOf(debugLogLevel)}
              {@const colors = { debug: 'bg-gray-600', info: 'bg-blue-600', warn: 'bg-yellow-600', error: 'bg-red-600' }}
              {@const labels = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }}
              <button
                class="rounded px-1.5 py-0.5 text-[9px] font-bold text-white transition-opacity {colors[lvl]} {active ? 'opacity-100' : 'opacity-30'}"
                onclick={() => { debugLogLevel = lvl; }}
              >{labels[lvl]}+</button>
            {/each}
          </div>
          <div class="mt-1 max-h-[200px] overflow-y-auto text-[10px] leading-tight">
            {#each forYouDebugLogs.filter(e => LOG_LEVELS.indexOf(e.level) >= LOG_LEVELS.indexOf(debugLogLevel)).slice().reverse() as entry}
              <div class="border-t border-gray-800 py-0.5">
                <span class="text-gray-500">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                {#if entry.level === 'error'}
                  <span class="inline-block rounded px-1 text-[9px] font-bold bg-red-600 text-white mr-0.5">ERR</span>
                {:else if entry.level === 'warn'}
                  <span class="inline-block rounded px-1 text-[9px] font-bold bg-yellow-600 text-white mr-0.5">WRN</span>
                {:else if entry.level === 'info'}
                  <span class="inline-block rounded px-1 text-[9px] font-bold bg-blue-600 text-white mr-0.5">INF</span>
                {:else}
                  <span class="inline-block rounded px-1 text-[9px] font-bold bg-gray-600 text-gray-300 mr-0.5">DBG</span>
                {/if}
                {entry.message}
              </div>
            {/each}
          </div>
        </details>

        <button
          class="mt-2 w-full rounded bg-gray-700 hover:bg-gray-600 py-1 text-center"
          onclick={() => { clearForYouDebugLog(); refreshDebugOverlay(); }}
        >
          Clear Log
        </button>
      </div>
    {/if}
  {/if}

  {#if $slideshowState === SlideshowState.None && showNavigation && !isShowEditor}
    <div class="my-auto column-span-1 col-start-1 row-span-full row-start-1 justify-self-start">
      <PreviousAssetAction onPreviousAsset={() => navigateAsset('previous')} />
    </div>
  {/if}

  <!-- Asset Viewer -->
  <div class="z-[-1] relative col-start-1 col-span-4 row-start-1 row-span-full">
    {#if previewStackedAsset}
      {#key previewStackedAsset.id}
        {#if previewStackedAsset.type === AssetTypeEnum.Image}
          <PhotoViewer
            bind:zoomToggle
            bind:copyImage
            asset={previewStackedAsset}
            {preloadAssets}
            onPreviousAsset={() => navigateAsset('previous')}
            onNextAsset={() => navigateAsset('next')}
            haveFadeTransition={false}
            {sharedLink}
          />
        {:else}
          <VideoViewer
            assetId={previewStackedAsset.id}
            cacheKey={previewStackedAsset.thumbhash}
            projectionType={previewStackedAsset.exifInfo?.projectionType}
            loopVideo={true}
            onPreviousAsset={() => navigateAsset('previous')}
            onNextAsset={() => navigateAsset('next')}
            onClose={closeViewer}
            onVideoEnded={() => navigateAsset()}
            onVideoStarted={handleVideoStarted}
            {playOriginalVideo}
          />
        {/if}
      {/key}
    {:else}
      {#key asset.id}
        {#if asset.type === AssetTypeEnum.Image}
          {#if shouldPlayMotionPhoto && asset.livePhotoVideoId}
            <VideoViewer
              assetId={asset.livePhotoVideoId}
              cacheKey={asset.thumbhash}
              projectionType={asset.exifInfo?.projectionType}
              loopVideo={$slideshowState !== SlideshowState.PlaySlideshow}
              onPreviousAsset={() => navigateAsset('previous')}
              onNextAsset={() => navigateAsset('next')}
              onVideoEnded={() => (shouldPlayMotionPhoto = false)}
              {playOriginalVideo}
            />
          {:else if asset.exifInfo?.projectionType === ProjectionType.EQUIRECTANGULAR || (asset.originalPath && asset.originalPath
                .toLowerCase()
                .endsWith('.insp'))}
            <ImagePanoramaViewer bind:zoomToggle {asset} />
          {:else if isShowEditor && selectedEditType === 'crop'}
            <CropArea {asset} />
          {:else}
            <PhotoViewer
              bind:zoomToggle
              bind:copyImage
              {asset}
              {preloadAssets}
              onPreviousAsset={() => navigateAsset('previous')}
              onNextAsset={() => navigateAsset('next')}
              {sharedLink}
              haveFadeTransition={$slideshowState !== SlideshowState.None && $slideshowTransition}
            />
          {/if}
        {:else}
          <VideoViewer
            assetId={asset.id}
            cacheKey={asset.thumbhash}
            projectionType={asset.exifInfo?.projectionType}
            loopVideo={$slideshowState !== SlideshowState.PlaySlideshow}
            onPreviousAsset={() => navigateAsset('previous')}
            onNextAsset={() => navigateAsset('next')}
            onClose={closeViewer}
            onVideoEnded={() => navigateAsset()}
            onVideoStarted={handleVideoStarted}
            {playOriginalVideo}
          />
        {/if}

        {#if $slideshowState === SlideshowState.None && isShared && ((album && album.isActivityEnabled) || activityManager.commentCount > 0) && !activityManager.isLoading}
          <div class="absolute bottom-0 end-0 mb-20 me-8">
            <ActivityStatus
              disabled={!album?.isActivityEnabled}
              isLiked={activityManager.isLiked}
              numberOfComments={activityManager.commentCount}
              numberOfLikes={activityManager.likeCount}
              onFavorite={handleFavorite}
              onOpenActivityTab={handleOpenActivity}
            />
          </div>
        {/if}

        {#if $slideshowState === SlideshowState.None && asset.type === AssetTypeEnum.Image && !isShowEditor && ocrManager.hasOcrData}
          <div class="absolute bottom-0 end-0 mb-6 me-6">
            <OcrButton />
          </div>
        {/if}
      {/key}
    {/if}
  </div>

  {#if $slideshowState === SlideshowState.None && showNavigation && !isShowEditor}
    <div class="my-auto col-span-1 col-start-4 row-span-full row-start-1 justify-self-end">
      <NextAssetAction onNextAsset={() => navigateAsset('next')} />
    </div>
  {/if}

  {#if enableDetailPanel && $slideshowState === SlideshowState.None && $isShowDetail && !isShowEditor}
    <div
      transition:fly={{ duration: 150 }}
      id="detail-panel"
      class="row-start-1 row-span-4 w-[360px] overflow-y-auto transition-all dark:border-l dark:border-s-immich-dark-gray bg-light"
      translate="yes"
    >
      <DetailPanel {asset} currentAlbum={album} albums={appearsInAlbums} onClose={() => ($isShowDetail = false)} />
    </div>
  {/if}

  {#if isShowEditor}
    <div
      transition:fly={{ duration: 150 }}
      id="editor-panel"
      class="row-start-1 row-span-4 w-[400px] overflow-y-auto transition-all dark:border-l dark:border-s-immich-dark-gray"
      translate="yes"
    >
      <EditorPanel {asset} onUpdateSelectedType={handleUpdateSelectedEditType} onClose={closeEditor} />
    </div>
  {/if}

  {#if stack && withStacked}
    {@const stackedAssets = stack.assets}
    <div id="stack-slideshow" class="absolute bottom-0 w-full col-span-4 col-start-1">
      <div class="relative flex flex-row no-wrap overflow-x-auto overflow-y-hidden horizontal-scrollbar">
        {#each stackedAssets as stackedAsset (stackedAsset.id)}
          <div
            class={['inline-block px-1 relative transition-all pb-2']}
            style:bottom={stackedAsset.id === asset.id ? '0' : '-10px'}
          >
            <Thumbnail
              imageClass={{ 'border-2 border-white': stackedAsset.id === asset.id }}
              brokenAssetClass="text-xs"
              dimmed={stackedAsset.id !== asset.id}
              asset={toTimelineAsset(stackedAsset)}
              onClick={() => {
                asset = stackedAsset;
                previewStackedAsset = undefined;
              }}
              onMouseEvent={({ isMouseOver }) => handleStackedAssetMouseEvent(isMouseOver, stackedAsset)}
              readonly
              thumbnailSize={stackedAsset.id === asset.id ? stackSelectedThumbnailSize : stackThumbnailSize}
              showStackedIcon={false}
              disableLinkMouseOver
            />

            {#if stackedAsset.id === asset.id}
              <div class="w-full flex place-items-center place-content-center">
                <div class="w-2 h-2 bg-white rounded-full flex mt-0.5"></div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if isShared && album && isShowActivity && $user}
    <div
      transition:fly={{ duration: 150 }}
      id="activity-panel"
      class="row-start-1 row-span-5 w-[360px] md:w-[460px] overflow-y-auto transition-all dark:border-l dark:border-s-immich-dark-gray"
      translate="yes"
    >
      <ActivityViewer
        user={$user}
        disabled={!album.isActivityEnabled}
        assetType={asset.type}
        albumOwnerId={album.ownerId}
        albumId={album.id}
        assetId={asset.id}
        onClose={() => (isShowActivity = false)}
      />
    </div>
  {/if}
</section>

<style>
  #immich-asset-viewer {
    contain: layout;
  }

  .horizontal-scrollbar::-webkit-scrollbar {
    width: 8px;
    height: 10px;
  }

  /* Track */
  .horizontal-scrollbar::-webkit-scrollbar-track {
    background: #000000;
    border-radius: 16px;
  }

  /* Handle */
  .horizontal-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(159, 159, 159, 0.408);
    border-radius: 16px;
  }

  /* Handle on hover */
  .horizontal-scrollbar::-webkit-scrollbar-thumb:hover {
    background: #adcbfa;
    border-radius: 16px;
  }
</style>
