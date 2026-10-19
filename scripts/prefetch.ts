// Hazır yolların (Kuzey Marmara, Avrasya, Osmangazi, 1915 Çanakkale) verisini, Marmara
// otoyol ağını ve masraf hesabı için Türkiye'deki paralı otoyollar ile köprü/tünelleri indirip public/data/prebuilt.json dosyasını tazeler. Site bu dosyayı
// kullandığı için telefonda ilk hesaplama Overpass'i beklemez.
//
// Dosya repoda da durur: Netlify derlemesinden Overpass'e ulaşılamazsa (sunucular yoğun ya da
// bulut IP'lerini sınırlıyor) derleme repodaki son sağlam veriyle devam eder. Sadece
// başarıyla indirilen kalemler güncellenir.
//
// Çalıştırma: npm run prefetch
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  PRESET_ROADS,
  fetchAnchors,
  overpass,
  processWays,
} from "../src/lib/roads";
import type { Prebuilt } from "../src/lib/roads";
import { fetchTollData } from "../src/lib/cost";

const FILE = "public/data/prebuilt.json";
// Tüm hazır yollar kapalıyken oluşan bölgeyi (+20 km) rahatça kapsayan kutu
const ANCHOR_BOX = { s: 39.9, w: 26.0, n: 41.7, e: 31.3 };

async function retry<T>(
  label: string,
  fn: () => Promise<T>,
  tries = 3,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      console.warn(`  ${label}: deneme ${i}/${tries} başarısız`);
      if (i < tries) await new Promise((r) => setTimeout(r, 15000 * i));
    }
  }
  throw last;
}

async function main() {
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

  for (const def of PRESET_ROADS) {
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
    if (f < 6 || !t.roads["O-7"] || !t.roads["O-5"])
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

  mkdirSync("public/data", { recursive: true });
  writeFileSync(FILE, JSON.stringify(out));
  console.log(`${FILE} yazıldı${kept ? ` (${kept} kalem eski veriyle)` : ""}`);
  if (kept)
    console.log(
      "::notice::Yol verisinin bir kısmı indirilemedi; repodaki son sağlam veri kullanıldı.",
    );
}

// Overpass'e ulaşılamasa bile derleme durmasın.
main().catch((err) => {
  console.warn("Ön hazırlık başarısız, repodaki veri kullanılacak:", err);
});
