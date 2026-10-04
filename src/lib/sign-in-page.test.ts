import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n/dictionary";
import { AUTHELIA_FIRST_FACTOR, AUTHELIA_LOGOUT, AUTHELIA_SECOND_FACTOR, renderSignInPage, signInPolicy } from "./sign-in-page";

const page = (over: Partial<Parameters<typeof renderSignInPage>[0]> = {}) =>
  renderSignInPage({
    t: getDictionary("it").signIn,
    locale: "it",
    area: "hub",
    host: "hub.example.com",
    nonce: "bm9uY2U=",
    ...over,
  });

describe("the sign-in page", () => {
  it("is in the reader's language, and names the app this address serves", () => {
    expect(page()).toContain('<html lang="it">');
    expect(page()).toContain("Nome utente");
    expect(page()).toContain("<b>Store Hub</b>");
    expect(page({ area: "vetrina" })).toContain("<b>Vetrina</b>");

    const en = page({ t: getDictionary("en").signIn, locale: "en" });
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("Username");
    expect(en).toContain('data-lang="en" aria-current="true"');
  });

  it("escapes the address it shows", () => {
    const html = page({ host: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("runs only its own nonce'd style and scripts", () => {
    const html = page();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    const styles = html.match(/<style\b[^>]*>/g) ?? [];
    expect(scripts.length).toBe(2);
    expect(styles.length).toBe(1);
    for (const tag of [...scripts, ...styles]) expect(tag).toContain('nonce="bm9uY2U="');
    expect(html).not.toMatch(/\son[a-z]+=/i); // no inline handlers: the policy would block them
    expect(html).not.toMatch(/\sstyle="/); // nor style attributes

    const policy = signInPolicy("bm9uY2U=");
    expect(policy).toContain("script-src 'nonce-bm9uY2U='");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("connect-src 'self'");
  });

  it("signs in with Authelia's API, on the same address", () => {
    const html = page();
    for (const path of [AUTHELIA_FIRST_FACTOR, AUTHELIA_LOGOUT, AUTHELIA_SECOND_FACTOR]) {
      expect(html).toContain(JSON.stringify(path).slice(1, -1));
      expect(path.startsWith("/authelia/")).toBe(true);
    }
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
  });

  it("keeps texts with quotes or tags from closing its script", () => {
    const t = { ...getDictionary("it").signIn, failed: "</script><script>alert(1)</script>" };
    const html = page({ t });
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });
});
