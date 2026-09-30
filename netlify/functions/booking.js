const { google } = require('googleapis');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

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

// 喺「💰...」行之後插入 bookingId
function insertBookingIdAfterFare(text, bookingId) {
  if (!bookingId) return text;
  const lines = text.split('\n');
  let insertIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('💰')) {
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

// ⭐ 將 changedFields 轉成 Discord diff code block（紅 / 綠）
// ⚠️ 用 String.fromCharCode(96,96,96) 產生反引號，避免被 Markdown 解析器干擾
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

  const ticks = String.fromCharCode(96, 96, 96);   // 三個反引號
  return ticks + 'diff\n' + lines.join('\n') + '\n' + ticks;
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

    // ===== 即時訂單：永遠 CREATE，跳過 Calendar，唔產生 bookingId =====
    if (bookingData.orderType === 'instant') {
      console.log('即時訂單，跳過 Calendar');
      await sendDiscordNotification(bookingData, null, false, false, null);
      return ok({ success: true, bookingId: null, updated: false });
    }

    // ===== 預約訂單：有 bookingId 先試 UPDATE =====
    if (incomingBookingId) {
      const existing = await findExistingBooking(incomingBookingId);
      if (existing) {
        await updateGoogleCalendar(existing, bookingData);
        await updateDiscordNotification(existing, bookingData, changedFields);
        console.log('訂單已更新：', incomingBookingId, '，修改欄位：', changedFields ? Object.keys(changedFields) : '無');
        return ok({ success: true, bookingId: incomingBookingId, updated: true });
      }
      console.log('搵唔到舊訂單，改為新建：', incomingBookingId);
    }

    // ===== CREATE =====
    const newBookingId = generateBookingId();

    const calendarEvent = await addToGoogleCalendar(bookingData, newBookingId, null);
    const discordMessageId = await sendDiscordNotification(bookingData, newBookingId, true, false, null);

    if (discordMessageId && calendarEvent && calendarEvent.id) {
      await patchCalendarDiscordMessageId(calendarEvent.id, discordMessageId);
    }

    return ok({ success: true, bookingId: newBookingId, updated: false });

  } catch (error) {
    console.error('處理訂單時出錯：', error);
    return err(500, error.message);
  }
};

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
  return {
    eventId: ev.id,
    bookingId: bookingId,
    discordMessageId: (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.discordMessageId) || null
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

  description = description
    .replace(/\[([^\]]+)\]\(tel:[^)]+\)/g, '$1')
    .replace(/\[WhatsApp\]\(<([^>]+)>\)/g, 'WhatsApp：$1')
    .replace(/^⚡ 即時訂單 ⚡\n\n/m, '')
    .replace(/\n\n🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸$/, '');

  description = insertBookingIdAfterFare(description, bookingId);

  // ⭐ 建立結構化資料（用於 lookup-booking 查詢）
  const cleanPhone = String(data.phone || '').replace(/\D/g, '');
  const stopoversStr = Array.isArray(data.stopoverTexts)
    ? data.stopoverTexts.map(function(s) {
        return String(s).replace(/中途站\d+:\s*/, '');
      }).join('、')
    : '';

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
    feeMode: data.feeMode || ''
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
  const result = await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId: existing.eventId,
    resource: resource,
    sendUpdates: 'all'
  });
  console.log('日曆已更新：', result.data.htmlLink);
  return result.data;
}

async function patchCalendarDiscordMessageId(eventId, discordMessageId) {
  try {
    const calendar = getCalendarClient();
    const ev = await calendar.events.get({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId: eventId
    });
    const existing = (ev.data.extendedProperties && ev.data.extendedProperties.private) || {};
    const merged = Object.assign({}, existing, { discordMessageId: discordMessageId });

    await calendar.events.patch({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId: eventId,
      resource: {
        extendedProperties: { private: merged }
      }
    });
    console.log('已回寫 Discord messageId');
  } catch (e) {
    console.error('回寫 discordMessageId 失敗：', e);
  }
}

function buildDiscordMessage(data, bookingId, isUpdate, changedFields) {
  let body = data.fullMessage || data.description || '收到新訂單';

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

  body = insertBookingIdAfterFare(body, bookingId);
  return body;
}

async function sendDiscordNotification(data, bookingId, waitForId, isUpdate, changedFields) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('Discord 未設定，跳過通知');
    return null;
  }

  const message = buildDiscordMessage(data, bookingId, isUpdate === true, changedFields || null);
  const reqBody = JSON.stringify({ content: message, flags: 4 });

  if (waitForId) {
    const urlWithWait = webhookUrl + (webhookUrl.indexOf('?') >= 0 ? '&' : '?') + 'wait=true';
    try {
      const res = await fetch(urlWithWait, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody
      });
      if (res.ok) {
        const json = await res.json();
        console.log('Discord 已發送（含 messageId）：', json.id);
        return json.id;
      }
      const errText = await res.text().catch(function() { return ''; });
      console.warn('[Discord] wait=true 失敗，改用普通 POST。狀態:', res.status, errText);
    } catch (e) {
      console.warn('[Discord] wait=true 拋錯，改用普通 POST:', e.message);
    }
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reqBody
    });
    if (res.ok) {
      console.log('Discord 通知已發送（無 messageId）');
    } else {
      const errText = await res.text().catch(function() { return ''; });
      console.error('[Discord] 普通 POST 失敗。狀態:', res.status, errText);
    }
    return null;
  } catch (error) {
    console.error('[Discord] 普通 POST 拋錯：', error);
    return null;
  }
}

// 刪除 Discord 訊息
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
    const res = await fetch(deleteUrl, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      console.log('Discord 舊訊息已刪除（或不存在）：', messageId);
      return true;
    }
    const errText = await res.text().catch(function() { return ''; });
    console.error('[Discord] 刪除失敗。狀態:', res.status, errText);
    return false;
  } catch (e) {
    console.error('[Discord] 刪除拋錯：', e);
    return false;
  }
}

// ⭐ 方案 C：先發新訊息，成功後刪除舊訊息
async function updateDiscordNotification(existing, data, changedFields) {
  console.log('方案 C：發新訊息 + 刪舊訊息');

  const oldMessageId = existing.discordMessageId;

  // 1) 先發新訊息（帶紅色 diff）→ 拎新 messageId
  const newMessageId = await sendDiscordNotification(
    data,
    existing.bookingId,
    true,           // waitForId
    true,           // isUpdate
    changedFields
  );

  if (!newMessageId) {
    console.error('新訊息發送失敗，保留舊訊息唔刪');
    return;
  }

  // 2) 新訊息成功發出 → 刪除舊訊息
  if (oldMessageId) {
    await deleteDiscordMessage(oldMessageId);
  }

  // 3) 更新 Calendar 嘅 discordMessageId 為最新嗰條
  await patchCalendarDiscordMessageId(existing.eventId, newMessageId);
}
