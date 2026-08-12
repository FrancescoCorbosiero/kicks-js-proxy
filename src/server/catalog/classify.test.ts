import { describe, it, expect } from "vitest";
import { classifyTitle } from "./classify";

describe("classifyTitle", () => {
  it("recognizes the big product lines from real-world titles", () => {
    expect(classifyTitle("Nike Air Force 1 Low '07 White")).toEqual({
      category: "Air Force",
      secondaryCategory: "One",
      gender: "",
    });
    expect(classifyTitle("adidas Yeezy Foam RNNR Sulfur")).toEqual({
      category: "Yeezy",
      secondaryCategory: "Foam RNNR",
      gender: "",
    });
    expect(classifyTitle("adidas Yeezy Boost 350 V2 Zebra")).toEqual({
      category: "Yeezy",
      secondaryCategory: "350",
      gender: "",
    });
    expect(classifyTitle("New Balance 550 White Grey")).toEqual({
      category: "New Balance",
      secondaryCategory: "550",
      gender: "",
    });
    expect(classifyTitle("Nike Dunk Low Retro White Black Panda")).toEqual({
      category: "Dunk",
      secondaryCategory: "",
      gender: "",
    });
    expect(classifyTitle("adidas Samba OG Cloud White Core Black")).toEqual({
      category: "Samba",
      secondaryCategory: "",
      gender: "",
    });
  });

  it("writes Jordan models with the KicksDB word vocabulary", () => {
    expect(classifyTitle("Air Jordan 4 Retro Military Black")).toEqual({
      category: "Air Jordan",
      secondaryCategory: "Four",
      gender: "",
    });
    expect(classifyTitle("Jordan 1 Retro High OG Chicago")!.secondaryCategory).toBe("One");
  });

  it("reads the gender from the title's size-run suffix", () => {
    expect(classifyTitle("Nike Air Force 1 Low '07 White (Women's)")!.gender).toBe("women");
    expect(classifyTitle("Nike Dunk Low Panda (GS)")!.gender).toBe("youth");
    expect(classifyTitle("Jordan 4 Retro Bred (PS)")!.gender).toBe("preschool");
    expect(classifyTitle("Yeezy Slide Bone (TD)")!.gender).toBe("toddler");
  });

  it("falls back to the brand, and to null when there is nothing to go on", () => {
    expect(classifyTitle("Qualche Prodotto Sconosciuto", "Nike")).toEqual({
      category: "Nike",
      secondaryCategory: "",
      gender: "",
    });
    expect(classifyTitle("Qualche Prodotto Sconosciuto")).toBeNull();
    expect(classifyTitle("")).toBeNull();
  });

  it("Air Max keeps the model token", () => {
    expect(classifyTitle("Nike Air Max 97 Silver Bullet")!.secondaryCategory).toBe("97");
    expect(classifyTitle("Nike Air Max Plus Tn")!.secondaryCategory).toBe("Plus");
  });
});
