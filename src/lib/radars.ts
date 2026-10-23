import { PointIndex, bboxOf, cumulative, resample } from './geo'
import type { LatLng } from './geo'
import { overpassFetch } from './roads'
import { MANUAL_SECTIONS } from './manualSections'

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
  /** Uç noktaları kesin değil (elle eklenmiş) */
  approx?: boolean
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

export interface Node {
  type?: 'node' | 'relation'
  lat: number
  lon: number
  tags?: Record<string, string>
  members?: Member[]
}

/** `b`: "güney,batı,kuzey,doğu". Radar düğümleri ve ortalama hız ilişkileri. */
export const radarQuery = (b: string) =>
  `[out:json][timeout:60];(node["highway"="speed_camera"](${b});rel["type"="enforcement"]["enforcement"="average_speed"](${b}););out geom;`

/** Siteyle gelen hazır radar verisi: derlemede `npm run prefetch` üretir. */
export interface RadarFile {
  generatedAt: number
  nodes: Node[]
}

/** Sadece kullandığımız alanlar kalsın, dosya küçük olsun. */
export function compactNode({ type, lat, lon, tags, members }: Node): Node {
  const t: Record<string, string> = {}
  if (tags?.maxspeed) t.maxspeed = tags.maxspeed
  if (tags?.enforcement) t.enforcement = tags.enforcement
  const n: Node = { type, lat, lon, tags: t }
  if (members) n.members = members
  return n
}

let embedded: Promise<Node[] | null> | null = null
/** Siteyle gelen radar verisini bir kez indirir; yoksa (ör. dosyadan açıldıysa) null. */
function loadEmbedded(): Promise<Node[] | null> {
  embedded ??= (async () => {
    try {
      const res = await fetch(new URL('data/radars.json', document.baseURI))
      if (!res.ok) return null
      const f = (await res.json()) as RadarFile
      return f.nodes?.length ? f.nodes : null
    } catch {
      return null
    }
  })()
  return embedded
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
        radarQuery(b),
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
  // Radarlar sabit: önce siteyle gelen veri, yoksa (ya da eskiyse) Overpass'ten canlı
  const nodes = (await loadEmbedded()) ?? (await loadNodes(b))
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
  for (const m of MANUAL_SECTIONS) {
    if (m.line.some((p) => idx.nearest(p, NEAR_M) <= NEAR_M)) sections.push(m)
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

/** Radarın önünde ve arkasında rotanın bu kadarı (metre) "radarlı yol" sayılır. */
const REACH_M = 1000
const STEP_M = 40

/** Rotanın radarlı kesimleri; üst üste binenler birleştirilir. */
export function radarStretches(route: LatLng[], radars: Radar[]): LatLng[][] {
  if (route.length < 2 || !radars.length) return []
  const pts = resample(route, STEP_M)
  const reach = Math.ceil(REACH_M / STEP_M)
  const spans: [number, number][] = radars.map((r) => {
    let best = 0
    let bd = Infinity
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - r.p[0], pts[i][1] - r.p[1])
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return [Math.max(0, best - reach), Math.min(pts.length - 1, best + reach)]
  })
  spans.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else merged.push([s[0], s[1]])
  }
  return merged.map(([a, b]) => pts.slice(a, b + 1))
}
