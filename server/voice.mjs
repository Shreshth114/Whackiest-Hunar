const provider = 'https://api.elevenlabs.io/v1';

export async function voiceKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  if (!process.env.ELEVENLABS_SECRET_ARN) return '';
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const result = await new SecretsManagerClient().send(new GetSecretValueCommand({ SecretId: process.env.ELEVENLABS_SECRET_ARN }));
  const value = result.SecretString || '';
  if (value.startsWith('{')) return JSON.parse(value).ELEVENLABS_API_KEY || '';
  return value;
}

async function call(path, method, body, type) {
  const key = await voiceKey();
  if (!key) throw Object.assign(new Error('Voice is unavailable. You can type your search.'), { status: 503 });
  let response;
  try {
    response = await fetch(provider + path, {
      method, body, headers: { 'xi-api-key': key, ...(type ? { 'Content-Type': type } : {}) },
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw Object.assign(new Error('Voice took too long. Please retry or type.'), { status: 502 });
  }
  if (!response.ok) throw Object.assign(new Error('ElevenLabs could not process this request. Please retry or type.'), { status: 502 });
  return response;
}

export async function transcribe(bytes, mime) {
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'webm';
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: mime }), 'search.' + ext);
  form.set('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v2');
  const result = await (await call('/speech-to-text', 'POST', form)).json();
  return String(result.text || '').trim().slice(0, 500);
}

export async function speak(text) {
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!voice) throw Object.assign(new Error('Read aloud is unavailable on this installation.'), { status: 503 });
  const result = await call('/text-to-speech/' + encodeURIComponent(voice), 'POST', JSON.stringify({
    text, model_id: process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2'
  }), 'application/json');
  return Buffer.from(await result.arrayBuffer());
}
