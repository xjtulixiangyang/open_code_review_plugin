import type { ReviewContext } from '../model/request.js';

export function resolveContextRef(ctx: ReviewContext): string | undefined {
  if (ctx.range === 'workspace' || ctx.range === 'staged') return undefined;
  if (ctx.range.startsWith('commit:')) {
    const ref = ctx.range.slice('commit:'.length).trim();
    return ref || undefined;
  }
  const idx = ctx.range.indexOf('..');
  if (idx !== -1) {
    const to = ctx.range.slice(idx + 2).trim();
    return to || undefined;
  }
  const trimmed = ctx.range.trim();
  return trimmed || undefined;
}
