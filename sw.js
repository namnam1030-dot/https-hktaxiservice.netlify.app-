self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
    // 預設直接通過網路請求
});
