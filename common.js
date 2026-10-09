// host.html / guest.html 共享的 P2P 逻辑
// 双端同代码,SDP 过滤与 QR 瘦身规则天然一致

(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const localVideo = document.getElementById('localVideo');
  const remoteVideo = document.getElementById('remoteVideo');
  const qrCanvas = document.getElementById('qrCanvas');
  const scanModal = document.getElementById('scanModal');
  const scanVideo = document.getElementById('scanVideo');

  const state = {
    localStream: null,
    localStreamPromise: null,
    scanStream: null,
    scanTimer: null,
    peerConnection: null,
    resumeLocalPreview: false,
  };

  function setStatus(message, isSuccess = true) {
    statusEl.textContent = message;
    statusEl.style.color = isSuccess ? 'var(--green)' : 'var(--danger)';
    statusEl.style.background = isSuccess ? 'rgba(52, 211, 153, 0.09)' : 'rgba(248, 113, 113, 0.08)';
  }

  function normalizeSdp(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
  }

  function renderQr(text) {
    if (!text) {
      const ctx = qrCanvas.getContext('2d');
      ctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
      return;
    }

    QRCode.toCanvas(qrCanvas, text, {
      width: 480,
      margin: 2,
      errorCorrectionLevel: 'L',
      color: { dark: '#0f172a', light: '#ffffff' }
    }, (error) => {
      if (error) setStatus('二维码生成失败：' + error.message, false);
    });
  }

  // 只保留这些编码;同编码多变种(如多个 H264 profile)只留第一个,缩小 SDP
  const ALLOWED_CODECS = { audio: ['opus'], video: ['h264'] };

  // 局域网模式:host 候选直连即可,不配 STUN(不收集 srflx,ICE 收集快、SDP 更小);
  // 以后要跨网使用时改成 false
  const LAN_MODE = true;

  function filterSdpCodecs(sdpText) {
    const lines = normalizeSdp(sdpText).split('\n');
    const output = [];
    let mediaLines = [];

    function flushMedia() {
      if (!mediaLines.length) return;

      const headerParts = mediaLines[0].split(/\s+/);
      const mediaType = headerParts[0].replace(/^m=/, '').toLowerCase();
      const payloads = headerParts.slice(3);
      const codecByPayload = {};

      for (const line of mediaLines) {
        const m = line.match(/^a=rtpmap:(\d+)\s+([^\s/]+)/);
        if (m) codecByPayload[m[1]] = m[2].toLowerCase();
      }

      const allowed = ALLOWED_CODECS[mediaType] || [];
      const seen = new Set();
      let keptPayloads = payloads.filter((p) => {
        const codec = codecByPayload[p];
        if (!codec || !allowed.includes(codec) || seen.has(codec)) return false;
        seen.add(codec);
        return true;
      });

      // 浏览器不支持目标编码时(如无 H264)保留全部,避免 m= 行负载为空导致 SDP 非法
      if (!keptPayloads.length) keptPayloads = payloads;

      const keptSet = new Set(keptPayloads);
      output.push(headerParts.slice(0, 3).concat(keptPayloads).join(' '));

      for (const line of mediaLines.slice(1)) {
        const m = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)[\s:]/);
        // 只删与被移除编码关联的属性行;其余行(c= / a=candidate / a=ice-* 等)全部保留
        if (m && !keptSet.has(m[1])) continue;
        output.push(line);
      }

      mediaLines = [];
    }

    for (const line of lines) {
      if (line.startsWith('m=')) {
        flushMedia();
        mediaLines = [line];
        continue;
      }
      if (mediaLines.length) mediaLines.push(line);
      else output.push(line);
    }
    flushMedia();

    return output.filter(Boolean).join('\r\n') + '\r\n';
  }

  // 二维码专用瘦身:只保留建连与协商必需的行,控制 QR 容量(<2953 字节,Version 40-L 上限)
  function slimSdpForQr(sdpText) {
    const lines = normalizeSdp(sdpText).split('\n').filter(Boolean);
    const out = [];
    let mIndex = -1;
    let mediaType = '';

    for (const line of lines) {
      if (line.startsWith('m=')) {
        mIndex += 1;
        mediaType = line.slice(2).split(/\s+/)[0].toLowerCase();
        out.push(line);
        continue;
      }

      // 候选:BUNDLE 下每个 m 段重复同一批,只留第一个 m 段的;
      // 局域网只要 host(srflx/relay 是跨网才需要的)
      if (line.startsWith('a=candidate:')) {
        if (mIndex > 0) continue;
        if (LAN_MODE && !/ typ host(?: |$)/.test(line)) continue;
      }

      // rtcp 反馈(nack/nack pli/ccm fir/goog-remb/transport-cc):局域网丢包率低,全删
      if (line.startsWith('a=rtcp-fb:')) continue;

      // 音频 fmtp(opus 的 minptime/useinbandfec)是可省配置;视频 fmtp 是 h264 profile,必须保留
      if (mediaType === 'audio' && line.startsWith('a=fmtp:')) continue;

      // ssrc/msid 只用于 track 归属展示,接收端 ontrack 已做兜底
      if (/^a=(?:ssrc:|ssrc-group:|msid(?:-semantic)?)/.test(line)) continue;

      if (/^a=(?:extmap:|rtcp:|rtcp-xr:|rtcp-mux-only$|ice-options:|mslabel:|label:|sendrecv$)/.test(line)) continue;
      if (/^b=/.test(line)) continue;

      out.push(line);
    }

    return out.join('\r\n') + '\r\n';
  }

  function buildQrPayload(sdpText) {
    return slimSdpForQr(sdpText);
  }

  function createPeerConnection() {
    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }

    const pc = new RTCPeerConnection({
      // 局域网直连不需要 STUN;跨网时(LAN_MODE=false)用国内可达的 STUN,
      // google 的在国内手机网络基本不通
      iceServers: LAN_MODE ? [] : [
        { urls: ['stun:stun.chat.bilibili.com:3478', 'stun:stun.cloudflare.com:3478'] },
      ],
    });

    pc.ontrack = (event) => {
      // QR 瘦身版 SDP 删了 msid/ssrc,streams 可能为空,用 track 兜底组流
      if (event.streams && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
      } else {
        const stream = new MediaStream();
        stream.addTrack(event.track);
        remoteVideo.srcObject = stream;
      }
    };

    pc.onconnectionstatechange = () => {
      const status = pc.connectionState;
      if (status === 'connected') setStatus('P2P 连接已建立');
      else if (status === 'connecting') setStatus('P2P 连接中...');
      else if (status === 'failed') setStatus('P2P 连接失败', false);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) console.log('ICE candidate:', event.candidate.candidate);
    };

    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, state.localStream);
      });
    }

    state.peerConnection = pc;
    return pc;
  }

  async function ensureLocalStream() {
    if (state.localStream) return state.localStream;
    // 缓存在途 Promise:扫码恢复预览与建连并发调用时,避免重复 getUserMedia
    if (state.localStreamPromise) return state.localStreamPromise;

    state.localStreamPromise = navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    }).then((stream) => {
      state.localStream = stream;
      localVideo.srcObject = stream;
      state.localStreamPromise = null;
      return stream;
    });

    return state.localStreamPromise;
  }

  const ICE_GATHER_TIMEOUT_MS = 3000;

  // 等待 ICE 收集完成;超时则带着已收集到的候选继续,绝不无限死等
  function waitForGatheringComplete(peerConnection, timeoutMs = ICE_GATHER_TIMEOUT_MS) {
    if (peerConnection.iceGatheringState === 'complete') return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (completed) => {
        peerConnection.removeEventListener('icegatheringstatechange', listener);
        clearTimeout(timer);
        resolve(completed);
      };
      const listener = () => {
        if (peerConnection.iceGatheringState === 'complete') finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      peerConnection.addEventListener('icegatheringstatechange', listener);
    });
  }

  // offer 固定为 actpass;answer 是 active/passive
  function inferTypeFromSdp(sdpText) {
    const s = normalizeSdp(sdpText);
    if (/^a=setup:(?:active|passive)$/m.test(s)) return 'answer';
    if (/^a=setup:actpass$/m.test(s)) return 'offer';
    return null;
  }

  // openScanner 为了腾出摄像头会 stop 掉本地 track,但 sender 上挂的还是那批已 ended 的 track。
  // 不换回新 track,本端发出去的音视频就一直是死的(对端停在最后一帧)。
  // 同 kind 的 replaceTrack 不触发重新协商,所以建连后再扫码也能救回来。
  function rewireSenders() {
    const pc = state.peerConnection;
    if (!pc || !state.localStream) return;

    const fresh = {
      audio: state.localStream.getAudioTracks()[0] || null,
      video: state.localStream.getVideoTracks()[0] || null,
    };

    pc.getSenders().forEach((sender) => {
      const kind = sender.track && sender.track.kind;
      if (!kind || !fresh[kind]) return;
      sender.replaceTrack(fresh[kind]).catch((error) => {
        console.error('replaceTrack 失败:', error);
      });
    });
  }

  function closeScanner() {
    if (state.scanTimer) {
      clearInterval(state.scanTimer);
      state.scanTimer = null;
    }
    if (state.scanStream) {
      state.scanStream.getTracks().forEach((track) => track.stop());
      state.scanStream = null;
    }
    scanVideo.srcObject = null;
    scanModal.classList.add('hidden');

    if (state.resumeLocalPreview) {
      ensureLocalStream().then(() => {
        rewireSenders();
        setStatus('摄像头已恢复');
      }).catch((error) => {
        setStatus('恢复摄像头失败：' + error.message, false);
      });
      state.resumeLocalPreview = false;
    }
  }

  // 打开扫码窗口;扫到内容后回调 onText(字符串),扫码器自动关闭
  async function openScanner(onText) {
    try {
      if (state.localStream) {
        state.localStream.getTracks().forEach((track) => track.stop());
        state.localStream = null;
        localVideo.srcObject = null;
        state.resumeLocalPreview = true;
      } else {
        state.resumeLocalPreview = false;
      }

      scanModal.classList.remove('hidden');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      state.scanStream = stream;
      scanVideo.srcObject = stream;
      setStatus('扫描中，请对准对端二维码');

      state.scanTimer = setInterval(() => {
        const video = scanVideo;
        if (!video.videoWidth || !video.videoHeight) return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });

        if (code && code.data) {
          clearInterval(state.scanTimer);
          state.scanTimer = null;
          closeScanner();
          onText(code.data);
        }
      }, 500);
    } catch (error) {
      console.error(error);
      setStatus('扫码摄像头启动失败：' + error.message, false);
      closeScanner();
    }
  }

  // 供各角色页重置使用
  function resetAll() {
    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }
    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => track.stop());
      state.localStream = null;
    }
    if (remoteVideo.srcObject) {
      remoteVideo.srcObject.getTracks().forEach((track) => track.stop());
      remoteVideo.srcObject = null;
    }
    localVideo.srcObject = null;
    state.localStreamPromise = null;
    renderQr('');
  }

  // 视频全屏按钮(ios Safari 退回视频原生全屏)
  document.querySelectorAll('.fs-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const video = document.getElementById(btn.dataset.fsFor);
      if (!video) return;
      if (document.fullscreenElement === video) {
        document.exitFullscreen();
        return;
      }
      if (video.requestFullscreen) {
        video.requestFullscreen().catch(() => {});
      } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    });
  });

  window.addEventListener('beforeunload', () => {
    closeScanner();
    if (state.peerConnection) state.peerConnection.close();
    if (state.localStream) state.localStream.getTracks().forEach((track) => track.stop());
  });

  // 各角色页(offer/answer.html)直接调用裸 setStatus(),这里补上全局别名
  window.setStatus = setStatus;

  window.P2P = {
    state,
    setStatus,
    normalizeSdp,
    renderQr,
    filterSdpCodecs,
    slimSdpForQr,
    buildQrPayload,
    createPeerConnection,
    ensureLocalStream,
    waitForGatheringComplete,
    inferTypeFromSdp,
    openScanner,
    closeScanner,
    resetAll,
  };
})();
