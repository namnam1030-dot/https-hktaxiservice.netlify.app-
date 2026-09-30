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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return err(405, 'Method Not Allowed');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const title = String(body.title || '').trim();
    const message = String(body.message || '');

    const ntfyUrl = process.env.NTFY_URL;
    if (!ntfyUrl) {
      console.log('[Forward-Ntfy] NTFY_URL 未設定');
      return err(500, 'NTFY_URL 未設定');
    }

    // ⭐ 保留 [tel:xxx] 連結，只將 Discord 格式 [WhatsApp](<url>) 轉做標準 markdown
    let clean = message
      .replace(/\[WhatsApp\]\(<([^>]+)>\)/g, '[WhatsApp]($1)')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\n{3,}/g, '\n\n');

    if (clean.length > 3500) {
      clean = clean.substring(0, 3500) + '\n…（內容過長已截斷）';
    }

    // ⭐ 動態加 Title header：只有 title 有值先傳
    // ⭐ 加 Markdown: yes，令 tel: 連結可以點擊
    const reqHeaders = {
      'Priority': 'high',
      'Tags': 'taxi',
      'Markdown': 'yes',
      'Content-Type': 'text/plain; charset=utf-8'
    };
    if (title && title !== 'Notification') {
      reqHeaders['Title'] = title;
    }

    const res = await fetch(ntfyUrl, {
      method: 'POST',
      headers: reqHeaders,
      body: clean
    });

    if (res.ok) {
      console.log('[Forward-Ntfy] 已發送', title ? '(Title: ' + title + ')' : '(無 Title)');
      return ok({ success: true });
    } else {
      const errText = await res.text().catch(() => '');
      console.error('[Forward-Ntfy] 失敗：', res.status, errText);
      return err(500, 'ntfy 發送失敗');
    }
  } catch (error) {
    console.error('[Forward-Ntfy] 拋錯：', error);
    return err(500, error.message);
  }
};
