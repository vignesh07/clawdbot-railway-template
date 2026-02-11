// Served at /setup/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  var statusEl = document.getElementById('status');
  var statusDetailsEl = document.getElementById('statusDetails');
  var authGroupEl = document.getElementById('authGroup');
  var authChoiceEl = document.getElementById('authChoice');
  var logEl = document.getElementById('log');

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

  function setStatus(s) {
    statusEl.textContent = s;
  }

  function isInteractiveOAuth(optionValue, optionLabel) {
    var v = String(optionValue || '');
    var l = String(optionLabel || '');
    return l.indexOf('OAuth') !== -1 || v.indexOf('cli') !== -1 || v.indexOf('codex') !== -1 || v.indexOf('portal') !== -1;
  }

  function renderAuth(groups) {
    authGroupEl.innerHTML = '';

    // Toggle for showing interactive OAuth choices.
    var advancedToggle = document.getElementById('showAdvancedAuth');
    if (!advancedToggle) {
      advancedToggle = document.createElement('label');
      advancedToggle.style.display = 'block';
      advancedToggle.style.marginTop = '0.5rem';
      advancedToggle.innerHTML = '<input type="checkbox" id="showAdvancedAuth" /> Show interactive OAuth options (advanced)';
      authGroupEl.parentNode.insertBefore(advancedToggle, authChoiceEl.parentNode);
    }

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var opt = document.createElement('option');
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? ' - ' + g.hint : '');
      authGroupEl.appendChild(opt);
    }

    function rerenderChoices() {
      var sel = null;
      for (var j = 0; j < groups.length; j++) {
        if (groups[j].value === authGroupEl.value) sel = groups[j];
      }
      authChoiceEl.innerHTML = '';
      var opts = (sel && sel.options) ? sel.options : [];
      var showAdv = Boolean(document.getElementById('showAdvancedAuth') && document.getElementById('showAdvancedAuth').checked);

      var firstNonInteractive = null;
      for (var k = 0; k < opts.length; k++) {
        var o = opts[k];
        var interactive = isInteractiveOAuth(o.value, o.label);
        if (interactive && !showAdv) continue;
        if (!interactive && !firstNonInteractive) firstNonInteractive = o.value;

        var opt2 = document.createElement('option');
        opt2.value = o.value;
        opt2.textContent = o.label + (interactive ? ' (interactive OAuth)' : '');
        authChoiceEl.appendChild(opt2);
      }

      // Prefer selecting a non-interactive option by default.
      if (firstNonInteractive) authChoiceEl.value = firstNonInteractive;
    }

    authGroupEl.onchange = rerenderChoices;
    var advEl = document.getElementById('showAdvancedAuth');
    if (advEl) advEl.onchange = rerenderChoices;

    rerenderChoices();
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function refreshStatus() {
    setStatus('Loading...');
    if (statusDetailsEl) statusDetailsEl.textContent = '';

    return httpJson('/setup/api/status').then(function (j) {
      var ver = j.openclawVersion ? (' | ' + j.openclawVersion) : '';
      setStatus((j.configured ? 'Configured' : 'Not configured - run setup below') + ver);

      if (statusDetailsEl) {
        var parts = [];
        parts.push('Gateway target: ' + (j.gatewayTarget || '(unknown)'));
        parts.push('Tip: /healthz shows wrapper+gateway reachability.');
        statusDetailsEl.textContent = parts.join('\n');
      }

      renderAuth(j.authGroups || []);

      // If channels are unsupported, surface it for debugging.
      if (j.channelsAddHelp && j.channelsAddHelp.indexOf('telegram') === -1) {
        logEl.textContent += '\nNote: this openclaw build does not list telegram in `channels add --help`. Telegram auto-add will be skipped.\n';
      }

      // Attempt to load config editor content if present.
      if (configReloadEl && configTextEl) {
        loadConfigRaw();
      }

    }).catch(function (e) {
      setStatus('Error: ' + String(e));
      if (statusDetailsEl) statusDetailsEl.textContent = '';
    });
  }

  document.getElementById('run').onclick = function () {
    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      telegramToken: document.getElementById('telegramToken').value,
      discordToken: document.getElementById('discordToken').value,
      slackBotToken: document.getElementById('slackBotToken').value,
      slackAppToken: document.getElementById('slackAppToken').value,

      customProviderId: document.getElementById('customProviderId').value,
      customProviderBaseUrl: document.getElementById('customProviderBaseUrl').value,
      customProviderApi: document.getElementById('customProviderApi').value,
      customProviderApiKeyEnv: document.getElementById('customProviderApiKeyEnv').value,
      customProviderModelId: document.getElementById('customProviderModelId').value
    };

    logEl.textContent = 'Running...\n';

    fetch('/setup/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
      logEl.textContent += (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      logEl.textContent += '\nError: ' + String(e) + '\n';
    });
  };

  // Debug console runner
  function runConsole() {
    if (!consoleCmdEl || !consoleRunEl) return;
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';
    if (consoleOutEl) consoleOutEl.textContent = 'Running ' + cmd + '...\n';

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

  // Config raw load/save
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.textContent = '';
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = 'Config file: ' + (j.path || '(unknown)') + (j.exists ? '' : ' (does not exist yet)');
      }
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent = 'Error loading config: ' + String(e);
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway? A timestamped .bak backup will be created.')) return;
    if (configOutEl) configOutEl.textContent = 'Saving...\n';
    return httpJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function (j) {
      if (configOutEl) configOutEl.textContent = 'Saved: ' + (j.path || '') + '\nGateway restarted.\n';
      return refreshStatus();
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // Import backup
  function runImport() {
    if (!importRunEl || !importFileEl) return;
    var f = importFileEl.files && importFileEl.files[0];
    if (!f) {
      alert('Pick a .tar.gz file first');
      return;
    }
    if (!confirm('Import backup? This overwrites files under /data and restarts the gateway.')) return;

    if (importOutEl) importOutEl.textContent = 'Uploading ' + f.name + ' (' + f.size + ' bytes)...\n';

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
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + t);
        return refreshStatus();
      });
    }).catch(function (e) {
      if (importOutEl) importOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (importRunEl) importRunEl.onclick = runImport;

  // Pairing approve helper
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var channel = prompt('Enter channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord') {
        alert('Channel must be "telegram" or "discord"');
        return;
      }
      var code = prompt('Enter pairing code (e.g. 3EY4PUYS):');
      if (!code) return;
      logEl.textContent += '\nApproving pairing for ' + channel + '...\n';
      fetch('/setup/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) { logEl.textContent += t + '\n'; })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  // Device pairing helper
  var devicesRefreshBtn = document.getElementById('devicesRefresh');
  var devicesListEl = document.getElementById('devicesList');

  function approveDevice(requestId) {
    if (!requestId) return;
    if (!confirm('Approve device request ' + requestId + '?')) return;
    if (devicesListEl) devicesListEl.textContent = 'Approving ' + requestId + '...';

    return httpJson('/setup/api/devices/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requestId })
    }).then(function (j) {
      if (devicesListEl) devicesListEl.textContent = j.output || 'Approved.';
      return refreshStatus();
    }).catch(function (e) {
      if (devicesListEl) devicesListEl.textContent = 'Error: ' + String(e);
    });
  }

  function refreshDevices() {
    if (!devicesListEl) return;
    devicesListEl.textContent = 'Loading pending devices...';
    return httpJson('/setup/api/devices/pending').then(function (j) {
      var ids = j.requestIds || [];
      if (!ids.length) {
        devicesListEl.textContent = 'No pending device requests found.';
        return;
      }
      devicesListEl.innerHTML = '';
      for (var i = 0; i < ids.length; i++) {
        (function (id) {
          var row = document.createElement('div');
          row.style.marginTop = '0.25rem';
          var btn = document.createElement('button');
          btn.textContent = 'Approve ' + id;
          btn.style.background = '#111';
          btn.style.marginRight = '0.5rem';
          btn.onclick = function () { approveDevice(id); };
          var code = document.createElement('code');
          code.textContent = id;
          row.appendChild(btn);
          row.appendChild(code);
          devicesListEl.appendChild(row);
        })(ids[i]);
      }
    }).catch(function (e) {
      devicesListEl.textContent = 'Error: ' + String(e);
    });
  }

  if (devicesRefreshBtn) {
    devicesRefreshBtn.onclick = refreshDevices;
  }

  document.getElementById('reset').onclick = function () {
    if (!confirm('Reset setup? This deletes the config file so onboarding can run again.')) return;
    logEl.textContent = 'Resetting...\n';
    fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (t) { logEl.textContent += t + '\n'; return refreshStatus(); })
      .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
  };

  refreshStatus();
})();
