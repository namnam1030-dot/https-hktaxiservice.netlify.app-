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
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `BK-${ts}-${rand}`;
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const bookingData = JSON.parse(event.body);
    console.log('收到訂單：', bookingData);

    const incomingBookingId = bookingData.bookingId || null;

    // ===== 即時訂單：永遠 CREATE，唔支援修改 =====
    if (bookingData.orderType === 'instant') {
      console.log('即時訂單，跳過 Calendar');
      await sendDiscordNotification(bookingData, null, false);
      return ok({ success: true, bookingId: null, updated: false });
    }

    // ===== 預約訂單：有 bookingId 先試 UPDATE =====
    if (incomingBookingId) {
      const existing = await findExistingBooking(incomingBookingId);
      if (existing) {
        await updateGoogleCalendar(existing, bookingData);
        await updateDiscordNotification(existing, bookingData);
        console.log('訂單已更新：', incomingBookingId);
        return ok({ success: true, bookingId: incomingBookingId, updated: true });
      }
      console.log('搵唔到舊訂單，改為新建：', incomingBookingId);
    }

    // ===== CREATE =====
    const newBookingId = generateBookingId();

    const calendarEvent = await addToGoogleCalendar(bookingData, newBookingId, null);
    const discordMessageId = await sendDiscordNotification(bookingData, newBookingId, true);

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
    privateExtendedProperty: [`bookingId=${bookingId}`],
    maxResults: 1
  });
  const items = res.data.items || [];
  if (items.length === 0) return null;
  const ev = items[0];
  return {
    eventId: ev.id,
    bookingId,
    discordMessageId: ev.extendedProperties?.private?.discordMessageId || null
  };
}

function buildCalendarEvent(data, bookingId, discordMessageId) {
  const startTime = new Date(`${data.date}T${data.time}:00+08:00`);
  const endTime = new Date(startTime);
  endTime.setMinutes(endTime.getMinutes() + 1);

  const bookingSourceMark = data.isInternalBooking === true
    ? '\n\n[網站預約] 👤 工作人員落單'
    : '\n\n[網站預約]';

  let description = data.fullMessage || data.customerMessage
    || `📞 電話：${data.phone}\n📍 ${data.pickup} → ${data.dropoff}`;

  description = description
    .replace(/\[([^\]]+)\]\(tel:[^)]+\)/g, '$1')
    .replace(/\[WhatsApp\]\(<([^>]+)>\)/g, 'WhatsApp：$1')
    .replace(/^⚡ 即時訂單 ⚡\n\n/m, '')
    .replace(/\n\n🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸🔸$/, '');

  const privateProps = { bookingId };
  if (discordMessageId) privateProps.discordMessageId = discordMessageId;

  return {
    summary: `🚕 ${data.pickup} → ${data.dropoff} - ${data.carType || '的士預約'}`,
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
    resource,
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
    resource,
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
      eventId
    });
    const existing = ev.data.extendedProperties?.private || {};
    await calendar.events.patch({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId,
      resource: {
        extendedProperties: {
          private: { ...existing, discordMessageId }
        }
      }
    });
    console.log('已回寫 Discord messageId');
  } catch (e) {
    console.error('回寫 discordMessageId 失敗：', e);
  }
}

// ============================================
// ⭐ 已改：Discord 訊息加修改時間戳
// ============================================
function buildDiscordMessage(data, bookingId, isUpdate) {
  let body = data.fullMessage || data.description || '收到新訂單';
  if (isUpdate) {
    const now = new Date().toLocaleString('zh-HK', {
      timeZone: 'Asia/Hong_Kong',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    body = `🔄 **【訂單已修改】** _(${now})_\n` + body;
  }
  if (bookingId) body += `\n🆔 \`${bookingId}\``;
  return body;
}

async function sendDiscordNotification(data, bookingId, waitForId) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('Discord 未設定，跳過通知');
    return null;
  }

  const message = buildDiscordMessage(data, bookingId, false);
  const url = waitForId
    ? webhookUrl + (webhookUrl.includes('?') ? '&' : '?') + 'wait=true'
    : webhookUrl;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, flags: 4 })
    });
    if (waitForId && res.ok) {
      const json = await res.json();
      console.log('Discord 已發送，messageId：', json.id);
      return json.id;
    }
    console.log('Discord 通知已發送');
    return null;
  } catch (error) {
    console.error('Discord 通知失敗：', error);
    return null;
  }
}

async function updateDiscordNotification(existing, data) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const wh = parseDiscordWebhook(webhookUrl);
  if (!wh) {
    console.error('無法解析 Discord webhook URL');
    return;
  }

  const messageId = existing.discordMessageId;

  if (!messageId) {
    console.log('舊訂單冇 discordMessageId，改為發新訊息');
    const newId = await sendDiscordNotification(data, existing.bookingId, true);
    if (newId) {
      await patchCalendarDiscordMessageId(existing.eventId, newId);
    }
    return;
  }

  const editUrl = `https://discord.com/api/webhooks/${wh.id}/${wh.token}/messages/${messageId}`;
  const message = buildDiscordMessage(data, existing.bookingId, true);

  try {
    const res = await fetch(editUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, flags: 4 })
    });
    if (res.ok) {
      console.log('Discord 訊息已更新');
    } else {
      console.error('Discord 更新失敗，狀態：', res.status, await res.text());
    }
  } catch (e) {
    console.error('Discord 更新出錯：', e);
  }
}
