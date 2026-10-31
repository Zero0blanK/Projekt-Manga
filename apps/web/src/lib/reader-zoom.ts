'use client';

import { useCallback, useState } from 'react';

/** Reader zoom limits, shared by the zoom buttons, keys, the wheel and double-click. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.25;
/** What a double-click zooms to from the fitted page. */
export const DOUBLE_CLICK_ZOOM = 2;

export const clampZoom = (zoom: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));

export function useReaderZoom() {
  const [zoom, setZoomState] = useState(1);
  const setZoom = useCallback((next: number) => setZoomState(clampZoom(next)), []);
  const zoomIn = useCallback(() => setZoomState((z) => clampZoom(z + ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoomState((z) => clampZoom(z - ZOOM_STEP)), []);
  const zoomReset = useCallback(() => setZoomState(1), []);
  return { zoom, setZoom, zoomIn, zoomOut, zoomReset };
}
