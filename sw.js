// ✅ 完整版（HTML / CSS / JS 網路優先，圖片快取優先，離線可用）
const CACHE_NAME = 'taxi-service-__BUILD_VERSION__';
const urlsToCache = [
  '/',
  '/index.html',
  // ⭐ theme.css / theme.js 唔預緩存（避免 install 時撞到舊 HTTP cache）
  //    佢哋有自己嘅 network-first handler，第一次請求時會自動 cache
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
    // 舊瀏覽器唔支援 cache option，fallback 用普通 fetch
    return fetch(request);
  }
}

// =========================================================
// Fetch 攔截
// =========================================================
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 只處理同源請求（Google Maps / FontAwesome / Tailwind CDN 等跳過）
  if (url.origin !== self.location.origin) {
    return;
  }

  // 只處理 GET（POST / PUT 等直接交返俾瀏覽器）
  if (event.request.method !== 'GET') {
    return;
  }

  // ── 1) HTML：網路優先（reload 模式），失敗先 fallback cache ──
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

  // ── 2) CSS / JS：網路優先（reload 模式）⭐ 斷尾關鍵 ──
  if (isCSSorJS(url)) {
    event.respondWith(
      fetchFresh(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // ── 3) 圖片 / 字體：快取優先（快，唔常變）──
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

  // ── 4) 其他同源請求：network-first fallback cache ──
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