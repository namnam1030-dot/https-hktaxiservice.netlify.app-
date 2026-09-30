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
    const title = String(body.title || 'Notification');
    const message = String(body.message || '');

    const ntfyUrl = process.env.NTFY_URL;
    if (!ntfyUrl) {
      console.log('[Forward-Ntfy] NTFY_URL 未設定');
      return err(500, 'NTFY_URL 未設定');
    }

    // 清理 Discord Markdown
    let clean = message
      .replace(/\[([^\]]+)\]\(tel:[^)]+\)/g, '$1')
      .replace(/\[WhatsApp\]\(<([^>]+)>\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\n{3,}/g, '\n\n');

    if (clean.length > 3500) {
      clean = clean.substring(0, 3500) + '\n…（內容過長已截斷）';
    }

    // ⭐ 移除 Title header，第一行唔會再顯示 Order / Order (ID)
    const res = await fetch(ntfyUrl, {
      method: 'POST',
      headers: {
        'Priority': 'high',
        'Tags': 'taxi',
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: clean
    });

    if (res.ok) {
      console.log('[Forward-Ntfy] 已發送');
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
