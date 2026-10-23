import type { LatLng } from './geo'
import type { Radar, Section } from './radars'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const coords = (pts: LatLng[]) => pts.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)},0`).join(' ')

const KIND: Record<Radar['kind'], string> = {
  hiz: 'Sabit radar',
  ortalama: 'Ortalama hız radarı',
  isik: 'Kırmızı ışık kamerası',
}

function line(name: string, pts: LatLng[], style: string, desc = ''): string {
  return `<Placemark><name>${esc(name)}</name>${desc ? `<description>${esc(desc)}</description>` : ''}<styleUrl>#${style}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coords(pts)}</coordinates></LineString></Placemark>`
}

function point(name: string, p: LatLng, style: string, desc = ''): string {
  return `<Placemark><name>${esc(name)}</name>${desc ? `<description>${esc(desc)}</description>` : ''}<styleUrl>#${style}</styleUrl><Point><coordinates>${coords([p])}</coordinates></Point></Placemark>`
}

/** Google My Maps'e yüklenebilen KML: rota, radar noktaları ve ortalama hız bölümleri. */
export function routeKml(route: LatLng[], radars: Radar[], sections: Section[], stops: LatLng[]): string {
  const style = (id: string, color: string, width: number) =>
    `<Style id="${id}"><LineStyle><color>${color}</color><width>${width}</width></LineStyle></Style>`
  const pin = (id: string, color: string) =>
    `<Style id="${id}"><IconStyle><color>${color}</color><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`
  const parts = [
    style('rota', 'ffb36b0b', 5),
    style('bolum', 'ff009ff7', 8),
    pin('radar', 'ff2828d6'),
    pin('durak', 'ffb36b0b'),
    line('Rota', route, 'rota'),
    ...sections.map((s) => {
      const km = (s.length / 1000).toFixed(1).replace('.', ',')
      return line(`Ortalama hız bölümü · ${km} km${s.maxspeed ? ` · ${s.maxspeed} km/s` : ''}`, s.line, 'bolum')
    }),
    ...radars.map((r) =>
      point(KIND[r.kind] + (r.maxspeed ? ` · ${r.maxspeed} km/s` : ''), r.p, 'radar'),
    ),
    ...stops.map((p, i) => point(`${i + 1}. durak`, p, 'durak')),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Rota ve radarlar</name>${parts.join('')}</Document></kml>`
}

export function downloadKml(kml: string, filename = 'rota-radarlar.kml'): void {
  const url = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
