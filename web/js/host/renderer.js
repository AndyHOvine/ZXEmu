import { CrtFilter, FILTER_DEFAULTS, FS_BEAM, FS_SCREEN } from './crtfilter.js';

// the parts of the frame buffer shown (704 x 288: each Spectrum pixel is two across, with 48
// pixels of border round the paper): normal has 32 of border at the sides and 24 above and below
export const CROPS = {
  normal: { x: 32, y: 24, w: 640, h: 240 },
  full: { x: 0, y: 0, w: 704, h: 288 },
  tight: { x: 80, y: 40, w: 544, h: 208 },
};

// a frame buffer pixel's width against its height: on a PAL TV a Spectrum pixel is 1.05
// times as wide as tall, and the frame buffer has two to a Spectrum pixel
export const PIXEL_ASPECT = { tv: 0.527, square: 0.5 };

export const CRT_DEFAULTS = {
  enabled: true,
  blur: 100,
  scanlineShade: 800,
  oddLinesPhase: 1125,
  oddLinesOffset: 1125,
  saturation: 1000,
  contrast: 1000,
  brightness: 1000,
  gamma: 2200,
  tint: 1000,
};

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS_DECODE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_fb;
uniform vec2 u_fbSize;
uniform vec2 u_origin;
uniform vec2 u_size;
uniform float u_lf;
uniform float u_sat;
uniform float u_tint;
uniform vec2 u_rot;
uniform float u_offs;

vec3 px(float x, float y, float odd) {
  vec3 c = texture2D(u_fb, (vec2(x, y) + 0.5) / u_fbSize).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec2 ch = vec2((c.b - l) * 0.564, (c.r - l) * 0.713) * u_sat;
  if (abs(ch.x) + abs(ch.y) > 0.001) ch.y += u_tint;
  if (odd > 0.5) ch = vec2(ch.x * u_rot.x - ch.y * u_rot.y, ch.x * u_rot.y + ch.y * u_rot.x) * u_offs;
  return vec3(l, ch);
}
vec2 chroma(float x, float y, float odd) {
  return (px(x - 2.0, y, odd).yz + px(x - 1.0, y, odd).yz +
          px(x, y, odd).yz + px(x + 1.0, y, odd).yz) * 0.25;
}
void main() {
  vec2 p = floor(v_uv * u_size) + u_origin;
  float odd = mod(p.y, 2.0);
  float y = px(p.x - 1.0, p.y, odd).x * u_lf +
            px(p.x, p.y, odd).x * (1.0 - 2.0 * u_lf) +
            px(p.x + 1.0, p.y, odd).x * u_lf;
  vec2 c = (chroma(p.x, p.y, odd) + chroma(p.x, p.y - 1.0, 1.0 - odd)) * 0.5;
  vec3 rgb = vec3(y + 1.402 * c.y, y - 0.344136 * c.x - 0.714136 * c.y, y + 1.772 * c.x);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

const FS_PLAIN = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_fb;
uniform vec2 u_fbSize;
uniform vec2 u_origin;
uniform vec2 u_size;
void main() {
  vec2 p = floor(v_uv * u_size) + u_origin;
  gl_FragColor = vec4(texture2D(u_fb, (p + 0.5) / u_fbSize).rgb, 1.0);
}`;

const FS_SCANLINES = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform vec2 u_outSize;
uniform float u_double;
uniform float u_rows;
uniform float u_shade;
uniform float u_bri;
uniform float u_con;
uniform float u_gam;

vec3 at(float x, float y) {
  return texture2D(u_src, (vec2(x, y) + 0.5) / u_srcSize).rgb;
}
vec3 curve(vec3 v) {
  return pow(max((v + u_bri) * u_con, 0.0), vec3(u_gam));
}
void main() {
  vec2 o = floor(v_uv * u_outSize);
  if (u_double < 0.5) { gl_FragColor = vec4(curve(at(o.x, o.y)), 1.0); return; }
  
  
  float sx = floor(o.x * 0.5), sy = floor(o.y / u_rows);
  bool oddX = mod(o.x, 2.0) > 0.5;
  vec3 a = at(sx, sy);
  if (oddX) a = (a + at(sx + 1.0, sy)) * 0.5;
  if (o.y - sy * u_rows >= ceil(u_rows * 0.5)) {
    vec3 b = at(sx, sy + 1.0);
    if (oddX) b = (b + at(sx + 1.0, sy + 1.0)) * 0.5;
    gl_FragColor = vec4(curve((a + b) * 0.5) * u_shade, 1.0);
  } else {
    gl_FragColor = vec4(curve(a), 1.0);
  }
}`;

const FS_PRESENT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform vec2 u_scale;
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 texel = uv * u_srcSize;
  vec2 base = floor(texel);
  vec2 d = fract(texel) - 0.5;
  vec2 range = max(0.5 - 0.5 / u_scale, 0.0);
  vec2 f = (d - clamp(d, -range, range)) * max(u_scale, 1.0) + 0.5;
  gl_FragColor = vec4(texture2D(u_src, (base + f) / u_srcSize).rgb, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.palette = 'standard';
    this.border = 'normal';
    this.window = null;
    this.aspect = 'tv';
    this.integerScale = false;
    this.crt = { ...CRT_DEFAULTS };
    this.filter = { ...FILTER_DEFAULTS };
    this.crtFilter = new CrtFilter();
    this.pixelScale = 1;
    this.dirty = true;
    this.fbW = 0; this.fbH = 0;
    this.viewport = { x: 0, y: 0, w: 1, h: 1 };
    this.gl = null;
    try { this.initGl(); } catch (e) { console.warn('WebGL unavailable, using 2D canvas', e); this.gl = null; }
    if (!this.gl) this.ctx2d = canvas.getContext('2d');
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; });
    canvas.addEventListener('webglcontextrestored', () => { this.initGl(); this.dirty = true; });
  }

  initGl() {
    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false }) ||
      this.canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) return;
    this.gl = gl;
    this.progDecode = program(gl, FS_DECODE);
    this.progPlain = program(gl, FS_PLAIN);
    this.progScan = program(gl, FS_SCANLINES);
    this.progPresent = program(gl, FS_PRESENT);
    this.progBeam = program(gl, FS_BEAM);
    this.progScreen = program(gl, FS_SCREEN);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.texFb = this.makeTex(gl.NEAREST);
    this.rtA = { tex: this.makeTex(gl.NEAREST), fbo: gl.createFramebuffer(), w: 0, h: 0 };
    this.rtB = { tex: this.makeTex(gl.LINEAR), fbo: gl.createFramebuffer(), w: 0, h: 0 };
    this.rtA2 = { tex: this.makeTex(gl.LINEAR), fbo: gl.createFramebuffer(), w: 0, h: 0 };
    this.rtBeam = { tex: this.makeTex(gl.LINEAR), fbo: gl.createFramebuffer(), w: 0, h: 0 };
    this.fbW = this.fbH = 0;
  }

  makeTex(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  sizeTarget(rt, w, h) {
    if (rt.w === w && rt.h === h) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, rt.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt.tex, 0);
    rt.w = w; rt.h = h;
  }

  configure(opts) {
    for (const k of ['palette', 'border', 'aspect', 'integerScale']) {
      if (opts[k] !== undefined) this[k] = opts[k];
    }
    if (opts.crt !== undefined) Object.assign(this.crt, typeof opts.crt === 'object' ? opts.crt : { enabled: !!opts.crt });
    if (opts.filter !== undefined) Object.assign(this.filter, typeof opts.filter === 'object' ? opts.filter : { enabled: !!opts.filter });
    this.dirty = true;
  }

  get crop() {
    if (this.border === 'none') return this.window || CROPS.tight;
    return CROPS[this.border] || CROPS.normal;
  }

  setWindow(win) {
    const full = CROPS.full;
    const x = Math.max(win.x, full.x), y = Math.max(win.y, full.y);
    const w = Math.min(win.x + win.w, full.x + full.w) - x;
    const h = Math.min(win.y + win.h, full.y + full.h) - y;
    if (w < 8 || h < 8) return;
    const cur = this.window;
    if (cur && cur.x === x && cur.y === y && cur.w === w && cur.h === h) return;
    this.window = { x, y, w, h };
    this.layout();
  }

  get displayAspect() {
    const c = this.crop;
    const par = PIXEL_ASPECT[this.aspect] || PIXEL_ASPECT.tv;
    return (c.w * par) / c.h;
  }

  layout() {
    const cw = this.canvas.width, ch = this.canvas.height;
    const aspect = this.displayAspect;
    let h = Math.min(ch, cw / aspect);
    if (this.integerScale) {
      const k = Math.floor(h / this.crop.h);
      if (k >= 1) h = k * this.crop.h;
    }
    const w = Math.round(h * aspect);
    h = Math.round(h);
    const y = this.alignTop ? ch - h : Math.floor((ch - h) / 2);
    this.viewport = { x: Math.floor((cw - w) / 2), y, w, h };
  }

  resize(cssW, cssH, dpr) {
    this.pixelScale = dpr;
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dirty = true;
  }

  draw(fb, lineWidth, lines, win) {
    if (this.border === 'none' && win) this.setWindow(win);
    if (this.dirty) {
      this.layout();
      this.dirty = false;
    }
    if (this.gl) this.drawGl(fb, lineWidth, lines);
    else this.draw2d(fb, lineWidth);
  }

  drawGl(fb, lineWidth, lines) {
    const gl = this.gl;
    const crop = this.crop;
    const bytes = new Uint8Array(fb.buffer, fb.byteOffset, lineWidth * lines * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.texFb);
    if (this.fbW !== lineWidth || this.fbH !== lines) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lineWidth, lines, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      this.fbW = lineWidth; this.fbH = lines;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, lineWidth, lines, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }

    const vp = this.viewport;
    const c = this.crt;
    let final;

    const crtOn = c.enabled;
    const decode = crtOn ? this.progDecode : this.progPlain;
    const rtA = crtOn ? this.rtA : this.rtA2;
    this.sizeTarget(rtA, crop.w, crop.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rtA.fbo);
    gl.viewport(0, 0, crop.w, crop.h);
    gl.useProgram(decode.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texFb);
    gl.uniform1i(decode.u.u_fb, 0);
    gl.uniform2f(decode.u.u_fbSize, lineWidth, lines);
    gl.uniform2f(decode.u.u_origin, crop.x, crop.y);
    gl.uniform2f(decode.u.u_size, crop.w, crop.h);
    if (crtOn) {
      const phase = ((c.oddLinesPhase - 1000) * 0.045 * Math.PI) / 180;
      gl.uniform1f(decode.u.u_lf, Math.floor((64 * c.blur) / 1000) / 255);
      gl.uniform1f(decode.u.u_sat, c.saturation / 1000);
      gl.uniform1f(decode.u.u_tint, ((c.tint * 50) / 2000 - 25) / 255);
      gl.uniform2f(decode.u.u_rot, Math.cos(phase), Math.sin(phase));
      gl.uniform1f(decode.u.u_offs, c.oddLinesOffset / 1000);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    final = rtA;

    if (crtOn) {
      const rows = Math.max(2, Math.floor(vp.h / crop.h));
      const dbl = c.scanlineShade < 1000 && vp.h >= crop.h * 2;
      const ow = dbl ? crop.w * 2 : crop.w, oh = dbl ? crop.h * rows : crop.h;
      this.sizeTarget(this.rtB, ow, oh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtB.fbo);
      gl.viewport(0, 0, ow, oh);
      const s = this.progScan;
      gl.useProgram(s.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rtA.tex);
      gl.uniform1i(s.u.u_src, 0);
      gl.uniform2f(s.u.u_srcSize, crop.w, crop.h);
      gl.uniform2f(s.u.u_outSize, ow, oh);
      gl.uniform1f(s.u.u_double, dbl ? 1 : 0);
      gl.uniform1f(s.u.u_rows, rows);
      gl.uniform1f(s.u.u_shade, c.scanlineShade / 1000);
      gl.uniform1f(s.u.u_bri, ((c.brightness - 1000) * 128) / 1000 / 255);
      gl.uniform1f(s.u.u_con, c.contrast / 1000);
      gl.uniform1f(s.u.u_gam, c.gamma / 1000 / 2.8);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      final = this.rtB;
    }

    if (this.filter.enabled) {
      this.drawFilter(final, crop);
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
    const pr = this.progPresent;
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, final.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(pr.u.u_src, 0);
    gl.uniform2f(pr.u.u_srcSize, final.w, final.h);
    gl.uniform2f(pr.u.u_scale, vp.w / final.w, vp.h / final.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  drawFilter(final, crop) {
    const gl = this.gl;
    const vp = this.viewport;
    const p = this.crtFilter.params(this.filter, vp.w, vp.h, final.w, final.h,
      final.w / crop.w, final.h / crop.h, this.pixelScale, true);
    let picture = final;

    if (p.beamPass) {
      this.sizeTarget(this.rtBeam, final.w, final.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtBeam.fbo);
      gl.viewport(0, 0, final.w, final.h);
      const b = this.progBeam;
      gl.useProgram(b.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, final.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(b.u.u_frame, 0);
      gl.uniform4fv(b.u['u_beam[0]'], p.beam);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      picture = this.rtBeam;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
    const s = this.progScreen;
    gl.useProgram(s.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, picture.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(s.u.u_src, 0);
    gl.uniform2f(s.u.u_srcSize, picture.w, picture.h);
    gl.uniform2f(s.u.u_scale, vp.w / picture.w, vp.h / picture.h);
    gl.uniform2f(s.u.u_rectGl, vp.x, vp.y + vp.h - 1);
    gl.uniform4fv(s.u['u_screen[0]'], p.screen);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  draw2d(fb, lineWidth) {
    const ctx = this.ctx2d;
    if (!ctx) return;
    const crop = this.crop;
    if (!this.image || this.image.width !== crop.w || this.image.height !== crop.h) {
      this.image = new ImageData(crop.w, crop.h);
      this.offscreen = document.createElement('canvas');
      this.offscreen.width = crop.w; this.offscreen.height = crop.h;
    }
    const px = new Uint32Array(this.image.data.buffer);
    let o = 0;
    for (let y = 0; y < crop.h; y++) {
      const i = (crop.y + y) * lineWidth + crop.x;
      px.set(fb.subarray(i, i + crop.w), o);
      o += crop.w;
    }
    this.offscreen.getContext('2d').putImageData(this.image, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    const vp = this.viewport;
    ctx.drawImage(this.offscreen, vp.x, this.canvas.height - vp.y - vp.h, vp.w, vp.h);
  }
}
