let token = sessionStorage.getItem('hunar.token') || '';
export const idToken = () => token;
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export async function signIn(config) {
  const verifier = base64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = crypto.randomUUID();
  sessionStorage.setItem('hunar.oauth', JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    response_type:'code', client_id:config.clientId, redirect_uri:location.origin + '/',
    scope:'openid profile', state, code_challenge:challenge, code_challenge_method:'S256'
  });
  location.assign(config.authUrl + '/oauth2/authorize?' + params);
}
export async function finishSignIn(config) {
  const query = new URLSearchParams(location.search);
  const code = query.get('code');
  if (!code) return;
  const saved = JSON.parse(sessionStorage.getItem('hunar.oauth') || 'null');
  if (!saved || saved.state !== query.get('state')) throw new Error('Sign-in could not be confirmed. Restart sign-in.');
  sessionStorage.removeItem('hunar.oauth');
  history.replaceState(null, '', '/' + location.hash);
  const response = await fetch(config.authUrl + '/oauth2/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({ grant_type:'authorization_code', client_id:config.clientId,
      redirect_uri:location.origin + '/', code, code_verifier:saved.verifier })
  });
  if (!response.ok) throw new Error('Sign-in failed. Please retry.');
  token = (await response.json()).id_token || '';
  sessionStorage.setItem('hunar.token', token);
}
export function signOut(config) {
  token = '';
  sessionStorage.removeItem('hunar.token');
  location.assign(config.authUrl + '/logout?' + new URLSearchParams({
    client_id:config.clientId, logout_uri:location.origin + '/'
  }));
}
