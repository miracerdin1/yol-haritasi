import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { VitePWA } from 'vite-plugin-pwa'

// Tek bir index.html üretir: Netlify ya da herhangi bir yere
// yüklenip telefondan açılabilir.
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    viteSingleFile(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'inline',
      // Tek dosyalık index.html'i workbox'ın kendi glob taraması yerine (bu depoda
      // içerik değişse de revizyonu `null` üretip güncellemeyi atlayan bir sorun
      // var) sayfa her açılışta önce ağdan denenip başarısız olursa önbellekten
      // sunulacak şekilde runtimeCaching ile ele alıyoruz. Statik ikonlar ise
      // includeAssets üzerinden (her zaman doğru içerik özetiyle) önbelleğe alınır.
      includeAssets: ['favicon.svg', 'favicon-32.png', 'icons/apple-touch-icon.png'],
      workbox: {
        globPatterns: [],
        navigateFallback: undefined,
        // injectRegister 'inline' iken eklenti bunları kendisi açmıyor; kapalıyken yeni
        // service worker, ana ekrandaki uygulama tamamen kapanana kadar bekliyor ve
        // telefon eski sürümde/eski veride takılı kalıyordu.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: { cacheName: 'app-shell', networkTimeoutSeconds: 3 },
          },
          {
            // Yol ve ücret verisi haftalık tazeleniyor: önce ağ, çevrimdışıyken son kopya
            urlPattern: ({ url }) => url.pathname.endsWith('/data/prebuilt.json'),
            handler: 'NetworkFirst',
            options: { cacheName: 'data', networkTimeoutSeconds: 8 },
          },
        ],
      },
      manifest: {
        name: 'Yol Haritası',
        short_name: 'Yol Haritası',
        description: 'Otoyol ve şehir içi rota planlayıcı',
        lang: 'tr',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0b6b3a',
        theme_color: '#0b6b3a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
