const { google } = require('googleapis');

exports.handler = async (event) => {
  // 處理 CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }
    };
  }

  try {
    const bookingData = JSON.parse(event.body);
    
    // 寫入 Google Calendar
    await addToGoogleCalendar(bookingData);
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ success: true, message: '預約成功' })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ success: false, error: error.message })
    };
  }
};

// Google Calendar 整合
async function addToGoogleCalendar(data) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  const calendar = google.calendar({ version: 'v3', auth });
  
  // 計算結束時間（假設車程 1 小時）
  const startTime = new Date(`${data.date}T${data.time}:00+08:00`);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

  const event = {
    summary: `🚕 ${data.carType} - ${data.pickup} → ${data.dropoff}`,
    description: `📞 電話：${data.phone}
👤 聯絡人：${data.surname} ${data.title}
👥 人數：${data.passengers}
🧳 行李：${data.luggages}
💳 付款：${data.paymentMethod}
💰 車費：HK$${data.totalFare}
${data.flightNo ? `✈️ 航班：${data.flightNo}\n` : ''}${data.stopover ? `🛑 中途站：${data.stopover}\n` : ''}${data.hasPet ? '🐶 有寵物\n' : ''}${data.hasWheelchair ? '♿ 有輪椅\n' : ''}📝 升級選項：${data.upgradeOption}`,
    start: {
      dateTime: startTime.toISOString(),
      timeZone: 'Asia/Hong_Kong'
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: 'Asia/Hong_Kong'
    },
    colorId: '10' // 綠色
  };

  await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: event,
    sendUpdates: 'all'
  });
}
