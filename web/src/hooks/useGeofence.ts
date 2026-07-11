import { useEffect, useCallback, useRef, useState } from 'react'
import { 
  GeofenceEventDetector, 
  checkAllGeofences, 
  type GeofenceEvent,
  type GeofenceStatus 
} from '../lib/geofenceService'

interface GeofenceHookConfig {
  enabled?: boolean;
  updateIntervalMs?: number;
  onGeofenceEvent?: (event: GeofenceEvent) => void;
  onStatusChange?: (statuses: GeofenceStatus[]) => void;
}

/**
 * Hook to monitor user location and detect geofence entry/exit events
 * 
 * Usage:
 * const { isMonitoring, currentGeofences } = useGeofence({
 *   enabled: true,
 *   updateIntervalMs: 5000, // Check every 5 seconds
 *   onGeofenceEvent: (event) => {
 *     if (event.type === 'ENTER') {
 *       console.log(`User entered ${event.projectName}`);
 *       // Send notification
 *     }
 *   }
 * });
 */
export function useGeofence(config: GeofenceHookConfig = {}) {
  const {
    enabled = true,
    onGeofenceEvent,
    onStatusChange
  } = config;

  // Lazy initializer: `useRef(new GeofenceEventDetector())` would construct a
  // detector on every render and discard all but the first.
  const [detector] = useState(() => new GeofenceEventDetector());
  const watchIdRef = useRef<number | null>(null);

  const handleLocationUpdate = useCallback((position: GeolocationPosition) => {
    const { latitude, longitude } = position.coords;

    // Check for geofence events
    const events = detector.detectEvents(latitude, longitude);

    // Emit events
    events.forEach(event => {
      onGeofenceEvent?.(event);
    });

    // Check current geofence statuses
    const statuses = checkAllGeofences(latitude, longitude);
    onStatusChange?.(statuses);
  }, [detector, onGeofenceEvent, onStatusChange]);

  const handleLocationError = useCallback((error: GeolocationPositionError) => {
    console.error('Geolocation error:', error.message);
  }, []);

  useEffect(() => {
    if (!enabled) {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    // Check if geolocation is available
    if (!('geolocation' in navigator)) {
      console.error('Geolocation not available in this browser');
      return;
    }

    // Watch user location
    watchIdRef.current = navigator.geolocation.watchPosition(
      handleLocationUpdate,
      handleLocationError,
      {
        enableHighAccuracy: true,
        maximumAge: 0, // Don't use cached location
        timeout: 10000 // 10 second timeout
      }
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [enabled, handleLocationUpdate, handleLocationError]);

  // Derived, not read off the ref. `watchIdRef` is only assigned inside the
  // effect, which runs AFTER render and never triggers one — so reading it here
  // reported `false` on first paint and then never corrected itself. The watch
  // is active exactly when it's enabled and the browser can geolocate, so say so.
  const isMonitoring =
    enabled && typeof navigator !== 'undefined' && 'geolocation' in navigator;

  return {
    isMonitoring,
    reset: () => detector.reset()
  };
}
