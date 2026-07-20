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
    const prompt = (fd.get('prompt') || '').toString().trim();
    const style = (fd.get('style') || '').toString().trim();

    if (tool === 'generate' && !prompt) {
      return new Response(JSON.stringify({ error: 'Please describe the image you want to create.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (tool !== 'generate' && (!imageFile || typeof imageFile.arrayBuffer !== 'function')) {
      return new Response(JSON.stringify({ error: 'No image' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let dataUri;
    if (tool !== 'generate') {
      const buffer = await imageFile.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      dataUri = `data:${imageFile.type};base64,${btoa(binary)}`;
    }
    const token = env.REPLICATE_API_TOKEN;
    if (!token) return new Response(JSON.stringify({ error: 'API not configured' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const models = {
      'remove-bg': {
        version: '95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1',
        input: { image: dataUri },
      },
      'upscale': {
        version: '0fbacf7afc6c144e5be9767cff80f25aff23e52b0708f17e20f9879b2f21516c',
        input: { img: dataUri, version: 'v1.4', scale: 4 },
      },
      'colorize': {
        version: 'ca494ba129e44e45f661d6ece83c4c98a9a7c774309beca01429b58fce8aa695',
        input: { image: dataUri, model_size: 'large' },
      },
      'generate': {
        version: 'c86579ac5193bf45422f1c8b92742135aa859b1850a8e4c531bff222fc75273d',
        input: {
          prompt: style ? `${prompt}, ${style}` : prompt,
          width: 1024,
          height: 1024,
          num_outputs: 1,
          scheduler: 'K_EULER',
          num_inference_steps: 30,
          guidance_scale: 7.5,
          apply_watermark: true,
        },
      },
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
    const output = Array.isArray(res.output) ? res.output[0] : res.output;
    if (!output) throw new Error('No image was returned by the AI model');
    const imgRes = await fetch(output);
    return new Response(await imgRes.blob(), { headers: { ...corsHeaders, 'Content-Type': imgRes.headers.get('content-type') || 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
