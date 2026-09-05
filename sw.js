// ✅ 完整版（有緩存、離線功能、更新機制）
const CACHE_NAME = 'taxi-service-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/logo.jpeg',
  '/icon.jpeg',
  '/icon192.jpeg',
  '/icon512.jpeg',
  '/comf.jpeg',
  '/m7.jpeg',
  '/e9.jpeg',
  '/bee.jpeg',
  '/NOAH.jpeg',
  '/wecomcode.jpeg',
  '/hotline.jpeg'
];

// 安裝 Service Worker 時緩存所有重要檔案
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting())
  );
});

// 啟動時清理舊版緩存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 攔截請求，優先使用緩存（離線可用）
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // 如果緩存有，直接回傳緩存
        if (response) {
          return response;
        }
        
        // 如果緩存冇，去網路請求
        return fetch(event.request).then(response => {
          // 檢查是否有效回應
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          
          // 複製回應（因為緩存同瀏覽器共用）
          const responseToCache = response.clone();
          
          caches.open(CACHE_NAME)
            .then(cache => {
              cache.put(event.request, responseToCache);
            });
          
          return response;
        });
      })
      .catch(() => {
        // 如果網路都失敗，回傳離線頁面（如有）
        // 或者回傳一個簡單嘅離線提示
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      })
  );
});