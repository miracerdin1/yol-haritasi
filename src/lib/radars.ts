import { PointIndex, bboxOf, cumulative, resample } from './geo'
import type { LatLng } from './geo'
import { overpassFetch } from './roads'

export interface Radar {
  p: LatLng
  /** Etiketteki hız sınırı (km/s), biliniyorsa */
  maxspeed?: number
  /** Ortalama hız (bölüm) ya da kırmızı ışık kamerası gibi türler */
  kind: 'hiz' | 'ortalama' | 'isik'
}

/** Rotaya bu kadar yakın radarlar gösterilir (metre). */
const NEAR_M = 60

/** Ortalama hız bölümü: iki kamera arasındaki yol kesimi. */
export interface Section {
  line: LatLng[]
  maxspeed?: number
  /** Bölüm uzunluğu (metre) */
  length: number
}

export interface RadarData {
  radars: Radar[]
  sections: Section[]
}

interface Member {
  type: 'node' | 'way'
  role: string
  lat?: number
  lon?: number
  geometry?: { lat: number; lon: number }[]
}

interface Node {
  type?: 'node' | 'relation'
  lat: number
  lon: number
  tags?: Record<string, string>
  members?: Member[]
}

const TTL = 1000 * 60 * 60 * 24 * 30
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Kutudaki radar düğümleri. Overpass meşgulse 3 kez, artan beklemeyle tekrar denenir;
 * hâlâ olmazsa (süresi geçmiş olsa bile) tarayıcıda kayıtlı son veri kullanılır.
 */
async function loadNodes(b: string): Promise<Node[]> {
  const key = `rp:radars:v2:${b}`
  let cached: { at: number; n: Node[] } | null = null
  try {
    const raw = localStorage.getItem(key)
    if (raw) cached = JSON.parse(raw)
  } catch {
    /* önbellek yok */
  }
  if (cached && Date.now() - cached.at < TTL) return cached.n
  let last: unknown
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(4000 * i)
    try {
      const j = await overpassFetch<{ elements: Node[] }>(
        `[out:json][timeout:60];(node["highway"="speed_camera"](${b});rel["type"="enforcement"]["enforcement"="average_speed"](${b}););out geom;`,
        { hedgeMs: 8000, timeoutMs: 60000 },
      )
      const n = j.elements.map(({ type, lat, lon, tags, members }) => ({ type, lat, lon, tags, members }))
      try {
        localStorage.setItem(key, JSON.stringify({ at: Date.now(), n }))
      } catch {
        /* depolama dolu */
      }
      return n
    } catch (err) {
      last = err
    }
  }
  if (cached) return cached.n
  throw last
}

/**
 * Rota boyunca OpenStreetMap'te `highway=speed_camera` olarak işaretli sabit radarlar.
 * Önce rotanın kutusundaki tüm radarlar indirilir, sonra rotaya NEAR_M içinde olanlar süzülür.
 */
export async function fetchRadars(line: LatLng[]): Promise<RadarData> {
  if (line.length < 2) return { radars: [], sections: [] }
  const box = bboxOf(line, 200)
  const b = `${box.s.toFixed(4)},${box.w.toFixed(4)},${box.n.toFixed(4)},${box.e.toFixed(4)}`
  const nodes = await loadNodes(b)
  const idx = new PointIndex(resample(line, 40))
  const radars: Radar[] = []
  const sections: Section[] = []
  for (const n of nodes) {
    const t = n.tags ?? {}
    const ms = parseInt(t.maxspeed ?? '', 10)
    const maxspeed = Number.isFinite(ms) ? ms : undefined
    if (n.type === 'relation') {
      const sec = sectionOf(n.members ?? [], maxspeed)
      if (sec && sec.line.some((p) => idx.nearest(p, NEAR_M) <= NEAR_M)) sections.push(sec)
      continue
    }
    if (n.lat == null || n.lon == null) continue
    const p: LatLng = [n.lat, n.lon]
    if (idx.nearest(p, NEAR_M) > NEAR_M) continue
    const enf = t.enforcement ?? ''
    radars.push({
      p,
      maxspeed,
      kind: enf === 'traffic_signals' ? 'isik' : enf === 'average_speed' ? 'ortalama' : 'hiz',
    })
  }
  return { radars, sections }
}

/** İlişkinin `section` yolları; yoksa `from` ile `to` kameraları arasına düz çizgi. */
function sectionOf(members: Member[], maxspeed?: number): Section | null {
  const ways = members
    .filter((m) => m.type === 'way' && m.geometry?.length)
    .map((m) => m.geometry!.map((g): LatLng => [g.lat, g.lon]))
  let pts: LatLng[] = []
  if (ways.length) {
    // Yolları uç uca sıralamaya çalışmadan, başlangıç kamerasına yakın uçtan başlatıp ekle
    const from = members.find((m) => m.type === 'node' && m.role === 'from')
    const rest = ways.slice()
    let cur = rest.shift()!
    if (from?.lat != null) {
      const f: LatLng = [from.lat, from.lon!]
      const d = (a: LatLng) => Math.hypot(a[0] - f[0], a[1] - f[1])
      if (d(cur[cur.length - 1]) < d(cur[0])) cur = cur.slice().reverse()
    }
    pts = cur.slice()
    while (rest.length) {
      const end = pts[pts.length - 1]
      const dist = (a: LatLng) => Math.hypot(a[0] - end[0], a[1] - end[1])
      rest.sort((x, y) => Math.min(dist(x[0]), dist(x[x.length - 1])) - Math.min(dist(y[0]), dist(y[y.length - 1])))
      let nxt = rest.shift()!
      if (dist(nxt[nxt.length - 1]) < dist(nxt[0])) nxt = nxt.slice().reverse()
      pts.push(...nxt)
    }
  } else {
    const f = members.find((m) => m.type === 'node' && m.role === 'from')
    const t = members.find((m) => m.type === 'node' && m.role === 'to')
    if (f?.lat == null || t?.lat == null) return null
    pts = [[f.lat, f.lon!], [t.lat, t.lon!]]
  }
  if (pts.length < 2) return null
  const cum = cumulative(pts)
  return { line: pts, maxspeed, length: cum[cum.length - 1] }
}
