const { google } = require('googleapis');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function ok(body) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}
function err(code, message) {
  return { statusCode: code, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: message }) };
}

function generateBookingId() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function getCalendarClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) throw new Error('缺少 GOOGLE_SERVICE_ACCOUNT 環境變數');
  if (!process.env.GOOGLE_CALENDAR_ID) throw new Error('缺少 GOOGLE_CALENDAR_ID 環境變數');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  return google.calendar({ version: 'v3', auth });
}

function parseDiscordWebhook(url) {
  if (!url) return null;
  const m = url.match(/\/webhooks\/(\d+)\/([^\/?]+)/);
  return m ? { id: m[1], token: m[2] } : null;
}

function insertBookingIdAfterFare(text, bookingId) {
  if (!bookingId) return text;
  if (text.indexOf('🆔') >= 0) return text;
  const lines = text.split('\n');
  let insertIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf('💰') >= 0) {
      insertIndex = i + 1;
      break;
    }
  }
  const idLine = '🆔 `' + bookingId + '`';
  if (insertIndex >= 0) {
    lines.splice(insertIndex, 0, idLine);
  } else {
    lines.push(idLine);
  }
  return lines.join('\n');
}

function buildChangedFieldsText(changedFields) {
  if (!changedFields || typeof changedFields !== 'object') return '';
  const keys = Object.keys(changedFields);
  if (keys.length === 0) return '';

  const lines = [];
  for (let i = 0; i < keys.length; i++) {
    const f = changedFields[keys[i]];
    if (!f) continue;
    lines.push('- ' + f.label + '：' + (f.old || '（空）'));
    lines.push('+ ' + f.label + '：' + (f.new || '（空）'));
  }
  if (lines.length === 0) return '';

  const ticks = String.fromCharCode(96, 96, 96);
  return ticks + 'diff\n' + lines.join('\n') + '\n' + ticks;
}

function ensureDateTime(data) {
  if (!data.date || !data.time) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    data.date = data.date || (yyyy + '-' + mm + '-' + dd);
    data.time = data.time || (hh + ':' + mi);
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const bookingData = JSON.parse(event.body);
    console.log('收到訂單：', bookingData);

    const incomingBookingId = bookingData.bookingId || null;
    const changedFields = bookingData.changedFields || null;
    const isInstantOrder = bookingData.orderType === 'instant';
    const isEdit = !!incomingBookingId;

    ensureDateTime(bookingData);

    if (incomingBookingId) {
      const existing = await findExistingBooking(incomingBookingId);
      if (existing) {
        await updateGoogleCalendar(existing, bookingData);
        await updateDiscordNotification(existing, bookingData, changedFields);
        await updateTelegramNotification(existing, bookingData, changedFields);
        console.log('訂單已更新：', incomingBookingId);
        return ok({ success: true, bookingId: incomingBookingId, updated: true });
      }
      console.log('Calendar 搵唔到 bookingId，視為首次入 Calendar：', incomingBookingId);
    }

    // ⭐ 即時訂單：跳過 Calendar，只發通知
    if (isInstantOrder) {
      const instantBookingId = incomingBookingId || generateBookingId();
      console.log('即時訂單，跳過 Calendar。bookingId:', instantBookingId);

      await sendDiscordNotification(bookingData, instantBookingId, false, isEdit, changedFields);

      const tgMsg = buildDiscordMessage(bookingData, instantBookingId, isEdit === true, changedFields || null);
      await sendTelegramNotification(tgMsg);

      return ok({ success: true, bookingId: instantBookingId, updated: isEdit });
    }

    // 非即時訂單：正常寫入 Calendar
    const newBookingId = incomingBookingId || generateBookingId();

    const calendarEvent = await addToGoogleCalendar(bookingData, newBookingId, null);
    const discordMessageId = await sendDiscordNotification(bookingData, newBookingId, true, isEdit, changedFields);

    const tgMsg = buildDiscordMessage(bookingData, newBookingId, isEdit === true, changedFields || null);
    const tgResult = await sendTelegramNotification(tgMsg);

    if (calendarEvent && calendarEvent.id) {
      await patchCalendarMessageIds(
        calendarEvent.id,
        discordMessageId || null,
        (tgResult && tgResult.messageId) || null
      );
    }

    return ok({ success: true, bookingId: newBookingId, updated: isEdit });

  } catch (error) {
    console.error('處理訂單時出錯：', error);
    return err(500, error.message);
  }
};

/* ============================================
   Telegram 發送
   ============================================ */
function convertToTelegramHtml(text) {
  if (!text) return '';
  let result = String(text);

  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
    return String(code).trim();
  });

  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  // ⭐ 先處理「粗體 + 連結」：**[text](url)**
  result = result.replace(/\*\*\[([^\]]+)\]\(<([^>]+)>\)\*\*/g, '<a href="$2"><b>$1</b></a>');
  result = result.replace(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/g, '<a href="$2"><b>$1</b></a>');

  // 普通連結
  result = result.replace(/\[([^\]]+)\]\(<([^>]+)>\)/g, '<a href="$2">$1</a>');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

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

async function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram] 未設定，跳過');
    return { success: false, messageId: null };
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
  let firstMessageId = null;

  for (let i = 0; i < chunks.length; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: chunks[i],
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      const data = await res.json();
      if (data.ok) {
        console.log('✅ Telegram 發送成功，message_id:', data.result.message_id);
        if (i === 0) firstMessageId = data.result.message_id;
      } else {
        console.error('❌ Telegram 失敗:', data.description);
        allSuccess = false;
      }
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error('❌ Telegram 拋錯：', e.message);
      allSuccess = false;
    }
  }

  return { success: allSuccess, messageId: firstMessageId };
}

async function deleteTelegramMessage(messageId) {
  if (!messageId) return false;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;

  const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/deleteMessage';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        message_id: parseInt(messageId, 10)
      })
    });
    const data = await res.json();
    if (data.ok) {
      console.log('✅ Telegram 舊訊息已刪除：', messageId);
      return true;
    }
    console.error('❌ Telegram 刪除失敗：', data.description);
    return false;
  } catch (e) {
    console.error('❌ Telegram 刪除拋錯：', e.message);
    return false;
  }
}

async function updateTelegramNotification(existing, data, changedFields) {
  console.log('Telegram：發新訊息 + 刪舊訊息');
  const oldMessageId = existing.telegramMessageId;

  const message = buildDiscordMessage(data, existing.bookingId, true, changedFields || null);
  const result = await sendTelegramNotification(message);

  if (!result.success) {
    console.error('Telegram 新訊息發送失敗，保留舊訊息唔刪');
    return;
  }

  if (oldMessageId) {
    await deleteTelegramMessage(oldMessageId);
  }

  await patchCalendarMessageIds(existing.eventId, null, result.messageId);
}

/* ============================================
   Calendar 相關
   ============================================ */
async function findExistingBooking(bookingId) {
  const calendar = getCalendarClient();
  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    privateExtendedProperty: ['bookingId=' + bookingId],
    maxResults: 1
  });
  const items = res.data.items || [];
  if (items.length === 0) return null;
  const ev = items[0];
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  return {
    eventId: ev.id,
    bookingId: bookingId,
    discordMessageId: priv.discordMessageId || null,
    telegramMessageId: priv.telegramMessageId || null
  };
}

function buildCalendarEvent(data, bookingId, discordMessageId) {
  const startTime = new Date(data.date + 'T' + data.time + ':00+08:00');
  const endTime = new Date(startTime);
  endTime.setMinutes(endTime.getMinutes() + 1);

  const bookingSourceMark = data.isInternalBooking === true
    ? '\n\n[網站預約] 👤 工作人員落單'
    : '\n\n[網站預約]';

  let description = data.fullMessage || data.customerMessage
    || ('📞 電話：' + data.phone + '\n📍 ' + data.pickup + ' → ' + data.dropoff);

  // ⭐ 先剝走粗體符號（**text** → text），保持日曆純文字
  description = description
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(tel:[^)]+\)/g, '$1')
    .replace(/\[WhatsApp\]\(<([^>]+)>\)/g, 'WhatsApp：$1')
    .replace(/^⚡ 即時訂單 ⚡\n\n/m, '')
    .replace(/\n\n🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴$/, '')
    .replace(/\n\n🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸$/, '');

  const cleanPhone = String(data.phone || '').replace(/\D/g, '');
  const stopoversStr = Array.isArray(data.stopoverTexts)
    ? data.stopoverTexts.map(function(s) {
        return String(s).replace(/中途站\d+:\s*/, '');
      }).join('、')
    : (typeof data.stopover === 'string' && data.stopover.trim() ? data.stopover.trim() : '');

  if (stopoversStr && description.indexOf('🛑有中途站') < 0) {
    description = '🛑有中途站\n' + description;
  }

  description = insertBookingIdAfterFare(description, bookingId);

  const privateProps = {
    bookingId: bookingId,
    phone: cleanPhone,
    pickup: data.pickup || '',
    dropoff: data.dropoff || '',
    stopovers: stopoversStr,
    date: data.date || '',
    time: data.time || '',
    flightNo: data.flightNo || '',
    passengers: data.passengers || '',
    luggages: data.luggages || '',
    hasPet: data.hasPet ? 'true' : 'false',
    hasWheelchair: data.hasWheelchair ? 'true' : 'false',
    payments: data.paymentMethod || '',
    contactTitle: data.title || '',
    contactSurname: data.surname || '',
    isWechatCustomer: data.isWechatCustomer ? 'true' : 'false',
    carDisplayText: data.carType || '',
    feeMode: data.feeMode || '',
    baseFare: String(data.currentBaseFare || 0),
    tunnelFee: String(data.currentTunnelFee || 0),
    surcharge: String(data.surcharge || 0),
    selectedFareMode: String(data.selectedFareMode || 'normal'),
    selectedCarName: String(data.selectedCarName || ''),
    orderType: data.orderType || 'booking'
  };
  if (discordMessageId) privateProps.discordMessageId = discordMessageId;

  return {
    summary: '🚕 ' + data.pickup + ' → ' + data.dropoff + ' - ' + (data.carType || '的士預約'),
    description: description + bookingSourceMark,
    start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Hong_Kong' },
    end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Hong_Kong' },
    colorId: '10',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    extendedProperties: { private: privateProps }
  };
}

async function addToGoogleCalendar(data, bookingId, discordMessageId) {
  const calendar = getCalendarClient();
  const resource = buildCalendarEvent(data, bookingId, discordMessageId);
  const result = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: resource,
    sendUpdates: 'all'
  });
  console.log('成功加入日曆：', result.data.htmlLink);
  return result.data;
}

async function updateGoogleCalendar(existing, data) {
  const calendar = getCalendarClient();
  const resource = buildCalendarEvent(data, existing.bookingId, existing.discordMessageId);

  if (existing.telegramMessageId) {
    if (!resource.extendedProperties) resource.extendedProperties = {};
    if (!resource.extendedProperties.private) resource.extendedProperties.private = {};
    resource.extendedProperties.private.telegramMessageId = existing.telegramMessageId;
  }

  const result = await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId: existing.eventId,
    resource: resource,
    sendUpdates: 'all'
  });
  console.log('日曆已更新：', result.data.htmlLink);
  return result.data;
}

async function patchCalendarMessageIds(eventId, discordMessageId, telegramMessageId) {
  try {
    const calendar = getCalendarClient();
    const ev = await calendar.events.get({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId: eventId
    });
    const existing = (ev.data.extendedProperties && ev.data.extendedProperties.private) || {};
    const merged = Object.assign({}, existing);

    if (discordMessageId !== null && discordMessageId !== undefined) {
      merged.discordMessageId = discordMessageId;
    }
    if (telegramMessageId !== null && telegramMessageId !== undefined) {
      merged.telegramMessageId = telegramMessageId;
    }

    await calendar.events.patch({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId: eventId,
      resource: { extendedProperties: { private: merged } }
    });
    console.log('已回寫 message IDs');
  } catch (e) {
    console.error('回寫 message IDs 失敗：', e);
  }
}

/* ============================================
   Discord 相關（即時訂單唔加查看/修改連結）
   ============================================ */
function buildDiscordMessage(data, bookingId, isUpdate, changedFields) {
  let body = data.fullMessage || data.description || '收到新訂單';

  let stopoversStr = '';
  if (Array.isArray(data.stopoverTexts)) {
    stopoversStr = data.stopoverTexts.map(function(s) {
      return String(s).replace(/中途站\d+:\s*/, '');
    }).join('、');
  } else if (typeof data.stopover === 'string' && data.stopover.trim()) {
    stopoversStr = data.stopover.trim();
  }

  if (stopoversStr && body.indexOf('🛑有中途站') < 0) {
    body = '🛑有中途站\n' + body;
  }

  if (isUpdate) {
    const now = new Date().toLocaleString('zh-HK', {
      timeZone: 'Asia/Hong_Kong',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    let header = '🔄 **【訂單已修改】** _(' + now + ')_\n';

    const diffText = buildChangedFieldsText(changedFields);
    if (diffText) {
      header += '\n**修改內容：**\n' + diffText + '\n\n';
    } else {
      header += '\n_（未能偵測具體修改欄位）_\n\n';
    }
    header += '**最新訂單內容：**\n';
    body = header + body;
  }

  // ⭐ 全部 🔸 改 🔴
  body = body.replace(/🔸/g, '🔴');
  body = insertBookingIdAfterFare(body, bookingId);

  // ⭐ 電話號碼加粗（只影響 Discord / Telegram，日曆會剝走）
  body = body.replace(/📞\s+\[([^\]]+)\]\(tel:([^)]+)\)/g, '📞 **[$1](tel:$2)**');

  // ⭐ 判斷是否即時訂單
  const isInstantOrder = (body.indexOf('⚡ 即時訂單 ⚡') >= 0) || (data.orderType === 'instant');

  // ⭐ 只有非即時訂單才加「查看/修改訂單」連結
  if (!isInstantOrder && bookingId && body.indexOf('查看/修改訂單') < 0) {
    body = body.replace(
      new RegExp('🆔\\s*`' + bookingId + '`', 'g'),
      '🆔 `' + bookingId + '` | [📋 查看/修改訂單](<https://hktaxiservice.netlify.app/booking.html?edit=' + bookingId + '>)'
    );
  }

  return body;
}

async function fetchWithRetry(url, options, maxRetries) {
  maxRetries = maxRetries || 3;
  let lastResponse = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;

      if (res.status === 429) {
        const waitMs = (attempt + 1) * 3000;
        console.warn('[Retry] 429 Rate Limit，等 ' + waitMs + 'ms 後重試');
        await new Promise(function(r) { setTimeout(r, waitMs); });
        lastResponse = res;
        continue;
      }
      if (res.status >= 500) {
        const waitMs = (attempt + 1) * 2000;
        console.warn('[Retry] ' + res.status + ' Server Error，等 ' + waitMs + 'ms 後重試');
        await new Promise(function(r) { setTimeout(r, waitMs); });
        lastResponse = res;
        continue;
      }
      return res;
    } catch (e) {
      if (attempt < maxRetries - 1) {
        const waitMs = (attempt + 1) * 2000;
        console.warn('[Retry] 網絡錯誤：' + e.message);
        await new Promise(function(r) { setTimeout(r, waitMs); });
        continue;
      }
      throw e;
    }
  }
  return lastResponse;
}

async function sendDiscordNotification(data, bookingId, waitForId, isUpdate, changedFields) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('Discord 未設定，跳過通知');
    return null;
  }

  const randomDelay = Math.floor(Math.random() * 800);
  await new Promise(function(r) { setTimeout(r, randomDelay); });

  const message = buildDiscordMessage(data, bookingId, isUpdate === true, changedFields || null);
  const reqBody = JSON.stringify({ content: message, flags: 4 });

  if (waitForId) {
    const urlWithWait = webhookUrl + (webhookUrl.indexOf('?') >= 0 ? '&' : '?') + 'wait=true';
    try {
      const res = await fetchWithRetry(urlWithWait, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody
      }, 3);
      if (res && res.ok) {
        const json = await res.json();
        console.log('Discord 已發送（含 messageId）：', json.id);
        return json.id;
      }
      const errText = res ? await res.text().catch(function() { return ''; }) : '';
      console.warn('[Discord] wait=true 失敗。狀態:', res ? res.status : '無回應', errText);
    } catch (e) {
      console.warn('[Discord] wait=true 拋錯：', e.message);
    }
  }

  try {
    const res = await fetchWithRetry(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reqBody
    }, 3);
    if (res && res.ok) {
      console.log('Discord 通知已發送（無 messageId）');
    } else {
      const errText = res ? await res.text().catch(function() { return ''; }) : '';
      console.error('[Discord] 普通 POST 失敗。狀態:', res ? res.status : '無回應', errText);
    }
    return null;
  } catch (error) {
    console.error('[Discord] 普通 POST 拋錯：', error);
    return null;
  }
}

async function deleteDiscordMessage(messageId) {
  if (!messageId) return false;
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const wh = parseDiscordWebhook(webhookUrl);
  if (!wh) {
    console.error('無法解析 Discord webhook URL');
    return false;
  }

  const deleteUrl = 'https://discord.com/api/webhooks/' + wh.id + '/' + wh.token + '/messages/' + messageId;
  try {
    const res = await fetchWithRetry(deleteUrl, { method: 'DELETE' }, 2);
    if (res && (res.ok || res.status === 404)) {
      console.log('Discord 舊訊息已刪除：', messageId);
      return true;
    }
    return false;
  } catch (e) {
    console.error('[Discord] 刪除拋錯：', e);
    return false;
  }
}

async function updateDiscordNotification(existing, data, changedFields) {
  console.log('Discord：發新訊息 + 刪舊訊息');
  const oldMessageId = existing.discordMessageId;
  const newMessageId = await sendDiscordNotification(data, existing.bookingId, true, true, changedFields);
  if (!newMessageId) {
    console.error('Discord 新訊息發送失敗，保留舊訊息唔刪');
    return;
  }
  if (oldMessageId) {
    await deleteDiscordMessage(oldMessageId);
  }
  await patchCalendarMessageIds(existing.eventId, newMessageId, null);
}
