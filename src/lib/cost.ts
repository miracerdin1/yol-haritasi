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
  /** Boğaz köprüleri: ücret sadece Avrupa → Asya yönünde alınır */
  eastOnly?: boolean;
  note?: string;
}

/** Köprü ve tüneller: sabit geçiş ücreti (1 Temmuz 2026 tarifesi). */
const FACILITIES: Facility[] = [
  {
    id: "15temmuz",
    osmName: "15 Temmuz Şehitler Köprüsü",
    label: "15 Temmuz Şehitler Köprüsü",
    price: 59,
    eastOnly: true,
  },
  {
    id: "fsm",
    osmName: "Fatih Sultan Mehmet Köprüsü",
    label: "Fatih Sultan Mehmet Köprüsü",
    price: 59,
    eastOnly: true,
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
 * Paralı otoyollar (otomobil). Otoyollar gişeden gişeye ücretlendirilir; burada tam güzergâh
 * ücretinden (köprü hariç) km başına ortalama çıkarıldı.
 *
 * Özel işletmeli olanlara Temmuz 2026 zammı (~%17,6, köprülerdeki artışla aynı) eklendi:
 *  O-5 Gebze–İzmir 2.465 − 995 (Osmangazi) = 1.470 TL / ~381 km
 *  O-7 Kınalı–Fatih 220 TL, Odayeri–Kurnaköy 415 TL (YSS hariç), Kurnaköy–Akyazı 510 TL
 *  O-6 Malkara–Çanakkale 1.260 − 995 (köprü) = 265 TL / ~85 km
 *  O-21 Ankara–Niğde 740 TL / ~275 km (330 km bağlantı yollarıyla) · O-31 Aydın–Denizli 495 TL / ~163 km
 *  O-33 Menemen–Çandarlı 205 TL / ~76 km
 *
 * KGM otoyollarında Temmuz'da zam yapılmadı (15 Temmuz/FSM 59 TL kaldı):
 *  O-3 Mahmutbey–Edirne 168 TL / ~230 km · O-4 Kurtköy–Ankara 338 TL / ~400 km
 *  O-21 Niğde–Tarsus 177 TL / ~190 km · O-31 İzmir–Aydın 73 TL / ~85 km
 *  O-32 İzmir–Çeşme 53 TL / ~70 km · O-53 Ceyhan–İskenderun ~65 TL / ~105 km
 *  O-52 Adana–Gaziantep 102 TL / ~200 km, Gaziantep–Şanlıurfa 102 TL / ~140 km
 */
const TOLL_ROADS: Record<string, TollRoad> = {
  "O-7": { label: "Kuzey Marmara Otoyolu", ref: "O-7 / E-80", perKm: 4.2 },
  "O-5": { label: "İstanbul–İzmir Otoyolu", ref: "O-5 / E-881", perKm: 4.5 },
  "O-6": { label: "Kınalı–Çanakkale Otoyolu", ref: "O-6 / E-87", perKm: 3.6 },
  "O-21": { label: "Ankara–Niğde Otoyolu", ref: "O-21 / E-90", perKm: 3.2 },
  "O-31": { label: "Aydın–Denizli Otoyolu", ref: "O-31 / E-87", perKm: 3.6 },
  "O-33": { label: "Kuzey Ege Otoyolu", ref: "O-33 / E-87", perKm: 3.2 },
  "O-3": { label: "Avrupa Otoyolu", ref: "O-3 / E-80", perKm: 0.75, state: true },
  "O-4": { label: "Anadolu Otoyolu", ref: "O-4 / E-80", perKm: 0.85, state: true },
  "O-21K": { label: "Niğde–Tarsus Otoyolu", ref: "O-21 / E-90", perKm: 0.95, state: true },
  "O-31K": { label: "İzmir–Aydın Otoyolu", ref: "O-31 / E-87", perKm: 0.85, state: true },
  "O-32": { label: "İzmir–Çeşme Otoyolu", ref: "O-32 / E-881", perKm: 0.75, state: true },
  "O-52": { label: "Adana–Şanlıurfa Otoyolu", ref: "O-52 / E-90", perKm: 0.6, state: true },
  "O-53": { label: "Ceyhan–İskenderun Otoyolu", ref: "O-53 / E-91", perKm: 0.6, state: true },
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
  if (ref === "O-7" || /Kuzey Marmara/.test(name)) return "O-7";
  if (ref === "O-33" || /Kuzey Ege/.test(name)) return "O-33";
  if (/Kırşehir Bağlantısı/.test(name)) return "O-21";
  // O-21'in Niğde'nin kuzeyi (Ankara–Niğde) özel, güneyi (Niğde–Pozantı–Tarsus) KGM
  if (ref === "O-21") return p[0] > 38.0 ? "O-21" : "O-21K";
  // O-31'in Aydın'ın doğusu (Aydın–Denizli) özel, batısı (İzmir–Aydın) KGM
  if (ref === "O-31") return p[1] > 27.85 || /Fernas/.test(op) ? "O-31" : "O-31K";
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

/**
 * Rotanın köprü/tünel ve otoyol ücretlerini tahmin eder. Rota ~50 m'lik parçalara bölünür:
 * önce köprü/tünellerin üstünden geçen kısımlar sabit ücretle sayılır, kalan paralı kısımlar
 * yakın olduğu özel otoyolun km ücretiyle, hiçbirine yakın değilse KGM tarifesiyle.
 */
export function tollCost(route: RouteResult, data: TollData | null): TollResult {
  const { line } = route;
  const cat = new Uint8Array(Math.max(0, line.length - 1));
  for (const [a, b, v] of route.waycategory)
    for (let i = a; i < b && i < cat.length; i++) cat[i] = v;

  // ~50 m aralıklı noktalar; her biri kendi uzunluğunu ve "paralı mı" bilgisini taşır
  const pts: { p: LatLng; len: number; at: number; toll: boolean }[] = [];
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

  const items: CostItem[] = [];
  const used = new Uint8Array(pts.length);

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
      if (start >= 0 && covered >= 0.6 * span) {
        for (let i = start; i <= last; i++) used[i] = 1;
        const east = pts[last].p[1] > pts[start].p[1];
        const free = f.eastOnly && !east;
        items.push({
          label: f.label,
          detail: free
            ? "Asya → Avrupa yönü ücretsiz"
            : (f.note ?? (f.eastOnly ? "Avrupa → Asya" : "")),
          tl: free ? 0 : f.price,
          at: pts[start].at,
        });
      }
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
