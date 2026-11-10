export const FILTER_DEFAULTS = {
  enabled: true,
  scale: 1,
  everyNLines: 4,
  linesDarkened: 3,
  darkness: 10,
  direction: 'rows',
  bulge: 8,
  corners: 17,
  cornerDot: 2,
  bleed: 12,
  glow: 5,
  mask: 3,
  maskShape: 'dots',
  maskWidth: 3,
  tintColor: '#ffb000',
  tint: 6,
  roll: -1,
  rollingBar: 0,
};

export const FILTER_RANGES = {
  scale: [1, 4], everyNLines: [2, 8], linesDarkened: [1, 4], darkness: [0, 100],
  bulge: [0, 100], corners: [0, 100], cornerDot: [0, 4], bleed: [0, 100], glow: [0, 100],
  mask: [0, 100], maskWidth: [1, 4], tint: [0, 100], roll: [-8, 8], rollingBar: [0, 100],
};

export const MASK_SHAPES = ['stripes', 'stripes-gaps', 'slots', 'dots'];

export const FS_BEAM = `
precision highp float;
uniform sampler2D u_frame;
uniform vec4 u_beam[2];
vec3 at(vec2 t, vec2 o) {
  return texture2D(u_frame, t + o * u_beam[0].xy).rgb;
}
void main() {
  vec2 t = (floor(gl_FragCoord.xy) + 0.5) * u_beam[0].xy;
  vec2 sx = vec2(u_beam[0].z, 0.0);
  vec2 sy = vec2(0.0, u_beam[0].w);
  vec2 a = u_beam[1].w > 0.5 ? sx : sy;
  vec2 b = u_beam[1].w > 0.5 ? sy : sx;
  vec3 c = at(t, vec2(0.0, 0.0));
  vec3 col = (c + (at(t, a) + at(t, -a)) * u_beam[1].x
                + (at(t, b) + at(t, -b)) * u_beam[1].y)
             / (1.0 + 2.0 * (u_beam[1].x + u_beam[1].y));
  vec3 light = vec3(0.0);
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      if (x != 0 || y != 0) {
        light += max(at(t, float(x) * sx + float(y) * sy) - c, 0.0) / (1.0 + float(x * x + y * y));
      }
    }
  }
  gl_FragColor = vec4(col + light * u_beam[1].z, 1.0);
}`;

export const FS_SCREEN = `
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform vec2 u_scale;
uniform vec2 u_rectGl;      
uniform vec4 u_screen[8];

float wrap(float v, float period) {
  return v - period * floor((v + 0.5) / period);
}

vec3 picture(vec2 uv) {
  vec2 texel = uv * u_srcSize;
  vec2 base = floor(texel);
  vec2 d = fract(texel) - 0.5;
  vec2 range = max(0.5 - 0.5 / u_scale, 0.0);
  vec2 f = (d - clamp(d, -range, range)) * max(u_scale, 1.0) + 0.5;
  return texture2D(u_src, (base + f) / u_srcSize).rgb;
}

void main() {
  vec4 rect = u_screen[0];
  vec4 glass = u_screen[1];
  vec4 scan = u_screen[2];
  vec4 phosphor = u_screen[3];
  vec4 tint = u_screen[4];
  vec4 bar = u_screen[5];
  vec4 pattern = u_screen[6];
  vec4 cornerDot = u_screen[7];
  vec2 p = vec2(floor(gl_FragCoord.x) - u_rectGl.x, u_rectGl.y - floor(gl_FragCoord.y));
  vec2 halfSize = rect.zw * 0.5;
  vec2 d = p + 0.5 - halfSize;
  vec2 uv = d / halfSize;
  vec2 s = uv * ((1.0 + glass.x * dot(uv, uv)) * glass.y);
  vec3 c = picture(s * 0.5 + 0.5);
  vec2 corner = abs(d) - (halfSize - glass.z);
  float lit = 1.0;
  if (max(abs(s.x), abs(s.y)) > 1.0 || (corner.x > 0.0 && corner.y > 0.0 && dot(corner, corner) > glass.w)) {
    lit = 0.0;
  }
  
  vec2 dotOffset = halfSize - abs(d) - cornerDot.xy;
  if (dot(dotOffset, dotOffset) < pattern.w) lit = 1.0;
  float along = phosphor.y > 0.5 ? p.y : p.x;
  float across = phosphor.y > 0.5 ? p.x : p.y;
  if (wrap(along - scan.w, scan.x) < scan.y) c *= scan.z;
  float u = floor((across + 0.5) / pattern.x);
  float v = floor((along + 0.5) / pattern.x);
  float w = phosphor.z;
  float column = floor((u + 0.5) / w);
  float ph = wrap(column, 3.0);
  if (phosphor.w > 2.5) {
    float band = wrap(floor((v + 0.5) / w), 2.0);
    ph = wrap(floor((u + band * pattern.y + 0.5) / w), 3.0);
  } else if (phosphor.w > 1.5) {
    float triad = floor((u + 0.5) / (3.0 * w));
    if (wrap(v + triad * 2.0 * w, 4.0 * w) > 3.0 * w - 0.5) ph = 3.0;
  } else if (phosphor.w > 0.5) {
    ph = wrap(column, 4.0);
  }
  vec3 own = vec3(ph < 0.5 ? 1.0 : 0.0, ph > 0.5 && ph < 1.5 ? 1.0 : 0.0, ph > 1.5 && ph < 2.5 ? 1.0 : 0.0);
  c *= (1.0 - phosphor.x) + phosphor.x * own;
  c *= tint.rgb;
  float db = abs(along + 0.5 - bar.y);
  db = min(db, bar.w - db);
  c += (1.0 - c) * (bar.x * clamp(1.0 - db / bar.z, 0.0, 1.0));
  gl_FragColor = vec4(c * lit, 1.0);
}`;

function isLit(x, y, hx, hy, k, radius) {
  const dx = x - hx, dy = y - hy;
  const u = dx / hx, v = dy / hy;
  const f = (1 + k * (u * u + v * v)) / (1 + k);
  const cx = Math.abs(dx) - (hx - radius), cy = Math.abs(dy) - (hy - radius);
  return Math.abs(u * f) <= 1 && Math.abs(v * f) <= 1 && !(cx > 0 && cy > 0 && cx * cx + cy * cy > radius * radius);
}

function darkCornerReach(width, height, k, radius) {
  const hx = width * 0.5, hy = height * 0.5, len = Math.hypot(hx, hy);
  for (let t = 0; t < len; t += 0.25) {
    if (isLit((t * hx) / len, (t * hy) / len, hx, hy, k, radius)) return t;
  }
  return len;
}

function clampSetting(f, key) {
  const r = FILTER_RANGES[key];
  const v = Math.round(Number(f[key]));
  return Number.isFinite(v) ? Math.max(r[0], Math.min(r[1], v)) : FILTER_DEFAULTS[key];
}

export class CrtFilter {
  constructor() {
    this.lineRoll = 0;
    this.barRoll = 0;
    this.reachKey = '';
    this.reach = 0;
  }

  params(f, width, height, picW, picH, texelsX, texelsY, pixelScale, advance) {
    const g = (k) => clampSetting(f, k);
    const pct = (k) => g(k) / 100;
    const rows = f.direction !== 'columns';
    const bleed = pct('bleed');
    const beam = [
      1 / picW, 1 / picH, texelsX, texelsY,
      bleed, bleed * 0.35, pct('glow') * 0.5, rows ? 1 : 0,
    ];
    const extent = rows ? height : width;
    const step = advance ? g('roll') : 0;
    const scale = g('scale') * Math.max(1, Math.round(pixelScale));
    let period = g('everyNLines');
    let dark = Math.min(g('linesDarkened'), period - 1);
    period *= scale;
    dark *= scale;
    const stripe = g('maskWidth');
    const k = pct('bulge') * 0.5;
    const radius = pct('corners') * Math.min(width, height) * 0.5;

    const dot = g('cornerDot') * scale;
    const key = `${width},${height},${k},${radius}`;
    if (key !== this.reachKey) {
      this.reachKey = key;
      this.reach = darkCornerReach(width, height, k, radius);
    }
    let dotX = 0, dotY = 0, dotRadius2 = 0;
    const gap = scale;
    if (dot > 0 && this.reach >= dot + gap + 2) {
      const len = Math.hypot(width, height);
      const t = this.reach - gap - dot / 2;
      const snap = (v) => (dot & 1 ? Math.floor(v) + 0.5 : Math.round(v));
      dotX = snap((t * width) / len);
      dotY = snap((t * height) / len);
      dotRadius2 = (dot * dot) / 4 + 0.01;
    }

    this.lineRoll = (((this.lineRoll + step) % period) + period) % period;
    this.barRoll = (this.barRoll + step) % extent;
    const barCentre = (extent * 0.3 + this.barRoll + extent) % extent;

    const tintRgb = parseInt(String(f.tintColor || '#ffb000').replace('#', ''), 16) || 0;
    const tint = pct('tint');
    const ch = (shift) => 1 + (((tintRgb >> shift) & 0xFF) / 255 - 1) * tint;
    const shape = Math.max(0, MASK_SHAPES.indexOf(f.maskShape));

    const screen = [
      0, 0, width, height,
      k, 1 / (1 + k), radius, radius * radius,
      period, dark - 0.5, 1 - pct('darkness'), this.lineRoll,
      pct('mask'), rows ? 1 : 0, stripe, shape,
      ch(16), ch(8), ch(0), 1,
      pct('rollingBar'), barCentre, Math.max(extent / 8, 1), extent,
      scale, Math.floor((3 * stripe + 1) / 2), 0, dotRadius2,
      dotX, dotY, 0, 0,
    ];
    return { beamPass: g('bleed') > 0 || g('glow') > 0, beam, screen };
  }
}
