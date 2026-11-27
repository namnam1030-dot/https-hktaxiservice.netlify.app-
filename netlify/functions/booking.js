// ============================================
// 的士預約 - Discord + Telegram 通知系統
// ⭐ v2：日曆活動被修改 → 刪舊訊息 + 發新訊息
// ⭐ v2.1：cleanupNotifiedEvents 順便觸發 cleanupMsgIds
// ⭐ v3：日曆活動被刪除 → 刪除 Discord + TG 訊息
// ⭐ v3.1：修改通知「修改者」→「原新增者」
// ⭐ v4：網站預約刪除時同步刪除 TG/Discord 訊息
// ⭐ v4.4：TG 用 tel: 連結（Rich HTML），Discord 用 <tel:+852...> 尖括號，兩邊都可撥號
// ⭐ v4.5：修正 runCheckUpcomingEvents 內 const 重新賦值導致網站預約單冇 30 分鐘提醒
// ============================================

// ===== 設定 =====
const CALENDAR_ID = '2ec3b3fe66e8b92177020221e964e8e96324e90447cedbb4c395b9bb3926bb7c@group.calendar.google.com';

const scriptProperties = PropertiesService.getScriptProperties();
const DISCORD_WEBHOOK = scriptProperties.getProperty('DISCORD_WEBHOOK');
const TELEGRAM_BOT_TOKEN = scriptProperties.getProperty('TELEGRAM_BOT_TOKEN');
const TELEGRAM_CHAT_ID = scriptProperties.getProperty('TELEGRAM_CHAT_ID');

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

  result = result.replace(/\*\*\[([^\]]+)\]\(<([^>]+)>\)\*\*/g, function(m, text, url) {
    if (url.startsWith('tel:')) return '<b>' + text.replace(/\s/g, '') + '</b>';
    return '<a href="' + url + '"><b>' + text + '</b></a>';
  });
  result = result.replace(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/g, function(m, text, url) {
    if (url.startsWith('tel:')) return '<b>' + text.replace(/\s/g, '') + '</b>';
    return '<a href="' + url + '"><b>' + text + '</b></a>';
  });

  result = result.replace(/\[([^\]]+)\]\(<([^>]+)>\)/g, function(m, text, url) {
    if (url.startsWith('tel:')) return text.replace(/\s/g, '');
    return '<a href="' + url + '">' + text + '</a>';
  });
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(m, text, url) {
    if (url.startsWith('tel:')) return text.replace(/\s/g, '');
    return '<a href="' + url + '">' + text + '</a>';
  });

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

function escapeTelegramRichHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function normalizeTelegramDialNumber(value) {
  const display = String(value).trim();
  if (!/^\+?\d(?:[\d \t\u00a0-]*\d)?$/.test(display)) return '';
  if (/^(?:\d{1,2}-\d{1,2}-\d{2,4}|\d{4}-\d{1,2}-\d{1,2})$/.test(display)) return '';

  const compact = display.replace(/[ \t\u00a0-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  if (/^852\d{8}$/.test(compact)) return '+' + compact;
  if (/^\d{8}$/.test(compact)) return '+852' + compact;
  return '';
}

function convertToTelegramRichDialHtml(message) {
  const source = String(message || '');
  if (!source || source.length > 16000) return '';
  let hasDialLink = false;
  let inFence = false;
  const esc = escapeTelegramRichHtml;

  function dial(label, number) {
    const target = normalizeTelegramDialNumber(number);
    if (!target) return esc(label);
    hasDialLink = true;
    return '<a href="tel:' + target + '">' + esc(label) + '</a>';
  }

  function renderLine(line) {
    if (/^[ \t]*```/.test(line)) {
      inFence = !inFence;
      return '';
    }
    if (inFence) return esc(line);

    const standalone = line.match(/^([ \t]*(?:🚕[ \t]*)?)(\+[\d \t\u00a0-]*\d|\d{8}|\d{4}[ \t\u00a0-]+\d{4})([ \t]*)$/u);
    if (standalone && normalizeTelegramDialNumber(standalone[2])) {
      return esc(standalone[1]) + dial(standalone[2], standalone[2]) + esc(standalone[3]);
    }

    const pattern = /`([^`]+)`|(\*\*)?\[([^\]]+)\]\((?:<([^>]+)>|([^)\r\n]+))\)(\*\*)?|\*\*([^*]+)\*\*|((?:📞[ \t]*(?:(?:聯絡電話|電話|手機)[ \t]*[：:]?[ \t]*)?|(?:聯絡電話|電話|手機)[ \t]*[：:][ \t]*))(\+?\d(?:[\d \t\u00a0-]*\d)?)|(https?:\/\/[^\s<>"'，。；、|]+)/gu;
    let html = '';
    let last = 0;
    for (const token of line.matchAll(pattern)) {
      const [raw, code, boldOpen, label, angleUrl, rawUrl, boldClose, bold, prefix, phone, url] = token;
      html += esc(line.slice(last, token.index));
      last = token.index + raw.length;
      if (code !== undefined) {
        html += '<code>' + esc(code) + '</code>';
      } else if (label !== undefined) {
        const href = (angleUrl || rawUrl).trim();
        let content = esc(label);
        if (/^tel:/i.test(href)) {
          content = dial(label, href.slice(4));
        } else if (/^(?:https?:\/\/|mailto:|tg:\/\/)[^\s<>"']+$/i.test(href)) {
          content = '<a href="' + esc(href) + '">' + content + '</a>';
        }
        html += boldOpen && boldClose ? '<b>' + content + '</b>' :
          (boldOpen || '') + content + (boldClose || '');
      } else if (bold !== undefined) {
        html += '<b>' + esc(bold) + '</b>';
      } else if (phone !== undefined) {
        html += esc(prefix) + (/^[\w./-]/.test(line.slice(last)) ? esc(phone) : dial(phone, phone));
      } else {
        const href = url.replace(/[.,!?;:)\]]+$/g, '');
        html += '<a href="' + esc(href) + '">' + esc(href) + '</a>' + esc(url.slice(href.length));
      }
    }
    return html + esc(line.slice(last));
  }

  const html = '<p>' + source.split(/\r\n|\r|\n/).map(renderLine).join('<br>') + '</p>';
  return hasDialLink && html.length <= 30000 ? html : '';
}

function sendTelegramNotification(message) {
  return sendTelegramNotificationWithId(message).success;
}

function sendTelegramNotificationWithId(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { success: false, messageId: null };
  }

  const baseUrl = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/';

  // ⭐ v4.4：移除 hasRestoredContact 判斷，全部行 Rich HTML（同手動新增活動一樣）
  // TG 訊息入面有 [電話](tel:+852...) 格式，convertToTelegramRichDialHtml 會轉做 <a href="tel:...">
  const richHtml = convertToTelegramRichDialHtml(message);

  if (richHtml) {
    try {
      const response = UrlFetchApp.fetch(baseUrl + 'sendRichMessage', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          rich_message: { html: richHtml, skip_entity_detection: true }
        }),
        muteHttpExceptions: true
      });
      const status = response.getResponseCode();
      const json = JSON.parse(response.getContentText());
      if (status === 200 && json.ok) {
        return { success: true, messageId: (json.result && json.result.message_id) || null };
      }
      if ((status !== 400 && status !== 404) || json.ok !== false) {
        console.error('Telegram Rich 訊息發送失敗（HTTP ' + status + '）。');
        return { success: false, messageId: null };
      }
      console.warn('Telegram 拒絕 Rich 訊息（HTTP ' + status + '），改發普通通知。');
    } catch (_) {
      console.error('Telegram Rich 訊息發送結果未能確認，唔會重發以免重複。');
      return { success: false, messageId: null };
    }
  }

  const url = baseUrl + 'sendMessage';
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

  let firstMessageId = null;
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

      if (response.getResponseCode() === 200) {
        try {
          const json = JSON.parse(response.getContentText());
          if (i === 0 && json.result && json.result.message_id) {
            firstMessageId = json.result.message_id;
          }
        } catch (e) {}
        console.log('✅ Telegram 發送成功 (' + (i + 1) + '/' + chunks.length + ')');
      } else {
        allSuccess = false;
        console.error('❌ Telegram 失敗：' + response.getContentText());
      }
      if (i < chunks.length - 1) Utilities.sleep(1000);
    } catch (e) {
      allSuccess = false;
      console.error('❌ Telegram 拋錯：' + e.message);
    }
  }
  return { success: allSuccess, messageId: firstMessageId };
}

function deleteTelegramMessage(messageId) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !messageId) return false;
  const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/deleteMessage';
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        message_id: parseInt(messageId, 10)
      }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 200) {
      console.log('✅ Telegram 舊訊息已刪除：' + messageId);
      return true;
    }
    const respText = res.getContentText();
    if (respText.indexOf('message to delete not found') >= 0) {
      console.log('ℹ️ Telegram 舊訊息已搵唔到（太舊），視為刪除成功');
      return true;
    }
    if (respText.indexOf("message can't be deleted") >= 0) {
      console.log('ℹ️ Telegram 舊訊息超過 48 小時無法刪除，保留舊訊息');
      return false;
    }
    console.error('❌ Telegram 刪除失敗：' + respText);
    return false;
  } catch (e) {
    console.error('❌ Telegram 刪除拋錯：' + e.message);
    return false;
  }
}

function deleteDiscordMessage(webhook, messageId) {
  if (!webhook || !messageId) return false;
  const m = String(webhook).match(/\/webhooks\/(\d+)\/([^\/?]+)/);
  if (!m) {
    console.error('無法解析 Discord webhook URL');
    return false;
  }
  const url = 'https://discord.com/api/webhooks/' + m[1] + '/' + m[2] + '/messages/' + messageId;
  try {
    const res = UrlFetchApp.fetch(url, { method: 'delete', muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 200 || code === 204 || code === 404) {
      console.log('✅ Discord 舊訊息已刪除：' + messageId);
      return true;
    }
    console.error('❌ Discord 刪除失敗：' + code);
    return false;
  } catch (e) {
    console.error('❌ Discord 刪除拋錯：' + e.message);
    return false;
  }
}

function saveMsgIds(eventId, discordId, tgId) {
  const baseId = String(eventId).split('@')[0];
  scriptProperties.setProperty(
    'msgIds_' + baseId,
    JSON.stringify({ discord: discordId || '', tg: tgId || '' })
  );
}

function getMsgIds(eventId) {
  const baseId = String(eventId).split('@')[0];
  const raw = scriptProperties.getProperty('msgIds_' + baseId);
  if (!raw) return { discord: '', tg: '' };
  try { return JSON.parse(raw); } catch (e) { return { discord: '', tg: '' }; }
}

// ⭐ v4.4：拆成兩個版本
// TG 用：[電話](tel:+852...) → Rich HTML → Android/iOS 都藍色可撥號
function restoreContactLinksForTelegram(text) {
  if (!text) return text;
  return text.replace(
    /📞\s*(\d[\d\s\-]*?)\s*\|\s*WhatsApp[：:]\s*(https?:\/\/wa\.me\/\S+)/g,
    function(match, phone, waUrl) {
      var phoneTrimmed = String(phone).trim();
      var clean = phoneTrimmed.replace(/\D/g, '');
      var intl = clean.length === 8 ? '+852' + clean : '+' + clean;
      return '📞 [' + phoneTrimmed + '](tel:' + intl + ') | [WhatsApp](<' + waUrl + '>)';
    }
  );
}

// Discord 用：<tel:+852...> 尖括號 → Discord 官方支援可撥號
function restoreContactLinksForDiscord(text) {
  if (!text) return text;
  return text.replace(
    /📞\s*(\d[\d\s\-]*?)\s*\|\s*WhatsApp[：:]\s*(https?:\/\/wa\.me\/\S+)/g,
    function(match, phone, waUrl) {
      var phoneTrimmed = String(phone).trim();
      var clean = phoneTrimmed.replace(/\D/g, '');
      var intl = clean.length === 8 ? '+852' + clean : '+' + clean;
      return '📞 <tel:' + intl + '> | <' + waUrl + '>';
    }
  );
}

// 向後兼容（其他位置可能用到）
function restoreContactLinks(text) {
  return restoreContactLinksForTelegram(text);
}

// ============================================
// ⭐ v4 新增：同步「網站預約」嘅 messageId 去 ScriptProperties
// ============================================
function syncWebsiteBookingMsgIds() {
  const now = new Date();
  const timeMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  let pageToken = null;
  let synced = 0;
  let updated = 0;
  let skipped = 0;
  let scanned = 0;
  let websiteCount = 0;

  try {
    do {
      const res = Calendar.Events.list(CALENDAR_ID, {
        timeMin: timeMin,
        timeMax: timeMax,
        singleEvents: true,
        maxResults: 250,
        pageToken: pageToken,
        orderBy: 'startTime'
      });
      (res.items || []).forEach(ev => {
        scanned++;
        const desc = ev.description || '';
        if (desc.indexOf('[網站預約]') < 0) return;
        websiteCount++;

        const baseId = String(ev.id).split('@')[0];
        const ext = (ev.extendedProperties && ev.extendedProperties.private) || {};
        const discordId = ext.discordMessageId || '';
        const tgId = ext.telegramMessageId || '';

        if (!discordId && !tgId) {
          skipped++;
          return;
        }

        const existing = scriptProperties.getProperty('msgIds_' + baseId);
        let existingParsed = { discord: '', tg: '' };
        if (existing) {
          try { existingParsed = JSON.parse(existing); } catch (e) {}
        }

        if (existingParsed.discord === discordId && existingParsed.tg === tgId) {
          skipped++;
          return;
        }

        scriptProperties.setProperty(
          'msgIds_' + baseId,
          JSON.stringify({ discord: discordId, tg: tgId })
        );

        if (existingParsed.discord || existingParsed.tg) {
          updated++;
          console.log('[Sync] 更新 messageId：' + baseId);
        } else {
          synced++;
        }
      });
      pageToken = res.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.error('[Sync] 同步失敗：' + e.message);
    return { synced: 0, updated: 0, skipped: 0, scanned: 0, error: e.message };
  }

  if (synced > 0 || updated > 0) {
    console.log('[Sync] 掃到 ' + scanned + ' 個 event（網站預約 ' + websiteCount + ' 個），新增 ' + synced + ' 個，更新 ' + updated + ' 個，跳過 ' + skipped);
  }

  return { synced: synced, updated: updated, skipped: skipped, scanned: scanned };
}

// ============================================
// ⭐ 主函數
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
      syncWebsiteBookingMsgIds();
    } catch (e) {
      console.error('[checkAllEvents] syncWebsiteBookingMsgIds 出錯：' + e.message);
    }

    try {
      runCheckDeletedEvents();
    } catch (e) {
      console.error('[checkAllEvents] checkDeletedEvents 出錯：' + e.message);
    }

    try {
      runCheckNewEvents(calendar);
    } catch (e) {
      console.error('[checkAllEvents] checkNewEvents 出錯：' + e.message);
    }

    try {
      runCheckModifiedEvents();
    } catch (e) {
      console.error('[checkAllEvents] checkModifiedEvents 出錯：' + e.message);
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
// 檢查「已刪除」事件
// ============================================
function runCheckDeletedEvents() {
  let syncToken = scriptProperties.getProperty('calendar_syncToken');
  let pageToken = null;
  let items = [];
  let newSyncToken = null;

  if (!syncToken) {
    console.log('[Deleted] 首次同步，建立 syncToken');
    try {
      do {
        const res = Calendar.Events.list(CALENDAR_ID, {
          singleEvents: true,
          maxResults: 2500,
          pageToken: pageToken,
          showDeleted: false
        });
        pageToken = res.nextPageToken;
        newSyncToken = res.nextSyncToken;
      } while (pageToken);

      if (newSyncToken) {
        scriptProperties.setProperty('calendar_syncToken', newSyncToken);
        console.log('[Deleted] 初始 syncToken 已建立（下一次執行才會偵測刪除）');
      } else {
        console.warn('[Deleted] 未能取得 syncToken，下次再試');
      }
      return;
    } catch (e) {
      console.error('[Deleted] 建立 syncToken 失敗：' + e.message);
      return;
    }
  }

  try {
    do {
      const res = Calendar.Events.list(CALENDAR_ID, {
        singleEvents: true,
        maxResults: 2500,
        pageToken: pageToken,
        syncToken: syncToken,
        showDeleted: true
      });
      items = items.concat(res.items || []);
      pageToken = res.nextPageToken;
      newSyncToken = res.nextSyncToken;
    } while (pageToken);
  } catch (e) {
    const isSyncTokenInvalid = (e.code === 410) ||
      (e.message && e.message.indexOf('Sync token is no longer valid') >= 0);
    if (isSyncTokenInvalid) {
      console.warn('[Deleted] syncToken 失效，清除後下次重建');
      scriptProperties.deleteProperty('calendar_syncToken');
      return;
    }
    console.error('[Deleted] 增量同步失敗：' + e.message);
    return;
  }

  const deletedEvents = items.filter(ev => ev.status === 'cancelled');
  console.log('[Deleted] 發現 ' + deletedEvents.length + ' 個已刪除事件');

  let processed = 0;
  deletedEvents.forEach(ev => {
    const baseId = String(ev.id).split('@')[0];
    const oldIds = getMsgIds(baseId);

    if (oldIds.discord || oldIds.tg) {
      console.log('[Deleted] 刪除訊息：' + baseId + '（' + (ev.summary || '無標題') + '）');
      if (oldIds.discord) deleteDiscordMessage(DISCORD_WEBHOOK, oldIds.discord);
      if (oldIds.tg) deleteTelegramMessage(oldIds.tg);
      scriptProperties.deleteProperty('msgIds_' + baseId);
      processed++;
    } else {
      console.log('[Deleted] 已刪除但冇訊息記錄：' + baseId);
    }

    try {
      let nn = JSON.parse(scriptProperties.getProperty('notified_new') || '[]');
      const nnBefore = nn.length;
      nn = nn.filter(id => String(id).split('@')[0] !== baseId);
      if (nn.length !== nnBefore) {
        scriptProperties.setProperty('notified_new', JSON.stringify(nn));
      }

      let n30 = JSON.parse(scriptProperties.getProperty('notified_30min') || '[]');
      const n30Before = n30.length;
      n30 = n30.filter(id => String(id).split('@')[0] !== baseId);
      if (n30.length !== n30Before) {
        scriptProperties.setProperty('notified_30min', JSON.stringify(n30));
      }

      let nu = JSON.parse(scriptProperties.getProperty('notified_updated') || '{}');
      if (nu[baseId]) {
        delete nu[baseId];
        scriptProperties.setProperty('notified_updated', JSON.stringify(nu));
      }
    } catch (e) {
      console.error('[Deleted] 清理通知記錄失敗：' + e.message);
    }
  });

  if (newSyncToken) {
    scriptProperties.setProperty('calendar_syncToken', newSyncToken);
  }

  if (processed > 0) {
    console.log('[Deleted] ✅ 共清理 ' + processed + ' 個已刪除活動嘅訊息');
  }
}

// ============================================
// 檢查新建立事件
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
      const tgResult = sendTelegramNotificationWithId(discordMessage);
      saveMsgIds(eventId, success.messageId || '', tgResult.messageId || '');
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
// 檢查「被修改」事件
// ============================================
function runCheckModifiedEvents() {
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString();

  let items = [];
  let pageToken = null;
  try {
    do {
      const res = Calendar.Events.list(CALENDAR_ID, {
        timeMin: timeMin,
        timeMax: timeMax,
        singleEvents: true,
        maxResults: 250,
        pageToken: pageToken,
        orderBy: 'startTime'
      });
      items = items.concat(res.items || []);
      pageToken = res.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.error('[Modified] 列 Calendar 失敗：' + e.message);
    return;
  }

  const notifiedNew = JSON.parse(scriptProperties.getProperty('notified_new') || '[]');
  let notifiedUpd = {};
  try {
    notifiedUpd = JSON.parse(scriptProperties.getProperty('notified_updated') || '{}');
  } catch (e) {}

  let changedCount = 0;

  items.forEach(ev => {
    const baseId = String(ev.id).split('@')[0];
    const updated = ev.updated;
    if (!updated) return;

    const desc = ev.description || '';
    if (desc.indexOf('[網站預約]') >= 0) {
      notifiedUpd[baseId] = updated;
      return;
    }

    const wasNotified = notifiedNew.some(id => String(id).split('@')[0] === baseId);
    if (!wasNotified) {
      if (!notifiedUpd[baseId]) notifiedUpd[baseId] = updated;
      return;
    }

    if (!notifiedUpd[baseId]) {
      notifiedUpd[baseId] = updated;
      return;
    }

    const oldTs = new Date(notifiedUpd[baseId]).getTime();
    const newTs = new Date(updated).getTime();
    if (newTs <= oldTs) return;

    console.log('[Modified] 偵測到修改：' + ev.summary);

    const title = ev.summary || '(無標題)';
    const startRaw = (ev.start && (ev.start.dateTime || ev.start.date)) || '';
    const startTime = startRaw ? new Date(startRaw) : new Date();
    const creatorEmail = getEventCreatorCached(CALENDAR_ID, baseId);
    const creatorName = getCreatorDisplayName(creatorEmail);

    const cleanDesc = desc
      .replace('[新事件已通知]', '')
      .replace('[30分鐘通知已發送]', '')
      .trim();

    const nowStr = new Date().toLocaleString('zh-HK', {
      timeZone: 'Asia/Hong_Kong', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });

    let message =
      '🔄 **【日曆活動已修改】** _(' + nowStr + ')_\n\n' +
      '🚕 ' + title + '\n' +
      '⏰ 開始：' + startTime.toLocaleString('zh-HK') + '\n' +
      '👤 原新增者：' + creatorName;

    if (cleanDesc) message += '\n\n' + cleanDesc;
    message += '\n\n🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴';

    const oldIds = getMsgIds(baseId);
    if (oldIds.discord) deleteDiscordMessage(DISCORD_WEBHOOK, oldIds.discord);
    if (oldIds.tg) deleteTelegramMessage(oldIds.tg);

    const dResult = sendDiscordNotification(DISCORD_WEBHOOK, message);
    const tResult = sendTelegramNotificationWithId(message);

    saveMsgIds(baseId, dResult.messageId || '', tResult.messageId || '');

    notifiedUpd[baseId] = updated;

    let notified30 = JSON.parse(scriptProperties.getProperty('notified_30min') || '[]');
    const before30 = notified30.length;
    notified30 = notified30.filter(id => String(id).split('@')[0] !== baseId);
    if (notified30.length !== before30) {
      scriptProperties.setProperty('notified_30min', JSON.stringify(notified30));
      console.log('[Modified] 已清除 30 分鐘提醒記錄，新時間會重新提醒');
    }

    changedCount++;
    Utilities.sleep(1200);
  });

  scriptProperties.setProperty('notified_updated', JSON.stringify(notifiedUpd));

  if (changedCount > 0) {
    console.log('[Modified] ✅ 共處理 ' + changedCount + ' 個修改事件');
  } else {
    console.log('[Modified] 冇新修改');
  }
}

// ============================================
// 檢查即將開始事件
// ============================================
function runCheckUpcomingEvents(calendar) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + UPCOMING_WINDOW_MINUTES * 60 * 1000);
  const upcomingEvents = calendar.getEvents(now, windowEnd);

  console.log('[Upcoming] 發現 ' + upcomingEvents.length + ' 個事件（窗口 ' + UPCOMING_WINDOW_MINUTES + ' 分鐘）');

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

    const isWebsiteBooking = rawDescription.indexOf('[網站預約]') >= 0;

    let fullDescription = rawDescription
      .replace('[網站預約]', '')
      .replace('[新事件已通知]', '')
      .replace('[30分鐘通知已發送]', '')
      .replace('👤 工作人員落單', '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // ⭐ v4.4：分別產生 TG 版同 Discord 版
    // ⭐ v4.5：改 const → let（下面會重新賦值，const 會拋 TypeError → 網站預約單冇 30 分鐘提醒）
    let tgDesc = restoreContactLinksForTelegram(fullDescription);
    let discordDesc = restoreContactLinksForDiscord(fullDescription);

    let bookingId = '';
    const idMatch = fullDescription.match(/🆔\s*`(\d{4})`/);
    if (idMatch) {
      bookingId = idMatch[1];
      // 兩個版本都要加「查看/修改訂單」連結
      if (fullDescription.indexOf('查看/修改訂單') < 0) {
        const orderLink = ' | [📋 查看/修改訂單](<https://hktaxiservice.netlify.app/booking.html?edit=' + bookingId + '>)';
        tgDesc = tgDesc.replace(
          new RegExp('🆔\\s*`' + bookingId + '`', 'g'),
          '🆔 `' + bookingId + '`' + orderLink
        );
        discordDesc = discordDesc.replace(
          new RegExp('🆔\\s*`' + bookingId + '`', 'g'),
          '🆔 `' + bookingId + '`' + orderLink
        );
      }
    }

    const creatorEmail = getEventCreatorCached(CALENDAR_ID, eventId);
    const creatorName = getCreatorDisplayName(creatorEmail);

    let tgFullDesc = tgDesc;
    let discordFullDesc = discordDesc;

    if (!isWebsiteBooking) {
      const parts = [];
      parts.push('🚕 ' + title);
      parts.push('⏰ 開始：' + startTime.toLocaleString('zh-HK'));
      parts.push('👤 新增者：' + creatorName);
      if (fullDescription) {
        parts.push('');
        parts.push(fullDescription);
      }
      const rebuilt = parts.join('\n');
      tgFullDesc = restoreContactLinksForTelegram(rebuilt);
      discordFullDesc = restoreContactLinksForDiscord(rebuilt);
    }

    pendingEvents.push({
      id: eventId,
      title: title,
      startTime: startTime,
      minutesUntil: minutesUntil,
      bookingId: bookingId,
      creatorName: creatorName,
      fullDescription: discordFullDesc,   // Discord 用
      tgDescription: tgFullDesc           // Telegram 用
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

  // 用 Discord 版計長度（通常長啲）
  pendingEvents.forEach(ev => {
    currentBatch.push(ev);
    const testMsg = buildUpcomingMessage(currentBatch, false);
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
    const discordMsg = buildUpcomingMessage(batch, false);
    const tgMsg = buildUpcomingMessage(batch, true);

    console.log('[Upcoming] 批次 ' + (batchIdx + 1) + '/' + batches.length + '：' + batch.length + ' 個 event，Discord ' + discordMsg.length + ' 字，TG ' + tgMsg.length + ' 字');

    batch.forEach(ev => {
      notifiedEvents.push(ev.id);
    });
    notifiedEvents = notifiedEvents.slice(-100);
    scriptProperties.setProperty('notified_30min', JSON.stringify(notifiedEvents));

    let success = false;
    try {
      const result = sendDiscordNotification(DISCORD_WEBHOOK, discordMsg);
      sendTelegramNotification(tgMsg);
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

// ⭐ v4.4：加 forTelegram 參數
function buildUpcomingMessage(events, forTelegram) {
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
    // ⭐ 根據平台選擇描述
    parts.push(forTelegram ? ev.tgDescription : ev.fullDescription);
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
  const notified30min = JSON.parse(scriptProperties.getProperty('notified_30min') || '[]');
  const notifiedNew = JSON.parse(scriptProperties.getProperty('notified_new') || '[]');

  if (notified30min.length > 500) {
    scriptProperties.setProperty('notified_30min', JSON.stringify(notified30min.slice(-500)));
  }
  if (notifiedNew.length > 500) {
    scriptProperties.setProperty('notified_new', JSON.stringify(notifiedNew.slice(-500)));
  }
  console.log('✅ 已清理通知記錄');

  try {
    cleanupMsgIds();
  } catch (e) {
    console.error('[cleanupNotifiedEvents] cleanupMsgIds 失敗：' + e.message);
    console.error(e.stack);
  }
}

function clearAllNotifiedEvents() {
  scriptProperties.deleteProperty('notified_30min');
  scriptProperties.deleteProperty('notified_new');
  console.log('✅ 已完全清理所有通知記錄');
}

function cleanupMsgIds() {
  const now = new Date();
  const past7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const future30d = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const aliveIds = new Set();
  let pageToken = null;
  let scanned = 0;
  try {
    do {
      const res = Calendar.Events.list(CALENDAR_ID, {
        timeMin: past7d.toISOString(),
        timeMax: future30d.toISOString(),
        singleEvents: true,
        maxResults: 250,
        pageToken: pageToken,
        orderBy: 'startTime'
      });
      (res.items || []).forEach(ev => {
        aliveIds.add(String(ev.id).split('@')[0]);
        scanned++;
      });
      pageToken = res.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.error('[cleanupMsgIds] 列 Calendar 失敗：' + e.message);
    return { deleted: 0, kept: 0, scanned: 0, error: e.message };
  }

  const allKeys = scriptProperties.getKeys();
  const msgIdKeys = allKeys.filter(k => k.indexOf('msgIds_') === 0);

  let deleted = 0;
  let kept = 0;
  const deletedList = [];

  msgIdKeys.forEach(k => {
    const baseId = k.substring('msgIds_'.length);
    if (!aliveIds.has(baseId)) {
      scriptProperties.deleteProperty(k);
      deletedList.push(baseId);
      deleted++;
    } else {
      kept++;
    }
  });

  try {
    let notifiedUpd = JSON.parse(scriptProperties.getProperty('notified_updated') || '{}');
    let updChanged = false;
    Object.keys(notifiedUpd).forEach(baseId => {
      if (!aliveIds.has(baseId)) {
        delete notifiedUpd[baseId];
        updChanged = true;
      }
    });
    if (updChanged) {
      scriptProperties.setProperty('notified_updated', JSON.stringify(notifiedUpd));
    }
  } catch (e) {
    console.error('[cleanupMsgIds] 清理 notified_updated 失敗：' + e.message);
  }

  try {
    const baseAlive = id => aliveIds.has(String(id).split('@')[0]);
    let nn = JSON.parse(scriptProperties.getProperty('notified_new') || '[]');
    nn = nn.filter(baseAlive);
    scriptProperties.setProperty('notified_new', JSON.stringify(nn));

    let n30 = JSON.parse(scriptProperties.getProperty('notified_30min') || '[]');
    n30 = n30.filter(baseAlive);
    scriptProperties.setProperty('notified_30min', JSON.stringify(n30));
  } catch (e) {
    console.error('[cleanupMsgIds] 清理 notified 失敗：' + e.message);
  }

  console.log('✅ cleanupMsgIds 完成');
  console.log('   掃到 event：' + scanned);
  console.log('   msgIds_ 總數：' + msgIdKeys.length);
  console.log('   保留：' + kept);
  console.log('   刪除：' + deleted);
  if (deletedList.length > 0) {
    console.log('   刪除清單：' + deletedList.join(', '));
  }

  return { scanned: scanned, total: msgIdKeys.length, kept: kept, deleted: deleted };
}

// ============================================
// 測試函數
// ============================================
function testDiscord() {
  const result = sendDiscordNotification(DISCORD_WEBHOOK, '🧪 Discord 測試訊息');
  console.log('Discord 測試：' + (result.success ? '✅ 成功' : '❌ 失敗'));
}

function testDiscordDialLink() {
  if (!DISCORD_WEBHOOK) throw new Error('搵唔到原有 Discord Webhook，未有發送。');

  const message = [
    '【Discord 撥號測試，唔係訂單】',
    '請逐個撳號碼，睇吓會唔會帶入 +85212345678；唔使打出。',
    '',
    'A 普通號碼',
    '+85212345678',
    'B 尖括號號碼',
    '<+85212345678>',
    'C 尖括號 tel 連結',
    '<tel:+85212345678>',
    'D Markdown tel 連結',
    '[+852 1234 5678](tel:+85212345678)'
  ].join('\n');

  const result = sendDiscordNotification(DISCORD_WEBHOOK, message);
  if (!result.success) throw new Error('Discord 撥號測試訊息未能發送，請睇執行記錄。');
  console.log('Discord 撥號測試訊息已送出。請喺 Android 試 A 至 D。');
}

function testTelegram() {
  const result = sendTelegramNotification('🧪 Telegram 測試訊息');
  console.log('Telegram 測試：' + (result ? '✅ 成功' : '❌ 失敗'));
}

function testTelegramDialLink() {
  const token = String(TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(TELEGRAM_CHAT_ID || '').trim();

  if (!token || !chatId) {
    throw new Error('搵唔到原有 Telegram 設定，未有發送。請確認用緊原本嘅 Apps Script 專案。');
  }

  let response;
  try {
    response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendRichMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: chatId,
        disable_notification: true,
        rich_message: {
          html: '<p>【撥號測試，唔係訂單】<br><a href="tel:+85212345678">+852 1234 5678</a></p>',
          skip_entity_detection: true
        }
      }),
      muteHttpExceptions: true
    });
  } catch (_) {
    throw new Error('未能連線到 Telegram；請檢查 Apps Script 外部連線權限後再試。');
  }

  const status = response.getResponseCode();
  let result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (_) {
    throw new Error('Telegram 回傳唔係有效 JSON（HTTP ' + status + '）。');
  }
  if (!result || !result.ok) {
    const description = String((result && result.description) || '未知錯誤');
    throw new Error('Telegram 測試失敗（HTTP ' + status + '）：' +
      description.split(token).join('[已遮蔽]'));
  }
  console.log('測試訊息已送出。請用 Android 撳號碼，確認撥號畫面有冇帶入 +85212345678；唔使打出。');
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

function testRestoreLinks() {
  var sample = '👤 王先生 | 📞 51245677 | WhatsApp：https://wa.me/85251245677';
  console.log('原字串：' + sample);
  console.log('TG 版：' + restoreContactLinksForTelegram(sample));
  console.log('Discord 版：' + restoreContactLinksForDiscord(sample));
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

// ⭐ v4.4：同時發 Discord 版同 TG 版測試
function testUpcomingMessageFormat() {
  const fakeEvents = [
    {
      id: 'test1',
      minutesUntil: 30,
      fullDescription: '🚕 order\n⏰ 5/10/2026 下午10:00:00\n👤 新增者：藍叔',
      tgDescription: '🚕 order\n⏰ 5/10/2026 下午10:00:00\n👤 新增者：藍叔'
    },
    {
      id: 'test2',
      minutesUntil: 28,
      fullDescription: '🚕 order\n⏰ 5/10/2026 下午10:00:00\n👤 新增者：藍叔',
      tgDescription: '🚕 order\n⏰ 5/10/2026 下午10:00:00\n👤 新增者：藍叔'
    },
    {
      id: 'test3',
      minutesUntil: 27,
      fullDescription: '🚕 🚕 Testing 22, 旺角香港 → Test, 元朗香港 - 接受混能以上任何車款\n⏰ 5/10/2026 下午10:00:00\n👤 新增者：網站預約\n📞 <tel:+85211112222> | <https://wa.me/85211112222>',
      tgDescription: '🚕 🚕 Testing 22, 旺角香港 → Test, 元朗香港 - 接受混能以上任何車款\n⏰ 5/10/2026 下午10:00:00\n👤 新增者：網站預約\n📞 [11112222](tel:+85211112222) | [WhatsApp](<https://wa.me/85211112222>)'
    }
  ];

  const discordMsg = buildUpcomingMessage(fakeEvents, false);
  const tgMsg = buildUpcomingMessage(fakeEvents, true);

  console.log('=== Discord 測試訊息 ===');
  console.log(discordMsg);
  console.log('=== Telegram 測試訊息 ===');
  console.log(tgMsg);

  sendDiscordNotification(DISCORD_WEBHOOK, discordMsg);
  sendTelegramNotification(tgMsg);
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

function testModifiedEvents() {
  console.log('=== 手動測試 runCheckModifiedEvents ===');
  try {
    runCheckModifiedEvents();
    console.log('=== 完成，請睇上面 log ===');
  } catch (e) {
    console.error('❌ 拋錯：' + e.message);
    console.error(e.stack);
  }
}

function listAllMsgIds() {
  const allKeys = scriptProperties.getKeys();
  const msgIdKeys = allKeys.filter(k => k.indexOf('msgIds_') === 0);

  console.log('=== 目前 msgIds_ 記錄（共 ' + msgIdKeys.length + ' 個）===');
  msgIdKeys.forEach(k => {
    const baseId = k.substring('msgIds_'.length);
    let parsed = { discord: '', tg: '' };
    try { parsed = JSON.parse(scriptProperties.getProperty(k)); } catch (e) {}
    console.log('eventId: ' + baseId);
    console.log('  discord: ' + (parsed.discord || '（空）'));
    console.log('  tg:      ' + (parsed.tg || '（空）'));
  });
  console.log('=== 完 ===');
}

function testManualModifyFlow() {
  const FAKE_EVENT_ID = 'TEST_FAKE_EVENT_12345';
  const nowStr = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });

  const message =
    '🔄 **【日曆活動已修改】** _(' + nowStr + ')_\n\n' +
    '🚕 測試訂單（呢個係假測試，可 ignore）\n' +
    '⏰ 開始：' + nowStr + '\n' +
    '👤 原新增者：測試函數\n\n' +
    '📝 備注：呢個係 testManualModifyFlow 發出嘅假訊息\n\n' +
    '🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴';

  const oldIds = getMsgIds(FAKE_EVENT_ID);
  console.log('[Test] 舊 messageId：', JSON.stringify(oldIds));

  if (oldIds.discord) {
    const ok = deleteDiscordMessage(DISCORD_WEBHOOK, oldIds.discord);
    console.log('[Test] 刪 Discord 舊消息：' + (ok ? '✅' : '❌'));
  }
  if (oldIds.tg) {
    const ok = deleteTelegramMessage(oldIds.tg);
    console.log('[Test] 刪 Telegram 舊消息：' + (ok ? '✅' : '❌'));
  }

  const dResult = sendDiscordNotification(DISCORD_WEBHOOK, message);
  const tResult = sendTelegramNotificationWithId(message);
  console.log('[Test] 發 Discord：' + (dResult.success ? '✅ id=' + dResult.messageId : '❌'));
  console.log('[Test] 發 Telegram：' + (tResult.success ? '✅ id=' + tResult.messageId : '❌'));

  saveMsgIds(FAKE_EVENT_ID, dResult.messageId || '', tResult.messageId || '');
  console.log('[Test] 已記低新 messageId，再執行一次就會自動刪舊消息');
  console.log('[Test] 完結。若要清理測試記錄，執行 cleanupTestMsgIds()');
}

function cleanupTestMsgIds() {
  const FAKE_EVENT_ID = 'TEST_FAKE_EVENT_12345';
  const oldIds = getMsgIds(FAKE_EVENT_ID);
  if (oldIds.discord) deleteDiscordMessage(DISCORD_WEBHOOK, oldIds.discord);
  if (oldIds.tg) deleteTelegramMessage(oldIds.tg);
  scriptProperties.deleteProperty('msgIds_' + FAKE_EVENT_ID);
  console.log('✅ 測試記錄已清理');
}

function testDeletedEvents() {
  console.log('=== 手動測試 runCheckDeletedEvents ===');
  try {
    runCheckDeletedEvents();
    console.log('=== 完成，請睇上面 log ===');
  } catch (e) {
    console.error('❌ 拋錯：' + e.message);
    console.error(e.stack);
  }
}

function listSyncTokenStatus() {
  const token = scriptProperties.getProperty('calendar_syncToken');
  if (token) {
    console.log('=== syncToken 狀態 ===');
    console.log('已存在（長度 ' + token.length + ' 字）');
    console.log('前 50 字：' + token.substring(0, 50) + '...');
  } else {
    console.log('=== syncToken 不存在 ===');
    console.log('下次執行 checkAllEvents 會自動建立');
  }
}

function resetSyncToken() {
  scriptProperties.deleteProperty('calendar_syncToken');
  console.log('✅ syncToken 已清除，下次 checkAllEvents 會重新建立');
}

// ============================================
// v4 新增測試函數
// ============================================
function testSyncWebsiteMsgIds() {
  console.log('=== 手動測試 syncWebsiteBookingMsgIds ===');
  try {
    const result = syncWebsiteBookingMsgIds();
    console.log('結果：', JSON.stringify(result));
    console.log('=== 完成 ===');
  } catch (e) {
    console.error('❌ 拋錯：' + e.message);
    console.error(e.stack);
  }
}

function listWebsiteBookingMsgIds() {
  const now = new Date();
  const timeMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  let pageToken = null;
  let count = 0;
  try {
    do {
      const res = Calendar.Events.list(CALENDAR_ID, {
        timeMin: timeMin,
        timeMax: timeMax,
        singleEvents: true,
        maxResults: 250,
        pageToken: pageToken
      });
      (res.items || []).forEach(ev => {
        const desc = ev.description || '';
        if (desc.indexOf('[網站預約]') < 0) return;
        count++;
        const baseId = String(ev.id).split('@')[0];
        const ext = (ev.extendedProperties && ev.extendedProperties.private) || {};
        console.log('---');
        console.log('eventId: ' + baseId);
        console.log('  summary: ' + ev.summary);
        console.log('  ext.discordMessageId: ' + (ext.discordMessageId || '（空）'));
        console.log('  ext.telegramMessageId: ' + (ext.telegramMessageId || '（空）'));

        const local = getMsgIds(baseId);
        console.log('  ScriptProperties.discord: ' + (local.discord || '（空）'));
        console.log('  ScriptProperties.tg: ' + (local.tg || '（空）'));
        console.log('  已同步: ' + ((local.discord === (ext.discordMessageId || '') && local.tg === (ext.telegramMessageId || '')) ? '✅' : '❌'));
      });
      pageToken = res.nextPageToken;
    } while (pageToken);
    console.log('=== 共 ' + count + ' 個網站預約 ===');
  } catch (e) {
    console.error('❌ 出錯：' + e.message);
  }
}

// ============================================
// 一次性重置
// ============================================
function resetForV2() {
  scriptProperties.deleteProperty('notified_new');
  scriptProperties.deleteProperty('notified_updated');
  scriptProperties.deleteProperty('notified_30min');
  scriptProperties.deleteProperty('calendar_syncToken');

  const allKeys = scriptProperties.getKeys();
  const msgIdKeys = allKeys.filter(k => k.indexOf('msgIds_') === 0);
  msgIdKeys.forEach(k => scriptProperties.deleteProperty(k));

  console.log('✅ 已重置所有記錄（' + msgIdKeys.length + ' 個 msgIds_ 已清除）');
  console.log('   下一次 checkAllEvents 會自動重新建立記錄（含 syncToken）');
}
