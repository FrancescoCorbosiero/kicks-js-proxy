/**
 * The sign-in page, in Store Hub's own look. Authelia still does the signing
 * in: this page only replaces its form. Caddy serves it where Authelia sends
 * anyone without a session (https://<address>/authelia/?rd=<page>, rewritten
 * to the app's SIGN_IN_PATH), and the form posts the name and password to
 * Authelia's own API on the same address, which checks them, applies the
 * lockout after wrong passwords and sets the session cookie. Everything else
 * under /authelia (the API, its settings page, a second factor if one is ever
 * required) stays Authelia's.
 *
 * One self-contained HTML document: its styles and script are inline because
 * the app's own files (/_next/...) sit behind the sign-in too. Both carry a
 * per-response nonce, and the Content-Security-Policy allows nothing else.
 *
 * Pure module: the route (src/app/sign-in/route.ts) passes in the texts, the
 * address and the nonce.
 */
import type { Dictionary } from "@/i18n/dictionary";
import type { Locale } from "@/i18n/config";
import { LOCALE_COOKIE } from "@/i18n/config";

/** Authelia's API and pages, served on every protected address under /authelia. */
export const AUTHELIA_FIRST_FACTOR = "/authelia/api/firstfactor";
export const AUTHELIA_LOGOUT = "/authelia/api/logout";
/** Authelia's own page for a second factor, should an address ever require one. */
export const AUTHELIA_SECOND_FACTOR = "/authelia/2fa";

export interface SignInPageInput {
  t: Dictionary["signIn"];
  locale: Locale;
  /** Which app this address serves, for the heading. */
  area: "hub" | "vetrina";
  /** The address, as the browser asked for it (already normalized). */
  host: string;
  nonce: string;
}

/** The page's Content-Security-Policy: its own inline style and script, and calls to its own address. */
export function signInPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** JSON for an inline <script>: nothing in it can close the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

// The app's design tokens (src/app/globals.css), light and dark: keep in step.
const STYLE = `
:root{--bg:#f6f7f5;--surface:#fff;--surface-2:#f1f3f0;--line:rgba(17,24,19,.09);--line-strong:rgba(17,24,19,.16);--ink:#141a16;--muted:#5a655d;--faint:#8b958c;--accent:#e8c437;--accent-strong:#d1a91a;--accent-fg:#241b00;--danger:#c2452f;--ok:#1f9d63;--ring:#8a6b00;--shadow:0 24px 60px -20px rgba(16,22,18,.28),0 1px 3px rgba(16,22,18,.07);color-scheme:light}
.dark{--bg:#0a0c0b;--surface:#121514;--surface-2:#181c1a;--line:rgba(255,255,255,.09);--line-strong:rgba(255,255,255,.17);--ink:#e9efe9;--muted:#a4aea6;--faint:#6d766f;--accent:#ddbe3f;--accent-strong:#eccf67;--accent-fg:#221a00;--danger:#ff7a66;--ok:#4cd699;--ring:#eccf67;--shadow:0 24px 60px -20px rgba(0,0,0,.6),0 1px 3px rgba(0,0,0,.4);color-scheme:dark}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:max(24px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom));background:radial-gradient(900px 480px at 50% -12%,color-mix(in oklab,var(--accent) 16%,transparent),transparent 70%),var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;letter-spacing:-.011em;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:400px;background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);padding:28px 24px 24px}
@media (min-width:480px){.card{padding:32px 32px 28px}}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:26px}
.tile{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--accent);color:var(--accent-fg);font-weight:800;font-size:22px;letter-spacing:-.5px;box-shadow:0 6px 16px -8px color-mix(in oklab,var(--accent) 70%,transparent)}
.brand b{display:block;font-size:15px;font-weight:650;letter-spacing:-.02em}
.brand span{display:block;margin-top:2px;font-size:12px;color:var(--faint);overflow-wrap:anywhere}
h1{font-size:24px;font-weight:700;letter-spacing:-.03em;margin-bottom:20px}
form{display:flex;flex-direction:column;gap:16px}
label.field{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:var(--muted)}
.hint{font-size:12px;font-weight:500;color:var(--faint)}
.input{position:relative;display:flex}
input[type=text],input[type=password]{width:100%;height:46px;padding:0 14px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface-2);color:var(--ink);font:inherit;font-size:16px;font-weight:500;outline:none;transition:border-color .15s,box-shadow .15s,background .15s}
input[type=text]:focus,input[type=password]:focus{border-color:var(--accent-strong);background:var(--surface);box-shadow:0 0 0 4px color-mix(in oklab,var(--accent) 28%,transparent)}
.input input{padding-right:84px}
.reveal{position:absolute;right:6px;top:6px;bottom:6px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.reveal:hover{background:var(--line);color:var(--ink)}
.check{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--muted);cursor:pointer;user-select:none}
.check input{width:18px;height:18px;margin:0;accent-color:var(--accent-strong)}
button.submit{position:relative;height:48px;margin-top:4px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-fg);font:inherit;font-size:15px;font-weight:700;cursor:pointer;transition:background .15s,transform .1s}
button.submit:hover{background:var(--accent-strong)}
button.submit:active{transform:scale(.99)}
button.submit[disabled]{opacity:.75;cursor:progress}
.spin{display:none;width:16px;height:16px;margin-right:8px;vertical-align:-3px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:s .7s linear infinite}
button[disabled] .spin{display:inline-block}
@keyframes s{to{transform:rotate(360deg)}}
.note{display:none;padding:11px 14px;border-radius:12px;font-size:14px;line-height:1.4}
.note.on{display:block}
.note small{display:block;margin-top:2px;font-size:12.5px;opacity:.85}
.note.err{background:color-mix(in oklab,var(--danger) 11%,transparent);border:1px solid color-mix(in oklab,var(--danger) 30%,transparent);color:var(--danger)}
.note.ok{background:color-mix(in oklab,var(--ok) 11%,transparent);border:1px solid color-mix(in oklab,var(--ok) 30%,transparent);color:var(--ok)}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
input:focus-visible{outline:none}
footer{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--faint)}
footer a{color:var(--muted);font-weight:600;text-decoration:none;padding:4px 6px;border-radius:6px}
footer a[aria-current]{color:var(--ink);background:var(--line)}
noscript p{font-size:14px;color:var(--danger)}
`.trim();

/** The page. Every value from outside (the address) is escaped. */
export function renderSignInPage({ t, locale, area, host, nonce }: SignInPageInput): string {
  const n = esc(nonce);
  const texts = {
    submit: t.submit,
    submitting: t.submitting,
    failed: t.failed,
    failedHint: t.failedHint,
    unavailable: t.unavailable,
    signedOut: t.signedOut,
    show: t.showPassword,
    hide: t.hidePassword,
  };
  const paths = { firstFactor: AUTHELIA_FIRST_FACTOR, logout: AUTHELIA_LOGOUT, secondFactor: AUTHELIA_SECOND_FACTOR };
  const lang = (code: Locale, label: string) =>
    `<a href="#" data-lang="${code}"${code === locale ? ' aria-current="true"' : ""}>${label}</a>`;

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(t.pageTitle)}</title>
<link rel="icon" href="/icon">
<link rel="apple-touch-icon" href="/apple-icon">
<script nonce="${n}">(function(){try{var t=localStorage.getItem('kx-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}})();</script>
<style nonce="${n}">${STYLE}</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <div class="tile" aria-hidden="true">S</div>
    <div><b>${esc(area === "vetrina" ? t.vetrina : t.hub)}</b><span>${esc(host)}</span></div>
  </div>
  <h1>${esc(t.title)}</h1>
  <noscript><p>${esc(t.noScript)}</p></noscript>
  <form id="sign-in" novalidate>
    <div class="note ok" id="notice" role="status"></div>
    <div class="note err" id="error" role="alert"></div>
    <label class="field">${esc(t.username)}
      <input type="text" name="username" id="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
      <span class="hint">${esc(t.usernameHint)}</span>
    </label>
    <label class="field">${esc(t.password)}
      <span class="input">
        <input type="password" name="password" id="password" autocomplete="current-password" required>
        <button type="button" class="reveal" id="reveal" aria-controls="password">${esc(t.showPassword)}</button>
      </span>
    </label>
    <label class="check"><input type="checkbox" id="remember" checked> ${esc(t.remember)}</label>
    <button type="submit" class="submit" id="submit"><span class="spin" aria-hidden="true"></span><span id="submit-label">${esc(t.submit)}</span></button>
  </form>
</main>
<footer>${lang("it", "Italiano")}${lang("en", "English")}</footer>
<script nonce="${n}">(function(){
var T=${scriptJson(texts)},P=${scriptJson(paths)};
var q=new URLSearchParams(location.search),$=function(id){return document.getElementById(id)};
var form=$('sign-in'),user=$('username'),pass=$('password'),remember=$('remember'),submit=$('submit'),label=$('submit-label'),error=$('error'),notice=$('notice'),reveal=$('reveal');
function say(el,text,hint){el.textContent=text;if(hint){var s=document.createElement('small');s.textContent=hint;el.appendChild(s)}el.className=el.className.replace(/ on$/,'')+' on'}
function busy(on){submit.disabled=on;label.textContent=on?T.submitting:T.submit}
function post(path,body){return fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)})}
if(q.has('signout')){q.delete('signout');history.replaceState(null,'',location.pathname+(q.toString()?'?'+q:''));post(P.logout,{}).then(function(){say(notice,T.signedOut)},function(){})}
reveal.addEventListener('click',function(){var shown=pass.type==='text';pass.type=shown?'password':'text';reveal.textContent=shown?T.show:T.hide;pass.focus()});
document.querySelectorAll('[data-lang]').forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();document.cookie='${LOCALE_COOKIE}='+a.getAttribute('data-lang')+'; path=/; max-age=31536000; samesite=lax';location.reload()})});
form.addEventListener('submit',function(e){e.preventDefault();
  error.className='note err';notice.className='note ok';
  var name=user.value.trim();if(!name){user.focus();return}if(!pass.value){pass.focus();return}
  busy(true);
  var body={username:name,password:pass.value,keepMeLoggedIn:remember.checked};
  if(q.get('rd'))body.targetURL=q.get('rd');if(q.get('rm'))body.requestMethod=q.get('rm');
  post(P.firstFactor,body).then(function(res){return res.json().then(function(j){return{status:res.status,body:j}},function(){return{status:res.status,body:null}})}).then(function(r){
    if(r.status===200&&r.body&&r.body.status==='OK'){
      var to=r.body.data&&r.body.data.redirect;
      location.assign(to||P.secondFactor+location.search);return}
    busy(false);
    if(r.status===401){say(error,T.failed,T.failedHint);pass.value='';pass.focus()}else say(error,T.unavailable);
  },function(){busy(false);say(error,T.unavailable)});
});
})();</script>
</body>
</html>
`;
}
