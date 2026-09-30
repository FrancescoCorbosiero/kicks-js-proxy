import { ImageResponse } from "next/og";
import { AppMark } from "./app-mark";

/** The installed app's icon (Android, desktop). */
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(<AppMark size={512} />, size);
}
