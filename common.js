// index.html 的 P2P 逻辑
// 双端同代码,SDP 过滤与 QR 瘦身规则天然一致;角色只由扫码顺序决定

(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const localVideo = document.getElementById('localVideo');
  const remoteVideo = document.getElementById('remoteVideo');
  const qrCanvas = document.getElementById('qrCanvas');
  const scanModal = document.getElementById('scanModal');
  const scanVideo = document.getElementById('scanVideo');
  const scanStage = document.querySelector('.scan-stage');

  const state = {
    localStream: null,
    localStreamPromise: null,
    scanStream: null,
    scanTimer: null,
    scanStartedAt: 0,
    scanHintShown: false,
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

  // 扫码结果 -> 可用的 SDP 文本。
  // 带 O1/A1 前缀的是模板载荷,填回模板;其余一律当明文 SDP 原样返回
  // (兼容 GitHub Pages 10 分钟缓存期内还在跑旧版的页面)。
  // 刻意不 trim:归一化留给下面的 normalizeSdp,明文末尾的空白由它处理。
  function decodeScannedText(rawText) {
    const role = roleFromQrPayload(rawText);
    if (!role) {
      // 形如 O2,/A3, 的是本方案的载荷但版本不认识,不能当明文 SDP 吞掉
      if (/^[OA]\d,/.test(String(rawText || ''))) {
        throw new Error('不支持的二维码版本,请把两端页面都刷新到最新版');
      }
      return { sdp: String(rawText || ''), role: null };
    }

    const fields = parseQrPayload(rawText);
    // 首次渲染的码没有 ICE 候选。a=ice-options:trickle 在瘦身时已被删,
    // 所以无候选就是真连不上,明确挡住,别让对端以为扫到了可用的码。
    if (!fields.candidates.length) {
      throw new Error('二维码尚未就绪(还在收集 ICE),请等状态栏提示后再扫');
    }
    validateFields(role, fields);

    return { sdp: buildSdp(role, fields), role };
  }

  // 返回是否真的画出了二维码。调用点用它决定要不要报「就绪」——
  // 载荷超出容量时 qrcode 库是通过**回调**报错的(1.5.1 内部 try/catch 后转交回调),
  // 并不抛异常,所以必须靠这个标志判断,不能靠 try/catch。
  function renderQr(text) {
    if (!text) {
      const ctx = qrCanvas.getContext('2d');
      ctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
      return true;
    }

    let rendered = false;
    try {
      QRCode.toCanvas(qrCanvas, text, {
        // 画布分辨率(绘制缓冲像素),不是显示尺寸;显示尺寸由 #qrCanvas 的 CSS 决定
        width: 480,
        margin: 2,
        // 模板载荷只有 254 字符(明文是 919 B),有富余把纠错从 L(7%)提到 M(15%)
        errorCorrectionLevel: 'M',
        color: { dark: '#0f172a', light: '#ffffff' }
      }, (error) => {
        // 同步回调;失败时保持 rendered=false,让调用点别覆盖这里的失败提示
        if (error) {
          setStatus('二维码生成失败：' + error.message, false);
          return;
        }
        // qrcode@1.5.1 渲染时会写死 inline style width/height = 480px,
        // 盖掉 CSS 里 min(100%, 340px) 的响应式宽度,手机上因此超出容器。
        // 渲染成功后清掉 inline 值,把显示尺寸还给样式表(容器小则等比缩小)。
        qrCanvas.style.width = '';
        qrCanvas.style.height = '';
        rendered = true;
      });
    } catch (error) {
      // 兜底:库若在某些版本改为抛错(而不是走回调)
      console.error(error);
      setStatus('二维码生成失败：' + error.message, false);
      return false;
    }

    return rendered;
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

  // ---- SDP 模板化载荷 ----
  // 双端都跑 Chrome、都支持 opus + h264,所以整份瘦身 SDP 里只有十来个字段是变量,
  // 其余全是常量样板(见下方 buildSdp)。二维码里不放 SDP 文本,只放这些变量的值,
  // 接收端填回模板。实测:明文 919 B -> 载荷 254 字符,QR v25/117 模块 -> v11/61 模块。
  //
  // 前提与代价(模板过期时 setRemoteDescription 不会报错,是「连上了没画面」):
  //   - 候选骨架(typ host / network-cost 999)、foundation、priority 是 LAN_MODE 专有的;
  //   - 只支持 opus + h264 各一个变种;
  //   - 视频 fmtp 按 H264 取;音频 fmtp(opus 的 minptime 等)是可省配置,不传。
  // 在「两个 m 段、顺序为 audio → video」这个前提下,除候选行的 foundation/priority 外,
  // 重建结果与 slimSdpForQr 的输出逐行一致。段序不符时 extractTemplateFields 会直接报错。
  // 这条等价关系由 .tmp/verify.js 守着(gitignored,不随仓库分发)。
  const QR_PAYLOAD_VERSION = '1';
  const ROLE_PREFIX = { offer: 'O', answer: 'A' };
  const PREFIX_ROLE = { O: 'offer', A: 'answer' };

  // 候选行里不传输的常量部分。
  // foundation 与 priority 其实**不是**跨运行稳定的:同一份代码两次运行,Chrome
  // 给的 foundation 就不同(样本 4133793110,实跑 2708498856);priority 是
  // 类型/本地偏好/组件/传输的向量化编码,host 候选通常落在 2113937151。
  //
  // 硬编码安全,但理由要说准:对端确实会读到这些值 —— priority 参与 ICE 候选对的
  // 排序与冗余裁剪。问题在于**双端填的是同一组常量**,各自重建出的 SDP 完全一致,
  // 所以排序结果与真实值不同也依然是自洽的、能连通的;建连本身只依赖 ufrag/pwd +
  // host/port/协议。已在真实 Chrome 里走完 offer/answer 双向建连验证
  // (candidate-pair succeeded)。若将来出现多候选、且需要真实的优先级差异来决定
  // 选路(例如同时有 IPv4 与 IPv6),再把它们加进载荷。
  const CANDIDATE_FOUNDATION = '4133793110';
  const CANDIDATE_PRIORITY = '2113937151';

  // 每份载荷的有序字段,parse/build 两侧共用,避免两边字段顺序漂移。
  // candidates 是唯一变长字段,占 2*nCand 个位置,所以 nCand 单独传输。
  const PAYLOAD_FIELDS = [
    'sid',
    'nCand',
    'candidates',
    'ufrag',
    'icePwd',
    'fingerprint',
    'opusPT',
    'h264PT',
    'h264Fmtp',
    'audioMid',
    'videoMid',
    'dirs',
  ];

  // 方向行必须传输,不能写死成 sendrecv:
  // 应答端缺摄像头/麦克风时,Chrome 会把对应 m 段答成 recvonly —— 那是合法的单向通话,
  // 如实传过去对端就正常单向收流;写死 sendrecv 则会拼出一份谎报能力的 SDP。
  // slimSdpForQr 会删掉 a=sendrecv(它就是默认值),所以只有非默认方向才输出该行,
  // 这样重建结果仍与 slim 逐行一致。
  //
  // 两个 m 段的方向合成一个字段,每段一个字符 —— 写成 'sendrecv,sendrecv' 要多花
  // 15 个字符,足以把二维码顶到下一个版本。字符表:
  const DIRECTION_CODES = { sendrecv: '.', sendonly: 's', recvonly: 'r', inactive: 'i' };
  const CODE_DIRECTIONS = { '.': 'sendrecv', s: 'sendonly', r: 'recvonly', i: 'inactive' };
  const DEFAULT_DIRECTION = 'sendrecv';
  const DEFAULT_DIRECTION_CODE = DIRECTION_CODES[DEFAULT_DIRECTION];

  // 除 candidates 外每个字段都占 1 个位置
  const SCALAR_FIELD_COUNT = PAYLOAD_FIELDS.length - 1;

  const MID_FIELD = { audio: 'audioMid', video: 'videoMid' };
  // 方向打包成 'ar' 两个字符(音频在前、视频在后)
  const DIRECTION_SLOT = { audio: 0, video: 1 };

  function stripFingerprintColons(value) {
    return String(value || '').replace(/:/g, '').toUpperCase();
  }

  // 还原成 a=fingerprint 行里的冒号分隔大写十六进制;slim 没给指纹时返回空串,
  // 交给调用方报错,而不是拼出一个空指纹行
  function restoreFingerprintColons(value) {
    const hex = stripFingerprintColons(value);
    if (!hex) return '';
    if (!/^[0-9A-F]+$/.test(hex) || hex.length % 2) return '';
    return hex.match(/.{2}/g).join(':');
  }

  // 从浏览器真实(已过滤编码的)SDP 里抽出变量
  function extractTemplateFields(sdpText) {
    const lines = normalizeSdp(sdpText).split('\n');
    const obj = { candidates: [] };
    const dirs = [DEFAULT_DIRECTION_CODE, DEFAULT_DIRECTION_CODE];

    // 会话级字段在首个 m 段之前
    for (const line of lines) {
      if (line.startsWith('m=')) break;
      const sid = line.match(/^o=\S+ (\S+) /);
      if (sid) obj.sid = sid[1];
    }

    // 按 m 段切分。mid 与编码按段归属(不靠绝对行号),但**段序本身是有前提的**:
    // buildSdp 固定按 audio → video 输出,且 BUNDLE 行、dirs 的两个槽位都按这个顺序排。
    // Chrome 用 getUserMedia({audio,video}) 时两个 m 段不会颠倒,但协议并不保证,
    // 所以这里显式挡住颠倒的情况,而不是悄悄产出一份 mid 与 m 段错位的 SDP。
    const sections = [];
    let current = null;
    for (const line of lines) {
      if (line.startsWith('m=')) {
        current = { mediaType: line.slice(2).split(/\s+/)[0].toLowerCase(), body: [] };
        sections.push(current);
        continue;
      }
      if (current) current.body.push(line);
    }

    const order = sections.map((s) => s.mediaType).join(',');
    if (order !== 'audio,video') {
      throw new Error('SDP 的 m 段顺序为 ' + order + ',当前模板只支持 audio,video 的顺序');
    }

    sections.forEach((section, index) => {
      const { mediaType, body } = section;
      const find = (re) => body.find((l) => re.test(l));

      // 方向行有语义,必须照搬。a=sendrecv 是默认值(slimSdpForQr 会删掉它),
      // 其余三种(sendonly/recvonly/inactive)才实际出现在 SDP 里。
      const dirSlot = DIRECTION_SLOT[mediaType];
      if (dirSlot !== undefined) {
        const dirLine = body.find((l) => /^a=(?:sendonly|recvonly|inactive)$/.test(l));
        dirs[dirSlot] = dirLine ? DIRECTION_CODES[dirLine.slice(2)] : DEFAULT_DIRECTION_CODE;
      }

      const midLine = find(/^a=mid:/);
      const field = MID_FIELD[mediaType];
      if (midLine && field) obj[field] = midLine.slice('a=mid:'.length);

      const rtpmap = find(/^a=rtpmap:\d+\s+[^\s/]+/);
      const codec = rtpmap && rtpmap.match(/^a=rtpmap:(\d+)\s+([^\s/]+)/);
      const pt = codec && codec[1];
      const name = codec && codec[2].toLowerCase();

      // 该段的 fmtp 必须按 PT 匹配。音频段的 fmtp 是 opus 的 minptime/useinbandfec,
      // 是可省配置、不传输;串到 h264 上会丢掉 profile,协商不上就是没画面。
      if (mediaType === 'audio' && name === 'opus') {
        obj.opusPT = pt;
      } else if (mediaType === 'video' && name === 'h264') {
        obj.h264PT = pt;
        const fmtp = body.find((l) => l.startsWith('a=fmtp:' + pt + ' '));
        if (fmtp) obj.h264Fmtp = fmtp.replace(/^a=fmtp:\d+ /, '');
      }

      // ICE/DTLS 参数与候选都只认首个 m 段 —— BUNDLE 下两条 m 段值相同,
      // slimSdpForQr 也只保留首个 m 段的候选
      if (index !== 0) return;

      for (const line of body) {
        const m = line.match(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ host(?:\s|$)/);
        if (m) obj.candidates.push([m[1], m[2]]);
      }

      const ufrag = find(/^a=ice-ufrag:(\S+)/);
      if (ufrag) obj.ufrag = ufrag.slice('a=ice-ufrag:'.length);
      const pwd = find(/^a=ice-pwd:(\S+)/);
      if (pwd) obj.icePwd = pwd.slice('a=ice-pwd:'.length);
      const fp = find(/^a=fingerprint:\S+ .+$/);
      if (fp) {
        const m = fp.match(/^a=fingerprint:(\S+) (.+)$/);
        if (m) obj.fingerprint = stripFingerprintColons(m[2]);
      }
    });

    obj.dirs = dirs.join('');
    return obj;
  }

  // 模板缺失的变量必须挡住:宁可报错,也不要拼出一份能过 setRemoteDescription、
  // 却静默不通媒体的 SDP
  function validateFields(role, f) {
    // candidates 允许为空:ICE 收集完成前要渲染一次无候选的码(见 buildSdp)
    const required = PAYLOAD_FIELDS.filter((key) => key !== 'candidates');
    const missing = required.filter((key) => !f[key] && f[key] !== 0);
    if (missing.length) throw new Error('SDP 模板字段缺失: ' + missing.join(', '));

    // 编码不匹配时,接收端会按模板里的 opus/H264 名去解释 PT,协商不上就是没画面
    if (!f.opusPT) throw new Error('SDP 里没有 opus(本项目只支持 opus + h264)');
    if (!f.h264PT) throw new Error('SDP 里没有 h264(本项目只支持 opus + h264)');
    if (!restoreFingerprintColons(f.fingerprint)) throw new Error('fingerprint 格式非法');

    // 方向字段恰好两个字符,且每个都必须是合法方向码
    if (!f.dirs || f.dirs.length !== 2 || ![...f.dirs].every((c) => CODE_DIRECTIONS[c])) {
      throw new Error('方向字段非法: ' + f.dirs);
    }

    // setup 由角色决定(a=setup 不进载荷)
    if (role !== 'offer' && role !== 'answer') throw new Error('未知角色: ' + role);
  }

  // 把变量填回模板,还原成完整瘦身 SDP。
  // 输出刻意与 slimSdpForQr(realSdp) 逐行一致,便于 .tmp/verify.js 做归一化比对。
  function buildSdp(role, f) {
    // 首次渲染(ICE 收集未完成)没有候选,此时没有可填的候选行
    const candidates = Array.isArray(f.candidates) ? f.candidates : [];
    const candLines = candidates.map(
      ([host, port]) =>
        `a=candidate:${CANDIDATE_FOUNDATION} 1 udp ${CANDIDATE_PRIORITY} ${host} ${port} typ host generation 0 network-cost 999`
    );

    // BUNDLE 下 ice-ufrag/ice-pwd/fingerprint/setup 在每个 m 段都写一遍。
    // 这些是模板常量,重复不占载荷体积 —— 去重只在「整份 SDP 文本进二维码」
    // 的旧方案里才有意义,所以这里选择逐份写全:
    //   1. 重建结果与 slimSdpForQr 逐字节一致,校验脚本能做严格等价比对;
    //   2. 不必假设 BUNDLE 恒为单传输通道,少一个会静默失效的前提。
    const iceDtlsBlock = [
      `a=ice-ufrag:${f.ufrag}`,
      `a=ice-pwd:${f.icePwd}`,
      `a=fingerprint:sha-256 ${restoreFingerprintColons(f.fingerprint)}`,
      `a=setup:${role === 'offer' ? 'actpass' : 'active'}`,
    ];

    // a=sendrecv 是默认值,slimSdpForQr 会把它删掉,这里也只在非默认时才输出,
    // 重建结果才能与 slim 逐行对齐
    const dirs = String(f.dirs || DEFAULT_DIRECTION_CODE + DEFAULT_DIRECTION_CODE).split('');
    const dirLine = (slot) => {
      const direction = CODE_DIRECTIONS[dirs[slot]] || DEFAULT_DIRECTION;
      return direction === DEFAULT_DIRECTION ? [] : ['a=' + direction];
    };

    const audio = [
      `m=audio 9 UDP/TLS/RTP/SAVPF ${f.opusPT}`,
      'c=IN IP4 0.0.0.0',
      ...candLines,
      ...iceDtlsBlock,
      `a=mid:${f.audioMid}`,
      ...dirLine(0),
      'a=rtcp-mux',
      'a=rtcp-rsize',
      `a=rtpmap:${f.opusPT} opus/48000/2`,
    ];

    const video = [
      `m=video 9 UDP/TLS/RTP/SAVPF ${f.h264PT}`,
      'c=IN IP4 0.0.0.0',
      ...iceDtlsBlock,
      `a=mid:${f.videoMid}`,
      ...dirLine(1),
      'a=rtcp-mux',
      'a=rtcp-rsize',
      `a=rtpmap:${f.h264PT} H264/90000`,
      `a=fmtp:${f.h264PT} ${f.h264Fmtp}`,
    ];

    // 顺序是协议强制的:v= 之后必须紧跟 o=,再 s= t=
    return [
      'v=0',
      `o=- ${f.sid} 2 IN IP4 127.0.0.1`,
      's=-',
      't=0 0',
      `a=group:BUNDLE ${f.audioMid} ${f.videoMid}`,
      'a=extmap-allow-mixed',
      ...audio,
      ...video,
    ].join('\r\n') + '\r\n';
  }

  // 解析载荷。分隔符是逗号;没有字段会含逗号(ice-pwd 含 / 但不含逗号,
  // fmtp 用 ; 分隔,host/port/fingerprint 同理),所以直接按逗号切分即可。
  // candidates 是变长字段(2*nCand 个位置),靠显式传输的 nCand 定位。
  function parseQrPayload(text) {
    const body = String(text || '');
    const sep = body.indexOf(',');
    if (sep < 0) throw new Error('载荷缺少分隔符');

    const prefix = body.slice(0, sep);
    const parts = body.slice(sep + 1).split(',');
    const version = prefix.slice(1);

    if (version !== QR_PAYLOAD_VERSION) {
      throw new Error('不支持的二维码载荷版本: ' + version);
    }

    // nCand 可以为 0(ICE 收集完成前),所以下限是 SCALAR_FIELD_COUNT 而不是 +1
    if (parts.length < SCALAR_FIELD_COUNT) throw new Error('二维码载荷不完整');

    const nCand = Number(parts[PAYLOAD_FIELDS.indexOf('nCand')]);
    if (!Number.isInteger(nCand) || nCand < 0) throw new Error('候选数量非法');

    if (parts.length !== SCALAR_FIELD_COUNT + 2 * nCand) throw new Error('二维码载荷长度与候选数不符');

    const values = {};
    const candidates = [];
    let cursor = 0;
    for (const key of PAYLOAD_FIELDS) {
      if (key === 'candidates') {
        for (let i = 0; i < nCand; i += 1) {
          candidates.push([parts[cursor], parts[cursor + 1]]);
          cursor += 2;
        }
      } else {
        values[key] = parts[cursor];
        cursor += 1;
      }
    }
    values.candidates = candidates;
    values.nCand = nCand;

    // String.split 会原样保留空字段,所以能在这里挡住残缺载荷。
    // candidates 允许为空(ICE 收集完成前),nCand 是数字 0 也算有值,两者都排除。
    const blank = PAYLOAD_FIELDS.filter(
      (k) => k !== 'candidates' && k !== 'nCand' && !values[k]
    );
    if (blank.length) throw new Error('二维码载荷字段为空: ' + blank.join(', '));

    return values;
  }

  function formatQrPayload(role, sdpText) {
    const filtered = filterSdpCodecs(sdpText);
    const f = extractTemplateFields(filtered);
    f.candidates = f.candidates || [];
    f.nCand = f.candidates.length;
    validateFields(role, f);

    const body = PAYLOAD_FIELDS.reduce((acc, key) => {
      if (key === 'candidates') f.candidates.forEach(([host, port]) => acc.push(host, port));
      else acc.push(f[key]);
      return acc;
    }, []).join(',');

    return ROLE_PREFIX[role] + QR_PAYLOAD_VERSION + ',' + body;
  }

  // 载荷里的角色前缀同时充当版本标记:a=setup 不进载荷后,
  // inferTypeFromSdp 靠 a=setup 判类型就失效了,改用前缀
  function roleFromQrPayload(text) {
    const body = String(text || '');
    if (body.charAt(1) !== QR_PAYLOAD_VERSION) return null;
    return PREFIX_ROLE[body.charAt(0)] || null;
  }

  function buildQrPayload(sdpText, role) {
    return formatQrPayload(role, sdpText);
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
      if (scanStage) scanStage.classList.remove('success');
      state.scanStartedAt = Date.now();
      state.scanHintShown = false;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      state.scanStream = stream;
      scanVideo.srcObject = stream;
      setStatus('扫描中，请将对端二维码置于取景框内并保持稳定');

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

        // 一直扫不上时给一次明确提示,别让用户对着取景框干等、猜是否扫到了
        if (!code && !state.scanHintShown && Date.now() - state.scanStartedAt > 12000) {
          state.scanHintShown = true;
          setStatus('仍未识别到二维码，请靠近一点、正对屏幕并保持稳定', false);
        }

        if (code && code.data) {
          clearInterval(state.scanTimer);
          state.scanTimer = null;
          // 扫到了:先绿框定格 + 震动告知,再关窗回调。之前直接关窗一闪而过,
          // 用户无法确认到底扫没扫上(iOS Safari 不支持 vibrate,靠绿框兜底)
          if (scanStage) scanStage.classList.add('success');
          if (navigator.vibrate) navigator.vibrate(80);
          setTimeout(() => {
            // 定格期间用户手动关窗的,按放弃处理,不再回调
            if (scanModal.classList.contains('hidden')) return;
            closeScanner();
            onText(code.data);
          }, 450);
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

  // 页面脚本直接调用裸 setStatus(),这里补上全局别名
  window.setStatus = setStatus;

  window.P2P = {
    state,
    setStatus,
    normalizeSdp,
    decodeScannedText,
    roleFromQrPayload,
    extractTemplateFields,
    buildSdp,
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
