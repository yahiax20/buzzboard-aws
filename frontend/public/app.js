(function () {
  var REACTIONS_SVC_URL = window.REACTIONS_SVC_URL || '';
  var MOOD_SVC_URL = window.MOOD_SVC_URL || '';

  function getReactionsUrl() { return (REACTIONS_SVC_URL || '/api/reactions').replace(/\/$/, ''); }
  function getMoodUrl() { return (MOOD_SVC_URL || '/api/mood').replace(/\/$/, ''); }

  var TOKEN_KEY = 'ashour_chat_token';
  var USER_KEY = 'ashour_chat_user';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (_) { return null; }
  }
  function setAuth(token, user) {
    if (token && user) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); }
    else { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
  }
  function clearAuth() { setAuth(null, null); }

  function authHeaders() {
    var t = getToken();
    var h = { 'Content-Type': 'application/json' };
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  function parseJsonSafe(r) {
    return r.text().then(function (text) {
      try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
    });
  }

  function apiFetch(url, options) {
    options = options || {};
    options.headers = options.headers || authHeaders();
    return fetch(url, options)
      .then(function (r) { return parseJsonSafe(r).then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
      .catch(function (err) { return { ok: false, status: 0, data: { error: 'Network error. Check if the server is running.' }, networkError: err }; });
  }

  function showView(viewId) {
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); p.setAttribute('aria-hidden', 'true'); });
    document.querySelectorAll('.menu-btn').forEach(function (b) { b.classList.remove('active'); b.removeAttribute('aria-current'); });
    var panel = document.getElementById(viewId + '-panel');
    var btn = document.querySelector('.menu-btn[data-view="' + viewId + '"]');
    if (panel) {
      panel.classList.add('active');
      panel.setAttribute('aria-hidden', 'false');
    }
    if (btn) {
      btn.classList.add('active');
      btn.setAttribute('aria-current', 'page');
    }
  }

  function setLoggedIn(loggedIn, user) {
    var guestEl = document.getElementById('menu-guest');
    var userEl = document.getElementById('menu-user');
    var explainerEl = document.getElementById('auth-explainer');
    var badgeEl = document.getElementById('signed-in-badge');
    var usernameVal = user && user.username ? user.username : '';
    ['menu-username', 'menu-username-nav'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = usernameVal;
    });
    document.body.classList.remove('state-logged-in', 'state-logged-out');
    if (loggedIn && user) {
      document.body.classList.add('state-logged-in');
      if (guestEl) guestEl.style.display = 'none';
      if (explainerEl) explainerEl.style.display = 'none';
      if (userEl) userEl.style.display = 'flex';
      if (badgeEl) badgeEl.style.display = 'flex';
      showView('reactions');
      loadReactions();
    } else {
      document.body.classList.add('state-logged-out');
      if (guestEl) guestEl.style.display = 'flex';
      if (explainerEl) explainerEl.style.display = 'block';
      if (userEl) userEl.style.display = 'none';
      if (badgeEl) badgeEl.style.display = 'none';
      showView('signin');
    }
  }

  function refreshAuthState() {
    var user = getUser();
    var token = getToken();
    if (!token || !user) { setLoggedIn(false); return; }
    setLoggedIn(true, user);
  }

  function showStats(panelId, source, latencyMs) {
    var el = document.getElementById(panelId + '-stats');
    if (!el) return;
    el.textContent = 'Last load: ' + (latencyMs != null ? latencyMs + ' ms' : '—') + ' · Source: ' + (source || '—');
    el.className = 'stats ' + (source === 'Redis' ? 'redis' : 'mysql');
  }

  function showToast(containerId, message, durationMs, type) {
    durationMs = durationMs || 2500;
    type = type || 'success';
    var el = document.getElementById(containerId);
    if (!el) return;
    el.textContent = message;
    el.classList.remove('toast-success', 'toast-error');
    el.classList.add('toast-' + type, 'toast-visible');
    setTimeout(function () {
      el.classList.remove('toast-visible');
      el.textContent = '';
    }, durationMs);
  }

  function setButtonLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    btn.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (btn.hasAttribute('data-loading-text')) {
      btn.textContent = loading ? btn.getAttribute('data-loading-text') : (btn.getAttribute('data-default-text') || btn.textContent);
    }
  }

  function loadReactions() {
    var list = document.getElementById('reactions-list');
    if (!list) return;
    list.innerHTML = '<li class="loading-item"><span class="spinner"></span> Loading…</li>';
    apiFetch(getReactionsUrl() + '/reactions')
      .then(function (result) {
        if (!result.ok) {
          list.innerHTML = '<li class="empty-state">Could not load reactions. ' + (result.data && result.data.error ? result.data.error : 'Try again.') + '</li>';
          return;
        }
        var data = result.data;
        showStats('reactions', data.source, data.latencyMs != null ? data.latencyMs : null);
        list.innerHTML = '';
        (data.reactions || []).forEach(function (r) {
          var li = document.createElement('li');
          var who = r.username ? ('@' + r.username) : 'Anonymous';
          li.innerHTML = '<span class="reaction-message">' + escapeHtml(r.message || r.emoji || r.body || '') + '</span> <span class="reaction-meta">' + who + ' · ' + (r.created_at ? new Date(r.created_at).toLocaleString() : '') + '</span>';
          list.appendChild(li);
        });
        if (!(data.reactions && data.reactions.length)) list.innerHTML = '<li class="empty-state">No reactions yet. Post one — it will be saved with your name!</li>';
      })
      .catch(function () {
        list.innerHTML = '<li class="empty-state">Could not load reactions. Check backend and CORS.</li>';
      });
  }

  function loadMood() {
    var user = getUser();
    var moodUsernameEl = document.getElementById('mood-username');
    if (moodUsernameEl) moodUsernameEl.textContent = user && user.username ? user.username : '';
    var tallyEl = document.getElementById('mood-tally');
    var statsEl = document.getElementById('mood-stats');
    if (tallyEl) { tallyEl.innerHTML = '<span class="spinner"></span> Loading…'; tallyEl.classList.add('loading'); }
    if (!tallyEl) return;
    apiFetch(getMoodUrl() + '/mood')
      .then(function (result) {
        if (!result.ok) {
          tallyEl.classList.remove('loading');
          tallyEl.textContent = 'Could not load mood. ' + (result.data && result.data.error ? result.data.error : '');
          return;
        }
        var data = result.data;
        showStats('mood', data.source, data.latencyMs != null ? data.latencyMs : null);
        if (statsEl) {
          statsEl.textContent = 'Last load: ' + (data.latencyMs != null ? data.latencyMs : '—') + ' ms · Source: ' + (data.source || '—');
          statsEl.className = 'stats ' + (data.source === 'Redis' ? 'redis' : 'mysql');
        }
        var t = data.tally || data.votes || {};
        tallyEl.classList.remove('loading');
        tallyEl.innerHTML = '😴 ' + (t.sleepy || 0) + ' · 😐 ' + (t.neutral || 0) + ' · 🔥 ' + (t.fire || 0);
      })
      .catch(function () {
        if (tallyEl) { tallyEl.classList.remove('loading'); tallyEl.textContent = 'Could not load mood.'; }
      });
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function init() {
    refreshAuthState();

    document.querySelectorAll('.menu-btn[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var view = btn.getAttribute('data-view');
        if (view) showView(view);
        if (view === 'reactions') loadReactions();
        if (view === 'mood') loadMood();
      });
    });

    document.querySelectorAll('.link-btn[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var view = btn.getAttribute('data-view');
        if (view) showView(view);
      });
    });

    var btnLogout = document.getElementById('btn-logout');
    if (btnLogout) btnLogout.addEventListener('click', function () { clearAuth(); setLoggedIn(false); });

    var signinForm = document.getElementById('signin-form');
    if (signinForm) {
      signinForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var errEl = document.getElementById('signin-error');
        var submitBtn = signinForm.querySelector('button[type="submit"]');
        var username = (document.getElementById('signin-username') && document.getElementById('signin-username').value || '').trim();
        var password = document.getElementById('signin-password') ? document.getElementById('signin-password').value : '';
        if (errEl) errEl.textContent = '';
        if (!username || !password) { if (errEl) errEl.textContent = 'Username and password required.'; return; }
        if (!submitBtn.hasAttribute('data-default-text')) { submitBtn.setAttribute('data-default-text', submitBtn.textContent); submitBtn.setAttribute('data-loading-text', 'Signing in…'); }
        setButtonLoading(submitBtn, true);
        apiFetch(getReactionsUrl() + '/auth/signin', { method: 'POST', body: JSON.stringify({ username: username, password: password }) })
          .then(function (result) {
            setButtonLoading(submitBtn, false);
            if (result.ok) {
              setAuth(result.data.token, result.data.user);
              setLoggedIn(true, result.data.user);
            } else {
              if (errEl) errEl.textContent = (result.data && result.data.error) || 'Sign in failed.';
            }
          })
          .catch(function () {
            setButtonLoading(submitBtn, false);
            if (errEl) errEl.textContent = 'Network error. Check if the server is running.';
          });
      });
    }

    var signupForm = document.getElementById('signup-form');
    if (signupForm) {
      signupForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var errEl = document.getElementById('signup-error');
        var submitBtn = signupForm.querySelector('button[type="submit"]');
        var username = (document.getElementById('signup-username') && document.getElementById('signup-username').value || '').trim();
        var password = document.getElementById('signup-password') ? document.getElementById('signup-password').value : '';
        if (errEl) errEl.textContent = '';
        if (!username || !password) { if (errEl) errEl.textContent = 'Username and password required.'; return; }
        if (password.length < 6) { if (errEl) errEl.textContent = 'Password must be at least 6 characters.'; return; }
        if (!submitBtn.hasAttribute('data-default-text')) { submitBtn.setAttribute('data-default-text', submitBtn.textContent); submitBtn.setAttribute('data-loading-text', 'Creating account…'); }
        setButtonLoading(submitBtn, true);
        apiFetch(getReactionsUrl() + '/auth/signup', { method: 'POST', body: JSON.stringify({ username: username, password: password }) })
          .then(function (result) {
            setButtonLoading(submitBtn, false);
            if (result.ok) {
              setAuth(result.data.token, result.data.user);
              setLoggedIn(true, result.data.user);
            } else {
              if (errEl) errEl.textContent = (result.data && result.data.error) || 'Sign up failed.';
            }
          })
          .catch(function () {
            setButtonLoading(submitBtn, false);
            if (errEl) errEl.textContent = 'Network error. Check if the server is running.';
          });
      });
    }

    var reactionForm = document.getElementById('reaction-form');
    if (reactionForm) {
      reactionForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var msgEl = document.getElementById('reaction-message');
        var msg = msgEl ? msgEl.value.trim() : '';
        if (!msg) return;
        var submitBtn = reactionForm.querySelector('button[type="submit"]');
        if (submitBtn && !submitBtn.hasAttribute('data-default-text')) {
          submitBtn.setAttribute('data-default-text', submitBtn.textContent);
          submitBtn.setAttribute('data-loading-text', 'Posting…');
        }
        setButtonLoading(submitBtn, true);
        apiFetch(getReactionsUrl() + '/reactions', { method: 'POST', body: JSON.stringify({ message: msg }) })
          .then(function (result) {
            setButtonLoading(submitBtn, false);
            if (result.status === 401) {
              clearAuth();
              setLoggedIn(false);
              return;
            }
            if (!result.ok) {
              showToast('reaction-feedback', (result.data && result.data.error) || 'Could not post. Try again.', 3500, 'error');
              loadReactions();
              return;
            }
            if (msgEl) msgEl.value = '';
            showToast('reaction-feedback', 'Posted! Recorded with your name.');
            loadReactions();
          })
          .catch(function () {
            setButtonLoading(submitBtn, false);
            showToast('reaction-feedback', 'Network error. Try again.', 3500, 'error');
            loadReactions();
          });
      });
    }

    document.querySelectorAll('.emoji-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var emoji = btn.getAttribute('data-emoji');
        var msgEl = document.getElementById('reaction-message');
        if (msgEl) msgEl.value = emoji;
      });
    });

    document.querySelectorAll('.mood-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mood = btn.getAttribute('data-mood');
        if (!mood) return;
        var btns = document.querySelectorAll('.mood-btn');
        btns.forEach(function (b) { b.disabled = true; });
        apiFetch(getMoodUrl() + '/mood', { method: 'POST', body: JSON.stringify({ mood: mood }) })
          .then(function (result) {
            btns.forEach(function (b) { b.disabled = false; });
            if (result.status === 401) {
              clearAuth();
              setLoggedIn(false);
              return;
            }
            if (!result.ok) {
              showToast('mood-feedback', (result.data && result.data.error) || 'Could not save vote.', 3500, 'error');
              loadMood();
              return;
            }
            showToast('mood-feedback', 'Vote recorded with your account!');
            loadMood();
          })
          .catch(function () {
            btns.forEach(function (b) { b.disabled = false; });
            showToast('mood-feedback', 'Network error. Try again.', 3500, 'error');
            loadMood();
          });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
