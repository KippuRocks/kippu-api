import { describe, expect, it } from "vitest";
import { classLocator, eventLocator, METADATA_ORIGIN } from "../src/index.js";

const eventId = "ab".repeat(32);
const classId = "cd".repeat(32);

describe("metadata locators", () => {
  it("REQ-MD-1: an event's locator is a stable HTTPS URL under meta.kippu.rocks, named by its id", () => {
    expect(METADATA_ORIGIN).toBe("https://meta.kippu.rocks");
    expect(eventLocator(eventId)).toBe(`https://meta.kippu.rocks/v0/events/${eventId}.json`);
    expect(eventLocator(eventId)).toBe(eventLocator(eventId));
  });

  it("REQ-MD-1: a class's locator is derived from the class id alone", () => {
    expect(classLocator(classId)).toBe(`https://meta.kippu.rocks/v0/classes/${classId}.json`);
  });

  it("follows a configured origin, such as a local stand-in", () => {
    expect(eventLocator(eventId, "https://meta.localhost")).toBe(
      `https://meta.localhost/v0/events/${eventId}.json`,
    );
  });

  it.each([
    ["an upper-case id", () => eventLocator(eventId.toUpperCase())],
    ["a short id", () => classLocator("ab")],
    ["an origin with a path", () => eventLocator(eventId, "https://meta.kippu.rocks/v0")],
    ["a plain-http origin", () => classLocator(classId, "http://meta.kippu.rocks")],
  ])("refuses %s", (_, derive) => {
    expect(derive).toThrow(TypeError);
  });
});
