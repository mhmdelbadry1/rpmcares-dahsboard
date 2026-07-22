import { env } from "../env";

export function renderAcceptInvitePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Set up your RPMCares account</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
<style>
  :root {
    --primary: #0073cf;
    --text: #031222;
    --text-secondary: #5c6b7a;
    --surface: #f8fafd;
    --card: #ffffff;
    --border: #dfe5ec;
    --destructive: #e62b34;
    --success: #04ab62;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: var(--surface);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .wrap { width: 100%; max-width: 360px; }
  .brand { display: flex; flex-direction: column; align-items: center; margin-bottom: 28px; }
  .brand-icon {
    width: 56px; height: 56px; border-radius: 18px; background: var(--primary);
    display: flex; align-items: center; justify-content: center; color: #fff;
    font-weight: 800; font-size: 22px;
  }
  .brand-title { font-size: 20px; font-weight: 800; margin-top: 12px; }
  .brand-sub { font-size: 11px; letter-spacing: 1.4px; color: var(--text-secondary); margin-top: 2px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 24px;
  }
  h1 { font-size: 17px; font-weight: 700; margin: 0; }
  p.subhead { font-size: 12.5px; color: var(--text-secondary); margin: 4px 0 0; }
  label { display: block; font-size: 12.5px; font-weight: 600; margin: 18px 0 6px; }
  input {
    width: 100%; height: 44px; border: 1px solid var(--border); border-radius: 10px;
    padding: 0 12px; font-size: 14.5px; font-family: inherit;
  }
  input:focus { outline: 2px solid var(--primary); outline-offset: -1px; }
  button {
    width: 100%; height: 46px; border: none; border-radius: 999px; background: var(--primary);
    color: #fff; font-size: 14.5px; font-weight: 700; margin-top: 22px; cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .message { font-size: 12.5px; font-weight: 600; margin-top: 14px; }
  .message.error { color: var(--destructive); }
  .message.success { color: var(--success); }
  .hint { font-size: 11px; color: var(--text-secondary); text-align: center; margin-top: 16px; }
  #status-screen { text-align: center; padding: 12px 0; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="brand-icon">R</div>
      <div class="brand-title">RPMCares</div>
      <div class="brand-sub">COMMAND CENTER</div>
    </div>

    <div class="card">
      <div id="loading-screen">
        <h1>Checking your invite…</h1>
        <p class="subhead">This only takes a moment.</p>
      </div>

      <div id="form-screen" style="display:none;">
        <h1>Set your password</h1>
        <p class="subhead" id="invite-subhead">Choose a password to finish setting up your account.</p>

        <label for="password">New password</label>
        <input id="password" type="password" autocomplete="new-password" placeholder="••••••••" />

        <label for="confirm">Confirm password</label>
        <input id="confirm" type="password" autocomplete="new-password" placeholder="••••••••" />

        <button id="submit-btn">Set password &amp; continue</button>
        <div id="form-message" class="message"></div>
      </div>

      <div id="status-screen" style="display:none;">
        <h1 id="status-title"></h1>
        <p class="subhead" id="status-body"></p>
      </div>
    </div>

    <p class="hint">After setting your password, you'll be taken to the dashboard automatically.</p>
  </div>

  <script>
    const supabaseClient = window.supabase.createClient(${JSON.stringify(env.SUPABASE_URL)}, ${JSON.stringify(env.SUPABASE_ANON_KEY)});

    const loadingScreen = document.getElementById('loading-screen');
    const formScreen = document.getElementById('form-screen');
    const statusScreen = document.getElementById('status-screen');
    const statusTitle = document.getElementById('status-title');
    const statusBody = document.getElementById('status-body');
    const formMessage = document.getElementById('form-message');

    function showStatus(title, body, tone) {
      loadingScreen.style.display = 'none';
      formScreen.style.display = 'none';
      statusScreen.style.display = 'block';
      statusTitle.textContent = title;
      statusTitle.style.color = tone === 'error' ? 'var(--destructive)' : 'var(--text)';
      statusBody.textContent = body;
    }

    function showForm() {
      loadingScreen.style.display = 'none';
      statusScreen.style.display = 'none';
      formScreen.style.display = 'block';
    }

    let sessionReady = false;

    supabaseClient.auth.onAuthStateChange((_event, session) => {
      if (session && !sessionReady) {
        sessionReady = true;
        showForm();
      }
    });

    setTimeout(async () => {
      if (sessionReady) return;
      const { data } = await supabaseClient.auth.getSession();
      if (data.session) {
        sessionReady = true;
        showForm();
      } else {
        showStatus(
          'This link is invalid or has expired',
          'Ask whoever invited you to send a new invite.',
          'error',
        );
      }
    }, 2500);

    document.getElementById('submit-btn').addEventListener('click', async () => {
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      formMessage.textContent = '';
      formMessage.className = 'message';

      if (password.length < 8) {
        formMessage.textContent = 'Password must be at least 8 characters.';
        formMessage.classList.add('error');
        return;
      }
      if (password !== confirm) {
        formMessage.textContent = 'Passwords do not match.';
        formMessage.classList.add('error');
        return;
      }

      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.textContent = 'Setting password…';

      const { error } = await supabaseClient.auth.updateUser({ password });

      if (error) {
        formMessage.textContent = error.message;
        formMessage.classList.add('error');
        btn.disabled = false;
        btn.textContent = 'Set password & continue';
        return;
      }

      // Auto-login: exchange credentials for a backend session token so the
      // dashboard can pick it up from localStorage and skip the login screen.
      btn.textContent = 'Logging you in…';
      try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        const loginRes = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: user.email, password }),
        });
        if (loginRes.ok) {
          const session = await loginRes.json();
          localStorage.setItem('rpmcares.session', JSON.stringify(session));
          window.location.replace('/');
          return;
        }
      } catch (_) { /* fall through */ }

      showStatus('You\\'re all set', 'Your password has been saved. Open the RPMCares app and sign in with your email.', 'success');
    });
  </script>
</body>
</html>`;
}
