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

// 由 description 抽電話（舊訂單 fallback）
function extractPhoneFromDescription(description) {
  if (!description) return '';
  const m = description.match(/📞\s*電話[：:]\s*([+\d\s\-()]+)/);
  if (!m) return '';
  return String(m[1]).replace(/\D/g, '');
}

// ⭐ 產生電話候選集
// 規則：
//   8 位        → [8位, 852+8位]（香港號碼）
//   11位 852開頭 → [11位, 去852後8位]（香港號碼帶國碼）
//   其他         → [原值]（大陸號碼、錯誤輸入等）
function phoneCandidates(input) {
  const d = String(input || '').replace(/\D/g, '');
  const result = [];
  if (!d) return result;

  if (d.length === 8) {
    result.push(d);
    result.push('852' + d);
  } else if (d.length === 11 && d.indexOf('852') === 0) {
    result.push(d);
    result.push(d.slice(3));
  } else {
    result.push(d);
  }
  return result;
}

// ⭐ 比對兩個電話（候選集交集唔為空 = 匹配）
function phoneMatches(inputPhone, storedPhone) {
  const inputCands = phoneCandidates(inputPhone);
  const storedCands = phoneCandidates(storedPhone);
  if (inputCands.length === 0 || storedCands.length === 0) return false;

  for (let i = 0; i < inputCands.length; i++) {
    for (let j = 0; j < storedCands.length; j++) {
      if (inputCands[i] === storedCands[j]) return true;
    }
  }
  return false;
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
    const inputPhoneRaw = String(body.phone || '').replace(/\D/g, '');

    // ⭐ 驗證：bookingId 必須 4 位數字
    if (!inputBookingId || !/^\d{4}$/.test(inputBookingId)) {
      return err(400, '請輸入 4 位數字預約編號');
    }

    // ⭐ 驗證：8 位（港）或 11 位（大陸 / 852+8）
    const validLen = inputPhoneRaw.length === 8 || inputPhoneRaw.length === 11;

    if (!validLen) {
      return err(400, '請輸入 8 位或 11 位數字電話號碼');
    }

    console.log('[Lookup] 查詢 bookingId:', inputBookingId, '，phone:', inputPhoneRaw);

    const calendar = getCalendarClient();

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

    if (ext.phone) {
      if (phoneMatches(inputPhoneRaw, ext.phone)) {
        phoneMatch = true;
        matchSource = 'extendedProperties';
      }
    }

    if (!phoneMatch) {
      const descPhone = extractPhoneFromDescription(ev.description);
      if (descPhone && phoneMatches(inputPhoneRaw, descPhone)) {
        phoneMatch = true;
        matchSource = 'description';
      }
    }

    if (!phoneMatch) {
      console.log('[Lookup] 電話唔匹配');
      return err(403, '預約編號或電話唔正確');
    }

    console.log('[Lookup] 成功，匹配方式：', matchSource);

    // ===== 組裝返回資料 =====
    let orderData = {};

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
      const desc = ev.description || '';
      const summaryMatch = (ev.summary || '').match(/🚕\s*(.+?)\s*→\s*(.+?)\s*-\s*/);
      const pickupFromSummary = summaryMatch ? summaryMatch[1].trim() : '';
      const dropoffFromSummary = summaryMatch ? summaryMatch[2].trim() : '';

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
        phone: inputPhoneRaw,
        isWechatCustomer: false,
        carDisplayText: '',
        feeMode: '',
        isLegacy: true
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
