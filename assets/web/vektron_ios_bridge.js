/**
 * Vektron Studio iOS & Web Unified Bridge (window.VektronBridge + window.Android)
 * - Replicates VektronSessionManager, VektronAuthGateway, VektronUiOverlay & AndroidBridge
 * - Manages Firebase Auth & Firestore 5-hour / weekly quota cycles
 * - Decrypts AES-256-GCM Master Vault & GitHub Cloud Node Pool strictly in volatile RAM
 * - Automatically wakes up GitHub Codespaces on demand and rotates across pool accounts
 */
(function () {
  'use strict';

  if (window.__VEKTRON_IOS_BRIDGE_INSTALLED__) return;
  window.__VEKTRON_IOS_BRIDGE_INSTALLED__ = true;

  var FIREBASE_API_KEY = "AIzaSyD_xQiHtL52CDG-3Vcz0DImFJQ5Ll7J95Q";
  var FIREBASE_PROJECT_ID = "vektron-studio-app";
  var FIRESTORE_BASE = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents";
  var VAULT_PASSPHRASE = "VK_STUDIO_CORE_VAULT_2026_9f4a8c21e7b3d605a1c8f924b7e0d36a";
  var ADMIN_EMAIL = "shadrick1212@gmail.com";

  var FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  var SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  var STORAGE_KEY = "vektron_studio_ios_session_v1";
  var DEVICE_KEY = "vektron_studio_ios_device_id";

  // Volatile RAM-only secrets (never written to localStorage)
  var ramActiveRefreshToken = "";
  var ramIosNodePool = [];
  var ramActiveTunnelUrl = "";
  var ramPrefsCache = null;
  var cachedHardwareId = "";
  var workspaceReadyInMemory = false;
  var bootSoundPlayed = false;
  var wakingNodeInProgress = false;
  var lastQuotaSyncMs = 0;

  // Check if session was passed via URL hash (#vk_session=...) into workspace iframe
  try {
    if (window.location.hash && window.location.hash.indexOf("vk_session=") !== -1) {
      var hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      var encodedSess = hashParams.get("vk_session");
      if (encodedSess) {
        var decodedJson = decodeURIComponent(escape(atob(encodedSess)));
        var parsedSess = JSON.parse(decodedJson);
        if (parsedSess && parsedSess.uid) {
          ramPrefsCache = parsedSess;
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsedSess)); } catch (_) {}
        }
        if (window.history && window.history.replaceState) {
          var cleanPath = window.location.pathname === "/workspace" ? "/" : window.location.pathname;
          window.history.replaceState(null, "", cleanPath + window.location.search);
        }
      }
    }
  } catch (e) {}

  function getPrefs() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        ramPrefsCache = parsed;
        return parsed;
      }
    } catch (e) {}
    return ramPrefsCache ? Object.assign({}, ramPrefsCache) : {};
  }

  function savePrefs(patch) {
    try {
      var cur = getPrefs();
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) {
          cur[k] = patch[k];
        }
      }
      // Never persist vaultCipher or raw refresh tokens
      delete cur.vaultCipher;
      delete cur.masterRefreshToken;
      ramPrefsCache = cur;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cur)); } catch (_) {}
      return cur;
    } catch (e) {
      return ramPrefsCache || {};
    }
  }

  function clearPrefs() {
    ramPrefsCache = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    ramActiveRefreshToken = "";
  }

  function fnv1aHex(str) {
    var h1 = 0x811c9dc5;
    var h2 = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= (c ^ (i & 0xff));
      h2 = Math.imul(h2, 0x01000193);
    }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  }

  function computeHardwareDeviceId() {
    if (cachedHardwareId) return cachedHardwareId;
    var parts = [];
    try {
      var sw = Math.min(window.screen.width || 0, window.screen.height || 0);
      var sh = Math.max(window.screen.width || 0, window.screen.height || 0);
      var dpr = Number(window.devicePixelRatio || 1).toFixed(2);
      parts.push(sw + "x" + sh + "@" + dpr + ":" + (window.screen.colorDepth || 24));
      parts.push(String(navigator.platform || ""));
      parts.push(String(navigator.hardwareConcurrency || 0));
      parts.push(String(navigator.maxTouchPoints || 0));
      parts.push(String(Intl.DateTimeFormat().resolvedOptions().timeZone || ""));
    } catch (_) {}
    try {
      var cv = document.createElement("canvas");
      var gl = cv.getContext("webgl") || cv.getContext("experimental-webgl");
      if (gl) {
        var dbg = gl.getExtension("WEBGL_debug_renderer_info");
        var vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        var renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        parts.push(String(vendor || "") + "|" + String(renderer || ""));
        parts.push(String(gl.getParameter(gl.MAX_TEXTURE_SIZE) || ""));
      }
    } catch (_) {}
    try {
      var c2 = document.createElement("canvas");
      c2.width = 120;
      c2.height = 30;
      var ctx = c2.getContext("2d");
      if (ctx) {
        ctx.textBaseline = "top";
        ctx.font = "14px Arial";
        ctx.fillStyle = "#f60";
        ctx.fillRect(10, 1, 62, 20);
        ctx.fillStyle = "#069";
        ctx.fillText("VektronHW#26", 2, 15);
        parts.push(fnv1aHex(c2.toDataURL()));
      }
    } catch (_) {}
    var hwHash = "web-hw-" + fnv1aHex(parts.join("||"));
    cachedHardwareId = hwHash;
    try { localStorage.setItem(DEVICE_KEY, hwHash); } catch (_) {}
    return hwHash;
  }

  function getHardwareDeviceId() {
    try {
      var p = ramPrefsCache;
      if (!p) {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) p = JSON.parse(raw);
      }
      if (p && p.boundDeviceId && p.boundDeviceId.indexOf("ios-vk-") === 0) {
        return p.boundDeviceId;
      }
      var existing = localStorage.getItem(DEVICE_KEY);
      if (existing && existing.indexOf("ios-vk-") === 0) {
        return existing;
      }
    } catch (_) {}
    return computeHardwareDeviceId();
  }

  async function decryptVaultCipher(cipherB64) {
    if (!cipherB64 || typeof cipherB64 !== "string") return null;
    try {
      var binary = atob(cipherB64.trim());
      var combined = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) combined[i] = binary.charCodeAt(i);
      if (combined.length <= 28) return null;
      var iv = combined.slice(0, 12);
      var cipherBytes = combined.slice(12);
      var keyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VAULT_PASSPHRASE));
      var cryptoKey = await crypto.subtle.importKey("raw", keyHash, { name: "AES-GCM" }, false, ["decrypt"]);
      var plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, cryptoKey, cipherBytes);
      return JSON.parse(new TextDecoder().decode(plainBuf));
    } catch (e) {
      return null;
    }
  }

  function getSnapshot() {
    var p = getPrefs();
    var uid = p.uid || "";
    var email = (p.email || "").trim().toLowerCase();
    var loggedIn = !!(uid && email);
    var status = p.status || "pending";
    var plan = p.plan || "none";
    var role = p.role || "client";
    var used = Number(p.usedCredits || 0);
    var max = Number(p.maxCredits || 0);
    var resetAt = Number(p.cycleResetAt || 0);
    var expiresAt = Number(p.expiresAt || 0);
    var boundDevice = p.boundDeviceId || "";
    var myDevice = getHardwareDeviceId();
    var isAdmin = loggedIn && (email === ADMIN_EMAIL || role === "admin");
    var emailVerified = isAdmin || status === "active" || !!p.emailVerified;
    var deviceMismatch = !isAdmin && !!boundDevice && boundDevice !== myDevice;

    var now = Date.now();
    var effectiveUsed = (resetAt > 0 && now >= resetAt) ? 0 : used;
    var rem = Math.max(0, max - effectiveUsed);
    var pct = isAdmin ? 100 : (max <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((rem * 100) / max))));
    var isExpired = expiresAt > 0 && now > expiresAt;
    var canRun = loggedIn && (isAdmin || (!deviceMismatch && !isExpired && status === "active" && pct > 0));

    function cycleResetLabelEs() {
      if (isAdmin) return "Cuota Ultra activa";
      if (resetAt <= now) return "Ciclo listo";
      var diffMin = Math.max(1, Math.floor((resetAt - now) / 60000));
      var h = Math.floor(diffMin / 60);
      var m = diffMin % 60;
      return "Reinicio en " + h + "h " + m + "m";
    }

    function statusLabelEs() {
      if (isAdmin) return "Acceso Maestro Ilimitado";
      if (deviceMismatch) return "Equipo no autorizado";
      if (isExpired) return "Licencia vencida";
      if (status === "active") return "Licencia activa";
      if (status === "suspended") return "Cuenta suspendida";
      return "Sin Membresía";
    }

    return {
      loggedIn: loggedIn,
      uid: uid,
      email: email,
      status: status,
      plan: plan,
      usedCredits: used,
      maxCredits: max,
      cycleResetAt: resetAt,
      expiresAt: expiresAt,
      deviceId: myDevice,
      deviceMismatch: deviceMismatch,
      isAdmin: isAdmin,
      emailVerified: emailVerified,
      securityCompromised: false,
      remainingPercent: pct,
      canRunAntigravity: canRun,
      cycleResetLabelEs: cycleResetLabelEs(),
      statusLabelEs: statusLabelEs()
    };
  }

  function buildLobbyStatePayload(s, authMessage, authOk) {
    var obj = {
      loggedIn: s.loggedIn,
      email: s.email || "",
      isAdmin: s.isAdmin,
      planCode: s.isAdmin ? "pro3x" : (s.plan || "none"),
      workspaceRunning: workspaceReadyInMemory
    };
    if (authMessage !== null && authMessage !== undefined) {
      obj.authError = authMessage;
      obj.authOk = !!authOk;
    }

    var badgeText = "SIN MEMBRESÍA";
    var badgeTextColor = "#94a3b8";
    var badgeBgColor = "rgba(30,41,59,0.7)";
    var canLaunch = s.canRunAntigravity;
    var blockedBtn = "DESBLOQUEAR ACCESO · VER PLANES";
    var pct = s.remainingPercent;
    var quotaSub = "";

    var now = Date.now();
    var isExpired = s.expiresAt > 0 && now > s.expiresAt;
    var isTrial = String(s.plan).toLowerCase() === "trial";

    if (s.isAdmin) {
      badgeText = "ULTRA X3";
      badgeTextColor = "#34d399";
      badgeBgColor = "rgba(6,95,70,0.35)";
      canLaunch = true;
      pct = 100;
      quotaSub = "Cuota Ultra activa  ·  Nodo Cloud iOS Activo";
    } else if (s.status === "suspended" || s.status === "banned") {
      badgeText = "SUSPENDIDA";
      badgeTextColor = "#f87171";
      badgeBgColor = "rgba(127,29,29,0.35)";
      blockedBtn = "CUENTA SUSPENDIDA · VER PLANES";
      quotaSub = "Cuenta pausada. Pulsa para contactar soporte en WhatsApp.";
    } else if (s.deviceMismatch) {
      badgeText = "OTRO EQUIPO";
      badgeTextColor = "#f87171";
      badgeBgColor = "rgba(127,29,29,0.35)";
      blockedBtn = "DISPOSITIVO VINCULADO A OTRO EQUIPO";
      quotaSub = "Esta cuenta está vinculada a otro hardware. Solicita desbloqueo.";
    } else if (s.status === "pending" || s.plan === "none" || s.status !== "active") {
      badgeText = "PLANES ULTRA";
      badgeTextColor = "#38bdf8";
      badgeBgColor = "rgba(37,99,235,0.28)";
      blockedBtn = "DESBLOQUEAR ACCESO · VER PLANES";
      quotaSub = "Activa un Plan Ultra o solicita tu prueba gratuita para desbloquear el motor.";
    } else if (isExpired) {
      badgeText = "RENOVAR PLAN";
      badgeTextColor = "#fbbf24";
      badgeBgColor = "rgba(120,53,15,0.35)";
      blockedBtn = "RENOVAR MEMBRESÍA · VER PLANES";
      quotaSub = "Tu ciclo de suscripción ha finalizado. Renueva tu Plan Ultra para continuar.";
    } else if (pct <= 0) {
      if (isTrial) {
        badgeText = "OBTENER PLAN";
        badgeTextColor = "#38bdf8";
        badgeBgColor = "rgba(37,99,235,0.28)";
        blockedBtn = "OBTENER PLAN ULTRA · VER PLANES";
        quotaSub = "Tu prueba gratuita ha finalizado. Adquiere un Plan Ultra para continuar.";
      } else {
        badgeText = "CICLO AGOTADO";
        badgeTextColor = "#fbbf24";
        badgeBgColor = "rgba(120,53,15,0.35)";
        blockedBtn = "CUOTA AGOTADA · " + s.cycleResetLabelEs.toUpperCase();
        quotaSub = "Has alcanzado el 100% de este ciclo. " + s.cycleResetLabelEs + " o amplía tu plan.";
      }
    } else {
      canLaunch = true;
      if (isTrial) badgeText = "PRUEBA ACTIVA";
      else if (s.plan === "pro3x") badgeText = "ULTRA X3";
      else if (s.plan === "pro2x" || s.plan === "plus") badgeText = "ULTRA X2";
      else badgeText = "ULTRA X1";
      badgeTextColor = "#34d399";
      badgeBgColor = "rgba(6,95,70,0.35)";
      var expStr = s.expiresAt > 0 ? new Date(s.expiresAt).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" }) : "Ilimitado";
      quotaSub = (isTrial ? "Modo Prueba activa" : s.cycleResetLabelEs) + "  ·  Vence: " + expStr;
    }

    obj.badgeText = badgeText;
    obj.badgeTextColor = badgeTextColor;
    obj.badgeBgColor = badgeBgColor;
    obj.canLaunchAntigravity = canLaunch;
    obj.blockedButtonText = blockedBtn;
    obj.pct = pct;
    obj.quotaSubtext = quotaSub;
    return obj;
  }

  function pushStateToWeb(authMessage, authOk) {
    try {
      var s = getSnapshot();
      var payload = buildLobbyStatePayload(s, authMessage, authOk);
      if (typeof window.updateFromAndroid === "function") {
        window.updateFromAndroid(payload);
      }
    } catch (e) {}
  }

  // Firestore helper functions
  function strField(fields, key, defVal) {
    if (!fields || !fields[key]) return defVal || "";
    return fields[key].stringValue !== undefined ? String(fields[key].stringValue) : (defVal || "");
  }
  function numField(fields, key, defVal) {
    if (!fields || !fields[key]) return defVal || 0;
    if (fields[key].integerValue !== undefined) return Number(fields[key].integerValue);
    if (fields[key].doubleValue !== undefined) return Number(fields[key].doubleValue);
    if (fields[key].timestampValue !== undefined) return new Date(fields[key].timestampValue).getTime();
    return defVal || 0;
  }
  function boolField(fields, key, defVal) {
    if (!fields || !fields[key]) return !!defVal;
    return fields[key].booleanValue !== undefined ? !!fields[key].booleanValue : !!defVal;
  }

  async function ensureValidIdToken() {
    var p = getPrefs();
    var idToken = p.idToken || "";
    var refreshToken = p.firebaseRefreshToken || "";
    var tokenObtainedAt = Number(p.tokenObtainedAt || 0);
    if (idToken && (Date.now() - tokenObtainedAt) < 45 * 60 * 1000) {
      return idToken;
    }
    if (!refreshToken) return idToken;
    try {
      var resp = await fetch("https://securetoken.googleapis.com/v1/token?key=" + FIREBASE_API_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refreshToken)
      });
      if (resp.ok) {
        var data = await resp.json();
        if (data.id_token) {
          savePrefs({
            idToken: data.id_token,
            firebaseRefreshToken: data.refresh_token || refreshToken,
            tokenObtainedAt: Date.now()
          });
          return data.id_token;
        }
      }
    } catch (e) {}
    return idToken;
  }

  async function syncWithFirestore() {
    var p = getPrefs();
    if (!p.uid) return getSnapshot();
    var idToken = await ensureValidIdToken();
    if (!idToken) return getSnapshot();

    try {
      var myDevice = getHardwareDeviceId();
      var userResp = await fetch(FIRESTORE_BASE + "/users/" + encodeURIComponent(p.uid), {
        headers: { "Authorization": "Bearer " + idToken }
      });

      if (userResp.status === 404) {
        var isAdm = (p.email || "").toLowerCase() === ADMIN_EMAIL;
        var createFields = {
          email: { stringValue: p.email },
          deviceId: { stringValue: myDevice },
          status: { stringValue: isAdm ? "active" : "pending" },
          plan: { stringValue: isAdm ? "pro3x" : "none" },
          quotaMultiplier: { integerValue: isAdm ? "3" : "0" },
          usedCreditsCycle: { integerValue: "0" },
          maxCreditsCycle: { integerValue: isAdm ? "1500" : "0" },
          cycleResetAt: { integerValue: "0" },
          expiresAt: { integerValue: isAdm ? "4102444800000" : "0" },
          trialUsed: { booleanValue: false },
          role: { stringValue: isAdm ? "admin" : "client" },
          createdAt: { integerValue: String(Date.now()) },
          lastSeenAt: { integerValue: String(Date.now()) }
        };
        await fetch(FIRESTORE_BASE + "/users?documentId=" + encodeURIComponent(p.uid), {
          method: "POST",
          headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: createFields })
        });
        userResp = await fetch(FIRESTORE_BASE + "/users/" + encodeURIComponent(p.uid), {
          headers: { "Authorization": "Bearer " + idToken }
        });
      }

      var assignedMasterId = "default";
      if (userResp.ok) {
        var userDoc = await userResp.json();
        var uf = userDoc.fields || {};
        var status = strField(uf, "status", "pending");
        var plan = strField(uf, "plan", "none");
        var role = strField(uf, "role", "client");
        var remoteUsed = numField(uf, "usedCreditsCycle", 0);
        var max = numField(uf, "maxCreditsCycle", 0);
        var resetAt = numField(uf, "cycleResetAt", 0);
        var expiresAt = numField(uf, "expiresAt", 0);
        var boundDevice = strField(uf, "deviceId", "");
        assignedMasterId = strField(uf, "masterAccountId", "default") || "default";

        if (!boundDevice) {
          boundDevice = myDevice;
          fetch(FIRESTORE_BASE + "/users/" + encodeURIComponent(p.uid) + "?updateMask.fieldPaths=deviceId&updateMask.fieldPaths=lastSeenAt", {
            method: "PATCH",
            headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
            body: JSON.stringify({
              fields: {
                deviceId: { stringValue: myDevice },
                lastSeenAt: { integerValue: String(Date.now()) }
              }
            })
          }).catch(function () {});
        }

        savePrefs({
          status: status,
          plan: plan,
          role: role,
          usedCredits: Math.max(Number(p.usedCredits || 0), remoteUsed),
          maxCredits: max,
          cycleResetAt: resetAt,
          expiresAt: expiresAt,
          boundDeviceId: boundDevice,
          masterAccountId: assignedMasterId
        });
      }

      // Fetch /system/vault and /system/public
      var selectedCipher = "";
      var poolJson = "";
      var iosNodePoolCipher = "";

      try {
        var vaultResp = await fetch(FIRESTORE_BASE + "/system/vault", {
          headers: { "Authorization": "Bearer " + idToken }
        });
        if (vaultResp.ok) {
          var vaultDoc = await vaultResp.json();
          var vf = vaultDoc.fields || {};
          selectedCipher = strField(vf, "vaultCipher", "");
          poolJson = strField(vf, "masterPoolJson", "");
          iosNodePoolCipher = strField(vf, "iosNodePoolCipher", "");
        }
      } catch (e) {}

      try {
        var pubResp = await fetch(FIRESTORE_BASE + "/system/public", {
          headers: { "Authorization": "Bearer " + idToken }
        });
        if (pubResp.ok) {
          var pubDoc = await pubResp.json();
          var pf = pubDoc.fields || {};
          if (!selectedCipher) selectedCipher = strField(pf, "vaultCipher", "");
          if (!poolJson) poolJson = strField(pf, "masterPoolJson", "");
          if (!iosNodePoolCipher) iosNodePoolCipher = strField(pf, "iosNodePoolCipher", "");
          var base1x = numField(pf, "baseCreditsUltra1x", 500);
          var costFlash = numField(pf, "costFlash", 5);
          var costPro = numField(pf, "costPro", 12);
          var costSonnet = numField(pf, "costSonnet", 18);
          var costOpus = numField(pf, "costOpus", 30);
          savePrefs({
            baseCreditsUltra1x: base1x >= 100 ? base1x : 500,
            costFlash: costFlash >= 1 ? costFlash : 5,
            costPro: costPro >= 1 ? costPro : 12,
            costSonnet: costSonnet >= 1 ? costSonnet : 18,
            costOpus: costOpus >= 1 ? costOpus : 30
          });
        }
      } catch (e) {}

      if (poolJson) {
        try {
          var arr = JSON.parse(poolJson);
          if (Array.isArray(arr) && arr.length > 0) {
            if (assignedMasterId !== "default") {
              for (var i = 0; i < arr.length; i++) {
                var slotCipher = arr[i].cipher || arr[i].vaultCipher || "";
                if (arr[i].id === assignedMasterId && slotCipher) {
                  selectedCipher = slotCipher;
                  break;
                }
              }
            }
            if (!selectedCipher) {
              selectedCipher = arr[0].cipher || arr[0].vaultCipher || "";
            }
          }
        } catch (e) {}
      }

      if (selectedCipher) {
        var dec = await decryptVaultCipher(selectedCipher);
        if (dec && dec.refresh_token) {
          ramActiveRefreshToken = String(dec.refresh_token).trim();
        }
      }

      if (iosNodePoolCipher) {
        var decPool = await decryptVaultCipher(iosNodePoolCipher);
        if (decPool && Array.isArray(decPool.nodes)) {
          ramIosNodePool = decPool.nodes;
        }
      }
    } catch (e) {}

    return getSnapshot();
  }

  // Sound Effects via Web Audio / HTML5 Audio
  function playAssetSound(type) {
    try {
      if (type === "boot") {
        if (bootSoundPlayed) return;
        bootSoundPlayed = true;
      }
      var file = type === "boot" ? "boot_cinema.wav" : (type === "ignite" ? "engine_ignite.wav" : "ui_switch.wav");
      var basePath = window.location.pathname.indexOf("/vektron_deck/") !== -1 ? "./" : "/vektron_deck/";
      var audio = new Audio(basePath + file);
      audio.volume = 0.65;
      audio.play().catch(function () {});
    } catch (e) {}
  }

  // GitHub Cloud Node Auto-Wake & Tunnel Discovery
  function setLaunchButtonStatus(text) {
    try {
      var btn = document.getElementById("ag-launch-btn") || document.querySelector("[onclick*='launchAntigravity']");
      if (btn) btn.textContent = text;
    } catch (e) {}
  }

  async function githubApi(token, method, path, bodyObj) {
    var opts = {
      method: method || "GET",
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    };
    if (bodyObj) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(bodyObj);
    }
    return fetch("https://api.github.com" + path, opts);
  }

  async function checkTunnelHealth(url) {
    if (!url) return false;
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 4500);
      var r = await fetch(url.replace(/\/$/, "") + "/vektron/health", { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        var d = await r.json();
        return !!(d && d.ok);
      }
    } catch (e) {}
    return false;
  }

  async function resolveOrWakeCloudNode() {
    // 1. If we are already served directly from a live Cloud Node origin, use window.location.origin!
    if (window.location.hostname.indexOf(".trycloudflare.com") !== -1 ||
        window.location.hostname.indexOf(".app.github.dev") !== -1 ||
        window.location.port === "8080") {
      if (await checkTunnelHealth(window.location.origin)) {
        return window.location.origin;
      }
    }

    // 2. If we already have a cached healthy tunnel in RAM, use it immediately
    if (ramActiveTunnelUrl && (await checkTunnelHealth(ramActiveTunnelUrl))) {
      return ramActiveTunnelUrl;
    }

    // 3. Check /system/quota_status for iosActiveNodeUrl first (fast path: 0 GitHub API calls if already awake!)
    try {
      var idToken = await ensureValidIdToken();
      if (idToken) {
        var qsResp = await fetch(FIRESTORE_BASE + "/system/quota_status", {
          headers: { "Authorization": "Bearer " + idToken }
        });
        if (qsResp.ok) {
          var qsDoc = await qsResp.json();
          var fastUrl = strField(qsDoc.fields || {}, "iosActiveNodeUrl", "");
          if (fastUrl && (await checkTunnelHealth(fastUrl))) {
            ramActiveTunnelUrl = fastUrl;
            return fastUrl;
          }
        }
      }
    } catch (e) {}

    // 4. Ensure we have the decrypted GitHub Node Pool in RAM
    if (!ramIosNodePool || ramIosNodePool.length === 0) {
      await syncWithFirestore();
    }
    if (!ramIosNodePool || ramIosNodePool.length === 0) {
      throw new Error("No hay nodos Cloud iOS configurados en la bóveda.");
    }

    // 5. Iterate through GitHub accounts in the Pool
    for (var i = 0; i < ramIosNodePool.length; i++) {
      var node = ramIosNodePool[i];
      var ghToken = (node.token || "").trim();
      var owner = (node.owner || "").trim();
      var repo = (node.repo || "vektron-ios-node").trim();
      if (!ghToken) continue;

      try {
        setLaunchButtonStatus("VERIFICANDO NODO CLOUD (" + (i + 1) + "/" + ramIosNodePool.length + ")...");
        if (!owner) {
          var uResp = await githubApi(ghToken, "GET", "/user");
          if (!uResp.ok) continue;
          var uData = await uResp.json();
          owner = uData.login;
        }

        // Check existing codespaces for this account
        var csResp = await githubApi(ghToken, "GET", "/user/codespaces");
        if (!csResp.ok) continue;
        var csData = await csResp.json();
        var codespaces = (csData && csData.codespaces) || [];
        var targetCs = null;
        for (var j = 0; j < codespaces.length; j++) {
          if (codespaces[j].repository && codespaces[j].repository.name === repo) {
            targetCs = codespaces[j];
            break;
          }
        }
        if (!targetCs && codespaces.length > 0) {
          targetCs = codespaces[0];
        }

        // If no codespace exists yet on this pool account, auto-create it!
        if (!targetCs) {
          setLaunchButtonStatus("CREANDO NODO CLOUD EN " + owner.toUpperCase() + "...");
          var createCsResp = await githubApi(ghToken, "POST", "/repos/" + owner + "/" + repo + "/codespaces", {
            ref: "main",
            machine: "basicLinux32gb"
          });
          if (createCsResp.status === 402 || createCsResp.status === 403) {
            // Quota exhausted on this GitHub account -> rotate to next account in pool!
            continue;
          }
          if (createCsResp.ok) {
            targetCs = await createCsResp.json();
          }
        }

        if (!targetCs || !targetCs.name) continue;

        // If codespace is stopped/sleeping, start it!
        if (targetCs.state !== "Available") {
          setLaunchButtonStatus("ENCENDIENDO MOTOR LINUX X64 (8GB RAM)...");
          var startResp = await githubApi(ghToken, "POST", "/user/codespaces/" + targetCs.name + "/start");
          if (startResp.status === 402 || startResp.status === 403) {
            // Monthly 60h quota reached on this account -> rotate to next account in pool!
            continue;
          }
        }

        // Poll for live_tunnel.json in the repo (updated by server.js on boot)
        for (var attempt = 0; attempt < 35; attempt++) {
          setLaunchButtonStatus("CONECTANDO TÚNEL SEGURO (" + (attempt + 1) + "s)...");
          try {
            var fileResp = await githubApi(ghToken, "GET", "/repos/" + owner + "/" + repo + "/contents/live_tunnel.json?t=" + Date.now());
            if (fileResp.ok) {
              var fileData = await fileResp.json();
              if (fileData && fileData.content) {
                var rawJson = atob(fileData.content.replace(/\s/g, ""));
                var tunnelInfo = JSON.parse(rawJson);
                if (tunnelInfo && tunnelInfo.tunnelUrl) {
                  var healthy = await checkTunnelHealth(tunnelInfo.tunnelUrl);
                  if (healthy) {
                    ramActiveTunnelUrl = tunnelInfo.tunnelUrl;
                    // Cache active URL in /system/quota_status for instant subsequent launches
                    try {
                      var fbTok = await ensureValidIdToken();
                      if (fbTok) {
                        fetch(FIRESTORE_BASE + "/system/quota_status?updateMask.fieldPaths=iosActiveNodeUrl&updateMask.fieldPaths=updatedAt", {
                          method: "PATCH",
                          headers: { "Authorization": "Bearer " + fbTok, "Content-Type": "application/json" },
                          body: JSON.stringify({
                            fields: {
                              iosActiveNodeUrl: { stringValue: ramActiveTunnelUrl },
                              updatedAt: { integerValue: String(Date.now()) }
                            }
                          })
                        }).catch(function () {});
                      }
                    } catch (e) {}
                    return ramActiveTunnelUrl;
                  }
                }
              }
            }
          } catch (e) {}
          await new Promise(function (r) { setTimeout(r, 2000); });
        }
      } catch (err) {
        console.warn("[Vektron iOS Pool] Node error on index " + i + ":", err);
      }
    }

    throw new Error("No se pudo conectar al Nodo Cloud. Verifica tu conexión e inténtalo de nuevo.");
  }

  async function launchWorkspaceFlow() {
    if (wakingNodeInProgress) return;
    var snap = getSnapshot();
    if (!snap.canRunAntigravity) {
      pushStateToWeb(null, false);
      return;
    }

    wakingNodeInProgress = true;
    try {
      if (!ramActiveRefreshToken) {
        setLaunchButtonStatus("SINCRONIZANDO BÓVEDA...");
        await syncWithFirestore();
      }
      var nodeUrl = await resolveOrWakeCloudNode();
      setLaunchButtonStatus("ARMANDO BÓVEDA RAM...");

      var p = getPrefs();
      var provResp = await fetch(nodeUrl.replace(/\/$/, "") + "/vektron/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshToken: ramActiveRefreshToken,
          session: p
        })
      });

      if (!provResp.ok) {
        throw new Error("El nodo rechazó la provisión de bóveda (" + provResp.status + ").");
      }
      var provData = await provResp.json();

      // Wait until isolated per-UID language_server is ready on the Cloud Node
      var safeUid = String(p.uid || "default").replace(/[^a-zA-Z0-9_-]/g, "");
      for (var w = 0; w < 25; w++) {
        if (provData && provData.engineReady) break;
        setLaunchButtonStatus("INICIANDO ANTIGRAVITY ENGINE...");
        await new Promise(function (r) { setTimeout(r, 1000); });
        var hResp = await fetch(nodeUrl.replace(/\/$/, "") + "/vektron/health?vk_uid=" + encodeURIComponent(safeUid));
        if (hResp.ok) {
          provData = await hResp.json();
          if (provData.engineReady) break;
        }
      }

      workspaceReadyInMemory = true;
      if (typeof window.setLobbyPaused === "function") {
        window.setLobbyPaused(true);
      }

      // Open or reveal full-screen workspace iframe isolated by vk_uid
      var sessionB64 = btoa(unescape(encodeURIComponent(JSON.stringify(getPrefs()))));
      var targetWorkspaceUrl = nodeUrl.replace(/\/$/, "") + "/?hostTheme=dark&vk_uid=" + encodeURIComponent(safeUid) + "#vk_session=" + encodeURIComponent(sessionB64);
      var nodeKey = nodeUrl + "|" + safeUid;

      var frameWrap = document.getElementById("vk-ios-workspace-wrap");
      var frame = document.getElementById("vk-ios-workspace-frame");
      if (!frameWrap) {
        frameWrap = document.createElement("div");
        frameWrap.id = "vk-ios-workspace-wrap";
        frameWrap.style.cssText = "position:fixed;inset:0;width:100vw;height:100dvh;z-index:999999;background:#0b0e17;display:flex;flex-direction:column;";
        frame = document.createElement("iframe");
        frame.id = "vk-ios-workspace-frame";
        frame.style.cssText = "width:100%;height:100%;border:0;flex:1;background:#0b0e17;";
        frame.setAttribute("allow", "clipboard-read; clipboard-write; microphone; camera; fullscreen; downloads");
        frame.src = targetWorkspaceUrl;
        frameWrap.appendChild(frame);
        document.body.appendChild(frameWrap);
      } else {
        if (frame && frame.getAttribute("data-node-key") !== nodeKey) {
          frame.src = targetWorkspaceUrl;
        } else if (frame && frame.contentWindow) {
          try {
            frame.contentWindow.postMessage({ type: "VEKTRON_SYNC_PREFS", prefs: getPrefs() }, "*");
          } catch (_) {}
        }
        frameWrap.style.display = "flex";
      }
      if (frame) frame.setAttribute("data-node-key", nodeKey);
      setLaunchButtonStatus("REANUDAR ANTIGRAVITY");
    } catch (err) {
      var msg = (err && err.message) ? err.message : "Error al conectar con el Nodo Cloud.";
      pushStateToWeb(msg, false);
      setLaunchButtonStatus("EJECUTAR ANTIGRAVITY");
    } finally {
      wakingNodeInProgress = false;
    }
  }

  function returnToLobbyFromWorkspace() {
    // If inside iframe, notify parent window
    if (window.parent && window.parent !== window) {
      try {
        window.parent.postMessage({ type: "VEKTRON_RETURN_TO_LOBBY" }, "*");
        return;
      } catch (e) {}
    }
    var frameWrap = document.getElementById("vk-ios-workspace-wrap");
    if (frameWrap) {
      frameWrap.style.display = "none";
    }
    if (typeof window.setLobbyPaused === "function") {
      window.setLobbyPaused(false);
    }
    pushStateToWeb(null, false);
  }

  window.addEventListener("message", function (ev) {
    if (!ev || !ev.data) return;
    if (ev.data.type === "VEKTRON_RETURN_TO_LOBBY") {
      returnToLobbyFromWorkspace();
    } else if (ev.data.type === "VEKTRON_SYNC_PREFS" && ev.data.prefs) {
      savePrefs(ev.data.prefs);
      pushStateToWeb(null, false);
    }
  });

  // Build quota JSON identical to VektronSessionManager.buildOriginalQuotaJson (with __vektron: true)
  function buildOriginalQuotaJson() {
    var now = Date.now();
    var snap = getSnapshot();
    var p = getPrefs();
    var base1x = Math.max(100, Number(p.baseCreditsUltra1x || 500));
    var max5h = snap.maxCredits > 0
      ? snap.maxCredits
      : (snap.plan === "pro3x" ? base1x * 3 : ((snap.plan === "pro2x" || snap.plan === "plus") ? base1x * 2 : base1x));
    var maxWeekly = snap.plan === "trial" ? max5h : max5h * 5;

    var gemUsed5h = Number(p.geminiUsed5h || 0);
    var gemReset5h = Number(p.geminiReset5hAt || 0);
    var gemUsedWeekly = Number(p.geminiUsedWeekly || 0);
    var gemResetWeekly = Number(p.geminiResetWeeklyAt || 0);

    var claudeUsed5h = Number(p.claudeUsed5h || 0);
    var claudeReset5h = Number(p.claudeReset5hAt || 0);
    var claudeUsedWeekly = Number(p.claudeUsedWeekly || 0);
    var claudeResetWeekly = Number(p.claudeResetWeeklyAt || 0);

    if (snap.usedCredits > 0 && gemUsed5h === 0 && claudeUsed5h === 0) {
      gemUsed5h = snap.usedCredits;
      gemReset5h = snap.cycleResetAt > now ? snap.cycleResetAt : (now + FIVE_HOURS_MS);
      if (gemUsedWeekly === 0) {
        gemUsedWeekly = snap.usedCredits;
        gemResetWeekly = now + SEVEN_DAYS_MS - 3600000;
      }
      savePrefs({
        geminiUsed5h: gemUsed5h,
        geminiReset5hAt: gemReset5h,
        geminiUsedWeekly: gemUsedWeekly,
        geminiResetWeeklyAt: gemResetWeekly
      });
    }

    var disabled = !snap.canRunAntigravity;

    function buildGroup(title, desc, prefix, u5h, r5h, m5h, uW, rW, mW) {
      var effW = (rW > 0 && now >= rW) ? 0 : Math.max(0, uW);
      var fracW = 1.0;
      var refW = "Weekly limit at 100% capacity.";
      var subW = "100% available";
      if (effW > 0 && mW > 0) {
        fracW = Math.max(0.0, Math.min(0.99, (mW - effW) / mW));
        var targetW = rW > now ? rW : (now + SEVEN_DAYS_MS);
        var totMinW = Math.max(1, Math.floor((targetW - now) / 60000));
        var dW = Math.floor(totMinW / 1440);
        var hW = Math.floor((totMinW % 1440) / 60);
        var minW = totMinW % 60;
        refW = "You have used some of your weekly limit, it will fully refresh in " + dW + " days, " + hW + " hours.";
        subW = "Resets in " + (dW > 0 ? (hW > 0 ? dW + "d " + hW + "h" : dW + "d") : (hW > 0 ? hW + "h " + minW + "m" : minW + "m"));
      }

      var eff5 = (r5h > 0 && now >= r5h) ? 0 : Math.max(0, u5h);
      var frac5 = disabled ? 0.0 : 1.0;
      var ref5 = "5-hour cycle limit at 100% capacity.";
      var sub5 = "100% available";
      if (eff5 > 0 && m5h > 0 && !disabled) {
        frac5 = Math.max(0.0, Math.min(0.99, (m5h - eff5) / m5h));
        var target5 = r5h > now ? r5h : (now + FIVE_HOURS_MS);
        var totMin5 = Math.max(1, Math.floor((target5 - now) / 60000));
        var h5 = Math.floor(totMin5 / 60);
        var min5 = totMin5 % 60;
        sub5 = "Resets in " + (h5 > 0 ? (min5 > 0 ? h5 + "h " + min5 + "m" : h5 + "h") : min5 + "m");
        ref5 = "You have used some of your 5-hour limit, it will fully refresh in " + (h5 > 0 ? h5 + " hours, " + min5 + " minutes." : min5 + " minutes.");
      }

      return {
        displayName: title,
        description: desc,
        buckets: [
          {
            __vektron: true,
            bucketId: prefix + "-weekly",
            displayName: "Weekly limit",
            remainingFraction: fracW,
            refreshText: refW,
            subtext: subW,
            disabled: disabled
          },
          {
            __vektron: true,
            bucketId: prefix + "-5h",
            displayName: "5-hour limit",
            remainingFraction: frac5,
            refreshText: ref5,
            subtext: sub5,
            disabled: disabled
          }
        ]
      };
    }

    return JSON.stringify({
      email: snap.email || "",
      planLabel: "Google AI Ultra",
      statusDesc: "You are subscribed to the best Google AI plan.",
      groups: [
        buildGroup("Gemini Models", "Quota shared across Gemini models.", "gemini", gemUsed5h, gemReset5h, max5h, gemUsedWeekly, gemResetWeekly, maxWeekly),
        buildGroup("Claude and GPT models", "Quota shared across Claude and GPT models.", "claude", claudeUsed5h, claudeReset5h, max5h, claudeUsedWeekly, claudeResetWeekly, maxWeekly)
      ]
    });
  }

  function consumePromptQuota(modelFamily) {
    var snap = getSnapshot();
    if (!snap.isAdmin && !snap.canRunAntigravity) return false;

    var p = getPrefs();
    var now = Date.now();
    var resetAt = Number(p.cycleResetAt || 0);
    var used = Number(p.usedCredits || 0);
    var base1x = Math.max(100, Number(p.baseCreditsUltra1x || 500));
    var max = Number(p.maxCredits || base1x);
    var plan = p.plan || "pro";
    if (plan !== "trial" && plan !== "none" && resetAt > 0 && now >= resetAt) {
      used = 0;
      resetAt = now + FIVE_HOURS_MS;
    }

    var fam = String(modelFamily || "").toLowerCase();
    var cost = Number(p.costPro || 12);
    if (fam.indexOf("opus") !== -1) cost = Number(p.costOpus || 30);
    else if (fam.indexOf("sonnet") !== -1 || fam.indexOf("claude") !== -1 || fam.indexOf("gpt") !== -1) cost = Number(p.costSonnet || 18);
    else if (fam.indexOf("flash") !== -1 || fam.indexOf("lite") !== -1) cost = Number(p.costFlash || 5);

    var newUsed = used + cost;
    var finalResetAt = resetAt > 0 ? resetAt : (now + FIVE_HOURS_MS);
    var isClaude = fam.indexOf("claude") !== -1 || fam.indexOf("sonnet") !== -1 || fam.indexOf("opus") !== -1 || fam.indexOf("gpt") !== -1;
    var prefix = isClaude ? "claude" : "gemini";

    var famUsed5h = Number(p[prefix + "Used5h"] || 0);
    var famReset5h = Number(p[prefix + "Reset5hAt"] || 0);
    if (famReset5h <= 0 || now >= famReset5h) {
      famUsed5h = 0;
      famReset5h = finalResetAt;
    }
    famUsed5h += cost;

    var famUsedW = Number(p[prefix + "UsedWeekly"] || 0);
    var famResetW = Number(p[prefix + "ResetWeeklyAt"] || 0);
    if (famResetW <= 0 || now >= famResetW) {
      famUsedW = 0;
      famResetW = now + SEVEN_DAYS_MS;
    }
    famUsedW += cost;

    var patch = {
      usedCredits: newUsed,
      cycleResetAt: finalResetAt
    };
    patch[prefix + "Used5h"] = famUsed5h;
    patch[prefix + "Reset5hAt"] = famReset5h;
    patch[prefix + "UsedWeekly"] = famUsedW;
    patch[prefix + "ResetWeeklyAt"] = famResetW;
    var updated = savePrefs(patch);

    if (window.parent && window.parent !== window) {
      try {
        window.parent.postMessage({ type: "VEKTRON_SYNC_PREFS", prefs: updated }, "*");
      } catch (e) {}
    }

    // Async Firestore sync
    (async function () {
      try {
        var idToken = await ensureValidIdToken();
        if (!idToken || !p.uid) return;
        var mask = "?updateMask.fieldPaths=usedCreditsCycle&updateMask.fieldPaths=cycleResetAt&updateMask.fieldPaths=lastSeenAt";
        await fetch(FIRESTORE_BASE + "/users/" + encodeURIComponent(p.uid) + mask, {
          method: "PATCH",
          headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: {
              usedCreditsCycle: { integerValue: String(newUsed) },
              cycleResetAt: { integerValue: String(finalResetAt) },
              lastSeenAt: { integerValue: String(Date.now()) }
            }
          })
        });
      } catch (e) {}
    })();

    if (!snap.isAdmin && max > 0 && newUsed >= max) {
      setTimeout(returnToLobbyFromWorkspace, 300);
      return false;
    }
    return true;
  }

  // =========================================================================
  // 1. Expose window.VektronBridge (for 3D Lobby vektron_deck/index.html)
  // =========================================================================
  window.VektronBridge = {
    playSound: function (type) {
      playAssetSound(type);
    },
    submitAuth: function (emailRaw, pass, isRegister) {
      (async function () {
        try {
          var email = String(emailRaw || "").trim().toLowerCase();
          if (!email || email.indexOf("@") === -1) throw new Error("Ingresa un correo electrónico válido.");
          if (!pass || pass.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");

          var endpoint = isRegister
            ? "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + FIREBASE_API_KEY
            : "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FIREBASE_API_KEY;

          var resp = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email, password: pass, returnSecureToken: true })
          });
          var data = await resp.json();
          if (!resp.ok) {
            var code = (data && data.error && data.error.message) || "AUTH_ERROR";
            if (code.indexOf("EMAIL_EXISTS") !== -1) throw new Error("Este correo ya está registrado. Inicia sesión.");
            if (code.indexOf("INVALID_LOGIN_CREDENTIALS") !== -1 || code.indexOf("INVALID_PASSWORD") !== -1 || code.indexOf("EMAIL_NOT_FOUND") !== -1) {
              throw new Error("Correo o contraseña incorrectos.");
            }
            throw new Error("Error de autenticación (" + code + ").");
          }

          savePrefs({
            uid: data.localId,
            email: email,
            idToken: data.idToken,
            firebaseRefreshToken: data.refreshToken,
            tokenObtainedAt: Date.now()
          });

          await syncWithFirestore();
          pushStateToWeb(null, true);
        } catch (err) {
          pushStateToWeb(err && err.message ? err.message : "Error de conexión.", false);
        }
      })();
    },
    resetPassword: function (emailRaw) {
      (async function () {
        try {
          var email = String(emailRaw || "").trim().toLowerCase();
          if (!email || email.indexOf("@") === -1) throw new Error("Ingresa tu correo para recuperar la contraseña.");
          var resp = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=" + FIREBASE_API_KEY, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestType: "PASSWORD_RESET", email: email })
          });
          if (!resp.ok) throw new Error("No se pudo enviar el enlace de recuperación.");
          pushStateToWeb("Enlace enviado a " + email + ". Revisa tu bandeja o Spam.", true);
        } catch (err) {
          pushStateToWeb(err && err.message ? err.message : "Error al enviar enlace.", false);
        }
      })();
    },
    submitReport: function (category, message) {
      (async function () {
        try {
          var snap = getSnapshot();
          if (!snap.loggedIn) throw new Error("Inicia sesión primero.");
          var idToken = await ensureValidIdToken();
          var fields = {
            uid: { stringValue: snap.uid },
            email: { stringValue: snap.email },
            category: { stringValue: String(category || "general") },
            message: { stringValue: String(message || "").trim() },
            plan: { stringValue: String(snap.plan || "none") },
            deviceId: { stringValue: snap.deviceId },
            status: { stringValue: "open" },
            createdAt: { integerValue: String(Date.now()) }
          };
          var resp = await fetch(FIRESTORE_BASE + "/reports", {
            method: "POST",
            headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: fields })
          });
          if (!resp.ok) throw new Error("No se pudo registrar el reporte.");
          if (typeof window.onReportResult === "function") {
            window.onReportResult({ ok: true, message: "Tu reporte fue enviado al panel administrativo." });
          }
        } catch (err) {
          if (typeof window.onReportResult === "function") {
            window.onReportResult({ ok: false, message: err && err.message ? err.message : "Error al enviar." });
          }
        }
      })();
    },
    openExternalUrl: function (url) {
      if (!url) return;
      window.open(url, "_blank", "noopener,noreferrer");
    },
    logout: function () {
      workspaceReadyInMemory = false;
      clearPrefs();
      var frameWrap = document.getElementById("vk-ios-workspace-wrap");
      if (frameWrap) frameWrap.remove();
      pushStateToWeb(null, false);
    },
    launchAntigravity: function () {
      launchWorkspaceFlow();
    }
  };

  // =========================================================================
  // 2. Expose window.Android & window.AndroidBridge (for Antigravity Web UI)
  // =========================================================================
  var androidPolyfill = {
    onUiReady: function () {},
    onUiError: function (msg) { console.warn("[Vektron iOS UI Error]", msg); },
    setTheme: function (mode) {
      savePrefs({ themeMode: mode });
      return true;
    },
    setThemeByUser: function (mode) {
      savePrefs({ themeMode: mode });
      return true;
    },
    onVisualThemeChanged: function () {},
    getTheme: function () {
      return getPrefs().themeMode || "dark";
    },
    isDesktopMode: function () {
      return !!getPrefs().desktopMode;
    },
    setDesktopMode: function (enabled) {
      savePrefs({ desktopMode: !!enabled });
    },
    isEngineReady: function () { return true; },
    getEnginePort: function () {
      return Number(window.location.port) || (window.location.protocol === "https:" ? 443 : 8080);
    },
    getEngineBaseUrl: function () {
      return window.location.origin;
    },
    getCsrfToken: function () {
      return window.__AG_CSRF__ || "vektron-ios-csrf-token";
    },
    getConfig: function () {
      return JSON.stringify(window.__APP_CONFIG__ || {});
    },
    openUrl: function (url) {
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    },
    exec: function () { return ""; },
    shizuku: function () { return ""; },
    shizukuAvailable: function () { return false; },
    postNotification: function () { return true; },
    listNotifications: function () { return "[]"; },
    saveBlob: function (base64Data, filename, mimeType) {
      try {
        var a = document.createElement("a");
        a.href = "data:" + (mimeType || "application/octet-stream") + ";base64," + base64Data;
        a.download = filename || "download";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e) {}
    },
    installMarketplacePlugin: function (pluginName, archiveUrl, catalogId, marketplace, version) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", window.location.origin + "/vektron/plugin/install", false);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(JSON.stringify({
          pluginName: pluginName,
          archiveUrl: archiveUrl,
          catalogId: catalogId,
          marketplace: marketplace,
          version: version
        }));
        if (xhr.status === 200 && xhr.responseText) return xhr.responseText;
      } catch (e) {}
      return JSON.stringify({ success: false, message: "Plugin install error" });
    },
    uninstallMarketplacePlugin: function (pluginName) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", window.location.origin + "/vektron/plugin/uninstall", false);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(JSON.stringify({ pluginName: pluginName }));
        return xhr.status === 200;
      } catch (e) {}
      return false;
    },
    getVektronCustomerEmail: function () {
      return getSnapshot().email || "usuario@vektron.studio";
    },
    getVektronPlanLabel: function () {
      var s = getSnapshot();
      return "Vektron Studio · " + (s.isAdmin ? "Plan Ultra x3" : s.plan);
    },
    getVektronQuotaJson: function (forceRefresh) {
      var now = Date.now();
      if (forceRefresh && (now - lastQuotaSyncMs) > 25000) {
        lastQuotaSyncMs = now;
        syncWithFirestore().catch(function () {});
      }
      return buildOriginalQuotaJson();
    },
    consumeVektronPromptQuota: function (modelFamily) {
      return consumePromptQuota(modelFamily || "gemini");
    },
    isVektronAdmin: function () {
      return false;
    },
    reportRealMasterQuota: function (realQuotaJson) {
      if (!realQuotaJson) return;
      (async function () {
        try {
          var p = getPrefs();
          var masterId = (p.masterAccountId || "default").replace(/[^a-zA-Z0-9_]/g, "_");
          var safeField = "quota_" + masterId;
          var idToken = await ensureValidIdToken();
          if (!idToken) return;
          var url = FIRESTORE_BASE + "/system/quota_status?updateMask.fieldPaths=" + safeField + "&updateMask.fieldPaths=latestRealQuotaJson&updateMask.fieldPaths=updatedAt";
          var fields = {
            latestRealQuotaJson: { stringValue: String(realQuotaJson) },
            updatedAt: { integerValue: String(Date.now()) }
          };
          fields[safeField] = { stringValue: String(realQuotaJson) };
          await fetch(url, {
            method: "PATCH",
            headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: fields })
          });
        } catch (e) {}
      })();
    },
    returnToLobby: function () {
      returnToLobbyFromWorkspace();
    }
  };

  window.Android = androidPolyfill;
  window.AndroidBridge = androidPolyfill;

  // =========================================================================
  // 3. Workspace Top Bar ("Lobby" + "Archivos / Web"), Live Preview & ZIP Export
  // =========================================================================
  function getActiveWorkspaceUid() {
    if (window.__VK_UID__) return String(window.__VK_UID__);
    var p = getPrefs();
    if (p && p.uid) return String(p.uid).replace(/[^a-zA-Z0-9_-]/g, "");
    try {
      var qp = new URLSearchParams(window.location.search);
      if (qp.get("vk_uid")) return qp.get("vk_uid");
    } catch (_) {}
    return "default";
  }

  function openLivePreviewOverlay(url, titleText) {
    var modal = document.getElementById("vk-live-preview-overlay");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "vk-live-preview-overlay";
      modal.style.cssText = "position:fixed;inset:0;z-index:2147483645;background:#070a12;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
      modal.innerHTML =
        '<div style="height:46px;background:#0d121f;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:space-between;padding:0 12px;gap:8px;">' +
          '<div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">' +
            '<span style="width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;flex-shrink:0;"></span>' +
            '<span id="vk-preview-title" style="color:#f8fafc;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Vista Previa en Vivo</span>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">' +
            '<button id="vk-preview-reload" type="button" style="background:rgba(255,255,255,0.07);color:#e2e8f0;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;">↻ Recargar</button>' +
            '<a id="vk-preview-ext" href="#" target="_blank" rel="noopener" style="background:rgba(56,189,248,0.14);color:#38bdf8;border:1px solid rgba(56,189,248,0.3);border-radius:8px;padding:5px 10px;font-size:12px;font-weight:600;text-decoration:none;">↗ Pestaña</a>' +
            '<button id="vk-preview-close" type="button" style="background:rgba(239,68,68,0.16);color:#fca5a5;border:1px solid rgba(239,68,68,0.32);border-radius:8px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;">✕ Cerrar</button>' +
          '</div>' +
        '</div>' +
        '<iframe id="vk-live-preview-frame" style="width:100%;flex:1;border:0;background:#ffffff;" allow="fullscreen; clipboard-read; clipboard-write"></iframe>';
      document.body.appendChild(modal);

      document.getElementById("vk-preview-close").onclick = function () {
        modal.style.display = "none";
      };
      document.getElementById("vk-preview-reload").onclick = function () {
        var f = document.getElementById("vk-live-preview-frame");
        if (f && f.src) f.src = f.src;
      };
    }
    var frame = document.getElementById("vk-live-preview-frame");
    var titleEl = document.getElementById("vk-preview-title");
    var extEl = document.getElementById("vk-preview-ext");
    if (titleEl) titleEl.textContent = titleText || url;
    if (extEl) extEl.href = url;
    if (frame) frame.src = url;
    modal.style.display = "flex";
  }

  function formatBytes(bytes) {
    var b = Number(bytes || 0);
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(2) + " MB";
  }

  async function openFilesAndPreviewModal() {
    var uid = getActiveWorkspaceUid();
    var modal = document.getElementById("vk-files-drawer-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "vk-files-drawer-modal";
      modal.style.cssText = "position:fixed;inset:0;z-index:2147483640;background:rgba(4,6,12,0.78);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
      modal.innerHTML =
        '<div style="width:100%;max-width:540px;max-height:84vh;background:#0d121f;border:1px solid rgba(255,255,255,0.12);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,0.75);display:flex;flex-direction:column;overflow:hidden;color:#f8fafc;">' +
          '<div style="padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;">' +
            '<div>' +
              '<div style="font-size:15px;font-weight:700;color:#f8fafc;">Archivos del Proyecto y Vista Previa</div>' +
              '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">Visualiza servidores locales o guarda tus archivos en el móvil</div>' +
            '</div>' +
            '<button id="vk-files-close" type="button" style="background:rgba(255,255,255,0.07);color:#cbd5e1;border:1px solid rgba(255,255,255,0.1);border-radius:9px;padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;">Cerrar</button>' +
          '</div>' +
          '<div id="vk-files-body" style="padding:14px 16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px;">' +
            '<div style="color:#94a3b8;font-size:13px;">Cargando archivos y servidores activos...</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);
      modal.addEventListener("click", function (e) {
        if (e.target === modal) modal.style.display = "none";
      });
      document.getElementById("vk-files-close").onclick = function () {
        modal.style.display = "none";
      };
    }

    modal.style.display = "flex";
    var bodyEl = document.getElementById("vk-files-body");
    bodyEl.innerHTML = '<div style="color:#94a3b8;font-size:13px;padding:12px 0;">Escaneando espacio de trabajo y puertos activos...</div>';

    try {
      var resp = await fetch(window.location.origin + "/vektron/files/list?vk_uid=" + encodeURIComponent(uid));
      var data = await resp.json();
      var ports = (data && data.ports) || [];
      var files = (data && data.files) || [];
      var html = "";

      // 1. Download full ZIP button
      var zipUrl = window.location.origin + "/vektron/files/zip?vk_uid=" + encodeURIComponent(uid);
      html +=
        '<div style="background:linear-gradient(135deg,rgba(37,99,235,0.18),rgba(56,189,248,0.10));border:1px solid rgba(56,189,248,0.32);border-radius:13px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;">' +
          '<div>' +
            '<div style="font-size:13px;font-weight:700;color:#f8fafc;">Guardar todo en mi celular / tablet</div>' +
            '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">Descarga todos los archivos de tu proyecto en un paquete .ZIP</div>' +
          '</div>' +
          '<a href="' + zipUrl + '" download style="background:#2563eb;color:#ffffff;text-decoration:none;padding:8px 13px;border-radius:10px;font-size:12px;font-weight:700;white-space:nowrap;box-shadow:0 4px 14px rgba(37,99,235,0.4);">⬇ Descargar .ZIP</a>' +
        '</div>';

      // 2. Active Localhost Servers
      html += '<div><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#38bdf8;margin-bottom:7px;">🌐 Servidores Locales Activos (localhost)</div>';
      if (ports.length === 0) {
        html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:10px 12px;font-size:12px;color:#94a3b8;">No hay servidores de puerto activos en este momento. Si creaste una web estática, ábrela abajo con el botón <b>Ver</b> en <code>index.html</code>.</div>';
      } else {
        for (var i = 0; i < ports.length; i++) {
          var pt = ports[i];
          var prevUrl = window.location.origin + "/preview/" + pt + "/";
          html +=
            '<div style="background:rgba(16,185,129,0.09);border:1px solid rgba(16,185,129,0.3);border-radius:10px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
              '<div style="display:flex;align-items:center;gap:8px;">' +
                '<span style="width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;"></span>' +
                '<span style="font-size:13px;font-weight:600;color:#f8fafc;">Servidor en Puerto :' + pt + '</span>' +
              '</div>' +
              '<div style="display:flex;gap:6px;">' +
                '<button type="button" data-preview-url="' + prevUrl + '" data-preview-title="localhost:' + pt + '" class="vk-btn-open-preview" style="background:#10b981;color:#04130d;border:0;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer;">👁 Ver en Vivo</button>' +
                '<a href="' + prevUrl + '" target="_blank" rel="noopener" style="background:rgba(255,255,255,0.08);color:#e2e8f0;text-decoration:none;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;">↗</a>' +
              '</div>' +
            '</div>';
        }
      }
      html += '</div>';

      // 3. Project Files List
      html += '<div><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;margin-bottom:7px;">📄 Archivos Creados (' + files.length + ')</div>';
      if (files.length === 0) {
        html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px;font-size:12px;color:#94a3b8;">Aún no hay archivos en tu carpeta de Proyectos. Pídele al agente que cree una página o aplicación.</div>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:6px;">';
        for (var j = 0; j < files.length; j++) {
          var f = files[j];
          var viewUrl = window.location.origin + "/vektron/files/view/" + encodeURIComponent(uid) + "/" + f.relPath.split("/").map(encodeURIComponent).join("/");
          var dlUrl = window.location.origin + "/vektron/files/download?vk_uid=" + encodeURIComponent(uid) + "&path=" + encodeURIComponent(f.relPath);
          html +=
            '<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:8px 11px;display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
              '<div style="min-width:0;flex:1;">' +
                '<div style="font-size:13px;font-weight:600;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + f.relPath + '</div>' +
                '<div style="font-size:11px;color:#64748b;">' + formatBytes(f.size) + '</div>' +
              '</div>' +
              '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">' +
                ((f.isHtml || f.isImage)
                  ? '<button type="button" data-preview-url="' + viewUrl + '" data-preview-title="' + f.relPath + '" class="vk-btn-open-preview" style="background:rgba(56,189,248,0.16);color:#38bdf8;border:1px solid rgba(56,189,248,0.32);border-radius:8px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer;">👁 Ver</button>'
                  : '') +
                '<a href="' + dlUrl + '" download="' + f.name + '" style="background:rgba(255,255,255,0.08);color:#e2e8f0;text-decoration:none;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 10px;font-size:12px;font-weight:600;">⬇ Guardar</a>' +
              '</div>' +
            '</div>';
        }
        html += '</div>';
      }
      html += '</div>';

      bodyEl.innerHTML = html;

      var prevBtns = bodyEl.querySelectorAll(".vk-btn-open-preview");
      for (var k = 0; k < prevBtns.length; k++) {
        prevBtns[k].onclick = function () {
          var u = this.getAttribute("data-preview-url");
          var t = this.getAttribute("data-preview-title");
          modal.style.display = "none";
          openLivePreviewOverlay(u, t);
        };
      }
    } catch (err) {
      bodyEl.innerHTML = '<div style="color:#f87171;font-size:13px;">Error al consultar archivos: ' + (err && err.message ? err.message : err) + '</div>';
    }
  }

  function installWorkspaceFloatingBarAndInterceptors() {
    if (!window.__APP_CONFIG__) return;
    if (document.getElementById("vk-workspace-top-pill")) return;

    var bar = document.createElement("div");
    bar.id = "vk-workspace-top-pill";
    bar.style.cssText =
      "position:fixed;top:calc(env(safe-area-inset-top, 0px) + 6px);left:50%;transform:translateX(-50%);" +
      "z-index:2147483000;display:flex;align-items:center;gap:4px;padding:3px 5px;" +
      "background:rgba(10,14,23,0.88);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);" +
      "border:1px solid rgba(255,255,255,0.14);border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,0.55);" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

    var btnLobby = document.createElement("button");
    btnLobby.type = "button";
    btnLobby.innerHTML = '⟵ Lobby';
    btnLobby.style.cssText =
      "background:transparent;color:#e2e8f0;border:0;border-radius:999px;padding:4px 10px;" +
      "font-size:11.5px;font-weight:700;cursor:pointer;letter-spacing:0.02em;";
    btnLobby.onclick = function () {
      returnToLobbyFromWorkspace();
    };

    var sep = document.createElement("span");
    sep.style.cssText = "width:1px;height:13px;background:rgba(255,255,255,0.15);";

    var btnFiles = document.createElement("button");
    btnFiles.type = "button";
    btnFiles.innerHTML = '📁 Archivos / Web';
    btnFiles.style.cssText =
      "background:rgba(56,189,248,0.15);color:#38bdf8;border:0;border-radius:999px;padding:4px 10px;" +
      "font-size:11.5px;font-weight:700;cursor:pointer;letter-spacing:0.02em;";
    btnFiles.onclick = function () {
      openFilesAndPreviewModal();
    };

    bar.appendChild(btnLobby);
    bar.appendChild(sep);
    bar.appendChild(btnFiles);
    document.body.appendChild(bar);

    // Intercept clicks on localhost:<port> or 127.0.0.1:<port> links in chat!
    document.addEventListener("click", function (ev) {
      var el = ev.target;
      while (el && el !== document.body) {
        if (el.tagName === "A" && el.href) {
          var m = el.href.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(\/.*)?$/i);
          if (m && m[1]) {
            ev.preventDefault();
            ev.stopPropagation();
            var port = m[1];
            var sub = m[2] || "/";
            var liveUrl = window.location.origin + "/preview/" + port + sub;
            openLivePreviewOverlay(liveUrl, "localhost:" + port + sub);
            return;
          }
        }
        el = el.parentElement;
      }
    }, true);
  }

  // Initial sync & periodic heartbeat on Lobby or Workspace
  function initBridgeLifecycle() {
    if (window.__APP_CONFIG__) {
      installWorkspaceFloatingBarAndInterceptors();
      return;
    }
    pushStateToWeb(null, false);
    if (getSnapshot().loggedIn) {
      syncWithFirestore().then(function () {
        pushStateToWeb(null, false);
      }).catch(function () {});
    }
    setInterval(function () {
      if (getSnapshot().loggedIn) {
        syncWithFirestore().then(function () {
          pushStateToWeb(null, false);
        }).catch(function () {});
      }
    }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(initBridgeLifecycle, 150);
    });
  } else {
    setTimeout(initBridgeLifecycle, 150);
  }
})();
