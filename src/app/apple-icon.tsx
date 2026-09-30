import { ImageResponse } from "next/og";
import { AppMark } from "./app-mark";

/** The home-screen icon iOS uses (it ignores SVG and the manifest's icons). */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<AppMark size={180} />, size);
}
