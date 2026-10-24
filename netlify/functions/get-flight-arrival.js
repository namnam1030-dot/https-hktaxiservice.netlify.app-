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

// 獲取香港時區嘅日期字串 (YYYY-MM-DD)
function getHKDateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 將 ISO 時間轉成 HH:MM (香港時間)
function formatToHHMM(isoString) {
  try {
    const dt = new Date(isoString);
    if (isNaN(dt.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Hong_Kong',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(dt);
    const hh = parts.find(function(p) { return p.type === 'hour'; });
    const mm = parts.find(function(p) { return p.type === 'minute'; });
    if (hh && mm) return hh.value + ':' + mm.value;
    return null;
  } catch (e) {
    return null;
  }
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
    let flightNo = String(body.flightNo || '').trim().toUpperCase().replace(/\s+/g, '');
    let date = String(body.date || '').trim();

    if (!flightNo) return err(400, '請輸入航班編號');

    const rapidApiKey = process.env.RAPIDAPI_KEY;
    const rapidApiHost = process.env.RAPIDAPI_AERODATABOX_HOST || 'aerodatabox.p.rapidapi.com';

    if (!rapidApiKey) {
      console.error('[FlightArrival] 缺少 RAPIDAPI_KEY 環境變數');
      return err(500, '伺服器未設定航班 API 金鑰');
    }

    // 決定要查邊幾日
    let datesToQuery = [];
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      datesToQuery.push(date);
    } else {
      // 如果冇指定日期，查今日起 4 日 (因為預約限制最多 3 日內)
      for (let i = 0; i <= 4; i++) {
        datesToQuery.push(getHKDateStr(i));
      }
    }

    // 定義單次查詢函數
    async function fetchFlightForDate(d) {
      const url = 'https://' + rapidApiHost + '/flights/number/' + encodeURIComponent(flightNo) + '/' + encodeURIComponent(d);
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'X-RapidAPI-Key': rapidApiKey,
            'X-RapidAPI-Host': rapidApiHost
          }
        });
        
        if (!response.ok) return null; // 404 或其他錯誤直接跳過
        
        const responseText = await response.text();
        if (!responseText || responseText.trim() === '') return null;

        let data;
        try { data = JSON.parse(responseText); } catch (e) { return null; }

        const flights = Array.isArray(data) ? data : [data];
        const arrivalsToHKG = flights.filter(function(f) {
          return f && f.arrival && f.arrival.airport && f.arrival.airport.iata === HKG_IATA;
        });

        if (arrivalsToHKG.length === 0) {
          if (flights.length > 0 && flights[0] && flights[0].arrival) {
            arrivalsToHKG.push(flights[0]);
          } else {
            return null;
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

        if (!bestTime) return null;

        const hhmm = formatToHHMM(bestTime);
        if (!hhmm) return null;

        return {
          date: d,
          timeHHMM: hhmm,
          status: flight.status || 'Scheduled'
        };
      } catch (e) {
        return null;
      }
    }

    // 並行查詢所有指定日期
    const promises = datesToQuery.map(d => fetchFlightForDate(d));
    const results = await Promise.all(promises);

    // 過濾出成功嘅結果
    const validFlights = results.filter(r => r !== null);

    if (validFlights.length === 0) {
      return err(404, '搵唔到呢個航班嘅近期資料，請檢查航班編號。');
    }

    return ok({
      success: true,
      flightNo: flightNo,
      flights: validFlights // 返回包含多個 {date, timeHHMM, status} 嘅 Array
    });

  } catch (error) {
    console.error('[FlightArrival] 伺服器出錯：', error);
    return err(500, '伺服器暫時未能處理請求');
  }
};
