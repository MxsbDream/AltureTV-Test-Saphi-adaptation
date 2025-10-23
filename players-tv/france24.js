/**
 * France24 player helper (HLS)
 * - Charge hls.js dynamiquement si nécessaire
 * - Gère l'attachement/détachement propre du player
 * - Retry simple sur erreurs réseau
 * - Applique playsinline / muted sur Android Chrome pour faciliter l'autoplay
 *
 * Usage:
 *  France24Player.init({
 *    videoId: 'france24Video',
 *    modalId: 'france24Modal',
 *    src: 'https://static.france24.com/live/F24_FR_LO_HLS/live_web.m3u8', // optionnel
 *    autoplayMuted: true // recommandé pour Chrome Android
 *  });
 *
 *  // Ouvrir / fermer
 *  France24Player.open();
 *  France24Player.close();
 */
(function (global) {
  const DEFAULT_SRC = "https://static.france24.com/live/F24_FR_LO_HLS/live_web.m3u8";
  const HLS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@latest";
  let config = {
    videoId: "france24Video",
    modalId: "france24Modal",
    src: DEFAULT_SRC,
    autoplayMuted: true,
    maxRetries: 3,
    xhrTimeout: 15000
  };

  let _hls = null;
  let _retryCount = 0;
  let _initialized = false;

  function log(...args) { console.log("[France24Player]", ...args); }
  function warn(...args) { console.warn("[France24Player]", ...args); }
  function err(...args) { console.error("[France24Player]", ...args); }

  function loadHlsJs() {
    return new Promise((resolve, reject) => {
      if (window.Hls) return resolve(window.Hls);
      // Avoid loading multiple times
      if (document.querySelector('script[data-france24-hls]')) {
        const existing = document.querySelector('script[data-france24-hls]');
        existing.addEventListener('load', () => {
          if (window.Hls) resolve(window.Hls);
          else reject(new Error('hls.js failed to load'));
        });
        existing.addEventListener('error', () => reject(new Error('hls.js load error')));
        return;
      }
      const s = document.createElement('script');
      s.src = HLS_CDN;
      s.async = true;
      s.setAttribute('data-france24-hls', '1');
      s.onload = () => {
        if (window.Hls) resolve(window.Hls);
        else reject(new Error('hls.js loaded but not available'));
      };
      s.onerror = () => reject(new Error('Failed to load hls.js'));
      document.head.appendChild(s);
    });
  }

  function getVideoEl() {
    return document.getElementById(config.videoId);
  }
  function getModalEl() {
    return document.getElementById(config.modalId);
  }

  function applyVideoAttributes(video) {
    if (!video) return;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('crossorigin', 'anonymous');
    // on Android Chrome, autoplay often only works when muted
    if (config.autoplayMuted && /Android/i.test(navigator.userAgent) && /Chrome/i.test(navigator.userAgent)) {
      video.muted = true;
      log('Android Chrome detected: muting video to allow autoplay');
    }
  }

  function attachHls(video, src) {
    return loadHlsJs().then(Hls => {
      // destroy previous
      if (_hls) {
        try { _hls.destroy(); } catch (e) { warn('destroy previous hls failed', e); }
        _hls = null;
      }
      _hls = new Hls({
        maxBufferLength: 30,
        enableWorker: true,
        xhrSetup: function (xhr, url) {
          xhr.withCredentials = false;
          xhr.timeout = config.xhrTimeout;
        }
      });

      _hls.on(Hls.Events.MEDIA_ATTACHED, function () {
        log("Media element attached to HLS");
      });

      _hls.on(Hls.Events.MANIFEST_PARSED, function () {
        log("Manifest parsed");
      });

      _hls.on(Hls.Events.ERROR, function (event, data) {
        warn("HLS error", event, data);
        if (data && data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && _retryCount < config.maxRetries) {
            _retryCount++;
            log("Network error, retrying startLoad (attempt " + _retryCount + ")");
            setTimeout(() => {
              try { _hls.startLoad(); } catch (e) { warn(e); }
            }, 1000 * _retryCount);
            return;
          } else {
            err("Fatal HLS error, destroying instance", data);
            try { _hls.destroy(); } catch (e) { warn(e); }
            _hls = null;
          }
        }
      });

      _hls.attachMedia(video);
      _hls.loadSource(src);
      return _hls;
    });
  }

  function attachNative(video, src) {
    video.src = src;
    return Promise.resolve(null);
  }

  function open() {
    const video = getVideoEl();
    const modal = getModalEl();
    if (!video || !modal) {
      err("Video or modal element not found (videoId/modalId)", config.videoId, config.modalId);
      return;
    }
    applyVideoAttributes(video);
    _retryCount = 0;

    // If the browser supports MSE and we have hls.js, use it; otherwise set src directly (Safari)
    const src = config.src;
    if (window.Hls && window.Hls.isSupported()) {
      attachHls(video, src).then(() => {
        // try play
        video.play().catch(e => {
          warn("Play attempt failed (hls):", e);
        });
      }).catch(e => {
        warn("attachHls failed, fallback to native", e);
        // fallback
        video.src = src;
        video.play().catch(() => {});
      });
    } else {
      // If Hls not loaded yet, try to load it; if not supported later fallback to native
      loadHlsJs().then(Hls => {
        if (Hls && Hls.isSupported()) {
          attachHls(video, src).then(() => {
            video.play().catch(e => warn("Play attempt failed after hls load:", e));
          });
        } else {
          // native HLS (Safari) or unsupported
          attachNative(video, src);
          video.play().catch(e => warn("Native play failed:", e));
        }
      }).catch(e => {
        warn("Could not load hls.js, fallback to native:", e);
        attachNative(video, src);
        video.play().catch(e => warn("Native play failed:", e));
      });
    }

    // show modal
    modal.classList.remove("hidden");
  }

  function close() {
    const video = getVideoEl();
    const modal = getModalEl();
    if (!video || !modal) return;
    // destroy hls if present
    if (_hls) {
      try { _hls.destroy(); } catch (e) { warn('destroy hls failed', e); }
      _hls = null;
    }
    // pause and clear
    try {
      video.pause();
      video.removeAttribute('src');
      // remove <source> children if any
      const sources = video.querySelectorAll('source');
      sources.forEach(s => s.removeAttribute('src'));
      video.load();
    } catch (e) { warn('clear video failed', e); }

    modal.classList.add("hidden");
    _retryCount = 0;
  }

  function init(userConfig) {
    if (_initialized) {
      log("already initialized, merging config");
    }
    config = Object.assign({}, config, userConfig || {});
    const video = getVideoEl();
    if (!video) {
      warn("init: video element not found yet. Make sure the DOM contains an element with id=", config.videoId);
    } else {
      applyVideoAttributes(video);
    }
    _initialized = true;
  }

  // Expose API
  global.France24Player = {
    init,
    open,
    close,
    config, // expose config for debugging/modification at runtime
    _internal: {
      loadHlsJs
    }
  };
})(window);
