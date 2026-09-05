// ✅ 完整版（網路優先，離線可用）
const CACHE_NAME = 'taxi-service-v2'; // 更新版本號，強制更新快取
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

// 攔截請求：HTML 使用網路優先，其他檔案使用緩存優先
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // 如果是 HTML 頁面（導航請求），使用網路優先策略
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // 更新緩存
          const responseToCache = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => {
              cache.put(event.request, responseToCache);
            });
          return response;
        })
        .catch(() => {
          // 網路失敗時，回傳緩存
          return caches.match(event.request)
            .then(response => {
              return response || caches.match('/index.html');
            });
        })
    );
    return;
  }
  
  // 其他檔案（圖片、CSS、JS）使用緩存優先
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        
        return fetch(event.request).then(response => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          
          const responseToCache = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => {
              cache.put(event.request, responseToCache);
            });
          
          return response;
        });
      })
      .catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      })
  );
});

// 監聽訊息，允許手動更新
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});