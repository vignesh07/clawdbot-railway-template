// Served at /setup/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  var statusEl = document.getElementById('status');
  var statusDot = document.getElementById('statusDot');
  var logEl = document.getElementById('log');

  // Provider fields
  var authChoiceEl = document.getElementById('authChoice');
  var modelEl = document.getElementById('model');
  var modelLabelEl = document.getElementById('modelLabel');
  var modelHintEl = document.getElementById('modelHint');

  // Debug console
  var consoleCmdEl = document.getElementById('consoleCmd');
  var consoleArgEl = document.getElementById('consoleArg');
  var consoleRunEl = document.getElementById('consoleRun');
  var consoleOutEl = document.getElementById('consoleOut');

  // Config editor
  var configPathEl = document.getElementById('configPath');
  var configTextEl = document.getElementById('configText');
  var configReloadEl = document.getElementById('configReload');
  var configSaveEl = document.getElementById('configSave');
  var configOutEl = document.getElementById('configOut');

  // Import
  var importFileEl = document.getElementById('importFile');
  var importRunEl = document.getElementById('importRun');
  var importOutEl = document.getElementById('importOut');

  // Toggles
  var toggleSlack = document.getElementById('toggleSlack');
  var slackSection = document.getElementById('slackSection');
  var toggleAdvanced = document.getElementById('toggleAdvanced');
  var advancedSection = document.getElementById('advancedSection');

  // Model field visibility based on provider
  var providersWithModel = {
    'openrouter-api-key': { placeholder: 'anthropic/claude-sonnet-4', hint: 'OpenRouter format: provider/model-name. Examples: anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-2.5-pro' },
    'openai-api-key': { placeholder: 'gpt-4o', hint: 'e.g. gpt-4o, gpt-4o-mini, o1-preview' },
    'gemini-api-key': { placeholder: 'gemini-2.5-pro', hint: 'e.g. gemini-2.5-pro, gemini-2.5-flash' },
    'ai-gateway-api-key': { placeholder: 'anthropic/claude-sonnet-4', hint: 'provider/model format via Vercel AI Gateway' },
    'apiKey': { placeholder: 'claude-sonnet-4-20250514', hint: 'e.g. claude-sonnet-4-20250514, claude-opus-4-20250514' }
  };

  function updateModelVisibility() {
    var choice = authChoiceEl.value;
    var cfg = providersWithModel[choice];
    if (cfg) {
      modelEl.style.display = '';
      modelLabelEl.style.display = '';
      modelHintEl.style.display = '';
      modelEl.placeholder = cfg.placeholder;
      modelHintEl.textContent = cfg.hint;
    } else {
      modelEl.style.display = 'none';
      modelLabelEl.style.display = 'none';
      modelHintEl.style.display = 'none';
    }
  }

  authChoiceEl.onchange = updateModelVisibility;
  updateModelVisibility();

  // Toggle handlers
  if (toggleSlack && slackSection) {
    toggleSlack.onclick = function () {
      var open = slackSection.classList.toggle('open');
      toggleSlack.textContent = open ? '- Slack' : '+ Slack';
    };
  }

  if (toggleAdvanced && advancedSection) {
    toggleAdvanced.onclick = function () {
      var open = advancedSection.classList.toggle('open');
      toggleAdvanced.textContent = open ? 'Hide advanced tools' : 'Advanced tools';
    };
  }

  function showLog(text) {
    logEl.textContent = text;
    logEl.classList.add('visible');
  }

  function appendLog(text) {
    logEl.textContent += text;
    logEl.classList.add('visible');
  }

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusDot.className = 'status-dot' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      // If session expired, redirect to login
      if (res.status === 401) {
        window.location.href = '/auth/login';
        return new Promise(function () {}); // never resolves
      }
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function refreshStatus() {
    setStatus('Loading...', null);
    return httpJson('/setup/api/status').then(function (j) {
      var ver = j.openclawVersion ? (' v' + j.openclawVersion) : '';
      if (j.configured) {
        setStatus('Configured' + ver + ' - ready to use', true);
      } else {
        setStatus('Not configured' + ver + ' - fill in the form below', false);
      }

      if (configReloadEl && configTextEl) {
        loadConfigRaw();
      }
    }).catch(function (e) {
      setStatus('Error: ' + String(e), false);
    });
  }

  // Run setup
  document.getElementById('run').onclick = function () {
    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      model: modelEl.value,
      telegramToken: document.getElementById('telegramToken').value,
      discordToken: document.getElementById('discordToken').value,
      slackBotToken: document.getElementById('slackBotToken').value,
      slackAppToken: document.getElementById('slackAppToken').value
    };

    showLog('Running setup...\n');

    fetch('/setup/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.status === 401) { window.location.href = '/auth/login'; return new Promise(function () {}); }
      return res.text();
    }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
      appendLog(j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      appendLog('\nError: ' + String(e) + '\n');
    });
  };

  // Reset
  document.getElementById('reset').onclick = function () {
    if (!confirm('Reset setup? This deletes the config file so onboarding can run again.')) return;
    showLog('Resetting...\n');
    fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { if (res.status === 401) { window.location.href = '/auth/login'; return new Promise(function () {}); } return res.text(); })
      .then(function (t) { appendLog(t + '\n'); return refreshStatus(); })
      .catch(function (e) { appendLog('Error: ' + String(e) + '\n'); });
  };

  // Debug console
  function runConsole() {
    if (!consoleCmdEl || !consoleRunEl) return;
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';
    if (consoleOutEl) { consoleOutEl.textContent = 'Running ' + cmd + '...\n'; consoleOutEl.classList.add('visible'); }

    return httpJson('/setup/api/console/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: arg })
    }).then(function (j) {
      if (consoleOutEl) consoleOutEl.textContent = (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      if (consoleOutEl) consoleOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (consoleRunEl) {
    consoleRunEl.onclick = runConsole;
  }

  // Config editor
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.textContent = '';
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = 'File: ' + (j.path || '(unknown)') + (j.exists ? '' : ' (not yet created)');
      }
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) { configOutEl.textContent = 'Error: ' + String(e); configOutEl.classList.add('visible'); }
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway?')) return;
    if (configOutEl) { configOutEl.textContent = 'Saving...\n'; configOutEl.classList.add('visible'); }
    return httpJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function (j) {
      if (configOutEl) configOutEl.textContent = 'Saved. Gateway restarted.\n';
      return refreshStatus();
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // Import
  function runImport() {
    if (!importRunEl || !importFileEl) return;
    var f = importFileEl.files && importFileEl.files[0];
    if (!f) { alert('Pick a .tar.gz file first'); return; }
    if (!confirm('Import backup? This overwrites files and restarts the gateway.')) return;

    if (importOutEl) { importOutEl.textContent = 'Uploading...\n'; importOutEl.classList.add('visible'); }

    return f.arrayBuffer().then(function (buf) {
      return fetch('/setup/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/gzip' },
        body: buf
      });
    }).then(function (res) {
      return res.text().then(function (t) {
        if (importOutEl) importOutEl.textContent += t + '\n';
        return refreshStatus();
      });
    }).catch(function (e) {
      if (importOutEl) importOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (importRunEl) importRunEl.onclick = runImport;

  // Pairing
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var channel = prompt('Channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord') {
        alert('Must be "telegram" or "discord"');
        return;
      }
      var code = prompt('Pairing code:');
      if (!code) return;
      showLog('Approving pairing for ' + channel + '...\n');
      fetch('/setup/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) { appendLog(t + '\n'); })
        .catch(function (e) { appendLog('Error: ' + String(e) + '\n'); });
    };
  }

  refreshStatus();
})();
