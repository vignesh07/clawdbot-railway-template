// OpenClaw Setup - Client-side logic
// Served at /setup/app.js

(function () {
  'use strict';

  // ======== Toast System ========
  var toastContainer = document.getElementById('toastContainer');
  var TOAST_ICONS = {
    success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  function toast(message, type) {
    type = type || 'info';
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.innerHTML = (TOAST_ICONS[type] || '') + '<span>' + escapeHtml(message) + '</span>';
    toastContainer.appendChild(el);
    setTimeout(function () {
      el.classList.add('removing');
      setTimeout(function () { el.remove(); }, 250);
    }, 4000);
  }

  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ======== Tab Navigation ========
  var tabs = document.querySelectorAll('.tab');
  var panels = document.querySelectorAll('.tab-panel');
  var TAB_NAMES = ['setup', 'channels', 'tools'];

  function switchTab(name) {
    tabs.forEach(function (t) {
      var isActive = t.getAttribute('data-tab') === name;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      t.setAttribute('tabindex', isActive ? '0' : '-1');
    });
    panels.forEach(function (p) {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      switchTab(t.getAttribute('data-tab'));
    });
  });

  // Keyboard shortcuts: 1/2/3 for tabs, arrow keys within tab bar
  document.addEventListener('keydown', function (e) {
    // Don't capture if user is typing in an input/textarea/select
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.key === '1') switchTab('setup');
    else if (e.key === '2') switchTab('channels');
    else if (e.key === '3') switchTab('tools');

    // Arrow key navigation within tabs
    if (e.target.classList && e.target.classList.contains('tab')) {
      var idx = TAB_NAMES.indexOf(e.target.getAttribute('data-tab'));
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        var next = TAB_NAMES[(idx + 1) % TAB_NAMES.length];
        switchTab(next);
        document.querySelector('[data-tab="' + next + '"]').focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        var prev = TAB_NAMES[(idx - 1 + TAB_NAMES.length) % TAB_NAMES.length];
        switchTab(prev);
        document.querySelector('[data-tab="' + prev + '"]').focus();
      }
    }
  });

  // ======== Channel Accordion ========
  var channelCards = document.querySelectorAll('.channel-card');
  channelCards.forEach(function (card) {
    var header = card.querySelector('.channel-header');
    if (!header) return;
    header.addEventListener('click', function () {
      var wasOpen = card.classList.contains('open');
      card.classList.toggle('open');
      header.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
    });
  });

  // Track channel token inputs for "Connected" badges
  function updateChannelBadges() {
    var tg = document.getElementById('telegramToken');
    var dc = document.getElementById('discordToken');
    var sb = document.getElementById('slackBotToken');
    if (tg) document.getElementById('channelTelegram').classList.toggle('has-token', !!tg.value.trim());
    if (dc) document.getElementById('channelDiscord').classList.toggle('has-token', !!dc.value.trim());
    if (sb) document.getElementById('channelSlack').classList.toggle('has-token', !!sb.value.trim());
  }
  ['telegramToken', 'discordToken', 'slackBotToken', 'slackAppToken'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', updateChannelBadges);
  });

  // ======== Element refs ========
  var statusEl = document.getElementById('status');
  var statusDot = document.getElementById('statusDot');
  var statusVersion = document.getElementById('statusVersion');
  var logEl = document.getElementById('log');

  var authChoiceEl = document.getElementById('authChoice');
  var modelEl = document.getElementById('model');
  var modelFieldEl = document.getElementById('modelField');
  var modelHintEl = document.getElementById('modelHint');

  var consoleCmdEl = document.getElementById('consoleCmd');
  var consoleArgEl = document.getElementById('consoleArg');
  var consoleRunEl = document.getElementById('consoleRun');
  var consoleOutEl = document.getElementById('consoleOut');

  var configPathEl = document.getElementById('configPath');
  var configTextEl = document.getElementById('configText');
  var configReloadEl = document.getElementById('configReload');
  var configSaveEl = document.getElementById('configSave');
  var configOutEl = document.getElementById('configOut');

  var importFileEl = document.getElementById('importFile');
  var importRunEl = document.getElementById('importRun');
  var importOutEl = document.getElementById('importOut');

  var preflightBoxEl = document.getElementById('preflightBox');
  var preflightListEl = document.getElementById('preflightList');
  var preflightRunEl = document.getElementById('preflightRun');

  var stageEls = {
    validate: document.getElementById('stage-validate'),
    configure: document.getElementById('stage-configure'),
    deploy: document.getElementById('stage-deploy'),
    verify: document.getElementById('stage-verify')
  };

  // ======== Model field visibility ========
  var providersWithModel = {
    'openrouter-api-key': { placeholder: 'anthropic/claude-sonnet-4', hint: 'OpenRouter: <code>provider/model-name</code>' },
    'openai-api-key': { placeholder: 'gpt-4o', hint: 'e.g. gpt-4o, gpt-4o-mini, o1-preview' },
    'gemini-api-key': { placeholder: 'gemini-2.5-pro', hint: 'e.g. gemini-2.5-pro, gemini-2.5-flash' },
    'ai-gateway-api-key': { placeholder: 'anthropic/claude-sonnet-4', hint: 'provider/model format via Vercel AI Gateway' },
    'apiKey': { placeholder: 'claude-sonnet-4-20250514', hint: 'e.g. claude-sonnet-4-20250514, claude-opus-4-20250514' }
  };

  function updateModelVisibility() {
    var choice = authChoiceEl.value;
    var cfg = providersWithModel[choice];
    if (cfg) {
      modelFieldEl.style.display = '';
      modelEl.placeholder = cfg.placeholder;
      modelHintEl.innerHTML = cfg.hint;
    } else {
      modelFieldEl.style.display = 'none';
    }
  }

  authChoiceEl.addEventListener('change', updateModelVisibility);
  updateModelVisibility();

  // ======== Helpers ========
  function showLog(text) {
    logEl.textContent = text;
    logEl.classList.add('visible');
  }

  function appendLog(text) {
    logEl.textContent += text;
    logEl.classList.add('visible');
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(text, state) {
    statusEl.textContent = text;
    statusDot.className = 'status-dot';
    if (state === 'ok') statusDot.classList.add('ok');
    else if (state === 'err') statusDot.classList.add('err');
    else if (state === 'loading') statusDot.classList.add('loading');
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('loading', loading);
    btn.disabled = loading;
  }

  function normalizeApiError(status, body, fallbackMessage) {
    var err = (body && body.error) || null;
    if (err && typeof err === 'object') {
      return {
        status: status,
        code: err.code || 'UNKNOWN',
        message: err.message || fallbackMessage || 'Request failed',
        action: err.action || '',
        details: err.details || null
      };
    }
    return {
      status: status,
      code: 'HTTP_' + status,
      message: fallbackMessage || 'HTTP ' + status,
      action: '',
      details: body || null
    };
  }

  function formatApiError(err) {
    if (!err) return 'Unknown error';
    var msg = err.message || String(err);
    if (err.action) msg += ' Next: ' + err.action;
    return msg;
  }

  function requestJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/auth/login';
        return new Promise(function () {});
      }
      return res.text().then(function (text) {
        var parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_e) {}
        if (!res.ok) throw normalizeApiError(res.status, parsed || text, 'Request failed');
        return parsed || {};
      });
    });
  }

  function requestText(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/auth/login';
        return new Promise(function () {});
      }
      return res.text().then(function (text) {
        if (!res.ok) {
          var parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch (_e) {}
          throw normalizeApiError(res.status, parsed || text, text || 'Request failed');
        }
        return text;
      });
    });
  }


  function setStage(stage, state) {
    var order = ['validate', 'configure', 'deploy', 'verify'];
    order.forEach(function (name) {
      var el = stageEls[name];
      if (!el) return;
      el.classList.remove('current', 'done', 'error');
      if (state === 'error' && name === stage) {
        el.classList.add('error');
        return;
      }
      if (order.indexOf(name) < order.indexOf(stage)) el.classList.add('done');
      else if (name === stage) el.classList.add('current');
    });
  }

  function renderPreflight(j) {
    if (!preflightBoxEl || !preflightListEl) return;
    preflightListEl.innerHTML = '';
    var items = [];
    (j.errors || []).forEach(function (e) { items.push({ cls: 'err', text: e.message + ' Next: ' + (e.action || '') }); });
    (j.warnings || []).forEach(function (w) { items.push({ cls: 'warn', text: w.message + ' Next: ' + (w.action || '') }); });
    if (!items.length) items.push({ cls: '', text: 'All checks passed. You can deploy configuration.' });
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = it.cls;
      li.textContent = it.text;
      preflightListEl.appendChild(li);
    });
    preflightBoxEl.classList.add('visible');
  }

  function buildPayload() {
    return {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      model: modelEl.value,
      telegramToken: document.getElementById('telegramToken').value,
      discordToken: document.getElementById('discordToken').value,
      slackBotToken: document.getElementById('slackBotToken').value,
      slackAppToken: document.getElementById('slackAppToken').value
    };
  }

  function runPreflight(payload, quiet) {
    return requestJson('/setup/api/preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || buildPayload())
    }).then(function (j) {
      renderPreflight(j);
      if (!quiet) {
        if (j.ok) toast('Preflight passed', 'success');
        else toast('Preflight found blocking issues', 'error');
      }
      return j;
    }).catch(function (e) {
      if (!quiet) toast('Preflight failed: ' + String(e), 'error');
      throw e;
    });
  }

  // ======== Status ========
  function refreshStatus() {
    setStatus('Checking...', 'loading');
    return requestJson('/setup/api/status').then(function (j) {
      var ver = j.openclawVersion ? j.openclawVersion : '';
      if (statusVersion) statusVersion.textContent = ver ? 'v' + ver : '';
      if (j.configured) {
        setStatus('Instance running', 'ok');
      } else {
        setStatus('Not configured', 'err');
      }
      loadConfigRaw();
    }).catch(function (e) {
      setStatus('Connection error', 'err');
      if (statusVersion) statusVersion.textContent = '';
    });
  }

  // ======== Run setup ========
  var runBtn = document.getElementById('run');
  if (preflightRunEl) {
    preflightRunEl.addEventListener('click', function () {
      setStage('validate');
      setLoading(preflightRunEl, true);
      runPreflight(buildPayload(), false).finally(function () {
        setLoading(preflightRunEl, false);
      });
    });
  }

  runBtn.addEventListener('click', function () {
    var payload = buildPayload();
    setLoading(runBtn, true);
    if (preflightRunEl) setLoading(preflightRunEl, true);

    setStage('validate');
    showLog('[validate] Running preflight checks...\n');

    runPreflight(payload, true).then(function (pf) {
      if (!pf.ok) {
        setStage('validate', 'error');
        throw new Error('Preflight failed. Resolve highlighted issues and try again.');
      }

      setStage('configure');
      showLog('[configure] Inputs validated. Preparing setup payload...\n');
      setStage('deploy');
      appendLog('[deploy] Running OpenClaw onboarding...\n');

      return requestJson('/setup/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }).then(function (j) {
      if (!j) return;
      appendLog(j.output || JSON.stringify(j, null, 2));

      setStage('verify');
      return refreshStatus().then(function () {
        toast('Configuration deployed successfully', 'success');
        appendLog('\n[verify] Setup complete. Next: open / and /openclaw to confirm routing.\n');
      });
    }).catch(function (e) {
      var msg = formatApiError(e);
      appendLog('\nError: ' + msg + '\n');
      if (e && e.details && e.details.outputPreview) {
        appendLog('\n--- Output preview ---\n' + e.details.outputPreview + '\n');
      }
      if ((e && e.code === 'PRECONDITION_FAILED') || String(msg).toLowerCase().indexOf('preflight') >= 0) {
        setStage('validate', 'error');
        toast('Fix validation issues, then retry deployment.', 'error');
      } else {
        setStage('deploy', 'error');
        toast(msg, 'error');
      }
    }).finally(function () {
      setLoading(runBtn, false);
      if (preflightRunEl) setLoading(preflightRunEl, false);
    });
  });

  // ======== Reset ========
  document.getElementById('reset').addEventListener('click', function () {
    if (!confirm('Reset configuration? This deletes the config file so setup can run again.')) return;
    showLog('Resetting...\n');
    requestText('/setup/api/reset', { method: 'POST' })
      .then(function (t) {
        appendLog(t + '\n');
        toast('Configuration reset', 'info');
        return refreshStatus();
      })
      .catch(function (e) {
        appendLog('Error: ' + String(e) + '\n');
        toast('Reset failed', 'error');
      });
  });

  // ======== Debug Console ========
  function runConsole() {
    if (!consoleCmdEl || !consoleRunEl) return;
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';

    setLoading(consoleRunEl, true);
    if (consoleOutEl) { consoleOutEl.textContent = 'Running ' + cmd + '...\n'; consoleOutEl.classList.add('visible'); }

    return requestJson('/setup/api/console/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: arg })
    }).then(function (j) {
      if (consoleOutEl) consoleOutEl.textContent = (j.output || JSON.stringify(j, null, 2));
      toast('Command completed', 'success');
      return refreshStatus();
    }).catch(function (e) {
      if (consoleOutEl) consoleOutEl.textContent += '\nError: ' + String(e) + '\n';
      toast('Command failed', 'error');
    }).finally(function () {
      setLoading(consoleRunEl, false);
    });
  }

  if (consoleRunEl) consoleRunEl.addEventListener('click', runConsole);

  // ======== Config Editor ========
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.textContent = '';
    return requestJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = (j.path || 'Config file') + (j.exists ? '' : ' (not yet created)');
      }
      configTextEl.value = j.content || '';
    }).catch(function () {
      // Silent -- config may not exist yet
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway?')) return;

    setLoading(configSaveEl, true);
    if (configOutEl) { configOutEl.textContent = 'Saving...\n'; configOutEl.classList.add('visible'); }

    return requestJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function () {
      if (configOutEl) configOutEl.textContent = 'Saved. Gateway restarting...\n';
      toast('Configuration saved', 'success');
      return refreshStatus();
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
      toast('Save failed: ' + String(e), 'error');
    }).finally(function () {
      setLoading(configSaveEl, false);
    });
  }

  if (configReloadEl) configReloadEl.addEventListener('click', function () {
    loadConfigRaw().then(function () { toast('Config reloaded', 'info'); });
  });
  if (configSaveEl) configSaveEl.addEventListener('click', saveConfigRaw);

  // ======== Import ========
  function runImport() {
    if (!importRunEl || !importFileEl) return;
    var f = importFileEl.files && importFileEl.files[0];
    if (!f) { toast('Pick a .tar.gz file first', 'error'); return; }
    if (!confirm('Import backup? This overwrites files and restarts the gateway.')) return;

    setLoading(importRunEl, true);
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
        toast('Backup imported successfully', 'success');
        return refreshStatus();
      });
    }).catch(function (e) {
      if (importOutEl) importOutEl.textContent += '\nError: ' + String(e) + '\n';
      toast('Import failed', 'error');
    }).finally(function () {
      setLoading(importRunEl, false);
    });
  }

  if (importRunEl) importRunEl.addEventListener('click', runImport);

  // ======== Pairing ========
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.addEventListener('click', function () {
      var channel = prompt('Channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord') {
        toast('Must be "telegram" or "discord"', 'error');
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
        .then(function (t) {
          appendLog(t + '\n');
          toast('Pairing approved', 'success');
        })
        .catch(function (e) {
          appendLog('Error: ' + String(e) + '\n');
          toast('Pairing failed', 'error');
        });
    });
  }

  // ======== Config textarea: Tab key inserts tab instead of moving focus ========
  if (configTextEl) {
    configTextEl.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var start = this.selectionStart;
        var end = this.selectionEnd;
        this.value = this.value.substring(0, start) + '  ' + this.value.substring(end);
        this.selectionStart = this.selectionEnd = start + 2;
      }
      // Ctrl+S / Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveConfigRaw();
      }
    });
  }

  // ======== Init ========
  setStage('validate');
  runPreflight(buildPayload(), true).catch(function () {});
  refreshStatus();
})();
