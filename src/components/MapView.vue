<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { LatLng } from '../lib/geo'
import type { Radar, Section } from '../lib/radars'

const props = defineProps<{
  route: LatLng[] | null
  avoided: LatLng[][]
  radars: Radar[]
  sections: Section[]
  stops: LatLng[]
  from: LatLng | null
  to: LatLng | null
  addMode: boolean
}>()
const emit = defineEmits<{
  (e: 'map-tap', p: LatLng): void
  (e: 'stop-tap', index: number): void
}>()

const el = ref<HTMLDivElement>()
let map: L.Map | null = null
const layers = {
  avoided: L.layerGroup(),
  route: L.layerGroup(),
  sections: L.layerGroup(),
  radars: L.layerGroup(),
  stops: L.layerGroup(),
  ends: L.layerGroup(),
}

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#0B6B3A'
}

function drawAvoided() {
  layers.avoided.clearLayers()
  for (const l of props.avoided) {
    L.polyline(l, { color: css('--stop'), weight: 5, opacity: 0.55, dashArray: '6 6', interactive: false }).addTo(
      layers.avoided,
    )
  }
}

function drawRoute(fit: boolean) {
  layers.route.clearLayers()
  if (!props.route) return
  L.polyline(props.route, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(layers.route)
  L.polyline(props.route, { color: css('--sign'), weight: 5, interactive: false }).addTo(layers.route)
  if (fit && map) map.fitBounds(L.latLngBounds(props.route), { padding: [24, 24] })
}

function drawSections() {
  layers.sections.clearLayers()
  for (const sec of props.sections) {
    const km = (sec.length / 1000).toFixed(1).replace('.', ',')
    const tip = `Ortalama hız bölümü · ${km} km${sec.maxspeed ? ` · ${sec.maxspeed} km/s` : ''}`
    L.polyline(sec.line, { color: '#f77f00', weight: 8, opacity: 0.75, lineCap: 'butt' })
      .bindTooltip(tip, { sticky: true })
      .addTo(layers.sections)
  }
}

function drawRadars() {
  layers.radars.clearLayers()
  for (const r of props.radars) {
    const kind = r.kind === 'isik' ? 'Kırmızı ışık kamerası' : r.kind === 'ortalama' ? 'Ortalama hız radarı' : 'Sabit radar'
    const limit = r.maxspeed ? ` · ${r.maxspeed} km/s` : ''
    const icon = L.divIcon({
      className: 'radar-pin',
      html: `<span>${r.maxspeed ?? '📷'}</span>`,
      iconSize: [26, 26],
    })
    L.marker(r.p, { icon, title: kind + limit, zIndexOffset: -100 }).bindTooltip(kind + limit).addTo(layers.radars)
  }
}

function drawStops() {
  layers.stops.clearLayers()
  props.stops.forEach((p, i) => {
    const icon = L.divIcon({ className: 'stop-pin', html: `<span>${i + 1}</span>`, iconSize: [30, 30] })
    L.marker(p, { icon, keyboard: true, title: `${i + 1}. durak — kaldırmak için dokunun` })
      .on('click', () => emit('stop-tap', i))
      .addTo(layers.stops)
  })
}

function drawEnds() {
  layers.ends.clearLayers()
  if (props.from) L.circleMarker(props.from, { radius: 8, color: '#fff', weight: 3, fillColor: css('--ink'), fillOpacity: 1 }).addTo(layers.ends)
  if (props.to) L.circleMarker(props.to, { radius: 8, color: css('--ink'), weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(layers.ends)
}

onMounted(() => {
  map = L.map(el.value!, { zoomControl: true, attributionControl: true }).setView([41.02, 29.0], 9)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap katkıcıları',
  }).addTo(map)
  Object.values(layers).forEach((g) => g.addTo(map!))
  map.on('click', (e: L.LeafletMouseEvent) => {
    if (props.addMode) emit('map-tap', [e.latlng.lat, e.latlng.lng])
  })
  drawAvoided()
  drawRoute(true)
  drawSections()
  drawRadars()
  drawStops()
  drawEnds()
})

onBeforeUnmount(() => map?.remove())

watch(() => props.avoided, drawAvoided)
watch(() => props.radars, drawRadars)
watch(() => props.sections, drawSections)
watch(() => props.route, () => drawRoute(true))
watch(() => props.stops, drawStops, { deep: true })
watch(() => [props.from, props.to], drawEnds)
</script>

<template>
  <div ref="el" class="map" :class="{ adding: addMode }" role="application" aria-label="Rota haritası"></div>
</template>

<style scoped>
.map {
  width: 100%;
  height: min(62vh, 520px);
  border-radius: 10px;
  border: 1.5px solid var(--line);
  overflow: hidden;
  z-index: 0;
}
.map.adding {
  outline: 3px solid var(--sign);
  outline-offset: 2px;
  cursor: crosshair;
}
:deep(.stop-pin) {
  display: grid;
  place-items: center;
  background: var(--sign);
  color: #fff;
  border: 3px solid #fff;
  border-radius: 50%;
  font: 800 13px/1 var(--display);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
:deep(.radar-pin) {
  display: grid;
  place-items: center;
  background: #fff;
  color: #111;
  border: 3px solid #d62828;
  border-radius: 50%;
  font: 800 10px/1 var(--display);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
:deep(.leaflet-container) {
  font-family: var(--body);
}
</style>
