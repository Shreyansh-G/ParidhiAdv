// GPS signal conditioning + anti-cheat.
//
// Raw geolocation fixes jitter by tens of meters, which causes phantom
// geofence ENTER/EXIT events, and nothing stops a user from "exploring"
// half the city from a car window. Three measures:
//
//  1. Accuracy gate    — fixes worse than 100 m are discarded outright.
//  2. EMA smoothing    — exponential moving average whose weight scales with
//                        fix accuracy (precise fix → trust it more).
//  3. Speed estimation — haversine speed over recent fixes; above 25 km/h the
//                        user is in a vehicle and auto-explore is suppressed.

import { calculateDistance } from '../data/projectsEnhanced'

const MAX_ACCURACY_M = 100
const VEHICLE_SPEED_KMH = 25
const MIN_ALPHA = 0.25 // smoothing weight for a poor (but accepted) fix
const MAX_ALPHA = 0.85 // smoothing weight for a very precise fix

export interface FilteredFix {
  lat: number
  lng: number
  speedKmh: number
  isVehicleSpeed: boolean
  accepted: boolean
}

interface RawFix {
  lat: number
  lng: number
  timeMs: number
}

export class LocationFilter {
  private smoothed: { lat: number; lng: number } | null = null
  private lastRaw: RawFix | null = null
  private speedKmh = 0

  /**
   * Feed a raw geolocation fix; returns the smoothed position + motion state.
   * When `accepted` is false the fix failed the accuracy gate and the previous
   * smoothed position is returned unchanged.
   */
  update(position: GeolocationPosition): FilteredFix {
    const { latitude: lat, longitude: lng, accuracy } = position.coords
    const timeMs = position.timestamp || Date.now()

    if (typeof accuracy === 'number' && accuracy > MAX_ACCURACY_M) {
      return this.current(false)
    }

    // Speed from device if provided (m/s), else derived from consecutive fixes
    if (typeof position.coords.speed === 'number' && position.coords.speed >= 0) {
      this.speedKmh = position.coords.speed * 3.6
    } else if (this.lastRaw) {
      const dtHours = (timeMs - this.lastRaw.timeMs) / 3_600_000
      if (dtHours > 0.0002) {
        // ≥ ~0.7 s apart — short gaps make speed estimates explode
        const km = calculateDistance(this.lastRaw.lat, this.lastRaw.lng, lat, lng)
        this.speedKmh = km / dtHours
      }
    }
    this.lastRaw = { lat, lng, timeMs }

    // Accuracy-weighted EMA: alpha interpolated between MIN and MAX as
    // accuracy goes from the gate limit down to 5 m.
    const acc = typeof accuracy === 'number' ? accuracy : MAX_ACCURACY_M
    const t = Math.min(1, Math.max(0, (MAX_ACCURACY_M - acc) / (MAX_ACCURACY_M - 5)))
    const alpha = MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * t

    if (!this.smoothed) {
      this.smoothed = { lat, lng }
    } else {
      this.smoothed = {
        lat: this.smoothed.lat + alpha * (lat - this.smoothed.lat),
        lng: this.smoothed.lng + alpha * (lng - this.smoothed.lng),
      }
    }

    return this.current(true)
  }

  private current(accepted: boolean): FilteredFix {
    return {
      lat: this.smoothed?.lat ?? this.lastRaw?.lat ?? 0,
      lng: this.smoothed?.lng ?? this.lastRaw?.lng ?? 0,
      speedKmh: this.speedKmh,
      isVehicleSpeed: this.speedKmh > VEHICLE_SPEED_KMH,
      accepted: accepted && this.smoothed !== null,
    }
  }

  reset(): void {
    this.smoothed = null
    this.lastRaw = null
    this.speedKmh = 0
  }
}
