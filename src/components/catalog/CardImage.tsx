"use client";

import * as React from "react";

/**
 * Product image with a graceful placeholder when missing or broken.
 * `eager` marks above-the-fold cells (first grid rows, the drawer) so the
 * browser prioritizes them; everything else stays lazy.
 */
export function CardImage({ src, alt, eager }: { src: string; alt: string; eager?: boolean }) {
  const [failed, setFailed] = React.useState(false);

  if (!src || failed) {
    return (
      <div className="grid aspect-square w-full place-items-center bg-surface-2 text-faint">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8">
          <path d="M3 16.5l5-5a2 2 0 0 1 2.8 0l5.2 5.2M14 14l1.5-1.5a2 2 0 0 1 2.8 0L21 15" />
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="9" r="1.4" />
        </svg>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote KicksDB image hosts are unknown ahead of time
    <img
      src={src}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : "auto"}
      decoding="async"
      className="aspect-square w-full bg-white object-contain"
      onError={() => setFailed(true)}
    />
  );
}
