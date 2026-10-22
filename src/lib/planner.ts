import type { LatLng } from "./geo";
import {
  bboxOf,
  cumulative,
  haversine,
  inBBox,
  PointIndex,
  resample,
} from "./geo";
import type { BBox } from "./geo";
import type { RouteResult } from "./ors";
import { route as orsRoute } from "./ors";
import type { RoadData } from "./roads";
import type { Waypoint } from "./waypoints";
import { candidatesBetween, junctionLocks, touchesAvoided } from "./waypoints";

/**
 * OpenRouteService, yasak bölgeli isteklerde rotayı ~150 km ile sınırlıyor.
 * Bu yüzden:
 *  1. Önce yasaksız rota alınır (uzunluk sınırı yok).
 *  2. Rotanın kapalı yolların çevresine (bölge) giren kısmı bulunur.
 *  3. Sadece o kısım, kapalı yollar kesilerek ve gerekirse otoyol üstündeki ara noktalarla
 *     ≤ LEG_MAX km'lik parçalara bölünerek yeniden hesaplanır.
 *  4. Parçalar yasaksız rotanın baş ve son kısmıyla birleştirilir.
 */
const LEG_MAX = 90000; // m, kuş uçuşu
const ZONE_MARGIN = 20000;
const EDGE_BACKOFF = 3000;

export interface Anchor {
  p: LatLng;
  /** Yol parçasının yön vektörü (normalize, [dLat, dLng]) */
  dir: [number, number];
}

export interface PlanInput {
  key: string;
  from: LatLng;
  to: LatLng;
  closed: RoadData[];
  loadAnchors: (box: BBox) => Promise<Anchor[]>;
  onStatus?: (s: string) => void;
}

export interface PlanResult extends RouteResult {
  /** Yeniden hesaplanan parça sayısı (0 = yasaksız rota zaten uygundu) */
  legs: number;
}

export async function planRoute(inp: PlanInput): Promise<PlanResult> {
  const { key, from, to, closed, onStatus } = inp;
  onStatus?.("Rota hesaplanıyor…");
  const base = await orsRoute(key, [from, to]);
  const samples = closed.flatMap((d) => d.samples);
  if (!samples.length) return { ...base, legs: 0 };

  const zone = bboxOf(samples, ZONE_MARGIN);
  const line = base.line;
  let i = line.findIndex((p) => inBBox(p, zone));
  if (i < 0) return { ...base, legs: 0 };
  let j = line.length - 1;
  while (j > i && !inBBox(line[j], zone)) j--;
  if (!touchesAvoided(line.slice(i, j + 1), samples, 1500))
    return { ...base, legs: 0 };

  // Bölgeye girmeden biraz önce ve çıktıktan biraz sonra bağlan.
  const cum = cumulative(line);
  const i0 = i;
  const j0 = j;
  while (i > 0 && cum[i0] - cum[i - 1] < EDGE_BACKOFF) i--;
  while (j < line.length - 1 && cum[j + 1] - cum[j0] < EDGE_BACKOFF) j++;
  const S = i === 0 ? from : line[i];
  const T = j === line.length - 1 ? to : line[j];

  onStatus?.("Otoyol ağı hazırlanıyor (ilk seferde 1 dakikayı bulabilir)…");
  const points = await splitLeg(S, T, samples, inp.loadAnchors, zone);

  const cuts = closed.flatMap((d) => d.cuts);
  const legs: RouteResult[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    onStatus?.(
      points.length > 2
        ? `Rota hesaplanıyor (${k + 1}/${points.length - 1})…`
        : "Rota hesaplanıyor…",
    );
    const box = bboxOf([points[k], points[k + 1]], 15000);
    const legCuts = cuts.filter((c) => inBBox(c, box));
    legs.push(await orsRoute(key, [points[k], points[k + 1]], legCuts));
  }

  // Birleştir: yasaksız rotanın başı + yeni parçalar + yasaksız rotanın sonu
  const head = i === 0 ? null : slice(base, cum, 0, i);
  const tail =
    j === line.length - 1 ? null : slice(base, cum, j, line.length - 1);
  const parts = [head, ...legs, tail].filter((x): x is RouteResult => !!x);
  return { ...concat(parts), legs: legs.length };
}

/** S→T'yi, uzun ise kapalı yollardan uzak otoyol noktalarıyla ≤ LEG_MAX parçalara böler. */
async function splitLeg(
  S: LatLng,
  T: LatLng,
  samples: LatLng[],
  loadAnchors: (box: BBox) => Promise<Anchor[]>,
  zone: BBox,
): Promise<LatLng[]> {
  if (haversine(S, T) <= LEG_MAX) return [S, T];
  const all = await loadAnchors(zone);
  const idx = new PointIndex(samples);
  const usable = all.filter((a) => idx.nearest(a.p, 3000) >= 3000);

  const rec = (a: LatLng, b: LatLng, depth: number): LatLng[] => {
    const d = haversine(a, b);
    if (d <= LEG_MAX || depth > 6) return [a, b];
    const mid: LatLng = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const len = Math.hypot(
      b[0] - a[0],
      (b[1] - a[1]) * Math.cos((mid[0] * Math.PI) / 180),
    );
    const ux = (b[0] - a[0]) / len;
    const uy = ((b[1] - a[1]) * Math.cos((mid[0] * Math.PI) / 180)) / len;
    let best: Anchor | null = null;
    let bestScore = Infinity;
    for (const c of usable) {
      if (c.dir[0] * ux + c.dir[1] * uy < 0.3) continue; // ters yöndeki şerit
      const da = haversine(a, c.p);
      const db = haversine(c.p, b);
      if (da >= d || db >= d) continue;
      const score = haversine(c.p, mid) + 0.5 * (da + db - d); // ortaya yakın ve sapma az
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) return [a, b];
    const left = rec(a, best.p, depth + 1);
    const right = rec(best.p, b, depth + 1);
    return [...left, ...right.slice(1)];
  };
  return rec(S, T, 0);
}

function slice(
  r: RouteResult,
  cum: number[],
  a: number,
  b: number,
): RouteResult {
  const total = cum[cum.length - 1] || 1;
  const frac = (cum[b] - cum[a]) / total;
  return {
    line: r.line.slice(a, b + 1),
    wayPoints: [0, b - a],
    distance: r.distance * frac,
    duration: r.duration * frac,
    waycategory: r.waycategory
      .filter(([s, e]) => e >= a && s <= b)
      .map(([s, e, v]) => [Math.max(s, a) - a, Math.min(e, b) - a, v]),
  };
}

function concat(parts: RouteResult[]): RouteResult {
  const out: RouteResult = {
    line: [],
    distance: 0,
    duration: 0,
    waycategory: [],
    wayPoints: [],
  };
  for (const p of parts) {
    const offset = out.line.length ? out.line.length - 1 : 0;
    out.line.push(...(out.line.length ? p.line.slice(1) : p.line));
    out.distance += p.distance;
    out.duration += p.duration;
    for (const [s, e, v] of p.waycategory)
      out.waycategory.push([s + offset, e + offset, v]);
  }
  out.wayPoints = [0, out.line.length - 1];
  return out;
}

/** Overpass way'lerinden otoyol ara noktası adayları üretir (köprü/tünel ve kısa parçalar hariç). */
export function anchorsFromWays(
  ways: {
    geometry: { lat: number; lon: number }[];
    tags?: Record<string, string>;
  }[],
): Anchor[] {
  const out: Anchor[] = [];
  for (const w of ways) {
    const t = w.tags ?? {};
    if ((t.bridge && t.bridge !== "no") || (t.tunnel && t.tunnel !== "no"))
      continue;
    const line: LatLng[] = w.geometry.map((g) => [g.lat, g.lon]);
    const cum = cumulative(line);
    if (cum[cum.length - 1] < 500) continue;
    // Yol üstündeki ~1 km aralıklı noktalar; yön, komşu noktalardan.
    const r = resample(line, Math.min(1000, cum[cum.length - 1] / 3));
    for (let k = 1; k < r.length - 1; k++) {
      const a = r[k - 1];
      const b = r[k + 1];
      const c = Math.cos((r[k][0] * Math.PI) / 180);
      const dx = b[0] - a[0];
      const dy = (b[1] - a[1]) * c;
      const n = Math.hypot(dx, dy) || 1;
      out.push({ p: r[k], dir: [dx / n, dy / n] });
    }
  }
  return out;
}

export interface StopFit {
  stops: Waypoint[];
  /** Google'ın (ORS ile taklit edilen) en hızlı rotası duraklarla kapalı yolları artık kullanmıyor mu */
  clean: boolean;
}

/**
 * Google Maps'in ne yapacağını, yasaksız ORS rotasıyla taklit eder:
 * duraklarla yasaksız rota hâlâ kapalı bir yola giriyorsa, o aralığa önerilen rotanın
 * kapalı yola en uzak otoyol noktasını durak olarak ekler ve tekrar dener.
 */
export async function fitGoogleStops(
  key: string,
  planned: RouteResult,
  closed: RoadData[],
  maxStops: number,
  onStatus?: (s: string) => void,
  isClear: (pts: LatLng[]) => Promise<boolean[]> = async (pts) =>
    pts.map(() => true),
  /** Her durumda konacak duraklar (Boğaz geçiş kilidi); sınırdan sayılır, çıkarılmaz */
  forced: Waypoint[] = [],
): Promise<StopFit> {
  const samples = closed.flatMap((d) => d.samples);
  if (!samples.length) return { stops: [], clean: true };
  const locks = forced.slice(0, maxStops);
  // Google, OpenRouteService'e göre pahalı otoyolları daha hızlı sayıyor; bu yüzden önce
  // kapalı yola paralel giden kesimi ~SEED_SPACING'de bir durakla sabitle, sonra taklitle kontrol et.
  onStatus?.("Duraklar seçiliyor…");
  const seeds = (
    await pickClear(seedStops(planned, samples, maxStops - locks.length), isClear)
  ).filter((s) => !locks.some((l) => Math.abs(l.along - s.along) < 3000));
  const stops: Waypoint[] = [...locks, ...seeds].sort(
    (a, b) => a.along - b.along,
  );
  const from = planned.line[0];
  const to = planned.line[planned.line.length - 1];
  const pcum = cumulative(planned.line);
  const total = pcum[pcum.length - 1];
  const onPlanned = new PointIndex(resample(planned.line, 150));
  const closedIdx = new PointIndex(samples);
  // Önerilen rotadaki bir noktanın rota başından uzaklığı (en yakın köşeye göre)
  const alongOf = (p: LatLng) => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < planned.line.length; i++) {
      const d = haversine(planned.line[i], p);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return pcum[bi];
  };

  const fixes = new Set<Waypoint>(locks);
  for (let iter = 0; iter <= maxStops + 3; iter++) {
    onStatus?.(`Google rotası kontrol ediliyor (${iter + 1})…`);
    const sim = await orsRoute(key, [from, ...stops.map((s) => s.point), to]);
    const wp = sim.wayPoints;
    let bad = -1;
    let touch = -1;
    for (let k = 0; k < wp.length - 1 && bad < 0; k++) {
      const hit = touchesAvoided(
        sim.line.slice(wp[k], wp[k + 1] + 1),
        samples,
        1500,
      );
      if (hit) {
        bad = k;
        touch = sim.line.indexOf(hit, wp[k]);
      }
    }
    if (bad < 0) return { stops, clean: true };
    // Taklit rotanın önerilen rotadan ayrıldığı ve geri döndüğü noktalar
    let div = touch;
    while (div > wp[bad] && onPlanned.nearest(sim.line[div], 400) > 150) div--;
    let join = touch;
    while (
      join < wp[bad + 1] &&
      (onPlanned.nearest(sim.line[join], 400) > 150 ||
        closedIdx.nearest(sim.line[join], 400) < 200)
    )
      join++;
    const segLo = bad === 0 ? 0 : stops[bad - 1].along;
    const segHi = bad === stops.length ? total : stops[bad].along;
    let lo = Math.max(segLo, alongOf(sim.line[div]));
    let hi = Math.min(segHi, alongOf(sim.line[join]));
    if (hi - lo < 4000) {
      lo = segLo;
      hi = segHi;
    }
    const [s] = await pickClear(
      [
        candidatesBetween(
          planned.line,
          planned.waycategory,
          samples,
          lo,
          hi,
          1000,
        ),
      ],
      isClear,
    );
    if (!s || stops.some((x) => Math.abs(x.along - s.along) < 1000)) break;
    stops.splice(bad, 0, s);
    fixes.add(s);
    // Sınır doluysa, taklidin gösterdiği bu durak için en az işe yarayan dolgu durağını çıkar:
    // kapalı yola en uzak olan (orada Google'ın sapma ihtimali en düşük) ve taklitle eklenmemiş olan.
    if (stops.length > maxStops) {
      let drop = -1;
      stops.forEach((x, i) => {
        if (fixes.has(x)) return;
        if (drop < 0 || x.nearAvoided > stops[drop].nearAvoided) drop = i;
      });
      if (drop < 0) {
        stops.splice(stops.indexOf(s), 1);
        break;
      }
      stops.splice(drop, 1);
    }
  }
  return { stops, clean: false };
}

const SEED_SPACING = 30000;
const PARALLEL_DIST = 20000;

/** Her grup için, yan yolu olmayan ilk adayı seçer (hiçbiri temiz değilse ilkini). */
async function pickClear(
  groups: Waypoint[][],
  isClear: (pts: LatLng[]) => Promise<boolean[]>,
): Promise<Waypoint[]> {
  const flat = groups.flat();
  const ok = await isClear(flat.map((w) => w.point));
  let k = 0;
  const out: Waypoint[] = [];
  for (const g of groups) {
    const flags = ok.slice(k, k + g.length);
    k += g.length;
    const free = (w: Waypoint) =>
      !out.some((o) => Math.abs(o.along - w.along) < 3000);
    const choice = g.find((w, i) => flags[i] && free(w)) ?? g.find(free);
    if (choice) out.push(choice);
  }
  return out.sort((a, b) => a.along - b.along);
}

/**
 * Başlangıç durak adayları: önce kavşak kilitleri, sonra kapalı yola paralel uzun kesimlerde
 * kilitler arasında SEED_SPACING'den uzun boşluk kalmayacak şekilde, kapalı yola en uzak noktalar.
 * Her durak için birkaç alternatif döner; yan yolu olmayan seçilir.
 */
function seedStops(
  planned: RouteResult,
  samples: LatLng[],
  max: number,
): Waypoint[][] {
  if (max <= 0) return [];
  const cum = cumulative(planned.line);
  const total = cum[cum.length - 1];
  const idx = new PointIndex(samples);
  let first = -1;
  let last = -1;
  let next = 0;
  for (let i = 0; i < planned.line.length; i++) {
    if (cum[i] < next) continue;
    next = cum[i] + 500;
    if (idx.nearest(planned.line[i], PARALLEL_DIST) <= PARALLEL_DIST) {
      if (first < 0) first = cum[i];
      last = cum[i];
    }
  }
  if (first < 0) return [];

  const locks = junctionLocks(planned.line, planned.waycategory, samples);
  const fills: Waypoint[][] = [];
  const marks = [
    first,
    ...locks.map((g) => g[0].along),
    Math.min(last, total),
  ].sort((a, b) => a - b);
  for (let k = 0; k < marks.length - 1; k++) {
    const lo = marks[k];
    const hi = marks[k + 1];
    const n = Math.floor((hi - lo) / SEED_SPACING);
    for (let j = 0; j < n; j++) {
      const a = lo + ((hi - lo) * j) / (n + 1);
      const b = lo + ((hi - lo) * (j + 2)) / (n + 1);
      const c = candidatesBetween(
        planned.line,
        planned.waycategory,
        samples,
        a,
        b,
        3000,
      );
      if (c.length) fills.push(c);
    }
  }
  // Sınırı aşarsa önce dolgu duraklarını at: başka bir durağa en yakın (en gereksiz) olandan başla
  while (locks.length + fills.length > max && fills.length) {
    const all = [...locks, ...fills].map((g) => g[0].along);
    let worst = 0;
    let worstNear = Infinity;
    fills.forEach((g, i) => {
      const at = g[0].along;
      const near = Math.min(
        ...all.filter((x) => x !== at).map((x) => Math.abs(x - at)),
        at,
        total - at,
      );
      if (near < worstNear) {
        worstNear = near;
        worst = i;
      }
    });
    fills.splice(worst, 1);
  }
  return [...locks, ...fills]
    .slice(0, max)
    .sort((a, b) => a[0].along - b[0].along);
}
