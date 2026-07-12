/* sw.js — 앱 셸 오프라인 캐시 (지도 타일은 온라인 필요) */
var CACHE = 'runclub-v3';
var ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/storage.js',
  './js/audio.js',
  './js/programs.js',
  './js/achievements.js',
  './js/tracker.js',
  './js/map.js',
  './js/stats.js',
  './js/app.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = e.request.url;
  // 지도 타일 등 실시간 리소스만 항상 네트워크 (Leaflet은 캐시 사용 가능하도록 유지)
  if (url.indexOf('cartocdn') > -1 || url.indexOf('openstreetmap') > -1) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request).catch(function () { return caches.match('./index.html'); });
    })
  );
});
