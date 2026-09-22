export const parseTags = text => [...new Set(text.split(/[\s,]+/u).map(t => t.replace(/^#+/,'').trim()).filter(Boolean))];
