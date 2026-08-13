import { describe, it, expect } from "vitest";
import { formatAddress, initialStatusForWoo, needsWooMirror, normalizeWooOrder } from "./model";

const RAW = {
  id: 1042,
  number: "1042",
  status: "processing",
  currency: "EUR",
  total: "189.99",
  date_created: "2026-08-11T09:30:00",
  date_modified: "2026-08-11T10:00:00",
  customer_note: "Citofono rotto, chiamare al telefono.",
  payment_method_title: "Klarna",
  billing: {
    first_name: "Mario",
    last_name: "Rossi",
    address_1: "Via Roma 1",
    city: "Piacenza",
    postcode: "29121",
    country: "IT",
    email: "mario@example.com",
    phone: "+39 333 1234567",
  },
  shipping: {
    first_name: "Mario",
    last_name: "Rossi",
    address_1: "Via Milano 2",
    address_2: "Scala B",
    city: "Piacenza",
    state: "PC",
    postcode: "29121",
    country: "IT",
  },
  line_items: [
    {
      name: "adidas Yeezy Foam RNNR Stone Salt",
      sku: "HP8695-44.5",
      quantity: 1,
      total: "189.99",
      image: { src: "https://store.example/foam.jpg" },
      meta_data: [
        { key: "pa_taglia", value: "44-5", display_key: "Taglia", display_value: "44.5" },
        { key: "_reduced_stock", value: "1", display_key: "_reduced_stock", display_value: "1" },
      ],
    },
  ],
};

describe("normalizeWooOrder", () => {
  it("maps the fields the tab shows, preferring the shipping address", () => {
    const o = normalizeWooOrder(RAW)!;
    expect(o.id).toBe(1042);
    expect(o.number).toBe("1042");
    expect(o.wooStatus).toBe("processing");
    expect(o.total).toBe(189.99);
    expect(o.customerName).toBe("Mario Rossi");
    expect(o.customerEmail).toBe("mario@example.com");
    expect(o.paymentMethod).toBe("Klarna");
    expect(o.shipping.street).toBe("Via Milano 2, Scala B");
    expect(o.shipping.city).toBe("Piacenza");
    // Shipping block carries no phone — the billing one fills in.
    expect(o.shipping.phone).toBe("+39 333 1234567");
    expect(o.items).toHaveLength(1);
    expect(o.items[0].size).toBe("44.5"); // display_value of the taglia meta
    expect(o.items[0].sku).toBe("HP8695-44.5");
    expect(o.raw).toBe(RAW);
  });

  it("falls back to the billing address when the shipping block is empty", () => {
    const o = normalizeWooOrder({ ...RAW, shipping: { first_name: "", address_1: "" } })!;
    expect(o.shipping.street).toBe("Via Roma 1");
    expect(o.shipping.name).toBe("Mario Rossi"); // billing name fills in
  });

  it("ignores underscore metas and size-less items", () => {
    const o = normalizeWooOrder({
      ...RAW,
      line_items: [{ name: "X", meta_data: [{ key: "_reduced_stock", value: "1" }] }],
    })!;
    expect(o.items[0].size).toBe("");
    expect(o.items[0].quantity).toBe(1);
  });

  it("uses the id as display number when number is missing, and rejects non-orders", () => {
    const o = normalizeWooOrder({ ...RAW, number: null })!;
    expect(o.number).toBe("1042");
    expect(normalizeWooOrder({ no: "id" })).toBeNull();
    expect(normalizeWooOrder(null)).toBeNull();
  });
});

describe("formatAddress", () => {
  it("renders a copy-pastable block, skipping empty lines", () => {
    const o = normalizeWooOrder(RAW)!;
    expect(formatAddress(o.shipping)).toBe(
      "Mario Rossi\nVia Milano 2, Scala B\n29121 Piacenza PC\nIT\n+39 333 1234567",
    );
  });
});

describe("initialStatusForWoo", () => {
  it("settled Woo history starts settled locally", () => {
    expect(initialStatusForWoo("completed")).toBe("completed");
    expect(initialStatusForWoo("cancelled")).toBe("cancelled");
    expect(initialStatusForWoo("refunded")).toBe("cancelled");
    expect(initialStatusForWoo("failed")).toBe("cancelled");
  });
  it("open Woo statuses enter the working pipeline (default new)", () => {
    expect(initialStatusForWoo("processing")).toBeNull();
    expect(initialStatusForWoo("on-hold")).toBeNull();
    expect(initialStatusForWoo("pending")).toBeNull();
    expect(initialStatusForWoo("")).toBeNull();
  });
});

describe("needsWooMirror", () => {
  it("flags terminal local states the store does not reflect yet", () => {
    expect(needsWooMirror("shipped", "processing")).toBe(true);
    expect(needsWooMirror("completed", "processing")).toBe(true);
    expect(needsWooMirror("cancelled", "processing")).toBe(true);
  });
  it("stays quiet while working locally or once Woo caught up", () => {
    expect(needsWooMirror("new", "processing")).toBe(false);
    expect(needsWooMirror("processing", "processing")).toBe(false);
    expect(needsWooMirror("shipped", "completed")).toBe(false);
    expect(needsWooMirror("completed", "completed")).toBe(false);
    expect(needsWooMirror("cancelled", "refunded")).toBe(false);
  });
});
