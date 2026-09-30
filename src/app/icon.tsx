import { ImageResponse } from "next/og";

import { BrandMark } from "@/components/cockpit/brand-mark";

export const contentType = "image/png";

export function generateImageMetadata() {
  return [
    { id: "32", size: { width: 32, height: 32 }, contentType },
    { id: "192", size: { width: 192, height: 192 }, contentType },
    { id: "512", size: { width: 512, height: 512 }, contentType },
    { id: "maskable", size: { width: 512, height: 512 }, contentType },
  ];
}

export default async function Icon({ id }: { id: Promise<string> }) {
  const key = await id;
  const size = key === "maskable" ? 512 : Number(key);
  return new ImageResponse(<BrandMark size={size} inset={key === "maskable" ? 0.25 : 0} />, {
    width: size,
    height: size,
  });
}
