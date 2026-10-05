/**
 * The photo queue's planner: what to do next for one product, from its job
 * and the product as the store has it right now.
 *
 * Why a queue at all: WordPress downloads every photo and cuts it into every
 * thumbnail size inside the request that attaches it, so a product created
 * with its photos was a slow create — the slow half of a first import. The
 * Publisher now creates products hidden (a draft) and without photos, and the
 * queue attaches them in the background, one photo per request. The product
 * goes on sale with its first photo, never before.
 *
 * Stateless on purpose. Every photo is filed under a name of its own (the
 * SKU, its position and the job's token), and the product's photo list is the
 * only record of what is attached. A request whose answer was lost — a
 * timeout, Cloudflare's 524 — is never sent again blind: the next look at the
 * product says whether the photo landed. Sending it again would put the same
 * picture in the media library twice.
 *
 * Pure module: no client, no DB.
 */

/** One photo of a job: where WordPress downloads it from, and the name it is filed under. */
export interface MediaImage {
  src: string;
  name: string;
}

/** The job, as the planner sees it. */
export interface MediaJobView {
  images: MediaImage[];
  /** Positions the store refused for good (a dead link, not an image): never sent again. */
  skipped: number[];
  /** Put the product on sale once it has a photo: the Publisher's hidden creates. */
  publish: boolean;
  /** Replace the photos it has (a force reimport with new media) instead of only filling an empty product. */
  replace: boolean;
  /** Alt text for every photo: the product's name. */
  alt: string;
}

/** The live product, narrowed to what the planner looks at. */
export interface MediaLiveProduct {
  status: string | null | undefined;
  images: { id?: number | null; name?: string | null }[];
  /** Sizes it has. A product with none sells nothing, so it is not put on sale. */
  variations: number;
}

export type MediaStep =
  /** Send this body: one more photo, and the status when it goes on sale with it. */
  | { kind: "attach"; index: number; body: Record<string, unknown> }
  /** The photos are on; only the status is left. */
  | { kind: "publish"; body: { status: "publish" } }
  /** Nothing to do until the product has sizes. */
  | { kind: "waitForSizes" }
  /** No photo the store will take, and the product has none: it stays hidden. */
  | { kind: "noPhoto" }
  | { kind: "done" };

/** The name a job's photo is filed under: "DD1391-100-1-k3f9q2". */
export function mediaName(sku: string, index: number, token: string): string {
  return `${sku}-${index + 1}-${token}`;
}

/** A job's photos, main first, each under its own name. */
export function mediaImages(sku: string, urls: string[], token: string): MediaImage[] {
  return urls.map((src, i) => ({ src, name: mediaName(sku, i, token) }));
}

/**
 * WordPress hands a title back texturized and HTML-escaped ("&#8211;" for a
 * dash), so two names are compared on their letters and digits only.
 */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&#?[a-z0-9]+;/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Which of the job's photos the product carries, by position. */
export function photosOn(job: Pick<MediaJobView, "images">, live: Pick<MediaLiveProduct, "images">): boolean[] {
  const keys = new Set(live.images.map((i) => nameKey(i.name ?? "")));
  return job.images.map((img) => keys.has(nameKey(img.name)));
}

/** Draft and pending: the statuses a hidden create can be in, and the queue may publish from. */
export function isHidden(status: string | null | undefined): boolean {
  return status === "draft" || status === "pending";
}

const PUBLISH = { kind: "publish", body: { status: "publish" } } as const;

/** The next thing to do for a product, or that there is nothing left. */
export function nextMediaStep(job: MediaJobView, live: MediaLiveProduct): MediaStep {
  const ours = photosOn(job, live);
  const oursOn = ours.filter(Boolean).length;
  const ourKeys = new Set(job.images.map((img) => nameKey(img.name)));
  const others = live.images.filter((i) => !ourKeys.has(nameKey(i.name ?? ""))).length;
  const goesOnSale = job.publish && isHidden(live.status);

  // A product without sizes sells nothing: it is not put on sale, and its
  // photos wait with it — it may yet be completed, or removed.
  if (goesOnSale && live.variations === 0) return { kind: "waitForSizes" };

  // Filling a product that already has photos someone else put there (by
  // hand, or before this job): theirs stand.
  if (!job.replace && oursOn === 0 && others > 0) return goesOnSale ? PUBLISH : { kind: "done" };

  const index = job.images.findIndex((_, i) => !ours[i] && !job.skipped.includes(i));
  if (index === -1) {
    if (live.images.length === 0) return { kind: "noPhoto" };
    return goesOnSale ? PUBLISH : { kind: "done" };
  }

  const image: Record<string, unknown> = { src: job.images[index].src, name: job.images[index].name };
  if (job.alt) image.alt = job.alt;
  const body: Record<string, unknown> = {
    // The job's first photo becomes the main one, replacing what was there on
    // a reimport. Later ones go behind the photos the product has, restated by
    // id: Woo takes the list as the whole gallery and drops what it omits.
    images:
      oursOn === 0
        ? [image]
        : [...live.images.filter((i) => i.id != null).map((i) => ({ id: i.id })), image],
  };
  if (goesOnSale) body.status = "publish";
  return { kind: "attach", index, body };
}
