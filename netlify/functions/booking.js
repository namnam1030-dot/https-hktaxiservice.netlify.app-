async function addToGoogleCalendar(data) {
  try {
    // 檢查環境變數
    if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
      throw new Error('缺少 GOOGLE_SERVICE_ACCOUNT 環境變數');
    }
    if (!process.env.GOOGLE_CALENDAR_ID) {
      throw new Error('缺少 GOOGLE_CALENDAR_ID 環境變數');
    }

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ['https://www.googleapis.com/auth/calendar']
    });

    const calendar = google.calendar({ version: 'v3', auth });
    
    // 計算開始時間
    const startTime = new Date(`${data.date}T${data.time}:00+08:00`);
    // 結束時間 = 開始時間（同一時間）
    const endTime = new Date(startTime);

    const event = {
      summary: `🚕 ${data.pickup} → ${data.dropoff} - ${data.carType || '的士預約'}`,
      description: data.fullMessage || `📞 電話：${data.phone}\n📍 ${data.pickup} → ${data.dropoff}`,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: 'Asia/Hong_Kong'
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: 'Asia/Hong_Kong'
      },
      colorId: '10',
      // 提前 20 分鐘通知
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 20 }
        ]
      }
    };

    const result = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      resource: event,
      sendUpdates: 'all'
    });

    console.log('成功加入日曆：', result.data.htmlLink);
    return result.data;
  } catch (error) {
    console.error('Google Calendar 錯誤：', error);
    throw error;
  }
}
