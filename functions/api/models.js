export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  const models = {
    'remove-bg': { name: 'Remove Background', icon: '🖼️', free: true },
    'upscale': { name: 'Upscale Image', icon: '🔍', free: true },
    'colorize': { name: 'Colorize', icon: '🎨', free: true },
    'generate': { name: 'Text to Image', icon: '✨', free: true, styles: ['photorealistic', 'cartoon illustration', 'fine art'] },
  };

  return new Response(JSON.stringify(models), { headers });
}
