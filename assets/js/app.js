"use strict";

var $ = function (s) { return document.querySelector(s); };
/* Portal cameras whose streams returned 404 on a manifest check against
   cctv.jogjaprov.go.id on 3 Nov 2026 (~15:50 WIB). The 2 Nov list had 8 entries;
   four of them (19, 101, 126, 242) were live again by 3 Nov and #28
   (Depan Plaza/Mall Malioboro) had died — these cameras flap, so this list is
   only a starting hint: the live checks replace it with fresh results. */
var DEAD_NOW = { 4: 1, 28: 1, 105: 1, 207: 1, 261: 1 };
var state = {
  q: "",
  group: -1,
  mainIdx: -1,
  mainHls: null,
  cap: 9,
  wall: [],          // camera indices or null, length === cap
  tileHls: {},       // tile position -> Hls instance
  status: CAMS.map(function (_c, i) { return DEAD_NOW[i] ? "offline" : "verified"; }),
  checking: false,
  fsOpen: false
};

function groupOf(i) { return GROUPS[CAMS[i][1]]; }
function isYt(c) { return c[5] === "yt"; }
function hasCoords(c) { return typeof c[2] === "number" && typeof c[3] === "number"; }
function ytId(url) { var m = /[?&]v=([\w-]{6,})/.exec(url); return m ? m[1] : ""; }
function esc(s) {
  return s.replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function statusText(s) {
  return { verified: "Verified live at the last check", online: "Live now", offline: "Offline at last check", checking: "Checking…" }[s];
}
var YT_BADGE = '<span class="yt-badge">YouTube</span>';

/* ---------------- YouTube IFrame Player API ----------------
   Plain embed iframes surface YouTube's own cryptic error screen
   (notably "Error 153" when a live ends, its ID rotates, or embedding
   is disabled) with no way for the page to react. Loading the IFrame
   API and creating every YouTube player through YT.Player gives each
   embed an onError handler; on error the player is replaced visually
   by a friendly overlay with Recheck + Watch on YouTube actions.
   If the API itself cannot load, players fall back to plain embeds. */
var YT_ERR_CODES = { 2: 1, 5: 1, 100: 1, 101: 1, 150: 1, 153: 1 };
var ytApiState = "idle"; // idle | loading | ready | failed
var ytApiQueue = [];
var ytApiTimer = null;
function flushYtApi(ok) {
  var q = ytApiQueue; ytApiQueue = [];
  q.forEach(function (cb) { try { cb(ok); } catch (err) {} });
}
function withYtApi(cb) {
  if (ytApiState === "ready" && window.YT && window.YT.Player) { cb(true); return; }
  if (ytApiState === "failed") { cb(false); return; }
  ytApiQueue.push(cb);
  if (ytApiState === "loading") return;
  ytApiState = "loading";
  window.onYouTubeIframeAPIReady = function () {
    if (ytApiTimer) { clearTimeout(ytApiTimer); ytApiTimer = null; }
    ytApiState = "ready";
    flushYtApi(true);
  };
  var tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  tag.async = true;
  tag.onerror = function () {
    if (ytApiState !== "loading") return;
    ytApiState = "failed"; flushYtApi(false);
  };
  document.head.appendChild(tag);
  ytApiTimer = setTimeout(function () {
    if (ytApiState !== "loading") return;
    ytApiState = "failed"; flushYtApi(false);
  }, 8000);
}
function ytErrorText(code, name) {
  var base = "The live stream for " + name + " is currently unavailable. The live ID may have rotated \u2014 these channels issue new IDs when streams restart.";
  if (code === 153) return base + " YouTube reported error 153: the stream may have ended or embedding was disabled for this video.";
  if (code === 100) return base + " YouTube reported error 100: this video was not found \u2014 it may have ended or been removed.";
  if (code === 101 || code === 150) return base + " YouTube reported error " + code + ": the channel has disabled embedding for this video.";
  if (code === 2 || code === 5) return base + " YouTube reported error " + code + " while loading the player.";
  return base;
}

/* ---------------- HLS plumbing ----------------
   The player library (hls.js) is self-hosted in assets/ — an earlier build
   loaded it from a public CDN, and when that CDN stalled every camera was
   wrongly reported "offline". Two defences: the local copy, and below, a
   missing library is never treated as a dead camera. */
var playerPending = false;
/* Portal streams flap: segments stall, the origin answers a brief 500, or a
   slow cold start misses the live edge — then recovers seconds later. The old
   plumbing declared a camera dead after 2 network retries, so on a fresh open
   the main player plus four wall tiles stampeded one host, hit transient
   errors together, and every camera was branded "offline" within seconds,
   permanently. Now a fatal error rebuilds the player from the live edge with
   backoff (1.5s → 20s, 5 rebuilds ≈ 40s of patience), any buffered fragment
   resets the patience counter, and onDead fires only after all rebuilds fail.
   onState("retrying", n) / onState("alive") let callers show "Reconnecting…"
   instead of "offline" while recovery is in progress. opts.delayMs staggers
   simultaneous starts so a wall of tiles doesn't burst at once. */
var REVIVE_DELAYS = [1500, 3000, 6000, 12000, 20000];
function attachHls(video, url, onDead, onState, opts) {
  opts = opts || {};
  var handle = { hls: null, dead: false, destroyed: false, revives: 0, timer: null, suspended: false };
  function alive() {
    if (handle.destroyed) return;
    handle.revives = 0;
    if (onState) onState("alive");
  }
  function revive() {
    if (handle.destroyed || handle.dead || handle.suspended) return;
    if (handle.hls) { try { handle.hls.destroy(); } catch (err) {} handle.hls = null; }
    if (handle.revives >= REVIVE_DELAYS.length) {
      handle.dead = true;
      if (onDead) onDead();
      return;
    }
    var delay = REVIVE_DELAYS[handle.revives];
    handle.revives++;
    if (onState) onState("retrying", handle.revives);
    handle.timer = setTimeout(start, delay);
  }
  function start() {
    if (handle.destroyed || handle.dead || handle.suspended) return;
    if (window.Hls && Hls.isSupported()) {
      var h = new Hls({ maxBufferLength: 30, liveSyncDurationCount: 3, fragLoadingMaxRetry: 6, manifestLoadingMaxRetry: 4, levelLoadingMaxRetry: 4, fragLoadingRetryDelay: 1000, manifestLoadingRetryDelay: 1000, levelLoadingRetryDelay: 1000 });
      handle.hls = h;
      h.loadSource(url);
      h.attachMedia(video);
      h.on(Hls.Events.FRAG_BUFFERED, alive);
      h.on(Hls.Events.ERROR, function (_e, data) {
        if (!data || !data.fatal || handle.destroyed) return;
        revive();
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    } else {
      /* No playback engine at all — the player library itself is missing.
         Flag it instead of blaming the camera; ensureFallbackPlayer() retries
         with a CDN copy and reboots the players if it arrives. */
      handle.noEngine = true;
      playerPending = true;
    }
  }
  video.addEventListener("playing", alive);
  if (!window.Hls || !Hls.isSupported()) {
    /* Native-HLS path (Safari): a media error gets the same revive treatment. */
    video.addEventListener("error", function () { if (!handle.noEngine) revive(); });
  }
  handle.destroy = function () {
    handle.destroyed = true;
    if (handle.timer) { clearTimeout(handle.timer); handle.timer = null; }
    if (handle.hls) { try { handle.hls.destroy(); } catch (err) {} handle.hls = null; }
  };
  /* Power saving, used by the video wall: suspend() tears the stream
     down (no segment fetches, no decoding) without marking the handle
     dead or destroyed; resume() restarts it from the live edge. */
  handle.suspend = function () {
    if (handle.destroyed || handle.suspended) return;
    handle.suspended = true;
    if (handle.timer) { clearTimeout(handle.timer); handle.timer = null; }
    if (handle.hls) { try { handle.hls.destroy(); } catch (err) {} handle.hls = null; }
    try { video.pause(); } catch (err) {}
  };
  handle.resume = function () {
    if (handle.destroyed || handle.dead || !handle.suspended) return;
    handle.suspended = false;
    start();
  };
  if (opts.delayMs) handle.timer = setTimeout(start, opts.delayMs);
  else start();
  return handle;
}
var fallbackTried = false;
function ensureFallbackPlayer() {
  if (fallbackTried || window.Hls) return;
  fallbackTried = true;
  var s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js";
  s.onload = function () {
    if (!window.Hls) { s.onerror(); return; }
    playerPending = false;
    if (state.mainIdx >= 0) loadMain(state.mainIdx);
    buildWall();
    highlightRow();
    updateAddWallBtn();
  };
  s.onerror = function () {
    showStageMsg("error", "Video player unavailable", "The video player couldn't be loaded, so no camera can play right now. Check your connection and reload the page.");
  };
  document.head.appendChild(s);
}
function detachHls(handle, video) {
  if (!handle) return;
  if (handle.destroy) handle.destroy();
  else if (handle.hls) { try { handle.hls.destroy(); } catch (err) {} }
  if (video) { try { video.pause(); video.removeAttribute("src"); video.load(); } catch (err) {} }
}

/* ---------------- main player ---------------- */
var mainVideo = $("#mainVideo");
var mainHandle = null;

function setBadge(mode) {
  var b = $("#liveBadge");
  if (!mode) { b.style.display = "none"; return; }
  b.style.display = "inline-flex";
  b.classList.toggle("off", mode === "offline");
  $("#liveBadgeText").textContent = mode === "offline" ? "OFFLINE" : "LIVE";
}
function showStageMsg(mode, title, text) {
  var msg = $("#stageMsg");
  if (!mode) { msg.className = "stage-msg"; return; }
  setBadge(mode === "error" ? "offline" : null);
  msg.className = "stage-msg show";
  $("#stageSpinner").style.display = mode === "loading" ? "block" : "none";
  $("#stageRetry").style.display = mode === "error" ? "inline-flex" : "none";
  $("#stageMsgTitle").textContent = title || "";
  $("#stageMsgText").textContent = text || "";
}

var mainFrame = $("#mainFrame");
var mainYt = { player: null, ready: false, creating: false, wantedId: "", loadedId: "" };
function hideStageYtErr() { $("#stageYtErr").classList.remove("show"); }
function showStageYtErr(code) {
  var i = state.mainIdx;
  if (i < 0 || !isYt(CAMS[i])) return;
  showStageMsg(null);
  $("#stageYtErrText").textContent = ytErrorText(code, CAMS[i][0]);
  $("#stageYtWatch").href = CAMS[i][4];
  $("#stageYtErr").classList.add("show");
  setBadge("offline");
  if (state.status[i] !== "offline") setStatus(i, "offline");
}
function fallbackMainYt(id) {
  mainFrame.innerHTML = '<iframe class="fallback-frame" title="YouTube live stream" src="https://www.youtube.com/embed/' + id + '?autoplay=1&mute=1&playsinline=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>';
  showStageMsg(null);
  setBadge("live");
  var i = state.mainIdx;
  if (i >= 0 && state.status[i] !== "online") setStatus(i, "online");
}
function playMainYt(i) {
  var cam = CAMS[i], id = ytId(cam[4]);
  mainYt.wantedId = id;
  hideStageYtErr();
  showStageMsg("loading", "Connecting…", "Loading the live stream for " + cam[0] + ".");
  withYtApi(function (ok) {
    if (state.mainIdx !== i || !isYt(CAMS[state.mainIdx])) return;
    if (!ok || !window.YT || !window.YT.Player) { fallbackMainYt(id); return; }
    if (mainYt.player) {
      if (mainYt.ready && mainYt.loadedId !== id) {
        mainYt.loadedId = id;
        try { mainYt.player.loadVideoById(id); } catch (err) {}
      } else if (mainYt.ready) {
        try { mainYt.player.playVideo(); } catch (err) {}
      }
      return;
    }
    if (mainYt.creating) return;
    mainYt.creating = true; mainYt.loadedId = id;
    try {
      mainYt.player = new YT.Player("mainYtMount", {
        videoId: id,
        playerVars: { autoplay: 1, mute: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: function (e) {
            mainYt.ready = true; mainYt.creating = false;
            try { e.target.mute(); } catch (err) {}
            if (state.mainIdx < 0 || !isYt(CAMS[state.mainIdx])) return;
            if (mainYt.wantedId && mainYt.wantedId !== mainYt.loadedId) {
              mainYt.loadedId = mainYt.wantedId;
              try { e.target.loadVideoById(mainYt.wantedId); } catch (err) {}
            } else {
              try { e.target.playVideo(); } catch (err) {}
            }
          },
          onStateChange: function (e) {
            if (state.mainIdx < 0 || !isYt(CAMS[state.mainIdx])) return;
            if (e.data === 1) {
              hideStageYtErr(); showStageMsg(null); setBadge("live");
              if (state.status[state.mainIdx] !== "online") setStatus(state.mainIdx, "online");
            }
          },
          onError: function (e) {
            if (state.mainIdx < 0 || !isYt(CAMS[state.mainIdx])) return;
            showStageYtErr(e && typeof e.data === "number" ? e.data : null);
          }
        }
      });
    } catch (err) { mainYt.creating = false; mainYt.player = null; fallbackMainYt(id); }
  });
}
function stopMainYt() {
  hideStageYtErr();
  if (mainYt.player && mainYt.ready) { try { mainYt.player.stopVideo(); } catch (err) {} }
  if (!mainYt.player && mainFrame.querySelector(".fallback-frame")) {
    mainFrame.innerHTML = '<div id="mainYtMount"></div>';
  }
}
$("#stageYtRecheck").addEventListener("click", function () {
  var i = state.mainIdx;
  if (i < 0 || !isYt(CAMS[i])) return;
  setStatus(i, "checking");
  if (mainYt.player && mainYt.ready) {
    hideStageYtErr();
    showStageMsg("loading", "Connecting…", "Re-checking the live stream for " + CAMS[i][0] + ".");
    try { mainYt.player.loadVideoById(mainYt.wantedId || ytId(CAMS[i][4])); } catch (err) { playMainYt(i); }
  } else {
    playMainYt(i);
  }
});
function loadMain(i, opts) {
  opts = opts || {};
  if (i < 0 || i >= CAMS.length) return;
  if (rec) stopRecording(); // switching cameras ends (and saves) any recording
  state.mainIdx = i;
  var cam = CAMS[i], g = groupOf(i);
  detachHls(mainHandle, mainVideo);
  mainHandle = null;
  $("#stageCamName").textContent = cam[0];
  $("#metaName").textContent = cam[0];
  $("#metaGroup").textContent = g.name;
  $("#metaDot").style.background = g.color;
  $("#metaCoords").textContent = hasCoords(cam) ? cam[2].toFixed(5) + ", " + cam[3].toFixed(5) : "no map pin";
  $("#metaStatus").textContent = statusText(state.status[i]);
  $("#metaYtBadge").hidden = !isYt(cam);
  $("#stageYtBadge").hidden = !isYt(cam);
  $("#streamLink").href = cam[4];
  $("#streamLinkLabel").textContent = isYt(cam) ? "Watch on YouTube" : "Stream (.m3u8)";
  var mapsBtn = $("#mapsLink");
  if (hasCoords(cam)) {
    mapsBtn.style.display = "";
    var murl = window.MapHelpers ? MapHelpers.mapsSearchUrl({ label: cam[0], lat: cam[2], lng: cam[3] }) : null;
    mapsBtn.href = murl || ("https://www.google.com/maps/search/?api=1&query=" + cam[2] + "," + cam[3]);
  } else {
    mapsBtn.style.display = "none";
  }
  $("#muteBtn").style.display = isYt(cam) ? "none" : "";
  if (isYt(cam)) {
    /* YouTube lives play through the IFrame API player (onError handled), not hls.js. */
    try { mainVideo.pause(); } catch (err) {}
    $("#stage").classList.add("yt");
    playMainYt(i);
  } else {
    $("#stage").classList.remove("yt");
    stopMainYt();
    showStageMsg("loading", "Connecting…", "Loading the live stream for " + cam[0] + ".");
    mainHandle = attachHls(mainVideo, cam[4], function () {
      if (state.mainIdx !== i) return;
      setStatus(i, "offline");
      showStageMsg("error", "Stream offline", cam[0] + " isn't answering right now — it may be down for maintenance or off for the night. Try the retry button, or pick another camera.");
    }, function (st, n) {
      if (state.mainIdx !== i) return;
      if (st === "retrying") {
        showStageMsg("loading", "Reconnecting…", cam[0] + "'s stream hiccuped — these portal cameras drop segments for a few seconds at a time. Retrying (attempt " + n + " of 5) instead of giving up.");
      }
    });
    if (mainHandle.noEngine) {
      showStageMsg("loading", "Loading video player…", "The stream player is still loading. If this stays, check your connection and reload the page.");
      ensureFallbackPlayer();
    }
    mainVideo.muted = $("#muteLabel").textContent === "Unmute";
    var p = mainVideo.play();
    if (p && p.catch) p.catch(function () {});
  }
  highlightRow();
  updateAddWallBtn();
  updateRecBtn();
  updateSnapBtn();
  if (window.__mapHandle && !opts.fromMap) { try { window.__mapHandle.selectPlace(i); } catch (err) {} }
  if (opts.scroll && window.innerWidth < 1021) {
    $("#stage").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

mainVideo.addEventListener("playing", function () {
  setBadge("live");
  if (state.mainIdx >= 0) { showStageMsg(null); if (state.status[state.mainIdx] !== "online") setStatus(state.mainIdx, "online"); }
});
mainVideo.addEventListener("click", function () {
  if (mainVideo.paused) { mainVideo.play(); } else { mainVideo.pause(); }
});
$("#stageRetry").addEventListener("click", function () { loadMain(state.mainIdx); });
$("#muteBtn").addEventListener("click", function () {
  mainVideo.muted = !mainVideo.muted;
  $("#muteLabel").textContent = mainVideo.muted ? "Unmute" : "Mute";
});
$("#fsBtn").addEventListener("click", function () {
  var st = $("#stage");
  if (document.fullscreenElement) { document.exitFullscreen(); }
  else if (st.requestFullscreen) { st.requestFullscreen(); }
});

/* ---------------- recording ----------------
   Records the main player with MediaRecorder and saves the clip as a
   download on this device. Video only, as asked: any audio track the
   captured stream carries is dropped before recording starts (the
   portal feeds are effectively silent anyway). YouTube embeds cannot
   be captured, so the button disables itself for the JITV cameras. */
var rec = null; // { recorder, chunks, camIdx, startedAt, timer, mime }
function recSupported() {
  return typeof window.MediaRecorder !== "undefined" &&
    (typeof mainVideo.captureStream === "function" || typeof mainVideo.mozCaptureStream === "function");
}
function fmtRecTime(ms) {
  var s = Math.floor(ms / 1000), m = Math.floor(s / 60), ss = s % 60;
  return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss;
}
function pickRecMime() {
  var cands = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  for (var k = 0; k < cands.length; k++) {
    try { if (MediaRecorder.isTypeSupported(cands[k])) return cands[k]; } catch (err) {}
  }
  return "";
}
function updateRecBtn() {
  var btn = $("#recBtn");
  if (rec) {
    btn.classList.add("recording");
    btn.disabled = false;
    btn.title = "Stop recording and save the clip to this device";
    $("#recLabel").textContent = "Stop · " + fmtRecTime(Date.now() - rec.startedAt);
    return;
  }
  btn.classList.remove("recording");
  var cam = state.mainIdx >= 0 ? CAMS[state.mainIdx] : null;
  btn.disabled = !recSupported() || !cam || isYt(cam);
  btn.title = !recSupported()
    ? "Recording isn't supported in this browser"
    : (cam && isYt(cam))
      ? "YouTube live streams can't be recorded here — use the YouTube link instead"
      : "Record the main player (video only, no sound) and save the clip to this device";
  $("#recLabel").textContent = "Record";
}
function startRecording() {
  if (rec || state.mainIdx < 0) return;
  var cam = CAMS[state.mainIdx];
  if (isYt(cam) || !recSupported()) return;
  var stream;
  try {
    stream = mainVideo.captureStream ? mainVideo.captureStream() : mainVideo.mozCaptureStream();
  } catch (err) { return; }
  stream.getAudioTracks().forEach(function (t) {
    stream.removeTrack(t);
    try { t.stop(); } catch (err) {}
  });
  if (!stream.getVideoTracks().length) return;
  var mime = pickRecMime();
  var recorder;
  try {
    recorder = new MediaRecorder(stream, mime
      ? { mimeType: mime, videoBitsPerSecond: 2500000 }
      : { videoBitsPerSecond: 2500000 });
  } catch (err) { return; }
  rec = {
    recorder: recorder, chunks: [], camIdx: state.mainIdx,
    startedAt: Date.now(), timer: null,
    mime: mime || recorder.mimeType || "video/webm"
  };
  recorder.ondataavailable = function (e) { if (e.data && e.data.size && rec) rec.chunks.push(e.data); };
  recorder.onstop = saveRecording;
  recorder.start(1000);
  $("#recBadge").classList.add("show");
  $("#recTime").textContent = "00:00";
  rec.timer = setInterval(function () {
    if (!rec) return;
    var t = fmtRecTime(Date.now() - rec.startedAt);
    $("#recTime").textContent = t;
    $("#recLabel").textContent = "Stop · " + t;
  }, 500);
  updateRecBtn();
}
function stopRecording() {
  if (!rec) return;
  if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
  try { rec.recorder.stop(); }
  catch (err) { rec = null; $("#recBadge").classList.remove("show"); updateRecBtn(); }
}
function saveRecording() {
  var r = rec;
  rec = null;
  $("#recBadge").classList.remove("show");
  updateRecBtn();
  if (!r || !r.chunks.length) return;
  var type = (r.mime || "video/webm").split(";")[0];
  var blob = new Blob(r.chunks, { type: type });
  var cam = CAMS[r.camIdx];
  var slug = cam[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "camera";
  var d = new Date();
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  var stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "jogja-cctv-" + slug + "-" + stamp + (type.indexOf("mp4") !== -1 ? ".mp4" : ".webm");
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  var lbl = $("#recLabel");
  lbl.textContent = "Saved to downloads";
  setTimeout(function () { if (!rec) lbl.textContent = "Record"; }, 2600);
}
$("#recBtn").addEventListener("click", function () {
  if (rec) stopRecording(); else startRecording();
});

/* ---------------- snapshot ----------------
   Captures the main player's current frame to a canvas and downloads
   it as a PNG, instantly — no recording session needed. The frame comes
   from the hls.js MediaSource, so it isn't CORS-tainted; the native-HLS
   path (Safari) can refuse, which is reported on the button instead of
   failing silently. YouTube embeds can't be captured at all, so the
   button disables itself for the JITV cameras, like Record does. */
function updateSnapBtn() {
  var btn = $("#snapBtn");
  var cam = state.mainIdx >= 0 ? CAMS[state.mainIdx] : null;
  btn.disabled = !cam || isYt(cam);
  btn.title = (cam && isYt(cam))
    ? "YouTube live streams can't be snapshotted here — use the YouTube link instead"
    : "Save the current frame of the main player as a PNG image";
}
function snapFeedback(text) {
  var lbl = $("#snapLabel");
  lbl.textContent = text;
  setTimeout(function () { lbl.textContent = "Snapshot"; }, 2200);
}
function takeSnapshot() {
  if (state.mainIdx < 0 || isYt(CAMS[state.mainIdx])) return;
  if (!mainVideo.videoWidth || !mainVideo.videoHeight) { snapFeedback("No frame yet"); return; }
  var cv = document.createElement("canvas");
  cv.width = mainVideo.videoWidth;
  cv.height = mainVideo.videoHeight;
  try {
    cv.getContext("2d").drawImage(mainVideo, 0, 0, cv.width, cv.height);
  } catch (err) { snapFeedback("Snapshot blocked"); return; }
  var cam = CAMS[state.mainIdx];
  var slug = cam[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "camera";
  var d = new Date();
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  var stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  function save(blob) {
    if (!blob) { snapFeedback("Snapshot failed"); return; }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "jogja-cctv-" + slug + "-" + stamp + ".png";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    snapFeedback("Saved PNG");
  }
  try {
    if (cv.toBlob) cv.toBlob(save, "image/png");
    else { // very old browsers: fall back to a data-URL download
      var a2 = document.createElement("a");
      a2.href = cv.toDataURL("image/png");
      a2.download = "jogja-cctv-" + slug + "-" + stamp + ".png";
      document.body.appendChild(a2);
      a2.click();
      setTimeout(function () { a2.remove(); }, 4000);
      snapFeedback("Saved PNG");
    }
  } catch (err) { snapFeedback("Snapshot blocked"); }
}
$("#snapBtn").addEventListener("click", takeSnapshot);

/* ---------------- fullscreen wall ----------------
   Moves the existing wall element into a fullscreen overlay, so the
   tiles keep playing (no stream restarts) and every wall control
   keeps working. In fullscreen the wall is edge-to-edge (no gaps,
   borders or rounded corners) and unlimited: adding a camera appends
   a new tile instead of replacing one, and the grid scrolls. The
   column buttons reshape the grid; Esc or Exit puts the wall back and
   folds any extra tiles down to a 2x2 / 3x3 / 4x4 page preset. */
var wallHome = null; // comment node marking the wall's normal spot
var fsCols = 0;      // 0 = auto-fit, otherwise a fixed column count

function parkWall() {
  var wall = $("#wall");
  if (wallHome && wallHome.parentNode) wallHome.parentNode.replaceChild(wall, wallHome);
}
function autoFsCols() {
  var w = $("#fsSlot").clientWidth || window.innerWidth || 1280;
  // roughly one tile per 360px of viewport; never fewer than 1 or more than 8
  return Math.max(1, Math.min(8, Math.round(w / 360)));
}
function fsColumnCount() {
  return fsCols > 0 ? fsCols : autoFsCols();
}
function applyFsColumns() {
  var wall = $("#wall");
  if (wall) wall.style.gridTemplateColumns = "repeat(" + fsColumnCount() + ", 1fr)";
}
function syncCapButtons(n) {
  document.querySelectorAll(".wall-head .seg button").forEach(function (x) {
    var on = parseInt(x.getAttribute("data-cap"), 10) === n;
    x.classList.toggle("on", on);
    x.setAttribute("aria-pressed", on ? "true" : "false");
  });
}
/* Drop the tiles added beyond the largest page preset, newest first, and
   detach their players so nothing keeps decoding offstage. */
function trimWallToCap() {
  var presets = [4, 9, 16];
  var target = state.cap;
  if (state.wall.length > state.cap) {
    target = 16;
    for (var k = 0; k < presets.length; k++) {
      if (presets[k] >= state.wall.length) { target = presets[k]; break; }
    }
  }
  while (state.wall.length > target) {
    var p = state.wall.length - 1;
    var tile = document.querySelector('.tile[data-pos="' + p + '"]');
    detachHls(state.tileHls[p], tile ? tile.querySelector("video") : null);
    destroyTileYt(p);
    delete state.tileHls[p];
    if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
    state.wall.pop();
  }
  if (target !== state.cap) {
    state.cap = target;
    $("#wall").className = "wall c" + target;
    syncCapButtons(target);
  }
  $("#wall").style.gridTemplateColumns = "";
}
function openFsWall() {
  var overlay = $("#fsOverlay"), wall = $("#wall");
  if (!wallHome) {
    wallHome = document.createComment("wall-home");
    wall.parentNode.insertBefore(wallHome, wall);
  }
  $("#fsSlot").appendChild(wall);
  overlay.classList.add("show");
  state.fsOpen = true;
  applyFsColumns();
  if (overlay.requestFullscreen) {
    try {
      var pr = overlay.requestFullscreen();
      if (pr && pr.catch) pr.catch(function () {});
    } catch (err) {}
  }
}
function closeFsWall() {
  if (!state.fsOpen) return;
  trimWallToCap();
  parkWall();
  $("#fsOverlay").classList.remove("show");
  state.fsOpen = false;
  if (document.fullscreenElement) {
    try { document.exitFullscreen(); } catch (err) {}
  }
}
$("#fsWallBtn").addEventListener("click", openFsWall);
$("#fsExitBtn").addEventListener("click", closeFsWall);
document.addEventListener("fullscreenchange", function () {
  // Esc / system exit: restore the wall to the page as it was.
  if (!document.fullscreenElement && state.fsOpen) closeFsWall();
});
document.addEventListener("keydown", function (e) {
  // The Fullscreen API may be unavailable (iOS, denied gesture): Esc still exits.
  if (e.key === "Escape" && state.fsOpen) closeFsWall();
});
$("#fsSeg").addEventListener("click", function (e) {
  var b = e.target.closest("[data-cols]");
  if (!b) return;
  document.querySelectorAll("#fsSeg button").forEach(function (x) {
    x.classList.toggle("on", x === b);
    x.setAttribute("aria-pressed", x === b ? "true" : "false");
  });
  fsCols = parseInt(b.getAttribute("data-cols"), 10);
  applyFsColumns();
});
window.addEventListener("resize", function () {
  if (state.fsOpen && fsCols === 0) applyFsColumns();
});
/* First camera matching the current search/filter that is not on the wall,
   preferring cameras not already known to be offline. */
function nextWallCandidate() {
  for (var pass = 0; pass < 2; pass++) {
    for (var i = 0; i < CAMS.length; i++) {
      if (!matches(i) || state.wall.indexOf(i) !== -1) continue;
      if (pass === 0 && state.status[i] === "offline") continue;
      return i;
    }
  }
  return -1;
}
$("#fsAddBtn").addEventListener("click", function () {
  var i = nextWallCandidate();
  if (i >= 0) addToWall(i, true);
});
$("#fsRowBtn").addEventListener("click", function () {
  var n = fsColumnCount(), added = 0;
  for (var k = 0; k < n; k++) {
    var i = nextWallCandidate();
    if (i < 0) break;
    addToWall(i, false);
    added++;
  }
  if (added) {
    var last = $("#wall").lastElementChild;
    if (last) last.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});
$("#addWallBtn").addEventListener("click", function () { addToWall(state.mainIdx, true); });
$("#randomBtn").addEventListener("click", function () {
  var pool = CAMS.map(function (_c, i) { return i; }).filter(function (i) { return state.status[i] !== "offline" && i !== state.mainIdx; });
  var pick = pool[Math.floor(Math.random() * pool.length)];
  loadMain(pick, { scroll: true });
});

function updateAddWallBtn() {
  var inWall = state.wall.indexOf(state.mainIdx) !== -1;
  $("#addWallBtn").style.opacity = inWall ? ".5" : "1";
  $("#addWallBtn").firstElementChild.nextSibling.textContent = inWall ? " On the wall" : " Add to wall";
}

/* ---------------- status ---------------- */
function setStatus(i, s) {
  state.status[i] = s;
  var dot = document.querySelector('.row[data-i="' + i + '"] .sdot');
  if (dot) dot.className = "sdot s-" + s;
  if (i === state.mainIdx) $("#metaStatus").textContent = statusText(s);
}

var recheckAbort = false;
$("#recheckBtn").addEventListener("click", function () {
  if (state.checking) { recheckAbort = true; return; }
  runRecheck(false);
});
/* Statuses baked into this page are a snapshot, and these cameras flap daily.
   The Recheck button re-tests every stream from the viewer's own connection;
   on open (auto mode) only the cameras on stage and on the wall are tested,
   so opening the page no longer fires ~936 requests at the portal within
   seconds. A camera is only marked offline after TWO failed probes ~1.5s
   apart (the portal throws brief 500s), and a camera already playing is
   never downgraded by a probe. */
function runRecheck(auto, only) {
  if (state.checking) return;
  state.checking = true; recheckAbort = false;
  var btn = $("#recheckBtn"), label = $("#recheckLabel");
  btn.classList.remove("primary");
  var order = [];
  if (only) {
    only.forEach(function (i) {
      if (i >= 0 && i < CAMS.length && order.indexOf(i) === -1) order.push(i);
    });
  } else {
    for (var oi = 0; oi < CAMS.length; oi++) order.push(oi);
  }
  var total = order.length, done = 0, online = 0, idx = 0, skipped = 0;
  label.textContent = "Stop · 0/" + total;
  if (auto) $("#verifiedText").textContent = "Checking the cameras on stage and on the wall from your connection…";
  var workers = [];
  function probeOnce(i) {
    var ctl = ("AbortController" in window) ? new AbortController() : null;
    var to = ctl ? setTimeout(function () { ctl.abort(); }, 6000) : null;
    /* Resolve a playlist or segment reference against the URL it was
       found in: absolute refs pass through, root-relative refs keep the
       origin, relative refs replace the base's last path segment — and
       the base's query string (e.g. ?session=…) carries over when the
       reference has none of its own. */
    function resolveRef(base, ref) {
      if (/^https?:\/\//i.test(ref)) return ref;
      if (ref.charAt(0) === "/" && ref.charAt(1) === "/") return base.split(":")[0] + ":" + ref;
      var out;
      if (ref.charAt(0) === "/") {
        var m = /^(https?:\/\/[^/]+)/i.exec(base);
        out = (m ? m[1] : "") + ref;
      } else {
        out = base.replace(/[^/]*(\?.*)?$/, ref);
      }
      if (out.indexOf("?") === -1) {
        var q = base.indexOf("?");
        if (q !== -1) out += base.slice(q);
      }
      return out;
    }
    function fetchText(url) {
      return fetch(url, { cache: "no-store", signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error("http")); });
    }
    function firstVariant(text) {
      var lines = text.split("\n"), want = false;
      for (var k = 0; k < lines.length; k++) {
        var ln = lines[k].trim();
        if (ln.indexOf("#EXT-X-STREAM-INF") === 0) { want = true; continue; }
        if (want && ln && ln.charAt(0) !== "#") return ln;
      }
      return null;
    }
    function lastSegment(text) {
      var lines = text.split("\n"), seg = null;
      for (var k = lines.length - 1; k >= 0; k--) {
        var ln = lines[k].trim();
        if (ln && ln.charAt(0) !== "#") { seg = ln; break; }
      }
      return seg;
    }
    /* Verify the way a player does: manifest first, then the newest media
       segment it lists. A manifest alone can answer 200 while the stream
       is stalled. Some streams (the Bantul regency ones) answer with a
       MASTER playlist (#EXT-X-STREAM-INF) that only points at
       sub-playlists — follow it and validate a real .ts segment from the
       sub-playlist, or "live" would just mean "a text file answered". */
    return fetchText(CAMS[i][4])
      .then(function (t) {
        if (t.indexOf("#EXTM3U") !== 0) throw new Error("bad manifest");
        if (t.indexOf("#EXT-X-STREAM-INF") !== -1) {
          var variant = firstVariant(t);
          if (!variant) throw new Error("no variant");
          var subUrl = resolveRef(CAMS[i][4], variant);
          return fetchText(subUrl).then(function (t2) { return { text: t2, base: subUrl }; });
        }
        return { text: t, base: CAMS[i][4] };
      })
      .then(function (pl) {
        var seg = lastSegment(pl.text);
        if (!seg) throw new Error("no segment");
        return fetch(resolveRef(pl.base, seg), { cache: "no-store", headers: { Range: "bytes=0-1023" }, signal: ctl ? ctl.signal : undefined });
      })
      .then(function (r2) {
        if (to) clearTimeout(to);
        if (r2 && (r2.ok || r2.status === 206)) return true;
        throw new Error("segment");
      })
      .catch(function () { if (to) clearTimeout(to); return false; });
  }
  function probe(i) {
    return probeOnce(i).then(function (ok) {
      if (ok || recheckAbort) return ok;
      return new Promise(function (res) { setTimeout(res, 1500); })
        .then(function () { return probeOnce(i); });
    });
  }
  function next() {
    if (recheckAbort || idx >= total) return Promise.resolve();
    var i = order[idx++];
    if (isYt(CAMS[i])) {
      /* YouTube embeds can't be probed from the page — keep their
         build-time verified status and leave them out of the tally. */
      skipped++; done++;
      label.textContent = "Stop · " + done + "/" + total;
      return next();
    }
    if (state.status[i] === "online") {
      /* Already proven live by an actual player this session — count it
         and don't let a probe race downgrade it. */
      online++; done++;
      label.textContent = "Stop · " + done + "/" + total + " checked";
      return next();
    }
    if (!auto) setStatus(i, "checking");
    return probe(i).then(function (ok) {
      if (ok) { setStatus(i, "online"); online++; }
      else if (state.status[i] !== "online") setStatus(i, "offline");
      done++;
      label.textContent = "Stop · " + done + "/" + total + " checked";
      return next();
    });
  }
  var nWorkers = auto ? 6 : 10;
  for (var w = 0; w < nWorkers; w++) workers.push(next());
  Promise.all(workers).then(function () {
    state.checking = false;
    btn.classList.add("primary");
    label.textContent = "Recheck streams";
    var summary;
    if (recheckAbort) {
      summary = "Recheck stopped · " + done + " of " + total + " cameras tested";
    } else if (auto) {
      summary = "Quick check on open · " + online + " of " + (total - skipped) + " on-stage streams live now · Recheck streams tests all " + CAMS.length;
    } else {
      summary = "Recheck complete · " + online + " of " + (total - skipped) + " streams live now";
    }
    if (!recheckAbort && skipped) summary += " · " + skipped + " YouTube lives not probed";
    $("#verifiedText").textContent = summary;
  });
}

/* ---------------- filter chips ---------------- */
function buildChips() {
  var box = $("#chips");
  var counts = GROUPS.map(function () { return 0; });
  CAMS.forEach(function (c) { counts[c[1]]++; });
  var html = '<button type="button" class="chip on" data-g="-1">All regions<span class="n">' + CAMS.length + '</span></button>';
  GROUPS.forEach(function (g, gi) {
    html += '<button type="button" class="chip" data-g="' + gi + '"><span class="cdot" style="--c:' + g.color + ';background:' + g.color + '"></span>' + esc(g.short) + '<span class="n">' + counts[gi] + '</span></button>';
  });
  box.innerHTML = html;
  box.addEventListener("click", function (e) {
    var b = e.target.closest(".chip");
    if (!b) return;
    state.group = parseInt(b.getAttribute("data-g"), 10);
    box.querySelectorAll(".chip").forEach(function (c) { c.classList.toggle("on", c === b); });
    applyFilter();
  });
}

/* ---------------- camera list ---------------- */
var rowEls = [];
function buildList() {
  var list = $("#list");
  var html = "";
  CAMS.forEach(function (c, i) {
    var g = GROUPS[c[1]];
    html += '<button type="button" class="row" data-i="' + i + '">'
      + '<span class="cdot" style="background:' + g.color + '"></span>'
      + '<span class="txt"><span class="nm-row"><span class="nm">' + esc(c[0]) + '</span>' + (isYt(c) ? YT_BADGE : '') + '</span><span class="gp">' + esc(g.short) + '</span></span>'
      + '<span class="sdot s-' + state.status[i] + '" title="status"></span>'
      + '<span class="add" data-add="' + i + '" role="button" aria-label="Add to wall" title="Add to wall">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>'
      + '</button>';
  });
  list.innerHTML = html;
  rowEls = Array.prototype.slice.call(list.querySelectorAll(".row"));
  list.addEventListener("click", function (e) {
    var add = e.target.closest("[data-add]");
    var row = e.target.closest(".row");
    if (!row) return;
    var i = parseInt(row.getAttribute("data-i"), 10);
    if (add) { addToWall(i, true); return; }
    loadMain(i, { scroll: true });
  });
}
function highlightRow() {
  rowEls.forEach(function (r) {
    var on = parseInt(r.getAttribute("data-i"), 10) === state.mainIdx;
    r.classList.toggle("on", on);
    if (on && $("#list").contains(r)) { /* keep list position; user navigates */ }
  });
  document.querySelectorAll(".row .add").forEach(function (a) {
    var i = parseInt(a.getAttribute("data-add"), 10);
    a.classList.toggle("inwall", state.wall.indexOf(i) !== -1);
  });
}
function matches(i) {
  var c = CAMS[i];
  if (state.group !== -1 && c[1] !== state.group) return false;
  if (!state.q) return true;
  var hay = (c[0] + " " + GROUPS[c[1]].name + " " + GROUPS[c[1]].short + (isYt(c) ? " youtube" : "")).toLowerCase();
  return state.q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
}
function applyFilter() {
  var shown = 0;
  rowEls.forEach(function (r) {
    var i = parseInt(r.getAttribute("data-i"), 10);
    var ok = matches(i);
    r.style.display = ok ? "" : "none";
    if (ok) shown++;
  });
  $("#listCount").textContent = shown + " of " + CAMS.length + " shown";
  $("#listEmpty").classList.toggle("show", shown === 0);
}
$("#q").addEventListener("input", function (e) {
  state.q = e.target.value.trim().toLowerCase();
  applyFilter();
});

/* ---------------- video wall ---------------- */
function findCam(name) {
  for (var i = 0; i < CAMS.length; i++) if (CAMS[i][0] === name) return i;
  return -1;
}
function buildWall() {
  var wall = $("#wall");
  wall.className = "wall c" + state.cap;
  wall.innerHTML = "";
  state.tileHls = {};
  for (var p = 0; p < state.cap; p++) renderTile(p, true);
}
/* ---------------- wall-tile YouTube players ---------------- */
var tileYtPlayers = {}; // tile position -> { player, camIdx, ready, creating, loadedId, wantedId }
function destroyTileYt(p) {
  var recd = tileYtPlayers[p];
  if (recd && recd.player) { try { recd.player.destroy(); } catch (err) {} }
  delete tileYtPlayers[p];
}
function showTileYtErr(p, ci, code) {
  var t = document.querySelector('.tile[data-pos="' + p + '"]');
  if (!t || state.wall[p] !== ci) return;
  var tx = t.querySelector("[data-yt-err-text]");
  if (tx) tx.textContent = ytErrorText(code, CAMS[ci][0]);
  var err = t.querySelector("[data-yt-err]");
  if (err) err.classList.add("show");
  if (state.status[ci] !== "offline") setStatus(ci, "offline");
}
function hideTileYtErr(p) {
  var t = document.querySelector('.tile[data-pos="' + p + '"]');
  var err = t ? t.querySelector("[data-yt-err]") : null;
  if (err) err.classList.remove("show");
}
function fallbackTileYt(p, ci) {
  var t = document.querySelector('.tile[data-pos="' + p + '"]');
  if (!t || state.wall[p] !== ci) return;
  var mount = t.querySelector("[data-yt-mount]");
  if (mount) mount.innerHTML = '<iframe src="https://www.youtube.com/embed/' + ytId(CAMS[ci][4]) + '?autoplay=1&mute=1&controls=0&playsinline=1&rel=0" allow="autoplay; encrypted-media" title="' + esc(CAMS[ci][0]) + '"></iframe>';
}
function mountTileYt(p, ci) {
  destroyTileYt(p);
  var recd = { player: null, ready: false, creating: false, loadedId: "", wantedId: ytId(CAMS[ci][4]), camIdx: ci };
  tileYtPlayers[p] = recd;
  withYtApi(function (ok) {
    if (tileYtPlayers[p] !== recd || state.wall[p] !== ci) return;
    if (!ok || !window.YT || !window.YT.Player) { fallbackTileYt(p, ci); return; }
    var t = document.querySelector('.tile[data-pos="' + p + '"]');
    var mount = t ? t.querySelector("[data-yt-mount]") : null;
    if (!mount) return;
    var mountId = "tileYtMount-" + p + "-" + ci;
    mount.id = mountId;
    recd.creating = true; recd.loadedId = recd.wantedId;
    try {
      recd.player = new YT.Player(mountId, {
        videoId: recd.wantedId,
        playerVars: { autoplay: 1, mute: 1, controls: 0, playsinline: 1, rel: 0, disablekb: 1, fs: 0, modestbranding: 1 },
        events: {
          onReady: function (e) {
            recd.ready = true; recd.creating = false;
            try { e.target.mute(); e.target.playVideo(); } catch (err) {}
          },
          onStateChange: function (e) {
            if (state.wall[p] !== ci) return;
            if (e.data === 1) { hideTileYtErr(p); if (state.status[ci] !== "online") setStatus(ci, "online"); }
          },
          onError: function (e) {
            showTileYtErr(p, ci, e && typeof e.data === "number" ? e.data : null);
          }
        }
      });
    } catch (err) { recd.creating = false; fallbackTileYt(p, ci); }
  });
}
function recheckTileYt(p) {
  var ci = state.wall[p];
  if (ci === null || ci === undefined || !isYt(CAMS[ci])) return;
  hideTileYtErr(p);
  setStatus(ci, "checking");
  var recd = tileYtPlayers[p];
  if (recd && recd.player && recd.ready) {
    try { recd.player.loadVideoById(recd.wantedId); } catch (err) { mountTileYt(p, ci); }
  } else if (recd && recd.player && recd.creating) {
    /* player still loading; its onError/onStateChange will resolve the tile */
  } else {
    mountTileYt(p, ci);
  }
}
function renderTile(p, stagger) {
  destroyTileYt(p);
  var wall = $("#wall");
  var old = wall.children[p];
  var tile = document.createElement("div");
  tile.className = "tile";
  tile.setAttribute("data-pos", p);
  var ci = state.wall[p];
  if (ci === null || ci === undefined) {
    tile.innerHTML = '<div class="empty"><button type="button" data-pick="' + p + '">+ Add a camera</button></div>';
  } else {
    var c = CAMS[ci], g = GROUPS[c[1]];
    tile.innerHTML =
      (isYt(c)
        ? '<div class="tile-yt" data-yt-mount="' + p + '"></div>'
          + '<div class="yt-err" data-yt-err="' + p + '"><div class="yt-err-box"><span class="yt-badge">YouTube</span>'
          + '<p class="yt-err-title">Stream unavailable</p>'
          + '<p data-yt-err-text="' + p + '">This YouTube live stream is currently unavailable.</p>'
          + '<div class="yt-err-acts"><button type="button" class="yt-act primary" data-yt-recheck="' + p + '">Recheck</button>'
          + '<a class="yt-act" href="' + esc(c[4]) + '" target="_blank" rel="noopener">Watch on YouTube</a></div></div></div>'
        : '<video muted playsinline autoplay></video>'
          + '<div class="err"><span>Stream offline<br><small>' + esc(c[0]) + '</small></span></div>'
          + '<div class="rec"><span>Reconnecting…</span></div>')
      + '<div class="bar"><span class="cdot" style="background:' + g.color + '"></span>'
      + '<span class="nm">' + esc(c[0]) + '</span>' + (isYt(c) ? YT_BADGE : '')
      + '<button type="button" class="tbtn" data-expand="' + p + '" title="Watch in main player" aria-label="Watch in main player">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="M9 21H3v-6"/><path d="m3 21 7-7"/></svg></button>'
      + '<button type="button" class="tbtn" data-remove="' + p + '" title="Remove from wall" aria-label="Remove from wall">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>';
    var video = tile.querySelector("video");
    if (video) (function (pos, camIdx) {
      /* Stagger tile starts by position so a fresh page doesn't fire the main
         player plus every tile at the same host in the same instant. */
      state.tileHls[pos] = attachHls(video, CAMS[camIdx][4], function () {
        var t = document.querySelector('.tile[data-pos="' + pos + '"]');
        if (t && state.wall[pos] === camIdx) { t.classList.remove("retrying"); t.classList.add("dead"); setStatus(camIdx, "offline"); }
      }, function (st) {
        var t = document.querySelector('.tile[data-pos="' + pos + '"]');
        if (!t || state.wall[pos] !== camIdx) return;
        if (st === "retrying") { t.classList.remove("dead"); t.classList.add("retrying"); }
        else if (st === "alive") {
          t.classList.remove("retrying"); t.classList.remove("dead");
          if (state.status[camIdx] !== "online") setStatus(camIdx, "online");
        }
      }, { delayMs: stagger ? Math.min(pos, 5) * 500 : 0 });
    })(p, ci);
    tile.addEventListener("click", function (e) {
      if (e.target.closest("[data-yt-recheck]")) { recheckTileYt(p); return; }
      if (e.target.closest("a")) return;
      if (e.target.closest("[data-expand]")) { loadMain(camIdxOf(p), { scroll: true }); }
      else if (e.target.closest("[data-remove]")) { removeFromWall(p); }
    });
  }
  if (old) {
    if (tileObserver) tileObserver.unobserve(old);
    wall.replaceChild(tile, old);
  } else {
    wall.appendChild(tile);
  }
  if (tileObserver) tileObserver.observe(tile);
  if (ci !== null && ci !== undefined && isYt(CAMS[ci])) mountTileYt(p, ci);
}
function camIdxOf(p) { return state.wall[p]; }
function addToWall(i, announce) {
  if (i < 0) return;
  if (state.wall.indexOf(i) !== -1) { if (announce) flashTile(state.wall.indexOf(i)); return; }
  var p = state.wall.indexOf(null);
  if (p === -1) {
    if (state.fsOpen) {
      // Fullscreen holds unlimited cameras: append instead of overwriting.
      p = state.wall.length;
      state.wall.push(null);
    } else {
      p = 0; // page wall is fixed-size: replace the first tile
    }
  }
  detachHls(state.tileHls[p], document.querySelector('.tile[data-pos="' + p + '"] video'));
  state.wall[p] = i;
  renderTile(p);
  highlightRow();
  updateAddWallBtn();
}
function removeFromWall(p) {
  detachHls(state.tileHls[p], document.querySelector('.tile[data-pos="' + p + '"] video'));
  delete state.tileHls[p];
  state.wall[p] = null;
  renderTile(p);
  highlightRow();
  updateAddWallBtn();
}
function flashTile(p) {
  var t = document.querySelector('.tile[data-pos="' + p + '"]');
  if (t) t.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
document.querySelector(".seg").addEventListener("click", function (e) {
  var b = e.target.closest("[data-cap]");
  if (!b) return;
  document.querySelectorAll(".seg button").forEach(function (x) { x.classList.toggle("on", x === b); });
  b.parentNode.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
  setCap(parseInt(b.getAttribute("data-cap"), 10));
});
function setCap(n) {
  // tear down all tile streams, then rebuild at the new size keeping the first n picks
  Object.keys(state.tileHls).forEach(function (p) { detachHls(state.tileHls[p], null); });
  var kept = state.wall.filter(function (x) { return x !== null && x !== undefined; }).slice(0, n);
  state.cap = n;
  state.wall = [];
  for (var p = 0; p < n; p++) state.wall.push(p < kept.length ? kept[p] : null);
  buildWall();
  highlightRow();
  updateAddWallBtn();
}
$("#fillWallBtn").addEventListener("click", function () {
  // first pass prefers cameras not known to be offline; second pass takes any match
  for (var pass = 0; pass < 2; pass++) {
    for (var p = 0; p < state.cap; p++) {
      if (state.wall[p] !== null && state.wall[p] !== undefined) continue;
      for (var i = 0; i < CAMS.length; i++) {
        if (!matches(i) || state.wall.indexOf(i) !== -1) continue;
        if (pass === 0 && state.status[i] === "offline") continue;
        detachHls(state.tileHls[p], null);
        state.wall[p] = i;
        renderTile(p);
        break;
      }
    }
  }
  highlightRow();
  updateAddWallBtn();
});
$("#clearWallBtn").addEventListener("click", function () {
  Object.keys(state.tileHls).forEach(function (p) {
    detachHls(state.tileHls[p], document.querySelector('.tile[data-pos="' + p + '"] video'));
  });
  state.wall = state.wall.map(function () { return null; });
  buildWall();
  highlightRow();
  updateAddWallBtn();
});
$("#wall").addEventListener("click", function (e) {
  var pick = e.target.closest("[data-pick]");
  if (!pick) return;
  // fill the empty tile with the camera currently in the main player, else the first match
  var p = parseInt(pick.getAttribute("data-pick"), 10);
  var cand = state.mainIdx;
  if (cand < 0 || state.wall.indexOf(cand) !== -1) {
    cand = -1;
    for (var i = 0; i < CAMS.length; i++) if (matches(i) && state.wall.indexOf(i) === -1) { cand = i; break; }
  }
  if (cand >= 0) { state.wall[p] = cand; renderTile(p); highlightRow(); updateAddWallBtn(); }
});

/* ---------------- wall power saving ----------------
   Wall tiles only decode while they can actually be seen. An
   IntersectionObserver suspends a tile's player when the tile scrolls
   out of view (a small margin resumes slightly before it reappears),
   and hiding the tab suspends every tile; both resume from the live
   edge when the tile is visible again. Suspending destroys the HLS
   instance, so an offscreen wall costs no bandwidth or CPU. YouTube
   tiles have no HLS handle and are left alone. */
var tileSeen = {}; // tile position -> currently near/in the viewport
var tileObserver = ("IntersectionObserver" in window) ? new IntersectionObserver(function (entries) {
  entries.forEach(function (en) {
    var p = parseInt(en.target.getAttribute("data-pos"), 10);
    tileSeen[p] = en.isIntersecting;
    applyTilePower(p);
  });
}, { rootMargin: "120px" }) : null;
function applyTilePower(p) {
  var h = state.tileHls[p];
  if (!h || !h.suspend) return;
  if (!document.hidden && tileSeen[p] !== false) h.resume();
  else h.suspend();
}
function applyAllTilePower() {
  Object.keys(state.tileHls).forEach(function (p) { applyTilePower(parseInt(p, 10)); });
}
document.addEventListener("visibilitychange", applyAllTilePower);

/* ---------------- map ----------------
   Basemap providers: the built-in Meta styles the map already used,
   plus public MapLibre style JSONs from OpenFreeMap and CARTO (all
   URLs reachability-checked when this was built). Switching destroys
   and remounts the map with the same pins; if an outside provider
   fails to load, the map falls back to the built-in street style
   instead of disappearing. */
var MAP_PROVIDERS = [
  { id: "meta-light", label: "Streets", group: "Meta (built-in)", baseStyle: "light" },
  { id: "meta-dark", label: "Dark", group: "Meta (built-in)", baseStyle: "dark" },
  { id: "meta-gray", label: "Grayscale", group: "Meta (built-in)", baseStyle: "grayscale" },
  { id: "meta-nolabels", label: "Streets, no labels", group: "Meta (built-in)", baseStyle: "light-no-labels" },
  { id: "meta-dark-nolabels", label: "Dark, no labels", group: "Meta (built-in)", baseStyle: "dark-no-labels" },
  { id: "ofm-liberty", label: "Liberty", group: "OpenFreeMap", customStyleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  { id: "ofm-positron", label: "Positron", group: "OpenFreeMap", customStyleUrl: "https://tiles.openfreemap.org/styles/positron" },
  { id: "ofm-bright", label: "Bright", group: "OpenFreeMap", customStyleUrl: "https://tiles.openfreemap.org/styles/bright" },
  { id: "carto-voyager", label: "Voyager", group: "CARTO", customStyleUrl: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" },
  { id: "carto-dark", label: "Dark Matter", group: "CARTO", customStyleUrl: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" },
  { id: "carto-positron", label: "Positron", group: "CARTO", customStyleUrl: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" }
];
var mapProviderId = null;
var mapPlaces = null;
function providerById(id) {
  for (var k = 0; k < MAP_PROVIDERS.length; k++) if (MAP_PROVIDERS[k].id === id) return MAP_PROVIDERS[k];
  return MAP_PROVIDERS[0];
}
function buildProviderOptions() {
  var sel = $("#mapProvider");
  var groups = {};
  MAP_PROVIDERS.forEach(function (p) {
    if (!groups[p.group]) {
      var og = document.createElement("optgroup");
      og.label = p.group;
      groups[p.group] = og;
      sel.appendChild(og);
    }
    var o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    groups[p.group].appendChild(o);
  });
  sel.addEventListener("change", function () { setMapProvider(sel.value); });
}
function setMapProvider(id) {
  if (id === mapProviderId) return;
  mapProviderId = id;
  $("#mapProvider").value = id;
  mountMapNow(providerById(id), false);
}
function mountMapNow(p, isRetry) {
  var el = $("#map");
  if (!window.MapHelpers || !window.HatchMaps) { showMapFallback(); return; }
  if (window.__mapHandle) {
    try { window.__mapHandle.destroy(); } catch (err) {}
    window.__mapHandle = null;
  }
  el.innerHTML = "";
  el.style.display = "";
  $("#mapFallback").hidden = true;
  var opts = {
    places: mapPlaces,
    center: { lat: -7.795, lng: 110.365 },
    zoom: 11,
    /* No marker callback on purpose: without one the map draws every
       pin on its WebGL canvas as a single circle layer — coloured per
       region from each place's color, YouTube pins badged — instead of
       ~680 separate DOM marker elements, which made panning and zooming
       sluggish in Chrome. Taps still select via onSelectPlace, and the
       hover tooltip below replaces the old pins' title text. */
    tooltip: function (feature) { return feature.properties.label; },
    onSelectPlace: function (index) {
      if (index === null || index === undefined) return;
      loadMain(index, { fromMap: true, scroll: true });
    }
  };
  if (p.customStyleUrl) opts.customStyleUrl = p.customStyleUrl;
  else opts.baseStyle = p.baseStyle;
  window.__mapHandle = MapHelpers.mountMap(el, opts, function () {
    if (!isRetry && p.id !== "meta-light") {
      mapProviderId = "meta-light";
      $("#mapProvider").value = "meta-light";
      mountMapNow(providerById("meta-light"), true);
    } else {
      showMapFallback();
    }
  });
  if (!window.__mapHandle) { showMapFallback(); return; }
  if (state.mainIdx >= 0) { try { window.__mapHandle.selectPlace(state.mainIdx); } catch (err) {} }
}
function initMap() {
  if (!window.MapHelpers || !window.HatchMaps) { showMapFallback(); return; }
  mapPlaces = [];
  CAMS.forEach(function (c, i) {
    if (!hasCoords(c)) return; // the JITV channel stream has no location pin
    mapPlaces.push({ label: c[0] + (isYt(c) ? " \u00b7 YouTube" : ""), lat: c[2], lng: c[3], color: GROUPS[c[1]].color, index: i, yt: isYt(c) });
  });
  buildProviderOptions();
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  mapProviderId = dark ? "meta-dark" : "meta-light";
  $("#mapProvider").value = mapProviderId;
  mountMapNow(providerById(mapProviderId), false);
}
function showMapFallback() {
  $("#map").style.display = "none";
  $("#mapFallback").hidden = false;
}

/* ---------------- boot ---------------- */
buildChips();
buildList();
applyFilter();
var startNames = ["Malioboro Nolkm Arah Timur", "Tugu (view dari atas)", "Titik Nol Kilometer (view Barat)", "Titik Nol Kilometer Alun-alun Wonosari", "Malioboro Nolkm Arah Utara"];
state.wall = [];
for (var p0 = 0; p0 < state.cap; p0++) state.wall.push(null);
startNames.slice(1).forEach(function (nm, k) {
  var i = findCam(nm);
  if (i !== -1) state.wall[k] = i;
});
buildWall();
var startMain = findCam(startNames[0]);
loadMain(startMain !== -1 ? startMain : 0);
highlightRow();
initMap();
/* The baked-in statuses are a snapshot and the cameras flap daily. A fresh
   open used to re-test all 464 HLS streams — about 930 requests at the portal
   in a few seconds, which from the portal's side looks like an attack —
   so now only the cameras actually on stage and on the wall are re-tested
   on open. The Recheck button still runs the full test on demand. Delayed
   so the players get first claim on the connection; the button stops it. */
setTimeout(function () {
  var onStage = [];
  if (state.mainIdx >= 0) onStage.push(state.mainIdx);
  state.wall.forEach(function (ci) {
    if (ci !== null && ci !== undefined && onStage.indexOf(ci) === -1) onStage.push(ci);
  });
  runRecheck(true, onStage);
}, 2500);
