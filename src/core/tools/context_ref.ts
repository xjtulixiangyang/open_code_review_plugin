import type { ReviewContext } from '../model/request.js';

export function resolveContextRef(ctx: ReviewContext): string | undefined {
  if (ctx.range === 'workspace' || ctx.range === 'staged') return undefined;
  if (ctx.range.startsWith('commit:')) {
    const ref = ctx.range.slice('commit:'.length).trim();
    return ref || undefined;
  }
  const threeDotIdx = ctx.range.lastIndexOf('...');
  if (threeDotIdx !== -1) {
    const to = ctx.range.slice(threeDotIdx + 3).trim();
    return to || undefined;
  }
  const twoDotIdx = ctx.range.lastIndexOf('..');
  if (twoDotIdx !== -1) {
    const to = ctx.range.slice(twoDotIdx + 2).trim();
    return to || undefined;
  }
  const trimmed = ctx.range.trim();
  return trimmed || undefined;
}
