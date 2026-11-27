function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderPage(ownerName: string): string {
  const safeName = escapeHtml(ownerName);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Doorbell</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f5f7;
    --fg: #1a1a1a;
    --muted: #4b4b55;
    --card: #ffffff;
    --accent: #2451c4;
    --accent-fg: #ffffff;
    --border: #d5d5dd;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121214;
      --fg: #f2f2f4;
      --muted: #c7c7ce;
      --card: #1c1c1f;
      --accent: #6d8dff;
      --accent-fg: #0b0b0d;
      --border: #3a3a3f;
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  main {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  h1 {
    font-size: 1.5rem;
    margin: 0;
    text-align: center;
  }
  label {
    font-size: 0.95rem;
    color: var(--muted);
    display: block;
    margin-bottom: 6px;
  }
  input[type="text"] {
    width: 100%;
    font-size: 1rem;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--fg);
  }
  button {
    width: 100%;
    min-height: 56px;
    font-size: 1.05rem;
    font-weight: 600;
    border-radius: 12px;
    border: none;
    background: var(--accent);
    color: var(--accent-fg);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  #status {
    min-height: 1.2em;
    text-align: center;
    font-size: 0.95rem;
    color: var(--muted);
  }
</style>
</head>
<body>
<main>
  <h1>Let ${safeName} know you're here</h1>
  <div>
    <label for="visitor-name">Your name (optional)</label>
    <input id="visitor-name" name="name" type="text" maxlength="40" autocomplete="name" placeholder="Your name">
  </div>
  <button id="ring-button" type="button">Ring the bell</button>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script>
(function () {
  var button = document.getElementById('ring-button');
  var status = document.getElementById('status');
  var nameInput = document.getElementById('visitor-name');
  var busy = false;

  function setStatus(message) {
    status.textContent = message;
  }

  function disableFor(ms) {
    button.disabled = true;
    setTimeout(function () {
      button.disabled = false;
    }, ms);
  }

  button.addEventListener('click', function () {
    if (busy || button.disabled) return;
    busy = true;
    button.disabled = true;
    button.textContent = 'Ringing...';
    setStatus('');

    fetch(location.pathname + '/ring', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameInput.value })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    }).then(function (result) {
      busy = false;
      button.textContent = 'Ring the bell';

      if (result.status === 200 && result.data && result.data.ok) {
        setStatus('${safeName} has been notified. Hang tight!');
        disableFor(60000);
        return;
      }

      if (result.status === 429) {
        setStatus('Already rang, hang tight!');
        disableFor(60000);
        return;
      }

      setStatus("Couldn't reach ${safeName} right now. Try texting instead.");
      button.disabled = false;
    }).catch(function () {
      busy = false;
      button.textContent = 'Ring the bell';
      setStatus("Couldn't reach ${safeName} right now. Try texting instead.");
      button.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;
}
