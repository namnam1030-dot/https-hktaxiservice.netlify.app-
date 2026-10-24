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

const HKG_IATA = 'HKG';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return err(405, 'Method Not Allowed');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    let flightNo = String(body.flightNo || '').trim().toUpperCase().replace(/\s+/g, '');
    let date = String(body.date || '').trim();

    if (!flightNo) return err(400, '請輸入航班編號');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(400, '請提供有效日期（YYYY-MM-DD）');

    const rapidApiKey = process.env.RAPIDAPI_KEY;
    const rapidApiHost = process.env.RAPIDAPI_AERODATABOX_HOST || 'aerodatabox.p.rapidapi.com';

    if (!rapidApiKey) {
      console.error('[FlightArrival] 缺少 RAPIDAPI_KEY 環境變數');
      return err(500, '伺服器未設定航班 API 金鑰');
    }

    const url = 'https://' + rapidApiHost + '/flights/number/' + encodeURIComponent(flightNo) + '/' + encodeURIComponent(date);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': rapidApiKey,
        'X-RapidAPI-Host': rapidApiHost
      }
    });

    // ⭐ 修復核心：用 text() 接收，防止 204 或空白回應令 .json() 崩潰
    const responseText = await response.text();

    if (!response.ok) {
      console.error('[FlightArrival] AeroDataBox 回應失敗：', response.status, responseText);
      if (response.status === 404) return err(404, '搵唔到呢個航班，請檢查航班編號或日期');
      if (response.status === 429) return err(429, '航班查詢次數已達上限，請稍後再試');
      return err(502, '航班資料服務暫時未能回應');
    }

    // ⭐ 如果 API 回傳空白，直接當作搵唔到
    if (!responseText || responseText.trim() === '') {
      return err(404, '搵唔到航班抵達時間資料');
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('[FlightArrival] JSON 解析失敗：', responseText);
      return err(502, '航班資料格式錯誤');
    }

    const flights = Array.isArray(data) ? data : [data];
    const arrivalsToHKG = flights.filter(function(f) {
      return f && f.arrival && f.arrival.airport && f.arrival.airport.iata === HKG_IATA;
    });

    if (arrivalsToHKG.length === 0) {
      if (flights.length > 0 && flights[0] && flights[0].arrival) {
        arrivalsToHKG.push(flights[0]);
      } else {
        return err(404, '搵唔到航班抵達時間資料');
      }
    }

    const flight = arrivalsToHKG[0];
    const arrival = flight.arrival || {};

    function pickLocalTime(timeObj) {
      if (!timeObj) return null;
      if (timeObj.local) return timeObj.local;
      if (timeObj.utc) return timeObj.utc;
      return null;
    }

    const scheduled = pickLocalTime(arrival.scheduledTime);
    const estimated = pickLocalTime(arrival.estimatedTime);
    const actual = pickLocalTime(arrival.actualTime);
    const bestTime = actual || estimated || scheduled;

    if (!bestTime) return err(404, '航班資料暫時未有抵達時間');

    let hhmm = '';
    try {
      const dt = new Date(bestTime);
      if (!isNaN(dt.getTime())) {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Hong_Kong',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(dt);
        const hh = parts.find(function(p) { return p.type === 'hour'; });
        const mm = parts.find(function(p) { return p.type === 'minute'; });
        if (hh && mm) hhmm = hh.value + ':' + mm.value;
      }
    } catch (e) {
      console.error('[FlightArrival] 時間轉換失敗：', e);
    }

    if (!hhmm) return err(500, '未能解析航班抵達時間');

    return ok({
      success: true,
      flightNo: flightNo,
      date: date,
      arrivalTimeHHMM: hhmm,
      scheduledTime: scheduled || null,
      estimatedTime: estimated || null,
      actualTime: actual || null,
      status: flight.status || null
    });

  } catch (error) {
    console.error('[FlightArrival] 伺服器出錯：', error);
    return err(500, '伺服器暫時未能處理請求');
  }
};
