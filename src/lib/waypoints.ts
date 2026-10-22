import type { LatLng } from './geo'
import { PointIndex, cumulative, haversine } from './geo'

export interface Waypoint {
  point: LatLng
  /** Rota başından itibaren metre */
  along: number
  /** Kaçınılan en yakın yola uzaklık (m); elle eklenenlerde Infinity */
  nearAvoided: number
  manual?: boolean
  /** Zorunlu geçiş durağı (ör. Boğaz'da kullanılan köprü) */
  lock?: string
}

const HIGHWAY = 1
const TUNNEL = 64 // ORS waycategory: 1 otoyol, 2 ücretli, 4 merdiven, 8 feribot, 16 toprak, 32 patika, 64 tünel

/**
 * Önerilen rotada [lo, hi] (metre) aralığında, kapalı yollara en uzak otoyol noktası.
 * Nokta otoyolun tam üstünde olduğu için Google rotayı otoyoldan çıkarmaz; kapalı yoldan
 * uzak olduğu için de iki durak arasında kapalı yola sapmak kısa yol olmaktan çıkar.
 */
/**
 * "Kavşak kilidi": rota kapalı yola 3 km'den fazla yaklaştığı her yerde (bağlantı kavşakları),
 * yaklaşma bittikten hemen sonra, kapalı yoldan uzaklaşmış ilk otoyol noktasına durak koyar.
 * Böylece Google o kavşakta kapalı yola sapıp ileride geri dönemez.
 */
export function junctionLocks(
  line: LatLng[],
  waycategory: [number, number, number][],
  avoidedSamples: LatLng[],
  near = 3000,
  away = 3500,
  within = 12000,
  alternatives = 6,
): Waypoint[][] {
  const cat = new Uint8Array(line.length)
  for (const [a, b, v] of waycategory) for (let i = a; i <= b && i < line.length; i++) cat[i] = v
  const cum = cumulative(line)
  const idx = new PointIndex(avoidedSamples)
  const total = cum[cum.length - 1]
  const pts: { i: number; d: number }[] = []
  let next = 0
  for (let i = 0; i < line.length; i++) {
    if (cum[i] < next) continue
    next = cum[i] + 300
    pts.push({ i, d: idx.nearest(line[i], 6000) })
  }
  const out: Waypoint[][] = []
  for (let k = 1; k < pts.length; k++) {
    // Yaklaşmanın bittiği yer: önceki nokta yakın, bu nokta değil
    if (!(pts[k - 1].d < near && pts[k].d >= near)) continue
    const start = cum[pts[k].i]
    const alts: Waypoint[] = []
    for (let m = k; m < pts.length && cum[pts[m].i] - start <= within && alts.length < alternatives; m++) {
      const { i, d } = pts[m]
      if (d < away || total - cum[i] < 3000) continue
      if (!isSolidHighway(i, cat, cum, 400)) continue
      alts.push({ point: line[i], along: cum[i], nearAvoided: d })
    }
    if (alts.length && !out.some((g) => Math.abs(g[0].along - alts[0].along) < 3000)) out.push(alts)
  }
  return out
}

/** [lo, hi] aralığındaki durak adayları, kapalı yola uzaklığa göre azalan sırada. */
export function candidatesBetween(
  line: LatLng[],
  waycategory: [number, number, number][],
  avoidedSamples: LatLng[],
  lo: number,
  hi: number,
  edge = 2000,
  limit = 6,
): Waypoint[] {
  const cat = new Uint8Array(line.length)
  for (const [a, b, v] of waycategory) for (let i = a; i <= b && i < line.length; i++) cat[i] = v
  const cum = cumulative(line)
  const idx = new PointIndex(avoidedSamples)
  const all: Waypoint[] = []
  let next = 0
  for (let i = 0; i < line.length; i++) {
    if (cum[i] < next) continue
    next = cum[i] + 300
    if (cum[i] < lo + edge || cum[i] > hi - edge) continue
    if (!isSolidHighway(i, cat, cum, 400)) continue
    const d = Math.min(idx.nearest(line[i], 25000), 25000)
    if (d < 1500) continue
    all.push({ point: line[i], along: cum[i], nearAvoided: d })
  }
  all.sort((a, b) => b.nearAvoided - a.nearAvoided)
  // Birbirine çok yakın adayları ele (alternatifler farklı yerlerde olsun)
  const out: Waypoint[] = []
  for (const c of all) {
    if (out.some((o) => Math.abs(o.along - c.along) < 900)) continue
    out.push(c)
    if (out.length >= limit) break
  }
  return out
}

export function bestStopBetween(
  line: LatLng[],
  waycategory: [number, number, number][],
  avoidedSamples: LatLng[],
  lo: number,
  hi: number,
  edge = 2000,
): Waypoint | null {
  const cat = new Uint8Array(line.length)
  for (const [a, b, v] of waycategory) for (let i = a; i <= b && i < line.length; i++) cat[i] = v
  const cum = cumulative(line)
  const idx = new PointIndex(avoidedSamples)
  let best: Waypoint | null = null
  let next = 0
  for (let i = 0; i < line.length; i++) {
    if (cum[i] < next) continue
    next = cum[i] + 300
    if (cum[i] < lo + edge || cum[i] > hi - edge) continue
    if (!isSolidHighway(i, cat, cum, 400)) continue
    const d = Math.min(idx.nearest(line[i], 25000), 25000)
    if (d < 1500) continue
    if (!best || d > best.nearAvoided) best = { point: line[i], along: cum[i], nearAvoided: d }
  }
  return best
}

function isSolidHighway(i: number, cat: Uint8Array, cum: number[], margin: number): boolean {
  if (!(cat[i] & HIGHWAY) || cat[i] & TUNNEL) return false
  for (let j = i; j >= 0 && cum[i] - cum[j] <= margin; j--) if (!(cat[j] & HIGHWAY)) return false
  for (let j = i; j < cat.length && cum[j] - cum[i] <= margin; j++) if (!(cat[j] & HIGHWAY)) return false
  return true
}

/** Haritada dokunulan noktayı rotanın en yakın köşesine oturtur. */
export function snapToRoute(line: LatLng[], p: LatLng): Waypoint {
  const cum = cumulative(line)
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < line.length; i++) {
    const d = haversine(line[i], p)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return { point: line[best], along: cum[best], nearAvoided: Infinity, manual: true }
}

/**
 * Rota kaçınılan bir yolu kullanıyor mu? Örnek noktalar ~300 m aralıklı olduğundan
 * tek bir yakın nokta (üst/alt geçit) yetmez; en az `runM` boyunca yol üstünde kalmalı.
 */
export function touchesAvoided(line: LatLng[], avoidedSamples: LatLng[], runM = 3000): LatLng | null {
  if (!avoidedSamples.length) return null
  const idx = new PointIndex(avoidedSamples)
  const cum = cumulative(line)
  let next = 0
  let runStart = -1
  for (let i = 0; i < line.length; i++) {
    if (cum[i] < next) continue
    next = cum[i] + 100
    if (idx.nearest(line[i], 1000) < 170) {
      if (runStart < 0) runStart = cum[i]
      else if (cum[i] - runStart >= runM) return line[i]
    } else runStart = -1
  }
  return null
}
