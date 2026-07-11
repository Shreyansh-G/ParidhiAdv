/**
 * Geofence Detection Service — real dataset + spatial-grid index.
 *
 * Previously this file checked a hardcoded list of 6 placeholder projects, so
 * geofence notifications never matched anything on the map. It now runs
 * against the full merged dataset (curated + live OSM) and uses the uniform
 * grid index, so each location tick only inspects the user's 3×3 cell
 * neighborhood instead of scanning every project.
 */

import { enhancedProjects } from '../data/projectsEnhanced'
import { buildSpatialIndex, type SpatialIndex } from './spatialIndex'

const GEOFENCE_RADIUS_METERS = 150
// Query slightly beyond the fence so EXIT events resolve while still indexed
const QUERY_RADIUS_KM = 0.6

// Haversine formula to calculate distance between two coordinates
function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in kilometers
}

// Convert km to meters
export function getDistanceInMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  return calculateHaversineDistance(lat1, lon1, lat2, lon2) * 1000;
}

// Module-level index over the bundled dataset (built once; ~O(n) setup)
let index: SpatialIndex | null = null
function getIndex(): SpatialIndex {
  if (!index) index = buildSpatialIndex(enhancedProjects)
  return index
}

export interface GeofenceStatus {
  projectId: string;
  projectName: string;
  isInside: boolean;
  distanceMeters: number;
  radius: number;
}

/**
 * Geofence statuses for all projects near the user (grid-index lookup —
 * constant-time in dataset size).
 */
export function checkAllGeofences(
  userLat: number,
  userLon: number
): GeofenceStatus[] {
  return getIndex()
    .queryNearby(userLat, userLon, QUERY_RADIUS_KM)
    .map((project) => {
      const distanceMeters = getDistanceInMeters(userLat, userLon, project.lat, project.lng)
      return {
        projectId: project.id,
        projectName: project.name,
        isInside: distanceMeters <= GEOFENCE_RADIUS_METERS,
        distanceMeters,
        radius: GEOFENCE_RADIUS_METERS,
      }
    })
}

/**
 * Detect geofence entry/exit events
 */
export interface GeofenceEvent {
  type: 'ENTER' | 'EXIT';
  projectId: string;
  projectName: string;
  timestamp: Date;
  location: { lat: number; lon: number };
}

export class GeofenceEventDetector {
  private previousStatus: Map<string, { name: string; isInside: boolean }> = new Map();

  /**
   * Check for entry/exit events
   * Returns array of events that occurred
   */
  detectEvents(userLat: number, userLon: number): GeofenceEvent[] {
    const events: GeofenceEvent[] = [];
    const currentStatuses = checkAllGeofences(userLat, userLon);
    const seen = new Set<string>();

    for (const status of currentStatuses) {
      seen.add(status.projectId);
      const wasInside = this.previousStatus.get(status.projectId)?.isInside ?? false;
      const isInside = status.isInside;

      if (!wasInside && isInside) {
        events.push({
          type: 'ENTER',
          projectId: status.projectId,
          projectName: status.projectName,
          timestamp: new Date(),
          location: { lat: userLat, lon: userLon }
        });
      }

      if (wasInside && !isInside) {
        events.push({
          type: 'EXIT',
          projectId: status.projectId,
          projectName: status.projectName,
          timestamp: new Date(),
          location: { lat: userLat, lon: userLon }
        });
      }

      this.previousStatus.set(status.projectId, { name: status.projectName, isInside });
    }

    // Projects we were inside that dropped out of the query radius entirely
    // (user moved far away fast) still need their EXIT event.
    for (const [projectId, prev] of this.previousStatus) {
      if (prev.isInside && !seen.has(projectId)) {
        events.push({
          type: 'EXIT',
          projectId,
          projectName: prev.name,
          timestamp: new Date(),
          location: { lat: userLat, lon: userLon }
        });
        this.previousStatus.set(projectId, { ...prev, isInside: false });
      }
    }

    return events;
  }

  /**
   * Reset detector (useful when user signs in/out)
   */
  reset(): void {
    this.previousStatus.clear();
  }
}
