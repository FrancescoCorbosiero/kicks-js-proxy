/**
 * SKUs a live publish is working on right now, in this process.
 *
 * A request the proxy in front gave up on (Cloudflare answers 524 after 100
 * seconds) keeps running here, and the operator's natural next move is to
 * publish the same SKUs again. Two calls creating one SKU both pass the live
 * lookup before either creates — exactly the duplicate parent that lookup
 * exists to prevent. So a SKU already in flight is skipped instead, and the
 * photo queue leaves it alone until its publish is over. One app container per
 * shop (docs/deploy.md): this process is the whole picture. On globalThis
 * because route, action and instrumentation bundles each get their own copy of
 * this module.
 */
export const publishing = ((globalThis as { __storeHubPublishing?: Set<string> }).__storeHubPublishing ??=
  new Set<string>());
