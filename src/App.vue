<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from "vue";
import MapView from "./components/MapView.vue";
import PlaceInput from "./components/PlaceInput.vue";
import type { LatLng } from "./lib/geo";
import type { RouteResult } from "./lib/ors";
import type { Place } from "./lib/geocode";
import { geocode } from "./lib/geocode";
import type { RoadData, RoadDef } from "./lib/roads";
import {
  ROAD_CATALOG,
  clearOfSideRoads,
  customRoad,
  loadAnchors,
  loadPrebuilt,
  loadRoad,
} from "./lib/roads";
import { fitGoogleStops, planRoute } from "./lib/planner";
import type { Waypoint } from "./lib/waypoints";
import { snapToRoute, touchesAvoided } from "./lib/waypoints";
import { GOOGLE_MAX_WAYPOINTS, googleMapsUrl } from "./lib/google";
import { yandexMapsUrl, yandexNaviUrl } from "./lib/yandex";
import { load, save } from "./lib/storage";
import { fetchRadars } from "./lib/radars";
import { downloadKml, routeKml } from "./lib/kml";
import type { Radar, Section } from "./lib/radars";
import type { FuelType, TollResult } from "./lib/cost";
import {
  FUEL_DEFAULTS,
  FUEL_LABELS,
  TARIFF_DATE,
  crossingLocks,
  tollCost,
} from "./lib/cost";

// ---------- Ayarlar ----------
// Derleme sırasında verilen anahtar (Netlify ortam değişkeni: VITE_ORS_KEY) varsa varsayılan olarak o kullanılır.
const BUILT_IN_KEY =
  (import.meta.env.VITE_ORS_KEY as string | undefined)?.trim() ?? "";
const apiKey = ref<string>(load("apiKey", "") || BUILT_IN_KEY);
const keyDraft = ref(apiKey.value === BUILT_IN_KEY ? "" : apiKey.value);
const showSettings = ref(!apiKey.value);
// Yapıştırır yapıştırmaz kaydet; "Kaydet"e basmayı unutmak anahtarı kaybettirmesin.
watch(keyDraft, (v) => {
  const k = v.trim();
  apiKey.value = k || BUILT_IN_KEY;
  save("apiKey", k);
});
function saveKey() {
  showSettings.value = !apiKey.value;
}

// ---------- Yollar ----------
const customInputs = ref<string[]>(load("customRoads", []));
const roads = computed<RoadDef[]>(() => [
  ...ROAD_CATALOG,
  ...customInputs.value.map(customRoad),
]);
/** true = yol açık (kullanılabilir), false = kaçın */
const allowed = reactive<Record<string, boolean>>(
  load("allowed", {
    kmo: false,
    avrasya: false,
    osmangazi: true,
    canakkale: true,
  }),
);
watch(allowed, (v) => save("allowed", v), { deep: true });
const newRoad = ref("");
function addRoad() {
  const v = newRoad.value.trim();
  if (!v) return;
  const def = customRoad(v);
  if (!roads.value.some((r) => r.id === def.id)) {
    customInputs.value = [...customInputs.value, v];
    save("customRoads", customInputs.value);
    allowed[def.id] = false;
  }
  newRoad.value = "";
}
function removeRoad(def: RoadDef) {
  customInputs.value = customInputs.value.filter(
    (c) => customRoad(c).id !== def.id,
  );
  save("customRoads", customInputs.value);
  delete allowed[def.id];
}
const isAllowed = (id: string) => allowed[id] !== false;
const showPick = ref(false);
const roadFilter = ref("");
const norm = (t: string) => t.toLocaleLowerCase("tr").replace(/[\s-]/g, "");
const filteredRoads = computed(() => {
  const q = norm(roadFilter.value);
  return q
    ? roads.value.filter((r) =>
        norm(`${r.tag} ${r.label} ${r.note}`).includes(q),
      )
    : roads.value;
});
const avoidedRoads = computed(() => roads.value.filter((r) => !isAllowed(r.id)));

// ---------- Başlangıç / varış ----------
const last = load("last", {
  from: "Hadımköy, Arnavutköy, İstanbul",
  to: "Kargı, Çorum",
});
const fromText = ref(last.from);
const toText = ref(last.to);
const fromPlace = ref<Place | null>(null);
const toPlace = ref<Place | null>(null);
const fromCurrent = ref(false);
function swap() {
  [fromText.value, toText.value] = [toText.value, fromText.value];
  [fromPlace.value, toPlace.value] = [toPlace.value, fromPlace.value];
  fromCurrent.value = false;
}

// ---------- Sonuç ----------
const busy = ref(false);
const status = ref("");
const error = ref("");
const warning = ref("");
const result = shallowRef<RouteResult | null>(null);
const resolvedFrom = ref<LatLng | null>(null);
const resolvedTo = ref<LatLng | null>(null);
const avoidedSamples = shallowRef<LatLng[]>([]);
const avoidedLines = shallowRef<LatLng[][]>([]);
const stops = ref<Waypoint[]>([]);
const maxStops = ref<number>(
  Math.min(load("maxStops", 8), GOOGLE_MAX_WAYPOINTS),
);
const addMode = ref(false);
const copied = ref(false);
const closedData = shallowRef<RoadData[]>([]);
const radars = shallowRef<Radar[]>([]);
const sections = shallowRef<Section[]>([]);
const radarState = ref<"" | "loading" | "failed">("");
/** Durak ayarı sonrası Google'ın taklit rotası kapalı yolları kullanıyor mu */
const stopsClean = ref(true);
const fitting = ref(false);

// ---------- Masraf ----------
const tolls = shallowRef<TollResult | null>(null);
const showCost = ref(false);
const fuelType = ref<FuelType>(load("fuelType", "benzin"));
const saved = load<Partial<typeof FUEL_DEFAULTS>>("fuel", {});
const fuelSettings = reactive(
  Object.fromEntries(
    (Object.keys(FUEL_DEFAULTS) as FuelType[]).map((k) => [
      k,
      { ...FUEL_DEFAULTS[k], ...saved[k] },
    ]),
  ) as typeof FUEL_DEFAULTS,
);
watch(fuelType, (v) => save("fuelType", v));
watch(fuelSettings, (v) => save("fuel", v), { deep: true });
const fuel = computed(() => fuelSettings[fuelType.value]);
const liters = computed(() =>
  result.value
    ? ((result.value.distance / 1000) * (Number(fuel.value.use) || 0)) / 100
    : 0,
);
const fuelTl = computed(() => liters.value * (Number(fuel.value.price) || 0));
const costTotal = computed(() => fuelTl.value + (tolls.value?.total ?? 0));

watch(maxStops, (v) => save("maxStops", v));

async function resolve(
  text: string,
  place: Place | null,
  current: boolean,
): Promise<Place> {
  if (current) {
    const p = await new Promise<GeolocationPosition>((ok, fail) =>
      navigator.geolocation.getCurrentPosition(ok, fail, {
        enableHighAccuracy: true,
        timeout: 15000,
      }),
    ).catch(() => {
      throw new Error(
        "Konum alınamadı. Tarayıcıda konum iznini açın ya da başlangıcı yazın.",
      );
    });
    return { label: "Konumum", point: [p.coords.latitude, p.coords.longitude] };
  }
  if (place) return place;
  const res = await geocode(text);
  if (!res.length)
    throw new Error(
      `"${text}" bulunamadı. Daha açık yazmayı deneyin (ör. ilçe, il).`,
    );
  return res[0];
}

/** Rota üzerindeki radarlar arka planda gelir; rota sonucunu bekletmez. */
async function loadRadars(line: LatLng[]) {
  radarState.value = "loading";
  radars.value = [];
  sections.value = [];
  try {
    const r = await fetchRadars(line);
    if (result.value?.line !== line) return;
    radars.value = r.radars;
    sections.value = r.sections;
    radarState.value = "";
  } catch {
    if (result.value?.line === line) radarState.value = "failed";
  }
}

async function calculate() {
  error.value = "";
  warning.value = "";
  if (!apiKey.value) {
    showSettings.value = true;
    error.value = "Önce OpenRouteService API anahtarını girin.";
    return;
  }
  if (!fromCurrent.value && !fromText.value.trim())
    return void (error.value = "Başlangıç yazın.");
  if (!toText.value.trim()) return void (error.value = "Varış yazın.");
  busy.value = true;
  addMode.value = false;
  try {
    status.value = "Adresler bulunuyor…";
    const [a, b] = await Promise.all([
      resolve(fromText.value, fromPlace.value, fromCurrent.value),
      resolve(toText.value, toPlace.value, false),
    ]);
    if (!fromCurrent.value) fromPlace.value = a;
    toPlace.value = b;
    toText.value = b.label;
    if (!fromCurrent.value) fromText.value = a.label;
    save("last", {
      from: fromCurrent.value ? last.from : a.label,
      to: b.label,
    });
    resolvedFrom.value = a.point;
    resolvedTo.value = b.point;

    const closed = roads.value.filter((r) => !isAllowed(r.id));
    const data: RoadData[] = [];
    for (const r of closed) {
      status.value = `${r.label} verisi alınıyor…`;
      const d = await loadRoad(r);
      if (d.wayCount === 0)
        warning.value = `"${r.label}" OpenStreetMap'te bulunamadı, bu yol engellenmedi.`;
      data.push(d);
    }

    avoidedSamples.value = data.flatMap((d) => d.samples);
    avoidedLines.value = data.flatMap((d) => d.lines);

    const res = await planRoute({
      key: apiKey.value,
      from: a.point,
      to: b.point,
      closed: data,
      loadAnchors,
      onStatus: (s) => (status.value = s),
    });
    result.value = res;
    loadRadars(res.line);
    tolls.value = tollCost(res, (await loadPrebuilt())?.tolls ?? null);
    closedData.value = data;
    stops.value = [];
    await autoPick();

    const hit = touchesAvoided(res.line, avoidedSamples.value, 1500);
    if (hit)
      warning.value =
        "Rota kapalı yollardan birine çok yakın geçiyor. Haritada kırmızı çizgilerle karşılaştırın.";
    status.value = "";
  } catch (e) {
    error.value = friendly(e);
    status.value = "";
  } finally {
    busy.value = false;
  }
}

function onEnter(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t.id === "from" || t.id === "to") calculate();
}

/** Ağ hatalarını anlaşılır hâle getirir. */
function friendly(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m))
    return "İnternet bağlantısı kurulamadı. Dosyayı bir uygulama önizlemesinde açtıysanız Chrome ya da Safari ile doğrudan açın; önizlemeler dış bağlantılara izin vermeyebilir.";
  return m || "Bir şey ters gitti.";
}

// Beklenmeyen hatalar da ekranda görünsün
window.addEventListener(
  "error",
  (ev) => (error.value = friendly(ev.error ?? ev.message)),
);
window.addEventListener(
  "unhandledrejection",
  (ev) => (error.value = friendly(ev.reason)),
);

async function autoPick() {
  if (!result.value) return;
  fitting.value = true;
  error.value = "";
  try {
    const locks: Waypoint[] = crossingLocks(
      result.value,
      (await loadPrebuilt())?.tolls ?? null,
      closedData.value.map((d) => d.id),
    ).map((c) => ({
      point: c.point,
      along: c.along,
      nearAvoided: Infinity,
      lock: c.label,
    }));
    const fit = await fitGoogleStops(
      apiKey.value,
      result.value,
      closedData.value,
      maxStops.value,
      (s) => (status.value = s),
      clearOfSideRoads,
      locks,
    );
    stops.value = fit.stops;
    stopsClean.value = fit.clean;
  } catch (e) {
    error.value = friendly(e);
  } finally {
    fitting.value = false;
    status.value = "";
  }
}

function onMapTap(p: LatLng) {
  if (!result.value || stops.value.length >= GOOGLE_MAX_WAYPOINTS) return;
  const w = snapToRoute(result.value.line, p);
  stops.value = [...stops.value, w].sort((x, y) => x.along - y.along);
  addMode.value = false;
}
function removeStop(i: number) {
  stops.value = stops.value.filter((_, k) => k !== i);
}

const gmapsUrl = computed(() => {
  if (!result.value) return "";
  return googleMapsUrl(
    fromCurrent.value
      ? { current: true }
      : { text: fromText.value, point: resolvedFrom.value ?? undefined },
    { text: toText.value, point: resolvedTo.value ?? undefined },
    stops.value.map((s) => s.point),
  );
});

// Yandex koordinat istiyor; "Konumum" seçiliyse başlangıç boş bırakılır (telefonun konumu)
const yandexFrom = computed(() =>
  fromCurrent.value ? null : resolvedFrom.value,
);
const ynaviUrl = computed(() =>
  result.value && resolvedTo.value
    ? yandexNaviUrl(yandexFrom.value, resolvedTo.value, stopPoints.value)
    : "",
);
const ymapsUrl = computed(() =>
  result.value && resolvedTo.value
    ? yandexMapsUrl(yandexFrom.value, resolvedTo.value, stopPoints.value)
    : "",
);

function exportKml() {
  if (!result.value) return;
  downloadKml(
    routeKml(result.value.line, radars.value, sections.value, stopPoints.value),
  );
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(gmapsUrl.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    window.prompt("Linki kopyalayın:", gmapsUrl.value);
  }
}

const km = (m: number) =>
  (m / 1000).toLocaleString("tr-TR", {
    maximumFractionDigits: m < 10000 ? 1 : 0,
  });
function dur(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} sa ${m} dk` : `${m} dk`;
}
const tl = (n: number) =>
  `${Math.round(n).toLocaleString("tr-TR")} TL`;
const stopPoints = computed(() => stops.value.map((s) => s.point));
const closedLabels = computed(() =>
  roads.value.filter((r) => !isAllowed(r.id)).map((r) => r.label),
);
</script>

<template>
  <main class="wrap">
    <header class="sign">
      <div class="codes"><b>O-7</b><b>AVRASYA</b><b>O-5</b></div>
      <h1>Yol Haritası</h1>
      <p>
        Pahalı yolları tek tek kapat. Rota onlarsız hesaplanır, sonra Google
        Maps ya da Yandex Navigasyon'da aynı yoldan gitmen için otoyolun üstüne
        durak konur.
      </p>
      <button
        class="gear"
        type="button"
        @click="showSettings = !showSettings"
        aria-label="Ayarlar"
      >
        ⚙
      </button>
    </header>

    <section v-if="showSettings" class="card settings">
      <h2>OpenRouteService anahtarı</h2>
      <p class="muted">
        Rotayı hesaplayan ücretsiz servis.
        <a
          href="https://openrouteservice.org/dev/#/signup"
          target="_blank"
          rel="noopener"
          >openrouteservice.org</a
        >'da hesap açıp "Tokens" bölümünden bir anahtar oluşturun. Anahtar
        yalnızca bu cihazda saklanır.
      </p>
      <div class="row">
        <input
          id="apikey"
          v-model="keyDraft"
          type="text"
          :placeholder="
            BUILT_IN_KEY
              ? 'Boş bırakırsanız sitedeki anahtar kullanılır'
              : 'Anahtarı yapıştırın'
          "
          autocomplete="off"
          spellcheck="false"
        />
        <button type="button" class="btn primary small" @click="saveKey">
          Tamam
        </button>
      </div>
      <p class="muted small">Yapıştırdığınız anda bu cihazda kaydedilir.</p>
    </section>

    <div
      class="stack"
      role="form"
      aria-label="Rota bilgileri"
      @keydown.enter="onEnter"
    >
      <div class="ends">
        <div class="stack tight">
          <PlaceInput
            id="from"
            v-model:text="fromText"
            v-model:place="fromPlace"
            v-model:current="fromCurrent"
            label="Nereden"
            allow-current
            placeholder="Adres, ilçe ya da yer"
          />
          <PlaceInput
            id="to"
            v-model:text="toText"
            v-model:place="toPlace"
            label="Nereye"
            placeholder="Adres, ilçe ya da yer"
          />
        </div>
        <button
          type="button"
          class="swap"
          @click="swap"
          aria-label="Başlangıç ile varışı yer değiştir"
        >
          ⇅
        </button>
      </div>

      <div class="stack tight">
        <span class="lbl">Kaçınılacak ücretli yollar</span>
        <div class="card pick">
          <button
            type="button"
            class="pick-head"
            :aria-expanded="showPick"
            aria-controls="pick-body"
            @click="showPick = !showPick"
          >
            <span>{{
              avoidedRoads.length
                ? `${avoidedRoads.length} yol seçili`
                : "Yol seçmek için dokunun"
            }}</span>
            <span class="chev" aria-hidden="true">▾</span>
          </button>
          <ul v-if="avoidedRoads.length" class="chips" aria-label="Seçili yollar">
            <li v-for="r in avoidedRoads" :key="r.id">
              <span class="chip">
                <em class="tag" :class="{ city: r.id === 'avrasya' }">{{
                  r.tag
                }}</em>
                {{ r.label }}
                <button
                  type="button"
                  class="x"
                  @click="allowed[r.id] = true"
                  :aria-label="r.label + ' seçimini kaldır'"
                >
                  ✕
                </button>
              </span>
            </li>
          </ul>
          <div v-if="showPick" id="pick-body" class="pick-body">
            <input
              v-model="roadFilter"
              type="search"
              class="pick-search"
              placeholder="Ara: O-5, köprü, İzmir…"
              aria-label="Yol ara"
            />
            <div class="pick-list" role="group" aria-label="Ücretli yollar">
              <label v-for="r in filteredRoads" :key="r.id" class="opt">
                <input
                  type="checkbox"
                  :checked="!isAllowed(r.id)"
                  @change="
                    allowed[r.id] = !($event.target as HTMLInputElement).checked
                  "
                />
                <em class="tag" :class="{ city: r.id === 'avrasya' }">{{
                  r.tag
                }}</em>
                <span class="txt">
                  <strong>{{ r.label }}</strong>
                  <small>{{ r.note }}</small>
                </span>
                <button
                  v-if="r.custom"
                  type="button"
                  class="x"
                  @click.prevent="removeRoad(r)"
                  :aria-label="r.label + ' yolunu listeden çıkar'"
                >
                  ✕
                </button>
              </label>
              <p v-if="!filteredRoads.length" class="muted small pad">
                Listede yok. Aşağıdan numarasıyla ya da adıyla ekleyin.
              </p>
            </div>
            <div class="add">
              <input
                id="newroad"
                v-model="newRoad"
                type="text"
                placeholder="Listede yok mu? O-6 ya da tam adı"
                @keydown.enter.prevent="addRoad"
              />
              <button type="button" class="btn ghost small" @click="addRoad">
                Ekle
              </button>
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        class="btn primary"
        :disabled="busy"
        @click="calculate"
      >
        {{ busy ? status || "Hesaplanıyor…" : "Rotayı hesapla" }}
      </button>
      <p v-if="error" class="msg bad" role="alert">{{ error }}</p>
    </div>

    <section class="stack">
      <MapView
        :route="result?.line ?? null"
        :avoided="avoidedLines"
        :radars="radars"
        :sections="sections"
        :stops="stopPoints"
        :from="resolvedFrom"
        :to="resolvedTo"
        :add-mode="addMode"
        @map-tap="onMapTap"
        @stop-tap="removeStop"
      />
      <p class="legend">
        <i class="lg route"></i>Önerilen rota <i class="lg avoid"></i>Kapalı
        yollar <i class="lg pin"></i>Durak (dokun: kaldır)
        <i class="lg radar"></i>Sabit radar
        <i class="lg radar-road"></i>Radarlı yol
        <i class="lg section"></i>Ortalama hız bölümü
      </p>
      <p v-if="radarState === 'loading'" class="legend">Radarlar aranıyor…</p>
      <p v-else-if="radarState === 'failed'" class="legend">
        Radar verisi alınamadı.
        <button
          type="button"
          class="link"
          @click="result && loadRadars(result.line)"
        >
          Tekrar ara
        </button>
      </p>
      <p v-else-if="result" class="legend">
        Rotada {{ radars.length }} sabit radar, {{ sections.length }} ortalama
        hız bölümü işaretli (OpenStreetMap; eksik olabilir).
      </p>
    </section>

    <section v-if="result" class="card out stack">
      <div class="summary">
        <div>
          <span class="big">{{ dur(result.duration) }}</span
          ><span class="muted">{{ km(result.distance) }} km</span>
        </div>
        <p class="muted small">
          {{
            closedLabels.length
              ? closedLabels.join(", ") + " hariç"
              : "Tüm yollar açık"
          }}
        </p>
      </div>
      <div class="cost">
        <button
          type="button"
          class="cost-head"
          :aria-expanded="showCost"
          aria-controls="cost-body"
          @click="showCost = !showCost"
        >
          <span class="lbl">Tahmini masraf</span>
          <span class="cost-sum">{{ tl(costTotal) }}</span>
          <span class="chev" aria-hidden="true">▾</span>
        </button>
        <div v-if="showCost" id="cost-body" class="cost-body">
          <ul class="cost-list">
            <li>
              <span
                >Yakıt
                <small
                  >{{ FUEL_LABELS[fuelType] }} · {{ km(result.distance) }} km ·
                  {{
                    liters.toLocaleString("tr-TR", { maximumFractionDigits: 1 })
                  }}
                  L</small
                ></span
              ><b>{{ tl(fuelTl) }}</b>
            </li>
            <li v-for="(it, i) in tolls?.items ?? []" :key="i">
              <span
                >{{ it.label }} <small v-if="it.detail">{{ it.detail }}</small></span
              ><b>{{ it.tl ? tl(it.tl) : "Ücretsiz" }}</b>
            </li>
            <li v-if="tolls && !tolls.items.length" class="none">
              <span>Köprü ve otoyol <small>Rotada ücretli yol yok</small></span
              ><b>0 TL</b>
            </li>
            <li class="total">
              <span>Toplam</span><b>{{ tl(costTotal) }}</b>
            </li>
          </ul>
          <div class="fuel">
            <label
              >Yakıt
              <select v-model="fuelType">
                <option v-for="(l, k) in FUEL_LABELS" :key="k" :value="k">
                  {{ l }}
                </option>
              </select>
            </label>
            <label
              >Tüketim (L/100 km)
              <input
                v-model.number="fuelSettings[fuelType].use"
                type="number"
                inputmode="decimal"
                min="0"
                step="0.1"
              />
            </label>
            <label
              >Litre fiyatı (TL)
              <input
                v-model.number="fuelSettings[fuelType].price"
                type="number"
                inputmode="decimal"
                min="0"
                step="0.01"
              />
            </label>
          </div>
          <p class="muted small">
            Otomobil, tek yön. Köprü ve otoyol ücretleri {{ TARIFF_DATE }}
            tarifesine göre tahmindir; otoyollar gişeden gişeye
            ücretlendirildiği için gerçek tutar biraz farklı olabilir.
            <template v-if="tolls?.partial">
              Köprü/otoyol verisi yüklenemedi; paralı kısımlar devlet otoyolu
              ücretiyle sayıldı.</template
            >
          </p>
        </div>
      </div>
      <p v-if="warning" class="msg warn">{{ warning }}</p>

      <div class="stops-head">
        <span class="lbl">Navigasyon durakları</span>
        <div class="stepper" role="group" aria-label="En fazla otomatik durak">
          <button
            type="button"
            @click="maxStops = Math.max(0, maxStops - 1)"
            aria-label="Azalt"
          >
            −
          </button>
          <output>{{ maxStops }}</output>
          <button
            type="button"
            @click="maxStops = Math.min(GOOGLE_MAX_WAYPOINTS, maxStops + 1)"
            aria-label="Artır"
          >
            +
          </button>
        </div>
      </div>
      <ol class="stops">
        <li v-for="(s, i) in stops" :key="s.along">
          <span class="n">{{ i + 1 }}</span>
          <span class="t">
            {{ km(s.along) }}. km'de
            <small
              >{{
                s.manual
                  ? "Elle eklendi"
                  : s.lock
                    ? `${s.lock}: geçiş sabit`
                    : `Kapalı yola ${km(s.nearAvoided)} km`
              }}
              · {{ s.point[0].toFixed(5) }}, {{ s.point[1].toFixed(5) }}</small
            >
          </span>
          <button
            type="button"
            class="x"
            @click="removeStop(i)"
            :aria-label="`${i + 1}. durağı kaldır`"
          >
            ✕
          </button>
        </li>
        <li v-if="fitting" class="empty">
          {{ status || "Duraklar seçiliyor…" }}
        </li>
        <li v-else-if="!stops.length" class="empty">
          Durak gerekmiyor: Google'ın en hızlı rotası kapalı yolları zaten
          kullanmıyor.
        </li>
      </ol>
      <p v-if="!fitting && stopsClean && stops.length" class="msg ok">
        ✓ Bu duraklarla Google'ın en hızlı rotası kapalı yollara girmiyor.
      </p>
      <p v-else-if="!fitting && !stopsClean" class="msg warn">
        {{ maxStops }} durakla yetmedi. Sayıyı artırıp "Otomatik seç"e basın ya
        da haritadan elle durak ekleyin.
      </p>
      <div class="actions">
        <button
          type="button"
          class="btn ghost"
          :class="{ on: addMode }"
          @click="addMode = !addMode"
          :disabled="stops.length >= GOOGLE_MAX_WAYPOINTS"
        >
          {{ addMode ? "Haritaya dokunun…" : "+ Durak ekle" }}
        </button>
        <button
          type="button"
          class="btn ghost"
          @click="autoPick"
          :disabled="fitting"
        >
          {{ fitting ? status || "Kontrol ediliyor…" : "Otomatik seç" }}
        </button>
      </div>
      <div class="actions">
        <a
          class="btn primary"
          :class="{ wait: fitting }"
          :href="gmapsUrl"
          target="_blank"
          rel="noopener"
          :aria-disabled="fitting"
          @click="fitting && $event.preventDefault()"
          >{{ fitting ? "Duraklar hazırlanıyor…" : "Google Maps'te aç ↗" }}</a
        >
        <button
          type="button"
          class="btn ghost"
          :disabled="fitting"
          @click="copyLink"
        >
          {{ copied ? "Kopyalandı" : "Linki kopyala" }}
        </button>
      </div>
      <div class="actions">
        <a
          class="btn primary"
          :class="{ wait: fitting }"
          :href="ynaviUrl"
          :aria-disabled="fitting"
          @click="fitting && $event.preventDefault()"
          >Yandex Navigasyon'da aç ↗</a
        >
        <a
          class="btn ghost"
          :class="{ wait: fitting }"
          :href="ymapsUrl"
          target="_blank"
          rel="noopener"
          :aria-disabled="fitting"
          @click="fitting && $event.preventDefault()"
          >Yandex Haritalar ↗</a
        >
      </div>
      <div class="actions">
        <button
          type="button"
          class="btn ghost"
          :disabled="radarState === 'loading'"
          @click="exportKml"
        >
          Radarlı haritayı indir (KML)
        </button>
      </div>
      <p class="muted small">
        KML dosyasını mymaps.google.com'da "Yeni harita → İçe aktar" ile
        yükleyin; rota, radarlar ve ortalama hız bölümleri Google Maps
        uygulamasında Kaydedilenler → Haritalar altında görünür.
      </p>
      <p class="muted small">
        Navigasyonda açınca yol tarifinde O-7 ya da kapattığınız yol görünüyorsa
        "+ Durak ekle" ile o bölgedeki önerilen rotanın üstüne bir durak daha
        koyun. Yandex Navigasyon rotayı açmazsa "Yandex Haritalar"dan açıp
        oradan navigasyona geçin.
      </p>
    </section>

    <footer class="muted small">
      Rota: OpenRouteService · Yol verisi ve harita: © OpenStreetMap katkıcıları
    </footer>
  </main>
</template>
