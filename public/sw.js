// 앱 셸의 기본 캐시만 제공한다. AI API 응답이나 음성 파일은 저장하지 않는다.
const CACHE = 'sueon-attempt3-appshell';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('sueon-') && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// 오프라인 번역을 보장하지 않으므로 API·HTML·3D 데이터는 캐시하지 않는다.
self.addEventListener('fetch', () => {});
