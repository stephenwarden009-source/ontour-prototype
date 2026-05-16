#!/usr/bin/env python3
"""
Patches index.html.PROPOSED to produce index.html:
  1. Strips live TM API key from client code
  2. Appends push infrastructure script block before </body>

Run from the repo root:
  python3 patch_html.py
"""

import sys

SRC  = 'index.html.PROPOSED'
DEST = 'index.html'

# ── 1. Read source ────────────────────────────────────────────────────────────
with open(SRC, 'r', encoding='utf-8') as f:
    html = f.read()

# ── 2. Remove live TM key ─────────────────────────────────────────────────────
OLD_KEY = "const TICKETMASTER_API_KEY = '8JMzyTOgftXrOfZFXzhfguKKfQS1DtHx';"
NEW_KEY = "const TICKETMASTER_API_KEY = ''; // key moved to Cloudflare Worker secret"

if OLD_KEY not in html:
    print("WARNING: TM API key string not found — check source file. Proceeding anyway.")
else:
    html = html.replace(OLD_KEY, NEW_KEY, 1)
    print("✓ TM API key removed from client")

# ── 3. Push infrastructure script block ───────────────────────────────────────
#
# VAPID_PUBLIC_KEY and WORKER_BASE_URL must be filled in after:
#   • npx web-push generate-vapid-keys   (gives you the public key)
#   • wrangler deploy                    (gives you the worker URL)
#
PUSH_SCRIPT = """
<script>
/* ── onTour Push Infrastructure ── added by patch_html.py ── */

// Fill these in before deploying:
const VAPID_PUBLIC_KEY = 'BByRsvbFrIVXDWPyTbke7uQ5-2mXOpmj1i8S3BmFoFIz3pbaBSHnY-_SKrsMne49V_-xcPxLkhZvkbWoKXVHLIs';
const WORKER_BASE_URL  = (function() {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    return 'http://localhost:8787';
  return 'https://ontour-api.stephenwarden009.workers.dev';
})();

// Keyword → tourId map (mirrors Worker TOUR_MAP)
const KEYWORD_TO_TOUR_ID = {
  'Harry Styles': 'styles-2026',
  'Rush':         'rush-2026',
  'Bruno Mars':   'bruno-2026',
};

// Override fetchTicketmasterEvents to use Worker proxy instead of TM directly.
// Same signature + return type — callers are unaffected.
const _origFetchTM = typeof fetchTicketmasterEvents === 'function'
  ? fetchTicketmasterEvents : null;

window.fetchTicketmasterEvents = async function(keyword, opts = {}) {
  const tourId = KEYWORD_TO_TOUR_ID[keyword];
  if (!tourId) {
    if (_origFetchTM) return _origFetchTM(keyword, opts);
    return [];
  }
  const params = new URLSearchParams();
  if (opts.city) params.set('city', opts.city);
  if (opts.size) params.set('size', String(opts.size));
  try {
    const resp = await fetch(`${WORKER_BASE_URL}/api/tm/${tourId}?${params}`);
    if (!resp.ok) throw new Error(`Worker ${resp.status}`);
    const data = await resp.json();
    return normalizeWorkerFeedResponse(data);
  } catch (err) {
    console.warn('[onTour] Worker proxy failed, trying direct TM:', err);
    if (_origFetchTM) return _origFetchTM(keyword, opts);
    return [];
  }
};

// Unwrap Worker envelope — returns raw TM event array (same format as direct TM call).
function normalizeWorkerFeedResponse(data) {
  return data?.events || [];
}

// Convert VAPID public key (base64url) → Uint8Array for pushManager.subscribe
function _vapidKeyToArray(b64u) {
  const pad = '='.repeat((4 - b64u.length % 4) % 4);
  const b64 = (b64u + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Core subscribe function — call with tourId array + intake field object.
// Requests notification permission, creates push subscription, POSTs to Worker.
async function subscribeToTourAlerts(followedTours, intakeData) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications are not supported in this browser.');
  }
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith('REPLACE')) {
    throw new Error('VAPID_PUBLIC_KEY not configured — deploy Worker first.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission denied.');
  }

  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: _vapidKeyToArray(VAPID_PUBLIC_KEY),
  });

  const resp = await fetch(`${WORKER_BASE_URL}/api/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription:   subscription.toJSON(),
      followed_tours: followedTours,
      consented_at:   new Date().toISOString(),
      ...intakeData,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Subscribe failed (${resp.status})`);
  }
  return resp.json();
}

// Attach to window so the alerts modal handler can call it
window.subscribeToTourAlerts = subscribeToTourAlerts;

// ── Alerts modal: copy updates + saveAlertOptIn override ─────────────────────
document.addEventListener('DOMContentLoaded', function() {

  // Hide phone field (SMS not active)
  const phoneInput = document.getElementById('alertPhone');
  if (phoneInput) {
    phoneInput.style.display = 'none';
    phoneInput.removeAttribute('required');
  }

  // Update label
  const label = document.querySelector('.alert-label');
  if (label && label.textContent.includes('text alerts')) {
    label.textContent = 'Browser notifications';
  }

  // Remove SMS consent language
  const consentSpan = document.querySelector('.alert-consent span');
  if (consentSpan) {
    consentSpan.innerHTML = consentSpan.innerHTML
      .replace(/Message\/data rates may apply[^<]*/gi, '')
      .replace(/Reply STOP to unsubscribe\./gi, '')
      .trim();
  }

  // Override saveAlertOptIn — the existing function handles validation + localStorage + modal close.
  // We wrap it: let it run, then if it succeeded (alerts_enabled flag set), run push subscription.
  const _origSaveAlertOptIn = window.saveAlertOptIn;
  window.saveAlertOptIn = async function() {
    // Clear any prior alerts_enabled so we can detect if original succeeds
    const wasEnabled = localStorage.getItem('alerts_enabled');
    localStorage.removeItem('alerts_enabled');

    // Run original (validates, saves localStorage, closes modal, shows toast)
    if (typeof _origSaveAlertOptIn === 'function') _origSaveAlertOptIn();

    // If original validation failed, alerts_enabled won't be set — bail out
    if (localStorage.getItem('alerts_enabled') !== '1') {
      if (wasEnabled) localStorage.setItem('alerts_enabled', wasEnabled); // restore
      return;
    }

    // Original succeeded — now run push subscription
    const followedTours = Object.values(KEYWORD_TO_TOUR_ID); // all tours for now
    const intakeData = {
      name:              localStorage.getItem('alert_name')          || null,
      home_city:         localStorage.getItem('alert_city')          || null,
      alert_scope:       localStorage.getItem('alert_scope')         || null,
      travel_markets:    localStorage.getItem('alert_travel_markets')|| null,
      travel_mode:       localStorage.getItem('alert_travel_mode')   || null,
      package_open:      localStorage.getItem('alert_package_open')  || null,
      trip_budget:       localStorage.getItem('alert_trip_budget')   || null,
    };

    try {
      await subscribeToTourAlerts(followedTours, intakeData);
    } catch (err) {
      console.error('[onTour] Push subscription failed:', err);
      // Non-fatal — user still opted in, alerts_enabled is set
      // Show a note that push failed
      if (typeof showToast === 'function') {
        showToast('Alerts saved', 'Note: browser notification permission was not granted.');
      }
    }
  };

});
</script>
"""

if '</body>' not in html:
    print("ERROR: </body> not found in HTML. Cannot inject script. Aborting.")
    sys.exit(1)

html = html.replace('</body>', PUSH_SCRIPT + '</body>', 1)
print("✓ Push infrastructure script injected before </body>")

# ── 4. Write output ───────────────────────────────────────────────────────────
with open(DEST, 'w', encoding='utf-8') as f:
    f.write(html)

print(f"✓ Written to {DEST}")
print()
print("Next steps before this file is ready to deploy:")
print("  1. Fill in VAPID_PUBLIC_KEY (from: npx web-push generate-vapid-keys)")
print("  2. Fill in WORKER_BASE_URL  (from: wrangler deploy output)")
