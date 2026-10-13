const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { origin, destination, waypoints } = body;
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: false, error: 'Server misconfigured: missing GOOGLE_MAPS_API_KEY' })
      };
    }
    if (!origin || !destination) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: false, error: 'origin and destination required' })
      };
    }

    const params = new URLSearchParams({
      origin: origin,
      destination: destination,
      mode: 'driving',
      alternatives: 'true',
      language: 'zh-HK',
      region: 'hk',
      departure_time: 'now',
      traffic_model: 'best_guess',
      key: apiKey
    });

    if (Array.isArray(waypoints) && waypoints.length > 0) {
      params.append('waypoints', waypoints.join('|'));
    }

    const url = 'https://maps.googleapis.com/maps/api/directions/json?' + params.toString();
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'OK') {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: false, error: data.status, message: data.error_message || '' })
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: true, data: data })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
