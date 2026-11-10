export function saveFields(obj, skip = []) {
  const s = {};
  for (const [k, v] of Object.entries(obj)) {
    if (skip.includes(k)) continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') s[k] = v;
    else if (ArrayBuffer.isView(v)) s[k] = v.slice();
    else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) s[k] = v.slice();
  }
  return s;
}

export function loadFields(obj, s) {
  for (const [k, v] of Object.entries(s)) {
    const cur = obj[k];
    if (cur && typeof cur === 'object' && !ArrayBuffer.isView(cur) && !Array.isArray(cur)) continue;
    if (ArrayBuffer.isView(cur) && ArrayBuffer.isView(v) && cur.length === v.length && cur.constructor === v.constructor) cur.set(v);
    else obj[k] = ArrayBuffer.isView(v) || Array.isArray(v) ? v.slice() : v;
  }
}
