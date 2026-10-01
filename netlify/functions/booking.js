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
        console.log('訂單已更新：', incomingBookingId);
        return ok({ success: true, bookingId: incomingBookingId, updated: true });
      }
      console.log('Calendar 搵唔到 bookingId，視為首次入 Calendar：', incomingBookingId);
    }

    if (isInstantOrder) {
      const instantBookingId = incomingBookingId || generateBookingId();
      console.log('即時訂單，跳過 Calendar。bookingId:', instantBookingId);

      await sendDiscordNotification(bookingData, instantBookingId, false, isEdit, changedFields);

      return ok({ success: true, bookingId: instantBookingId, updated: isEdit });
    }

    const newBookingId = incomingBookingId || generateBookingId();

    const calendarEvent = await addToGoogleCalendar(bookingData, newBookingId, null);
    const discordMessageId = await sendDiscordNotification(bookingData, newBookingId, true, isEdit, changedFields);

    if (discordMessageId && calendarEvent && calendarEvent.id) {
      await patchCalendarDiscordMessageId(calendarEvent.id, discordMessageId);
    }

    return ok({ success: true, bookingId: newBookingId, updated: isEdit });

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
    .replace(/\n\n🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴$/, '')
    .replace(/\n\n🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸$/, ''); // 兼容舊格式

  // ⭐ 清理電話 + 中途站字串
  const cleanPhone = String(data.phone || '').replace(/\D/g, '');
  const stopoversStr = Array.isArray(data.stopoverTexts)
    ? data.stopoverTexts.map(function(s) {
        return String(s).replace(/中途站\d+:\s*/, '');
      }).join('、')
    : '';

  // ⭐ 如果 description 冇中途站，喺起點前加「🛑有中途站」+ 中途站
  if (stopoversStr && description.indexOf('🛑有中途站') < 0 && description.indexOf('🛑 中途站') < 0) {
    // 支援兩種格式：
    // 1. customerMessage: "📍 起點：xxx\n..."  → 插去「📍 起點：」上一行
    // 2. fullMessage: "🚕 xxx → yyy\n..."     → 插去「🚕 ...」上一行
    const pickupLineMatch = description.match(/^(📍\s*起點[：:][^\n]*\n)/m);
    if (pickupLineMatch) {
      description = description.replace(
        pickupLineMatch[0],
        '🛑有中途站\n' + pickupLineMatch[0] + '🛑 中途站：' + stopoversStr + '\n'
      );
    } else {
      const firstLineMatch = description.match(/^([^\n]*\n)/);
      if (firstLineMatch) {
        description = description.replace(
          firstLineMatch[0],
          '🛑有中途站\n' + firstLineMatch[0] + '🛑 中途站：' + stopoversStr + '\n'
        );
      } else {
        description = '🛑有中途站\n🛑 中途站：' + stopoversStr + '\n' + description;
      }
    }
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

/* ============================================
   Discord 通知（隨機延遲 + 429 重試）
   ============================================ */

function buildDiscordMessage(data, bookingId, isUpdate, changedFields) {
  let body = data.fullMessage || data.description || '收到新訂單';

  // ⭐ 支援 stopoverTexts（array）或 stopover（string）
  let stopoversStr = '';
  if (Array.isArray(data.stopoverTexts)) {
    stopoversStr = data.stopoverTexts.map(function(s) {
      return String(s).replace(/中途站\d+:\s*/, '');
    }).join('、');
  } else if (typeof data.stopover === 'string' && data.stopover.trim()) {
    stopoversStr = data.stopover.trim();
  }

  // ⭐ 有中途站，喺最頂加提醒（唔顯示中途站名）
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
        console.warn('[Retry] 429 Rate Limit，等 ' + waitMs + 'ms 後重試 (' + (attempt + 1) + '/' + maxRetries + ')');
        await new Promise(function(r) { setTimeout(r, waitMs); });
        lastResponse = res;
        continue;
      }

      if (res.status >= 500) {
        const waitMs = (attempt + 1) * 2000;
        console.warn('[Retry] ' + res.status + ' Server Error，等 ' + waitMs + 'ms 後重試 (' + (attempt + 1) + '/' + maxRetries + ')');
        await new Promise(function(r) { setTimeout(r, waitMs); });
        lastResponse = res;
        continue;
      }

      return res;

    } catch (e) {
      if (attempt < maxRetries - 1) {
        const waitMs = (attempt + 1) * 2000;
        console.warn('[Retry] 網絡錯誤：' + e.message + '，等 ' + waitMs + 'ms 後重試 (' + (attempt + 1) + '/' + maxRetries + ')');
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
      console.warn('[Discord] wait=true 失敗，改用普通 POST。狀態:', res ? res.status : '無回應', errText);
    } catch (e) {
      console.warn('[Discord] wait=true 拋錯，改用普通 POST:', e.message);
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
      console.log('Discord 舊訊息已刪除（或不存在）：', messageId);
      return true;
    }
    const errText = res ? await res.text().catch(function() { return ''; }) : '';
    console.error('[Discord] 刪除失敗。狀態:', res ? res.status : '無回應', errText);
    return false;
  } catch (e) {
    console.error('[Discord] 刪除拋錯：', e);
    return false;
  }
}

async function updateDiscordNotification(existing, data, changedFields) {
  console.log('Discord：發新訊息 + 刪舊訊息');

  const oldMessageId = existing.discordMessageId;

  const newMessageId = await sendDiscordNotification(
    data,
    existing.bookingId,
    true,
    true,
    changedFields
  );

  if (!newMessageId) {
    console.error('Discord 新訊息發送失敗，保留舊訊息唔刪');
    return;
  }

  if (oldMessageId) {
    await deleteDiscordMessage(oldMessageId);
  }

  await patchCalendarDiscordMessageId(existing.eventId, newMessageId);
}
