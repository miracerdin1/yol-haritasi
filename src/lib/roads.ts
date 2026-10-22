import type { BBox } from "./geo";
import type { TollData } from "./cost";
import type { Anchor } from "./planner";
import { anchorsFromWays } from "./planner";
import type { LatLng } from "./geo";
import { cumulative, pointAlong, resample } from "./geo";

export interface RoadDef {
  id: string;
  label: string;
  /** Levhada görünen kısa etiket */
  tag: string;
  note: string;
  /** Overpass sorgu gövdesi (tek ya da birden çok `way[...]` satırı) */
  query: string;
  /** Köprü/viyadük parçalarını kesme dışı bırak (altından geçen yolları engellememek için) */
  skipBridges: boolean;
  /** skipBridges açıkken yine de kesilecek köprü adları */
  keepBridgeNames?: RegExp;
  custom?: boolean;
}

// Sorgular 26 Eylül 2026'da OpenStreetMap verisinde denendi:
// O-7 → 692 yol parçası (Kınalı – Akyazı, Çamlık/Ümraniye bağlantısı dahil).
export const PRESET_ROADS: RoadDef[] = [
  {
    id: "kmo",
    label: "Kuzey Marmara Otoyolu",
    tag: "O-7",
    note: "Yavuz Sultan Selim Köprüsü ve Ümraniye–Nişantepe bağlantısı dahil",
    query: 'way["highway"="motorway"]["ref"="O-7"](40.3,27.9,41.4,30.9);',
    skipBridges: true,
    keepBridgeNames: /Yavuz Sultan Selim/,
  },
  {
    id: "avrasya",
    label: "Avrasya Tüneli",
    tag: "TÜNEL",
    note: "Kazlıçeşme – Göztepe",
    query:
      'way["highway"="trunk"]["name"="Avrasya Tüneli"](40.95,28.9,41.05,29.1);',
    skipBridges: false,
  },
  {
    id: "osmangazi",
    label: "Osmangazi Köprüsü",
    tag: "O-5",
    note: "Bursa, İzmir yönü; kapalıyken körfez etrafından dolaşır",
    query:
      'way["highway"="motorway"]["name"="Osmangazi Köprüsü"](40.5,29.2,41.0,29.8);',
    skipBridges: false,
  },
  {
    id: "canakkale",
    label: "1915 Çanakkale Köprüsü",
    tag: "O-6",
    note: "Kapalıyken feribot ya da Gelibolu üzerinden",
    query:
      'way["highway"="motorway"]["name"="1915 Çanakkale Köprüsü"](40.1,26.4,40.6,26.9);',
    skipBridges: false,
  },
];

/** Kullanıcının eklediği yol: OSM "ref" (ör. O-6) ya da tam ad (ör. "Fatih Sultan Mehmet Köprüsü"). */
export function customRoad(input: string): RoadDef {
  const v = input.trim();
  const isRef = /^[A-ZÇĞİÖŞÜ]{1,3}-?\s?\d{1,4}$/i.test(v);
  const esc = v.replace(/"/g, '\\"');
  const tr = "(35.8,25.6,42.2,44.9)";
  const query = isRef
    ? `way["highway"="motorway"]["ref"="${esc.toUpperCase().replace(/\s/g, "")}"]${tr};`
    : `way["highway"~"^(motorway|trunk|primary)$"]["name"="${esc}"]${tr};`;
  return {
    id: "c:" + v.toLowerCase(),
    label: v,
    tag: isRef ? v.toUpperCase() : "YOL",
    note: isRef ? "Otoyol numarasıyla eklendi" : "Yol adıyla eklendi",
    query,
    skipBridges: isRef,
    custom: true,
  };
}

export interface RoadData {
  id: string;
  /** Rota motorunun bu yolu kullanmasını engelleyen kesim noktaları */
  cuts: LatLng[];
  /** Yakınlık hesabı için ~300 m aralıklı örnek noktalar */
  samples: LatLng[];
  /** Haritada çizmek için sadeleştirilmiş parçalar */
  lines: LatLng[][];
  fetchedAt: number;
  wayCount: number;
}

interface OverpassWay {
  type: "way";
  id: number;
  nodes?: number[];
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
interface OverpassNode {
  type: "node";
  id: number;
}
export interface OverpassResult {
  ways: OverpassWay[];
  /** Yolun başka bir yola (bağlantı kolu, kavşak) bağlandığı düğümler */
  junctions: Set<number>;
}

export const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Tarayıcı User-Agent'ı kendisi koyar; Node'da (Netlify derlemesi) tanımlı bir UA olmadan
// bazı Overpass sunucuları isteği reddediyor.
const HEADERS: Record<string, string> =
  typeof window === "undefined"
    ? {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "yol-haritasi/1.0 (+https://github.com/miracerdin1/rota-pusulasi)",
      }
    : { "Content-Type": "application/x-www-form-urlencoded" };

/**
 * Overpass sunucuları bazen isteği kabul edip dakikalarca bekletiyor. Bu yüzden sunuculara
 * sırayla değil "kademeli yarış" ile gidilir: ilk sunucu `hedgeMs` içinde cevap vermezse
 * ikincisine de istek atılır, ilk geçerli cevap kazanır, diğerleri iptal edilir.
 */
export async function overpassFetch<T>(
  data: string,
  {
    hedgeMs = 7000,
    timeoutMs = 60000,
  }: { hedgeMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const ctrls = ENDPOINTS.map(() => new AbortController());
  const errors: unknown[] = [];
  try {
    return await new Promise<T>((resolve, reject) => {
      let pending = ENDPOINTS.length;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = () => timers.forEach(clearTimeout);
      ENDPOINTS.forEach((ep, i) => {
        timers.push(
          setTimeout(async () => {
            const kill = setTimeout(() => ctrls[i].abort(), timeoutMs);
            try {
              const res = await fetch(ep, {
                method: "POST",
                body: "data=" + encodeURIComponent(data),
                headers: HEADERS,
                signal: ctrls[i].signal,
              });
              const text = await res.text();
              if (!res.ok || text[0] !== "{")
                throw new Error(`${ep} → ${res.status}`);
              finish();
              resolve(JSON.parse(text) as T);
            } catch (err) {
              errors.push(err);
              if (--pending === 0) reject(errors);
            } finally {
              clearTimeout(kill);
            }
          }, i * hedgeMs),
        );
      });
    });
  } finally {
    ctrls.forEach((c) => c.abort());
  }
}

export async function overpass(body: string): Promise<OverpassResult> {
  // Yolun parçaları + başka yolların bağlandığı düğümler (kavşak noktaları)
  const data =
    `[out:json][timeout:90];(${body})->.k;.k out body geom;` +
    'node(w.k)->.kn;way(bn.kn)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)(_link)?$"]->.a;(.a; - .k;)->.o;node(w.o)->.on;node.kn.on;out ids;';
  try {
    const j = await overpassFetch<{ elements: (OverpassWay | OverpassNode)[] }>(
      data,
    );
    const els = j.elements;
    return {
      ways: els.filter(
        (e): e is OverpassWay => e.type === "way" && !!e.geometry && !!e.nodes,
      ),
      junctions: new Set(els.filter((e) => e.type === "node").map((e) => e.id)),
    };
  } catch (err) {
    console.warn("Overpass hatası", err);
    throw new Error(
      "Yol verisi alınamadı, OpenStreetMap sunucuları meşgul. Biraz sonra tekrar deneyin.",
    );
  }
}

/** Bu uzunluktan kısa kesimler (kavşak içi kısa parçalar) kesilmez. */
const MIN_STRETCH = 800;

interface Segment {
  from: number;
  to: number;
  line: LatLng[];
  len: number;
  cuttable: boolean;
}

/**
 * Yol parçalarını kavşak düğümlerinde böler, aradaki parçaları "kesim"lere (stretch) birleştirir
 * ve her kesime tek bir kesim noktası koyar. Böylece rota motoru yolun hiçbir kavşak arasını
 * kullanamaz, istek de küçük kalır.
 */
export function processWays(
  def: RoadDef,
  { ways, junctions }: OverpassResult,
): RoadData {
  const samples: LatLng[] = [];
  const lines: LatLng[][] = [];
  const segs: Segment[] = [];

  for (const w of ways) {
    const line: LatLng[] = w.geometry!.map((g) => [g.lat, g.lon]);
    const nodes = w.nodes!;
    if (line.length < 2 || nodes.length !== line.length) continue;
    lines.push(resample(line, 250));
    samples.push(...resample(line, 300));
    const tags = w.tags ?? {};
    const bridge = !!tags.bridge && tags.bridge !== "no";
    const cuttable = !(
      bridge &&
      def.skipBridges &&
      !(def.keepBridgeNames && def.keepBridgeNames.test(tags.name ?? ""))
    );
    let a = 0;
    for (let i = 1; i < nodes.length; i++) {
      if (i === nodes.length - 1 || junctions.has(nodes[i])) {
        const part = line.slice(a, i + 1);
        const cum = cumulative(part);
        segs.push({
          from: nodes[a],
          to: nodes[i],
          line: part,
          len: cum[cum.length - 1],
          cuttable,
        });
        a = i;
      }
    }
  }

  // Kavşak olmayan ve tek giriş/tek çıkışlı düğümlerde parçaları birleştir (union-find).
  const outs = new Map<number, number[]>();
  const ins = new Map<number, number[]>();
  segs.forEach((s, i) => {
    outs.set(s.from, [...(outs.get(s.from) ?? []), i]);
    ins.set(s.to, [...(ins.get(s.to) ?? []), i]);
  });
  const parent = segs.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (const [node, incoming] of ins) {
    const outgoing = outs.get(node) ?? [];
    if (junctions.has(node) || incoming.length !== 1 || outgoing.length !== 1)
      continue;
    parent[find(incoming[0])] = find(outgoing[0]);
  }
  const groups = new Map<number, Segment[]>();
  segs.forEach((s, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), s]);
  });

  const cuts: LatLng[] = [];
  const onlyGroup = groups.size <= 2; // tek köprü/tünel gibi kısa yollar: uzunluk sınırı yok
  for (const g of groups.values()) {
    const total = g.reduce((t, s) => t + s.len, 0);
    if (total < MIN_STRETCH && !onlyGroup) continue;
    const pool = g.filter((s) => s.cuttable);
    const best = (pool.length ? pool : g).reduce((x, y) =>
      y.len > x.len ? y : x,
    );
    cuts.push(pointAlong(best.line, cumulative(best.line), best.len / 2));
  }
  return {
    id: def.id,
    cuts,
    samples,
    lines,
    fetchedAt: Date.now(),
    wayCount: ways.length,
  };
}

const CACHE_VERSION = 2;
const CACHE_TTL = 1000 * 60 * 60 * 24 * 30;

function cacheKey(def: RoadDef) {
  return `rp:road:v${CACHE_VERSION}:${def.id}:${def.query}`;
}

// ---------- Derleme sırasında hazırlanan veri ----------
/** Netlify derlemesinde `npm run prefetch` ile üretilen dosya (public/data/prebuilt.json). */
export interface Prebuilt {
  generatedAt: number;
  roads: Record<string, RoadData & { query: string }>;
  anchors: { box: BBox; a: Anchor[] };
  /** Masraf hesabı için paralı otoyollar ve köprü/tüneller */
  tolls?: TollData;
}

let prebuiltPromise: Promise<Prebuilt | null> | null = null;
/** Siteyle birlikte gelen hazır veriyi bir kez indirir; yoksa (ör. dosyadan açıldıysa) null. */
export function loadPrebuilt(): Promise<Prebuilt | null> {
  prebuiltPromise ??= (async () => {
    try {
      const res = await fetch(new URL("data/prebuilt.json", document.baseURI));
      if (!res.ok) return null;
      return (await res.json()) as Prebuilt;
    } catch {
      return null;
    }
  })();
  return prebuiltPromise;
}

export async function loadRoad(def: RoadDef, force = false): Promise<RoadData> {
  const key = cacheKey(def);
  // Hazır yollar için siteyle gelen veri, tarayıcı önbelleğinden de tazedir.
  if (!force && !def.custom) {
    const pb = await loadPrebuilt();
    const d = pb?.roads[def.id];
    if (d && d.query === def.query && d.wayCount > 0) return d;
  }
  if (!force) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const d = JSON.parse(raw) as RoadData;
        if (Date.now() - d.fetchedAt < CACHE_TTL) return d;
      }
    } catch {
      /* önbellek okunamadı, yeniden indir */
    }
  }
  const data = processWays(def, await overpass(def.query));
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* depolama dolu olabilir; veri yine de kullanılır */
  }
  return data;
}

// ---------- Ara nokta adayları (kapalı olmayan otoyollar) ----------

export async function loadAnchors(box: BBox): Promise<Anchor[]> {
  const pb = await loadPrebuilt();
  if (pb) {
    const P = pb.anchors.box;
    if (box.s >= P.s && box.w >= P.w && box.n <= P.n && box.e <= P.e) {
      return pb.anchors.a.filter(
        (x) =>
          x.p[0] >= box.s &&
          x.p[0] <= box.n &&
          x.p[1] >= box.w &&
          x.p[1] <= box.e,
      );
    }
  }
  return fetchAnchors(box);
}

/** Kutu içindeki otoyollardan ara nokta adayları (Overpass'ten, tarayıcı önbellekli). */
export async function fetchAnchors(
  box: BBox,
  useCache = true,
): Promise<Anchor[]> {
  const r = (x: number) => Math.round(x * 10) / 10;
  const b = `${r(box.s)},${r(box.w)},${r(box.n)},${r(box.e)}`;
  const key = `rp:anchors:v1:${b}`;
  try {
    if (!useCache) throw 0;
    const raw = localStorage.getItem(key);
    if (raw) {
      const d = JSON.parse(raw) as { at: number; a: Anchor[] };
      if (Date.now() - d.at < CACHE_TTL) return d.a;
    }
  } catch {
    /* yeniden indir */
  }
  try {
    const j = await overpassFetch<{ elements: OverpassWay[] }>(
      `[out:json][timeout:90];way["highway"="motorway"](${b});out tags geom;`,
      { hedgeMs: 12000, timeoutMs: 90000 },
    );
    const ways = j.elements.filter((w) => w.geometry);
    const a = anchorsFromWays(
      ways as {
        geometry: { lat: number; lon: number }[];
        tags?: Record<string, string>;
      }[],
    ).map((x) => ({
      p: [+x.p[0].toFixed(6), +x.p[1].toFixed(6)] as LatLng,
      dir: [+x.dir[0].toFixed(3), +x.dir[1].toFixed(3)] as [number, number],
    }));
    try {
      if (useCache)
        localStorage.setItem(key, JSON.stringify({ at: Date.now(), a }));
    } catch {
      /* depolama dolu */
    }
    return a;
  } catch (err) {
    console.warn("Overpass hatası", err);
    throw new Error(
      "Otoyol verisi alınamadı, OpenStreetMap sunucuları meşgul. Biraz sonra tekrar deneyin.",
    );
  }
}

// ---------- Durak noktası temizliği ----------
/**
 * Google, durak koordinatını en yakın yola oturtur. Otoyolun hemen yanında bir yan yol,
 * bağlantı kolu ya da servis yolu varsa durak oraya düşebilir ve rota otoyoldan çıkar.
 * Her nokta için `radius` metre içinde otoyol dışında bir yol olup olmadığını kontrol eder.
 * Sunucuya ulaşılamazsa hepsini "temiz" sayar.
 */
export async function clearOfSideRoads(
  points: LatLng[],
  radius = 60,
): Promise<boolean[]> {
  if (!points.length) return [];
  const parts = points
    .map(
      (p) =>
        `way(around:${radius},${p[0].toFixed(6)},${p[1].toFixed(6)})["highway"]["highway"!="motorway"];`,
    )
    .join("");
  const data = `[out:json][timeout:60];(${parts});out geom;`;
  try {
    const j = await overpassFetch<{ elements: OverpassWay[] }>(data, {
      hedgeMs: 5000,
      timeoutMs: 20000,
    });
    const segs: [LatLng, LatLng][] = [];
    for (const w of j.elements) {
      const g = w.geometry;
      if (!g) continue;
      for (let i = 1; i < g.length; i++)
        segs.push([
          [g[i - 1].lat, g[i - 1].lon],
          [g[i].lat, g[i].lon],
        ]);
    }
    return points.map((p) =>
      segs.every(([a, b]) => distToSegment(p, a, b) > radius),
    );
  } catch {
    return points.map(() => true);
  }
}

function distToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = (a[1] - p[1]) * k,
    ay = a[0] - p[0];
  const bx = (b[1] - p[1]) * k,
    by = b[0] - p[0];
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) * 111320;
}
