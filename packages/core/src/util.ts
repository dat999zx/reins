import picomatch from 'picomatch';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function isValidGlob(glob: string): boolean {
  if (!glob || typeof glob !== 'string') return false;
  let inBracket = false;
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '\\') {
      i++;
      continue;
    }
    if (glob[i] === '[') {
      if (inBracket) return false;
      inBracket = true;
    } else if (glob[i] === ']') {
      if (!inBracket) return false;
      inBracket = false;
    }
  }
  if (inBracket) return false;
  try {
    const re = picomatch.makeRe(glob, { strictSlashes: true });
    return re instanceof RegExp;
  } catch {
    return false;
  }
}
