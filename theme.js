/* =========================================================
   theme.js — 共用主題 / 浮標 / 安裝指南腳本
   適用：index / result / fleet / booking / booking-success
   ========================================================= */

// ============================================
// 主題系統
// ============================================
const systemThemeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function applyTheme(isLight) {
    if (isLight) document.body.classList.add('light-theme');
    else document.body.classList.remove('light-theme');
}

function toggleTheme() {
    const isCurrentlyLight = document.body.classList.contains('light-theme');
    const newIsLight = !isCurrentlyLight;
    applyTheme(newIsLight);
    localStorage.setItem('taxiTheme', newIsLight ? 'light' : 'dark');
    localStorage.setItem('taxiThemeUserOverride', '1');
}

function initTheme() {
    const saved = localStorage.getItem('taxiTheme');
    const isUserOverride = localStorage.getItem('taxiThemeUserOverride') === '1';
    if (isUserOverride && (saved === 'light' || saved === 'dark')) {
        applyTheme(saved === 'light');
    } else {
        const systemIsLight = systemThemeQuery ? systemThemeQuery.matches : false;
        applyTheme(systemIsLight);
    }
}

function setupSystemThemeListener() {
    if (!systemThemeQuery) return;
    const handler = (e) => {
        const isUserOverride = localStorage.getItem('taxiThemeUserOverride') === '1';
        if (!isUserOverride) applyTheme(e.matches);
    };
    if (systemThemeQuery.addEventListener) systemThemeQuery.addEventListener('change', handler);
    else if (systemThemeQuery.addListener) systemThemeQuery.addListener(handler);
}

// ============================================
// Mini 浮標
// ============================================
let miniFloatLastToggle = 0;
function toggleMiniFloat() {
    const now = Date.now();
    if (now - miniFloatLastToggle < 200) return;
    miniFloatLastToggle = now;

    const el = document.getElementById('mini-float');
    const icon = document.getElementById('mini-float-icon');
    if (!el) return;
    el.classList.toggle('minimized');
    const isMinimized = el.classList.contains('minimized');
    if (icon) icon.className = isMinimized ? 'fa-solid fa-sliders' : 'fa-solid fa-xmark';
    localStorage.setItem('taxiMiniFloatMinimized', isMinimized ? '1' : '0');
}

function initMiniFloat() {
    const el = document.getElementById('mini-float');
    const icon = document.getElementById('mini-float-icon');
    if (!el) return;
    if (localStorage.getItem('taxiMiniFloatMinimized') === '1') {
        el.classList.add('minimized');
        if (icon) icon.className = 'fa-solid fa-sliders';
    } else {
        el.classList.remove('minimized');
        if (icon) icon.className = 'fa-solid fa-xmark';
    }
}

let miniFloatToggleInitialized = false;
function setupMiniFloatToggleButton() {
    if (miniFloatToggleInitialized) return;
    miniFloatToggleInitialized = true;

    const toggleBtn = document.getElementById('mini-float-toggle-btn');
    if (!toggleBtn) return;

    if (window.PointerEvent) {
        toggleBtn.addEventListener('pointerdown', function(e) {
            if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            toggleMiniFloat();
        }, { passive: false });
    } else {
        toggleBtn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            toggleMiniFloat();
        }, { passive: false });
        toggleBtn.addEventListener('click', function(e) {
            e.preventDefault();
            toggleMiniFloat();
        });
    }
}

function positionMiniFloat() {
    const header = document.querySelector('header');
    const miniFloat = document.getElementById('mini-float');
    if (!header || !miniFloat) return;
    if (getComputedStyle(miniFloat).position === 'relative') return;
    miniFloat.style.top = (header.offsetHeight + 8) + 'px';
}

function adjustBodyPaddingForHeader() {
    const header = document.querySelector('header');
    if (header) {
        const headerHeight = header.offsetHeight;
        document.body.style.paddingTop = headerHeight + 'px';
        document.documentElement.style.scrollPaddingTop = headerHeight + 'px';
    }
    positionMiniFloat();
}

function setupHeaderResizeObserver() {
    const header = document.querySelector('header');
    if (!header) return;
    if (window.ResizeObserver) {
        const observer = new ResizeObserver(adjustBodyPaddingForHeader);
        observer.observe(header);
    }
}

// ============================================
// 安裝指南彈窗
// ============================================
function showInstallGuide() {
    const modal = document.getElementById('install-modal');
    if (!modal) return;
    const content = document.getElementById('install-guide-content');
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const lang = (typeof currentLang !== 'undefined') ? currentLang : 'zh';

    if (isIOS) {
        content.innerHTML = lang === 'en' ? `
            <p><strong>1.</strong> Tap the Share button <i class="fa-solid fa-arrow-up-from-bracket text-brand-yellow"></i> at the bottom of Safari.</p>
            <p class="mt-1"><strong>2.</strong> Scroll down and tap <span class="text-brand-yellow font-bold">"Add to Home Screen"</span>.</p>
            <p class="mt-1"><strong>3.</strong> Tap "Add" in the top right corner to complete!</p>
        ` : `
            <p><strong>1.</strong> 點擊 Safari 瀏覽器下方的分享按鈕 <i class="fa-solid fa-arrow-up-from-bracket text-brand-yellow"></i>。</p>
            <p class="mt-1"><strong>2.</strong> 向下捲動並點選 <span class="text-brand-yellow font-bold">「加入主畫面」</span>。</p>
            <p class="mt-1"><strong>3.</strong> 點擊右上角的「新增」即可完成！</p>
        `;
    } else {
        content.innerHTML = lang === 'en' ? `
            <p><strong>1.</strong> Tap the menu button <i class="fa-solid fa-ellipsis-vertical text-brand-yellow"></i> in the top right corner of Chrome.</p>
            <p class="mt-1"><strong>2.</strong> Tap <span class="text-brand-yellow font-bold">"Add to Home Screen"</span> or <span class="text-brand-yellow font-bold">"Install App"</span>.</p>
            <p class="mt-1"><strong>3.</strong> Confirm to complete installation!</p>
        ` : `
            <p><strong>1.</strong> 點擊 Chrome 瀏覽器右上角的選單按鈕 <i class="fa-solid fa-ellipsis-vertical text-brand-yellow"></i>。</p>
            <p class="mt-1"><strong>2.</strong> 點選 <span class="text-brand-yellow font-bold">「加到主畫面」</span> 或 <span class="text-brand-yellow font-bold">「安裝應用程式」</span>。</p>
            <p class="mt-1"><strong>3.</strong> 確認新增即可完成安裝！</p>
        `;
    }
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function closeInstallGuide() {
    const modal = document.getElementById('install-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.display = 'none';
}

// ============================================
// 自動初始化
// ============================================
document.addEventListener('DOMContentLoaded', function() {
    initTheme();
    setupSystemThemeListener();
    initMiniFloat();
    setupMiniFloatToggleButton();
    adjustBodyPaddingForHeader();
    setupHeaderResizeObserver();
});

window.addEventListener('load', () => {
    adjustBodyPaddingForHeader();
    setTimeout(adjustBodyPaddingForHeader, 100);
    setTimeout(adjustBodyPaddingForHeader, 500);
});

window.addEventListener('resize', adjustBodyPaddingForHeader);

if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(adjustBodyPaddingForHeader);
}