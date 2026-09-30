const { google } = require('googleapis');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function ok(body) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}
function err(code, message, extra) {
  const payload = Object.assign({ success: false, error: message }, extra || {});
  return { statusCode: code, headers: CORS_HEADERS, body: JSON.stringify(payload) };
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

// 只保留數字（方便對比電話）
function cleanPhone(s) {
  return String(s || '').replace(/\D/g, '');
}

// 由 description 抽電話（舊訂單 fallback）
function extractPhoneFromDescription(description) {
  if (!description) return '';
  // 匹配「📞 電話：9123 4567」或「📞 電話：+852 9123 4567」等格式
  const m = description.match(/📞\s*電話[：:]\s*([+\d\s\-()]+)/);
  if (!m) return '';
  return cleanPhone(m[1]);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return err(405, 'Method Not Allowed');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const inputBookingId = String(body.bookingId || '').trim();
    const inputPhone = cleanPhone(body.phone);

    // 基本驗證
    if (!inputBookingId || !/^\d{4}$/.test(inputBookingId)) {
      return err(400, '請輸入 4 位數字預約編號');
    }
    if (!inputPhone || inputPhone.length < 4) {
      return err(400, '請輸入有效嘅電話號碼');
    }

    console.log('[Lookup] 查詢 bookingId:', inputBookingId, '，phone:', inputPhone);

    const calendar = getCalendarClient();

    // 用 bookingId 搵 event
    const res = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      privateExtendedProperty: ['bookingId=' + inputBookingId],
      maxResults: 1
    });

    const items = res.data.items || [];
    if (items.length === 0) {
      console.log('[Lookup] 搵唔到 bookingId');
      return err(404, '搵唔到呢個預約編號');
    }

    const ev = items[0];
    const ext = (ev.extendedProperties && ev.extendedProperties.private) || {};

    // ===== 電話驗證 =====
    let phoneMatch = false;
    let matchSource = '';

    // 1) 優先對比 extendedProperties.phone
    if (ext.phone) {
      if (cleanPhone(ext.phone) === inputPhone) {
        phoneMatch = true;
        matchSource = 'extendedProperties';
      } else if (cleanPhone(ext.phone).endsWith(inputPhone) && inputPhone.length >= 4) {
        // 允許輸入後 4 位（客人可能只記後 4 位）
        phoneMatch = true;
        matchSource = 'extendedProperties-suffix';
      }
    }

    // 2) Fallback：由 description 抽電話
    if (!phoneMatch) {
      const descPhone = extractPhoneFromDescription(ev.description);
      if (descPhone) {
        if (descPhone === inputPhone) {
          phoneMatch = true;
          matchSource = 'description';
        } else if (descPhone.endsWith(inputPhone) && inputPhone.length >= 4) {
          phoneMatch = true;
          matchSource = 'description-suffix';
        }
      }
    }

    // 3) 都搵唔到 → 失敗
    if (!phoneMatch) {
      console.log('[Lookup] 電話唔匹配');
      return err(403, '預約編號或電話唔正確');
    }

    console.log('[Lookup] 成功，匹配方式：', matchSource);

    // ===== 組裝返回資料 =====
    let orderData = {};

    // 新訂單：有完整 extendedProperties
    if (ext.pickup || ext.dropoff || ext.date) {
      orderData = {
        pickup: ext.pickup || '',
        dropoff: ext.dropoff || '',
        stopovers: ext.stopovers || '',
        date: ext.date || '',
        time: ext.time || '',
        flightNo: ext.flightNo || '',
        passengers: ext.passengers || '',
        luggages: ext.luggages || '',
        hasPet: ext.hasPet === 'true',
        hasWheelchair: ext.hasWheelchair === 'true',
        payments: ext.payments || '',
        contactTitle: ext.contactTitle || '',
        contactSurname: ext.contactSurname || '',
        phone: ext.phone || '',
        isWechatCustomer: ext.isWechatCustomer === 'true',
        carDisplayText: ext.carDisplayText || '',
        feeMode: ext.feeMode || ''
      };
    } else {
      // 舊訂單：只有 description，盡量抽取可填嘅欄位
      const desc = ev.description || '';

      // 起點：由 summary 抽「🚕 XXX → YYY」
      const summaryMatch = (ev.summary || '').match(/🚕\s*(.+?)\s*→\s*(.+?)\s*-\s*/);
      const pickupFromSummary = summaryMatch ? summaryMatch[1].trim() : '';
      const dropoffFromSummary = summaryMatch ? summaryMatch[2].trim() : '';

      // 由 description 抽起點 / 終點 / 人數 / 電話
      const pickupMatch = desc.match(/📍\s*起點[：:]\s*(.+)/);
      const dropoffMatch = desc.match(/🏁\s*終點[：:]\s*(.+)/);
      const passengersMatch = desc.match(/👥\s*人數[：:]\s*(.+)/);
      const paymentMatch = desc.match(/💳\s*付款方式[：:]\s*(.+)/);
      const surnameMatch = desc.match(/👤\s*聯絡人[：:]\s*(.+)/);

      orderData = {
        pickup: pickupMatch ? pickupMatch[1].trim() : pickupFromSummary,
        dropoff: dropoffMatch ? dropoffMatch[1].trim() : dropoffFromSummary,
        stopovers: '',
        date: '',
        time: '',
        flightNo: '',
        passengers: passengersMatch ? passengersMatch[1].trim() : '',
        luggages: '',
        hasPet: false,
        hasWheelchair: false,
        payments: paymentMatch ? paymentMatch[1].trim() : '',
        contactTitle: '',
        contactSurname: surnameMatch ? surnameMatch[1].trim() : '',
        phone: inputPhone,
        isWechatCustomer: false,
        carDisplayText: '',
        feeMode: '',
        isLegacy: true   // ⭐ 標記係舊訂單，前端可提示
      };
    }

    return ok({
      success: true,
      bookingId: inputBookingId,
      orderData: orderData
    });

  } catch (error) {
    console.error('[Lookup] 出錯：', error);
    return err(500, error.message);
  }
};
