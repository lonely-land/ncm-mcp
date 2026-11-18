/**
 * Server-rendered login page. No client framework needed for the shell: the three tabs
 * are progressively enhanced by `login-form.tsx`.
 */
export function renderLoginPage(props: { clientName: string; scope: string }): string {
  const { clientName, scope } = props
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in to NetEase Cloud Music</title>
<style>${STYLES}</style>
</head>
<body>
<main class="shell">
  <header class="head">
    <div class="badge" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
        <path d="M12 3v9" />
      </svg>
    </div>
    <h1>Sign in to NetEase Cloud Music</h1>
    <p class="sub"><strong>${escapeHtml(clientName)}</strong> wants to use your NetEase account through this MCP server.</p>
    <p class="scope">Scopes requested: <code>${escapeHtml(scope)}</code></p>
  </header>

  <div class="tabs" role="tablist" aria-label="Sign-in method">
    <button class="tab is-active" role="tab" aria-selected="true" data-tab="qr" type="button">QR code</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="sms" type="button">SMS code</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="password" type="button">Password</button>
  </div>

  <section class="panel is-active" data-panel="qr">
    <div class="qr-wrap">
      <div class="qr" id="qr-box" role="img" aria-label="Login QR code">
        <div class="qr-placeholder" id="qr-placeholder">
          <span class="spinner"></span>
          <span id="qr-hint">Generating QR code…</span>
        </div>
      </div>
      <div class="qr-side">
        <p class="qr-title">Scan with the NetEase Cloud Music app</p>
        <ol class="steps">
          <li>Open the NetEase Cloud Music mobile app</li>
          <li>Tap <em>Scan</em> in the search bar</li>
          <li>Confirm the sign-in on your phone</li>
        </ol>
        <p class="status" id="qr-status" role="status" aria-live="polite"></p>
        <button class="link" id="qr-refresh" type="button">Get a new QR code</button>
      </div>
    </div>
  </section>

  <section class="panel" data-panel="sms">
    <form id="sms-form" novalidate>
      <label>Phone number
        <input id="sms-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="13800000000" required />
      </label>
      <label>Country code
        <input id="sms-country" name="countrycode" type="text" inputmode="numeric" value="86" required />
      </label>
      <label>Verification code
        <span class="row">
          <input id="sms-code" name="captcha" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6 digits" required />
          <button class="secondary" id="sms-send" type="button">Send code</button>
        </span>
      </label>
      <button class="primary" type="submit" id="sms-submit">Sign in</button>
      <p class="status" id="sms-status" role="status" aria-live="polite"></p>
    </form>
  </section>

  <section class="panel" data-panel="password">
    <form id="password-form" novalidate>
      <label>Phone number or email
        <input id="pw-account" name="account" type="text" autocomplete="username" placeholder="13800000000 or you@example.com" required />
      </label>
      <label id="pw-country-row">Country code
        <input id="pw-country" name="countrycode" type="text" inputmode="numeric" value="86" />
      </label>
      <label>Password
        <input id="pw-password" name="password" type="password" autocomplete="current-password" required />
      </label>
      <button class="primary" type="submit" id="pw-submit">Sign in</button>
      <p class="status" id="pw-status" role="status" aria-live="polite"></p>
    </form>
  </section>

  <footer class="foot">
    <p>
      Your NetEase session cookie is sealed inside the MCP access token and never stored on the
      server. Revoke access at any time by disconnecting the client.
    </p>
  </footer>
</main>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const STYLES = `
:root{color-scheme:dark light;--bg:#0d0b12;--panel:#161320;--panel-2:#1d1929;--line:#2b2538;--text:#efeaf7;--muted:#a095b8;--accent:#ff2d55;--accent-2:#ff6b8a;--ok:#3ddc97;--warn:#ffc857}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(1200px 600px at 20% -10%,#2a1730 0%,transparent 60%),radial-gradient(900px 500px at 110% 10%,#1b1030 0%,transparent 55%),var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif}
.shell{width:100%;max-width:520px;background:linear-gradient(180deg,rgba(255,255,255,.04),transparent 30%),var(--panel);border:1px solid var(--line);border-radius:20px;padding:28px;box-shadow:0 30px 80px -40px rgba(0,0,0,.9)}
.head{text-align:center;margin-bottom:20px}
.badge{width:44px;height:44px;margin:0 auto 12px;display:grid;place-items:center;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}
h1{font-size:20px;line-height:1.3;margin:0 0 8px;letter-spacing:-.01em}
.sub{margin:0 0 6px;color:var(--muted);font-size:13.5px}
.sub strong{color:var(--text);font-weight:600}
.scope{margin:0;font-size:12px;color:var(--muted)}
.scope code{background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:11.5px}
.tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:var(--panel-2);border:1px solid var(--line);border-radius:12px;padding:4px;margin-bottom:18px}
.tab{appearance:none;border:0;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:500;padding:8px 6px;border-radius:9px;cursor:pointer;transition:background .16s,color .16s}
.tab:hover{color:var(--text)}
.tab.is-active{background:var(--panel);color:var(--text);box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 6px 18px -12px #000}
.panel{display:none}
.panel.is-active{display:block}
label{display:block;margin-bottom:14px;font-size:12.5px;font-weight:500;color:var(--muted)}
input{display:block;width:100%;margin-top:6px;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:#0f0d17;color:var(--text);font:inherit;font-size:14px;outline:none;transition:border-color .16s,box-shadow .16s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,45,85,.16)}
.row{display:flex;gap:8px;margin-top:6px}
.row input{margin-top:0;flex:1}
button{font:inherit;cursor:pointer;border-radius:10px;transition:filter .16s,background .16s,opacity .16s}
button:disabled{opacity:.55;cursor:not-allowed}
.primary{width:100%;padding:11px 16px;border:0;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:600;font-size:14px;margin-top:4px}
.primary:hover:not(:disabled){filter:brightness(1.08)}
.secondary{padding:0 14px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);font-size:13px;white-space:nowrap}
.secondary:hover:not(:disabled){background:#241f33}
.link{border:0;background:none;color:var(--accent-2);padding:0;font-size:13px;text-decoration:underline;text-underline-offset:3px}
.status{min-height:20px;margin:12px 0 0;font-size:13px;color:var(--muted)}
.status.is-error{color:#ff8095}
.status.is-ok{color:var(--ok)}
.status.is-warn{color:var(--warn)}
.qr-wrap{display:flex;gap:20px;align-items:center;flex-wrap:wrap;justify-content:center}
.qr{width:186px;height:186px;flex:0 0 auto;border-radius:14px;background:#fff;padding:10px;display:grid;place-items:center;overflow:hidden}
.qr img{width:100%;height:100%;display:block;image-rendering:pixelated}
.qr-placeholder{display:grid;gap:10px;justify-items:center;color:#4a4157;font-size:12px;text-align:center}
.spinner{width:26px;height:26px;border-radius:50%;border:3px solid rgba(0,0,0,.12);border-top-color:#ff2d55;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.qr-side{flex:1 1 210px;min-width:200px}
.qr-title{margin:0 0 10px;font-size:13.5px;font-weight:600;color:var(--text)}
.steps{margin:0 0 12px;padding-left:18px;color:var(--muted);font-size:12.5px}
.steps li{margin-bottom:4px}
.steps em{color:var(--text);font-style:normal}
.foot{margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.foot p{margin:0;color:var(--muted);font-size:11.5px;line-height:1.6}
@media (max-width:420px){.shell{padding:20px;border-radius:16px}.qr{width:160px;height:160px}}
`

const CLIENT_SCRIPT = `
(function(){
  var tabs = document.querySelectorAll('.tab');
  var panels = document.querySelectorAll('.panel');
  function show(name){
    tabs.forEach(function(t){ var on = t.dataset.tab === name; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    panels.forEach(function(p){ p.classList.toggle('is-active', p.dataset.panel === name); });
    if (name === 'qr' && !document.getElementById('qr-box').dataset.started) startQr();
  }
  tabs.forEach(function(t){ t.addEventListener('click', function(){ show(t.dataset.tab); }); });

  function setStatus(id, text, kind){
    var el = document.getElementById(id);
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' is-' + kind : '');
  }
  function post(url, body){
    return fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body || {}), credentials:'same-origin' })
      .then(function(r){ return r.json().catch(function(){ return { ok:false, message:'Unexpected server response (' + r.status + ')' }; }); });
  }
  // The login completion returns a redirect target; navigate there so the browser
  // follows the client redirect URI with the authorization code.
  function complete(payload){
    return fetch('/api/auth/complete', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(payload), credentials:'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(data){ if (data && data.redirect) { window.location.replace(data.redirect); return true; } return false; });
  }

  var qrKey = null, qrTimer = null;
  function startQr(){
    var box = document.getElementById('qr-box');
    box.dataset.started = '1';
    stopPoll();
    box.innerHTML = '<div class="qr-placeholder"><span class="spinner"></span><span>Generating QR code…</span></div>';
    setStatus('qr-status', '');
    post('/api/auth/qr/create', {}).then(function(data){
      if (!data.ok) { failQr(data.message || 'Could not create a QR code'); return; }
      qrKey = data.key;
      box.innerHTML = '<img alt="NetEase login QR code" src="' + data.qrImage + '" />';
      setStatus('qr-status', 'Waiting for scan…');
      qrTimer = setInterval(pollQr, 2000);
    }).catch(function(){ failQr('Network error while creating the QR code'); });
  }
  function failQr(msg){
    setStatus('qr-status', msg, 'error');
    document.getElementById('qr-box').innerHTML = '<div class="qr-placeholder"><span>QR unavailable</span></div>';
  }
  function stopPoll(){ if (qrTimer) { clearInterval(qrTimer); qrTimer = null; } }
  function pollQr(){
    if (!qrKey) return;
    post('/api/auth/qr/poll', { key: qrKey }).then(function(data){
      if (data.status === 801) { setStatus('qr-status', 'Waiting for scan…'); return; }
      if (data.status === 802) { setStatus('qr-status', 'Scanned — confirm on your phone', 'warn'); return; }
      if (data.status === 800) { stopPoll(); setStatus('qr-status', 'QR expired. Get a new one.', 'error'); return; }
      if (data.ok) {
        stopPoll();
        setStatus('qr-status', 'Signed in, finishing…', 'ok');
        complete({ method:'qr', jar: data.jar, userId: data.userId, nickname: data.nickname }).then(function(done){
          if (!done) setStatus('qr-status', 'Signed in, but the redirect failed. Close this tab and retry from your client.', 'error');
        });
        return;
      }
      setStatus('qr-status', data.message || 'QR login failed', 'error');
    }).catch(function(){ setStatus('qr-status', 'Network hiccup, retrying…', 'warn'); });
  }
  document.getElementById('qr-refresh').addEventListener('click', startQr);

  var smsCooldown = 0, smsTimer = null;
  document.getElementById('sms-send').addEventListener('click', function(){
    var phone = document.getElementById('sms-phone').value.trim();
    var country = document.getElementById('sms-country').value.trim() || '86';
    if (!phone) { setStatus('sms-status', 'Enter your phone number first', 'error'); return; }
    if (smsCooldown > 0) return;
    var btn = this;
    btn.disabled = true;
    post('/api/auth/sms/send', { phone: phone, countrycode: country }).then(function(data){
      if (!data.ok) { setStatus('sms-status', data.message || 'Could not send the code', 'error'); btn.disabled = false; return; }
      setStatus('sms-status', 'Code sent. Check your messages.', 'ok');
      smsCooldown = 60;
      btn.textContent = smsCooldown + 's';
      smsTimer = setInterval(function(){
        smsCooldown--;
        if (smsCooldown <= 0) { clearInterval(smsTimer); btn.textContent = 'Send code'; btn.disabled = false; return; }
        btn.textContent = smsCooldown + 's';
      }, 1000);
    }).catch(function(){ setStatus('sms-status', 'Network error', 'error'); btn.disabled = false; });
  });

  document.getElementById('sms-form').addEventListener('submit', function(event){
    event.preventDefault();
    var phone = document.getElementById('sms-phone').value.trim();
    var country = document.getElementById('sms-country').value.trim() || '86';
    var captcha = document.getElementById('sms-code').value.trim();
    if (!phone || !captcha) { setStatus('sms-status', 'Phone number and code are required', 'error'); return; }
    var btn = document.getElementById('sms-submit');
    btn.disabled = true;
    setStatus('sms-status', 'Signing in…');
    post('/api/auth/sms/login', { phone: phone, countrycode: country, captcha: captcha }).then(function(data){
      if (!data.ok) { setStatus('sms-status', data.message || 'Sign-in failed', 'error'); btn.disabled = false; return; }
      setStatus('sms-status', 'Signed in, finishing…', 'ok');
      complete({ method:'jar', jar: data.jar, userId: data.userId, nickname: data.nickname }).then(function(done){
        if (!done) { setStatus('sms-status', 'Signed in, but the redirect failed.', 'error'); btn.disabled = false; }
      });
    }).catch(function(){ setStatus('sms-status', 'Network error', 'error'); btn.disabled = false; });
  });

  var pwAccount = document.getElementById('pw-account');
  var pwCountryRow = document.getElementById('pw-country-row');
  pwAccount.addEventListener('input', function(){
    pwCountryRow.style.display = pwAccount.value.includes('@') ? 'none' : 'block';
  });

  document.getElementById('password-form').addEventListener('submit', function(event){
    event.preventDefault();
    var account = pwAccount.value.trim();
    var password = document.getElementById('pw-password').value;
    var country = document.getElementById('pw-country').value.trim() || '86';
    if (!account || !password) { setStatus('pw-status', 'Account and password are required', 'error'); return; }
    var btn = document.getElementById('pw-submit');
    btn.disabled = true;
    setStatus('pw-status', 'Signing in…');
    post('/api/auth/password/login', { account: account, password: password, countrycode: country }).then(function(data){
      if (!data.ok) { setStatus('pw-status', data.message || 'Sign-in failed', 'error'); btn.disabled = false; return; }
      setStatus('pw-status', 'Signed in, finishing…', 'ok');
      complete({ method:'jar', jar: data.jar, userId: data.userId, nickname: data.nickname }).then(function(done){
        if (!done) { setStatus('pw-status', 'Signed in, but the redirect failed.', 'error'); btn.disabled = false; }
      });
    }).catch(function(){ setStatus('pw-status', 'Network error', 'error'); btn.disabled = false; });
  });

  startQr();
})();
`
