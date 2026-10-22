export function compareVersions(left, right) {
  const a = String(left).replace(/^[≤≥]/, '').split(/[.-]/).map(value => Number.parseInt(value, 10) || 0);
  const b = String(right).replace(/^[≤≥]/, '').split(/[.-]/).map(value => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

export function compatibilityReasons(record, browsers, targets) {
  if (!record) return [];
  const labels = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari' };
  const reasons = [];
  for (let index = 0; index < browsers.length; index++) {
    const support = record[index];
    if (!support) continue;
    const [added, removed, partial, prefix, flags] = support;
    const browser = browsers[index];
    const target = String(targets[browser]);
    const label = labels[browser] || browser;
    if (added === false) {
      reasons.push(`${label} ${target}: unsupported`);
      continue;
    }
    if (typeof added === 'string') {
      const earlyBound = added.startsWith('≤');
      if (/^(?:≤|≥)?\d/.test(added) && !earlyBound && compareVersions(target, added) < 0) {
        reasons.push(`${label} ${target}: added in ${added}`);
        continue;
      }
    }
    if (typeof removed === 'string' && /^(?:≤|≥)?\d/.test(removed) && compareVersions(target, removed) >= 0) {
      reasons.push(`${label} ${target}: removed in ${removed}`);
      continue;
    }
    if (prefix) reasons.push(`${label} ${target}: requires the ${prefix} prefix`);
    else if (flags) reasons.push(`${label} ${target}: requires a browser flag`);
    else if (partial) reasons.push(`${label} ${target}: partial implementation`);
  }
  return reasons;
}
