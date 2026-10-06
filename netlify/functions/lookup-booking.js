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

function extractPhoneFromDescription(description) {
  if (!description) return '';
  const m = description.match(/📞\s*電話[：:]\s*([+\d\s\-()]+)/);
  if (!m) return '';
  return String(m[1]).replace(/\D/g, '');
}

function cleanPhone(s) {
  return String(s || '').replace(/\D/g, '');
}

function extractStopoversFromDescription(description) {
  if (!description) return '';
  
  const m = description.match(/🛑\s*中途站[：:]\s*([^\n]+)/);
  if (m) return m[1].trim();
  
  const routeMatch = description.match(/（經\s*([^）]+)）/);
  if (routeMatch) return routeMatch[1].trim();
  
  return '';
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
    const inputAccessKey = String(body.accessKey || '').trim();

    if (!inputBookingId || !/^\d{4}$/.test(inputBookingId)) {
      return err(400, '請輸入 4 位數字預約編號');
    }

    // ⭐ 檢查內部密碼
    const internalKey = process.env.INTERNAL_ACCESS_KEY || '';
    const isInternalAccess = (inputAccessKey && internalKey && inputAccessKey === internalKey);

    // ⭐ 如果唔係內部密碼，就需要電話號碼
    if (!isInternalAccess && !inputPhone) {
      return err(400, '請輸入電話號碼或內部密碼');
    }

    console.log('[Lookup] 查詢 bookingId:', inputBookingId, '，內部訪問:', isInternalAccess ? '是' : '否');

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

    // ===== 電話驗證（只適用於非內部訪問）=====
    if (!isInternalAccess) {
      let phoneMatch = false;
      let matchSource = '';

      if (ext.phone) {
        if (cleanPhone(ext.phone) === inputPhone) {
          phoneMatch = true;
          matchSource = 'extendedProperties';
        }
      }

      if (!phoneMatch) {
        const descPhone = extractPhoneFromDescription(ev.description);
        if (descPhone && descPhone === inputPhone) {
          phoneMatch = true;
          matchSource = 'description';
        }
      }

      if (!phoneMatch) {
        console.log('[Lookup] 電話唔匹配');
        return err(403, '預約編號或電話唔正確');
      }

      console.log('[Lookup] 成功，匹配方式：', matchSource);
    } else {
      console.log('[Lookup] 內部訪問，跳過電話驗證');
    }

    // ===== 組裝返回資料 =====
    let orderData = {};

    if (ext.pickup || ext.dropoff || ext.date) {
      let stopovers = ext.stopovers || '';
      if (!stopovers) {
        stopovers = extractStopoversFromDescription(ev.description);
      }

      orderData = {
        pickup: ext.pickup || '',
        dropoff: ext.dropoff || '',
        stopovers: stopovers,
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
        feeMode: ext.feeMode || '',
        baseFare: parseInt(ext.baseFare || '0', 10) || 0,
        tunnelFee: parseInt(ext.tunnelFee || '0', 10) || 0,
        surcharge: parseInt(ext.surcharge || '0', 10) || 0,
        selectedFareMode: ext.selectedFareMode || 'normal',
        selectedCarName: ext.selectedCarName || ''
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
      const stopoversFromDesc = extractStopoversFromDescription(desc);

      orderData = {
        pickup: pickupMatch ? pickupMatch[1].trim() : pickupFromSummary,
        dropoff: dropoffMatch ? dropoffMatch[1].trim() : dropoffFromSummary,
        stopovers: stopoversFromDesc,
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
        baseFare: 0,
        tunnelFee: 0,
        surcharge: 0,
        selectedFareMode: 'normal',
        selectedCarName: '',
        isLegacy: true
      };
    }

    return ok({
      success: true,
      bookingId: inputBookingId,
      orderData: orderData,
      isInternalAccess: isInternalAccess
    });

  } catch (error) {
    console.error('[Lookup] 出錯：', error);
    return err(500, error.message);
  }
};
