import { photoZoomState } from '$lib/stores/zoom-image.store';
import { useZoomImageWheel } from '@zoom-image/svelte';
import { get } from 'svelte/store';

export const zoomImageAction = (
  node: HTMLElement,
  options?: { disabled?: boolean; disableDoubleTapZoom?: boolean },
) => {
  const { createZoomImage, zoomImageState, setZoomImageState } = useZoomImageWheel();

  // Double-tap detection state — mirrors the library's own 300ms timer logic
  let lastSingleTouchTime = 0;
  const DOUBLE_TAP_THRESHOLD = 300;

  // Must be registered BEFORE createZoomImage so our capture handler fires first
  const touchStartHandler = (event: TouchEvent) => {
    if (!options?.disableDoubleTapZoom) return;
    if (event.touches.length !== 1) return;

    const now = Date.now();
    if (now - lastSingleTouchTime < DOUBLE_TAP_THRESHOLD) {
      // This is the second tap of a double-tap — block it from reaching the library
      event.stopImmediatePropagation();
      lastSingleTouchTime = 0;
    } else {
      lastSingleTouchTime = now;
    }
  };

  node.addEventListener('touchstart', touchStartHandler, { capture: true });

  createZoomImage(node, {
    maxZoom: 10,
  });

  const state = get(photoZoomState);
  if (state) {
    setZoomImageState(state);
  }

  // Store original event handlers so we can prevent them when disabled
  const wheelHandler = (event: WheelEvent) => {
    if (options?.disabled) {
      event.stopImmediatePropagation();
    }
  };

  const pointerDownHandler = (event: PointerEvent) => {
    if (options?.disabled) {
      event.stopImmediatePropagation();
    }
  };

  // Add handlers at capture phase with higher priority
  node.addEventListener('wheel', wheelHandler, { capture: true });
  node.addEventListener('pointerdown', pointerDownHandler, { capture: true });

  const unsubscribes = [photoZoomState.subscribe(setZoomImageState), zoomImageState.subscribe(photoZoomState.set)];

  return {
    update(newOptions?: { disabled?: boolean; disableDoubleTapZoom?: boolean }) {
      options = newOptions;
    },
    destroy() {
      node.removeEventListener('touchstart', touchStartHandler, { capture: true });
      node.removeEventListener('wheel', wheelHandler, { capture: true });
      node.removeEventListener('pointerdown', pointerDownHandler, { capture: true });
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    },
  };
};
