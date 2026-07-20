const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function toDataUri(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
}

async function processImage(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const form = await request.formData();
    const tool = form.get('tool') || 'remove-bg';
    const prompt = String(form.get('prompt') || '').trim();
    const style = String(form.get('style') || '').trim();
    const image = form.get('image');

    if (tool === 'generate' && !prompt) return json({ error: 'Please describe the image you want to create.' }, 400);
    if (tool !== 'generate' && (!image || typeof image.arrayBuffer !== 'function')) return json({ error: 'No image was uploaded.' }, 400);
    if (!env.REPLICATE_API_TOKEN) return json({ error: 'The image service is not configured yet.' }, 503);

    const dataUri = tool === 'generate' ? null : await toDataUri(image);
    const models = {
      'remove-bg': {
        version: '95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1',
        input: { image: dataUri },
      },
      upscale: {
        version: '0fbacf7afc6c144e5be9767cff80f25aff23e52b0708f17e20f9879b2f21516c',
        input: { img: dataUri, version: 'v1.4', scale: 4 },
      },
      colorize: {
        version: 'ca494ba129e44e45f661d6ece83c4c98a9a7c774309beca01429b58fce8aa695',
        input: { image: dataUri, model_size: 'large' },
      },
      generate: {
        version: 'c86579ac5193bf45422f1c8b92742135aa859b1850a8e4c531bff222fc75273d',
        input: { prompt: style ? `${prompt}, ${style}` : prompt, width: 1024, height: 1024, num_outputs: 1, scheduler: 'K_EULER', num_inference_steps: 30, guidance_scale: 7.5, apply_watermark: true },
      },
    };
    const model = models[tool];
    if (!model) return json({ error: 'This tool is not available.' }, 400);

    let prediction = await (await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(model),
    })).json();
    if (!prediction.id) throw new Error(prediction.detail || 'Replicate could not start the request.');

    while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      prediction = await (await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` },
      })).json();
    }
    if (prediction.status !== 'succeeded') throw new Error(prediction.error || 'AI processing failed.');

    const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!output) throw new Error('No image was returned by the AI model.');
    const outputResponse = await fetch(output);
    return new Response(outputResponse.body, {
      headers: { ...corsHeaders, 'Content-Type': outputResponse.headers.get('content-type') || 'image/png', 'Cache-Control': 'public, max-age=86400' },
    });
  } catch (error) {
    return json({ error: error.message || 'Image processing failed.' }, 500);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/process') return processImage(request, env);
    return env.ASSETS.fetch(request);
  },
};
