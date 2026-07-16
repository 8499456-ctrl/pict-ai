export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try {
    const fd = await request.formData();
    const imageFile = fd.get('image');
    const tool = fd.get('tool') || 'remove-bg';
    if (!imageFile) return new Response(JSON.stringify({ error: 'No image' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const buffer = await imageFile.arrayBuffer();
    const b64 = btoa(new Uint8Array(buffer).reduce((d,b)=>d+String.fromCharCode(b),''));
    const dataUri = `data:${imageFile.type};base64,${b64}`;
    const token = env.REPLICATE_API_TOKEN;
    if (!token) return new Response(JSON.stringify({ error: 'API not configured' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const models = {
      'remove-bg': { version: 'a42d8ed4e8e3c1e5b5e5c5d5e5f5g5h5i5j5k5l5m5n5o5p5', input: { image: dataUri } },
      'upscale': { version: 'b42d8ed4e8e3c1e5b5e5c5d5e5f5g5h5i5j5k5l5m5n5o5p6', input: { image: dataUri, scale: 4 } },
    };
    const model = models[tool] || models['remove-bg'];
    const pred = await (await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: model.version, input: model.input }),
    })).json();
    if (!pred.id) throw new Error(pred.detail || 'Replicate error');
    let res = pred;
    while (res.status !== 'succeeded' && res.status !== 'failed') {
      await new Promise(r => setTimeout(r, 1000));
      res = await (await fetch(`https://api.replicate.com/v1/predictions/${res.id}`, { headers: { 'Authorization': `Bearer ${token}` } })).json();
    }
    if (res.status === 'failed') throw new Error('AI processing failed');
    const imgRes = await fetch(res.output);
    return new Response(await imgRes.blob(), { headers: { ...corsHeaders, 'Content-Type': imgRes.headers.get('content-type') || 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
