import { describe, expect, it } from "vitest";
import {
  mediaImages,
  mediaName,
  nameKey,
  nextMediaStep,
  photosOn,
  type MediaJobView,
  type MediaLiveProduct,
} from "./media-plan";

const SKU = "DD1391-100";
const job = (over: Partial<MediaJobView> = {}): MediaJobView => ({
  images: mediaImages(SKU, ["https://cdn.gs/a.jpg", "https://cdn.gs/b.jpg", "https://cdn.gs/c.jpg"], "k3f9q2"),
  skipped: [],
  publish: true,
  replace: false,
  alt: "Nike Dunk Low Panda",
  ...over,
});
const draft = (over: Partial<MediaLiveProduct> = {}): MediaLiveProduct => ({
  status: "draft",
  images: [],
  variations: 8,
  ...over,
});
/** Photo `i` of the job above, as the store lists it. */
const ours = (i: number, id = 100 + i) => ({ id, name: mediaName(SKU, i, "k3f9q2") });

describe("a product the Publisher created hidden", () => {
  it("goes on sale with its main photo", () => {
    expect(nextMediaStep(job(), draft())).toEqual({
      kind: "attach",
      index: 0,
      body: {
        images: [{ src: "https://cdn.gs/a.jpg", name: "DD1391-100-1-k3f9q2", alt: "Nike Dunk Low Panda" }],
        status: "publish",
      },
    });
  });

  it("then gets the rest of the gallery, one photo at a time, keeping the ones it has", () => {
    const step = nextMediaStep(job(), draft({ status: "publish", images: [ours(0)] }));
    expect(step).toEqual({
      kind: "attach",
      index: 1,
      body: {
        images: [{ id: 100 }, { src: "https://cdn.gs/b.jpg", name: "DD1391-100-2-k3f9q2", alt: "Nike Dunk Low Panda" }],
      },
    });
  });

  it("is done once every photo is on", () => {
    expect(nextMediaStep(job(), draft({ status: "publish", images: [ours(0), ours(1), ours(2)] }))).toEqual({
      kind: "done",
    });
  });

  it("is put on sale even when only the status is left", () => {
    expect(nextMediaStep(job(), draft({ images: [ours(0), ours(1), ours(2)] }))).toEqual({
      kind: "publish",
      body: { status: "publish" },
    });
  });

  it("waits for its sizes: a product without any sells nothing", () => {
    expect(nextMediaStep(job(), draft({ variations: 0 }))).toEqual({ kind: "waitForSizes" });
  });

  it("goes on with the next photo when the store refused the main one", () => {
    const step = nextMediaStep(job({ skipped: [0] }), draft());
    expect(step.kind).toBe("attach");
    if (step.kind !== "attach") return;
    expect(step.index).toBe(1);
    expect(step.body).toMatchObject({ images: [{ src: "https://cdn.gs/b.jpg" }], status: "publish" });
  });

  it("stays hidden when the store takes none of its photos", () => {
    expect(nextMediaStep(job({ skipped: [0, 1, 2] }), draft())).toEqual({ kind: "noPhoto" });
    expect(nextMediaStep(job({ images: [] }), draft())).toEqual({ kind: "noPhoto" });
  });

  it("keeps a photo someone put there by hand, and just goes on sale", () => {
    expect(nextMediaStep(job(), draft({ images: [{ id: 7, name: "my own shot" }] }))).toEqual({
      kind: "publish",
      body: { status: "publish" },
    });
  });

  it("leaves a status the operator chose alone", () => {
    const step = nextMediaStep(job(), draft({ status: "private" }));
    expect(step.kind).toBe("attach");
    if (step.kind === "attach") expect(step.body.status).toBeUndefined();
  });
});

describe("photos for a product already on sale", () => {
  it("only adds them, and never touches the status", () => {
    const step = nextMediaStep(job({ publish: false }), draft({ status: "publish", variations: 0 }));
    expect(step.kind).toBe("attach");
    if (step.kind === "attach") expect(step.body.status).toBeUndefined();
  });

  it("replaces the photos it had on a reimport with new media, then adds behind the new main one", () => {
    const old = [
      { id: 7, name: "old-1" },
      { id: 8, name: "old-2" },
    ];
    const first = nextMediaStep(job({ publish: false, replace: true }), draft({ status: "publish", images: old }));
    expect(first).toMatchObject({ kind: "attach", index: 0, body: { images: [{ src: "https://cdn.gs/a.jpg" }] } });

    const second = nextMediaStep(job({ publish: false, replace: true }), draft({ status: "publish", images: [ours(0)] }));
    expect(second).toMatchObject({ kind: "attach", index: 1, body: { images: [{ id: 100 }, { src: "https://cdn.gs/b.jpg" }] } });
  });

  it("keeps the old photos when the store refuses every new one", () => {
    const old = [{ id: 7, name: "old-1" }];
    expect(
      nextMediaStep(job({ publish: false, replace: true, skipped: [0, 1, 2] }), draft({ status: "publish", images: old })),
    ).toEqual({ kind: "done" });
  });
});

describe("recognizing a photo on the store", () => {
  it("files each photo under the SKU, its position and the job's token", () => {
    expect(mediaImages("ABC-1", ["u1", "u2"], "tok")).toEqual([
      { src: "u1", name: "ABC-1-1-tok" },
      { src: "u2", name: "ABC-1-2-tok" },
    ]);
  });

  it("matches a name WordPress sends back texturized or escaped", () => {
    expect(nameKey("DD1391&#8211;100-1-k3f9q2")).toBe(nameKey("DD1391-100-1-k3f9q2"));
    expect(nameKey("dd1391-100-1-K3F9Q2")).toBe(nameKey("DD1391-100-1-k3f9q2"));
    expect(photosOn(job(), draft({ images: [{ id: 1, name: "dd1391–100–2–k3f9q2" }] }))).toEqual([false, true, false]);
  });

  it("never takes another job's photo of the same product for its own", () => {
    const other = mediaImages(SKU, ["https://cdn.gs/a.jpg"], "zzzzzz");
    expect(photosOn(job(), draft({ images: [{ id: 1, name: other[0].name }] }))).toEqual([false, false, false]);
  });
});
