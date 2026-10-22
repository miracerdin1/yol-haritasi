import type { LatLng } from "./geo";
import { PointIndex, haversine, resample } from "./geo";
import type { RouteResult } from "./ors";
import { overpassFetch } from "./roads";

// ---------- Tarife (otomobil, 1. sınıf) ----------
// Her Ocak ve Temmuz'da KGM/işletmeci zamlarından sonra güncellenmeli.
export const TARIFF_DATE = "Temmuz 2026";

interface Facility {
  id: string;
  /** OpenStreetMap'teki tam adı */
  osmName: string;
  label: string;
  price: number;
  note?: string;
}

/**
 * Köprü ve tüneller: sabit geçiş ücreti, iki yönde de alınır (KGM 2026 tarifeleri; 15 Temmuz ve
 * FSM 1 Ocak, diğerleri 1 Temmuz). KGM: "01.01.2022'den itibaren FSM ve 15 Temmuz Şehitler
 * Köprülerinden iki yönlü ücret alınmaktadır."
 * https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/Otoyollar/UcretlerYeni.aspx
 */
const FACILITIES: Facility[] = [
  {
    id: "15temmuz",
    osmName: "15 Temmuz Şehitler Köprüsü",
    label: "15 Temmuz Şehitler Köprüsü",
    price: 59,
  },
  {
    id: "fsm",
    osmName: "Fatih Sultan Mehmet Köprüsü",
    label: "Fatih Sultan Mehmet Köprüsü",
    price: 59,
  },
  {
    id: "yss",
    osmName: "Yavuz Sultan Selim Köprüsü",
    label: "Yavuz Sultan Selim Köprüsü",
    price: 110,
  },
  {
    id: "osmangazi",
    osmName: "Osmangazi Köprüsü",
    label: "Osmangazi Köprüsü",
    price: 1170,
  },
  {
    id: "canakkale",
    osmName: "1915 Çanakkale Köprüsü",
    label: "1915 Çanakkale Köprüsü",
    price: 1170,
  },
  {
    id: "avrasya",
    osmName: "Avrasya Tüneli",
    label: "Avrasya Tüneli",
    price: 330,
    note: "gündüz; gece 165 TL",
  },
];

interface TollRoad {
  label: string;
  /** Levhadaki numaralar */
  ref: string;
  /** TL/km */
  perKm: number;
  /** KGM otoyolu: kısa girişlerde gişe en az STATE_MIN alır */
  state?: boolean;
}

/**
 * Paralı otoyollar (otomobil), TL/km. Otoyollar gişeden gişeye ücretlendirilir; burada KGM'nin
 * 2026 tarife tablolarındaki tam parkur ücreti, aynı yolun bu uygulamanın ölçtüğü uzunluğuna
 * (OSRM rotası + bu dosyadaki sınıflandırma) bölündü. Köprü dahil tarifelerde köprü ücreti
 * düşüldü, köprü ayrıca sayılıyor.
 * https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/Otoyollar/UcretlerYeni.aspx
 *
 * Özel işletmeli (1 Temmuz 2026):
 *  O-7 Avrupa Kınalı–Odayeri 260 TL / 53 km · Kuzey Çevre Odayeri–Kurnaköy 520 − 110 (YSS) / 88 km
 *  O-7 Anadolu Kurnaköy–Akyazı 600 TL / 126 km
 *  O-5 Gebze–İzmir 1.170 (köprü) + 370 (→Bursa Kuzey) + 1.355 (Bursa Batı→İzmir) = 2.895 − 1.170 / 359 km
 *  O-6 Malkara–Çanakkale 1.480 − 1.170 / 65 km
 *  O-21 Ankara–Niğde 925 TL / 265 km · O-31 Aydın–Denizli 590 TL / 151 km
 *  O-33 Menemen–Çandarlı 240 TL / 51 km
 *
 * KGM (1 Ocak 2026, Temmuz'da değişmedi):
 *  O-3 Mahmutbey–Edirne 168 TL / 212 km · O-4 Çamlıca–Akıncı 338 TL / 380,7 km
 *  O-21 Niğde Güney–Mersin 184 TL / 182,5 km · O-31 Işıkkent–Aydın Batı 73 TL / 88,6 km (OSM; tablo 99,6)
 *  O-32 Seferihisar–Çeşme 53 TL / 56,3 km · O-53 Ceyhan–İskenderun 65 TL / 77 km
 *  O-52 Adana Doğu–Gaziantep Batı 102 TL / 157 km · Gaziantep Doğu–Şanlıurfa 102 TL / 120 km
 * Hesap özeti: docs/tarifeler/README.md
 */
const TOLL_ROADS: Record<string, TollRoad> = {
  "O-7A": { label: "Kuzey Marmara Otoyolu, Avrupa", ref: "O-7 / E-80", perKm: 4.9 },
  "O-7K": { label: "Kuzey Çevre Otoyolu", ref: "O-7 / E-80", perKm: 4.7 },
  "O-7D": { label: "Kuzey Marmara Otoyolu, Anadolu", ref: "O-7 / E-80", perKm: 4.8 },
  "O-5": { label: "İstanbul–İzmir Otoyolu", ref: "O-5 / E-881", perKm: 4.8 },
  "O-6": { label: "Malkara–Çanakkale Otoyolu", ref: "O-6 / E-87", perKm: 4.8 },
  "O-21": { label: "Ankara–Niğde Otoyolu", ref: "O-21 / E-90", perKm: 3.5 },
  "O-31": { label: "Aydın–Denizli Otoyolu", ref: "O-31 / E-87", perKm: 3.9 },
  "O-33": { label: "Kuzey Ege Otoyolu", ref: "O-33 / E-87", perKm: 4.7 },
  "O-3": { label: "Avrupa Otoyolu", ref: "O-3 / E-80", perKm: 0.79, state: true },
  "O-4": { label: "Anadolu Otoyolu", ref: "O-4 / E-80", perKm: 0.89, state: true },
  "O-21K": { label: "Niğde–Mersin Otoyolu", ref: "O-21 / E-90", perKm: 1.0, state: true },
  "O-31K": { label: "İzmir–Aydın Otoyolu", ref: "O-31 / E-87", perKm: 0.82, state: true },
  "O-32": { label: "İzmir–Çeşme Otoyolu", ref: "O-32 / E-881", perKm: 0.94, state: true },
  "O-52": { label: "Adana–Gaziantep Otoyolu", ref: "O-52 / E-90", perKm: 0.65, state: true },
  "O-52Ş": { label: "Gaziantep–Şanlıurfa Otoyolu", ref: "O-52 / E-90", perKm: 0.85, state: true },
  "O-53": { label: "Ceyhan–İskenderun Otoyolu", ref: "O-53 / E-91", perKm: 0.84, state: true },
};
/** Numarası bilinmeyen paralı yollar: KGM ortalaması */
const OTHER: TollRoad = { label: "Diğer paralı yollar", ref: "", perKm: 0.8, state: true };
const STATE_MIN = 40;
/** Bundan kısa kesintisiz KGM parçaları sayılmaz (gerçek bir gişe arası bu kadar kısa değil). */
const STATE_MIN_RUN = 3000;
/** Kavşaklarda özel otoyola değen kısa parçalar o otoyolu kullanmak değildir. */
const PRIVATE_MIN_RUN = 2000;

/** Boğaz köprülerine bağlanan paralı işaretli kısımlar; ücret köprüde alınır. */
const FREE = "free";

// ---------- Yakıt ----------
export type FuelType = "benzin" | "motorin" | "lpg";
export const FUEL_LABELS: Record<FuelType, string> = {
  benzin: "Benzin",
  motorin: "Motorin",
  lpg: "LPG",
};
/** Varsayılanlar: İstanbul, 19 Ekim 2026 pompa fiyatı ve ortalama binek araç tüketimi */
export const FUEL_DEFAULTS: Record<FuelType, { price: number; use: number }> = {
  benzin: { price: 83.9, use: 7 },
  motorin: { price: 96.7, use: 6 },
  lpg: { price: 41.2, use: 9 },
};

// ---------- Derleme sırasında hazırlanan veri ----------
export interface TollData {
  generatedAt: number;
  /** Paralı otoyollar (ve ücretsiz sayılan parçalar): TOLL_ROADS anahtarı → ~400 m aralıklı noktalar */
  roads: Record<string, LatLng[]>;
  /** Köprü/tünel → ~100 m aralıklı noktalar */
  facilities: Record<string, LatLng[]>;
}

const TR_BOX = "35.8,25.6,42.2,44.9";

/** Paralı bir otoyol parçasının hangi tarifeye girdiği; bilinmiyorsa null. */
function classify(tags: Record<string, string>, p: LatLng): string | null {
  const ref = (tags.ref ?? "")
    .split(";")[0]
    .replace(/\s/g, "")
    .toUpperCase()
    .replace(/^O(\d)/, "O-$1");
  const name = tags.name ?? "";
  const op = tags.operator ?? "";
  if (ref === "O-7" || /Kuzey Marmara/.test(name)) {
    // Üç ayrı tarife: Avrupa (Kınalı–Odayeri), Kuzey Çevre (Odayeri–YSS–Kurnaköy, Çamlık ve
    // Fenertepe bağlantıları dahil), Anadolu (Kurnaköy/İstanbulpark–Akyazı)
    if (p[1] < 28.78) return "O-7A";
    return p[0] < 40.96 ? "O-7D" : "O-7K";
  }
  if (ref === "O-33" || /Kuzey Ege/.test(name)) return "O-33";
  if (/Kırşehir Bağlantısı/.test(name)) return "O-21";
  // O-21'in Niğde'nin kuzeyi (Ankara–Niğde) özel, güneyi (Niğde–Pozantı–Tarsus) KGM
  if (ref === "O-21") return p[0] > 38.0 ? "O-21" : "O-21K";
  // O-31'in Aydın'ın doğusu (Aydın–Denizli) özel, batısı (İzmir–Aydın) KGM
  if (ref === "O-31") return p[1] > 27.85 || /Fernas/.test(op) ? "O-31" : "O-31K";
  // O-6'nın Malkara'nın doğusu (Kınalı–Malkara) 1915 tarifesinde yok
  if (ref === "O-6" && p[1] > 27.0) return null;
  // O-52 Gaziantep'in doğusu ayrı tarife (Gaziantep Doğu–Şanlıurfa)
  if (ref === "O-52" && p[1] > 37.4) return "O-52Ş";
  if (ref === "O-1" || ref === "O-2") return FREE;
  return ref in TOLL_ROADS ? ref : null;
}

const round = (p: LatLng): LatLng => [+p[0].toFixed(4), +p[1].toFixed(4)];

interface TollWay {
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/** Türkiye'deki paralı otoyollar ile köprü/tüneller için Overpass sorgusu. */
export function tollQuery(): string {
  const names = FACILITIES.map((f) => f.osmName).join("|");
  return (
    `[out:json][timeout:180];` +
    `way["highway"="motorway"]["toll"="yes"](${TR_BOX});out tags geom;` +
    `way["highway"~"^(motorway|trunk)$"]["name"~"^(${names})$"](${TR_BOX});out tags geom;`
  );
}

/** Paralı otoyolları ve köprü/tünelleri Overpass'ten indirir (npm run prefetch). */
export async function fetchTollData(): Promise<TollData> {
  const j = await overpassFetch<{ elements: TollWay[] }>(tollQuery(), {
    hedgeMs: 20000,
    timeoutMs: 180000,
  });
  return buildTollData(j.elements);
}

export function buildTollData(elements: TollWay[]): TollData {
  const roads: Record<string, LatLng[]> = {};
  const facilities: Record<string, LatLng[]> = {};
  for (const w of elements) {
    if (!w.geometry || w.geometry.length < 2) continue;
    const line: LatLng[] = w.geometry.map((g) => [g.lat, g.lon]);
    const tags = w.tags ?? {};
    const f = FACILITIES.find((x) => x.osmName === tags.name);
    if (f) {
      (facilities[f.id] ??= []).push(...resample(line, 100).map(round));
      continue;
    }
    const c = classify(tags, line[0]);
    if (c) (roads[c] ??= []).push(...resample(line, 400).map(round));
  }
  return { generatedAt: Date.now(), roads, facilities };
}

// ---------- Hesap ----------
export interface CostItem {
  label: string;
  detail: string;
  tl: number;
  /** Rota başından metre (sıralama için) */
  at: number;
}

export interface TollResult {
  items: CostItem[];
  total: number;
  /** Köprü/otoyol verisi yoktu; sadece paralı km, KGM tarifesiyle sayıldı */
  partial: boolean;
}

const TOLL = 2; // ORS waycategory: 2 = ücretli yol
const STEP = 50;

const kmText = (m: number) =>
  `${(m / 1000).toLocaleString("tr-TR", { maximumFractionDigits: m < 10000 ? 1 : 0 })} km`;

interface DensePoint {
  p: LatLng;
  len: number;
  /** Rota başından metre */
  at: number;
  toll: boolean;
}

/** Rotayı ~50 m'lik parçalara böler; her parça kendi uzunluğunu ve "paralı mı" bilgisini taşır. */
function densify(route: RouteResult): DensePoint[] {
  const { line } = route;
  const cat = new Uint8Array(Math.max(0, line.length - 1));
  for (const [a, b, v] of route.waycategory)
    for (let i = a; i < b && i < cat.length; i++) cat[i] = v;
  const pts: DensePoint[] = [];
  let at = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const d = haversine(line[i], line[i + 1]);
    const k = Math.max(1, Math.ceil(d / STEP));
    for (let s = 0; s < k; s++) {
      const t = (s + 0.5) / k;
      pts.push({
        p: [
          line[i][0] + (line[i + 1][0] - line[i][0]) * t,
          line[i][1] + (line[i + 1][1] - line[i][1]) * t,
        ],
        len: d / k,
        at: at + d * t,
        toll: !!(cat[i] & TOLL),
      });
    }
    at += d;
  }
  return pts;
}

interface Crossing {
  facility: Facility;
  /** Köprünün üstündeki ilk ve son nokta (densify indeksleri) */
  from: number;
  to: number;
}

/** Rotanın üstünden geçtiği köprü/tüneller, rota sırasıyla. */
function findCrossings(pts: DensePoint[], data: TollData | null): Crossing[] {
  const out: Crossing[] = [];
  for (const f of FACILITIES) {
    const samples = data?.facilities[f.id];
    if (!samples?.length) continue;
    const span = farthest(samples);
    const idx = new PointIndex(samples);
    // Köprünün üstünden geçen ardışık noktalar (arada birkaç kopukluğa izin vererek)
    let start = -1;
    let last = -1;
    let covered = 0;
    const flush = () => {
      if (start >= 0 && covered >= 0.6 * span)
        out.push({ facility: f, from: start, to: last });
      start = -1;
      covered = 0;
    };
    for (let i = 0; i < pts.length; i++) {
      if (idx.nearest(pts[i].p, 120) < 60) {
        if (start < 0) start = i;
        last = i;
        covered += pts[i].len;
      } else if (start >= 0 && i - last > 4) flush();
    }
    flush();
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Boğaz geçişleri: biri kapalıyken Google trafiğe göre diğerine kayabiliyor. */
const BOSPHORUS = ["15temmuz", "fsm", "yss", "avrasya"];
/** Hazır yol → içerdiği köprü/tünel */
const ROAD_FACILITY: Record<string, string> = {
  kmo: "yss",
  avrasya: "avrasya",
  osmangazi: "osmangazi",
  canakkale: "canakkale",
};

export interface CrossingLock {
  point: LatLng;
  along: number;
  label: string;
}

/**
 * Rota Boğaz'ı açık bir köprü/tünelden geçiyor ve başka bir Boğaz geçişi kapalıysa, geçilen
 * köprünün ortasına konacak durak. ORS trafiği bilmediği için taklit "durak gerekmiyor"
 * diyebiliyor; Google ise trafikte (ör. FSM yoğunken) kapalı köprüyü seçebiliyor. Köprü
 * suyun üstünde olduğundan Google durağı başka bir yola oturtamaz.
 */
export function crossingLocks(
  route: RouteResult,
  data: TollData | null,
  closedRoadIds: string[],
): CrossingLock[] {
  const closed = new Set(closedRoadIds.map((id) => ROAD_FACILITY[id]));
  if (!data || !BOSPHORUS.some((f) => closed.has(f))) return [];
  const pts = densify(route);
  return findCrossings(pts, data)
    .filter((c) => BOSPHORUS.includes(c.facility.id) && !closed.has(c.facility.id))
    .map((c) => {
      const k = Math.round((c.from + c.to) / 2);
      return { point: pts[k].p, along: pts[k].at, label: c.facility.label };
    });
}

/**
 * Rotanın köprü/tünel ve otoyol ücretlerini tahmin eder. Rota ~50 m'lik parçalara bölünür:
 * önce köprü/tünellerin üstünden geçen kısımlar sabit ücretle sayılır, kalan paralı kısımlar
 * yakın olduğu otoyolun km ücretiyle, hiçbirine yakın değilse KGM ortalamasıyla.
 */
export function tollCost(route: RouteResult, data: TollData | null): TollResult {
  const pts = densify(route);
  const items: CostItem[] = [];
  const used = new Uint8Array(pts.length);

  for (const { facility: f, from, to } of findCrossings(pts, data)) {
    for (let i = from; i <= to; i++) used[i] = 1;
    items.push({
      label: f.label,
      detail: f.note ?? "",
      tl: f.price,
      at: pts[from].at,
    });
  }

  const classes = Object.entries(data?.roads ?? {}).map(
    ([id, s]) => [id, new PointIndex(s)] as const,
  );
  // Her yolun kesintisiz parçaları; KGM'de her parça ayrı bir gişe girişi (en az ücret için)
  const runs = new Map<string, { m: number; at: number; end: number }[]>();
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i];
    if (!q.toll || used[i]) continue;
    let cls: string | null = null;
    let best = 250;
    for (const [id, idx] of classes) {
      const d = idx.nearest(q.p, best);
      if (d < best) {
        best = d;
        cls = id;
      }
    }
    if (cls === FREE) continue;
    const id = cls ?? "";
    const list = runs.get(id) ?? [];
    const last = list[list.length - 1];
    // Viyadük/tünellerdeki kısa paralı işaret kopuklukları aynı yolculuk sayılır
    if (last && q.at - last.end <= 3000) {
      last.m += q.len;
      last.end = q.at;
    } else list.push({ m: q.len, at: q.at, end: q.at });
    runs.set(id, list);
  }

  for (const [id, list] of runs) {
    const r = TOLL_ROADS[id] ?? OTHER;
    // Köprü bağlantıları gibi kısa paralı işaretli parçalar gişe girişi değildir
    const ok = list.filter(
      (x) => x.m >= (r.state ? STATE_MIN_RUN : PRIVATE_MIN_RUN),
    );
    if (!ok.length) continue;
    const m = ok.reduce((t, x) => t + x.m, 0);
    const tl = ok.reduce((t, x) => {
      const v = (x.m / 1000) * r.perKm;
      return t + (r.state ? Math.max(STATE_MIN, v) : v);
    }, 0);
    items.push({
      label: r.ref ? `${r.label} (${r.ref})` : r.label,
      detail: kmText(m),
      tl: Math.round(tl),
      at: ok[0].at,
    });
  }

  items.sort((a, b) => a.at - b.at);
  return {
    items,
    total: items.reduce((t, x) => t + x.tl, 0),
    partial: !data,
  };
}

/** Noktalar arasındaki en uzak iki noktanın mesafesi (köprünün boyu). */
function farthest(points: LatLng[]): number {
  let best = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const d = haversine(points[i], points[j]);
      if (d > best) best = d;
    }
  return best;
}
