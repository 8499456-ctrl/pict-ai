const ALLOWED_ORIGINS = new Set([
  'https://www.picttool.com',
  'https://picttool.com',
]);

const TOOL_GROUPS = {
  'remove-bg': 'basic',
  upscale: 'basic',
  colorize: 'basic',
  generate: 'generate',
  'comic-portrait': 'creative',
  'game-avatar': 'creative',
  cartoon: 'creative',
  art: 'creative',
  'change-background': 'creative',
  'remove-object': 'creative',
  'scene-lighting': 'creative',
};

const DAILY_LIMITS = { basic: 3, generate: 1, creative: 1, feedback: 2 };
const FINAL_PREDICTION_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const PREDICTION_POLL_INTERVAL_MS = 2000;
const MAX_PREDICTION_POLLS = 30;
const ART_STYLE_PROMPTS = {
  cinematic: 'vertical 3:4 cinematic portrait photoshoot, half-body or upper-body composition, strongly replace the original background with a cinematic city rooftop, modern high-rise skyline, night city lights, seaside railing, ocean pier, or sunset waterfront. The background must visibly change from the uploaded snapshot while staying realistic and tasteful. Use soft side light from above, one side of the face gently fading into shadow, realistic skin texture, muted colors, subtle film grain, calm professional editorial mood',
  literary: 'vertical 3:4 literary editorial portrait, half-body composition, replace the original background with a quiet cafe, library, window-light room, old street, or clean indoor atmosphere, soft natural window light, muted warm-gray palette, relaxed thoughtful expression, simple tasteful clothing, gentle film texture',
  melancholy: 'vertical 3:4 moody cinematic portrait, half-body composition, replace the original background with a deep neutral studio, rainy window, quiet night interior, or dark waterfront atmosphere, soft side light, gentle facial shadow, restrained calm expression, cool muted tones, controlled contrast, dramatic but realistic atmosphere',
  street: 'vertical 3:4 urban street portrait, half-body or full-body composition, replace the original background with a night city street, neon signs, wet pavement, alley wall, or modern urban scene, hoodie or modern streetwear styling, high contrast teal-magenta lighting, cinematic hip-hop editorial mood, realistic photography',
  japanese: 'vertical 3:4 Japanese-style quiet portrait, half-body or full-body composition, replace the original background with a minimalist room, soft window light, quiet street, seaside, or clean neutral setting, low saturation, clean composition, gentle natural expression, understated clothing, calm cinematic stillness',
};

function artStylePrompt(style) {
  return ART_STYLE_PROMPTS[style] || ART_STYLE_PROMPTS.cinematic;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.picttool.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Pict-Test-Token',
    'Access-Control-Expose-Headers': 'X-Pict-Quota-Limit, X-Pict-Quota-Remaining, X-Pict-Quota-Group, X-Pict-Test-Mode',
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

function isTestRequest(request, env) {
  const token = request.headers.get('X-Pict-Test-Token');
  return Boolean(env.ADMIN_TEST_TOKEN) && token === env.ADMIN_TEST_TOKEN;
}

function testQuotaGroups() {
  const quota = { limit: 999999, remaining: 999999, used: 0, test: true };
  return Object.fromEntries(Object.keys(DAILY_LIMITS).map(group => [group, quota]));
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
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = { error: text || 'The AI service returned an unreadable response.' };
  }
  if (!response.ok) throw new Error(payload.detail || payload.error || 'The AI service could not process this request.');
  return payload;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    const isTestMode = isTestRequest(request, env);

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
    const artDirection = artStylePrompt(style);
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
      'comic-portrait': {
        model: 'black-forest-labs/flux-kontext-pro',
        input: { prompt: `Turn this exact photo into a clean colorful editorial comic portrait. Keep the same person or people immediately recognizable: preserve faces, facial features, expressions, hairstyle, hairline, glasses, facial hair, age, body proportions, clothing, pose, camera angle, and composition. Add clear ink outlines, detailed linework, natural skin tones, realistic proportions, soft professional shading, and a polished magazine-style comic look. Keep the background coherent but do not let it distract from the subject. Do not make it watercolor, anime, manga, childish cartoon, storybook illustration, plastic-looking, or a different person.${prompt ? ` Additional user direction: ${prompt}` : ''}`, input_image: dataUri, aspect_ratio: 'match_input_image', output_format: 'jpg', safety_tolerance: 2, prompt_upsampling: false },
      },
      'game-avatar': {
        model: 'black-forest-labs/flux-2-dev',
        input: { prompt: 'Create a clearly visible original fantasy-game avatar from this reference photo. Keep the same child or person immediately recognizable: preserve real facial features, age, hairstyle, expression, pose, body proportions, framing, and camera angle. Transform the clothing into an age-appropriate fantasy adventurer outfit that follows the original clothing colors and silhouette; replace the setting with an original magical landscape and add subtle glowing details. The result must still be obviously the same person and same pose, never an adult when the reference is a child, never a new person. Do not imitate any named game, character, artist, or logo.', input_images: [dataUri], aspect_ratio: 'match_input_image', output_format: 'jpg', output_quality: 82, go_fast: true },
      },
      cartoon: {
        // The one-click cartoon filter can collapse photos into harsh line art.
        // Use prompt-guided Kontext Pro instead, so the result stays colorful
        // and the original person, composition, and proportions are protected.
        model: 'black-forest-labs/flux-kontext-pro',
        input: { prompt: 'Render this exact photo as a colorful, gentle hand-painted animation illustration: soft watercolor-like shading, clean rounded shapes, warm natural light, rich but realistic colors, and a cozy storybook feeling. Preserve the exact person or subject, facial features, age, hairstyle, expression, pose, body proportions, clothing, objects, composition, framing, and camera angle. Keep the subject immediately recognizable as the same person. Do not make black-and-white line art, pencil sketch, manga ink, comic hatching, exaggerated facial features, or a new person. Do not imitate a named studio, character, or artist.', input_image: dataUri, aspect_ratio: 'match_input_image', output_format: 'jpg', safety_tolerance: 2, prompt_upsampling: false },
      },
      art: {
        model: 'black-forest-labs/flux-kontext-pro',
        input: { prompt: `Use this uploaded photo mainly as the identity reference, not as a scene that must be copied. Create a realistic professional AI photoshoot that looks immediately attractive as a social profile image or editorial cover. Keep the same person immediately recognizable: preserve facial structure, facial features, age, hairstyle, hairline, facial hair, expression, skin texture, body proportions, and natural human anatomy. The photo style should be: ${artDirection}. Prefer a vertical 3:4 portrait composition when possible. Replace the original snapshot background with a tasteful professional portrait background unless the user explicitly asks to keep it. Improve clothing styling, adjust the pose slightly, and redesign lighting, color mood, and camera framing to make the portrait look polished. Keep the result photographic and believable, with real skin texture, natural shadows, and a professional camera look. Do not merely repaint the original photo. Do not keep cluttered indoor background, plain wall, home furniture, or casual room details unless the user explicitly asks. Do not make oil paint, watercolor, cartoon, anime, comic, plastic skin, over-smoothed face, orange skin, exaggerated muscles, a different person, distorted hands, extra fingers, explicit sexual content, or a fantasy costume. Do not imitate any named artist, celebrity, movie, brand, or copyrighted character.${prompt ? ` Additional user direction: ${prompt}` : ''}`, input_image: dataUri, aspect_ratio: 'match_input_image', output_format: 'jpg', safety_tolerance: 2, prompt_upsampling: false },
      },
      'change-background': {
        model: 'black-forest-labs/flux-2-dev',
        input: { prompt: `Use this reference image as the source of truth. Preserve the main subject exactly: face, hairstyle, expression, pose, body proportions, clothing, foreground objects, framing, and camera angle. Change only the background to ${prompt || 'a clean, natural outdoor setting with soft daylight'}. Do not alter the subject or turn it into a new person. Natural edges and coherent light, original imagery.`, input_images: [dataUri], aspect_ratio: 'match_input_image', output_format: 'jpg', output_quality: 82, go_fast: true },
      },
      'remove-object': {
        // A dedicated instruction-following editor is much more reliable for
        // removing one described object than a general creative image model.
        // It keeps this tool distinct from background removal: the subject and
        // existing background remain, while only the requested item is edited.
        model: 'reve/edit-fast',
        input: { image: dataUri, prompt: `Remove only ${prompt}. Keep every other person, object, edge, color, lighting, perspective, and the original composition unchanged. Naturally reconstruct only the area that was occupied by the requested item. Do not redesign the image or remove the entire background.` },
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

    let pollCount = 0;
    while (!FINAL_PREDICTION_STATUSES.has(prediction.status) && pollCount < MAX_PREDICTION_POLLS) {
      await sleep(PREDICTION_POLL_INTERVAL_MS);
      pollCount += 1;
      prediction = await replicateJson(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` },
      });
    }
    if (!FINAL_PREDICTION_STATUSES.has(prediction.status)) {
      throw new Error('The AI image is still processing. Please try again in a moment.');
    }
    if (prediction.status !== 'succeeded') throw new Error(prediction.error || 'AI processing failed.');

    const committed = isTestMode ? { data: { limit: 999999, remaining: 999999 } } : await quotaRequest(request, env, group, 'commit', reservation);
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
        'X-Pict-Test-Mode': isTestMode ? 'true' : 'false',
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
  if (isTestRequest(request, env)) return json(request, { groups: testQuotaGroups(), test: true });
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

function applyLocalizationFixes(html) {
  if (html.includes('id="pict-l10n-fix"')) return html;

  const layoutFixCss = `<style id="pict-l10n-layout-fix">
html[dir="rtl"] nav,html[dir="rtl"] .nav-inner,html[dir="rtl"] .nav-menu,html[dir="rtl"] .nav-secondary{direction:ltr}
html[dir="rtl"] .nav-links a,html[dir="rtl"] .nav-secondary a,html[dir="rtl"] .nav-language{direction:rtl}
html[dir="rtl"] .nav-language{justify-self:end}
html[dir="rtl"] .privacy-card,html[dir="rtl"] .generation-zone,html[dir="rtl"] .local-editor,html[dir="rtl"] .feedback-form{text-align:right}
html[dir="rtl"] .tool-card .arrow{right:auto;left:24px}
html[dir="rtl"] .tool-card:hover .arrow{transform:translateX(-3px)}
@media(max-width:768px){html[dir="rtl"] .nav-secondary{right:0;left:auto}}
</style>`;
  const localizationFixScript = `<script id="pict-l10n-fix">
(function(){
  if(window.__pictL10nFixApplied)return;
  window.__pictL10nFixApplied=true;
  const extras={
    en:{
      'tool.group.creative':'🎮 Creative tools for creators','tool.group.everyday':'✦ Everyday image tools','tool.group.quick':'✦ Quick tools — free & private in your browser',
      'nav.guides':'Guides','guides.label':'Popular guides','guides.title':'Explore PictTool by task','guides.intro':'Open a focused page for the tool you need, then jump straight into the editor when you are ready.','guides.comic.title':'Photo to Comic','guides.comic.desc':'Turn portraits, pets, and travel photos into colorful comic-style illustrations.','guides.remove.title':'Remove Background','guides.remove.desc':'Create clean cutouts for products, people, profile images, and social posts.','guides.travel.title':'Travel Photo to Art','guides.travel.desc':'Transform travel snapshots into watercolor-style art for Pinterest and memories.','guides.compress.title':'Image Compressor','guides.compress.desc':'Reduce image file size and convert JPG, PNG, or WebP before sharing.','guides.resize.title':'Resize & Crop Image','guides.resize.desc':'Crop images for Pinterest, Instagram, YouTube, and other social formats.','guides.open':'Open guide →',
      'tool.comic-portrait':'☷ Comic Portrait','tool.comic-portrait.desc':'Turn a portrait into a polished comic illustration while keeping the person recognizable.','tool.game-avatar.desc':'Turn a portrait into an original fantasy RPG avatar. No named characters or games.','tool.cartoon.desc':'Make a clean, charming cartoon version while keeping the subject recognizable.','tool.art.desc':'Choose a realistic portrait style such as cinematic, literary, moody, street, or Japanese.','tool.change-background.desc':'Keep the subject and create a new scene around it.','tool.remove-object.desc':'Remove one unwanted item while keeping the rest of your photo intact.','tool.scene-lighting.desc':'Improve light, color, and atmosphere without changing the scene.','tool.remove-bg.desc':'Instantly remove image backgrounds with AI. Perfect for people, products, and game screenshots.','tool.upscale.desc':'Enhance and upscale low-resolution images up to 4x. Revive old photos and game captures.','tool.colorize.desc':'Bring black-and-white photos to life with realistic AI colorization. Preserves original details.','tool.generate.desc':'Generate stunning images from text. Describe, create, and download.','tool.add-text.desc':'Add a headline or caption with fonts, color, shadow, and simple placement controls.','tool.resize-crop.desc':'Make a clean, ready-to-share image for Instagram, Pinterest, YouTube, and more.','tool.compress-convert.desc':'Reduce file size or convert between JPG, PNG, and WebP before you share.','tool.badge.new':'✨ New','tool.badge.popular':'🔥 Popular','tool.badge.local':'Free · No AI needed',
      'feature.fast':'Lightning Fast','feature.fast.desc':'AI processing in seconds. No queue, no waiting.','feature.private':'100% Private','feature.private.desc':'Images processed temporarily and deleted immediately.','feature.free':'Free Daily Usage','feature.free.desc':'No credit card needed. Free allowances every day.','footer.text':'Built with ❤️ — Pict · AI Image Tools · Free for everyone','footer.avatarGuide':'📖 Avatar Guide','prompt.note':'Tip: English prompts usually produce more accurate results.','upload.tap':'Tap to choose an image','drop.local':'JPG, PNG, WEBP — up to 50MB, processed locally','quota.local':'Free quick tool: unlimited, processed in your browser','quota.default':'Free today: 3 basic edits · 1 image generation','quota.remaining':'Free today — {name} remaining: {remaining}/{limit}','quota.test':'🧪 Private test mode: daily free quota is not used','quota.basic':'basic edits','quota.generate':'image generation','quota.creative':'creative edit','quota.localName':'quick tools',
      'local.add-text.help':'Your image stays in this browser. Add a headline, caption, and simple style, then download.','local.resize-crop.help':'Crop your image to popular social-media sizes. Nothing is uploaded.','local.compress-convert.help':'Choose JPG, WebP, or PNG and set the download quality. Your image is never uploaded.','creativePromptLabel.game-avatar':'Original fantasy game avatar','creativePromptHelp.game-avatar':'Keeps the person’s face, age, hair, and pose, while creating a clearly visible original fantasy-adventurer look.','creativePromptLabel.comic-portrait':'Comic portrait','creativePromptHelp.comic-portrait':'Turn a portrait or team photo into a polished comic illustration. Better prompts help preserve face, hair, expression, and style.','creativePromptLabel.cartoon':'Cartoon effect','creativePromptHelp.cartoon':'Keeps the subject, objects, composition, and colors, then illustrates the same image.','creativePromptLabel.art':'AI photoshoot','creativePromptHelp.art':'Choose a cinematic, literary, moody, street, or Japanese-style portrait. Better prompts help keep identity and mood stable.','creativePromptLabel.change-background':'New background (optional)','creativePromptHelp.change-background':'Only the background changes; the subject, pose, clothing, and foreground stay intact. Example: a sunny flower garden.','creativePromptLabel.remove-object':'What should be removed?','creativePromptHelp.remove-object':'Describe one specific item and its location, for example: the red bag on the table. This keeps the rest of the photo intact.','creativePromptLabel.scene-lighting':'Lighting enhance','creativePromptHelp.scene-lighting':'Improves exposure, white balance, and natural color only, without darkening or redesigning the scene.','creative.placeholder.object':'For example: the red bag on the table','creative.placeholder.scene':'For example: a moonlit forest'
    },
    zh:{'tool.group.creative':'🎮 创作者工具','tool.group.everyday':'✦ 日常图片工具','tool.group.quick':'✦ 快捷工具 — 免费且在浏览器本地处理','nav.guides':'入口','guides.label':'常用入口','guides.title':'按任务打开 PictTool','guides.intro':'进入更详细的工具页面，了解用途和示例，准备好后可直接跳到编辑器。','guides.comic.title':'照片转漫画','guides.comic.desc':'把头像、宠物和旅行照片变成彩色漫画风插画。','guides.remove.title':'去除背景','guides.remove.desc':'为商品、人物、头像和社交帖子制作干净抠图。','guides.travel.title':'旅行照片转艺术','guides.travel.desc':'把旅行随手拍变成水彩风艺术图，适合 Pinterest 和纪念收藏。','guides.compress.title':'图片压缩','guides.compress.desc':'分享前压缩图片体积，或在 JPG、PNG、WebP 之间转换。','guides.resize.title':'图片改尺寸与裁剪','guides.resize.desc':'裁剪成 Pinterest、Instagram、YouTube 等平台常用比例。','guides.open':'打开页面 →','tool.comic-portrait':'☷ 漫画肖像','tool.comic-portrait.desc':'把头像变成精致漫画插画，同时尽量保留人物识别度。','tool.game-avatar.desc':'把头像变成原创幻想 RPG 头像，不使用已有角色或游戏。','tool.cartoon.desc':'生成清爽可爱的卡通版本，同时保留主体识别度。','tool.art.desc':'选择电影、文艺、忧郁、街头或日系写真风格。','tool.change-background.desc':'保留主体，为画面生成新的背景场景。','tool.remove-object.desc':'移除一个不想要的物体，同时保留照片其他部分。','tool.scene-lighting.desc':'优化光线、色彩和氛围，不改变原场景。','tool.remove-bg.desc':'用 AI 快速去除图片背景，适合人物、商品和游戏截图。','tool.upscale.desc':'将低清图片增强到最高 4 倍，修复旧照片和游戏截图。','tool.colorize.desc':'为黑白照片添加自然色彩，并保留原始细节。','tool.generate.desc':'用文字生成图片，描述、创建并下载。','tool.add-text.desc':'添加标题或说明，并调整字体、颜色、阴影和位置。','tool.resize-crop.desc':'裁剪成适合 Instagram、Pinterest、YouTube 等平台的尺寸。','tool.compress-convert.desc':'分享前压缩体积，或在 JPG、PNG、WebP 间转换。','tool.badge.new':'✨ 新功能','tool.badge.popular':'🔥 热门','tool.badge.local':'免费 · 不需要 AI','footer.avatarGuide':'📖 头像指南','prompt.note':'提示：文字生图模型使用英文描述通常更准确。','upload.tap':'点击选择图片','drop.local':'JPG、PNG、WEBP — 最大 50MB，本地处理','quota.local':'免费本地工具：不限次数，不上传到服务器','quota.default':'每日免费：基础修图 3 次 · 文字生图 1 次','quota.remaining':'今日{name}剩余：{remaining}/{limit}','quota.test':'🧪 私人测试模式：不占用每日免费次数','quota.basic':'基础修图','quota.generate':'文字生图','quota.creative':'高级创意编辑','quota.localName':'本地实用工具','local.add-text.help':'图片仅在本机浏览器中处理。添加标题、说明和简单样式后即可下载。','local.resize-crop.help':'按常见社交媒体比例裁剪图片。裁剪只在本机完成。','local.compress-convert.help':'选择 JPG、WebP 或 PNG，并调整下载质量。图片不会上传到服务器。','creativePromptLabel.game-avatar':'原创幻想游戏头像','creativePromptHelp.game-avatar':'保留人物脸、年龄、发型与姿势，同时生成清晰可见的原创幻想冒险者服装和场景。','creativePromptLabel.comic-portrait':'漫画肖像','creativePromptHelp.comic-portrait':'把头像或团队照变成专业漫画肖像。提示词越具体，脸部、发型、表情和风格越稳定。','creativePromptLabel.cartoon':'卡通化风格','creativePromptHelp.cartoon':'默认保留原图的人物、物体、构图与颜色，只把画面转为卡通效果。','creativePromptLabel.art':'AI写真','creativePromptHelp.art':'选择电影、文艺、忧郁、街头或日系写真风格。提示词越具体，人物身份和氛围越稳定。','creativePromptLabel.change-background':'新背景描述（可选）','creativePromptHelp.change-background':'只更换背景，人物、姿势、衣服和前景会尽量保持不变。例如：阳光花园。','creativePromptLabel.remove-object':'要删除什么？','creativePromptHelp.remove-object':'只描述一个具体物体，并写明位置。例如：the red bag on the table。不会去除整张图片的背景。','creativePromptLabel.scene-lighting':'灯光优化','creativePromptHelp.scene-lighting':'只改善曝光、白平衡和自然色彩；不会故意压暗背景或改变场景。','creative.placeholder.object':'例如：桌子上的红色包','creative.placeholder.scene':'例如：月光森林'},
    es:{'tool.group.creative':'🎮 Herramientas creativas','tool.group.everyday':'✦ Herramientas diarias de imagen','tool.group.quick':'✦ Herramientas rápidas — gratis y privadas en tu navegador','tool.comic-portrait':'☷ Retrato cómic','tool.game-avatar':'🎮 Avatar fantástico','tool.cartoon':'🧸 Foto a caricatura','tool.art':'📸 Sesión con IA','tool.change-background':'🏞️ Cambiar fondo','tool.remove-object':'🧹 Quitar objeto','tool.scene-lighting':'💡 Mejorar luz','tool.add-text':'✍️ Añadir texto','tool.resize-crop':'↔️ Redimensionar y recortar','tool.compress-convert':'🗜️ Comprimir y convertir','tool.comic-portrait.desc':'Convierte un retrato en una ilustración cómic pulida manteniendo a la persona reconocible.','tool.game-avatar.desc':'Convierte un retrato en un avatar RPG fantástico original, sin personajes ni juegos existentes.','tool.cartoon.desc':'Crea una versión caricatura limpia y agradable manteniendo el sujeto reconocible.','tool.art.desc':'Elige un retrato realista: cinematográfico, literario, urbano, japonés o con ambiente.','tool.change-background.desc':'Mantén el sujeto y crea una nueva escena alrededor.','tool.remove-object.desc':'Elimina un elemento no deseado y conserva intacto el resto de la foto.','tool.scene-lighting.desc':'Mejora luz, color y ambiente sin cambiar la escena.','tool.remove-bg.desc':'Quita fondos con IA al instante, ideal para personas, productos y capturas de juegos.','tool.upscale.desc':'Mejora imágenes de baja resolución hasta 4x. Recupera fotos antiguas y capturas.','tool.colorize.desc':'Da vida a fotos en blanco y negro con colorización realista.','tool.generate.desc':'Genera imágenes desde texto: describe, crea y descarga.','tool.add-text.desc':'Añade un título o subtítulo con fuentes, color, sombra y posición sencilla.','tool.resize-crop.desc':'Prepara una imagen lista para Instagram, Pinterest, YouTube y más.','tool.compress-convert.desc':'Reduce tamaño o convierte entre JPG, PNG y WebP antes de compartir.','tool.badge.new':'✨ Nuevo','tool.badge.popular':'🔥 Popular','tool.badge.local':'Gratis · Sin IA','feature.fast':'Muy rápido','feature.fast.desc':'Procesamiento con IA en segundos. Sin cola ni espera.','feature.private':'100% privado','feature.private.desc':'Las imágenes se procesan temporalmente y se eliminan de inmediato.','feature.free':'Uso diario gratis','feature.free.desc':'Sin tarjeta. Cuotas gratuitas todos los días.','footer.text':'Hecho con ❤️ — Pict · Herramientas de imagen IA · Gratis para todos','footer.avatarGuide':'📖 Guía de avatar','prompt.note':'Consejo: las indicaciones en inglés suelen dar resultados más precisos.','upload.tap':'Toca para elegir una imagen','drop.local':'JPG, PNG, WEBP — hasta 50 MB, procesado localmente','quota.local':'Herramienta rápida gratis: uso ilimitado en tu navegador','quota.default':'Gratis hoy: 3 ediciones básicas · 1 generación','quota.remaining':'Gratis hoy — {name} restantes: {remaining}/{limit}','quota.test':'🧪 Modo privado de prueba: no usa la cuota diaria','quota.basic':'ediciones básicas','quota.generate':'generación de imágenes','quota.creative':'edición creativa','quota.localName':'herramientas rápidas'},
    fr:{'tool.group.creative':'🎮 Outils créatifs','tool.group.everyday':'✦ Outils image du quotidien','tool.group.quick':'✦ Outils rapides — gratuits et privés dans votre navigateur','tool.comic-portrait':'☷ Portrait BD','tool.game-avatar':'🎮 Avatar fantasy','tool.cartoon':'🧸 Photo en cartoon','tool.art':'📸 Shooting IA','tool.change-background':'🏞️ Changer le fond','tool.remove-object':'🧹 Supprimer un objet','tool.scene-lighting':'💡 Améliorer la lumière','tool.add-text':'✍️ Ajouter du texte','tool.resize-crop':'↔️ Redimensionner et recadrer','tool.compress-convert':'🗜️ Compresser et convertir','tool.comic-portrait.desc':'Transforme un portrait en illustration BD soignée tout en gardant la personne reconnaissable.','tool.game-avatar.desc':'Transforme un portrait en avatar RPG fantasy original, sans personnages ni jeux nommés.','tool.cartoon.desc':'Crée une version cartoon nette et charmante en gardant le sujet reconnaissable.','tool.art.desc':'Choisissez un portrait réaliste : cinéma, littéraire, urbain, japonais ou atmosphérique.','tool.change-background.desc':'Gardez le sujet et créez une nouvelle scène autour de lui.','tool.remove-object.desc':'Supprimez un élément indésirable tout en gardant le reste de la photo intact.','tool.scene-lighting.desc':'Améliorez lumière, couleur et ambiance sans changer la scène.','tool.remove-bg.desc':'Supprimez les arrière-plans instantanément avec l’IA, idéal pour personnes, produits et captures de jeu.','tool.upscale.desc':'Améliorez les images basse résolution jusqu’à 4x. Ravivez anciennes photos et captures.','tool.colorize.desc':'Redonnez vie aux photos noir et blanc avec une colorisation réaliste.','tool.generate.desc':'Générez des images à partir de texte : décrivez, créez, téléchargez.','tool.add-text.desc':'Ajoutez un titre ou une légende avec police, couleur, ombre et placement simple.','tool.resize-crop.desc':'Préparez une image prête à partager pour Instagram, Pinterest, YouTube et plus.','tool.compress-convert.desc':'Réduisez la taille ou convertissez entre JPG, PNG et WebP avant de partager.','tool.badge.new':'✨ Nouveau','tool.badge.popular':'🔥 Populaire','tool.badge.local':'Gratuit · Sans IA','feature.fast':'Ultra rapide','feature.fast.desc':'Traitement IA en quelques secondes. Pas de file, pas d’attente.','feature.private':'100% privé','feature.private.desc':'Les images sont traitées temporairement puis supprimées immédiatement.','feature.free':'Usage quotidien gratuit','feature.free.desc':'Aucune carte bancaire. Des quotas gratuits chaque jour.','footer.text':'Créé avec ❤️ — Pict · Outils d’image IA · Gratuit pour tous','footer.avatarGuide':'📖 Guide avatar','prompt.note':'Astuce : les prompts en anglais donnent souvent des résultats plus précis.','upload.tap':'Touchez pour choisir une image','drop.local':'JPG, PNG, WEBP — jusqu’à 50 Mo, traitement local','quota.local':'Outil rapide gratuit : illimité, traité dans votre navigateur','quota.default':'Gratuit aujourd’hui : 3 retouches de base · 1 génération','quota.remaining':'Gratuit aujourd’hui — {name} restantes : {remaining}/{limit}','quota.test':'🧪 Mode test privé : le quota quotidien n’est pas utilisé','quota.basic':'retouches de base','quota.generate':'génération d’image','quota.creative':'retouche créative','quota.localName':'outils rapides'},
    pt:{'tool.group.creative':'🎮 Ferramentas criativas','tool.group.everyday':'✦ Ferramentas de imagem do dia a dia','tool.group.quick':'✦ Ferramentas rápidas — grátis e privadas no navegador','tool.comic-portrait':'☷ Retrato em quadrinhos','tool.game-avatar':'🎮 Avatar fantasia','tool.cartoon':'🧸 Foto para cartoon','tool.art':'📸 Ensaio com IA','tool.change-background':'🏞️ Trocar fundo','tool.remove-object':'🧹 Remover objeto','tool.scene-lighting':'💡 Melhorar luz','tool.add-text':'✍️ Adicionar texto','tool.resize-crop':'↔️ Redimensionar e cortar','tool.compress-convert':'🗜️ Comprimir e converter','tool.comic-portrait.desc':'Transforme um retrato em ilustração de quadrinhos mantendo a pessoa reconhecível.','tool.game-avatar.desc':'Transforme um retrato em avatar RPG fantasia original, sem personagens ou jogos existentes.','tool.cartoon.desc':'Crie uma versão cartoon limpa e charmosa mantendo o sujeito reconhecível.','tool.art.desc':'Escolha um retrato realista: cinema, literário, urbano, japonês ou com clima marcante.','tool.change-background.desc':'Mantenha o sujeito e crie uma nova cena ao redor.','tool.remove-object.desc':'Remova um item indesejado mantendo o restante da foto intacto.','tool.scene-lighting.desc':'Melhore luz, cor e atmosfera sem alterar a cena.','tool.remove-bg.desc':'Remova fundos com IA instantaneamente, ideal para pessoas, produtos e capturas de jogos.','tool.upscale.desc':'Melhore imagens de baixa resolução até 4x. Recupere fotos antigas e capturas.','tool.colorize.desc':'Dê vida a fotos em preto e branco com colorização realista.','tool.generate.desc':'Gere imagens a partir de texto: descreva, crie e baixe.','tool.add-text.desc':'Adicione título ou legenda com fontes, cor, sombra e posicionamento simples.','tool.resize-crop.desc':'Crie uma imagem pronta para Instagram, Pinterest, YouTube e mais.','tool.compress-convert.desc':'Reduza o tamanho ou converta entre JPG, PNG e WebP antes de compartilhar.','tool.badge.new':'✨ Novo','tool.badge.popular':'🔥 Popular','tool.badge.local':'Grátis · Sem IA','feature.fast':'Muito rápido','feature.fast.desc':'Processamento por IA em segundos. Sem fila, sem espera.','feature.private':'100% privado','feature.private.desc':'As imagens são processadas temporariamente e apagadas em seguida.','feature.free':'Uso diário grátis','feature.free.desc':'Sem cartão. Limites gratuitos todos os dias.','footer.text':'Criado com ❤️ — Pict · Ferramentas de imagem IA · Grátis para todos','footer.avatarGuide':'📖 Guia de avatar','prompt.note':'Dica: prompts em inglês geralmente produzem resultados mais precisos.','upload.tap':'Toque para escolher uma imagem','drop.local':'JPG, PNG, WEBP — até 50 MB, processado localmente','quota.local':'Ferramenta rápida grátis: ilimitada, processada no navegador','quota.default':'Grátis hoje: 3 edições básicas · 1 geração','quota.remaining':'Grátis hoje — {name} restantes: {remaining}/{limit}','quota.test':'🧪 Modo de teste privado: não usa a cota diária','quota.basic':'edições básicas','quota.generate':'geração de imagem','quota.creative':'edição criativa','quota.localName':'ferramentas rápidas'},
    ja:{'tool.group.creative':'🎮 クリエイター向けツール','tool.group.everyday':'✦ 日常画像ツール','tool.group.quick':'✦ クイックツール — 無料・ブラウザ内で非公開処理','tool.comic-portrait':'☷ コミック肖像','tool.game-avatar':'🎮 ファンタジーアバター','tool.cartoon':'🧸 写真をカートゥーン化','tool.art':'📸 AIフォト撮影','tool.change-background':'🏞️ 背景を変更','tool.remove-object':'🧹 オブジェクト削除','tool.scene-lighting':'💡 ライト補正','tool.add-text':'✍️ 画像に文字を追加','tool.resize-crop':'↔️ リサイズ・切り抜き','tool.compress-convert':'🗜️ 圧縮・変換','tool.comic-portrait.desc':'人物の印象を保ちながら、肖像を洗練されたコミック風イラストにします。','tool.game-avatar.desc':'既存キャラクターやゲームを使わず、肖像をオリジナルのファンタジーRPGアバターにします。','tool.cartoon.desc':'被写体の認識性を保ちながら、清潔で魅力的なカートゥーン版を作ります。','tool.art.desc':'映画風、文芸風、ムーディー、ストリート、日系などのリアルな肖像スタイルを選べます。','tool.change-background.desc':'被写体を保ち、その周囲に新しい背景シーンを作ります。','tool.remove-object.desc':'不要なものを1つ削除し、写真の他の部分は保ちます。','tool.scene-lighting.desc':'シーンを変えずに光、色、雰囲気を整えます。','tool.remove-bg.desc':'人物、商品、ゲーム画像に便利なAI背景削除をすばやく実行します。','tool.upscale.desc':'低解像度画像を最大4倍に高画質化。古い写真やキャプチャを改善します。','tool.colorize.desc':'白黒写真を自然な色でよみがえらせ、細部を保ちます。','tool.generate.desc':'テキストから画像を生成。説明して、作成して、ダウンロードできます。','tool.add-text.desc':'フォント、色、影、配置を調整してタイトルや説明文を追加します。','tool.resize-crop.desc':'Instagram、Pinterest、YouTubeなどに共有しやすい画像に整えます。','tool.compress-convert.desc':'共有前にサイズを減らし、JPG、PNG、WebP間で変換します。','tool.badge.new':'✨ 新機能','tool.badge.popular':'🔥 人気','tool.badge.local':'無料 · AI不要','feature.fast':'高速処理','feature.fast.desc':'AI処理は数秒。待ち行列なし。','feature.private':'100%プライベート','feature.private.desc':'画像は一時的に処理され、すぐ削除されます。','feature.free':'毎日無料','feature.free.desc':'カード不要。毎日無料枠があります。','footer.text':'❤️ で制作 — Pict · AI画像ツール · だれでも無料','footer.avatarGuide':'📖 アバターガイド','prompt.note':'ヒント：英語のプロンプトのほうが正確な結果になりやすいです。','upload.tap':'タップして画像を選択','drop.local':'JPG、PNG、WEBP — 最大50MB、ローカル処理','quota.local':'無料クイックツール：無制限、ブラウザ内で処理','quota.default':'本日の無料枠：基本編集3回 · 画像生成1回','quota.remaining':'本日の無料枠 — {name} 残り：{remaining}/{limit}','quota.test':'🧪 非公開テストモード：毎日の無料枠は消費されません','quota.basic':'基本編集','quota.generate':'画像生成','quota.creative':'クリエイティブ編集','quota.localName':'クイックツール'},
    ko:{'tool.group.creative':'🎮 크리에이터 도구','tool.group.everyday':'✦ 일상 이미지 도구','tool.group.quick':'✦ 빠른 도구 — 무료, 브라우저에서 비공개 처리','tool.comic-portrait':'☷ 코믹 초상화','tool.game-avatar':'🎮 판타지 아바타','tool.cartoon':'🧸 사진을 만화로','tool.art':'📸 AI 프로필 촬영','tool.change-background':'🏞️ 배경 변경','tool.remove-object':'🧹 물체 제거','tool.scene-lighting':'💡 조명 보정','tool.add-text':'✍️ 이미지에 텍스트 추가','tool.resize-crop':'↔️ 크기 조정 및 자르기','tool.compress-convert':'🗜️ 압축 및 변환','tool.comic-portrait.desc':'인물을 알아볼 수 있게 유지하면서 초상화를 완성도 높은 코믹 일러스트로 바꿉니다.','tool.game-avatar.desc':'기존 캐릭터나 게임 없이 초상화를 독창적인 판타지 RPG 아바타로 바꿉니다.','tool.cartoon.desc':'대상을 알아볼 수 있게 유지하면서 깔끔하고 매력적인 만화 버전을 만듭니다.','tool.art.desc':'시네마틱, 문예, 무드, 스트리트, 일본풍 등 사실적인 인물 스타일을 선택하세요.','tool.change-background.desc':'대상은 유지하고 주변에 새로운 장면을 만듭니다.','tool.remove-object.desc':'원하지 않는 물체 하나를 제거하고 사진의 나머지는 유지합니다.','tool.scene-lighting.desc':'장면은 바꾸지 않고 빛, 색, 분위기를 개선합니다.','tool.remove-bg.desc':'인물, 제품, 게임 캡처에 적합한 AI 배경 제거를 즉시 실행합니다.','tool.upscale.desc':'저해상도 이미지를 최대 4배 개선해 오래된 사진과 캡처를 되살립니다.','tool.colorize.desc':'흑백 사진에 자연스러운 색을 입히고 원본 디테일을 보존합니다.','tool.generate.desc':'텍스트로 이미지를 생성합니다. 설명하고, 만들고, 다운로드하세요.','tool.add-text.desc':'글꼴, 색상, 그림자, 위치를 조절해 제목이나 설명을 추가합니다.','tool.resize-crop.desc':'Instagram, Pinterest, YouTube 등에 바로 공유할 이미지를 만듭니다.','tool.compress-convert.desc':'공유 전에 파일 크기를 줄이거나 JPG, PNG, WebP로 변환합니다.','tool.badge.new':'✨ 신규','tool.badge.popular':'🔥 인기','tool.badge.local':'무료 · AI 불필요','feature.fast':'빠른 처리','feature.fast.desc':'AI 처리가 몇 초 만에 끝납니다. 대기열이 없습니다.','feature.private':'100% 비공개','feature.private.desc':'이미지는 임시로 처리되고 즉시 삭제됩니다.','feature.free':'매일 무료','feature.free.desc':'카드 없이 매일 무료 사용량이 제공됩니다.','footer.text':'❤️로 제작 — Pict · AI 이미지 도구 · 모두에게 무료','footer.avatarGuide':'📖 아바타 가이드','prompt.note':'팁: 영어 프롬프트가 보통 더 정확한 결과를 만듭니다.','upload.tap':'탭하여 이미지 선택','drop.local':'JPG, PNG, WEBP — 최대 50MB, 로컬 처리','quota.local':'무료 빠른 도구: 무제한, 브라우저에서 처리','quota.default':'오늘 무료: 기본 편집 3회 · 이미지 생성 1회','quota.remaining':'오늘 무료 — {name} 남음: {remaining}/{limit}','quota.test':'🧪 비공개 테스트 모드: 일일 무료 사용량을 쓰지 않습니다','quota.basic':'기본 편집','quota.generate':'이미지 생성','quota.creative':'창작 편집','quota.localName':'빠른 도구'},
    ar:{'tool.group.creative':'🎮 أدوات إبداعية','tool.group.everyday':'✦ أدوات صور يومية','tool.group.quick':'✦ أدوات سريعة — مجانية وخاصة داخل المتصفح','tool.comic-portrait':'☷ بورتريه كوميكس','tool.game-avatar':'🎮 صورة رمزية خيالية','tool.cartoon':'🧸 تحويل الصورة إلى كرتون','tool.art':'📸 جلسة تصوير بالذكاء الاصطناعي','tool.change-background':'🏞️ تغيير الخلفية','tool.remove-object':'🧹 إزالة عنصر','tool.scene-lighting':'💡 تحسين الإضاءة','tool.add-text':'✍️ إضافة نص إلى الصورة','tool.resize-crop':'↔️ تغيير الحجم والقص','tool.compress-convert':'🗜️ ضغط وتحويل','tool.comic-portrait.desc':'حوّل البورتريه إلى رسم كوميكس مصقول مع الحفاظ على قابلية التعرّف على الشخص.','tool.game-avatar.desc':'حوّل البورتريه إلى صورة رمزية RPG خيالية أصلية، دون شخصيات أو ألعاب معروفة.','tool.cartoon.desc':'أنشئ نسخة كرتونية نظيفة وجذابة مع الحفاظ على تمييز الشخص أو العنصر.','tool.art.desc':'اختر أسلوب بورتريه واقعيًا مثل السينمائي أو الأدبي أو الشارع أو الياباني.','tool.change-background.desc':'حافظ على العنصر الرئيسي وأنشئ مشهدًا جديدًا حوله.','tool.remove-object.desc':'أزل عنصرًا غير مرغوب فيه مع إبقاء بقية الصورة كما هي.','tool.scene-lighting.desc':'حسّن الضوء واللون والأجواء دون تغيير المشهد.','tool.remove-bg.desc':'أزل الخلفية بالذكاء الاصطناعي فورًا، مناسب للأشخاص والمنتجات ولقطات الألعاب.','tool.upscale.desc':'حسّن الصور منخفضة الدقة حتى 4× وأعد إحياء الصور القديمة واللقطات.','tool.colorize.desc':'أضف ألوانًا واقعية للصور بالأبيض والأسود مع الحفاظ على التفاصيل.','tool.generate.desc':'أنشئ صورًا من النص: صف، أنشئ، ثم حمّل.','tool.add-text.desc':'أضف عنوانًا أو تعليقًا مع التحكم بالخط واللون والظل والموضع.','tool.resize-crop.desc':'حضّر صورة نظيفة للمشاركة على Instagram وPinterest وYouTube وغيرها.','tool.compress-convert.desc':'قلّل حجم الملف أو حوّل بين JPG وPNG وWebP قبل المشاركة.','tool.badge.new':'✨ جديد','tool.badge.popular':'🔥 شائع','tool.badge.local':'مجاني · لا يحتاج إلى ذكاء اصطناعي','feature.fast':'سريع جدًا','feature.fast.desc':'معالجة بالذكاء الاصطناعي خلال ثوانٍ. بلا طابور أو انتظار.','feature.private':'خصوصية 100%','feature.private.desc':'تُعالج الصور مؤقتًا ثم تُحذف فورًا.','feature.free':'استخدام يومي مجاني','feature.free.desc':'لا حاجة لبطاقة. حصص مجانية كل يوم.','footer.text':'صُنع بحب ❤️ — Pict · أدوات صور بالذكاء الاصطناعي · مجانية للجميع','footer.avatarGuide':'📖 دليل الصورة الرمزية','prompt.note':'نصيحة: التعليمات باللغة الإنجليزية تعطي غالبًا نتائج أدق.','upload.tap':'اضغط لاختيار صورة','drop.local':'JPG وPNG وWEBP — حتى 50 ميجابايت، معالجة محلية','quota.local':'أداة سريعة مجانية: غير محدودة وتُعالج داخل المتصفح','quota.default':'مجاني اليوم: 3 تعديلات أساسية · إنشاء صورة واحدة','quota.remaining':'مجاني اليوم — {name} المتبقي: {remaining}/{limit}','quota.test':'🧪 وضع اختبار خاص: لا يستهلك الحصة اليومية','quota.basic':'تعديلات أساسية','quota.generate':'إنشاء الصور','quota.creative':'تعديل إبداعي','quota.localName':'أدوات سريعة'},
    de:{'tool.group.creative':'🎮 Kreative Werkzeuge','tool.group.everyday':'✦ Alltags-Bildwerkzeuge','tool.group.quick':'✦ Schnellwerkzeuge — kostenlos und privat im Browser','tool.comic-portrait':'☷ Comic-Porträt','tool.game-avatar':'🎮 Fantasy-Avatar','tool.cartoon':'🧸 Foto zu Cartoon','tool.art':'📸 KI-Fotoshooting','tool.change-background':'🏞️ Hintergrund ändern','tool.remove-object':'🧹 Objekt entfernen','tool.scene-lighting':'💡 Licht verbessern','tool.add-text':'✍️ Text hinzufügen','tool.resize-crop':'↔️ Größe ändern & zuschneiden','tool.compress-convert':'🗜️ Komprimieren & konvertieren','tool.comic-portrait.desc':'Verwandle ein Porträt in eine polierte Comic-Illustration und halte die Person erkennbar.','tool.game-avatar.desc':'Verwandle ein Porträt in einen originellen Fantasy-RPG-Avatar, ohne bekannte Figuren oder Spiele.','tool.cartoon.desc':'Erstelle eine klare, sympathische Cartoon-Version, während das Motiv erkennbar bleibt.','tool.art.desc':'Wähle einen realistischen Porträtstil: cineastisch, literarisch, urban, japanisch oder stimmungsvoll.','tool.change-background.desc':'Behalte das Motiv bei und erstelle eine neue Szene darum herum.','tool.remove-object.desc':'Entferne ein unerwünschtes Element und erhalte den Rest des Fotos.','tool.scene-lighting.desc':'Verbessere Licht, Farbe und Stimmung, ohne die Szene zu ändern.','tool.remove-bg.desc':'Entferne Bildhintergründe sofort mit KI, ideal für Personen, Produkte und Spiel-Screenshots.','tool.upscale.desc':'Verbessere niedrig aufgelöste Bilder bis zu 4x. Belebe alte Fotos und Screenshots.','tool.colorize.desc':'Bringe Schwarzweißfotos mit realistischer Kolorierung zum Leben.','tool.generate.desc':'Erstelle Bilder aus Text: beschreiben, erzeugen, herunterladen.','tool.add-text.desc':'Füge Überschrift oder Bildtext mit Schrift, Farbe, Schatten und einfacher Platzierung hinzu.','tool.resize-crop.desc':'Erstelle ein sauberes, teilbares Bild für Instagram, Pinterest, YouTube und mehr.','tool.compress-convert.desc':'Reduziere Dateigröße oder konvertiere zwischen JPG, PNG und WebP vor dem Teilen.','tool.badge.new':'✨ Neu','tool.badge.popular':'🔥 Beliebt','tool.badge.local':'Kostenlos · Keine KI nötig','feature.fast':'Blitzschnell','feature.fast.desc':'KI-Verarbeitung in Sekunden. Keine Warteschlange, kein Warten.','feature.private':'100% privat','feature.private.desc':'Bilder werden nur vorübergehend verarbeitet und sofort gelöscht.','feature.free':'Täglich kostenlos','feature.free.desc':'Keine Kreditkarte. Jeden Tag kostenlose Kontingente.','footer.text':'Mit ❤️ erstellt — Pict · KI-Bildwerkzeuge · Kostenlos für alle','footer.avatarGuide':'📖 Avatar-Leitfaden','prompt.note':'Tipp: Englische Prompts liefern meist genauere Ergebnisse.','upload.tap':'Tippen, um ein Bild auszuwählen','drop.local':'JPG, PNG, WEBP — bis 50 MB, lokal verarbeitet','quota.local':'Kostenloses Schnellwerkzeug: unbegrenzt, im Browser verarbeitet','quota.default':'Heute kostenlos: 3 Basis-Bearbeitungen · 1 Bildgenerierung','quota.remaining':'Heute kostenlos — {name} übrig: {remaining}/{limit}','quota.test':'🧪 Privater Testmodus: Tageskontingent wird nicht genutzt','quota.basic':'Basis-Bearbeitungen','quota.generate':'Bildgenerierung','quota.creative':'kreative Bearbeitung','quota.localName':'Schnellwerkzeuge'}
  };
  Object.keys(extras).forEach(lang=>Object.assign(i18n[lang]||(i18n[lang]={}),extras[lang]));
  const localTools=['add-text','resize-crop','compress-convert'];
  const creativeTools=['comic-portrait','game-avatar','cartoon','art','change-background','remove-object','scene-lighting'];
  const tr=key=>((i18n[currentLang]&&i18n[currentLang][key])||(i18n.en&&i18n.en[key])||key);
  const replaceVars=(template,vars)=>String(template).replace(/\\{(\\w+)\\}/g,(_,key)=>vars[key]??'');
  function applyCards(){
    const groups=document.querySelectorAll('.tool-group-title');
    if(groups[0])groups[0].textContent=tr('tool.group.creative');
    if(groups[1])groups[1].textContent=tr('tool.group.everyday');
    if(groups[2])groups[2].textContent=tr('tool.group.quick');
    document.querySelectorAll('.tool-card').forEach(card=>{
      const tool=card.dataset.tool;
      const title=card.querySelector('h3');
      const desc=card.querySelector('p');
      const badge=card.querySelector('.badge');
      if(title)title.textContent=tr('tool.'+tool);
      if(desc)desc.textContent=tr('tool.'+tool+'.desc');
      if(badge){
        const badgeKey=tool==='remove-bg'?'tool.badge.popular':localTools.includes(tool)?'tool.badge.local':'tool.badge.new';
        badge.textContent=tr(badgeKey);
      }
    });
  }
  function applyQuota(){
    if(typeof currentTool==='undefined')return;
    const status=document.getElementById('quotaStatus');
    if(!status)return;
    const group=localTools.includes(currentTool)?'local':currentTool==='generate'?'generate':['remove-bg','upscale','colorize'].includes(currentTool)?'basic':'creative';
    const quota=typeof quotaGroups!=='undefined'&&quotaGroups&&quotaGroups[group];
    if(group==='local'){status.textContent=tr('quota.local');return;}
    if(quota)status.textContent=replaceVars(tr('quota.remaining'),{name:tr('quota.'+group),remaining:quota.remaining,limit:quota.limit});
    else status.textContent=tr('quota.default');
    if(typeof testMode!=='undefined'&&testMode&&typeof testToken!=='undefined'&&testToken)status.textContent=tr('quota.test');
  }
  function applyLocalCopy(tool){
    if(!localTools.includes(tool))return;
    const title=document.getElementById('localEditorTitle');
    const help=document.getElementById('localEditorHelp');
    if(title)title.textContent=tr('tool.'+tool);
    if(help)help.textContent=tr('local.'+tool+'.help');
  }
  function applyCreativeCopy(tool,preserveValue){
    if(!creativeTools.includes(tool))return;
    const label=document.getElementById('creativePromptLabel');
    const help=document.getElementById('creativeHelp');
    const prompt=document.getElementById('creativePrompt');
    if(label)label.textContent=tr('creativePromptLabel.'+tool);
    if(help)help.textContent=tr('creativePromptHelp.'+tool);
    if(prompt){
      prompt.required=tool==='remove-object';
      prompt.placeholder=tool==='remove-object'?tr('creative.placeholder.object'):tr('creative.placeholder.scene');
      if(!preserveValue)prompt.value='';
    }
  }
  function applyDynamicCopy(){
    const note=document.getElementById('promptLanguageNote');
    if(note)note.textContent=tr('prompt.note');
    const dropTitle=document.querySelector('.upload-zone h3');
    const dropDesc=document.querySelector('.upload-zone p');
    if(dropTitle&&typeof isTouchUpload==='function'&&isTouchUpload())dropTitle.textContent=tr('upload.tap');
    if(dropDesc&&typeof currentTool!=='undefined'&&localTools.includes(currentTool))dropDesc.textContent=tr('drop.local');
    const guide=document.querySelector('footer .partner-links a[href*="original-game-avatar"]');
    if(guide)guide.textContent=tr('footer.avatarGuide');
    if(typeof currentTool!=='undefined'){
      const indicator=document.getElementById('toolIndicator');
      if(indicator)indicator.textContent=tr('tool.'+currentTool);
      applyLocalCopy(currentTool);
      applyCreativeCopy(currentTool,true);
    }
    applyQuota();
  }
  function applyAll(){applyCards();applyDynamicCopy();}
  const baseSetLanguage=typeof setLanguage==='function'?setLanguage:null;
  if(baseSetLanguage){setLanguage=function(lang){baseSetLanguage(lang);document.documentElement.dir=lang==='ar'?'rtl':'ltr';applyAll();};}
  const baseSelectTool=typeof selectTool==='function'?selectTool:null;
  if(baseSelectTool){selectTool=function(tool){const result=baseSelectTool.apply(this,arguments);applyAll();return result;};}
  const baseRenderQuota=typeof renderQuota==='function'?renderQuota:null;
  if(baseRenderQuota){renderQuota=function(){baseRenderQuota.apply(this,arguments);applyQuota();};}
  const baseSetLocalEditorCopy=typeof setLocalEditorCopy==='function'?setLocalEditorCopy:null;
  if(baseSetLocalEditorCopy){setLocalEditorCopy=function(tool){baseSetLocalEditorCopy.apply(this,arguments);applyLocalCopy(tool);};}
  const baseSetCreativeCopy=typeof setCreativeCopy==='function'?setCreativeCopy:null;
  if(baseSetCreativeCopy){setCreativeCopy=function(tool){baseSetCreativeCopy.apply(this,arguments);applyCreativeCopy(tool,false);};}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyAll,{once:true});
  applyAll();
})();
</script>`;

  return html
    .replace('</head>', `${layoutFixCss}\n</head>`)
    .replace('</body>', `${localizationFixScript}\n</body>`);
}

function enhanceIndexHtml(html) {
  const hasComicPortrait = html.includes('data-tool="comic-portrait"');
  const hasArtStyleControls = html.includes('id="artStyleOptions"');
  const seoGuideCss = `  .guide-section{padding:34px 0 12px}
  .guide-label{text-align:center;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:var(--text-dim);margin-bottom:8px}
  .guide-title{text-align:center;font-size:28px;font-weight:850;letter-spacing:-.4px;margin-bottom:8px;text-shadow:0 3px 0 rgba(12,7,35,.58),0 8px 16px rgba(0,0,0,.16)}
  .guide-intro{max-width:620px;margin:0 auto 22px;text-align:center;color:var(--text-dim);font-size:13px;line-height:1.7}
  .guide-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
  .guide-card{min-height:156px;padding:22px;border:1px solid rgba(255,255,255,.09);border-radius:18px;background:linear-gradient(145deg,rgba(255,255,255,.065),rgba(255,255,255,.025));box-shadow:9px 11px 24px rgba(4,2,18,.26),inset 1px 1px 0 rgba(255,255,255,.06);color:inherit;text-decoration:none;display:flex;flex-direction:column;justify-content:space-between;gap:16px;transition:transform .25s,border-color .25s,background .25s}
  .guide-card:hover{transform:translateY(-2px);border-color:rgba(167,139,250,.42);background:linear-gradient(145deg,rgba(124,58,237,.14),rgba(255,255,255,.035))}
  .guide-card strong{display:block;font-size:16px;line-height:1.3;margin-bottom:6px}
  .guide-card p{color:var(--text-dim);font-size:12.5px;line-height:1.55}
  .guide-card span{font-size:12px;font-weight:800;color:var(--accent-light)}
  @media(max-width:768px){.guide-grid{grid-template-columns:1fr}.guide-title{font-size:23px}.guide-card{min-height:132px}}`;
  const seoGuideSection = `<section class="container guide-section" id="guides">
  <div class="guide-label" data-i18n="guides.label">Popular guides</div>
  <h2 class="guide-title" data-i18n="guides.title">Explore PictTool by task</h2>
  <p class="guide-intro" data-i18n="guides.intro">Open a focused page for the tool you need, then jump straight into the editor when you are ready.</p>
  <div class="guide-grid">
    <a class="guide-card" href="photo-to-comic/">
      <div><strong data-i18n="guides.comic.title">Photo to Comic</strong><p data-i18n="guides.comic.desc">Turn portraits, pets, and travel photos into colorful comic-style illustrations.</p></div>
      <span data-i18n="guides.open">Open guide →</span>
    </a>
    <a class="guide-card" href="remove-background/">
      <div><strong data-i18n="guides.remove.title">Remove Background</strong><p data-i18n="guides.remove.desc">Create clean cutouts for products, people, profile images, and social posts.</p></div>
      <span data-i18n="guides.open">Open guide →</span>
    </a>
    <a class="guide-card" href="travel-photo-to-art/">
      <div><strong data-i18n="guides.travel.title">Travel Photo to Art</strong><p data-i18n="guides.travel.desc">Transform travel snapshots into watercolor-style art for Pinterest and memories.</p></div>
      <span data-i18n="guides.open">Open guide →</span>
    </a>
    <a class="guide-card" href="image-compressor/">
      <div><strong data-i18n="guides.compress.title">Image Compressor</strong><p data-i18n="guides.compress.desc">Reduce image file size and convert JPG, PNG, or WebP before sharing.</p></div>
      <span data-i18n="guides.open">Open guide →</span>
    </a>
    <a class="guide-card" href="resize-crop-image/">
      <div><strong data-i18n="guides.resize.title">Resize &amp; Crop Image</strong><p data-i18n="guides.resize.desc">Crop images for Pinterest, Instagram, YouTube, and other social formats.</p></div>
      <span data-i18n="guides.open">Open guide →</span>
    </a>
  </div>
</section>`;
  const ensureSeoGuideEntries = page => {
    if (!page.includes('.guide-section{')) {
      page = page.replace('  /* Upload Area — glassmorphism */', `${seoGuideCss}\n\n  /* Upload Area — glassmorphism */`);
    }
    if (!page.includes('data-i18n="nav.guides"')) {
      page = page
        .replace('<a href="#examples" data-i18n="nav.examples">Examples</a>\n      <a href="#privacy"', '<a href="#examples" data-i18n="nav.examples">Examples</a>\n      <a href="#guides" data-i18n="nav.guides">Guides</a>\n      <a href="#privacy"')
        .replace('<a href="#examples" data-i18n="nav.examples">Examples</a>\n        <a href="#privacy"', '<a href="#examples" data-i18n="nav.examples">Examples</a>\n        <a href="#guides" data-i18n="nav.guides">Guides</a>\n        <a href="#privacy"');
    }
    if (!page.includes('id="guides"')) {
      page = page.replace('</section>\n\n<section class="container" id="tools">', `</section>\n\n${seoGuideSection}\n\n<section class="container" id="tools">`);
    }
    return page;
  };
  html = ensureSeoGuideEntries(html);
  html = html
    .replaceAll('See the difference instantly', 'Turn travel photos into comic art')
    .replaceAll('AI background removal example', 'AI comic-style travel example')
    .replaceAll('A real example — upload your own image to create your result.', 'A real example from PictTool — upload a travel photo and create your own result.')
    .replaceAll('一眼看见变化', '旅行照片也能变漫画')
    .replaceAll('AI 去背景效果示例', 'AI 漫画风旅行照片示例')
    .replaceAll('真实示例 — 上传自己的图片即可开始处理。', '真实示例 — 上传自己的旅行照片即可开始处理。')
    .replace('aria-label="Before and after product image comparison"', 'aria-label="Before and after travel photo comic-art comparison"')
    .replace('assets/bouquet-before.jpg', 'assets/homepage-travel-comic-before.jpg')
    .replace('assets/bouquet-after.png', 'assets/homepage-travel-comic-after.jpg')
    .replace('alt="Bouquet in a room before background removal"', 'alt="Tree-lined travel photo before AI comic transformation"')
    .replace('alt="Bouquet isolated on a purple background after AI background removal"', 'alt="Tree-lined travel photo after AI comic transformation"')
    .replace('<p>🎮 Creative tools for gamers & creators</p>', '<p data-i18n="group.creative">🎮 Creative tools for gamers & creators</p>')
    .replace('<p>✦ Everyday image tools</p>', '<p data-i18n="group.everyday">✦ Everyday image tools</p>')
    .replace('<p>✦ Quick tools — free & private in your browser</p>', '<p data-i18n="group.quick">✦ Quick tools — free & private in your browser</p>')
    .replace(
      "const testMode = new URLSearchParams(location.search).get('test') === '1';\nlet testToken = testMode ? sessionStorage.getItem('pict-test-token') : '';\nif (testMode && !testToken) {",
      "const testModeParam = new URLSearchParams(location.search).get('test') === '1';\nlet testToken = sessionStorage.getItem('pict-test-token') || '';\nif (testModeParam && !testToken) {"
    )
    .replace(
      "  if (testToken) sessionStorage.setItem('pict-test-token', testToken);\n}\nfunction processRequestOptions(form) {",
      "  if (testToken) sessionStorage.setItem('pict-test-token', testToken);\n}\nlet testMode = testModeParam || Boolean(testToken);\nfunction testRequestHeaders(){ return testToken ? { 'X-Pict-Test-Token': testToken } : {}; }\nfunction processRequestOptions(form) {"
    )
    .replace(
      "  return { method: 'POST', body: form, headers: testToken ? { 'X-Pict-Test-Token': testToken } : {} };\n}\n\nfunction quotaGroupForTool(tool) {",
      "  return { method: 'POST', body: form, headers: testRequestHeaders() };\n}\nfunction quotaRequestUrl(){ return '/api/quota'; }\nfunction quotaRequestOptions(){ return testToken ? { headers: testRequestHeaders() } : undefined; }\nfunction clearInvalidTestToken(){\n  if (!testToken) return;\n  sessionStorage.removeItem('pict-test-token');\n  testToken = '';\n  testMode = false;\n  if (testModeParam) alert(currentLang === 'zh' ? '测试密码无效，请刷新后重新输入。' : 'The test password is invalid. Refresh and enter it again.');\n}\n\nfunction quotaGroupForTool(tool) {"
    )
    .replace(
      "    const response = await fetch('/api/quota');",
      "    const response = await fetch(quotaRequestUrl(), quotaRequestOptions());"
    )
    .replace(
      "    const response = await fetch('/api/quota', quotaRequestOptions());",
      "    const response = await fetch(quotaRequestUrl(), quotaRequestOptions());"
    )
    .replace(
      "    quotaGroups = data.groups || null;\n    renderQuota();",
      "    if (testToken && !data.test) clearInvalidTestToken();\n    quotaGroups = data.groups || null;\n    renderQuota();"
    )
    .replace(
      "  if (testMode && testToken) status.textContent = currentLang === 'zh' ? '🧪 私人测试模式：不占用每日免费次数' : '🧪 Private test mode: daily free quota is not used';",
      "  if (testMode && testToken) status.textContent = currentLang === 'zh' ? '🧪 私人测试模式：不占用每日免费次数' : '🧪 Private test mode: daily free quota is not used';"
    )
    .replaceAll('https://pict-ai.pages.dev', 'https://picttool.com');
  if (hasComicPortrait && hasArtStyleControls) return applyLocalizationFixes(html);

  if (!hasComicPortrait) {
    const comicIconCss = '  .tool-card[data-tool="comic-portrait"] .neon-icon{background:linear-gradient(145deg,#fff0a8 0%,#f59f59 52%,#b967e8 100%)}';
    html = html.replace(
      '  .tool-card[data-tool="game-avatar"] .neon-icon{background:linear-gradient(145deg,#c6a8ff 0%,#8464df 54%,#6952ba 100%)}',
      `${comicIconCss}\n  .tool-card[data-tool="game-avatar"] .neon-icon{background:linear-gradient(145deg,#c6a8ff 0%,#8464df 54%,#6952ba 100%)}`
    );

    const gameAvatarCard = '    <a href="#upload" class="tool-card active" data-tool="game-avatar" onclick="selectTool(\'game-avatar\')"><span class="icon neon-icon" data-mark="⌘" aria-hidden="true"></span><h3>Game Fantasy Avatar</h3><p>Turn a portrait into an original fantasy RPG avatar. No named characters or games.</p><span class="badge">✨ New</span><span class="arrow">→</span></a>';
    const comicPortraitCard = '    <a href="#upload" class="tool-card active" data-tool="comic-portrait" onclick="selectTool(\'comic-portrait\')"><span class="icon neon-icon" data-mark="☷" aria-hidden="true"></span><h3>Comic Portrait</h3><p>Turn a portrait into a polished comic illustration while keeping the person recognizable.</p><span class="badge">✨ New</span><span class="arrow">→</span></a>';
    html = html.replace(gameAvatarCard, comicPortraitCard);

    html = html
      .replace(
        '<a href="#upload" class="tool-card" data-tool="art" onclick="selectTool(\'art\')"><span class="icon neon-icon" data-mark="✦" aria-hidden="true"></span><h3>Art Style</h3><p>Give a photo an original editorial digital-art finish.</p><span class="arrow">→</span></a>',
        '<a href="#upload" class="tool-card" data-tool="art" onclick="selectTool(\'art\')"><span class="icon neon-icon" data-mark="✦" aria-hidden="true"></span><h3>AI Photoshoot</h3><p>Choose a realistic portrait style such as cinematic, literary, moody, street, or Japanese.</p><span class="arrow">→</span></a>'
      )
      .replace(
        "'tool.game-avatar': '🎮 Game Fantasy Avatar', 'tool.cartoon': '🧸 Photo to Cartoon', 'tool.art': '🖼️ Art Style', 'tool.change-background': '🏞️ Change Background', 'tool.remove-object': '🧹 Remove Object', 'tool.scene-lighting': '💡 Lighting Enhance',",
        "'tool.comic-portrait': '☷ Comic Portrait', 'tool.game-avatar': '🎮 Game Fantasy Avatar', 'tool.cartoon': '🧸 Photo to Cartoon', 'tool.art': '📸 AI Photoshoot', 'tool.change-background': '🏞️ Change Background', 'tool.remove-object': '🧹 Remove Object', 'tool.scene-lighting': '💡 Lighting Enhance',"
      )
      .replace(
        "'tool.game-avatar': '🎮 幻想游戏头像', 'tool.cartoon': '🧸 图片卡通化', 'tool.art': '🖼️ 艺术风格', 'tool.change-background': '🏞️ 更换背景', 'tool.remove-object': '🧹 去除物体', 'tool.scene-lighting': '💡 灯光优化',",
        "'tool.comic-portrait': '☷ 漫画肖像', 'tool.game-avatar': '🎮 幻想游戏头像', 'tool.cartoon': '🧸 图片卡通化', 'tool.art': '📸 AI写真', 'tool.change-background': '🏞️ 更换背景', 'tool.remove-object': '🧹 去除物体', 'tool.scene-lighting': '💡 灯光优化',"
      )
      .replace("let currentTool = 'game-avatar';", "let currentTool = 'comic-portrait';")
      .replaceAll("['game-avatar','cartoon','art','change-background','remove-object','scene-lighting']", "['comic-portrait','game-avatar','cartoon','art','change-background','remove-object','scene-lighting']")
      .replaceAll("['comic-portrait','game-avatar','cartoon','art','change-background','remove-object','scene-lighting']", "['comic-portrait','cartoon','art','change-background','remove-object','scene-lighting']")
      .replace(
        "    'game-avatar': zh?['原创幻想游戏头像','保留人物脸、年龄、发型与姿势，同时生成清晰可见的原创幻想冒险者服装和场景。']:['Original fantasy game avatar','Keeps the person’s face, age, hair, and pose, while creating a clearly visible original fantasy-adventurer look.'],",
        "    'comic-portrait': zh?['漫画肖像','把头像或团队照变成专业漫画肖像。提示词越具体，脸部、发型、表情和风格越稳定。']:['Comic portrait','Turn a portrait or team photo into a polished comic illustration. Better prompts help preserve the face, hair, expression, and style.'],\n    'game-avatar': zh?['原创幻想游戏头像','保留人物脸、年龄、发型与姿势，同时生成清晰可见的原创幻想冒险者服装和场景。']:['Original fantasy game avatar','Keeps the person’s face, age, hair, and pose, while creating a clearly visible original fantasy-adventurer look.'],"
      )
      .replace(
        "    art: zh?['艺术风格','保留原图构图与人物细节，同时生成清晰可见的原创数字艺术效果。']:['Art effect','Keeps the composition and subject details, while applying a clearly visible original digital-art finish.'],",
        "    art: zh?['AI写真','选择电影、文艺、忧郁、街头或日系写真风格。提示词越具体，人物身份和氛围越稳定。']:['AI photoshoot','Choose a cinematic, literary, moody, street, or Japanese-style portrait. Better prompts help keep identity and mood stable.'],"
      )
      .replace(
        "  creativePrompt.placeholder=tool==='remove-object'?(zh?'例如：桌子上的红色包':'For example: the red bag on the table'):(zh?'例如：月光森林':'For example: a moonlit forest');",
        "  creativePrompt.placeholder=tool==='remove-object'\n    ? (zh?'例如：桌子上的红色包':'For example: the red bag on the table')\n    : tool==='comic-portrait'\n      ? 'professional founder portrait, clean ink outlines, natural skin tones, keep the same face'\n      : tool==='art'\n        ? 'soft side light, muted colors, realistic skin texture, keep the same face'\n        : tool==='scene-lighting'\n          ? 'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'\n          : (zh?'例如：月光森林':'For example: a moonlit forest');"
      )
      .replace(
        "selectTool('game-avatar');",
        "function initialToolFromUrl(){\n  const tool = new URLSearchParams(location.search).get('tool') || '';\n  const allowed = ['comic-portrait','cartoon','art','change-background','remove-object','scene-lighting','remove-bg','upscale','colorize','generate','add-text','resize-crop','compress-convert'];\n  return allowed.includes(tool) ? tool : 'comic-portrait';\n}\nselectTool(initialToolFromUrl());"
      )
      .replace(
        "const allowed = ['game-avatar','cartoon','art','change-background','remove-object','scene-lighting','remove-bg','upscale','colorize','generate','add-text','resize-crop','compress-convert'];\n  return allowed.includes(tool) ? tool : 'game-avatar';",
        "const allowed = ['comic-portrait','cartoon','art','change-background','remove-object','scene-lighting','remove-bg','upscale','colorize','generate','add-text','resize-crop','compress-convert'];\n  return allowed.includes(tool) ? tool : 'comic-portrait';"
      );
  }

  html = html
    .replace(
      '<a href="#upload" class="tool-card" data-tool="art" onclick="selectTool(\'art\')"><span class="icon neon-icon" data-mark="✦" aria-hidden="true"></span><h3>Art Style</h3><p>Give a photo an original editorial digital-art finish.</p><span class="arrow">→</span></a>',
      '<a href="#upload" class="tool-card" data-tool="art" onclick="selectTool(\'art\')"><span class="icon neon-icon" data-mark="✦" aria-hidden="true"></span><h3>AI Photoshoot</h3><p>Choose a realistic portrait style such as cinematic, literary, moody, street, or Japanese.</p><span class="arrow">→</span></a>'
    )
    .replace("'tool.art': '🖼️ Art Style'", "'tool.art': '📸 AI Photoshoot'")
    .replace("'tool.art': '🖼️ 艺术风格'", "'tool.art': '📸 AI写真'")
    .replace(
      "    art: zh?['艺术风格','保留原图构图与人物细节，同时生成清晰可见的原创数字艺术效果。']:['Art effect','Keeps the composition and subject details, while applying a clearly visible original digital-art finish.'],",
      "    art: zh?['AI写真','选择电影、文艺、忧郁、街头或日系写真风格。切换风格会清空旧预览，避免误用旧结果。']:['AI photoshoot','Choose a cinematic, literary, moody, street, or Japanese-style portrait. Switching styles clears the old preview to avoid mixing results.'],"
    );

  if (!hasArtStyleControls) {
    const artStyleCss = `  .tool-card[data-tool="game-avatar"]{display:none!important}
  .art-style-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px;margin:-2px 0 16px}
  .art-style-options[hidden]{display:none}
  .art-style-button{min-height:38px;border:1px solid rgba(167,139,250,.24);border-radius:12px;background:rgba(255,255,255,.055);color:#eee8ff;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
  .art-style-button:hover{border-color:rgba(216,180,254,.56);background:rgba(167,139,250,.13)}
  .art-style-button.active{border-color:rgba(253,186,116,.9);background:linear-gradient(135deg,rgba(253,186,116,.22),rgba(168,85,247,.2));color:#fff7ed}
  .art-style-note{margin:-6px 0 12px;color:var(--text-dim);font-size:12px;line-height:1.55}
  @media(max-width:760px){.art-style-options{grid-template-columns:repeat(2,minmax(0,1fr))}.art-style-button{font-size:11.5px}}`;
    const artStyleScript = `<script>
(function(){
  const styles=['cinematic','literary','melancholy','street','japanese'];
  const locales={
    en:{
      styles:{cinematic:'Cinematic',literary:'Literary',melancholy:'Moody',street:'Street',japanese:'Japanese'},
      note:'Choose one style, then run again. Switching styles clears the old preview so the result does not get mixed up.',
      changed:'Style changed. Upload or run again to preview this look.',
      exampleTitle:'Turn travel photos into comic art',
      exampleSubtitle:'AI comic-style travel example',
      exampleNote:'A real example from PictTool - upload a travel photo and create your own result.',
      beforeAlt:'Tree-lined travel photo before AI comic transformation',
      afterAlt:'Tree-lined travel photo after AI comic transformation',
      comicPlaceholder:'professional founder portrait, clean ink outlines, natural skin tones, keep the same face',
      artPlaceholder:'soft side light, muted colors, realistic skin texture, keep the same face',
      lightingPlaceholder:'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'
    },
    zh:{
      styles:{cinematic:'电影写真',literary:'文艺写真',melancholy:'忧郁氛围',street:'街头嘻哈',japanese:'日系清冷'},
      note:'选择一个写真风格后再生成。切换风格会清空旧预览，避免误用上一次结果。',
      changed:'风格已切换。请重新上传或再次生成，预览新的效果。',
      exampleTitle:'旅行照片也能变漫画',
      exampleSubtitle:'AI 漫画风旅行照片示例',
      exampleNote:'真实示例 - 上传自己的旅行照片即可开始处理。',
      beforeAlt:'AI 漫画转换前的林荫道旅行照片',
      afterAlt:'AI 漫画转换后的林荫道旅行照片',
      comicPlaceholder:'professional founder portrait, clean ink outlines, natural skin tones, keep the same face',
      artPlaceholder:'soft side light, muted colors, realistic skin texture, keep the same face',
      lightingPlaceholder:'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'
    },
    ja:{
      styles:{cinematic:'シネマ',literary:'文芸',melancholy:'ムーディ',street:'ストリート',japanese:'日本風'},
      note:'スタイルを選んでから再生成してください。切り替えると古いプレビューはクリアされます。',
      changed:'スタイルを変更しました。新しい効果を見るにはアップロードまたは再生成してください。',
      exampleTitle:'旅行写真をコミック風アートに',
      exampleSubtitle:'AI コミック風旅行写真の例',
      exampleNote:'PictTool の実例 - 旅行写真をアップロードして自分の結果を作れます。',
      beforeAlt:'AI コミック変換前の並木道の旅行写真',
      afterAlt:'AI コミック変換後の並木道の旅行写真',
      comicPlaceholder:'professional founder portrait, clean ink outlines, natural skin tones, keep the same face',
      artPlaceholder:'soft side light, muted colors, realistic skin texture, keep the same face',
      lightingPlaceholder:'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'
    },
    ko:{
      styles:{cinematic:'시네마',literary:'감성',melancholy:'무드',street:'스트리트',japanese:'일본풍'},
      note:'스타일을 선택한 뒤 다시 생성하세요. 스타일을 바꾸면 이전 미리보기가 지워집니다.',
      changed:'스타일이 변경되었습니다. 새 결과를 보려면 업로드하거나 다시 생성하세요.',
      exampleTitle:'여행 사진을 코믹 아트로',
      exampleSubtitle:'AI 코믹 스타일 여행 사진 예시',
      exampleNote:'PictTool 실제 예시 - 여행 사진을 업로드해 직접 만들어 보세요.',
      beforeAlt:'AI 코믹 변환 전 나무길 여행 사진',
      afterAlt:'AI 코믹 변환 후 나무길 여행 사진',
      comicPlaceholder:'professional founder portrait, clean ink outlines, natural skin tones, keep the same face',
      artPlaceholder:'soft side light, muted colors, realistic skin texture, keep the same face',
      lightingPlaceholder:'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'
    },
    es:{
      styles:{cinematic:'Cine',literary:'Editorial',melancholy:'Melancolico',street:'Urbano',japanese:'Japones'},
      note:'Elige un estilo y vuelve a generar. Al cambiar de estilo se limpia la vista previa anterior.',
      changed:'Estilo cambiado. Sube la imagen o genera otra vez para ver este resultado.',
      exampleTitle:'Convierte fotos de viaje en comic art',
      exampleSubtitle:'Ejemplo de viaje con estilo comic AI',
      exampleNote:'Ejemplo real de PictTool - sube una foto de viaje y crea tu propio resultado.',
      beforeAlt:'Foto de viaje arbolada antes de la transformacion comic AI',
      afterAlt:'Foto de viaje arbolada despues de la transformacion comic AI',
      comicPlaceholder:'professional founder portrait, clean ink outlines, natural skin tones, keep the same face',
      artPlaceholder:'soft side light, muted colors, realistic skin texture, keep the same face',
      lightingPlaceholder:'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'
    },
    fr:{
      styles:{cinematic:'Cinema',literary:'Editorial',melancholy:'Melancolie',street:'Street',japanese:'Japonais'},
      note:'Choisissez un style, puis relancez la generation. Changer de style efface l ancien apercu.',
      changed:'Style modifie. Importez ou relancez pour voir ce rendu.',
      exampleTitle:'Transformez vos photos de voyage en comic art',
      exampleSubtitle:'Exemple de voyage en style comic IA',
      exampleNote:'Exemple reel de PictTool - importez une photo de voyage et creez votre resultat.',
      beforeAlt:'Photo de voyage sous les arbres avant transformation comic IA',
      afterAlt:'Photo de voyage sous les arbres apres transformation comic IA',
      comicPlaceholder:'professional founder portrait, clean ink outlines, natural skin tones, keep the same face',
      artPlaceholder:'soft side light, muted colors, realistic skin texture, keep the same face',
      lightingPlaceholder:'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'
    },
    de:{
      styles:{cinematic:'Kino',literary:'Editorial',melancholy:'Moody',street:'Street',japanese:'Japanisch'},
      note:'Wahle einen Stil und generiere erneut. Beim Wechsel wird die alte Vorschau geleert.',
      changed:'Stil geandert. Lade hoch oder generiere erneut, um diesen Look zu sehen.',
      exampleTitle:'Reisefotos in Comic Art verwandeln',
      exampleSubtitle:'AI Comic-Stil Beispiel fur Reisefotos',
      exampleNote:'Ein echtes PictTool Beispiel - lade ein Reisefoto hoch und erstelle dein Ergebnis.',
      beforeAlt:'Reisefoto einer Baumallee vor der AI Comic-Umwandlung',
      afterAlt:'Reisefoto einer Baumallee nach der AI Comic-Umwandlung',
      comicPlaceholder:'professional founder portrait, clean ink outlines, natural skin tones, keep the same face',
      artPlaceholder:'soft side light, muted colors, realistic skin texture, keep the same face',
      lightingPlaceholder:'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'
    },
    pt:{
      styles:{cinematic:'Cinema',literary:'Editorial',melancholy:'Melancolico',street:'Urbano',japanese:'Japones'},
      note:'Escolha um estilo e gere novamente. Trocar de estilo limpa a previa antiga.',
      changed:'Estilo alterado. Envie a imagem ou gere novamente para ver este visual.',
      exampleTitle:'Transforme fotos de viagem em comic art',
      exampleSubtitle:'Exemplo de viagem em estilo comic com IA',
      exampleNote:'Exemplo real do PictTool - envie uma foto de viagem e crie seu resultado.',
      beforeAlt:'Foto de viagem arborizada antes da transformacao comic por IA',
      afterAlt:'Foto de viagem arborizada depois da transformacao comic por IA',
      comicPlaceholder:'professional founder portrait, clean ink outlines, natural skin tones, keep the same face',
      artPlaceholder:'soft side light, muted colors, realistic skin texture, keep the same face',
      lightingPlaceholder:'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'
    },
    ar:{
      styles:{cinematic:'سينمائي',literary:'تحريري',melancholy:'مزاجي',street:'شارع',japanese:'ياباني'},
      note:'اختر نمطاً ثم أنشئ الصورة من جديد. تغيير النمط يمسح المعاينة القديمة.',
      changed:'تم تغيير النمط. ارفع الصورة أو أنشئها من جديد لرؤية النتيجة.',
      exampleTitle:'حوّل صور السفر إلى فن قصصي',
      exampleSubtitle:'مثال لصورة سفر بأسلوب القصص المصورة بالذكاء الاصطناعي',
      exampleNote:'مثال حقيقي من PictTool - ارفع صورة سفر وأنشئ نتيجتك الخاصة.',
      beforeAlt:'صورة سفر بين الأشجار قبل تحويلها إلى فن قصصي',
      afterAlt:'صورة سفر بين الأشجار بعد تحويلها إلى فن قصصي',
      comicPlaceholder:'professional founder portrait, clean ink outlines, natural skin tones, keep the same face',
      artPlaceholder:'soft side light, muted colors, realistic skin texture, keep the same face',
      lightingPlaceholder:'Enhance this night photo naturally. Keep the night atmosphere and avoid overexposed lights.'
    }
  };
  const uiText={
    en:{
      creativeGroup:'Creative tools for gamers & creators',
      everydayGroup:'Everyday image tools',
      quickGroup:'Quick tools - free & private in your browser',
      before:'Before',
      after:'After',
      comparisonAria:'Before and after travel photo comic-art comparison',
      tools:{
        'comic-portrait':['Comic Portrait','Turn a portrait into a polished comic illustration while keeping the person recognizable.'],
        cartoon:['Photo to Cartoon','Make a clean, charming cartoon version while keeping the subject recognizable.'],
        art:['AI Photoshoot','Choose a realistic portrait style such as cinematic, literary, moody, street, or Japanese.'],
        'change-background':['Change Background','Keep the subject and create a new scene around it.'],
        'remove-object':['Remove Object','Remove one unwanted item while keeping the rest of your photo intact.'],
        'scene-lighting':['Lighting Enhance','Improve light, color, and atmosphere without changing the scene.']
      },
      promptHelp:{
        'comic-portrait':'Turn a portrait or team photo into a polished comic illustration. Better prompts help preserve the face, hair, expression, and style.',
        art:'Choose a realistic portrait style. Better prompts help keep identity, background, and mood stable.',
        'change-background':'Describe the new background while keeping the main subject unchanged.',
        'remove-object':'Describe the single object to remove. Other people and objects will stay unchanged.',
        'scene-lighting':'Improve light, color, and atmosphere while keeping the scene unchanged.',
        cartoon:'Create a clean, charming cartoon version while keeping the subject recognizable.'
      }
    },
    zh:{
      creativeGroup:'🎮 面向玩家和创作者的创意工具',
      everydayGroup:'✦ 日常图片工具',
      quickGroup:'✦ 快速工具 - 免费且保护隐私',
      before:'处理前',
      after:'处理后',
      comparisonAria:'旅行照片漫画效果前后对比',
      tools:{
        'comic-portrait':['☷ 漫画肖像','把头像变成专业漫画肖像，同时保持人物可识别。'],
        cartoon:['🧸 图片卡通化','生成干净、有亲和力的卡通效果，同时保持主体可识别。'],
        art:['📸 AI写真','选择电影、文艺、忧郁、街头或日系写真风格。'],
        'change-background':['🏞️ 更换背景','保留主体，并为照片创建新的场景。'],
        'remove-object':['🧹 去除物体','去除一个不需要的物体，同时保留照片其他内容。'],
        'scene-lighting':['💡 灯光优化','改善光线、色彩和氛围，不改变原有场景。']
      },
      promptHelp:{
        'comic-portrait':'把头像或团队照变成专业漫画肖像。提示词越具体，脸部、发型、表情和风格越稳定。',
        art:'选择一种写真风格。提示词越具体，人物身份、背景和氛围越稳定。',
        'change-background':'描述想要的新背景，同时保持主体不变。',
        'remove-object':'描述需要去除的一个物体，其他人物和物体会保持不变。',
        'scene-lighting':'改善光线、色彩和氛围，同时保持场景不变。',
        cartoon:'生成干净、有亲和力的卡通效果，同时保持主体可识别。'
      }
    },
    es:{
      creativeGroup:'🎮 Herramientas creativas para jugadores y creadores',
      everydayGroup:'✦ Herramientas de imagen cotidianas',
      quickGroup:'✦ Herramientas rápidas - gratis y privadas',
      before:'Antes',
      after:'Después',
      comparisonAria:'Comparación antes y después de la transformación comic',
      tools:{
        'comic-portrait':['☷ Retrato comic','Convierte un retrato en una ilustración comic manteniendo reconocible a la persona.'],
        cartoon:['🧸 Foto a caricatura','Crea una caricatura limpia y agradable manteniendo reconocible al sujeto.'],
        art:['📸 Sesión de fotos IA','Elige un estilo de retrato cinematográfico, editorial, melancólico, urbano o japonés.'],
        'change-background':['🏞️ Cambiar fondo','Mantén el sujeto y crea una nueva escena a su alrededor.'],
        'remove-object':['🧹 Eliminar objeto','Elimina un objeto no deseado manteniendo intacto el resto de la foto.'],
        'scene-lighting':['💡 Mejorar iluminación','Mejora la luz, el color y el ambiente sin cambiar la escena.']
      },
      promptHelp:{
        'comic-portrait':'Convierte un retrato o equipo en una ilustración comic. Los prompts detallados ayudan a conservar el rostro y el estilo.',
        art:'Elige un estilo de retrato realista. Los prompts detallados mantienen estables la identidad, el fondo y el ambiente.',
        'change-background':'Describe el nuevo fondo manteniendo intacto el sujeto principal.',
        'remove-object':'Describe el único objeto que quieres eliminar. Los demás elementos no cambiarán.',
        'scene-lighting':'Mejora la luz, el color y el ambiente manteniendo la escena.',
        cartoon:'Crea una caricatura limpia y agradable manteniendo reconocible al sujeto.'
      }
    },
    fr:{
      creativeGroup:'🎮 Outils créatifs pour joueurs et créateurs',
      everydayGroup:'✦ Outils photo du quotidien',
      quickGroup:'✦ Outils rapides - gratuits et privés',
      before:'Avant',
      after:'Après',
      comparisonAria:'Comparaison avant et après de la transformation comic',
      tools:{
        'comic-portrait':['☷ Portrait comic','Transformez un portrait en illustration comic tout en gardant la personne reconnaissable.'],
        cartoon:['🧸 Photo en cartoon','Créez une version cartoon propre et agréable tout en gardant le sujet reconnaissable.'],
        art:['📸 Séance photo IA','Choisissez un style de portrait cinéma, éditorial, mélancolique, urbain ou japonais.'],
        'change-background':['🏞️ Changer le fond','Conservez le sujet et créez une nouvelle scène autour de lui.'],
        'remove-object':['🧹 Supprimer un objet','Supprimez un objet indésirable en gardant le reste de la photo intact.'],
        'scene-lighting':['💡 Améliorer la lumière','Améliorez la lumière, les couleurs et l’ambiance sans changer la scène.']
      },
      promptHelp:{
        'comic-portrait':'Transformez un portrait ou une équipe en illustration comic. Des prompts précis aident à préserver le visage et le style.',
        art:'Choisissez un style de portrait réaliste. Des prompts précis stabilisent l’identité, le fond et l’ambiance.',
        'change-background':'Décrivez le nouveau fond en gardant le sujet principal intact.',
        'remove-object':'Décrivez le seul objet à supprimer. Les autres éléments resteront inchangés.',
        'scene-lighting':'Améliorez la lumière, les couleurs et l’ambiance sans changer la scène.',
        cartoon:'Créez une version cartoon propre et agréable tout en gardant le sujet reconnaissable.'
      }
    },
    pt:{
      creativeGroup:'🎮 Ferramentas criativas para jogadores e criadores',
      everydayGroup:'✦ Ferramentas de imagem do dia a dia',
      quickGroup:'✦ Ferramentas rápidas - gratuitas e privadas',
      before:'Antes',
      after:'Depois',
      comparisonAria:'Comparação antes e depois da transformação comic',
      tools:{
        'comic-portrait':['☷ Retrato comic','Transforme um retrato em uma ilustração comic mantendo a pessoa reconhecível.'],
        cartoon:['🧸 Foto para cartoon','Crie uma versão cartoon limpa e agradável mantendo o sujeito reconhecível.'],
        art:['📸 Sessão de fotos IA','Escolha um estilo de retrato cinematográfico, editorial, melancólico, urbano ou japonês.'],
        'change-background':['🏞️ Alterar fundo','Mantenha o sujeito e crie uma nova cena ao redor dele.'],
        'remove-object':['🧹 Remover objeto','Remova um objeto indesejado mantendo o restante da foto intacto.'],
        'scene-lighting':['💡 Melhorar iluminação','Melhore luz, cor e ambiente sem alterar a cena.']
      },
      promptHelp:{
        'comic-portrait':'Transforme um retrato ou equipe em uma ilustração comic. Prompts detalhados ajudam a preservar rosto e estilo.',
        art:'Escolha um estilo de retrato realista. Prompts detalhados mantêm identidade, fundo e clima estáveis.',
        'change-background':'Descreva o novo fundo mantendo o sujeito principal intacto.',
        'remove-object':'Descreva o único objeto que deve ser removido. Os demais elementos permanecem.',
        'scene-lighting':'Melhore luz, cor e ambiente mantendo a cena inalterada.',
        cartoon:'Crie uma versão cartoon limpa e agradável mantendo o sujeito reconhecível.'
      }
    },
    ja:{
      creativeGroup:'🎮 ゲーマーとクリエイター向けのクリエイティブツール',
      everydayGroup:'✦ 日常の画像ツール',
      quickGroup:'✦ クイックツール - 無料・プライベート',
      before:'変換前',
      after:'変換後',
      comparisonAria:'旅行写真のコミック変換前後比較',
      tools:{
        'comic-portrait':['☷ コミックポートレート','人物を認識できる状態で、ポートレートを洗練されたコミック風に変換します。'],
        cartoon:['🧸 写真をカートゥーンに','人物を保ちながら、きれいで親しみやすい効果にします。'],
        art:['📸 AI フォトシュート','シネマ、文芸、ムーディ、ストリート、日本風から選べます。'],
        'change-background':['🏞️ 背景を変更','被写体を保ったまま、新しい背景を作成します。'],
        'remove-object':['🧹 オブジェクトを削除','不要な物体を一つ削除し、他の部分を保ちます。'],
        'scene-lighting':['💡 ライティング補正','シーンを変えずに光、色、雰囲気を改善します。']
      },
      promptHelp:{
        'comic-portrait':'ポートレートを洗練されたコミック風に変換します。具体的なプロンプトほど顔や髪型を保ちやすくなります。',
        art:'リアルなポートレートスタイルを選びます。具体的なプロンプトで人物と雰囲気が安定します。',
        'change-background':'被写体を保ったまま、新しい背景を説明してください。',
        'remove-object':'削除する一つの物体を説明してください。他の要素は変わりません。',
        'scene-lighting':'シーンを変えずに光、色、雰囲気を改善します。',
        cartoon:'人物を保ちながら、きれいで親しみやすい効果にします。'
      }
    },
    ko:{
      creativeGroup:'🎮 게이머와 크리에이터를 위한 창작 도구',
      everydayGroup:'✦ 일상 이미지 도구',
      quickGroup:'✦ 빠른 도구 - 무료 및 비공개',
      before:'변환 전',
      after:'변환 후',
      comparisonAria:'여행 사진 코믹 변환 전후 비교',
      tools:{
        'comic-portrait':['☷ 코믹 초상화','인물을 알아볼 수 있도록 유지하면서 세련된 코믹 일러스트로 변환합니다.'],
        cartoon:['🧸 사진을 카툰으로','대상을 알아볼 수 있도록 유지하면서 깔끔한 카툰 효과를 만듭니다.'],
        art:['📸 AI 포토슈트','시네마, 감성, 무드, 스트리트, 일본풍 중에서 선택하세요.'],
        'change-background':['🏞️ 배경 변경','대상을 유지하고 주변에 새로운 장면을 만듭니다.'],
        'remove-object':['🧹 물체 제거','원하지 않는 물체 하나를 제거하고 나머지는 유지합니다.'],
        'scene-lighting':['💡 조명 개선','장면을 바꾸지 않고 빛, 색상, 분위기를 개선합니다.']
      },
      promptHelp:{
        'comic-portrait':'초상화나 단체 사진을 코믹 일러스트로 변환합니다. 구체적인 프롬프트가 얼굴과 스타일을 더 잘 보존합니다.',
        art:'사실적인 인물 스타일을 선택합니다. 구체적인 프롬프트가 인물과 분위기를 안정적으로 유지합니다.',
        'change-background':'주요 대상을 유지하면서 새 배경을 설명하세요.',
        'remove-object':'삭제할 물체 하나를 설명하세요. 다른 요소는 바뀌지 않습니다.',
        'scene-lighting':'장면을 바꾸지 않고 빛, 색상, 분위기를 개선합니다.',
        cartoon:'대상을 알아볼 수 있도록 유지하면서 깔끔한 카툰 효과를 만듭니다.'
      }
    },
    de:{
      creativeGroup:'🎮 Kreativtools für Gamer und Creator',
      everydayGroup:'✦ Bildtools für jeden Tag',
      quickGroup:'✦ Schnelle Tools - kostenlos und privat',
      before:'Vorher',
      after:'Nachher',
      comparisonAria:'Vorher-Nachher-Vergleich der Comic-Umwandlung',
      tools:{
        'comic-portrait':['☷ Comic-Porträt','Verwandle ein Porträt in eine hochwertige Comic-Illustration und erhalte die Wiedererkennbarkeit.'],
        cartoon:['🧸 Foto zu Cartoon','Erstelle einen klaren, freundlichen Cartoon und erhalte das Motiv.'],
        art:['📸 KI-Fotoshooting','Wähle einen Kino-, Editorial-, Moody-, Street- oder japanischen Porträtstil.'],
        'change-background':['🏞️ Hintergrund ändern','Behalte das Motiv und erstelle eine neue Szene darum herum.'],
        'remove-object':['🧹 Objekt entfernen','Entferne ein unerwünschtes Objekt und erhalte den Rest des Fotos.'],
        'scene-lighting':['💡 Licht verbessern','Verbessere Licht, Farben und Atmosphäre ohne die Szene zu ändern.']
      },
      promptHelp:{
        'comic-portrait':'Verwandle ein Porträt in eine hochwertige Comic-Illustration. Präzise Prompts erhalten Gesicht und Stil besser.',
        art:'Wähle einen realistischen Porträtstil. Präzise Prompts stabilisieren Identität, Hintergrund und Stimmung.',
        'change-background':'Beschreibe den neuen Hintergrund und erhalte das Hauptmotiv.',
        'remove-object':'Beschreibe das eine zu entfernende Objekt. Andere Elemente bleiben unverändert.',
        'scene-lighting':'Verbessere Licht, Farben und Atmosphäre ohne die Szene zu ändern.',
        cartoon:'Erstelle einen klaren, freundlichen Cartoon und erhalte das Motiv.'
      }
    },
    ar:{
      creativeGroup:'🎮 أدوات إبداعية للاعبين وصناع المحتوى',
      everydayGroup:'✦ أدوات الصور اليومية',
      quickGroup:'✦ أدوات سريعة - مجانية وخاصة',
      before:'قبل',
      after:'بعد',
      comparisonAria:'مقارنة صورة السفر قبل وبعد تحويلها إلى فن قصصي',
      tools:{
        'comic-portrait':['☷ صورة شخصية قصصية','حوّل الصورة الشخصية إلى رسم قصصي احترافي مع الحفاظ على قابلية التعرف على الشخص.'],
        cartoon:['🧸 تحويل الصورة إلى كرتون','أنشئ نسخة كرتونية لطيفة مع الحفاظ على ملامح الموضوع.'],
        art:['📸 جلسة تصوير بالذكاء الاصطناعي','اختر أسلوباً سينمائياً أو تحريرياً أو مزاجياً أو شارعياً أو يابانياً.'],
        'change-background':['🏞️ تغيير الخلفية','حافظ على الموضوع وأنشئ مشهداً جديداً حوله.'],
        'remove-object':['🧹 إزالة عنصر','أزل عنصراً غير مرغوب فيه مع الحفاظ على بقية الصورة.'],
        'scene-lighting':['💡 تحسين الإضاءة','حسّن الإضاءة والألوان والأجواء من دون تغيير المشهد.']
      },
      promptHelp:{
        'comic-portrait':'حوّل الصورة الشخصية إلى رسم قصصي احترافي. تساعد التعليمات التفصيلية على الحفاظ على الوجه والأسلوب.',
        art:'اختر أسلوباً واقعياً للصورة الشخصية. تساعد التعليمات التفصيلية على تثبيت الهوية والخلفية والأجواء.',
        'change-background':'صف الخلفية الجديدة مع الحفاظ على الموضوع الرئيسي.',
        'remove-object':'صف العنصر الوحيد الذي تريد حذفه. ستبقى العناصر الأخرى كما هي.',
        'scene-lighting':'حسّن الإضاءة والألوان والأجواء مع إبقاء المشهد كما هو.',
        cartoon:'أنشئ نسخة كرتونية لطيفة مع الحفاظ على ملامح الموضوع.'
      }
    }
  };
  function storedLanguage(name){
    try { return localStorage.getItem(name) || ''; } catch (_) { return ''; }
  }
  function languageKey(){
    const selector=document.querySelector('select');
    const selected=selector && selector.value;
    if(selected && locales[selected]) return selected;
    const raw=[document.documentElement.lang,navigator.language].filter(Boolean).join(' ').toLowerCase();
    if(raw.includes('zh')) return 'zh';
    if(raw.includes('ja')) return 'ja';
    if(raw.includes('ko')) return 'ko';
    if(raw.includes('es')) return 'es';
    if(raw.includes('fr')) return 'fr';
    if(raw.includes('de')) return 'de';
    if(raw.includes('pt')) return 'pt';
    if(raw.includes('ar')) return 'ar';
    return 'en';
  }
  function copy(){
    return locales[languageKey()] || locales.en;
  }
  let selectedArtStyle='cinematic';
  let lastArtStyle='cinematic';
  function applyLocalizedCopy(){
    const key=languageKey();
    const c=copy();
    const ui=uiText[key] || uiText.en;
    document.documentElement.dir=key==='ar'?'rtl':'ltr';
    document.querySelectorAll('[data-i18n="example.title"]').forEach(node=>{ node.textContent=c.exampleTitle; });
    document.querySelectorAll('[data-i18n="example.subtitle"]').forEach(node=>{ node.textContent=c.exampleSubtitle; });
    document.querySelectorAll('[data-i18n="example.note"]').forEach(node=>{ node.textContent=c.exampleNote; });
    document.querySelectorAll('[data-i18n="group.creative"]').forEach(node=>{ node.textContent=ui.creativeGroup; });
    document.querySelectorAll('[data-i18n="group.everyday"]').forEach(node=>{ node.textContent=ui.everydayGroup; });
    document.querySelectorAll('[data-i18n="group.quick"]').forEach(node=>{ node.textContent=ui.quickGroup; });
    document.querySelectorAll('img[src*="homepage-travel-comic-before"]').forEach(img=>{ img.alt=c.beforeAlt; });
    document.querySelectorAll('img[src*="homepage-travel-comic-after"]').forEach(img=>{ img.alt=c.afterAlt; });
    const comparison=document.querySelector('[aria-label*="travel photo comic-art comparison"], [aria-label*="旅行照片漫画效果前后对比"], [aria-label*="Comparación antes"], [aria-label*="Comparaison avant"], [aria-label*="Comparação antes"], [aria-label*="旅行写真"], [aria-label*="여행 사진"], [aria-label*="Vorher-Nachher"], [aria-label*="مقارنة صورة"]');
    if(comparison){
      comparison.setAttribute('aria-label', ui.comparisonAria);
      comparison.querySelectorAll('*').forEach(node=>{
        if(node.children.length) return;
        const text=node.textContent.trim();
        if(['Before','处理前','Antes','Avant','Antes','変換前','변환 전','Vorher','قبل'].includes(text)) node.textContent=ui.before;
        if(['After','处理后','Después','Après','Depois','変換後','변환 후','Nachher','بعد'].includes(text)) node.textContent=ui.after;
      });
    }
    document.querySelectorAll('.tool-card[data-tool]').forEach(card=>{
      const entry=ui.tools[card.dataset.tool];
      if(!entry) return;
      const title=card.querySelector('h3');
      const description=card.querySelector('p');
      if(title) title.textContent=entry[0];
      if(description) description.textContent=entry[1];
    });
    const note=document.getElementById('artStyleNote');
    if(note) note.textContent=c.note;
    const wrap=document.getElementById('artStyleOptions');
    if(wrap){
      wrap.querySelectorAll('[data-art-style]').forEach(button=>{
        const value=button.dataset.artStyle;
        const label=(c.styles && c.styles[value]) || locales.en.styles[value] || value;
        const english=locales.en.styles[value] || value;
        button.innerHTML=label+(languageKey()==='en'?'':'<br><span>'+english+'</span>');
      });
    }
    const currentTool=document.querySelector('.tool-card.active')?.dataset.tool;
    const promptLabel=document.querySelector('label[for="creativePrompt"]');
    if(promptLabel && ui.tools[currentTool]) promptLabel.textContent=ui.tools[currentTool][0];
    const help=document.getElementById('creativeHelp');
    if(help && ui.promptHelp[currentTool]){
      const helpText=help.querySelector('p') || help;
      helpText.textContent=ui.promptHelp[currentTool];
    }
    const prompt=document.getElementById('creativePrompt');
    if(prompt){
      if(currentTool==='comic-portrait') prompt.placeholder=c.comicPlaceholder;
      if(currentTool==='art') prompt.placeholder=c.artPlaceholder;
      if(currentTool==='scene-lighting') prompt.placeholder=c.lightingPlaceholder;
    }
  }
  function resetNode(node){
    if(!node) return;
    if(node instanceof HTMLImageElement || node instanceof HTMLVideoElement){
      node.removeAttribute('src');
      node.style.display='none';
      return;
    }
    if(node instanceof HTMLAnchorElement){
      node.removeAttribute('href');
      node.style.display='none';
      return;
    }
    if(node.tagName==='CANVAS'){
      const context=node.getContext('2d');
      if(context) context.clearRect(0,0,node.width,node.height);
      node.style.display='none';
      return;
    }
    if(node.id && /(result|output|download|preview|processed)/i.test(node.id)){
      node.hidden=true;
      node.style.display='none';
    }
  }
  function clearArtPreview(){
    const scope=document.getElementById('upload') || document.getElementById('creativeOptions')?.closest('section') || document.body;
    scope.querySelectorAll('img,video,canvas,a[href],#result,#output,#preview,#resultImage,#outputImage,#previewImage,#processedImage,#downloadBtn,#downloadLink,.result,.output,.preview,.download').forEach(resetNode);
    scope.querySelectorAll('input[type="file"]').forEach(input=>{ input.value=''; });
    const status=document.getElementById('status') || document.getElementById('resultStatus') || document.querySelector('[role="status"]');
    if(status) status.textContent=copy().changed;
  }
  function ensureArtStyleControls(){
    const creativeOptions=document.getElementById('creativeOptions');
    if(!creativeOptions || document.getElementById('artStyleOptions')) return;
    const note=document.createElement('p');
    note.id='artStyleNote';
    note.className='art-style-note';
    note.textContent=copy().note;
    const wrap=document.createElement('div');
    wrap.id='artStyleOptions';
    wrap.className='art-style-options';
    wrap.hidden=true;
    wrap.innerHTML=styles.map((value,index)=>'<button type="button" class="art-style-button '+(index===0?'active':'')+'" data-art-style="'+value+'"></button>').join('');
    const target=document.getElementById('creativeHelp') || creativeOptions.firstElementChild;
    if(target){
      target.insertAdjacentElement('afterend', note);
      note.insertAdjacentElement('afterend', wrap);
    }else{
      creativeOptions.prepend(wrap);
      creativeOptions.prepend(note);
    }
    note.hidden=true;
    applyLocalizedCopy();
    wrap.addEventListener('click', event=>{
      const target=event.target instanceof Element ? event.target : event.target.parentElement;
      const button=target && target.closest('[data-art-style]');
      if(!button) return;
      selectedArtStyle=button.dataset.artStyle || 'cinematic';
      wrap.querySelectorAll('.art-style-button').forEach(item=>item.classList.toggle('active', item===button));
      if(selectedArtStyle!==lastArtStyle){
        lastArtStyle=selectedArtStyle;
        clearArtPreview();
      }
    });
  }
  function syncArtStyles(tool){
    ensureArtStyleControls();
    const activeTool=tool || document.querySelector('.tool-card.active')?.dataset.tool;
    const show=activeTool==='art';
    const wrap=document.getElementById('artStyleOptions');
    const note=document.getElementById('artStyleNote');
    if(wrap) wrap.hidden=!show;
    if(note) note.hidden=!show;
    applyLocalizedCopy();
  }
  const originalSelectTool=window.selectTool;
  if(typeof originalSelectTool==='function'){
    window.selectTool=function(tool){
      const result=originalSelectTool.apply(this, arguments);
      syncArtStyles(tool);
      return result;
    };
  }
  const originalFetch=window.fetch;
  window.fetch=function(input, init){
    const url=typeof input==='string'?input:(input && input.url) || '';
    if(init && init.body instanceof FormData && url.includes('/api/process') && init.body.get('tool')==='art'){
      init.body.set('style', selectedArtStyle);
    }
    return originalFetch.apply(this, arguments);
  };
  document.addEventListener('DOMContentLoaded', ()=>{ syncArtStyles(); applyLocalizedCopy(); });
  const languageSelector=document.querySelector('select');
  if(languageSelector && !languageSelector.dataset.pictI18nBound){
    languageSelector.dataset.pictI18nBound='1';
    languageSelector.addEventListener('change', ()=>setTimeout(applyLocalizedCopy, 80));
  }
  document.addEventListener('click', event=>{
    const target=event.target instanceof Element ? event.target : null;
    if(target && target.closest('[data-lang],[data-language],.language-switcher,.lang-switcher')) setTimeout(applyLocalizedCopy, 120);
  }, true);
  syncArtStyles();
  applyLocalizedCopy();
})();
</script>`;
    html = html.replace('</style>', `${artStyleCss}\n</style>`);
    html = html.replace('</body>', `${artStyleScript}\n</body>`);
  }

  return applyLocalizationFixes(html);
}

async function assetResponse(request, env) {
  const response = await env.ASSETS.fetch(request);
  const url = new URL(request.url);
  const isIndex = request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html');
  const contentType = response.headers.get('Content-Type') || '';
  if (!isIndex || !contentType.includes('text/html')) return response;

  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.delete('ETag');
  headers.set('Content-Type', 'text/html; charset=UTF-8');
  return new Response(enhanceIndexHtml(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    return assetResponse(request, env);
  },
};
