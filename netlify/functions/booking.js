// ============================================
// 的士預約 - Discord + Telegram 通知系統 (預約訂單專用)
// ⭐ 即時訂單已由 Netlify 直接發送，唔會入日曆，所以 GAS 只處理預約單同手動加嘅單
// ⭐ 已合併 checkNewEvents + checkUpcomingEvents
// ============================================

// ===== 設定 =====
const CALENDAR_ID = '2ec3b3fe66e8b92177020221e964e8e96324e90447cedbb4c395b9bb3926bb7c@group.calendar.google.com';

// ⚠️ 注意：呢度請填「預約訂單」群組嘅 Webhook 同 Chat ID
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1555182258883924019/21nhg_H_o_KmnAIeUruYTgh4V43fbXSq8aiAlGWuDFK6U0EQRKD7AsCkp9MSXYQZiWhy'; // 請確保呢個係預約群組嘅 Webhook

const TELEGRAM_BOT_TOKEN = '8687704614:AAEiaeA7_Jpx4BKyWHmDDUsQJ0ys9aT-yYk';
const TELEGRAM_CHAT_ID = '-5227933482'; // ⚠️ 呢個係「的士預約通知」群組嘅 ID

const UPCOMING_WINDOW_MINUTES = 30;

// ===== 同事 Gmail → 顯示名 對照表 =====
const CREATOR_NAME_MAP = {
  'taxi-booking@lateral-music-507017-e8.iam.gserviceaccount.com':  '網站預約',
  'ceo-taxi-calender@hktaxi-504613.iam.gserviceaccount.com':  'ceotaxi',
  '852hktaxi@gmail.com':  'CEO-taxi',
  'hktaxi688@gmail.com':  '藍叔',
  'lhimtaxi@gmail.com':   '謙叔',
  'johnbbchan@gmail.com': '鬼陳',
  '4884mark@gmail.com':   '伍叔',
  'chiho491@gmail.com':   '濠叔',
  'chingcc9999@gmail.com':'正叔',
  'nobo37312@gmail.com':'寶哥',
  'txavengers@gmail.com':'藍叔',
  'tom986hk@gmail.com':'光仔',
  'whoami1238@gmail.com':'暉哥'
};

function getCreatorDisplayName(email) {
  if (!email || email === '(未知)') return '(未知)';
  const key = email.toLowerCase().trim();
  return CREATOR_NAME_MAP[key] || email;
}

function getEventCreatorCached(calendarId, eventId) {
  const cache = CacheService.getScriptCache();
  const key = 'creator_v2_' + eventId;
  const cached = cache.get(key);
  if (cached) return cached;

  let email = '(未知)';
  try {
    const cleanId = eventId.split('@')[0];
    const ev = Calendar.Events.get(calendarId, cleanId);
    if (ev.creator && ev.creator.email) email = ev.creator.email;
  } catch (e) {
    console.error('拎建立者失敗 (' + eventId + ')：' + e.message);
  }

  cache.put(key, email, 3600);
  return email;
}

// ============================================
// Telegram 發送
// ============================================
function convertToTelegramHtml(text) {
  if (!text) return '';
  let result = String(text);

  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
    return String(code).trim();
  });

  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  // ⭐ 先處理「粗體 + 連結」：**[text](url)**
  result = result.replace(/\*\*\[([^\]]+)\]\(<([^>]+)>\)\*\*/g, function(m, text, url) {
    if (url.startsWith('tel:')) return '<b>' + text.replace(/\s/g, '') + '</b>';
    return '<a href="' + url + '"><b>' + text + '</b></a>';
  });
  result = result.replace(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/g, function(m, text, url) {
    if (url.startsWith('tel:')) return '<b>' + text.replace(/\s/g, '') + '</b>';
    return '<a href="' + url + '"><b>' + text + '</b></a>';
  });

  // 普通連結
  result = result.replace(/\[([^\]]+)\]\(<([^>]+)>\)/g, function(m, text, url) {
    if (url.startsWith('tel:')) return text.replace(/\s/g, '');
    return '<a href="' + url + '">' + text + '</a>';
  });
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(m, text, url) {
    if (url.startsWith('tel:')) return text.replace(/\s/g, '');
    return '<a href="' + url + '">' + text + '</a>';
  });

  // 普通粗體
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  const placeholders = [];
  result = result.replace(/<a href="[^"]+">[\s\S]*?<\/a>|<b>[^<]+<\/b>|<code>[^<]+<\/code>/g, function(m) {
    placeholders.push(m);
    return '\u0000' + (placeholders.length - 1) + '\u0000';
  });

  result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  result = result.replace(/\u0000(\d+)\u0000/g, function(_, idx) {
    return placeholders[parseInt(idx, 10)];
  });

  return result;
}

function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram 未設定，跳過');
    return false;
  }

  const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
  const htmlMessage = convertToTelegramHtml(message);

  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = htmlMessage;
  while (remaining.length > MAX_LEN) {
    let cut = remaining.lastIndexOf('\n', MAX_LEN);
    if (cut < MAX_LEN / 2) cut = MAX_LEN;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);

  let allSuccess = true;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: chunks[i],
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }),
        muteHttpExceptions: true
      });

      const code = response.getResponseCode();
      if (code === 200) {
        console.log('✅ Telegram 發送成功');
      } else {
        console.error('❌ Telegram 失敗：' + response.getContentText());
        allSuccess = false;
      }
      if (i < chunks.length - 1) Utilities.sleep(1000);
    } catch (e) {
      console.error('❌ Telegram 拋錯：' + e.message);
      allSuccess = false;
    }
  }
  return allSuccess;
}

// ============================================
// ⭐ 將 Calendar 純文字還原為可點擊連結（電話加粗）
// ============================================
function restoreContactLinks(text) {
  if (!text) return text;
  return text.replace(
    /📞\s*(\d[\d\s\-]*?)\s*\|\s*WhatsApp[：:]\s*(https?:\/\/wa\.me\/\S+)/g,
    function(match, phone, waUrl) {
      var phoneTrimmed = String(phone).trim();
      var phoneClean = phoneTrimmed.replace(/\D/g, '');
      var phoneWithCode = phoneClean.length === 8 ? '852' + phoneClean : phoneClean;
      // ⭐ 電話號碼用粗體
      return '📞 **[' + phoneTrimmed + '](tel:' + phoneWithCode + ')** | [WhatsApp](<' + waUrl + '>)';
    }
  );
}

// ============================================
// ⭐ 主函數：合併 checkNewEvents + checkUpcomingEvents
// ============================================
function checkAllEvents() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(90000)) {
    console.log('前一個執行未完成，跳過');
    return;
  }

  try {
    Utilities.sleep(Math.floor(Math.random() * 500));

    const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
    if (!calendar) {
      console.error('❌ 搵唔到日曆');
      return;
    }

    try {
      runCheckNewEvents(calendar);
    } catch (e) {
      console.error('[checkAllEvents] checkNewEvents 出錯：' + e.message);
    }

    try {
      runCheckUpcomingEvents(calendar);
    } catch (e) {
      console.error('[checkAllEvents] checkUpcomingEvents 出錯：' + e.message);
    }

  } finally {
    lock.releaseLock();
  }
}

// ============================================
// 內部函數 1：檢查新建立事件
// ============================================
function runCheckNewEvents(calendar) {
  const now = new Date();
  const twentyMinutesAgo = new Date(now.getTime() - 20 * 60 * 1000);
  const fourDaysLater = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);

  const allRecentEvents = calendar.getEvents(twentyMinutesAgo, fourDaysLater);
  const newEvents = allRecentEvents.filter(event => {
    const createdTime = event.getDateCreated();
    if (!createdTime) return false;
    return createdTime >= twentyMinutesAgo && createdTime <= now;
  });

  console.log('[NewEvents] 發現 ' + newEvents.length + ' 個新建立嘅事件');
  if (newEvents.length === 0) return;

  const scriptProperties = PropertiesService.getScriptProperties();
  let notifiedEvents = JSON.parse(scriptProperties.getProperty('notified_new') || '[]');

  newEvents.forEach(event => {
    const eventId = event.getId();

    if (notifiedEvents.includes(eventId)) {
      console.log('[NewEvents] 已通知過，跳過：' + event.getTitle());
      return;
    }

    const rawDescription = event.getDescription() || '';

    if (rawDescription.includes('[網站預約]')) {
      console.log('[NewEvents] 網站提交嘅事件，跳過：' + event.getTitle());
      notifiedEvents.push(eventId);
      notifiedEvents = notifiedEvents.slice(-100);
      scriptProperties.setProperty('notified_new', JSON.stringify(notifiedEvents));
      return;
    }

    const description = rawDescription
      .replace('[新事件已通知]', '')
      .replace('[網站預約]', '')
      .replace('[30分鐘通知已發送]', '')
      .trim();

    const title = event.getTitle();
    const startTime = event.getStartTime();
    const creatorEmail = getEventCreatorCached(CALENDAR_ID, eventId);
    const creatorName = getCreatorDisplayName(creatorEmail);

    const cleanDesc = (description || '').trim();

    let discordMessage =
      '🚕 ' + title + '\n' +
      '⏰ 開始：' + startTime.toLocaleString('zh-HK') + '\n' +
      '👤 新增者：' + creatorName;

    if (cleanDesc) discordMessage += '\n\n' + cleanDesc;
    discordMessage += '\n\n🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴';

    const success = sendDiscordNotification(DISCORD_WEBHOOK, discordMessage);
    if (success.success) {
      sendTelegramNotification(discordMessage);
    }

    Utilities.sleep(1200);

    if (success.success) {
      notifiedEvents.push(eventId);
      notifiedEvents = notifiedEvents.slice(-100);
      scriptProperties.setProperty('notified_new', JSON.stringify(notifiedEvents));
      console.log('[NewEvents] ✅ 已發送：' + title + '（' + creatorName + '）');
    } else {
      console.error('[NewEvents] ❌ 發送失敗：' + title);
    }
  });
}

// ============================================
// ⭐ 內部函數 2：檢查即將開始事件
// ============================================
function runCheckUpcomingEvents(calendar) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + UPCOMING_WINDOW_MINUTES * 60 * 1000);
  const upcomingEvents = calendar.getEvents(now, windowEnd);

  console.log('[Upcoming] 發現 ' + upcomingEvents.length + ' 個事件（窗口 ' + UPCOMING_WINDOW_MINUTES + ' 分鐘）');

  const scriptProperties = PropertiesService.getScriptProperties();
  let notifiedEvents = JSON.parse(scriptProperties.getProperty('notified_30min') || '[]');

  const pendingEvents = [];
  upcomingEvents.forEach(event => {
    const eventId = event.getId();
    if (notifiedEvents.includes(eventId)) {
      console.log('[Upcoming] 已通知過，跳過：' + event.getTitle());
      return;
    }

    const title = event.getTitle();
    const startTime = event.getStartTime();
    const rawDescription = event.getDescription() || '';
    const minutesUntil = Math.round((startTime - now) / (1000 * 60));

    // ⭐ 判斷係咪網站預約
    const isWebsiteBooking = rawDescription.indexOf('[網站預約]') >= 0;

    // ⭐ 提取完整原裝內容（去掉網站預約等標記）
    let fullDescription = rawDescription
      .replace('[網站預約]', '')
      .replace('[新事件已通知]', '')
      .replace('[30分鐘通知已發送]', '')
      .replace('👤 工作人員落單', '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // ⭐ 還原電話 / WhatsApp 可點擊連結（電話加粗）
    fullDescription = restoreContactLinks(fullDescription);

    // ⭐ 提取訂單編號
    let bookingId = '';
    const idMatch = fullDescription.match(/🆔\s*`(\d{4})`/);
    if (idMatch) {
      bookingId = idMatch[1];
      if (fullDescription.indexOf('查看/修改訂單') < 0) {
        fullDescription = fullDescription.replace(
          new RegExp('🆔\\s*`' + bookingId + '`', 'g'),
          '🆔 `' + bookingId + '` | [📋 查看/修改訂單](<https://hktaxiservice.netlify.app/booking.html?edit=' + bookingId + '>)'
        );
      }
    }

    const creatorEmail = getEventCreatorCached(CALENDAR_ID, eventId);
    const creatorName = getCreatorDisplayName(creatorEmail);

    // ⭐ 同事手動新增嘅活動：補返標題、開始時間、新增者
    if (!isWebsiteBooking) {
      const parts = [];
      parts.push('🚕 ' + title);
      parts.push('⏰ 開始：' + startTime.toLocaleString('zh-HK'));
      parts.push('👤 新增者：' + creatorName);
      if (fullDescription) {
        parts.push('');
        parts.push(fullDescription);
      }
      fullDescription = parts.join('\n');
    }

    pendingEvents.push({
      id: eventId,
      title: title,
      startTime: startTime,
      minutesUntil: minutesUntil,
      bookingId: bookingId,
      creatorName: creatorName,
      fullDescription: fullDescription
    });
  });

  if (pendingEvents.length === 0) {
    console.log('[Upcoming] 冇新事件要通知');
    return;
  }

  console.log('[Upcoming] 準備通知 ' + pendingEvents.length + ' 個事件');

  const MAX_MSG_LEN = 1900;
  const batches = [];
  let currentBatch = [];

  pendingEvents.forEach(ev => {
    currentBatch.push(ev);
    const testMsg = buildUpcomingMessage(currentBatch);
    if (testMsg.length > MAX_MSG_LEN) {
      currentBatch.pop();
      if (currentBatch.length > 0) batches.push(currentBatch);
      currentBatch = [ev];
    }
  });
  if (currentBatch.length > 0) batches.push(currentBatch);

  console.log('[Upcoming] 分 ' + batches.length + ' 批發送');

  let allSuccess = true;

  batches.forEach((batch, batchIdx) => {
    const message = buildUpcomingMessage(batch);
    console.log('[Upcoming] 批次 ' + (batchIdx + 1) + '/' + batches.length + '：' + batch.length + ' 個 event，' + message.length + ' 字');

    batch.forEach(ev => {
      notifiedEvents.push(ev.id);
    });
    notifiedEvents = notifiedEvents.slice(-100);
    scriptProperties.setProperty('notified_30min', JSON.stringify(notifiedEvents));

    let success = false;
    try {
      const result = sendDiscordNotification(DISCORD_WEBHOOK, message);
      sendTelegramNotification(message);
      success = result.success;
    } catch (e) {
      console.error('[Upcoming] ❌ 發送時拋錯：' + e.message);
      success = false;
    }

    if (!success) {
      allSuccess = false;
      console.error('[Upcoming] ❌ 批次 ' + (batchIdx + 1) + ' 失敗，移除標記下次重試');

      let currentNotified = JSON.parse(scriptProperties.getProperty('notified_30min') || '[]');
      batch.forEach(ev => {
        currentNotified = currentNotified.filter(id => id !== ev.id);
      });
      currentNotified = currentNotified.slice(-100);
      scriptProperties.setProperty('notified_30min', JSON.stringify(currentNotified));
    } else {
      console.log('[Upcoming] ✅ 批次 ' + (batchIdx + 1) + ' 成功');
    }

    if (batchIdx < batches.length - 1) {
      Utilities.sleep(2500);
    }
  });

  if (!allSuccess) {
    console.error('[Upcoming] ⚠️ 有批次失敗，未標記嘅會下次再試');
  }
}

// ============================================
// 砌「即將開始」訊息
// ============================================
function buildUpcomingMessage(events) {
  const count = events.length;

  let maxMinutes = 0;
  events.forEach(ev => {
    if (ev.minutesUntil > maxMinutes) maxMinutes = ev.minutesUntil;
  });

  const header = count > 1
    ? '⏰ **訂單即將開始**（' + count + ' 個）| ⏳ 仲有 ' + maxMinutes + ' 分鐘'
    : '⏰ **訂單即將開始** | ⏳ 仲有 ' + maxMinutes + ' 分鐘';

  const parts = [header, ''];

  events.forEach((ev, idx) => {
    if (idx > 0) {
      parts.push('');
      parts.push('=============================');
      parts.push('');
    }
    parts.push(ev.fullDescription);
  });

  parts.push('');
  parts.push('🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴');

  return parts.join('\n');
}

// ============================================
// Discord 發送
// ============================================
function sendDiscordNotification(webhook, message) {
  if (!webhook || webhook === '') {
    console.error('❌ Webhook URL 為空');
    return { success: false, messageId: null };
  }

  const urlWithWait = webhook + (webhook.indexOf('?') >= 0 ? '&' : '?') + 'wait=true';
  const maxRetries = 5;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const response = UrlFetchApp.fetch(urlWithWait, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ content: message, flags: 4 }),
        muteHttpExceptions: true
      });

      const responseCode = response.getResponseCode();

      if (responseCode === 200 || responseCode === 204) {
        let messageId = null;
        try {
          const json = JSON.parse(response.getContentText());
          if (json && json.id) messageId = json.id;
        } catch (e) {}
        console.log('✅ Discord 成功（attempt ' + (attempt + 1) + '）' + (messageId ? '，id=' + messageId : ''));
        return { success: true, messageId: messageId };
      }

      if (responseCode === 429) {
        let waitSec = 3;
        try {
          const headers = response.getHeaders();
          const retryAfter = headers['Retry-After'] || headers['retry-after'] ||
                             headers['X-RateLimit-Reset-After'] || headers['x-ratelimit-reset-after'];
          if (retryAfter) {
            const parsed = parseFloat(retryAfter);
            if (!isNaN(parsed) && parsed > 0) waitSec = parsed;
          }
        } catch (e) {}

        const MAX_WAIT_SEC = 30;
        if (waitSec > MAX_WAIT_SEC) waitSec = MAX_WAIT_SEC;

        const waitMs = Math.ceil(waitSec * 1000) + 500;
        console.warn('⏳ 429 Rate Limit，等 ' + waitMs + 'ms（' + (attempt + 1) + '/' + maxRetries + '）');
        Utilities.sleep(waitMs);
        attempt++;
        continue;
      }

      if (responseCode >= 500) {
        const waitMs = (attempt + 1) * 2000;
        console.warn('⏳ ' + responseCode + ' Server Error，等 ' + waitMs + 'ms');
        Utilities.sleep(waitMs);
        attempt++;
        continue;
      }

      console.error('❌ Discord 回應 ' + responseCode + '：' + response.getContentText());
      return { success: false, messageId: null };

    } catch (error) {
      console.error('❌ Discord 拋錯（attempt ' + (attempt + 1) + '）：' + error.message);
      attempt++;
      if (attempt >= maxRetries) return { success: false, messageId: null };
      Utilities.sleep(2000);
    }
  }

  console.error('❌ Discord 重試 ' + maxRetries + ' 次仍然失敗');
  return { success: false, messageId: null };
}

// ============================================
// 清理
// ============================================
function cleanupNotifiedEvents() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const notified30min = JSON.parse(scriptProperties.getProperty('notified_30min') || '[]');
  const notifiedNew = JSON.parse(scriptProperties.getProperty('notified_new') || '[]');

  if (notified30min.length > 500) {
    scriptProperties.setProperty('notified_30min', JSON.stringify(notified30min.slice(-500)));
  }
  if (notifiedNew.length > 500) {
    scriptProperties.setProperty('notified_new', JSON.stringify(notifiedNew.slice(-500)));
  }
  console.log('✅ 已清理通知記錄');
}

function clearAllNotifiedEvents() {
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.deleteProperty('notified_30min');
  scriptProperties.deleteProperty('notified_new');
  console.log('✅ 已完全清理所有通知記錄');
}

// ============================================
// 測試函數
// ============================================
function testDiscord() {
  const result = sendDiscordNotification(DISCORD_WEBHOOK, '🧪 Discord 測試訊息');
  console.log('Discord 測試：' + (result.success ? '✅ 成功' : '❌ 失敗'));
}

function testTelegram() {
  const result = sendTelegramNotification('🧪 Telegram 測試訊息');
  console.log('Telegram 測試：' + (result ? '✅ 成功' : '❌ 失敗'));
}

function testBoth() {
  sendDiscordNotification(DISCORD_WEBHOOK, '🧪 Discord 測試訊息');
  sendTelegramNotification('🧪 Telegram 測試訊息');
  console.log('已發送 Discord + Telegram 測試訊息');
}

function testCalendar() {
  const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
  if (calendar) console.log('✅ 成功連接日曆：' + calendar.getName());
  else console.log('❌ 搵唔到日曆');
}

function testCheckAllEvents() {
  console.log('=== 手動測試 checkAllEvents ===');
  checkAllEvents();
  console.log('=== 完成 ===');
}

// ⭐ 測試還原連結 + 粗體效果
function testRestoreLinks() {
  var sample = '👤 王先生 | 📞 51245677 | WhatsApp：https://wa.me/85251245677';
  console.log('原字串：' + sample);
  console.log('還原後：' + restoreContactLinks(sample));
}

function testNewEvents() {
  const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!calendar) { console.log('❌ 搵唔到日曆'); return; }

  const now = new Date();
  const twentyMinutesAgo = new Date(now.getTime() - 20 * 60 * 1000);
  const fourDaysLater = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
  const allRecentEvents = calendar.getEvents(twentyMinutesAgo, fourDaysLater);
  const newEvents = allRecentEvents.filter(event => {
    const createdTime = event.getDateCreated();
    return createdTime >= twentyMinutesAgo && createdTime <= now;
  });

  console.log('最近 20 分鐘內建立嘅事件數量：' + newEvents.length);
  newEvents.forEach(event => {
    console.log('---');
    console.log('標題：' + event.getTitle());
    console.log('建立時間：' + event.getDateCreated());
    console.log('開始時間：' + event.getStartTime());
    console.log('事件 ID：' + event.getId());
    console.log('建立者：' + getCreatorDisplayName(getEventCreatorCached(CALENDAR_ID, event.getId())));
  });
}

function testUpcomingMessageFormat() {
  const fakeEvents = [
    {
      id: 'test1',
      minutesUntil: 30,
      fullDescription:
        '🚕 order\n' +
        '⏰ 5/10/2026 下午10:00:00\n' +
        '👤 新增者：藍叔'
    },
    {
      id: 'test2',
      minutesUntil: 28,
      fullDescription:
        '🚕 order\n' +
        '⏰ 5/10/2026 下午10:00:00\n' +
        '👤 新增者：藍叔'
    },
    {
      id: 'test3',
      minutesUntil: 27,
      fullDescription:
        '🚕 🚕 Testing 22, 旺角香港 → Test, 元朗香港 - 接受混能以上任何車款\n' +
        '⏰ 5/10/2026 下午10:00:00\n' +
        '👤 新增者：網站預約\n' +
        '📞 **[11112222](tel:85211112222)** | [WhatsApp](<https://wa.me/85211112222>)'
    }
  ];

  const message = buildUpcomingMessage(fakeEvents);
  console.log('=== 測試訊息內容 ===');
  console.log(message);

  sendDiscordNotification(DISCORD_WEBHOOK, message);
  sendTelegramNotification(message);
  console.log('已發送測試訊息到 Discord + Telegram');
}

function listAllCalendars() {
  const calendars = CalendarApp.getAllCalendars();
  console.log('你嘅 Google 帳戶入面所有日曆：');
  calendars.forEach(cal => {
    console.log('日曆名稱：' + cal.getName());
    console.log('日曆 ID：' + cal.getId());
    console.log('---');
  });
}

function debugNameMap() {
  console.log('===== 開始診斷 =====');
  console.log('Map 內容：' + JSON.stringify(CREATOR_NAME_MAP));
  const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!calendar) { console.log('❌ 搵唔到日曆'); return; }

  const now = new Date();
  const events = calendar.getEvents(
    new Date(now.getTime() - 24 * 60 * 60 * 1000),
    new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000)
  );

  console.log('最近 24 小時至未來 4 日事件數量：' + events.length);

  events.slice(0, 10).forEach(ev => {
    const rawEmail = getEventCreatorCached(CALENDAR_ID, ev.getId());
    const key = String(rawEmail).toLowerCase().trim();
    const matched = CREATOR_NAME_MAP[key];
    console.log('-----');
    console.log('標題：' + ev.getTitle());
    console.log('實際 Email：[' + rawEmail + ']');
    console.log('map 對中？ ' + (matched ? '✅ ' + matched : '❌ 冇對中'));
  });
  console.log('===== 診斷完成 =====');
}

function listAllCreators() {
  const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!calendar) { console.log('❌ 搵唔到日曆'); return; }

  const now = new Date();
  const past = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const future = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const events = calendar.getEvents(past, future);
  const creators = new Set();
  events.forEach(ev => {
    creators.add(getEventCreatorCached(CALENDAR_ID, ev.getId()));
  });
  console.log('=== 所有建立者 email ===');
  creators.forEach(c => console.log("  '" + c + "': '',"));
}
