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

function enhanceIndexHtml(html) {
  const hasComicPortrait = html.includes('data-tool="comic-portrait"');
  const hasArtStyleControls = html.includes('id="artStyleOptions"');
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
    .replace('alt="Bouquet isolated on a purple background after AI background removal"', 'alt="Tree-lined travel photo after AI comic transformation"');
  if (hasComicPortrait && hasArtStyleControls) return html;

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
      .replace("selectTool('game-avatar');", "selectTool('comic-portrait');");
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
    }
  };
  function storedLanguage(name){
    try { return localStorage.getItem(name) || ''; } catch (_) { return ''; }
  }
  function languageKey(){
    const raw=[storedLanguage('pict-lang'),storedLanguage('language'),storedLanguage('lang'),document.documentElement.lang,navigator.language].filter(Boolean).join(' ').toLowerCase();
    if(raw.includes('zh')) return 'zh';
    if(raw.includes('ja')) return 'ja';
    if(raw.includes('ko')) return 'ko';
    if(raw.includes('es')) return 'es';
    if(raw.includes('fr')) return 'fr';
    if(raw.includes('de')) return 'de';
    if(raw.includes('pt')) return 'pt';
    return 'en';
  }
  function copy(){
    return locales[languageKey()] || locales.en;
  }
  let selectedArtStyle='cinematic';
  let lastArtStyle='cinematic';
  function applyLocalizedCopy(){
    const c=copy();
    document.querySelectorAll('[data-i18n="example.title"]').forEach(node=>{ node.textContent=c.exampleTitle; });
    document.querySelectorAll('[data-i18n="example.subtitle"]').forEach(node=>{ node.textContent=c.exampleSubtitle; });
    document.querySelectorAll('[data-i18n="example.note"]').forEach(node=>{ node.textContent=c.exampleNote; });
    document.querySelectorAll('img[src*="homepage-travel-comic-before"]').forEach(img=>{ img.alt=c.beforeAlt; });
    document.querySelectorAll('img[src*="homepage-travel-comic-after"]').forEach(img=>{ img.alt=c.afterAlt; });
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

  return html;
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
