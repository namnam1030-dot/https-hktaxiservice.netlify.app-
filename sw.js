// ✅ HTML：網絡優先（確保反閃黑邏輯最新）
// ✅ CSS / JS：緩存優先（加快載入，靠 CACHE_NAME 把關更新）
// ✅ 圖片 / 字體：緩存優先
const CACHE_NAME = 'taxi-service-__BUILD_VERSION__';
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

// =========================================================
// 安裝：預緩存核心檔案 + 即刻接管
// =========================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// =========================================================
// 啟動：清舊 cache + 接管所有 client
// =========================================================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// =========================================================
// 判斷請求類型
// =========================================================
function isHTML(request) {
  return request.mode === 'navigate' ||
         (request.headers.get('accept') || '').includes('text/html');
}

function isCSSorJS(url) {
  return /\.(css|js)(\?.*)?$/i.test(url.pathname);
}

function isStaticAsset(url) {
  return /\.(jpe?g|png|gif|webp|svg|ico|woff2?|ttf|otf)(\?.*)?$/i.test(url.pathname);
}

// ⭐ 用 reload 模式繞過瀏覽器 HTTP 緩存
function fetchFresh(request) {
  try {
    return fetch(request, { cache: 'reload' });
  } catch (e) {
    return fetch(request);
  }
}

// =========================================================
// Fetch 攔截
// =========================================================
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 只處理同源請求
  if (url.origin !== self.location.origin) return;

  // 只處理 GET
  if (event.request.method !== 'GET') return;

  // ── 1) HTML：網絡優先（確保反閃黑邏輯最新）──
  if (isHTML(event.request)) {
    event.respondWith(
      fetchFresh(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request).then(r => r || caches.match('/index.html'))
        )
    );
    return;
  }

  // ── 2) CSS / JS：緩存優先（加快載入）⭐ 改動位置 ──
  //      靠 CACHE_NAME 每次 build 一變就清空，唔怕舊版
  if (isCSSorJS(url)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetchFresh(event.request).then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // ── 3) 圖片 / 字體：緩存優先（不變）──
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        });
      })
    );
    return;
  }

  // ── 4) 其他同源請求：網絡優先 fallback cache ──
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// =========================================================
// 手動更新
// =========================================================
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});