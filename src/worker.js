const ALLOWED_ORIGINS = new Set([
  'https://www.picttool.com',
  'https://picttool.com',
]);

const TOOL_GROUPS = {
  'remove-bg': 'basic',
  upscale: 'basic',
  colorize: 'basic',
  generate: 'generate',
  'game-avatar': 'creative',
  cartoon: 'creative',
  art: 'creative',
  'change-background': 'creative',
  'remove-object': 'creative',
  'scene-lighting': 'creative',
};

const DAILY_LIMITS = { basic: 3, generate: 1, creative: 1, feedback: 2 };

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.picttool.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Pict-Test-Token',
    'Access-Control-Expose-Headers': 'X-Pict-Quota-Limit, X-Pict-Quota-Remaining, X-Pict-Quota-Group',
    'Vary': 'Origin',
  };
}

function json(request, body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json', ...headers },
  });
}

function isAllowedRequest(request) {
  const origin = request.headers.get('Origin');
  // Mobile camera hand-offs and embedded browsers may send no Origin or the
  // literal value "null". Accept those normal uploads, and otherwise require
  // the request to come from the same host that is serving this Worker.
  if (!origin || origin === 'null') return true;
  return origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin);
}

function dayKey() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function quotaRequest(request, env, group, action, reservation) {
  if (!env.RATE_LIMITER) throw new Error('Daily usage protection is not configured yet.');
  const limit = DAILY_LIMITS[group];
  const id = env.RATE_LIMITER.idFromName(`${dayKey()}:${group}:${clientIp(request)}`);
  const response = await env.RATE_LIMITER.get(id).fetch('https://rate-limiter/', {
    method: 'POST',
    body: JSON.stringify({ action, day: dayKey(), limit, reservation }),
  });
  return { ok: response.ok, data: await response.json() };
}

async function toDataUri(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
}

async function replicateJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || payload.error || 'The AI service could not process this request.');
  return payload;
}

async function processImage(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders(request) });
  if (!isAllowedRequest(request)) return json(request, { error: 'This request is not allowed.' }, 403);

  let reservation;
  let group;
  try {
    const form = await request.formData();
    const tool = String(form.get('tool') || 'remove-bg');
    const prompt = String(form.get('prompt') || '').trim();
    const style = String(form.get('style') || '').trim();
    const image = form.get('image');
    group = TOOL_GROUPS[tool];
    const isTestMode = Boolean(env.ADMIN_TEST_TOKEN) && request.headers.get('X-Pict-Test-Token') === env.ADMIN_TEST_TOKEN;

    if (!group) return json(request, { error: 'This tool is not available.' }, 400);
    if ((tool === 'generate' || tool === 'remove-object') && (!prompt || prompt.length > 500)) return json(request, { error: 'Please enter a short description of up to 500 characters.' }, 400);
    if (tool !== 'generate') {
      if (!image || typeof image.arrayBuffer !== 'function') return json(request, { error: 'No image was uploaded.' }, 400);
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) return json(request, { error: 'Please upload a JPG, PNG, or WEBP image.' }, 400);
      if (image.size > 20 * 1024 * 1024) return json(request, { error: 'Please upload an image smaller than 20 MB.' }, 400);
    }
    if (!env.REPLICATE_API_TOKEN) return json(request, { error: 'The image service is not configured yet.' }, 503);

    if (!isTestMode) {
      const quota = await quotaRequest(request, env, group, 'reserve');
      if (!quota.ok) return json(request, { error: 'Today\'s free quota for this tool has been used. Please try again tomorrow.', quota: quota.data }, 429);
      reservation = quota.data.reservation;
    }

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
      // These creative edits share the same commercially usable image-to-image
      // model. Keeping input images to 1MP in the browser makes the cost and
      // turnaround time predictable for the free preview.
      'game-avatar': {
        model: 'black-forest-labs/flux-2-dev',
        input: { prompt: 'Create a clearly visible original fantasy-game avatar from this reference photo. Keep the same child or person immediately recognizable: preserve real facial features, age, hairstyle, expression, pose, body proportions, framing, and camera angle. Transform the clothing into an age-appropriate fantasy adventurer outfit that follows the original clothing colors and silhouette; replace the setting with an original magical landscape and add subtle glowing details. The result must still be obviously the same person and same pose, never an adult when the reference is a child, never a new person. Do not imitate any named game, character, artist, or logo.', input_images: [dataUri], aspect_ratio: 'match_input_image', output_format: 'jpg', output_quality: 82, go_fast: true },
      },
      cartoon: {
        model: 'black-forest-labs/flux-2-dev',
        input: { prompt: 'Use this reference image as the source of truth. Create a clean, charming cartoon rendering while preserving the exact main subject, facial features, hairstyle, expression, pose, clothing, object details, composition, framing, and colors. Keep it obviously the same image, only illustrated. Original artwork; do not imitate a named studio, character, or artist.', input_images: [dataUri], aspect_ratio: 'match_input_image', output_format: 'jpg', output_quality: 82, go_fast: true },
      },
      art: {
        model: 'black-forest-labs/flux-2-dev',
        input: { prompt: 'Create a clearly visible original digital-art version of this reference image. Preserve the exact main subject, facial features, hairstyle, expression, pose, clothing, object details, and composition so it remains immediately recognizable as the same image. Use richer color, painterly texture, and refined light, but do not redesign the subject or change people into someone else. Do not imitate a named artist.', input_images: [dataUri], aspect_ratio: 'match_input_image', output_format: 'jpg', output_quality: 82, go_fast: true },
      },
      'change-background': {
        model: 'black-forest-labs/flux-2-dev',
        input: { prompt: `Use this reference image as the source of truth. Preserve the main subject exactly: face, hairstyle, expression, pose, body proportions, clothing, foreground objects, framing, and camera angle. Change only the background to ${prompt || 'a clean, natural outdoor setting with soft daylight'}. Do not alter the subject or turn it into a new person. Natural edges and coherent light, original imagery.`, input_images: [dataUri], aspect_ratio: 'match_input_image', output_format: 'jpg', output_quality: 82, go_fast: true },
      },
      'remove-object': {
        model: 'black-forest-labs/flux-2-dev',
        input: { prompt: `Remove ${prompt} from this image. Preserve every other important subject and the original composition. Fill the removed area naturally and realistically.`, input_images: [dataUri], aspect_ratio: 'match_input_image', output_format: 'jpg', output_quality: 82, go_fast: true },
      },
      'scene-lighting': {
        model: 'black-forest-labs/flux-2-dev',
        input: { prompt: 'Use this reference photo as the source of truth. Improve only exposure, white balance, and gentle natural color. Preserve every person, face, hairstyle, expression, object, clothing detail, composition, and background exactly as shown. Keep the overall brightness at least as bright as the original; lift dark shadows gently and do not make the background darker. No cinematic color grading, no scene redesign, and no new objects.', input_images: [dataUri], aspect_ratio: 'match_input_image', output_format: 'jpg', output_quality: 82, go_fast: true },
      },
    };
    const model = models[tool];
    if (!model) return json(request, { error: 'This tool is not configured yet.' }, 503);
    const predictionUrl = model.model
      ? `https://api.replicate.com/v1/models/${model.model}/predictions`
      : 'https://api.replicate.com/v1/predictions';
    let prediction = await replicateJson(predictionUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(model.model ? { input: model.input } : model),
    });

    while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      prediction = await replicateJson(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` },
      });
    }
    if (prediction.status !== 'succeeded') throw new Error(prediction.error || 'AI processing failed.');

    const committed = isTestMode ? { data: { limit: 0, remaining: 0 } } : await quotaRequest(request, env, group, 'commit', reservation);
    reservation = null;
    const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!output) throw new Error('No image was returned by the AI model.');
    const outputResponse = await fetch(output);
    if (!outputResponse.ok) throw new Error('The result image could not be downloaded.');
    return new Response(outputResponse.body, {
      headers: {
        ...corsHeaders(request),
        'Content-Type': outputResponse.headers.get('content-type') || 'image/png',
        'Cache-Control': 'private, max-age=86400',
        'X-Pict-Quota-Limit': String(committed.data.limit),
        'X-Pict-Quota-Remaining': String(committed.data.remaining),
        'X-Pict-Quota-Group': group,
      },
    });
  } catch (error) {
    if (reservation && group) {
      try { await quotaRequest(request, env, group, 'release', reservation); } catch (_) { /* expires automatically */ }
    }
    return json(request, { error: error.message || 'Image processing failed.' }, 500);
  }
}

async function quotaStatus(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: corsHeaders(request) });
  // Same-origin browser GET requests may omit Origin. This endpoint only reports
  // remaining quota and never starts an AI job, so those reads are safe to allow.
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedRequest(request)) return json(request, { error: 'This request is not allowed.' }, 403);
  try {
    const groups = await Promise.all(Object.keys(DAILY_LIMITS).map(async group => {
      const result = await quotaRequest(request, env, group, 'status');
      return [group, result.data];
    }));
    return json(request, { groups: Object.fromEntries(groups) });
  } catch (error) {
    return json(request, { error: error.message || 'Could not load quota status.' }, 503);
  }
}

async function feedbackInbox(env, action, payload = {}) {
  if (!env.RATE_LIMITER) throw new Error('Feedback storage is not configured yet.');
  const id = env.RATE_LIMITER.idFromName('pict-feedback-inbox');
  const response = await env.RATE_LIMITER.get(id).fetch('https://feedback-inbox/', {
    method: 'POST',
    body: JSON.stringify({ action, ...payload }),
  });
  return { ok: response.ok, data: await response.json() };
}

async function submitFeedback(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders(request) });
  if (!isAllowedRequest(request)) return json(request, { error: 'This request is not allowed.' }, 403);

  let reservation;
  try {
    const { type, message, email } = await request.json();
    const safeType = ['idea', 'problem', 'result', 'other'].includes(type) ? type : 'other';
    const safeMessage = String(message || '').trim();
    const safeEmail = String(email || '').trim();
    if (safeMessage.length < 3 || safeMessage.length > 500) return json(request, { error: 'Please enter feedback between 3 and 500 characters.' }, 400);
    if (safeEmail && (!safeEmail.includes('@') || safeEmail.length > 254)) return json(request, { error: 'Please enter a valid email address.' }, 400);

    const quota = await quotaRequest(request, env, 'feedback', 'reserve');
    if (!quota.ok) return json(request, { error: 'You have sent the maximum number of feedback messages for today.' }, 429);
    reservation = quota.data.reservation;
    const saved = await feedbackInbox(env, 'feedback-submit', { type: safeType, message: safeMessage, email: safeEmail, createdAt: new Date().toISOString() });
    if (!saved.ok) throw new Error('Could not save feedback.');
    await quotaRequest(request, env, 'feedback', 'commit', reservation);
    return json(request, { ok: true, id: saved.data.id });
  } catch (error) {
    if (reservation) {
      try { await quotaRequest(request, env, 'feedback', 'release', reservation); } catch (_) { /* expires automatically */ }
    }
    return json(request, { error: error.message || 'Could not send feedback.' }, 500);
  }
}

async function listFeedback(request, env) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: corsHeaders(request) });
  // The dashboard sends this as a header so the password is not exposed in a URL,
  // browser history, or copied link.
  const token = request.headers.get('X-Pict-Admin-Token') || new URL(request.url).searchParams.get('token');
  if (!env.FEEDBACK_ADMIN_TOKEN) return json(request, { error: 'Feedback viewing is not configured yet.' }, 503);
  if (!token || token !== env.FEEDBACK_ADMIN_TOKEN) return json(request, { error: 'Not authorized.' }, 401);
  try {
    const result = await feedbackInbox(env, 'feedback-list');
    return json(request, { feedback: result.data.feedback || [] });
  } catch (error) {
    return json(request, { error: error.message || 'Could not load feedback.' }, 500);
  }
}

export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const payload = await request.json();
    const { action, day, limit, reservation } = payload;
    if (action === 'feedback-submit') {
      const messages = (await this.state.storage.get('feedbacks')) || [];
      const id = crypto.randomUUID();
      messages.unshift({
        id,
        type: payload.type,
        message: payload.message,
        email: payload.email || '',
        createdAt: payload.createdAt,
      });
      await this.state.storage.put('feedbacks', messages.slice(0, 100));
      return Response.json({ id });
    }
    if (action === 'feedback-list') {
      return Response.json({ feedback: (await this.state.storage.get('feedbacks')) || [] });
    }
    const now = Date.now();
    const data = (await this.state.storage.get('quota')) || { day, count: 0, pending: {} };
    if (data.day !== day) {
      data.day = day;
      data.count = 0;
      data.pending = {};
    }
    for (const [id, createdAt] of Object.entries(data.pending)) {
      if (now - createdAt > 10 * 60 * 1000) delete data.pending[id];
    }

    if (action === 'reserve') {
      const used = data.count + Object.keys(data.pending).length;
      if (used >= limit) return Response.json({ limit, remaining: Math.max(0, limit - used) }, { status: 429 });
      const id = crypto.randomUUID();
      data.pending[id] = now;
      await this.state.storage.put('quota', data);
      return Response.json({ limit, remaining: Math.max(0, limit - used - 1), reservation: id });
    }
    if (action === 'commit' && data.pending[reservation]) {
      delete data.pending[reservation];
      data.count += 1;
      await this.state.storage.put('quota', data);
    } else if (action === 'release' && data.pending[reservation]) {
      delete data.pending[reservation];
      await this.state.storage.put('quota', data);
    }
    const used = data.count + Object.keys(data.pending).length;
    return Response.json({ limit, remaining: Math.max(0, limit - used), used: data.count });
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/process') return processImage(request, env);
    if (pathname === '/api/quota') return quotaStatus(request, env);
    if (pathname === '/api/feedback') return request.method === 'GET' ? listFeedback(request, env) : submitFeedback(request, env);
    return env.ASSETS.fetch(request);
  },
};
