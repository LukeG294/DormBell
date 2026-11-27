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
    align-items: center;
    gap: 20px;
  }
  h1 {
    font-size: 1.3rem;
    margin: 0;
    text-align: center;
  }
  form {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
  }
  .field {
    width: 100%;
    max-width: 300px;
    text-align: center;
  }
  label {
    display: block;
    margin-bottom: 8px;
    font-size: 0.9rem;
    color: var(--muted);
  }
  input#visitor-name {
    width: 100%;
    font: inherit;
    font-size: 1.1rem;
    text-align: center;
    padding: 14px 18px;
    border-radius: 999px;
    border: 2px solid var(--border);
    background: var(--card);
    color: var(--fg);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input#visitor-name:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 4px rgba(80, 120, 240, 0.25);
  }
  button#ring-button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 4px;
  }
  button#ring-button {
    width: 140px;
    height: 140px;
    min-width: 56px;
    min-height: 56px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 4rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  button#ring-button:disabled {
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
  <h1>Ring the bell</h1>
  <form id="ring-form">
    <div class="field" id="name-field" hidden>
      <label for="visitor-name">First name</label>
      <input id="visitor-name" type="text" maxlength="40" autocomplete="given-name"
             enterkeyhint="send" placeholder="e.g. Maya">
    </div>
    <button id="ring-button" type="submit" aria-label="Ring the bell">&#128276;</button>
  </form>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script>
(function () {
  var NAME_KEY = 'doorbell_visitor_name';
  var button = document.getElementById('ring-button');
  var status = document.getElementById('status');
  var busy = false;
  var form = document.getElementById('ring-form');
  var nameInput = document.getElementById('visitor-name');
  var nameField = document.getElementById('name-field');

  // Ask only before the first ring. A blank answer is saved too, so it isn't asked again.
  var saved = null;
  try {
    saved = localStorage.getItem(NAME_KEY);
  } catch (e) {}
  nameInput.value = saved || '';
  nameField.hidden = saved !== null;

  function rememberName(name) {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch (e) {}
    nameField.hidden = true;
  }

  function setStatus(message) {
    status.textContent = message;
  }

  function disableFor(ms) {
    button.disabled = true;
    setTimeout(function () {
      button.disabled = false;
    }, ms);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy || button.disabled) return;
    busy = true;
    button.disabled = true;
    nameInput.blur();
    var visitorName = nameInput.value.trim().slice(0, 40);
    rememberName(visitorName);
    setStatus('Ringing...');

    fetch(location.pathname + '/ring', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: visitorName })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    }).then(function (result) {
      busy = false;

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
      setStatus("Couldn't reach ${safeName} right now. Try texting instead.");
      button.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;
}
