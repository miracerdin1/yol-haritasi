// Hazır yolların (Kuzey Marmara, Avrasya, Osmangazi, 1915 Çanakkale) verisini, Marmara
// otoyol ağını ve masraf hesabı için Türkiye'deki paralı otoyollar ile köprü/tünelleri indirip
// public/data/prebuilt.json dosyasını tazeler. Site bu dosyayı
// kullandığı için telefonda ilk hesaplama Overpass'i beklemez.
//
// Dosya repoda da durur: Netlify derlemesinden Overpass'e ulaşılamazsa (sunucular yoğun ya da
// bulut IP'lerini sınırlıyor) derleme repodaki son sağlam veriyle devam eder. Sadece
// başarıyla indirilen kalemler güncellenir.
//
// Netlify derlemesi 18 dakikada kesiliyor. Overpass'e hiç ulaşılamıyorsa (ECONNREFUSED) baştan
// vazgeçilir; ulaşılıyor ama yavaşsa toplam süre BUDGET_MS ile sınırlıdır, kalan kalemler
// repodaki veriyle kalır.
//
// Çalıştırma: npm run prefetch
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  ENDPOINTS,
  overpassFetch,
  ROAD_CATALOG,
  fetchAnchors,
  overpass,
  processWays,
} from "../src/lib/roads";
import type { Prebuilt } from "../src/lib/roads";
import { fetchTollData } from "../src/lib/cost";
import { compactNode, radarQuery } from "../src/lib/radars";
import type { Node, RadarFile } from "../src/lib/radars";

const FILE = "public/data/prebuilt.json";
const RADAR_FILE = "public/data/radars.json";
// Türkiye (kıyı şeridi dahil)
const TURKEY = "35.8,25.6,42.2,44.9";
// Marmara – Orta Karadeniz/İç Anadolu: rota bu kutunun dışına çıkarsa ara nokta adayları canlı Overpass'ten
// istenir ve sunucular meşgulken hesaplama takılır.
const ANCHOR_BOX = { s: 39.5, w: 26.0, n: 42.2, e: 36.5 };

/** Ön hazırlığın toplam süresi (denemek için PREFETCH_BUDGET_MS ile kısaltılabilir). */
const BUDGET_MS = Number(process.env.PREFETCH_BUDGET_MS) || 6 * 60_000;
const deadline = Date.now() + BUDGET_MS;
const timeLeft = () => deadline - Date.now();

/** En az bir Overpass sunucusu cevap veriyor mu? "Meşgul" cevabı da ulaşılabilir sayılır. */
async function reachable(): Promise<boolean> {
  return Promise.any(
    ENDPOINTS.map(async (ep) => {
      await fetch(ep.replace(/interpreter$/, "status"), {
        signal: AbortSignal.timeout(10_000),
      });
      return true;
    }),
  ).catch(() => false);
}

/** `fn`'i en fazla kalan süre kadar bekler. */
function withinBudget<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("süre doldu")), timeLeft());
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

async function retry<T>(
  label: string,
  fn: () => Promise<T>,
  tries = 3,
): Promise<T> {
  let last: unknown = new Error("süre doldu");
  for (let i = 1; i <= tries && timeLeft() > 0; i++) {
    try {
      return await withinBudget(fn());
    } catch (err) {
      last = err;
      console.warn(`  ${label}: deneme ${i}/${tries} başarısız`);
      const wait = 15000 * i;
      if (i < tries && timeLeft() > wait)
        await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

async function main() {
  if (!(await reachable())) {
    console.log(
      "::notice::Overpass sunucularına ulaşılamadı; repodaki yol verisi değiştirilmeden kullanılıyor.",
    );
    return;
  }
  const old: Prebuilt | null = existsSync(FILE)
    ? JSON.parse(readFileSync(FILE, "utf8"))
    : null;
  const out: Prebuilt = {
    generatedAt: Date.now(),
    roads: { ...(old?.roads ?? {}) },
    anchors: old?.anchors ?? { box: { s: 0, w: 0, n: 0, e: 0 }, a: [] },
    tolls: old?.tolls,
  };
  let kept = 0;

  for (const def of ROAD_CATALOG) {
    try {
      const d = await retry(def.label, async () => {
        const r = processWays(def, await overpass(def.query));
        if (!r.wayCount) throw new Error("yol bulunamadı");
        return r;
      });
      out.roads[def.id] = { ...d, query: def.query };
      console.log(
        `✓ ${def.label}: ${d.wayCount} parça, ${d.cuts.length} kesim`,
      );
    } catch {
      kept++;
      console.warn(
        `• ${def.label}: indirilemedi, ${out.roads[def.id] ? "repodaki veri kullanılıyor" : "site canlı indirecek"}`,
      );
    }
  }

  try {
    const a = await retry("Otoyol ağı", () => fetchAnchors(ANCHOR_BOX, false));
    if (a.length < 500) throw new Error("beklenenden az veri");
    out.anchors = { box: ANCHOR_BOX, a };
    console.log(`✓ Otoyol ağı: ${a.length} ara nokta adayı`);
  } catch {
    kept++;
    console.warn(
      `• Otoyol ağı: indirilemedi, ${out.anchors.a.length ? "repodaki veri kullanılıyor" : "site canlı indirecek"}`,
    );
  }

  try {
    const t = await retry("Ücretli yollar", fetchTollData);
    const f = Object.keys(t.facilities).length;
    if (f < 6 || !t.roads["O-7D"] || !t.roads["O-5"])
      throw new Error("beklenenden az veri");
    out.tolls = t;
    console.log(
      `✓ Ücretli yollar: ${f} köprü/tünel, ${Object.keys(t.roads).join(", ")}`,
    );
  } catch {
    kept++;
    console.warn(
      `• Ücretli yollar: indirilemedi, ${out.tolls ? "repodaki veri kullanılıyor" : "masrafta köprüler hesaplanmayacak"}`,
    );
  }

  try {
    const j = await retry("Radarlar", () =>
      overpassFetch<{ elements: Node[] }>(radarQuery(TURKEY), {
        hedgeMs: 10000,
        timeoutMs: 120000,
      }),
    );
    const nodes = j.elements.map(compactNode);
    if (nodes.length < 500) throw new Error("beklenenden az veri");
    const f: RadarFile = { generatedAt: Date.now(), nodes };
    mkdirSync("public/data", { recursive: true });
    writeFileSync(RADAR_FILE, JSON.stringify(f));
    console.log(`✓ Radarlar: ${nodes.length} nokta/bölüm`);
  } catch {
    kept++;
    console.warn(
      `• Radarlar: indirilemedi, ${existsSync(RADAR_FILE) ? "repodaki veri kullanılıyor" : "site canlı indirecek"}`,
    );
  }

  mkdirSync("public/data", { recursive: true });
  writeFileSync(FILE, JSON.stringify(out));
  console.log(`${FILE} yazıldı${kept ? ` (${kept} kalem eski veriyle)` : ""}`);
  if (kept)
    console.log(
      "::notice::Yol verisinin bir kısmı indirilemedi; repodaki son sağlam veri kullanıldı.",
    );
}

// Overpass'e ulaşılamasa bile derleme durmasın. Yarım kalan istekler süreci açık tutmasın diye
// iş bitince çıkılır.
main()
  .catch((err) => {
    console.warn("Ön hazırlık başarısız, repodaki veri kullanılacak:", err);
  })
  .finally(() => process.exit(0));
