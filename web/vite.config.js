import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Dos aplicaciones, un solo proyecto.
 *
 *   /            El sistema del personal del ISP.
 *   /portal/     El portal del abonado.
 *
 * Comparten el código de utilidad —el formato del dinero, la marca— pero se
 * compilan por separado: el abonado no descarga el sistema de gestión, y cada
 * uno se puede publicar en un dominio distinto y protegerse por su cuenta.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    /**
     * El técnico instala la app en el teléfono y trabaja sin señal.
     *
     * ── `autoUpdate`, y por qué importa ──
     *
     * Con `prompt`, el técnico tendría que aceptar un cartel de "hay una versión
     * nueva". En la calle eso se cierra sin leer, y termina trabajando durante
     * semanas con una versión vieja que quizá tiene el error que se arregló
     * ayer. Se actualiza sola en la siguiente apertura.
     *
     * ── Qué se guarda y qué no ──
     *
     * Se precachean el código y los estilos: es lo que hace que la app abra sin
     * señal. Los DATOS no se cachean acá — de eso se ocupa la cola, que es la
     * que sabe distinguir un dato que se puede mostrar viejo de uno que no.
     */
    VitePWA({
      registerType: 'autoUpdate',
      // El portal del abonado se compila aparte y no es una app instalable: si
      // se precachearan sus assets, cada técnico bajaría un portal que nunca va
      // a abrir.
      filename: 'sw.js',
      includeAssets: ['favicon.svg', 'icono-192.png', 'icono-512.png'],
      manifest: {
        name: 'Taller SmartOLT — Campo',
        short_name: 'Campo',
        description: 'Órdenes, tickets y materiales del técnico de campo.',
        lang: 'es',
        // Arranca en la app de campo y no en la raíz: quien instala esto en el
        // teléfono es el técnico, y mandarlo al sistema de escritorio para que
        // desde ahí navegue a lo suyo es un paso de más todos los días.
        start_url: '/campo',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#E4E9F0',
        theme_color: '#0369A1',
        icons: [
          { src: '/icono-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icono-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icono-512.png',
            sizes: '512x512',
            type: 'image/png',
            // `maskable` es lo que evita que Android recorte el ícono en un
            // círculo y le coma la mitad.
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // El bundle principal supera el límite por defecto de 2 MB. Sin esto,
        // el archivo más importante es justamente el que no se precachea, y la
        // app no abre sin señal — que es todo el punto.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // El portal del abonado queda afuera.
        //
        // `**/portal/**` no alcanzaba: ahí adentro solo cae `portal/index.html`.
        // El JS del portal se compila en `assets/portal-*.js`, así que se
        // precacheaba igual y cada técnico bajaba un portal que nunca va a
        // abrir. Se comprobó leyendo la lista del `sw.js` generado — el patrón
        // parecía correcto y no lo era.
        globIgnores: ['**/portal/**', '**/assets/portal-*'],
        navigateFallback: '/index.html',
        // Las llamadas a la API nunca se sirven desde el caché: una lista de
        // órdenes de ayer mostrada como si fuera de hoy es peor que una pantalla
        // vacía que dice "sin conexión".
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // Las fotos ya subidas sí: son inmutables y pesan.
            urlPattern: /\/storage\/v1\/object\/sign\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'fotos',
              expiration: { maxEntries: 120, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
        ],
      },
      devOptions: {
        // Apagado en desarrollo a propósito: un service worker cacheando
        // durante el desarrollo es exactamente cómo se pierde media tarde
        // depurando un cambio que sí estaba en el disco.
        enabled: false,
      },
    }),
  ],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: {
        principal: resolve(process.cwd(), 'index.html'),
        portal: resolve(process.cwd(), 'portal/index.html'),
      },
    },
  },
})
