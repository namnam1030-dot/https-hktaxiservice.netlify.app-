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
    
    console.log('收到訂單：', bookingData);
    
    // 1. 寫入 Google Calendar
    await addToGoogleCalendar(bookingData);
    
    // 2. 發送 Discord 通知（新事件）
    await sendDiscordNotification(bookingData);
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        success: true, 
        message: '預約成功，已加入日曆' 
      })
    };
  } catch (error) {
    console.error('處理訂單時出錯：', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        success: false, 
        error: error.message 
      })
    };
  }
};

// Google Calendar 整合
async function addToGoogleCalendar(data) {
  try {
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
    
    const startTime = new Date(`${data.date}T${data.time}:00+08:00`);
    const endTime = new Date(startTime);

const event = {
  summary: `🚕 ${data.pickup} → ${data.dropoff} - ${data.carType || '的士預約'}`,
  description: (data.fullMessage || `📞 電話：${data.phone}\n📍 ${data.pickup} → ${data.dropoff}`) + '\n\n[新事件已通知]',

      start: {
        dateTime: startTime.toISOString(),
        timeZone: 'Asia/Hong_Kong'
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: 'Asia/Hong_Kong'
      },
      colorId: '10',
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

// Discord 通知（新事件）
async function sendDiscordNotification(data) {
  const discordWebhook = process.env.DISCORD_WEBHOOK_URL;
  
  if (!discordWebhook) {
    console.log('Discord 未設定，跳過通知');
    return;
  }

  const message = data.fullMessage || data.description || '收到新訂單';

  try {
    await fetch(discordWebhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: `🆕 **新訂單通知**\n\n${message}`
      })
    });
    console.log('Discord 通知已發送');
  } catch (error) {
    console.error('Discord 通知失敗：', error);
  }
}
