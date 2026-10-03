import { describe, expect, it } from "vitest";
import { secretMatches, signedInUser } from "./auth";

const SECRET = "0123456789abcdef0123456789abcdef";

/** Header values as Node hands them over: one character per byte. */
const asHeaderBytes = (text: string) => String.fromCharCode(...new TextEncoder().encode(text));

describe("secretMatches", () => {
  it("accepts the secret and nothing else", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(null, SECRET)).toBe(false);
    expect(secretMatches("", SECRET)).toBe(false);
    expect(secretMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretMatches(`${SECRET}0`, SECRET)).toBe(false);
    expect(secretMatches(SECRET.toUpperCase(), SECRET)).toBe(false);
  });
});

describe("signedInUser", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it("is nobody without Remote-User", () => {
    expect(signedInUser(headers({}))).toBeNull();
    expect(signedInUser(headers({ "remote-name": "Operator" }))).toBeNull();
  });

  it("names the user by display name, else by username", () => {
    expect(signedInUser(headers({ "remote-user": "operator", "remote-name": "Operator" }))).toEqual({
      username: "operator",
      name: "Operator",
    });
    expect(signedInUser(headers({ "remote-user": "operator" }))).toEqual({ username: "operator", name: "operator" });
  });

  it("decodes a name Authelia sent as UTF-8", () => {
    const user = signedInUser(headers({ "remote-user": "niccolo", "remote-name": asHeaderBytes("Niccolò Rossi") }));
    expect(user?.name).toBe("Niccolò Rossi");
    // Bytes that are not UTF-8 are shown as they came, never dropped.
    expect(signedInUser(headers({ "remote-user": "x", "remote-name": "café" }))?.name).toBe("café");
  });
});
