const { google } = require('googleapis');

exports.handler = async (event) => {
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
    
    // 即時訂單唔加入 Calendar，只發 Discord 通知
    if (bookingData.orderType === 'instant') {
      console.log('即時訂單，跳過 Calendar');
      await sendDiscordNotification(bookingData);
    } else {
      // 預約訂單：加入 Calendar + 發 Discord
      await addToGoogleCalendar(bookingData);
      await sendDiscordNotification(bookingData);
    }
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        success: true, 
        message: '預約成功' 
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
    
    // 預約訂單：用客戶指定時間
    const startTime = new Date(`${data.date}T${data.time}:00+08:00`);
    const endTime = new Date(startTime);
    endTime.setHours(endTime.getHours() + 1);

    const bookingSourceMark = data.isInternalBooking === true 
      ? '\n\n[網站預約] 👤 工作人員落單' 
      : '\n\n[網站預約]';

    let descriptionWithLinks = data.customerMessage || data.fullMessage || `📞 電話：${data.phone}\n📍 ${data.pickup} → ${data.dropoff}`;
    
    const cleanPhone = (data.phone || '').replace(/\D/g, '');
    if (cleanPhone) {
      let phoneWithCode = cleanPhone;
      if (phoneWithCode.length === 8) {
        phoneWithCode = '852' + phoneWithCode;
      }
      
      descriptionWithLinks = descriptionWithLinks.replace(
        `📞 電話：${data.phone}`,
        `📞 電話：${data.phone}\n📱 WhatsApp：https://wa.me/${phoneWithCode}`
      );
    }

    const event = {
      summary: `🚕 ${data.pickup} → ${data.dropoff} - ${data.carType || '的士預約'}`,
      description: descriptionWithLinks + bookingSourceMark,
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
          { method: 'popup', minutes: 30 }
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

async function sendDiscordNotification(data) {
  const discordWebhook = process.env.DISCORD_WEBHOOK_URL;
  
  if (!discordWebhook) {
    console.log('Discord 未設定，跳過通知');
    return;
  }

  let message = data.fullMessage || data.description || '收到新訂單';
  
  const cleanPhone = (data.phone || '').replace(/\D/g, '');
  if (cleanPhone) {
    let phoneWithCode = cleanPhone;
    if (phoneWithCode.length === 8) {
      phoneWithCode = '852' + phoneWithCode;
    }
    
    // Discord 電話連結：只顯示一個電話號碼，可直接點擊撥號
    message = message.replace(
      `📞 電話：${data.phone}`,
      `📞 電話：[${data.phone}](tel:${cleanPhone})`
    );
  }

  try {
    await fetch(discordWebhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: message,
        flags: 4
      })
    });
    console.log('Discord 通知已發送');
  } catch (error) {
    console.error('Discord 通知失敗：', error);
  }
}
